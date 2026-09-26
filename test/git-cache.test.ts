// What a git killed midway (SIGKILL: a hook timeout, a crash) leaves in the git cache: real
// git, local bare repos, temp dirs.
// k84: its `*.lock` files; git never removes another process's lock, so every later fetch or
// reset of that cache failed and fell back to the old cache with a warning, forever. The run
// that takes the sync lock sweeps them (spec §6.5).
// k90: a cache it was creating – a repo without `origin` or without a commit; every fetch
// failed and there was no commit to fall back to, so the source failed every sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
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
  const again = await src.resolve();
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

/** Where a run creating the cache `dir` was killed: inside `git init` (a `.git` it never
 *  finished, here an empty one), after `git init`, or during the first fetch (after `remote add`). */
const KILLED = ["inside git init", "after git init", "during the first fetch"] as const;
type Killed = (typeof KILLED)[number];

/** Replace the cache `dir` with what a run killed at `killed` leaves. */
function plantKilledCache(dir: string, url: string, killed: Killed): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (killed === "inside git init") return;
  git(dir, "init", "-q");
  if (killed === "during the first fetch") git(dir, "remote", "add", "origin", url);
}

// Asserts: a first sync killed while it created the source's cache – inside `git init`, after
// it (no `origin`), or during the first fetch (no commit) – does not strand the source: the next
// sync fetches into that same cache and installs `foo` with no error and no warning, and the
// cache's `origin` is the source's address.
for (const killed of KILLED) {
  test(`k90: a first sync killed ${killed} leaves a cache the next sync installs from`, async (t) => {
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
    const cacheRoot = join(stateRoot, "cache");
    // The dir a sync resolves this source into, then left as the killed run left it.
    const cache = (await new GitSource({ url: repo.url, cacheRoot }).resolve()).dir;
    plantKilledCache(cache, repo.url, killed);

    const report = await sync(ctx);
    assert.equal(report.error, undefined);
    assert.deepEqual(report.scopes[0]!.warnings, []);
    assert.deepEqual(report.scopes[0]!.added.map((i) => i.key), ["skills/foo"]);
    assert.match(readFileSync(join(home, ".claude/skills/foo/SKILL.md"), "utf8"), /FIRST/);
    assert.deepEqual(readdirSync(cacheRoot), [basename(cache)], "the sync used the planted cache");
    assert.equal(git(cache, "config", "--local", "--get", "remote.origin.url"), repo.url);
  });
}

// Asserts: with the remote unreachable, a cache a killed run left without a commit – with or
// without `origin`, unpinned or pinned to a SHA – is no cache: resolve fails with the fetch
// error, never a "using cache" warning over an empty tree, and names no cache it rejected.
for (const killed of KILLED) {
  for (const pinned of [false, true]) {
    test(`k90: a cache killed ${killed}, remote unreachable: ${pinned ? "a pinned" : "an unpinned"} resolve errors, no cache`, async (t) => {
      const tmp = makeTmpDir();
      t.after(tmp.cleanup);
      const repo = makeRepo(tmp);
      repo.commit("FIRST");
      const sha = git(tmp.dir, "ls-remote", repo.url, "HEAD").split("\t")[0]!;
      const src = new GitSource({ url: repo.url, ref: pinned ? sha : undefined, cacheRoot: join(tmp.dir, "cache") });
      plantKilledCache((await src.resolve()).dir, repo.url, killed);
      rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
      await assert.rejects(() => src.resolve(), (err: Error) => {
        assert.match(err.message, /^git source .* failed: git fetch/);
        assert.doesNotMatch(err.message, /using cache|cache rejected|rev-parse/);
        return true;
      });
    });
  }
}

// Asserts: a whole cache is fetched into as it stands – not re-created: an object only it holds
// survives the next resolve, which takes the new commit with no warning; `origin` is unchanged.
test("k90: a whole cache is fetched into, not re-created: its objects are kept", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("FIRST");
  const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
  const first = await src.resolve();
  writeFileSync(join(tmp.dir, "marker"), "k90 marker\n");
  const marker = git(first.dir, "hash-object", "-w", join(tmp.dir, "marker"));

  repo.commit("SECOND");
  const second = await src.resolve();
  assert.equal(second.warning, undefined);
  assert.notEqual(second.version, first.version);
  assert.match(readFileSync(join(second.dir, "skills/foo/SKILL.md"), "utf8"), /SECOND/);
  assert.doesNotThrow(() => git(second.dir, "cat-file", "-e", marker), "the cache was re-created");
  assert.equal(git(second.dir, "config", "--local", "--get", "remote.origin.url"), repo.url);
});

// Asserts: a cache whose `origin` names another address is pointed back at the source's before
// the fetch: resolve takes the source's commit, no warning.
test("k90: a cache whose origin names another address is pointed back at the source's", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("FIRST");
  const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
  const first = await src.resolve();
  git(first.dir, "remote", "set-url", "origin", "file://" + join(tmp.dir, "elsewhere.git"));
  repo.commit("SECOND");
  const second = await src.resolve();
  assert.equal(second.warning, undefined);
  assert.match(readFileSync(join(second.dir, "skills/foo/SKILL.md"), "utf8"), /SECOND/);
  assert.equal(git(second.dir, "config", "--local", "--get", "remote.origin.url"), repo.url);
});

// The cache root lies inside another repository (the default `~/.claude/skilletor/cache` under a
// versioned `~/.claude`). A `.git` a killed `git init` left unfinished is no repository to git,
// which then looked for one further up and ran the cache's `remote`, `fetch` and `reset --hard`
// in the enclosing one. Asserts, with and without an `origin` there: resolve completes the
// cache's own repo and serves the source with no warning; the enclosing repo keeps its remotes,
// its HEAD and its files.
for (const outerOrigin of [false, true]) {
  test(`k90: a cache left inside git init never reaches the enclosing repository (${outerOrigin ? "with" : "without"} origin)`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const repo = makeRepo(tmp);
    repo.commit("FIRST");
    const outer = join(tmp.dir, "outer");
    mkdirSync(outer);
    git(outer, "init", "-q", "-b", "main");
    writeFileSync(join(outer, "mine.txt"), "mine\n");
    git(outer, "add", ".");
    git(outer, "commit", "-qm", "mine");
    if (outerOrigin) git(outer, "remote", "add", "origin", "file://" + join(tmp.dir, "dotfiles.git"));
    const remotes = git(outer, "remote", "-v");
    const head = git(outer, "rev-parse", "HEAD");

    const src = new GitSource({ url: repo.url, cacheRoot: join(outer, "cache") });
    const dir = (await src.resolve()).dir;
    plantKilledCache(dir, repo.url, "inside git init");
    const loc = await src.resolve();
    assert.equal(git(outer, "remote", "-v"), remotes, "the enclosing repo's remotes changed");
    assert.equal(git(outer, "rev-parse", "HEAD"), head, "the enclosing repo's HEAD moved");
    assert.equal(existsSync(join(outer, "mine.txt")) && readFileSync(join(outer, "mine.txt"), "utf8"), "mine\n",
      "the enclosing repo's files changed");
    assert.equal(loc.warning, undefined);
    assert.equal(loc.dir, dir);
    assert.match(readFileSync(join(dir, "skills/foo/SKILL.md"), "utf8"), /FIRST/);
    assert.equal(git(dir, "rev-parse", "--absolute-git-dir"), join(realpathSync(dir), ".git"));
  });
}
