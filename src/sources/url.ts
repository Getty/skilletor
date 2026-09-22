// URL source backend (spec §4.4, §9): an HTTPS .tar.gz with conditional GET.
//
// resolve(): GET with If-None-Match; 304 reuses the cache, 200 extracts a fresh
//   tree. version = "etag:<etag>", or "sha256:<hash>" when the server sends none.
// check():   HEAD + ETag comparison.
//
// Unpacking is dependency-free: zlib gunzip + a minimal tar reader (no external
// tar). Entries with `..`, absolute paths, symlinks or hardlinks are rejected; a
// single GitHub-style top-level directory is stripped. Offline with a cache
// reuses it and warns; without a cache it errors. Production is https-only;
// `allowHttp` (tests only) permits http://127.0.0.1.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Source, SourceLocation } from "./types.ts";

export interface UrlSourceOptions {
  url: string;
  cacheRoot: string;
  timeoutMs?: number;
  /** Tests only: permit http://127.0.0.1 (production is https-only). */
  allowHttp?: boolean;
}

export class TarError extends Error {
  override name = "TarError";
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class UrlSource implements Source {
  private readonly opts: UrlSourceOptions;

  constructor(opts: UrlSourceOptions) {
    this.opts = opts;
  }

  private cacheDir(): string {
    const hash = createHash("sha256").update(this.opts.url).digest("hex").slice(0, 16);
    return join(this.opts.cacheRoot, hash);
  }

  private assertScheme(): void {
    const u = new URL(this.opts.url);
    if (u.protocol === "https:") return;
    const localHttp = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    if (this.opts.allowHttp && localHttp) return;
    throw new Error(`url source must be https://: ${this.opts.url}`);
  }

  private async request(method: "GET" | "HEAD", headers: Record<string, string>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return await fetch(this.opts.url, { method, headers, signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(cachedVersion?: string): Promise<SourceLocation> {
    this.assertScheme();
    const dir = this.cacheDir();
    try {
      const headers: Record<string, string> = {};
      const etag = cachedVersion?.startsWith("etag:") ? cachedVersion.slice(5) : undefined;
      if (etag && existsSync(dir)) headers["If-None-Match"] = etag;

      const res = await this.request("GET", headers);
      if (res.status === 304 && existsSync(dir)) {
        return { dir, version: cachedVersion! };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = Buffer.from(await res.arrayBuffer());
      const resEtag = res.headers.get("etag");
      const version = resEtag ? `etag:${resEtag}` : `sha256:${createHash("sha256").update(body).digest("hex")}`;

      const entries = stripTopLevel(parseTar(gunzipSync(body)));
      writeEntries(dir, entries);
      return { dir, version };
    } catch (err) {
      if (err instanceof TarError) {
        throw new Error(`url source ${this.opts.url} failed: ${err.message}`);
      }
      if (existsSync(dir)) {
        return {
          dir,
          version: cachedVersion ?? "unknown",
          warning: `download failed for ${this.opts.url}, using cache (${(err as Error).message})`,
        };
      }
      throw new Error(`url source ${this.opts.url} failed: ${(err as Error).message}`);
    }
  }

  async check(cachedVersion: string | undefined): Promise<boolean> {
    this.assertScheme();
    const res = await this.request("HEAD", {});
    const etag = res.headers.get("etag");
    if (!etag || !cachedVersion?.startsWith("etag:")) return true;
    return etag !== cachedVersion.slice(5);
  }
}

// ---- tar reading ------------------------------------------------------------

interface TarEntry {
  name: string;
  type: "file" | "dir";
  data: Buffer;
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString("utf8", 0, end === -1 ? length : end);
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const s = readString(block, offset, length).trim();
  return s ? parseInt(s, 8) : 0;
}

/** Parse a (decompressed) tar into safe file/dir entries; throws on anything unsafe. */
function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;

  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break; // end of archive

    const rawName = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const size = readOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      longName = readString(data, 0, data.length).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      paxPath = parsePaxPath(data) ?? paxPath;
      continue;
    }
    if (typeflag === "2" || typeflag === "1") {
      throw new TarError(`unsafe tar entry (symlink/hardlink): ${rawName}`);
    }

    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = undefined;
    paxPath = undefined;

    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") continue; // skip devices etc.

    assertSafe(name);
    if (typeflag === "5" || name.endsWith("/")) {
      entries.push({ name: name.replace(/\/+$/, ""), type: "dir", data: Buffer.alloc(0) });
    } else {
      entries.push({ name, type: "file", data });
    }
  }
  return entries;
}

function parsePaxPath(data: Buffer): string | undefined {
  // records: "<len> key=value\n"
  for (const line of data.toString("utf8").split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

function assertSafe(name: string): void {
  if (name === "" || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new TarError(`unsafe tar entry (absolute path): ${name || "<empty>"}`);
  }
  if (name.split("/").some((seg) => seg === "..")) {
    throw new TarError(`unsafe tar entry (path traversal): ${name}`);
  }
}

/** Strip a single GitHub-style top-level directory, if present. */
function stripTopLevel(entries: TarEntry[]): TarEntry[] {
  const tops = new Set(entries.map((e) => e.name.split("/")[0]).filter(Boolean));
  const nested = entries.some((e) => e.name.includes("/"));
  if (tops.size !== 1 || !nested) return entries;
  const top = [...tops][0]!;
  const prefix = `${top}/`;
  return entries
    .map((e) => ({ ...e, name: e.name === top ? "" : e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name }))
    .filter((e) => e.name.length > 0);
}

function writeEntries(dir: string, entries: TarEntry[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const root = resolvePath(dir);
  for (const e of entries) {
    const dest = resolvePath(join(dir, e.name));
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw new TarError(`unsafe tar entry (escapes target): ${e.name}`);
    }
    if (e.type === "dir") {
      mkdirSync(dest, { recursive: true });
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, e.data);
    }
  }
}
