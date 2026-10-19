// The TypeScript runner of the shared conformance cases (k143): `conformance/README.md` is the
// format; the Perl port runs the same cases. TS is the reference, so
// `SKILLETOR_CONFORMANCE_UPDATE=1 npm test` rewrites every expectation from this engine – review
// the diff by hand against the spec before keeping it: an expectation that only mirrors the code
// proves nothing.
//
// Every case runs in a fresh temp dir: HOME, the project, the git sources and a git config of its
// own; nothing reads or writes the real home. Git sources are real repositories built from plain
// trees, reached through `url.<file>.insteadOf` – fetch, cache naming and `check`'s ls-remote run
// as for a remote, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { check, resolveItems, status, sync, type EngineContext, type ResolveReport } from "../src/engine.ts";

const ROOT = fileURLToPath(new URL("../conformance/cases", import.meta.url));
const UPDATE = process.env.SKILLETOR_CONFORMANCE_UPDATE === "1";

/** The commit identity and date every source commit is made with (README: git sources). */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "skilletor-conformance",
  GIT_AUTHOR_EMAIL: "conformance@skilletor.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
  GIT_COMMITTER_NAME: "skilletor-conformance",
  GIT_COMMITTER_EMAIL: "conformance@skilletor.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
};

interface Step {
  id: string;
  op: "resolve" | "sync" | "check" | "status";
  scope?: "user" | "project" | "all";
  force?: boolean;
  tree?: boolean;
}

interface Case {
  description: string;
  git?: Record<string, { url: string; commits: { tree: string; tag?: string; branch?: string; executable?: string[] }[] }>;
  env?: Record<string, string>;
  steps: Step[];
  engines?: Record<string, { skip?: string; steps?: Record<string, { skip?: string; expected?: string }> }>;
}

/** Every file under `dir`, relative and `/`-separated, sorted; `skip` holds relative paths left out. */
function walk(dir: string, skip: string[] = [], base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const rel = relative(base, p).split(sep).join("/");
    if (skip.includes(rel)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, skip, base));
    else out.push(rel);
  }
  return out.sort();
}

/** Keys sorted, arrays sorted by the canonical text of their elements, recursively (README). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(canonical).map((x) => [JSON.stringify(x), x] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, x]) => x);
  }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/** The projection of a resolve the cases pin (README: resolve). */
function resolveView(r: ResolveReport): unknown {
  if (r.error !== undefined) return { error: r.error, scopes: [] };
  return {
    scopes: r.scopes.map((s) => ({
      scope: s.scope,
      sources: s.sources.map((src) => {
        const o: Record<string, unknown> = { name: src.name, state: src.state };
        if (src.backend) {
          o.kind = src.backend.kind;
          o.address = src.backend.address;
          o.origin = src.backend.origin;
          if (src.backend.ref !== undefined) o.ref = src.backend.ref;
          if (src.backend.path !== undefined) o.path = src.backend.path;
        }
        if (src.cache !== undefined) o.cache = src.cache;
        if (src.dir !== undefined) o.dir = src.dir;
        if (src.version !== undefined) o.version = src.version;
        return o;
      }),
      items: s.items.map((i) => {
        const o: Record<string, unknown> = {
          type: i.type, name: i.name, source: i.source, declaredBy: i.declaredBy,
          path: i.type === "skill" ? i.item.dir : i.item.files[0], files: i.item.files,
          templated: i.item.files.some((f) => f.endsWith(".njk")), vars: i.vars,
        };
        if (i.via) o.via = i.via;
        if (i.item.description !== undefined) o.description = i.item.description;
        return o;
      }),
      warnings: s.warnings,
      trustRequests: s.trustRequests,
    })),
  };
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  execFileSync("git", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
}

/** Each case's temp roots and how outputs name them. */
interface Roots {
  tmp: string;
  home: string;
  project?: string;
}

function placeholders(r: Roots): [string, string][] {
  const out: [string, string][] = [[r.home, "${HOME}"]];
  if (r.project) out.push([r.project, "${PROJECT}"]);
  out.push([r.tmp, "${TMP}"]);
  return out;
}

function abstract(text: string, r: Roots): string {
  for (const [path, name] of placeholders(r)) text = text.split(path).join(name);
  return text;
}

function concrete(text: string, r: Roots): string {
  for (const [path, name] of placeholders(r)) text = text.split(name).join(path);
  return text;
}

/** A path as a case stores it (README: escaped names): every name starting with `.git` gets the
 *  prefix `dot`, since a `.gitignore` in a fixture would be live in this repository. */
function escapeName(rel: string): string {
  return rel.split("/").map((s) => (s.startsWith(".git") ? `dot${s}` : s)).join("/");
}

/** A stored path as the engine sees it: `dot.gitignore` is `.gitignore`. */
function unescapeName(rel: string): string {
  return rel.split("/").map((s) => (s.startsWith("dot.git") ? s.slice(3) : s)).join("/");
}

/** Copy a case's input tree, placeholders substituted in every file (README: inputs). */
function copyInput(from: string, to: string, r: Roots): void {
  for (const rel of walk(from)) {
    const dest = join(to, unescapeName(rel));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, concrete(readFileSync(join(from, rel), "utf8"), r));
  }
}

/** Build the case's git sources and the git config that reaches them (README: git sources). */
function buildGit(caseDir: string, c: Case, r: Roots, env: NodeJS.ProcessEnv): void {
  const config: string[] = [];
  for (const [name, g] of Object.entries(c.git ?? {})) {
    const repo = join(r.tmp, "git", name);
    mkdirSync(repo, { recursive: true });
    git(repo, env, "init", "-q", "-b", "main");
    g.commits.forEach((commit, i) => {
      for (const entry of readdirSync(repo)) if (entry !== ".git") rmSync(join(repo, entry), { recursive: true, force: true });
      const tree = join(caseDir, commit.tree);
      for (const rel of walk(tree)) {
        const dest = join(repo, unescapeName(rel));
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(tree, rel), dest); // byte for byte
      }
      for (const rel of commit.executable ?? []) chmodSync(join(repo, rel), 0o755);
      git(repo, env, "add", "-A");
      git(repo, env, "commit", "-q", "--allow-empty", "-m", `conformance ${i + 1}`);
      if (commit.tag) git(repo, env, "tag", commit.tag);
      if (commit.branch) git(repo, env, "branch", commit.branch);
    });
    config.push(`[url "file://${repo}"]`, `\tinsteadOf = ${g.url}`);
  }
  writeFileSync(join(r.tmp, "gitconfig"), config.join("\n") + "\n");
}

async function runStep(step: Step, ctx: EngineContext): Promise<unknown> {
  const opts = { scope: step.scope ?? "all", force: step.force };
  switch (step.op) {
    case "resolve":
      return resolveView(await resolveItems(ctx, opts));
    case "sync":
      return sync(ctx, opts);
    case "check":
      return check(ctx, opts);
    case "status":
      return status(ctx, opts);
  }
}

/** The files a tree step compares (README: trees): HOME but the state dir and the marker, all of PROJECT. */
function snapshot(r: Roots): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of walk(r.home, [".claude/skilletor", ".claude.json"])) {
    out.set(`home/${escapeName(rel)}`, abstract(readFileSync(join(r.home, rel), "utf8"), r));
  }
  if (r.project) {
    for (const rel of walk(r.project)) {
      out.set(`project/${escapeName(rel)}`, abstract(readFileSync(join(r.project, rel), "utf8"), r));
    }
  }
  return out;
}

/** The snapshot's files that carry the owner's executable bit (README: trees), sorted. */
function executablesOf(r: Roots, have: Map<string, string>): string[] {
  const abs = (key: string) => {
    const rel = unescapeName(key);
    return rel.startsWith("home/") ? join(r.home, rel.slice(5)) : join(r.project!, rel.slice(8));
  };
  return [...have.keys()].filter((rel) => (statSync(abs(rel)).mode & 0o100) !== 0).sort();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function runCase(name: string): Promise<void> {
  const caseDir = join(ROOT, name);
  const c = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as Case;
  const live = walk(caseDir).filter((rel) => rel.split("/").some((s) => s.startsWith(".git")));
  assert.deepEqual(live, [], `${name}: fixture names starting with .git must be stored escaped (dot.gitignore)`);
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "skilletor-conformance-")));
  const r: Roots = { tmp, home: join(tmp, "home") };
  if (existsSync(join(caseDir, "project"))) r.project = join(tmp, "project");
  const saved = { ...process.env };
  try {
    // The git config the engine's git runs with: this case's alone (README: environment).
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
    for (const v of ["CODEX_HOME", "HERMES_HOME", "CLAUDE_PLUGIN_ROOT", "CLAUDE_CONFIG_DIR"]) delete process.env[v];
    for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = concrete(v, r);
    buildGit(caseDir, c, r, { ...process.env, ...COMMIT_ENV });
    mkdirSync(join(r.home, ".claude"), { recursive: true });
    writeFileSync(join(r.home, ".claude.json"), "{}\n"); // Claude Code is in use (spec §14.1)
    const cfgDir = process.env.CLAUDE_CONFIG_DIR; // Claude Code keeps its .claude.json inside a custom config dir
    if (cfgDir) {
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, ".claude.json"), "{}\n");
    }
    copyInput(join(caseDir, "home"), r.home, r);
    if (r.project) {
      mkdirSync(r.project, { recursive: true });
      copyInput(join(caseDir, "project"), r.project, r);
    }
    const ctx: EngineContext = {
      home: r.home,
      projectDir: r.project,
      stateRoot: join(r.home, ".claude", "skilletor"),
      codexHome: join(r.home, ".codex"),
      hermesHome: join(r.home, ".hermes"),
      host: { name: "conformance", os: "linux" },
      user: { name: "conformance", home: r.home },
      isGitWorkTree: () => false,
      gitTracked: () => [],
    };
    for (const step of c.steps) {
      const actual = canonical(JSON.parse(abstract(JSON.stringify(await runStep(step, ctx)), r)));
      const file = join(caseDir, "expected", `${step.id}.json`);
      if (UPDATE) writeJson(file, actual);
      else assert.deepEqual(actual, canonical(JSON.parse(readFileSync(file, "utf8"))), `${name}: step ${step.id}`);
      if (!step.tree) continue;
      const treeDir = join(caseDir, "expected", step.id);
      const have = snapshot(r);
      const execFile = join(caseDir, "expected", `${step.id}.executables.json`);
      const execs = executablesOf(r, have);
      if (UPDATE) {
        if (execs.length > 0) writeJson(execFile, execs);
        else rmSync(execFile, { force: true });
        rmSync(treeDir, { recursive: true, force: true });
        for (const [rel, text] of have) {
          mkdirSync(dirname(join(treeDir, rel)), { recursive: true });
          writeFileSync(join(treeDir, rel), text);
        }
        continue;
      }
      const want = new Map(walk(treeDir).map((rel) => [rel, readFileSync(join(treeDir, rel), "utf8")]));
      assert.deepEqual([...have.keys()].sort(), [...want.keys()].sort(), `${name}: step ${step.id}: the files in the tree`);
      for (const [rel, text] of want) assert.equal(have.get(rel), text, `${name}: step ${step.id}: ${rel}`);
      const wantExecs = existsSync(execFile) ? JSON.parse(readFileSync(execFile, "utf8")) : [];
      assert.deepEqual(execs, wantExecs, `${name}: step ${step.id}: the files with the executable bit`);
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(tmp, { recursive: true, force: true });
  }
}

const cases = existsSync(ROOT) ? readdirSync(ROOT).filter((n) => existsSync(join(ROOT, n, "case.json"))).sort() : [];

test("conformance: the cases directory holds cases", () => {
  assert.ok(cases.length > 0, `no cases under ${ROOT}`);
});

for (const name of cases) {
  test(`conformance: ${name}`, () => runCase(name));
}
