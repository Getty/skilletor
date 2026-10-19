// k145: three strictness fixes – a source's `vars` must be an object, a lock entry's `via`
// must be an array of exact bundle labels, a tarball cut short is an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { makeTmpDir } from "./helpers/tmp.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { CatalogError, scan } from "../src/catalog.ts";
import { LockError, readLock } from "../src/lock.ts";
import { UrlSource } from "../src/sources/url.ts";

function put(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

for (const [what, vars] of [["an array", "[1]"], ["a string", '"x"'], ["a number", "3"], ["true", "true"], ["null", "null"]] as const) {
  test(`k145: a source's skilletor.json with ${what} as vars is a catalog error`, () => {
    const tmp = makeTmpDir();
    try {
      put(join(tmp.dir, "skilletor.json"), `{"description":"d","vars":${vars}}`);
      put(join(tmp.dir, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\nbody\n");
      assert.throws(() => scan(tmp.dir), (err: Error) =>
        err instanceof CatalogError && err.message.includes('"vars" must be an object'));
    } finally {
      tmp.cleanup();
    }
  });
}

test("k145: a source's skilletor.json with an object as vars, or none, is read", () => {
  const tmp = makeTmpDir();
  try {
    put(join(tmp.dir, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\nbody\n");
    put(join(tmp.dir, "skilletor.json"), '{"vars":{"k":1}}');
    assert.deepEqual(scan(tmp.dir).meta.vars, { k: 1 });
    put(join(tmp.dir, "skilletor.json"), '{"description":"d"}');
    assert.equal(scan(tmp.dir).meta.vars, undefined);
  } finally {
    tmp.cleanup();
  }
});

test("k145: a lock entry's via must be an array of strings, so a label never matches by substring", () => {
  const tmp = makeTmpDir();
  try {
    const file = join(tmp.dir, "skilletor.lock.json");
    const entry = (via: unknown) => JSON.stringify({ "skills/x": { source: "s", version: "v", files: {}, via } });
    writeFileSync(file, entry(["bundle:perl@shared"]));
    assert.deepEqual(readLock(file)["skills/x"]!.via, ["bundle:perl@shared"]);
    for (const bad of ["bundle:perl@shared-extra", "bundle:perl@shared", 3, [1], null, { a: 1 }]) {
      writeFileSync(file, entry(bad));
      assert.throws(() => readLock(file), (err: Error) =>
        err instanceof LockError && err.message.includes('skills/x: "via" must be an array of strings'), JSON.stringify(bad));
    }
  } finally {
    tmp.cleanup();
  }
});

async function serve(body: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end(body));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/x.tar.gz`, close: () => new Promise((done) => server.close(() => done())) };
}

const FULL = gunzipSync(makeTarGz([
  { name: "pkg/skills/x/SKILL.md", data: "---\ndescription: x\n---\n" },
  { name: "pkg/skills/y/SKILL.md", data: "y".repeat(700) },
]));
// header 512 + data 512, header 512 + data 1024, then the 1024-byte end marker
const CUTS: [string, number][] = [
  ["inside an entry's data", 512 + 100],
  ["after a header, before its data", 512 + 512 + 512],
  ["inside a header", 512 + 512 + 100],
  ["after the last entry, the end marker gone", 512 + 512 + 512 + 1024],
  ["in a partial block after the last entry", 512 + 512 + 512 + 1024 + 100],
];

for (const [what, at] of CUTS) {
  test(`k145: a tarball cut short ${what} is an error, nothing is published`, async () => {
    const tmp = makeTmpDir();
    const srv = await serve(gzipSync(FULL.subarray(0, at)));
    try {
      const src = new UrlSource({ url: srv.url, cacheRoot: join(tmp.dir, "cache"), allowHttp: true });
      await assert.rejects(src.resolve(), /corrupt tar/);
    } finally {
      tmp.cleanup();
      await srv.close();
    }
  });
}

test("k145: the whole tarball is still read", async () => {
  const tmp = makeTmpDir();
  const srv = await serve(gzipSync(FULL));
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: join(tmp.dir, "cache"), allowHttp: true });
    assert.ok((await src.resolve()).dir);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});
