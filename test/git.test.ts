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
  };
  const tag = (name: string) => {
    git(work, "tag", name);
    git(work, "push", "-q", url, name);
  };
  return { url, commit, tag };
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
