// Tests for the git source backend, against local bare repos (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";
import { GitSource } from "../src/sources/git.ts";

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ENV } });
}

/** A local bare repo plus a working clone to push commits/tags from. */
function makeRepo(tmp: TmpDir) {
  const bare = join(tmp.dir, "bare.git");
  const work = join(tmp.dir, "work");
  git(tmp.dir, "init", "-q", "-b", "main", "--bare", bare);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const url = "file://" + resolvePath(bare);
  const commit = (content: string, msg: string) => {
    writeFileSync(join(work, "file.txt"), content);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", msg);
    git(work, "push", "-q", url, "main");
    return git(work, "rev-parse", "HEAD").trim();
  };
  const tag = (name: string) => {
    git(work, "tag", name);
    git(work, "push", "-q", url, name);
  };
  const branch = (name: string) => {
    git(work, "branch", name);
    git(work, "push", "-q", url, name);
  };
  return { url, commit, tag, branch };
}

test("first resolve clones and checks out the source", async () => {
  const tmp = makeTmpDir();
  try {
    const repo = makeRepo(tmp);
    repo.commit("hello", "first");
    const cache = join(tmp.dir, "cache");
    const src = new GitSource({ url: repo.url, cacheRoot: cache });
    const loc = await src.resolve();
    assert.equal(readFileSync(join(loc.dir, "file.txt"), "utf8"), "hello");
    assert.match(loc.version, /^git:[0-9a-f]{7,}/);
    assert.equal(loc.warning, undefined);
  } finally {
    tmp.cleanup();
  }
});

test("resolve updates an existing cache after a new commit", async () => {
  const tmp = makeTmpDir();
  try {
    const repo = makeRepo(tmp);
    repo.commit("v1", "first");
    const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
    const first = await src.resolve();
    repo.commit("v2", "second");
    const second = await src.resolve();
    assert.equal(readFileSync(join(second.dir, "file.txt"), "utf8"), "v2");
    assert.notEqual(first.version, second.version);
  } finally {
    tmp.cleanup();
  }
});

test("a pinned tag stays put when the branch moves on", async () => {
  const tmp = makeTmpDir();
  try {
    const repo = makeRepo(tmp);
    repo.commit("tagged", "first");
    repo.tag("v1");
    repo.commit("moved on", "second");
    const src = new GitSource({ url: repo.url, ref: "v1", cacheRoot: join(tmp.dir, "cache") });
    const loc = await src.resolve();
    assert.equal(readFileSync(join(loc.dir, "file.txt"), "utf8"), "tagged");
  } finally {
    tmp.cleanup();
  }
});

test("check reports false when unchanged and true after a new commit", async () => {
  const tmp = makeTmpDir();
  try {
    const repo = makeRepo(tmp);
    repo.commit("a", "first");
    const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
    const loc = await src.resolve();
    assert.equal(await src.check(loc.version), false);
    repo.commit("b", "second");
    assert.equal(await src.check(loc.version), true);
  } finally {
    tmp.cleanup();
  }
});

test("offline fallback: uses the cache with a warning when the remote is gone", async () => {
  const tmp = makeTmpDir();
  try {
    const repo = makeRepo(tmp);
    repo.commit("cached", "first");
    const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
    const first = await src.resolve();
    // Remove the remote so fetch fails.
    rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
    const second = await src.resolve();
    assert.equal(readFileSync(join(second.dir, "file.txt"), "utf8"), "cached");
    assert.equal(second.version, first.version);
    assert.match(second.warning ?? "", /cache/i);
  } finally {
    tmp.cleanup();
  }
});

test("full SHA pins of the same URL retain independent trees", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const a = repo.commit("A", "first");
  const b = repo.commit("B", "second");
  const cacheRoot = join(tmp.dir, "cache");
  const first = await new GitSource({ url: repo.url, ref: a, cacheRoot }).resolve();
  const second = await new GitSource({ url: repo.url, ref: b, cacheRoot }).resolve();
  assert.notEqual(first.dir, second.dir, "one pin must not reset another pin's tree");
  assert.equal(readFileSync(join(first.dir, "file.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(second.dir, "file.txt"), "utf8"), "B");
  assert.equal(git(first.dir, "rev-parse", "HEAD").trim(), a);
  assert.equal(git(second.dir, "rev-parse", "HEAD").trim(), b);
});

test("offline pin A after resolving B still returns A, including its version", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const a = repo.commit("A", "first");
  const b = repo.commit("B", "second");
  const cacheRoot = join(tmp.dir, "cache");
  const first = await new GitSource({ url: repo.url, ref: a, cacheRoot }).resolve();
  const second = await new GitSource({ url: repo.url, ref: b, cacheRoot }).resolve();
  rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
  const offline = await new GitSource({ url: repo.url, ref: a, cacheRoot }).resolve(first.version);
  assert.equal(readFileSync(join(offline.dir, "file.txt"), "utf8"), "A");
  assert.equal(offline.dir, first.dir);
  assert.equal(offline.version, first.version);
  assert.match(offline.warning ?? "", /using cache/);
  assert.equal(readFileSync(join(second.dir, "file.txt"), "utf8"), "B");
});

for (const existing of ["other pin", "legacy unpinned"] as const) {
  test(`offline pin rejects when only a cache for ${existing} exists`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const repo = makeRepo(tmp);
    const a = repo.commit("A", "first");
    const b = repo.commit("B", "second");
    const cacheRoot = join(tmp.dir, "cache");
    const other = await new GitSource({
      url: repo.url, ref: existing === "other pin" ? b : undefined, cacheRoot,
    }).resolve();
    rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
    const missing = new GitSource({ url: repo.url, ref: a, cacheRoot });
    await assert.rejects(() => missing.resolve(), /git source .* failed/);
    assert.equal(readFileSync(join(other.dir, "file.txt"), "utf8"), "B");
  });
}

for (const abbreviated of [false, true]) {
  test(`a mismatched ${abbreviated ? "abbreviated" : "full"} pin cache is refused offline`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const repo = makeRepo(tmp);
    const a = repo.commit("A", "first");
    const b = repo.commit("B", "second");
    const src = new GitSource({ url: repo.url, ref: abbreviated ? a.slice(0, 7) : a, cacheRoot: join(tmp.dir, "cache") });
    const first = await src.resolve();
    // Simulate a stale/misplaced checkout in the expected cache directory.
    git(first.dir, "fetch", "-q", "origin", b);
    git(first.dir, "reset", "--hard", b);
    rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
    await assert.rejects(() => src.resolve(first.version), /does not match requested pin/);
  });
}

test("online full SHA update and rollback each serve the requested commit without fallback", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const a = repo.commit("A", "first");
  const b = repo.commit("B", "second");
  const cacheRoot = join(tmp.dir, "cache");
  for (const [ref, content] of [[a, "A"], [b, "B"], [a, "A"]]) {
    const loc = await new GitSource({ url: repo.url, ref, cacheRoot }).resolve();
    assert.equal(loc.warning, undefined);
    assert.equal(git(loc.dir, "rev-parse", "HEAD").trim(), ref);
    assert.equal(readFileSync(join(loc.dir, "file.txt"), "utf8"), content);
  }
});

test("branch, tag and default HEAD caches are independent; branch updates and offline fallback work", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("A", "first");
  repo.tag("v1");
  const cacheRoot = join(tmp.dir, "cache");
  const tagged = new GitSource({ url: repo.url, ref: "v1", cacheRoot });
  const branch = new GitSource({ url: repo.url, ref: "main", cacheRoot });
  const unpinned = new GitSource({ url: repo.url, cacheRoot });
  const tagLoc = await tagged.resolve();
  const branchLoc = await branch.resolve();
  const defaultLoc = await unpinned.resolve();
  assert.equal(new Set([tagLoc.dir, branchLoc.dir, defaultLoc.dir]).size, 3);
  repo.commit("B", "second");
  const updated = await branch.resolve(branchLoc.version);
  assert.equal(updated.dir, branchLoc.dir);
  assert.equal(updated.warning, undefined);
  assert.equal(readFileSync(join(updated.dir, "file.txt"), "utf8"), "B");
  assert.equal(readFileSync(join(tagLoc.dir, "file.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(defaultLoc.dir, "file.txt"), "utf8"), "A");
  rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
  for (const [src, previous, content] of [[tagged, tagLoc, "A"], [branch, updated, "B"], [unpinned, defaultLoc, "A"]] as const) {
    const offline = await src.resolve();
    assert.equal(offline.dir, previous.dir);
    assert.equal(offline.version, previous.version);
    assert.match(offline.warning ?? "", /using cache/);
    assert.equal(readFileSync(join(offline.dir, "file.txt"), "utf8"), content);
  }
});

test("abbreviated SHA pins resolve online and retain their own offline snapshot", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const a = repo.commit("A", "first");
  const b = repo.commit("B", "second");
  const cacheRoot = join(tmp.dir, "cache");
  const src = new GitSource({ url: repo.url, ref: a.slice(0, 7), cacheRoot });
  const first = await src.resolve();
  assert.equal(first.warning, undefined);
  assert.equal(git(first.dir, "rev-parse", "HEAD").trim(), a);
  await new GitSource({ url: repo.url, ref: b, cacheRoot }).resolve();
  rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
  const offline = await src.resolve();
  assert.equal(offline.version, first.version);
  assert.equal(git(offline.dir, "rev-parse", "HEAD").trim(), a);
  assert.match(offline.warning ?? "", /using cache/);
});

test("a full SHA pin cache moved to another commit is refused offline, even without the pinned object", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const a = repo.commit("A", "first");
  const b = repo.commit("B", "second");
  const src = new GitSource({ url: repo.url, ref: a, cacheRoot: join(tmp.dir, "cache") });
  const first = await src.resolve();
  git(first.dir, "fetch", "-q", "--depth", "1", "origin", b);
  git(first.dir, "reset", "-q", "--hard", b);
  git(first.dir, "reflog", "expire", "--expire=now", "--all");
  git(first.dir, "gc", "-q", "--prune=now");
  assert.throws(() => git(first.dir, "cat-file", "-e", a), "fixture: the pinned object is gone");
  rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
  await assert.rejects(() => src.resolve(first.version), /does not match requested pin/);
});

for (const kind of ["tag", "branch"] as const) {
  test(`a ${kind} named like a SHA prefix (a date) resolves by name, online and from its cache`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const repo = makeRepo(tmp);
    const named = repo.commit("A", "first");
    repo[kind]("20260926");
    repo.commit("B", "second");
    const src = new GitSource({ url: repo.url, ref: "20260926", cacheRoot: join(tmp.dir, "cache") });
    const online = await src.resolve();
    assert.equal(online.warning, undefined);
    assert.equal(git(online.dir, "rev-parse", "HEAD").trim(), named);
    rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
    const offline = await src.resolve(online.version);
    assert.equal(offline.version, online.version);
    assert.match(offline.warning ?? "", /using cache/);
    assert.equal(readFileSync(join(offline.dir, "file.txt"), "utf8"), "A");
  });
}

// k70 (spec §4.4): a SHA pin is compared with the commit the lock holds, never assumed installed.
test("check on a SHA pin: changed with nothing installed or another commit locked, unchanged at the pin without the remote", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const a = repo.commit("A", "first");
  const b = repo.commit("B", "second");
  const cacheRoot = join(tmp.dir, "cache");
  const pinA = new GitSource({ url: repo.url, ref: a, cacheRoot });
  const locked = (await pinA.resolve()).version;
  const lockedB = (await new GitSource({ url: repo.url, ref: b, cacheRoot }).resolve()).version;
  for (const ref of [a, a.slice(0, 7), a.toUpperCase()]) {
    const src = new GitSource({ url: repo.url, ref, cacheRoot });
    assert.equal(await src.check(undefined), true, `${ref}: nothing installed yet`);
    assert.equal(await src.check(lockedB), true, `${ref}: the lock holds another commit`);
    assert.equal(await src.check(locked), false, `${ref}: the lock holds the pin`);
  }
  rmSync(new URL(repo.url).pathname, { recursive: true, force: true });
  assert.equal(await pinA.check(locked), false, "a held pin is decided without the remote");
});

test("check on a tag named like a SHA prefix compares by name, like any other ref", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("A", "first");
  repo.tag("20260926");
  const b = repo.commit("B", "second");
  const src = new GitSource({ url: repo.url, ref: "20260926", cacheRoot: join(tmp.dir, "cache") });
  const loc = await src.resolve();
  assert.equal(await src.check(loc.version), false);
  // The tag moves to B: the name now points elsewhere.
  git(tmp.dir, "--git-dir", new URL(repo.url).pathname, "tag", "-f", "20260926", b);
  assert.equal(await src.check(loc.version), true);
});

for (const ref of [undefined, "0123456789abcdef0123456789abcdef01234567"]) {
  test(`without a cache, an unreachable ${ref ? "pinned" : "unpinned"} remote names the fetch error, no cache`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const url = "file://" + join(tmp.dir, "does-not-exist.git");
    const src = new GitSource({ url, ref, cacheRoot: join(tmp.dir, "cache") });
    await assert.rejects(() => src.resolve(), (err: Error) => {
      assert.match(err.message, /^git source .* failed: git fetch/);
      assert.doesNotMatch(err.message, /cache rejected|rev-parse/);
      return true;
    });
  });
}

test("no cache and an unreachable remote is an error", async () => {
  const tmp = makeTmpDir();
  try {
    const src = new GitSource({
      url: "file://" + join(tmp.dir, "does-not-exist.git"),
      cacheRoot: join(tmp.dir, "cache"),
    });
    await assert.rejects(() => src.resolve());
  } finally {
    tmp.cleanup();
  }
});
