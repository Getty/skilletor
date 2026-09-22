// Tests for the url source backend, against a local HTTP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { makeTmpDir } from "./helpers/tmp.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { UrlSource } from "../src/sources/url.ts";

type Handler = Parameters<typeof createServer>[1];

async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/skills.tar.gz`,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

/** Serve one tarball with an ETag, honoring If-None-Match and HEAD. */
function tarballHandler(body: Buffer, etag: string | null): Handler {
  return (req, res) => {
    if (etag && req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    if (etag) res.setHeader("ETag", etag);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  };
}

const NORMAL = () =>
  makeTarGz([
    { name: "pkg/", typeflag: "5" },
    { name: "pkg/skills/", typeflag: "5" },
    { name: "pkg/skills/x/", typeflag: "5" },
    { name: "pkg/skills/x/SKILL.md", data: "---\ndescription: x\n---\n" },
  ]);

test("resolve downloads and extracts, stripping the top-level dir", async () => {
  const srv = await startServer(tarballHandler(NORMAL(), '"v1"'));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    const loc = await src.resolve();
    assert.equal(readFileSync(join(loc.dir, "skills/x/SKILL.md"), "utf8").includes("description: x"), true);
    assert.equal(existsSync(join(loc.dir, "pkg")), false); // top-level stripped
    assert.equal(loc.version, 'etag:"v1"');
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("a 304 reuses the cache with the same version", async () => {
  const srv = await startServer(tarballHandler(NORMAL(), '"v1"'));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    const first = await src.resolve();
    const second = await src.resolve(first.version);
    assert.equal(second.version, first.version);
    assert.equal(readFileSync(join(second.dir, "skills/x/SKILL.md"), "utf8").includes("description: x"), true);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("no ETag falls back to a sha256 version", async () => {
  const srv = await startServer(tarballHandler(NORMAL(), null));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    const loc = await src.resolve();
    assert.match(loc.version, /^sha256:[0-9a-f]{64}$/);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("check compares the HEAD ETag", async () => {
  const srv = await startServer(tarballHandler(NORMAL(), "abc"));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    assert.equal(await src.check("etag:abc"), false);
    assert.equal(await src.check("etag:old"), true);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("a tar entry escaping via .. is rejected", async () => {
  const evil = makeTarGz([{ name: "../evil.txt", data: "pwned" }]);
  const srv = await startServer(tarballHandler(evil, '"e"'));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    await assert.rejects(() => src.resolve(), /unsafe|\.\./i);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("a symlink tar entry is rejected", async () => {
  const evil = makeTarGz([{ name: "pkg/link", typeflag: "2", linkname: "/etc/passwd" }]);
  const srv = await startServer(tarballHandler(evil, '"e"'));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    await assert.rejects(() => src.resolve(), /symlink|unsafe/i);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("an absolute tar entry is rejected", async () => {
  const evil = makeTarGz([{ name: "/abs/evil.txt", data: "x" }]);
  const srv = await startServer(tarballHandler(evil, '"e"'));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    await assert.rejects(() => src.resolve(), /unsafe|absolute/i);
  } finally {
    tmp.cleanup();
    await srv.close();
  }
});

test("http:// is rejected in production (allowHttp off)", async () => {
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: "http://example.com/s.tar.gz", cacheRoot: tmp.dir });
    await assert.rejects(() => src.resolve(), /https/i);
  } finally {
    tmp.cleanup();
  }
});

test("offline fallback uses the cache with a warning", async () => {
  const srv = await startServer(tarballHandler(NORMAL(), '"v1"'));
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: srv.url, cacheRoot: tmp.dir, allowHttp: true });
    const first = await src.resolve();
    await srv.close(); // server gone
    const second = await src.resolve(first.version);
    assert.equal(second.version, first.version);
    assert.match(second.warning ?? "", /cache/i);
  } finally {
    tmp.cleanup();
  }
});
