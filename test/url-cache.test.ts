// Last-good URL cache regressions: mocked downloads, real isolated filesystems.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { sweepUrlCache, UrlSource, URL_CACHE_FORMAT, URL_VERSION_FILE } from "../src/sources/url.ts";
import { sync, type EngineContext } from "../src/engine.ts";
import { cmdAvailable } from "../src/commands.ts";
import { readLock } from "../src/lock.ts";
import { makeTmpDir } from "./helpers/tmp.ts";
import { makeTarGz } from "./helpers/tar.ts";

const URL = "https://example.invalid/skills.tar.gz";
const OLD = "---\ndescription: old skill\n---\nLast good content.\n";
const goodArchive = () => makeTarGz([{ name: "pkg/skills/old/SKILL.md", data: OLD }]);
const newArchive = () => makeTarGz([{ name: "pkg/skills/new/SKILL.md", data: "New content.\n" }]);
const collidingArchive = () => makeTarGz([
  { name: "pkg/skills/partial/SKILL.md", data: "Partial content.\n" },
  { name: "pkg/clash", data: "not a directory" },
  { name: "pkg/clash/child", data: "cannot extract" },
]);
const response = (body: Buffer, etag: string) => new Response(new Uint8Array(body), { headers: { etag } });

for (const failure of ["extraction", "decompression", "download"] as const) {
  test(`${failure} failure keeps the complete old cache and version`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
    t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
    const first = await src.resolve();
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "download") throw new Error("offline");
      return response(failure === "extraction" ? collidingArchive() : Buffer.from("not gzip"), '"bad"');
    });
    const fallback = await src.resolve();
    assert.equal(fallback.dir, first.dir);
    assert.equal(fallback.version, first.version);
    assert.match(fallback.warning ?? "", /using cache/);
    if (failure === "extraction") assert.match(fallback.warning!, /EEXIST|ENOTDIR/);
    assert.equal(existsSync(join(first.dir, "skills/old/SKILL.md")), true, "last good skill must survive");
    assert.equal(readFileSync(join(first.dir, "skills/old/SKILL.md"), "utf8"), OLD);
    assert.equal(existsSync(join(first.dir, "skills/partial")), false);
    assert.deepEqual(readdirSync(tmp.dir), [basename(first.dir)], "no staging or backup directories remain");
  });
}

test("failed first extraction rejects and leaves no usable partial cache, including offline", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
  t.mock.method(globalThis, "fetch", async () => response(collidingArchive(), '"bad"'));
  await assert.rejects(() => src.resolve(), /EEXIST|ENOTDIR/);
  assert.deepEqual(readdirSync(tmp.dir), []);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(() => src.resolve(), /offline/);
});

test("successful replacement removes obsolete files, cleans temporary trees, and supports 304 and offline", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
  t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
  const first = await src.resolve();
  t.mock.method(globalThis, "fetch", async () => response(newArchive(), '"new"'));
  const second = await src.resolve();
  assert.equal(second.dir, first.dir);
  assert.equal(second.version, 'etag:"new"');
  assert.equal(second.warning, undefined);
  assert.equal(existsSync(join(second.dir, "skills/old")), false);
  assert.equal(readFileSync(join(second.dir, "skills/new/SKILL.md"), "utf8"), "New content.\n");
  assert.deepEqual(readdirSync(tmp.dir), [basename(second.dir)]);
  t.mock.method(globalThis, "fetch", async (...[_url, opts]: Parameters<typeof fetch>) => {
    assert.equal(new Headers(opts?.headers).get("If-None-Match"), '"new"');
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await src.resolve(), second);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const offline = await src.resolve();
  assert.equal(offline.version, second.version);
  assert.match(offline.warning ?? "", /using cache/);
  assert.equal(readFileSync(join(offline.dir, "skills/new/SKILL.md"), "utf8"), "New content.\n");
});

for (const failAt of [1, 2]) {
  test(`publication rename ${failAt} failure preserves the old cache and cleans temporary trees`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
    t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
    const first = await src.resolve();
    t.mock.method(globalThis, "fetch", async () => response(newArchive(), '"new"'));
    let renames = 0;
    const originalRename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof renameSync>) => {
      if (++renames === failAt) throw new Error("injected publication failure");
      return originalRename(...args);
    });
    syncBuiltinESMExports();
    try {
      const fallback = await src.resolve();
      assert.equal(fallback.version, first.version);
      assert.match(fallback.warning ?? "", /injected publication failure/);
      assert.equal(readFileSync(join(first.dir, "skills/old/SKILL.md"), "utf8"), OLD);
      assert.equal(existsSync(join(first.dir, "skills/new")), false);
      assert.deepEqual(readdirSync(tmp.dir), [basename(first.dir)]);
      assert.equal(renames, failAt === 2 ? 3 : 1, "failed swap restores the backup by rename");
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const leftover of ["stage", "backup"]) {
  test(`post-publication ${leftover} cleanup failure keeps the new bytes and new version`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
    t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
    const first = await src.resolve();
    t.mock.method(globalThis, "fetch", async () => response(newArchive(), '"new"'));
    const originalRemove = fs.rmSync;
    let failures = 0;
    const mock = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).includes(`.${leftover}-`)) {
        failures++;
        throw new Error("injected cleanup failure");
      }
      return originalRemove(...args);
    });
    syncBuiltinESMExports();
    try {
      const second = await src.resolve();
      assert.equal(failures, 1, "exercise cleanup after publication");
      assert.equal(second.version, 'etag:"new"');
      assert.match(second.warning ?? "", /cleanup.*injected cleanup failure/);
      assert.doesNotMatch(second.warning!, /using cache/);
      assert.equal(existsSync(join(second.dir, "skills/old")), false);
      assert.equal(readFileSync(join(second.dir, "skills/new/SKILL.md"), "utf8"), "New content.\n");
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("if publication and restoration both fail, reject and preserve the last-good backup", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
  t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
  const first = await src.resolve();
  t.mock.method(globalThis, "fetch", async () => response(newArchive(), '"new"'));
  const originalRename = fs.renameSync;
  let renames = 0;
  const mock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof renameSync>) => {
    if (++renames > 1) throw new Error("injected rename failure");
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => src.resolve(), /last good cache remains at/);
    assert.equal(existsSync(first.dir), false, "neither missing nor partial tree is reported as usable");
    const remaining = readdirSync(tmp.dir);
    assert.equal(remaining.length, 1);
    assert.match(remaining[0]!, /\.backup-/);
    assert.equal(readFileSync(join(tmp.dir, remaining[0]!, "tree/skills/old/SKILL.md"), "utf8"), OLD);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("unsafe tar update still rejects with a cache and leaves its contents untouched", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
  t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
  const first = await src.resolve();
  t.mock.method(globalThis, "fetch", async () => response(makeTarGz([
    { name: "pkg/skills/new/SKILL.md", data: "new" },
    { name: "pkg/link", typeflag: "2", linkname: "/etc/passwd" },
  ]), '"unsafe"'));
  await assert.rejects(() => src.resolve(), /unsafe tar entry/);
  assert.equal(readFileSync(join(first.dir, "skills/old/SKILL.md"), "utf8"), OLD);
  assert.deepEqual(readdirSync(tmp.dir), [basename(first.dir)]);
});

test("wildcard sync retains the installed old skill and lock after a colliding URL update", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, "home");
  const target = join(home, ".claude");
  const ctx: EngineContext = {
    home,
    codexHome: join(tmp.dir, "codex"),
    stateRoot: join(tmp.dir, "state"),
    markers: { claude: [], codex: [] },
    isGitWorkTree: () => false,
  };
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "skilletor.json"), JSON.stringify({
    targets: ["claude"], sources: { remote: { url: URL } }, install: { skills: ["*@remote"] },
  }));
  t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
  const first = await sync(ctx);
  assert.equal(first.error, undefined);
  assert.deepEqual(first.scopes[0]!.added.map((i) => i.key), ["skills/old"]);
  const lockPath = join(target, "skilletor.lock.json");
  const oldLock = readLock(lockPath);
  assert.equal(oldLock["skills/old"]!.version, 'etag:"old"');
  t.mock.method(globalThis, "fetch", async () => response(collidingArchive(), '"bad"'));
  const second = await sync(ctx);
  assert.equal(second.error, undefined);
  assert.match(second.scopes[0]!.warnings.join("\n"), /using cache.*EEXIST|using cache.*ENOTDIR/);
  assert.deepEqual(second.scopes[0]!.removed, [], "a failed update must not remove wildcard-installed skills");
  assert.deepEqual(second.scopes[0]!.added, []);
  assert.equal(readFileSync(join(target, "skills/old/SKILL.md"), "utf8"), OLD);
  assert.equal(existsSync(join(target, "skills/partial")), false);
  assert.deepEqual(readLock(lockPath), oldLock);
});

// ---- sweep (k74) ------------------------------------------------------------
// What a run that failed or died leaves in the cache root is swept by the next run that
// holds the sync lock (spec §6.5). Asserts: after publication and restoration both failed
// (the cache dir gone, the last good tree only in `<hash>.backup-*/tree`), the sweep moves
// that tree back into place and drops the backup, so an offline resolve serves the last
// good cache again instead of failing.
test("k74: sweep restores a last good cache left only in a backup; offline resolve serves it", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
  t.mock.method(globalThis, "fetch", async () => response(goodArchive(), '"old"'));
  const first = await src.resolve();
  t.mock.method(globalThis, "fetch", async () => response(newArchive(), '"new"'));
  const originalRename = fs.renameSync;
  let renames = 0;
  const mock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof renameSync>) => {
    if (++renames > 1) throw new Error("injected rename failure");
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => src.resolve(), /last good cache remains at/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(first.dir), false);
  sweepUrlCache(tmp.dir);
  assert.deepEqual(readdirSync(tmp.dir), [basename(first.dir)], "the backup is gone, the cache is back");
  assert.equal(readFileSync(join(first.dir, "skills/old/SKILL.md"), "utf8"), OLD);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const offline = await src.resolve();
  assert.equal(offline.version, first.version);
  assert.match(offline.warning ?? "", /using cache/);
});

// Asserts: a stage tree is removed whether or not its cache exists; a backup is removed when
// its cache dir exists (published, cleanup failed) or when it holds no tree; the cache dir
// itself, a git cache and names the url backend never creates are left as they are.
test("k74: sweep removes stage trees and obsolete backups, nothing else", () => {
  const tmp = makeTmpDir();
  try {
    const put = (rel: string, data = "x") => {
      mkdirSync(join(tmp.dir, rel, ".."), { recursive: true });
      writeFileSync(join(tmp.dir, rel), data);
    };
    const published = "0123456789abcdef";
    put(`${published}/skills/new/SKILL.md`, "NEW");
    put(`${published}.stage-Ab12Cd/skills/half/SKILL.md`);
    put(`${published}.backup-Ef34Gh/tree/skills/old/SKILL.md`);
    mkdirSync(join(tmp.dir, "fedcba9876543210.backup-Ij56Kl")); // died before the first rename
    put("fedcba9876543210.stage-Mn78Op/skills/half/SKILL.md"); // died while extracting a first fetch
    put("00112233445566ff/.git/HEAD", "ref: refs/heads/main\n"); // a git cache
    put("notes.stage-Qr90St/keep.txt"); // not a cache name
    put(`${published}.stage-/keep.txt`); // no mkdtemp suffix
    sweepUrlCache(tmp.dir);
    assert.deepEqual(readdirSync(tmp.dir).sort(), ["00112233445566ff", published, `${published}.stage-`, "notes.stage-Qr90St"]);
    assert.equal(readFileSync(join(tmp.dir, published, "skills/new/SKILL.md"), "utf8"), "NEW");
    assert.equal(existsSync(join(tmp.dir, "fedcba9876543210")), false, "an empty backup restores nothing");
  } finally {
    tmp.cleanup();
  }
});

// Asserts: the sweep never throws – a missing cache root and a cache root that is a file
// are no error (it runs on the hook path, spec §8).
test("k74: sweep of a missing or unreadable cache root is silent", () => {
  const tmp = makeTmpDir();
  try {
    sweepUrlCache(join(tmp.dir, "missing"));
    writeFileSync(join(tmp.dir, "file"), "not a dir");
    sweepUrlCache(join(tmp.dir, "file"));
    assert.deepEqual(readdirSync(tmp.dir), ["file"]);
  } finally {
    tmp.cleanup();
  }
});

// ---- the cache owns its version (k82) ---------------------------------------
// `available` and `install` resolve and may replace the url cache, but only a sync writes
// the lock. The cache keeps the version of its tree next to it, published with the tree
// (spec §4.4): the If-None-Match, the answer to a 304 and the label of a fallback to the
// cache all come from it, never from the lock.

const V1 = "---\ndescription: v1\n---\nFirst.\n";
const V2 = "---\ndescription: v2\n---\nSecond.\n";
const archiveOf = (body: string) => makeTarGz([{ name: "pkg/skills/s/SKILL.md", data: body }]);

/**
 * A user scope that installs `skills/s` from URL, and a mocked server: `serve(body, etag)`
 * sets what it serves (a 304 when If-None-Match is that ETag), `offline()` makes every
 * request fail; `sent` lists each request's If-None-Match.
 */
function k82Setup(t: TestContext) {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, "home");
  const target = join(home, ".claude");
  const ctx: EngineContext = {
    home,
    codexHome: join(tmp.dir, "codex"),
    stateRoot: join(tmp.dir, "state"),
    markers: { claude: [], codex: [] },
    isGitWorkTree: () => false,
  };
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "skilletor.json"), JSON.stringify({
    targets: ["claude"], sources: { remote: { url: URL } }, install: { skills: ["s@remote"] },
  }));
  let current: { body: string; etag: string } | null = null;
  const sent: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (...[, opts]: Parameters<typeof fetch>) => {
    const inm = new Headers(opts?.headers).get("If-None-Match");
    sent.push(inm);
    if (!current) throw new Error("offline");
    if (inm === current.etag) return new Response(null, { status: 304 });
    return response(archiveOf(current.body), current.etag);
  });
  const cacheRoot = join(ctx.stateRoot, "cache");
  return {
    ctx,
    sent,
    serve: (body: string, etag: string) => { current = { body, etag }; },
    offline: () => { current = null; },
    lockVersion: () => readLock(join(target, "skilletor.lock.json"))["skills/s"]?.version,
    installed: () => readFileSync(join(target, "skills/s/SKILL.md"), "utf8"),
    /** The one url cache dir. */
    cacheDir: () => {
      const dirs = readdirSync(cacheRoot);
      assert.equal(dirs.length, 1, dirs.join(", "));
      return join(cacheRoot, dirs[0]!);
    },
  };
}

// Asserts: after a sync at ETag "1", `available` replaces the cache with the tree of "2"
// (asking with the cache's "1"). The next sync sends "2" – the cache's, not the lock's
// "1" – gets its 304, installs the newer tree and labels the lock "2".
test("k82: after available refreshed the cache, the next sync sends and records the cache's ETag", async (t) => {
  const e = k82Setup(t);
  e.serve(V1, '"1"');
  const first = await sync(e.ctx);
  assert.equal(first.error, undefined);
  assert.deepEqual(e.sent, [null]);
  assert.equal(e.lockVersion(), 'etag:"1"');

  e.serve(V2, '"2"');
  e.sent.length = 0;
  await cmdAvailable(e.ctx);
  assert.deepEqual(e.sent, ['"1"'], "available asks with the cache's ETag");
  assert.equal(e.lockVersion(), 'etag:"1"', "available writes no lock");

  e.sent.length = 0;
  const second = await sync(e.ctx);
  assert.equal(second.error, undefined);
  assert.deepEqual(second.scopes[0]!.warnings, []);
  assert.deepEqual(e.sent, ['"2"'], "the cache's ETag, not the lock's");
  assert.deepEqual(second.scopes[0]!.updated.map((i) => i.key), ["skills/s"]);
  assert.equal(e.installed(), V2);
  assert.equal(e.lockVersion(), 'etag:"2"');
});

// Asserts: a server that went back to the lock's ETag "1" after `available` fetched "2"
// does not answer the next sync with a 304 for the tree of "2": the sync asks with "2",
// gets the archive of "1", installs it and labels the lock "1" – tree and label agree.
test("k82: a server back at the lock's ETag after a refresh serves its tree, not a 304", async (t) => {
  const e = k82Setup(t);
  e.serve(V1, '"1"');
  await sync(e.ctx);
  e.serve(V2, '"2"');
  await cmdAvailable(e.ctx);

  e.serve(V1, '"1"');
  e.sent.length = 0;
  const report = await sync(e.ctx);
  assert.equal(report.error, undefined);
  assert.deepEqual(e.sent, ['"2"']);
  assert.equal(e.installed(), V1);
  assert.equal(e.lockVersion(), 'etag:"1"');
});

// Asserts: offline after `available` fetched "2", the sync serves the cache and labels
// the lock with the cache's "2" – the tree it installs – not the lock's "1".
test("k82: offline after a refresh, the sync labels the cached tree with its own ETag", async (t) => {
  const e = k82Setup(t);
  e.serve(V1, '"1"');
  await sync(e.ctx);
  e.serve(V2, '"2"');
  await cmdAvailable(e.ctx);

  e.offline();
  const report = await sync(e.ctx);
  assert.equal(report.error, undefined);
  assert.match(report.scopes[0]!.warnings.join("\n"), /using cache/);
  assert.equal(e.installed(), V2);
  assert.equal(e.lockVersion(), 'etag:"2"');
});

// Asserts: a cache an older skilletor wrote – a tree without the version file – has no
// known version: the sync sends no If-None-Match although the lock holds "1", takes the
// 200, and from then on the cache has its version (the next sync asks with "1" and gets a
// 304). Offline, such a cache is still served, labelled "unknown", with its tree installed.
test("k82: a cache without a version file is fetched unconditionally, then conditionally", async (t) => {
  const e = k82Setup(t);
  e.serve(V1, '"1"');
  await sync(e.ctx);
  const versionFile = join(e.cacheDir(), URL_VERSION_FILE);
  assert.equal(readFileSync(versionFile, "utf8"), `${URL_CACHE_FORMAT}\netag:"1"`);

  rmSync(versionFile);
  e.sent.length = 0;
  const legacy = await sync(e.ctx);
  assert.equal(legacy.error, undefined);
  assert.deepEqual(legacy.scopes[0]!.warnings, []);
  assert.deepEqual(e.sent, [null], "no If-None-Match without the cache's own version");
  assert.equal(e.lockVersion(), 'etag:"1"');
  assert.equal(readFileSync(versionFile, "utf8"), `${URL_CACHE_FORMAT}\netag:"1"`);

  e.sent.length = 0;
  await sync(e.ctx);
  assert.deepEqual(e.sent, ['"1"']);

  rmSync(versionFile);
  e.offline();
  const offline = await sync(e.ctx);
  assert.equal(offline.error, undefined);
  assert.match(offline.scopes[0]!.warnings.join("\n"), /using cache/);
  assert.equal(e.installed(), V1);
  assert.equal(e.lockVersion(), "unknown");
});

// Asserts: the version file's name is reserved in the cache – an archive entry of that
// name (here a directory, under a stripped top-level dir or behind `./` in a flat archive)
// is dropped, the resolve succeeds with the server's ETag, and the next resolve asks with
// that ETag.
for (const [layout, entries] of [
  ["top-level dir", [{ name: "pkg/skills/old/SKILL.md", data: OLD }, { name: `pkg/${URL_VERSION_FILE}/forged`, data: "x" }]],
  ["flat, ./-prefixed", [{ name: "skills/old/SKILL.md", data: OLD }, { name: `./${URL_VERSION_FILE}/forged`, data: "x" }]],
] as const) {
  test(`k82: an archive entry named like the version file cannot replace it (${layout})`, async (t) => {
    const tmp = makeTmpDir();
    t.after(tmp.cleanup);
    const src = new UrlSource({ url: URL, cacheRoot: tmp.dir });
    t.mock.method(globalThis, "fetch", async () => response(makeTarGz([...entries]), '"real"'));
    const first = await src.resolve();
    assert.equal(first.version, 'etag:"real"');
    assert.equal(readFileSync(join(first.dir, URL_VERSION_FILE), "utf8"), `${URL_CACHE_FORMAT}\netag:"real"`);
    assert.equal(readFileSync(join(first.dir, "skills/old/SKILL.md"), "utf8"), OLD);
    t.mock.method(globalThis, "fetch", async (...[, opts]: Parameters<typeof fetch>) => {
      assert.equal(new Headers(opts?.headers).get("If-None-Match"), '"real"');
      return new Response(null, { status: 304 });
    });
    assert.deepEqual(await src.resolve(), first);
  });
}
