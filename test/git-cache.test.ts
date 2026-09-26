// Stale git lock files in the git cache (k84): real git, local bare repos, temp dirs.
// A git killed midway (SIGKILL: a hook timeout, a crash) leaves its `*.lock` files behind;
// git never removes another process's lock, so every later fetch or reset of that cache
// failed and fell back to the old cache with a warning, forever. The run that takes the sync
// lock sweeps them (spec §6.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { GitSource, sweepGitCache } from "../src/sources/git.ts";
import { UrlSource } from "../src/sources/url.ts";
import { sync, type EngineContext } from "../src/engine.ts";

const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: G, encoding: "utf8" }).trim();

/** A bare repo with one skill; `commit(body)` pushes a new version of it. */
function makeRepo(tmp: TmpDir) {
  const bare = join(tmp.dir, "repo.git");
  const work = join(tmp.dir, "work");
  git(tmp.dir, "init", "-q", "-b", "main", "--bare", bare);
  mkdirSync(join(work, "skills/foo"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  const url = "file://" + resolvePath(bare);
  const commit = (body: string) => {
    writeFileSync(join(work, "skills/foo/SKILL.md"), `---\ndescription: foo\n---\n${body}\n`);
    git(work, "add", ".");
    git(work, "commit", "-qm", body);
    git(work, "push", "-q", url, "main");
  };
  return { url, commit };
}

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);

/** Write `path` (parents made); `stale` backdates it past the sweep's age. */
function plant(path: string, stale = true): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  if (stale) utimesSync(path, TEN_MINUTES_AGO(), TEN_MINUTES_AGO());
  return path;
}

/** Every file named `*.lock` under `root`, relative, sorted (never through a symlink). */
function lockFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith(".lock")) out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

// Asserts: after a first sync installed `foo` and upstream moved on, the lock files a git
// killed midway leaves in the source's cache – `index.lock` (reset), `shallow.lock` (fetch),
// the checked-out branch's ref lock (reset) – no longer strand it: the next sync clears them
// before it resolves, so it fetches and installs the new version with no warning, and none
// of them is left.
test("k84: a sync clears the lock files a killed git left in its cache; the fetch succeeds, no warning", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("FIRST");
  const home = join(tmp.dir, "home");
  const stateRoot = join(tmp.dir, "state");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/skilletor.json"), JSON.stringify({
    targets: ["claude"], sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] },
  }));
  const ctx: EngineContext = {
    home, stateRoot, codexHome: join(tmp.dir, "codex"), markers: { claude: [], codex: [] }, isGitWorkTree: () => false,
  };
  const installed = join(home, ".claude/skills/foo/SKILL.md");
  const first = await sync(ctx);
  assert.equal(first.error, undefined);
  assert.match(readFileSync(installed, "utf8"), /FIRST/);

  repo.commit("SECOND");
  const cacheRoot = join(stateRoot, "cache");
  const [cache, ...others] = readdirSync(cacheRoot);
  assert.deepEqual(others, [], "one source, one cache");
  const gitDir = join(cacheRoot, cache!, ".git");
  const branch = git(join(cacheRoot, cache!), "symbolic-ref", "HEAD"); // init.defaultBranch decides it
  for (const rel of ["index.lock", "shallow.lock", `${branch}.lock`]) plant(join(gitDir, rel));

  const report = await sync(ctx);
  assert.equal(report.error, undefined);
  assert.deepEqual(report.scopes[0]!.warnings, []);
  assert.deepEqual(report.scopes[0]!.updated.map((i) => i.key), ["skills/foo"]);
  assert.match(readFileSync(installed, "utf8"), /SECOND/);
  assert.deepEqual(lockFiles(gitDir), []);
});

// Asserts what the sweep touches: in a dir named like a git cache (16 hex digits) whose `.git`
// is a real directory, git's lock files for what resolve runs – fixed names in `.git`, any
// `*.lock` under `.git/refs` (a ref name cannot end in `.lock`) – once older than 5 minutes.
// Left: a younger one (a git still at work may hold it), other names in `.git`, `objects/`,
// the checkout; a url cache's tree even when it carries files named like git's locks; a
// repo in a dir not named like a cache; a `.git` or refs dir that is a symlink. The cache
// still resolves afterwards.
test("k84: the sweep removes stale git lock files in git caches and nothing else", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("FIRST");
  const cacheRoot = join(tmp.dir, "cache");
  const src = new GitSource({ url: repo.url, cacheRoot });
  const loc = await src.resolve();
  const gitDir = join(loc.dir, ".git");
  const branch = git(loc.dir, "symbolic-ref", "HEAD");

  const swept = [
    "index.lock", "shallow.lock", "config.lock", "HEAD.lock", "ORIG_HEAD.lock", "packed-refs.lock",
    "reftable/tables.list.lock", `${branch}.lock`, "refs/remotes/origin/main.lock", "refs/remotes/origin/team/deep.lock",
  ].map((rel) => plant(join(gitDir, rel)));
  const kept = [
    plant(join(gitDir, "refs/tags/v1.lock"), false), // younger than 5 minutes: maybe a live git's
    plant(join(gitDir, "objects/info/commit-graph.lock")), // objects/ is never walked
    plant(join(gitDir, "unknown.lock")), // not a lock git takes for resolve
    plant(join(gitDir, "logs/refs/heads/x.lock")),
    plant(join(loc.dir, "index.lock")), // the checkout, not `.git`
    plant(join(loc.dir, "skills/foo/shallow.lock")),
    plant(join(tmp.dir, "elsewhere/.git/index.lock")), // outside the cache root
    plant(join(cacheRoot, "notacache/.git/index.lock")), // a repo not named like a cache
    plant(join(tmp.dir, "linked/x.lock")),
    plant(join(tmp.dir, "linked-repo/.git/index.lock")),
  ];
  symlinkSync(join(tmp.dir, "linked"), join(gitDir, "refs/remotes/linked")); // never followed
  mkdirSync(join(cacheRoot, "00112233445566ff"));
  symlinkSync(join(tmp.dir, "linked-repo/.git"), join(cacheRoot, "00112233445566ff/.git")); // never followed

  // A url cache: its tree carries files named like git's locks, at the top and deeper.
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(makeTarGz([
    { name: "pkg/index.lock", data: "" }, { name: "pkg/shallow.lock", data: "" }, { name: "pkg/refs/heads/x.lock", data: "" },
    { name: "pkg/skills/bar/SKILL.md", data: "bar\n" },
  ])), { headers: { etag: '"1"' } }));
  const url = await new UrlSource({ url: "https://example.invalid/s.tar.gz", cacheRoot }).resolve();
  for (const rel of ["index.lock", "shallow.lock", "refs/heads/x.lock"]) {
    const path = join(url.dir, rel);
    utimesSync(path, TEN_MINUTES_AGO(), TEN_MINUTES_AGO());
    kept.push(path);
  }

  sweepGitCache(cacheRoot);
  assert.deepEqual(swept.filter((p) => existsSync(p)), [], "stale git lock files in a git cache are removed");
  assert.deepEqual(kept.filter((p) => !existsSync(p)), [], "everything else is left");

  repo.commit("SECOND");
  const again = await src.resolve(loc.version);
  assert.equal(again.warning, undefined);
  assert.notEqual(again.version, loc.version);
});

// Asserts: the sweep never throws – a missing cache root, a cache root that is a file, a
// cache-named file, a cache without `.git` and a `.git` that is a file (a gitfile) are no
// error, and nothing is removed (it runs on the hook path, spec §8).
test("k84: the sweep of a missing root or odd entries is silent", () => {
  const tmp = makeTmpDir();
  try {
    sweepGitCache(join(tmp.dir, "missing"));
    writeFileSync(join(tmp.dir, "file"), "not a dir");
    sweepGitCache(join(tmp.dir, "file"));
    const root = join(tmp.dir, "cache");
    plant(join(root, "0123456789abcdef"));
    plant(join(root, "fedcba9876543210/index.lock"));
    plant(join(root, "00112233445566ff/.git"));
    sweepGitCache(root);
    assert.deepEqual(readdirSync(root).sort(), ["00112233445566ff", "0123456789abcdef", "fedcba9876543210"]);
    assert.equal(existsSync(join(root, "fedcba9876543210/index.lock")), true);
  } finally {
    tmp.cleanup();
  }
});
