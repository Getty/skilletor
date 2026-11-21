// The TypeScript runner of the shared conformance cases (k143): `conformance/README.md` is the
// format; the Perl port runs the same cases. TS is the reference, so
// `SKILLETOR_CONFORMANCE_UPDATE=1 npm test` rewrites every expectation from this engine – review
// the diff by hand against the spec before keeping it: an expectation that only mirrors the code
// proves nothing.
//
// Every case runs in a fresh temp dir: HOME, the project, the git sources and a git config of its
// own; nothing reads or writes the real home. Git sources are real repositories built from plain
// trees, reached through `url.<file>.insteadOf` – fetch, cache naming and `check`'s ls-remote run
// as for a remote, offline. A `cli` step runs a CLI – this checkout's bundle, or the one
// SKILLETOR_CONFORMANCE_CLI names (the Perl port's, say) – in an environment built from nothing.
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildToString } from "../scripts/esbuild.config.mjs";
import { check, resolveItems, status, sync, type EngineContext, type ResolveReport } from "../src/engine.ts";
import { homeEnv } from "./helpers/harness.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

const ROOT = fileURLToPath(new URL("../conformance/cases", import.meta.url));
const UPDATE = process.env.SKILLETOR_CONFORMANCE_UPDATE === "1";
/**
 * The version a `cli` step that asks for it writes as `${VERSION}` (README: placeholders), in either
 * spelling: the plugin's (package.json, 0.8.0), which this CLI reports, and the Perl dist's
 * (`$VERSION` in lib/Skilletor.pm, 0.008000), which the Perl CLI reports.
 */
const VERSIONS = [
  (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
  /^our \$VERSION = '([^']+)';$/m.exec(readFileSync(new URL("../lib/Skilletor.pm", import.meta.url), "utf8"))![1]!,
];
/** The CLI of `cli` steps as a JSON argv prefix; unset, this checkout's bundle (README: which CLI). */
const CLI_OVERRIDE = process.env.SKILLETOR_CONFORMANCE_CLI;
const CLI_TIMEOUT_MS = 30_000;
function updatePlatformProblem(update: boolean, platform: NodeJS.Platform): string | undefined {
  return update && platform === "win32"
    ? "SKILLETOR_CONFORMANCE_UPDATE=1 is unsupported on Windows: regenerate expectations on POSIX so path provenance comes from the existing oracle"
    : undefined;
}

const updateProblem = updatePlatformProblem(UPDATE, process.platform);
if (updateProblem) throw new Error(updateProblem);
if (UPDATE && CLI_OVERRIDE !== undefined) {
  throw new Error("SKILLETOR_CONFORMANCE_UPDATE=1 refuses SKILLETOR_CONFORMANCE_CLI: the expectations are the reference CLI's");
}

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
  op: "resolve" | "sync" | "check" | "status" | "cli";
  scope?: "user" | "project" | "all";
  force?: boolean;
  tree?: boolean;
  /** `cli` only (README: cli). */
  argv?: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  stdin?: unknown;
  version?: boolean;
}

interface Case {
  description: string;
  git?: Record<string, { url: string; commits: { tree: string; tag?: string; branch?: string; executable?: string[] }[] }>;
  env?: Record<string, string>;
  /** Directories made git work trees before the steps (README: case.json). */
  gitInit?: ("home" | "project")[];
  /** `false`: no Claude Code marker is written, so no harness is detected (README: case.json). */
  claude?: boolean;
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

/** Each case's temp roots and how outputs name them; `cwd` is a `cli` step's cwd without a project. */
interface Roots {
  tmp: string;
  home: string;
  project?: string;
  cwd: string;
}

function placeholders(r: Roots): [string, string][] {
  const out: [string, string][] = [[r.home, "${HOME}"]];
  if (r.project) out.push([r.project, "${PROJECT}"]);
  out.push([r.tmp, "${TMP}"]);
  return out;
}

const jsonStringContents = (value: string) => JSON.stringify(value).slice(1, -1);

type EncodingContext = "decoded" | "json" | "stream";

/** Whether `offset` lies inside a JSON string, without decoding or reserializing the text. */
function inJsonString(text: string, offset: number): boolean {
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < offset; i++) {
    const c = text[i]!;
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  return quoted;
}

/** Complete escaped-quote scalar intervals inside each outer JSON string. A delimiter is
 * exactly `\\"` (deeper escaped quotes are content), and a closing delimiter must end a value. */
function nestedJsonIntervals(text: string): [number, number][] {
  const intervals: [number, number][] = [];
  let outer = false;
  let tokens: { slash: number; quote: number }[] = [];
  const finishOuter = () => {
    const openingBoundary = (at: number) => at === 0 || /[\s:=,(\[{'`]/.test(text[at - 1]!);
    const closingBoundary = (at: number) => at >= text.length || /[\s,.;:)\]}"'`]/.test(text[at]!);
    for (let i = 0; i + 1 < tokens.length;) {
      const open = tokens[i]!;
      const close = tokens[i + 1]!;
      if (openingBoundary(open.slash) && closingBoundary(close.quote + 1)) {
        intervals.push([open.quote + 1, close.slash]);
        i += 2;
      } else {
        i++;
      }
    }
    tokens = [];
  };

  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (!outer) {
      if (c === '"') outer = true;
      i++;
      continue;
    }
    if (c === "\\") {
      let end = i + 1;
      while (text[end] === "\\") end++;
      if (text[end] === '"' && (end - i) % 2 === 1) {
        if (end - i === 1) tokens.push({ slash: i, quote: end });
        i = end + 1;
        continue;
      }
      i = end;
      continue;
    }
    if (c === '"') {
      finishOuter();
      outer = false;
    }
    i++;
  }
  // An unterminated outer JSON string has no proven nested intervals.
  if (outer) tokens = [];
  return intervals;
}

function inNestedJsonString(text: string, offset: number): boolean {
  return nestedJsonIntervals(text).some(([start, end]) => offset >= start && offset < end);
}

function encodedRoot(path: string, depth: number): string {
  let encoded = path;
  for (let i = 0; i < depth; i++) encoded = jsonStringContents(encoded);
  return encoded;
}

function expectedRootDepth(expected: string, offset: number, encoding: EncodingContext): number {
  if (encoding === "decoded") return 0;
  if (encoding === "stream" && !inJsonString(expected, offset)) return 0;
  return 1 + (inNestedJsonString(expected, offset) ? 1 : 0);
}

function replaceExactWhere(
  text: string, needle: string, replacement: string, accept: (text: string, offset: number) => boolean,
): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return out + text.slice(from);
    out += text.slice(from, at) + (accept(text, at) ? replacement : needle);
    from = at + needle.length;
  }
}

/** Replace concrete roots only; separator equivalence needs the expected oracle below. */
function abstractRoots(text: string, r: Roots, encoding: EncodingContext): string {
  for (const [path, name] of placeholders(r)) {
    const escaped = jsonStringContents(path);
    if (encoding === "decoded") {
      text = text.split(path).join(name);
    } else if (encoding === "json") {
      text = text.split(escaped).join(name);
    } else {
      text = replaceExactWhere(text, escaped, name, inJsonString);
      text = replaceExactWhere(text, path, name, (value, at) => !inJsonString(value, at));
    }
  }
  return text;
}

const PLACEHOLDER_NAMES = ["${HOME}", "${PROJECT}", "${TMP}"] as const;

function placeholderAt(text: string, offset: number): string | undefined {
  return PLACEHOLDER_NAMES.find((name) => text.startsWith(name, offset));
}

function pathClose(text: string, offset: number): string | undefined {
  const before = text[offset - 1];
  if (before === '"' || before === "'" || before === "`") return before;
  if (before === "(") return ")";
  return undefined;
}

function endsPath(c: string, close: string | undefined): boolean {
  if (close !== undefined && c === close) return true;
  if ('"\'`)]},;:\r\n—'.includes(c)) return true;
  return close === undefined && /\s/.test(c);
}

/** Exact comparison except for separators explicitly designated by `/` inside an expected
 * placeholder-rooted path token. JSON strings require an encoded `\\`; decoded text requires `\`. */
function oraclePathEqual(actual: string, expected: string, encoding: EncodingContext, roots?: Roots): boolean {
  let a = 0;
  let e = 0;
  let inPath = false;
  let close: string | undefined;
  while (e < expected.length) {
    const placeholder = placeholderAt(expected, e);
    if (placeholder !== undefined) {
      let consumed = placeholder.length;
      if (!actual.startsWith(placeholder, a)) {
        const concrete = roots && placeholders(roots).find(([, name]) => name === placeholder)?.[0];
        if (concrete === undefined) return false;
        const candidate = encodedRoot(concrete, expectedRootDepth(expected, e, encoding));
        if (!actual.startsWith(candidate, a)) return false;
        consumed = candidate.length;
      }
      a += consumed;
      e += placeholder.length;
      inPath = expected[e] === "/";
      close = inPath ? pathClose(expected, e - placeholder.length) : undefined;
      continue;
    }
    const wanted = expected[e]!;
    if (inPath && endsPath(wanted, close)) inPath = false;
    if (inPath && wanted === "/") {
      if (actual[a] === "/") a++;
      else {
        const separator = "\\".repeat(2 ** expectedRootDepth(expected, e, encoding));
        if (!actual.startsWith(separator, a)) return false;
        a += separator.length;
      }
      e++;
      continue;
    }
    if (actual[a] !== wanted) return false;
    a++;
    e++;
  }
  return a === actual.length;
}

function actualTextForExpected(actual: string, expected: string, encoding: EncodingContext, roots?: Roots): string {
  return oraclePathEqual(actual, expected, encoding, roots) ? expected : actual;
}

function valuesEquivalent(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return oraclePathEqual(actual, expected, "decoded");
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    const matchedActual = new Array<number>(expected.length).fill(-1);
    const assign = (actualIndex: number, seen: Set<number>): boolean => {
      for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex++) {
        if (seen.has(expectedIndex) || !valuesEquivalent(actual[actualIndex], expected[expectedIndex])) continue;
        seen.add(expectedIndex);
        if (matchedActual[expectedIndex] === -1 || assign(matchedActual[expectedIndex]!, seen)) {
          matchedActual[expectedIndex] = actualIndex;
          return true;
        }
      }
      return false;
    };
    return actual.every((_, i) => assign(i, new Set()));
  }
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object" &&
      !Array.isArray(actual) && !Array.isArray(expected)) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const aKeys = Object.keys(a).sort();
    const eKeys = Object.keys(e).sort();
    return aKeys.length === eKeys.length && aKeys.every((key, i) => key === eKeys[i] && valuesEquivalent(a[key], e[key]));
  }
  return Object.is(actual, expected);
}

function actualForExpected(actual: unknown, expected: unknown): unknown {
  return valuesEquivalent(actual, expected) ? expected : actual;
}

function concrete(text: string, r: Roots): string {
  for (const [path, name] of placeholders(r)) text = text.split(name).join(path);
  return text;
}

/** Placeholder substitution inside a JSON file: escape only the inserted path, not the rest. */
function concreteJsonText(text: string, r: Roots): string {
  for (const [path, name] of placeholders(r)) text = text.split(name).join(jsonStringContents(path));
  return text;
}

/** Replace concrete roots in every string of a structured result; comparison supplies paths. */
function abstractDeep(v: unknown, r: Roots): unknown {
  if (typeof v === "string") return abstractRoots(v, r, "decoded");
  if (Array.isArray(v)) return v.map((x) => abstractDeep(x, r));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, abstractDeep(x, r)]));
  }
  return v;
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
    const text = readFileSync(join(from, rel), "utf8");
    writeFileSync(dest, rel.endsWith(".json") ? concreteJsonText(text, r) : concrete(text, r));
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
        // Byte for byte, in a new file's mode: the checkout's mode of the fixture does not count.
        writeFileSync(dest, readFileSync(join(tree, rel)));
      }
      for (const rel of commit.executable ?? []) chmodSync(join(repo, rel), 0o755);
      git(repo, env, "add", "-A");
      const regular = execFileSync("git", ["-C", repo, "ls-files", "--stage", "-z"], { env, encoding: "utf8" })
        .split("\0").filter(Boolean).filter((entry) => entry.startsWith("100"))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));
      if (regular.length) git(repo, env, "update-index", "--chmod=-x", "--", ...regular);
      if (commit.executable?.length) git(repo, env, "update-index", "--chmod=+x", "--", ...commit.executable);
      git(repo, env, "commit", "-q", "--allow-empty", "-m", `conformance ${i + 1}`);
      if (commit.tag) git(repo, env, "tag", commit.tag);
      if (commit.branch) git(repo, env, "branch", commit.branch);
    });
    config.push(`[url "${pathToFileURL(repo).href}"]`, `\tinsteadOf = ${g.url}`);
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
    default:
      throw new Error(`step ${step.id}: unknown op ${step.op}`);
  }
}

let bundleDir: string | undefined;
let cliPrefix: Promise<string[]> | undefined;

/** The argv prefix of every `cli` step: SKILLETOR_CONFORMANCE_CLI, else node and this checkout's
 *  bundle, built once (as test/cli.test.ts builds it). */
function cli(): Promise<string[]> {
  cliPrefix ??= (async () => {
    if (CLI_OVERRIDE !== undefined) {
      const prefix: unknown = JSON.parse(CLI_OVERRIDE);
      if (!Array.isArray(prefix) || prefix.length === 0 || !prefix.every((a) => typeof a === "string")) {
        throw new Error(`SKILLETOR_CONFORMANCE_CLI is no JSON array of strings: ${CLI_OVERRIDE}`);
      }
      return prefix as string[];
    }
    bundleDir = mkdtempSync(join(tmpdir(), "skilletor-conformance-cli-"));
    const bundle = join(bundleDir, "skilletor.mjs"); // .mjs: Node runs the ESM bundle as ESM
    writeFileSync(bundle, await buildToString());
    return [process.execPath, bundle];
  })();
  return cliPrefix;
}

after(() => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

/** A `cli` step's environment, built from nothing (README: cli): the case's, then the step's
 *  variables on top of the fixed ones; a step's `null` unsets one. */
function cliEnv(c: Case, step: Step, r: Roots): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...homeEnv(r.home),
    CODEX_HOME: join(r.home, ".codex"),
    GIT_CONFIG_GLOBAL: join(r.tmp, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  if (process.platform === "win32") Object.assign(env, { TEMP: r.tmp, TMP: r.tmp });
  if (process.env.PERL5LIB !== undefined) env.PERL5LIB = process.env.PERL5LIB; // a Perl CLI's modules
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = concrete(v, r);
  for (const [k, v] of Object.entries(step.env ?? {})) {
    if (v === null) delete env[k];
    else env[k] = concrete(v, r);
  }
  return env;
}

/** Input placeholders in every string of a JSON value. */
function concreteDeep(v: unknown, r: Roots): unknown {
  if (typeof v === "string") return concrete(v, r);
  if (Array.isArray(v)) return v.map((x) => concreteDeep(x, r));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, concreteDeep(x, r)]));
  return v;
}

interface CliResult {
  exit: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Run a `cli` step's CLI (README: cli): stdin a pipe with the step's bytes. One that does not
 *  start, outlives its timeout or dies of a signal fails the step. */
function runCli(prefix: string[], step: Step, r: Roots, env: Record<string, string>, timeout = CLI_TIMEOUT_MS): CliResult {
  const argv = step.argv;
  assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === "string"), `step ${step.id}: argv is no array of strings`);
  const stdin = step.stdin === undefined ? "" : typeof step.stdin === "string" ? concrete(step.stdin, r) : JSON.stringify(concreteDeep(step.stdin, r));
  const res = spawnSync(prefix[0]!, [...prefix.slice(1), ...argv.map((a) => concrete(a, r))], {
    cwd: step.cwd !== undefined ? concrete(step.cwd, r) : r.project ?? r.cwd,
    env,
    input: Buffer.from(stdin),
    timeout,
  });
  if (res.error) throw new Error(`step ${step.id}: ${prefix.join(" ")} did not run to its end: ${res.error.message}`);
  if (res.status === null) throw new Error(`step ${step.id}: ${prefix.join(" ")} was killed by ${res.signal}`);
  return { exit: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Replace exact roots on raw stream bytes; expected-aware comparison handles separators. */
function abstractBytes(bytes: Buffer, r: Roots, version: boolean): Buffer {
  let text = bytes.toString("latin1"); // one char per byte: nothing is decoded, nothing lost
  for (const [path, name] of placeholders(r)) {
    const raw = Buffer.from(path).toString("latin1");
    const escaped = Buffer.from(jsonStringContents(path)).toString("latin1");
    text = replaceExactWhere(text, escaped, name, inJsonString);
    text = replaceExactWhere(text, raw, name, (value, at) => !inJsonString(value, at));
  }
  if (version) for (const v of VERSIONS) text = text.split(v).join("${VERSION}");
  return Buffer.from(text, "latin1");
}

/** An expected stream: no file means empty; update mode writes none for an empty one. */
function readStream(file: string): Buffer {
  return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
}

function writeStream(file: string, bytes: Buffer): void {
  if (bytes.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

/** The relative paths under HOME a tree leaves out (README: trees): the marker, skilletor's state
 *  dir and the CLI's own, `${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skilletor`. */
function homeSkip(r: Roots, configDir: string | undefined): string[] {
  const skip = [".claude/skilletor", ".claude.json"];
  const rel = relative(r.home, join(configDir || join(r.home, ".claude"), "skilletor"));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) skip.push(rel.split(sep).join("/"));
  return skip;
}

/** The files a tree step compares (README: trees): HOME but the state dirs and the marker, all of
 *  PROJECT – each without the `.git` a `gitInit` made there – and all of `${TMP}/cwd`. */
function snapshot(r: Roots, skip: string[], gitInit: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const fileText = (root: string, rel: string) =>
    abstractRoots(readFileSync(join(root, rel), "utf8"), r, rel.endsWith(".json") ? "json" : "decoded");
  for (const rel of walk(r.home, gitInit.includes("home") ? [...skip, ".git"] : skip)) {
    out.set(`home/${escapeName(rel)}`, fileText(r.home, rel));
  }
  if (r.project) {
    for (const rel of walk(r.project, gitInit.includes("project") ? [".git"] : [])) {
      out.set(`project/${escapeName(rel)}`, fileText(r.project, rel));
    }
  }
  for (const rel of walk(r.cwd)) out.set(`cwd/${escapeName(rel)}`, fileText(r.cwd, rel));
  return out;
}

/** The snapshot's files that carry the owner's executable bit (README: trees), sorted. */
function executablesOf(r: Roots, have: Map<string, string>): string[] {
  const abs = (key: string) => {
    const rel = unescapeName(key);
    if (rel.startsWith("home/")) return join(r.home, rel.slice(5));
    return rel.startsWith("cwd/") ? join(r.cwd, rel.slice(4)) : join(r.project!, rel.slice(8));
  };
  return [...have.keys()].filter((rel) => (statSync(abs(rel)).mode & 0o100) !== 0).sort();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function runCase(name: string, t: TestContext): Promise<void> {
  const caseDir = join(ROOT, name);
  const c = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as Case;
  const live = walk(caseDir).filter((rel) => rel.split("/").some((s) => s.startsWith(".git")));
  assert.deepEqual(live, [], `${name}: fixture names starting with .git must be stored escaped (dot.gitignore)`);
  const created = mkdtempSync(join(tmpdir(), "skilletor-conformance-"));
  const tmp = process.platform === "win32" ? realpathSync.native(created) : realpathSync(created);
  const r: Roots = { tmp, home: join(tmp, "home"), cwd: join(tmp, "cwd") };
  if (existsSync(join(caseDir, "project"))) r.project = join(tmp, "project");
  const saved = { ...process.env };
  try {
    // The git config the engine's git runs with: this case's alone (README: environment).
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
    for (const v of ["CODEX_HOME", "HERMES_HOME", "CLAUDE_PLUGIN_ROOT", "CLAUDE_CONFIG_DIR"]) delete process.env[v];
    for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = concrete(v, r);
    buildGit(caseDir, c, r, { ...process.env, ...COMMIT_ENV });
    mkdirSync(join(r.home, ".claude"), { recursive: true });
    const marker = c.claude !== false; // false: no marker, Claude Code is not in use
    if (marker) writeFileSync(join(r.home, ".claude.json"), "{}\n"); // Claude Code is in use (spec §14.1)
    const cfgDir = process.env.CLAUDE_CONFIG_DIR; // Claude Code keeps its .claude.json inside a custom config dir
    if (cfgDir) {
      mkdirSync(cfgDir, { recursive: true });
      if (marker) writeFileSync(join(cfgDir, ".claude.json"), "{}\n");
    }
    copyInput(join(caseDir, "home"), r.home, r);
    if (r.project) {
      mkdirSync(r.project, { recursive: true });
      copyInput(join(caseDir, "project"), r.project, r);
    }
    mkdirSync(r.cwd);
    const gitInit = c.gitInit ?? [];
    for (const where of gitInit) {
      const dir = where === "home" ? r.home : where === "project" ? r.project : undefined;
      assert.ok(dir, `${name}: gitInit names ${where}, which this case does not have`);
      git(dir, process.env, "init", "-q", "-b", "main");
    }
    const ctx: EngineContext = {
      home: r.home,
      projectDir: r.project,
      stateRoot: join(r.home, ".claude", "skilletor"),
      codexHome: join(r.home, ".codex"),
      hermesHome: join(r.home, ".hermes"),
      host: { name: "conformance", os: "linux" },
      user: { name: "conformance", home: r.home },
      // Neither dir lies in a work tree – unless gitInit made one: then git answers, as for the CLI.
      ...(gitInit.length > 0 ? {} : { isGitWorkTree: () => false, gitTracked: () => [] }),
    };
    for (const step of c.steps) {
      const file = join(caseDir, "expected", `${step.id}.json`);
      let configDir = process.env.CLAUDE_CONFIG_DIR;
      if (step.op === "cli") {
        const env = cliEnv(c, step, r);
        configDir = env.CLAUDE_CONFIG_DIR;
        const got = runCli(await cli(), step, r, env);
        const stdout = abstractBytes(got.stdout, r, step.version === true);
        const stderr = abstractBytes(got.stderr, r, step.version === true);
        const base = join(caseDir, "expected", step.id);
        const hook = step.argv![0] === "hook";
        if (UPDATE) {
          assert.ok(!hook || got.exit === 0, `${name}: step ${step.id}: a hook exits 0, this one ${got.exit}`);
          writeJson(file, { exit: got.exit });
          writeStream(`${base}.stdout`, stdout);
          writeStream(`${base}.stderr`, stderr);
        } else {
          const want = JSON.parse(readFileSync(file, "utf8")) as { exit: unknown };
          assert.ok(!hook || want.exit === 0, `${name}: step ${step.id}: a hook step must expect exit 0`);
          assert.deepEqual(canonical({ exit: got.exit }), canonical(want), `${name}: step ${step.id}: the exit code; stderr: ${stderr}`);
          for (const [stream, bytes] of [["stdout", stdout], ["stderr", stderr]] as const) {
            const wantBytes = readStream(`${base}.${stream}`);
            const actualText = actualTextForExpected(bytes.toString("latin1"), wantBytes.toString("latin1"), "stream", r);
            const comparable = Buffer.from(actualText, "latin1");
            assert.equal(comparable.toString("utf8"), wantBytes.toString("utf8"), `${name}: step ${step.id}: ${stream}`);
            assert.ok(comparable.equals(wantBytes), `${name}: step ${step.id}: ${stream}, byte for byte`);
          }
        }
      } else {
        const actual = canonical(abstractDeep(await runStep(step, ctx), r));
        if (UPDATE) writeJson(file, actual);
        else {
          const expected = canonical(JSON.parse(readFileSync(file, "utf8")));
          assert.deepEqual(actualForExpected(actual, expected), expected, `${name}: step ${step.id}`);
        }
      }
      if (!step.tree) continue;
      const treeDir = join(caseDir, "expected", step.id);
      const have = snapshot(r, homeSkip(r, configDir), gitInit);
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
      for (const [rel, text] of want) {
        const actual = have.get(rel);
        assert.equal(typeof actual, "string", `${name}: step ${step.id}: ${rel}`);
        const encoding: EncodingContext = rel.endsWith(".json") ? "json" : "decoded";
        assert.equal(actualTextForExpected(actual!, text, encoding, r), text, `${name}: step ${step.id}: ${rel}`);
      }
      const wantExecs = existsSync(execFile) ? JSON.parse(readFileSync(execFile, "utf8")) : [];
      if (process.platform === "win32" && wantExecs.length > 0) {
        await t.test(`${name}: ${step.id}: executable bits`, {
          skip: "Windows filesystems expose no POSIX executable-bit contract",
        });
      } else {
        assert.deepEqual(execs, wantExecs, `${name}: step ${step.id}: the files with the executable bit`);
      }
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
  test(`conformance: ${name}`, (t) => runCase(name, t));
}

test("conformance: expected oracles distinguish native paths from literal escapes", () => {
  const r: Roots = {
    tmp: "C:\\Temp\\fixture",
    home: "C:\\Temp\\fixture\\home",
    project: "C:\\Temp\\fixture\\project",
    cwd: "C:\\Temp\\fixture\\cwd",
  };
  const input = '{"path":"${HOME}/child","literal":"keep\\\\literal"}';
  assert.deepEqual(JSON.parse(concreteJsonText(input, r)), {
    path: `${r.home}/child`,
    literal: "keep\\literal",
  });

  const structured = abstractDeep({
    path: `${r.home}\\child\\deep`,
    nativeComponents: `${r.home}\\next\\tab\\u1234`,
    escaped: `${r.home}\\dev\\t\\u001b[31m`,
    literal: "keep\\literal",
  }, r);
  const structuredExpected = {
    path: "${HOME}/child/deep",
    nativeComponents: "${HOME}/next/tab/u1234",
    escaped: "${HOME}/dev/t\\u001b[31m",
    literal: "keep\\literal",
  };
  assert.deepEqual(actualForExpected(structured, structuredExpected), structuredExpected);

  const stream = abstractBytes(Buffer.from(JSON.stringify({
    path: `${r.project}\\child\\deep`, literal: "keep\\literal",
  })), r, false).toString("latin1");
  const streamExpected = JSON.stringify({ path: "${PROJECT}/child/deep", literal: "keep\\literal" });
  assert.equal(actualTextForExpected(stream, streamExpected, "stream"), streamExpected);

  const rejectedRef = `--upload-pack=touch '${r.project}\\dash-pwned'`;
  const rejectedMessage = `skilletor: ${r.project}\\.claude\\skilletor.json: sources.team.ref ${JSON.stringify(rejectedRef)}` +
    ` must not start with ${JSON.stringify("-")} (git would read it as an option)`;
  const hookActual = abstractBytes(Buffer.from(JSON.stringify({ systemMessage: rejectedMessage }) + "\n"), r, false).toString("latin1");
  const portableRef = "--upload-pack=touch '${PROJECT}/dash-pwned'";
  const portableMessage = `skilletor: ${"${PROJECT}"}/.claude/skilletor.json: sources.team.ref ${JSON.stringify(portableRef)}` +
    ` must not start with ${JSON.stringify("-")} (git would read it as an option)`;
  const hookExpected = JSON.stringify({ systemMessage: portableMessage }) + "\n";
  assert.equal(actualTextForExpected(hookActual, hookExpected, "stream", r), hookExpected,
    "ordinary and nested JSON-stringified paths compare without changing the rejected payload");
  const nestedRoot = encodedRoot(r.project!, 2);
  assert.ok(hookActual.includes(nestedRoot), "fixture contains exactly two root-encoding layers");
  for (const depth of [0, 1, 3]) {
    assert.equal(oraclePathEqual(hookActual.replace(nestedRoot, encodedRoot(r.project!, depth)), hookExpected, "stream", r), false,
      `nested root at wrong encoding depth ${depth} fails`);
  }
  assert.equal(oraclePathEqual(hookActual.replace("--upload-pack=touch", "--upload-pack=remove"), hookExpected, "stream", r), false,
    "changed rejected payload fails");
  assert.equal(oraclePathEqual(hookActual.replace('\\"--upload-pack', '"--upload-pack'), hookExpected, "stream", r), false,
    "changed nested quoting fails");
  const removeOpening = (text: string) => text.replace('\\"--upload-pack', "--upload-pack");
  const removeClosing = (text: string) => text.replace("dash-pwned'\\\"", "dash-pwned'");
  const missingOpeningActual = removeOpening(hookActual);
  const missingOpeningExpected = removeOpening(hookExpected);
  const missingClosingActual = removeClosing(hookActual);
  const missingClosingExpected = removeClosing(hookExpected);
  assert.notEqual(missingOpeningExpected, hookExpected, "opening-quote fixture changed");
  assert.notEqual(missingClosingExpected, hookExpected, "closing-quote fixture changed");
  assert.equal(oraclePathEqual(missingOpeningActual, missingOpeningExpected, "stream", r), false,
    "unmatched expected closing quote gives no nested provenance");
  assert.equal(oraclePathEqual(missingClosingActual, missingClosingExpected, "stream", r), false,
    "later quoted '-' cannot close an unmatched expected opener");

  const rawJson = '{"message":"${HOME}/child\\nnext","tab":"${HOME}/child\\tnext","unicode":"${HOME}/child\\u1234",' +
    '"path":"${HOME}\\\\nested\\\\u-part","literal":"keep\\\\literal"}';
  const normalizedJson = '{"message":"${HOME}/child\\nnext","tab":"${HOME}/child\\tnext","unicode":"${HOME}/child\\u1234",' +
    '"path":"${HOME}/nested/u-part","literal":"keep\\\\literal"}';
  assert.equal(actualTextForExpected(abstractRoots(rawJson, r, "json"), normalizedJson, "json"), normalizedJson);
  assert.equal(actualTextForExpected(abstractBytes(Buffer.from(rawJson), r, false).toString("latin1"), normalizedJson, "stream"), normalizedJson);
  const malformedRoot = `{"path":"${r.home}\\child"}`;
  assert.equal(abstractRoots(malformedRoot, r, "json"), malformedRoot,
    "raw JSON root substitution does not repair unescaped Windows bytes");

  // The same ambiguous bytes are data or a path only because the expected oracle says which.
  assert.equal(oraclePathEqual("${HOME}/child\\next", "${HOME}/child\\next", "decoded"), true);
  assert.equal(oraclePathEqual("${HOME}/child\\next", "${HOME}/child/next", "decoded"), true);
  assert.equal(oraclePathEqual('"${HOME}/child\\next"', '"${HOME}/child/next"', "json"), false,
    "a single raw-JSON escape is never a separator");
  assert.equal(oraclePathEqual('"${HOME}/child\\\\next"', '"${HOME}/child/next"', "json"), true);
  assert.equal(oraclePathEqual('"${HOME}/dir with space\\\\file"', '"${HOME}/dir with space/file"', "json"), true);

  for (const [label, actual, expected, encoding] of [
    ["changed non-separator", "${HOME}\\child\\wrong", "${HOME}/child/right", "decoded"],
    ["extra escape", '"${HOME}\\\\child\\\\\\next"', '"${HOME}/child/next"', "json"],
    ["missing escape", '"${HOME}\\\\childnext"', '"${HOME}/child/next"', "json"],
    ["formatting", '{ "path":"${HOME}\\\\child"}', '{"path":"${HOME}/child"}', "stream"],
    ["unrelated after path", "${HOME}\\child; data \\value", "${HOME}/child; data /value", "decoded"],
  ] as const) {
    assert.equal(oraclePathEqual(actual, expected, encoding), false, label);
  }

  const duplicates = [{ path: "${HOME}\\a" }, { path: "${HOME}\\a" }];
  assert.equal(valuesEquivalent(duplicates, [{ path: "${HOME}/a" }, { path: "${HOME}/a" }]), true);
  assert.equal(valuesEquivalent(duplicates, [{ path: "${HOME}/a" }]), false, "missing duplicate fails");
  assert.equal(valuesEquivalent([{ path: "${HOME}\\b" }, { path: "${HOME}\\a" }],
    [{ path: "${HOME}/a" }, { path: "${HOME}/b" }]), true, "array order remains insignificant");

  assert.match(updatePlatformProblem(true, "win32") ?? "", /regenerate expectations on POSIX/);
  assert.equal(updatePlatformProblem(true, "linux"), undefined);
});

test("conformance: git fixture executable mode is declared independently for every commit", () => {
  const tmp = makeTmpDir("skilletor-conformance-mode-");
  try {
    const caseDir = join(tmp.dir, "case");
    for (const tree of ["one", "two"]) {
      const dir = join(caseDir, tree);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.sh"), "#!/bin/sh\nexit 0\n");
    }
    const fixture: Case = {
      description: "",
      git: { shared: { url: "https://conformance.invalid/shared.git", commits: [
        { tree: "one", executable: ["run.sh"] }, { tree: "two" },
      ] } },
      steps: [],
    };
    const histories: string[][] = [];
    for (const name of ["a", "b"]) {
      const root = join(tmp.dir, `run-${name}`);
      mkdirSync(root);
      const roots: Roots = { tmp: root, home: join(root, "home"), cwd: join(root, "cwd") };
      buildGit(caseDir, fixture, roots, {
        ...process.env, ...COMMIT_ENV,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.filemode", GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
      });
      const repo = join(root, "git", "shared");
      const commits = execFileSync("git", ["-C", repo, "rev-list", "--reverse", "HEAD"], { encoding: "utf8" }).trim().split("\n");
      const modes = commits.map((commit) => execFileSync("git", ["-C", repo, "ls-tree", commit, "--", "run.sh"], { encoding: "utf8" }).slice(0, 6));
      assert.deepEqual(modes, ["100755", "100644"]);
      const trees = commits.map((commit) => execFileSync("git", ["-C", repo, "show", "-s", "--format=%T", commit], { encoding: "utf8" }).trim());
      assert.notEqual(trees[0], trees[1], "mode-only change has a different exact Git tree");
      histories.push(commits);
    }
    assert.deepEqual(histories[0], histories[1], "fixed metadata produces exact commit identities");
  } finally {
    tmp.cleanup();
  }
});

// The harness itself (README: cli), on a stand-in CLI that reports what it got. Asserts: the
// child's environment is exactly the fixed variables, the case's and the step's (a variable of
// the runner – CLAUDE_PROJECT_DIR here – never leaks in, `null` unsets); argv, cwd and stdin take
// the input placeholders; stdin is a string's bytes or a value's JSON.
test("conformance: a cli step's CLI gets the README's environment, argv, cwd and stdin – nothing else", () => {
  const created = mkdtempSync(join(tmpdir(), "skilletor-conformance-"));
  const tmp = process.platform === "win32" ? realpathSync.native(created) : realpathSync(created);
  const r: Roots = { tmp, home: join(tmp, "home"), cwd: join(tmp, "cwd") };
  mkdirSync(r.cwd);
  const echo = [process.execPath, "-e", "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env, stdin: require('node:fs').readFileSync(0, 'utf8') }))"];
  const c: Case = { description: "", env: { CLAUDE_CONFIG_DIR: "${HOME}/cfg", DROPPED: "x" }, steps: [] };
  const step: Step = { id: "echo", op: "cli", argv: ["status", "${HOME}"], env: { DROPPED: null, EXTRA: "${TMP}/e" }, stdin: { cwd: "${HOME}", n: [1] } };
  const forbidden = ["CLAUDE_PROJECT_DIR", "SKILLETOR_BIN", "GITHUB_TOKEN"] as const;
  const saved = Object.fromEntries(forbidden.map((name) => [name, process.env[name]])) as Record<string, string | undefined>;
  for (const name of forbidden) process.env[name] = `conformance-forbidden-${name}`;
  try {
    const got = JSON.parse(runCli(echo, step, r, cliEnv(c, step, r)).stdout.toString("utf8")) as {
      argv: string[]; cwd: string; env: Record<string, string>; stdin: string;
    };
    assert.deepEqual(got.argv, ["status", r.home]);
    assert.equal(got.cwd, r.cwd);
    assert.equal(got.stdin, JSON.stringify({ cwd: r.home, n: [1] }));
    const want: Record<string, string> = {
      PATH: process.env.PATH ?? "", ...homeEnv(r.home), CODEX_HOME: join(r.home, ".codex"),
      GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C",
      CLAUDE_CONFIG_DIR: concrete("${HOME}/cfg", r), EXTRA: concrete("${TMP}/e", r),
    };
    if (process.platform === "win32") Object.assign(want, { TEMP: r.tmp, TMP: r.tmp });
    if (process.env.PERL5LIB !== undefined) want.PERL5LIB = process.env.PERL5LIB;
    const allowedRuntimeAdditions = new Set(process.platform === "darwin"
      ? ["__CF_USER_TEXT_ENCODING"]
      : process.platform === "win32"
        ? ["LOGONSERVER", "SYSTEMDRIVE", "SYSTEMROOT", "USERDOMAIN", "USERNAME", "WINDIR"]
        : []);
    const unexpected = Object.keys(got.env).filter((name) => !(name in want) && !allowedRuntimeAdditions.has(name));
    assert.deepEqual(unexpected, [], `unexpected child environment keys: ${unexpected.join(", ")}`);
    const stable = Object.fromEntries(Object.entries(got.env).filter(([name]) => !allowedRuntimeAdditions.has(name)));
    assert.deepEqual(stable, want);
    for (const name of forbidden) assert.equal(got.env[name], undefined, `${name} does not leak`);
    const raw = { ...step, stdin: "not json ${TMP}", cwd: "${HOME}" };
    mkdirSync(r.home);
    const got2 = JSON.parse(runCli(echo, raw, r, cliEnv(c, raw, r)).stdout.toString("utf8"));
    assert.equal(got2.stdin, `not json ${tmp}`);
    assert.equal(got2.cwd, r.home);
  } finally {
    for (const name of forbidden) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("conformance: a cli step fails when its CLI dies of a POSIX signal", {
  skip: process.platform === "win32" ? "Windows reports process termination as an exit status, not a POSIX child signal" : false,
}, () => {
  const r: Roots = { tmp: tmpdir(), home: tmpdir(), cwd: tmpdir() };
  const step: Step = { id: "dies", op: "cli", argv: [] };
  const env = { PATH: process.env.PATH ?? "" };
  assert.throws(() => runCli([process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"], step, r, env), /killed by SIGKILL/);
});

test("conformance: a cli step fails when its CLI outlives its timeout", () => {
  const r: Roots = { tmp: tmpdir(), home: tmpdir(), cwd: tmpdir() };
  const step: Step = { id: "times-out", op: "cli", argv: [] };
  const env = { PATH: process.env.PATH ?? "" };
  assert.throws(() => runCli([process.execPath, "-e", "setTimeout(() => {}, 10000)"], step, r, env, 300), /did not run to its end.*ETIMEDOUT/);
});
