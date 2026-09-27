// URL source backend (spec §4.4, §9): an HTTPS .tar.gz with conditional GET.
//
// resolve(): GET with If-None-Match; 304 reuses the cache, 200 extracts a fresh
//   tree. version = "etag:<etag>", or "sha256:<hash>" when the server sends none.
// check():   HEAD + comparison with the ETag the caller read last.
//
// The cache owns its version (k82): URL_VERSION_FILE at the root of the tree, written into
// the stage tree before the swap, so tree and version are only ever replaced together. It –
// never the caller's lock – is the If-None-Match, the answer to a 304 and the label of a
// fallback to the cache, since `available` and `install` replace the cache between syncs.
// A cache without it (skilletor <= 0.3.0) has no known version: the GET is unconditional,
// a fallback is labelled "unknown". An archive entry of that name is dropped. Its first line
// is the format of the tree (k107): a cache of an earlier format – extracted without the
// executable bits k99 keeps – has no known version either, so it is extracted anew once.
//
// Unpacking is dependency-free: zlib gunzip + a minimal tar reader (no external
// tar). Entries with `..`, absolute paths, symlinks or hardlinks are rejected; a
// single GitHub-style top-level directory is stripped; of an entry's mode only the
// owner's executable bit is kept (k99). Offline with a cache reuses it and warns;
// without a cache it errors. Production is https-only; `allowHttp` (tests only)
// permits http://127.0.0.1.
//
// An update is extracted into `<hash>.stage-*` and swapped in through `<hash>.backup-*`;
// what a run that died leaves of these, `sweepUrlCache` clears – the engine calls it only
// while it holds the sync lock, under which every resolve runs (spec §6.5).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { isExecutable } from "../fsutil.ts";
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

/** The version of a cache's tree, at the root of the tree (reserved there). */
export const URL_VERSION_FILE = ".skilletor-version";

/** The first line of a version file: the format of its tree (k107). 2: an archive entry's
 *  owner executable bit is kept (k99). A version file of skilletor <= 0.4.1 holds the version
 *  alone. */
export const URL_CACHE_FORMAT = "format 2";

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

  async resolve(): Promise<SourceLocation> {
    this.assertScheme();
    const dir = this.cacheDir();
    try {
      const cached = cacheVersion(dir);
      const etag = cached?.startsWith("etag:") ? cached.slice(5) : undefined;
      const res = await this.request("GET", etag ? { "If-None-Match": etag } : {});
      if (res.status === 304 && etag) return { dir, version: cached! };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = Buffer.from(await res.arrayBuffer());
      const resEtag = res.headers.get("etag");
      const version = resEtag ? `etag:${resEtag}` : `sha256:${createHash("sha256").update(body).digest("hex")}`;

      const entries = stripTopLevel(parseTar(gunzipSync(body))).filter((e) => !isReserved(e.name));
      const warning = publishEntries(dir, entries, version);
      return { dir, version, ...(warning ? { warning } : {}) };
    } catch (err) {
      if (err instanceof TarError) {
        throw new Error(`url source ${this.opts.url} failed: ${err.message}`);
      }
      if (existsSync(dir)) {
        return {
          dir,
          version: cacheVersion(dir) ?? "unknown", // of the tree there: a failed update restored the old one
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
  /** A file whose mode has the owner's executable bit. */
  executable: boolean;
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
    const mode = readOctal(block, 100, 8);
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
      entries.push({ name: name.replace(/\/+$/, ""), type: "dir", data: Buffer.alloc(0), executable: false });
    } else {
      entries.push({ name, type: "file", data, executable: isExecutable(mode) });
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

/** The version of the tree in cache dir `dir`; undefined without a readable, well-formed one of
 *  the current format. */
function cacheVersion(dir: string): string | undefined {
  try {
    const [format, version, ...rest] = readFileSync(join(dir, URL_VERSION_FILE), "utf8").split("\n");
    if (format !== URL_CACHE_FORMAT || rest.length > 0) return undefined;
    return /^(etag|sha256):[^\r\n]+$/.test(version ?? "") ? version : undefined;
  } catch {
    return undefined;
  }
}

/** An archive entry at the version file's path, or under it (`./` prefixes too): never extracted. */
function isReserved(name: string): boolean {
  return name.split("/").find((seg) => seg !== "" && seg !== ".") === URL_VERSION_FILE;
}

/**
 * Extract completely, with the tree's `version` inside it, before replacing the cache; never
 * expose a partial tree. Every rename below moves tree and version together.
 */
function publishEntries(dir: string, entries: TarEntry[], version: string): string | undefined {
  mkdirSync(dirname(dir), { recursive: true });
  const staging = mkdtempSync(`${dir}.stage-`);
  let backup: string | undefined;
  let oldMoved = false;
  let published = false;
  const cleanupWarnings: string[] = [];
  try {
    writeEntries(staging, entries);
    writeFileSync(join(staging, URL_VERSION_FILE), `${URL_CACHE_FORMAT}\n${version}`);
    if (existsSync(dir)) {
      // A rename cannot replace a nonempty directory on supported filesystems.
      backup = mkdtempSync(`${dir}.backup-`);
      renameSync(dir, join(backup, "tree"));
      oldMoved = true;
    }
    try {
      renameSync(staging, dir);
    } catch (err) {
      if (oldMoved) {
        try {
          renameSync(join(backup!, "tree"), dir);
          oldMoved = false;
        } catch (restoreError) {
          throw new Error(`cache publication failed (${(err as Error).message}); ` +
            `restoration failed (${(restoreError as Error).message}); last good cache remains at ${join(backup!, "tree")}`);
        }
      }
      throw err;
    }
    // Commit point: cleanup must not turn new bytes into an old-version fallback.
    published = true;
  } finally {
    // Keep the backup if restoration failed. This is not crash-atomic: a process
    // killed between the two renames can leave the old tree only in the backup –
    // sweepUrlCache puts it back.
    const obsolete = [staging, ...(backup && (!oldMoved || published) ? [backup] : [])];
    for (const path of obsolete) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        cleanupWarnings.push(`cache cleanup failed for ${path} (${(err as Error).message})`);
      }
    }
  }
  return cleanupWarnings.length ? cleanupWarnings.join("; ") : undefined;
}

/** A stage or backup tree `publishEntries` makes next to a cache dir (`<hash>` of cacheDir). */
const LEFTOVER = /^([0-9a-f]{16})\.(stage|backup)-[A-Za-z0-9]{6}$/;

/**
 * Clear what a run that failed or died left of an update in `cacheRoot`: a stage tree goes;
 * a backup whose cache dir is missing holds the last good cache (a run killed between the two
 * renames, or one whose restoration failed) and is renamed back into place; any other backup
 * goes. Only safe while no resolve can run – the caller holds the sync lock (spec §6.5).
 * Never throws: whatever cannot be cleared now is tried again by the next run.
 */
export function sweepUrlCache(cacheRoot: string): void {
  let names: string[];
  try {
    names = readdirSync(cacheRoot).sort();
  } catch {
    return; // no cache yet, or none readable: nothing to sweep
  }
  for (const name of names) {
    const m = LEFTOVER.exec(name);
    if (!m) continue;
    const path = join(cacheRoot, name);
    try {
      if (m[2] === "backup") {
        const dir = join(cacheRoot, m[1]!);
        const tree = join(path, "tree");
        if (!existsSync(dir) && isRealDir(tree)) renameSync(tree, dir);
      }
      rmSync(path, { recursive: true, force: true });
    } catch {
      // left for the next run
    }
  }
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeEntries(dir: string, entries: TarEntry[]): void {
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
      writeFileSync(dest, e.data, { mode: e.executable ? 0o777 : 0o666 });
    }
  }
}
