// Last-good URL cache regressions: mocked downloads, real isolated filesystems.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { UrlSource } from "../src/sources/url.ts";
import { sync, type EngineContext } from "../src/engine.ts";
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
    const fallback = await src.resolve(first.version);
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
  const second = await src.resolve(first.version);
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
  assert.deepEqual(await src.resolve(second.version), second);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const offline = await src.resolve(second.version);
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
      const fallback = await src.resolve(first.version);
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
      const second = await src.resolve(first.version);
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
    await assert.rejects(() => src.resolve(first.version), /last good cache remains at/);
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
  await assert.rejects(() => src.resolve(first.version), /unsafe tar entry/);
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
