// One resolve per source cache and run (k83): real git through a logging `git` on PATH,
// mocked downloads, temp dirs. Two source names with the same git URL and ref share one
// cache dir (k69), and a sync resolves its sources in parallel: two `git fetch`/`reset --hard`
// ran in one repo at once (index.lock races, a torn reset, one name falling back to the cache
// with a warning). A sync now resolves each backend once and gives every name that result.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { sync, type EngineContext } from "../src/engine.ts";
import { readLock } from "../src/lock.ts";

const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: G, encoding: "utf8" }).trim();

const SKILLS = ["foo", "bar", "baz", "qux"];

/** A bare repo with the skills in SKILLS; `commit(body)` pushes a new version of all of them. */
function makeRepo(tmp: TmpDir) {
  const bare = join(tmp.dir, "repo.git");
  const work = join(tmp.dir, "work");
  git(tmp.dir, "init", "-q", "-b", "main", "--bare", bare);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const url = "file://" + resolvePath(bare);
  const commit = (body: string) => {
    for (const s of SKILLS) {
      mkdirSync(join(work, "skills", s), { recursive: true });
      writeFileSync(join(work, "skills", s, "SKILL.md"), `---\ndescription: ${s}\n---\n${body}\n`);
    }
    git(work, "add", ".");
    git(work, "commit", "-qm", body);
    git(work, "push", "-q", url, "main");
  };
  return { bare, url, commit };
}

/**
 * Put a `git` first on PATH that logs each call's directory and arguments, then runs the real
 * one (the fixture's `git` above keeps the real PATH). `fetches()` counts the `git fetch`
 * calls per cache dir under `cacheRoot`.
 */
function logGit(t: TestContext, tmp: TmpDir, cacheRoot: string) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(tmp.dir, "bin");
  const log = join(tmp.dir, "git.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> '${log}'\nexec '${real}' "$@"\n`, {
    mode: 0o755,
  });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return {
    fetches(): Record<string, number> {
      const root = realpathSync(cacheRoot);
      const out: Record<string, number> = {};
      for (const line of readFileSync(log, "utf8").split("\n")) {
        const [cwd, args] = line.split("\t");
        if (!cwd || !args?.startsWith("fetch ") || dirname(cwd) !== root) continue;
        out[cwd.slice(root.length + 1)] = (out[cwd.slice(root.length + 1)] ?? 0) + 1;
      }
      return out;
    },
  };
}

function setup(t: TestContext) {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  const stateRoot = join(tmp.dir, "state");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: EngineContext = {
    home, projectDir, stateRoot, codexHome: join(tmp.dir, "codex"), markers: { claude: [], codex: [] },
    isGitWorkTree: () => false,
  };
  const writeCfg = (which: "user" | "project", obj: unknown) =>
    writeFileSync(join(which === "user" ? home : projectDir, ".claude/skilletor.json"), JSON.stringify(obj));
  const skill = (base: string, name: string) => readFileSync(join(base, ".claude/skills", name, "SKILL.md"), "utf8");
  return { tmp, home, projectDir, stateRoot, cacheRoot: join(stateRoot, "cache"), ctx, writeCfg, skill };
}

// Asserts: two names with one git URL (g, h) and two with that URL and ref `main` (p, q) –
// two caches (k69) – are each fetched exactly once in a sync, every name is resolved (its
// skill installed from the one commit, the lock records one version per cache) and the report
// has no warning. The next sync, after upstream moved on, fetches each cache once more:
// the sharing never outlives the run.
test("k83: names sharing a git cache are fetched once per sync; the next sync fetches again", async (t) => {
  const e = setup(t);
  const repo = makeRepo(e.tmp);
  repo.commit("FIRST");
  e.writeCfg("user", {
    targets: ["claude"],
    sources: { g: { git: repo.url }, h: { git: repo.url }, p: { git: repo.url, ref: "main" }, q: { git: repo.url, ref: "main" } },
    install: { skills: ["foo@g", "bar@h", "baz@p", "qux@q"] },
  });
  const log = logGit(t, e.tmp, e.cacheRoot);

  const first = await sync(e.ctx, { scope: "user" });
  assert.equal(first.error, undefined);
  assert.deepEqual(first.scopes[0]!.warnings, []);
  assert.deepEqual(first.scopes[0]!.added.map((i) => i.key).sort(), ["skills/bar", "skills/baz", "skills/foo", "skills/qux"]);
  const caches = readdirSync(e.cacheRoot).sort();
  assert.equal(caches.length, 2, "one cache per URL and ref");
  assert.deepEqual(log.fetches(), Object.fromEntries(caches.map((c) => [c, 1])), "one fetch per cache");
  for (const s of SKILLS) assert.match(e.skill(e.home, s), /FIRST/);
  const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
  assert.equal(lock["skills/foo"]!.version, lock["skills/bar"]!.version);
  assert.equal(lock["skills/baz"]!.version, lock["skills/qux"]!.version);

  repo.commit("SECOND");
  const second = await sync(e.ctx, { scope: "user" });
  assert.equal(second.error, undefined);
  assert.deepEqual(second.scopes[0]!.warnings, []);
  assert.deepEqual(second.scopes[0]!.updated.map((i) => i.key).sort(), ["skills/bar", "skills/baz", "skills/foo", "skills/qux"]);
  assert.deepEqual(log.fetches(), Object.fromEntries(caches.map((c) => [c, 2])), "a later sync fetches again");
  for (const s of SKILLS) assert.match(e.skill(e.home, s), /SECOND/);
});

// Asserts: a source the user scope and the project scope both install from is fetched once
// in a sync of both scopes (the scopes run one after the other, never at once; the run's
// one resolve serves both), both scopes install from it with no warning; a later sync
// fetches again.
test("k83: one sync of both scopes fetches a shared source once", async (t) => {
  const e = setup(t);
  const repo = makeRepo(e.tmp);
  repo.commit("FIRST");
  e.writeCfg("user", { targets: ["claude"], sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] } });
  e.writeCfg("project", { install: { skills: ["bar@g"] } });
  const log = logGit(t, e.tmp, e.cacheRoot);

  const report = await sync(e.ctx);
  assert.equal(report.error, undefined);
  assert.deepEqual(report.scopes.map((s) => [s.scope, s.warnings, s.added.map((i) => i.key)]), [
    ["user", [], ["skills/foo"]],
    ["project", [], ["skills/bar"]],
  ]);
  const [cache] = readdirSync(e.cacheRoot);
  assert.deepEqual(log.fetches(), { [cache!]: 1 });
  assert.match(e.skill(e.home, "foo"), /FIRST/);
  assert.match(e.skill(e.projectDir, "bar"), /FIRST/);

  await sync(e.ctx);
  assert.deepEqual(log.fetches(), { [cache!]: 2 }, "a later sync fetches again");
});

// Asserts: when the one fetch of a shared git cache fails (the remote is gone), each name is
// served from the cache – its item kept, no error – and the report names the failure once,
// not once per name.
test("k83: a failed shared fetch serves every name from the cache with one warning", async (t) => {
  const e = setup(t);
  const repo = makeRepo(e.tmp);
  repo.commit("FIRST");
  e.writeCfg("user", {
    targets: ["claude"], sources: { g: { git: repo.url }, h: { git: repo.url } }, install: { skills: ["foo@g", "bar@h"] },
  });
  const first = await sync(e.ctx, { scope: "user" });
  assert.deepEqual(first.scopes[0]!.warnings, []);

  renameSync(repo.bare, `${repo.bare}.gone`);
  const log = logGit(t, e.tmp, e.cacheRoot);
  const report = await sync(e.ctx, { scope: "user" });
  assert.equal(report.error, undefined);
  const rep = report.scopes[0]!;
  assert.equal(rep.warnings.length, 1, rep.warnings.join("\n"));
  assert.match(rep.warnings[0]!, /^git fetch failed for .*, using cache/);
  assert.deepEqual(rep.unchanged.map((i) => i.key).sort(), ["skills/bar", "skills/foo"]);
  assert.deepEqual(Object.values(log.fetches()), [1]);
});

const URL = "https://example.invalid/skills.tar.gz";

// Asserts for `url` sources: names with the same URL share one download when they would send
// the same conditional GET – two names new to the lock send none, so one request. A name
// whose lock holds the current ETag sends it, and only it receives the 304: the new names
// get their own unconditional GET, never an answer to an ETag they do not hold. Every item is
// installed, no warning, and the lock records the one version.
test("k83: url names share a download only when they send the same If-None-Match", async (t) => {
  const e = setup(t);
  const archive = makeTarGz(SKILLS.map((s) => ({ name: `pkg/skills/${s}/SKILL.md`, data: `---\ndescription: ${s}\n---\nBODY\n` })));
  const sent: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (...[, opts]: Parameters<typeof fetch>) => {
    const inm = new Headers(opts?.headers).get("If-None-Match");
    sent.push(inm);
    if (inm === '"1"') return new Response(null, { status: 304 });
    return new Response(new Uint8Array(archive), { headers: { etag: '"1"' } });
  });

  e.writeCfg("user", { targets: ["claude"], sources: { a: { url: URL } }, install: { skills: ["foo@a"] } });
  const first = await sync(e.ctx, { scope: "user" });
  assert.deepEqual(first.scopes[0]!.warnings, []);
  assert.deepEqual(sent, [null]);

  sent.length = 0;
  e.writeCfg("user", {
    targets: ["claude"],
    sources: { a: { url: URL }, b: { url: URL }, c: { url: URL } },
    install: { skills: ["foo@a", "bar@b", "baz@c"] },
  });
  const second = await sync(e.ctx, { scope: "user" });
  assert.equal(second.error, undefined);
  assert.deepEqual(second.scopes[0]!.warnings, []);
  assert.deepEqual(second.scopes[0]!.added.map((i) => i.key).sort(), ["skills/bar", "skills/baz"]);
  assert.deepEqual(sent.map(String).sort(), ['"1"', "null"], "a's conditional GET, and one GET for b and c");
  const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
  assert.deepEqual(["foo", "bar", "baz"].map((s) => lock[`skills/${s}`]!.version), ['etag:"1"', 'etag:"1"', 'etag:"1"']);
});
