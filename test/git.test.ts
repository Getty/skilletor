// Tests for the git source backend, against local bare repos (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const tag = (name: string, annotated = false) => {
    git(work, "tag", ...(annotated ? ["-a", "-m", name] : []), name);
    git(work, "push", "-q", url, name);
  };
  const branch = (name: string) => {
    git(work, "branch", name);
    git(work, "push", "-q", url, name);
  };
  /** Runs git in the bare repo itself, to move refs upstream. */
  const upstream = (...args: string[]) => git(tmp.dir, "--git-dir", bare, ...args);
  return { url, commit, tag, branch, upstream };
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
  const offline = await new GitSource({ url: repo.url, ref: a, cacheRoot }).resolve();
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
    await assert.rejects(() => src.resolve(), /does not match requested pin/);
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
  const updated = await branch.resolve();
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
  await assert.rejects(() => src.resolve(), /does not match requested pin/);
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
    const offline = await src.resolve();
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

/** Does a `git:<sha>` version name this full commit SHA? */
const names = (version: string, sha: string) => version.startsWith("git:") && sha.startsWith(version.slice(4));

// k75: upstream, an annotated tag names a tag object; the commit is its peeled `^{}` line.
// Asserts: resolve records the tagged commit, not the tag object; check is false while the
// tag stays put (the branch has moved on), true once it moves; the next resolve takes the
// new commit and check is false again. A lightweight tag behaves the same.
for (const annotated of [true, false]) {
  test(`check on ${annotated ? "an annotated" : "a lightweight"} tag compares the commit it names`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const repo = makeRepo(tmp);
    const a = repo.commit("A", "first");
    repo.tag("v1", annotated);
    const b = repo.commit("B", "second");
    const src = new GitSource({ url: repo.url, ref: "v1", cacheRoot: join(tmp.dir, "cache") });
    const loc = await src.resolve();
    assert.equal(names(loc.version, a), true, `${loc.version} is the tagged commit ${a}`);
    assert.equal(await src.check(loc.version), false, "the tag did not move");
    repo.upstream("tag", "-f", ...(annotated ? ["-a", "-m", "moved"] : []), "v1", b);
    assert.equal(await src.check(loc.version), true, "the tag moved");
    const moved = await src.resolve();
    assert.equal(names(moved.version, b), true, `${moved.version} is the new commit ${b}`);
    assert.equal(readFileSync(join(moved.dir, "file.txt"), "utf8"), "B");
    assert.equal(await src.check(moved.version), false, "the moved tag is held");
  });
}

// k75: `git ls-remote <url> <ref>` lists every ref that ends in `/<ref>`, sorted by name;
// `git fetch` takes the one git's rev-parse rules rank first (exact, refs/, refs/tags/,
// refs/heads/, refs/remotes/, refs/remotes/<ref>/HEAD). Upstream here: main at C, a
// branch feature/main at A (listed before refs/heads/main), a branch x at A, a tag x at B.
// Asserts: resolve installs what fetch picks; check is false for it although a namesake
// names another commit, true once the ref resolve read moves, false after the next resolve.
for (const [ref, own, installs, movesTo] of [
  ["main", "refs/heads/main", "C", "A"],
  ["x", "refs/tags/x", "B", "C"],
  ["refs/heads/x", "refs/heads/x", "A", "C"],
] as const) {
  test(`check on "${ref}" follows ${own}, the ref git fetch picks among its namesakes`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const repo = makeRepo(tmp);
    const sha = { A: repo.commit("A", "first"), B: repo.commit("B", "second"), C: repo.commit("C", "third") };
    repo.upstream("update-ref", "refs/heads/feature/main", sha.A);
    repo.upstream("update-ref", "refs/heads/x", sha.A);
    repo.upstream("tag", "-a", "-m", "x", "x", sha.B);
    const src = new GitSource({ url: repo.url, ref, cacheRoot: join(tmp.dir, "cache") });
    const loc = await src.resolve();
    assert.equal(names(loc.version, sha[installs]), true, `fetch installs ${own} (${installs}), got ${loc.version}`);
    assert.equal(await src.check(loc.version), false, `${own} did not move`);
    if (own.startsWith("refs/tags/")) repo.upstream("tag", "-f", "-a", "-m", "moved", "x", sha[movesTo]);
    else repo.upstream("update-ref", own, sha[movesTo]);
    assert.equal(await src.check(loc.version), true, `${own} moved`);
    const moved = await src.resolve();
    assert.equal(names(moved.version, sha[movesTo]), true, `${moved.version} is ${movesTo}`);
    assert.equal(await src.check(moved.version), false, "the moved ref is held");
  });
}

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

// k85, layer 2 on its own: GitSource built directly, no config validation in between. A ref
// is a positional of `git fetch`, which still parses options after the remote name, so
// `--upload-pack=<cmd>` ran <cmd> (here: touch a marker in the temp dir). Asserts: resolve
// fails with the fetch error (no cache), check reports a change, and <cmd> never ran.
test("k85: a ref shaped like an option never runs as one, in resolve or check", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  const sha = repo.commit("v1", "first");
  const marker = join(tmp.dir, "pwned");
  const src = new GitSource({ url: repo.url, ref: `--upload-pack=touch '${marker}'`, cacheRoot: join(tmp.dir, "cache") });
  await assert.rejects(() => src.resolve(), (err: Error) => /^git source .* failed: git fetch/.test(err.message));
  assert.equal(existsSync(marker), false, "the ref ran as --upload-pack in git fetch");
  assert.equal(await src.check(`git:${sha.slice(0, 7)}`), true);
  assert.equal(existsSync(marker), false, "the ref ran as --upload-pack in git ls-remote");
});

// k85, layer 2: the address is a positional too. `git ls-remote <address> <patterns>` read an
// address shaped like an option as one and took the next argument – the ref, here a path to a
// real repository – as the remote, running <cmd> against it. Asserts: check and resolve both
// fail, and <cmd> never ran.
test("k85: an address shaped like an option never runs as one, in check or resolve", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("v1", "first");
  const marker = join(tmp.dir, "pwned");
  const src = new GitSource({ url: `--upload-pack=touch '${marker}'`, ref: repo.url, cacheRoot: join(tmp.dir, "cache") });
  await assert.rejects(() => src.check("git:0123456"));
  assert.equal(existsSync(marker), false, "the address ran as --upload-pack in git ls-remote");
  await assert.rejects(() => src.resolve());
  assert.equal(existsSync(marker), false, "the address ran as --upload-pack in git fetch");
});

// k87: git ends its stderr with a newline, and a failure's message carried it – every git
// warning then ended in a visible "\n" once report text escaped it. Asserts: the fallback
// warning, the error without a cache, and a check's error (ls-remote failing, and racing a 1 ms
// timeout – git's own multi-line error when it exits first, Node's "Command failed: …\n" when
// killed before writing anything; k106) each carry git's words and end in a word, never in
// whitespace.
test("k87: a git failure's message ends in git's last word, not its trailing newline", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("A", "first");
  const cacheRoot = join(tmp.dir, "cache");
  await new GitSource({ url: repo.url, cacheRoot }).resolve();
  rmSync(new URL(repo.url).pathname, { recursive: true, force: true });

  const offline = await new GitSource({ url: repo.url, cacheRoot }).resolve();
  assert.match(offline.warning ?? "", /using cache \(git fetch .*: fatal: [^]*\S\)$/);
  await assert.rejects(new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "empty") }).resolve(), (err: Error) => {
    assert.match(err.message, /^git source .* failed: git fetch .*: fatal: [^]*\S$/);
    return true;
  });
  await assert.rejects(new GitSource({ url: repo.url, cacheRoot }).check("git:abc"), (err: Error) => {
    assert.match(err.message, /^git ls-remote .*: fatal: [^]*\S$/);
    return true;
  });
  await assert.rejects(new GitSource({ url: repo.url, cacheRoot, timeoutMs: 1 }).check("git:abc"), (err: Error) => {
    assert.match(err.message, /^git ls-remote .*: (?:fatal: |Command failed: )[^]*\S$/);
    return true;
  });
});
