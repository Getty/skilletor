// Apply a build plan to disk (spec §6.1–6.3).
//
// Compares each item's built output against disk and the lock, writes only
// differences (atomically), removes files an item no longer contains, and
// deletes items no longer declared. Every path of an item is checked before its
// first write: a foreign path (present but not in the lock) or a symbolic link at
// or below the item's own path blocks the whole item – nothing of it is written or
// removed – unless --force adopts the file, replaces the link or deletes the file
// at a claimed path. Nothing is ever written or deleted through such a link; links
// above the item's path (a linked `skills` dir) are followed. Managed files that
// drifted from their lock hash are overwritten and reported. `apply` knows nothing
// about sources.
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import type { ItemType } from "./config.ts";
import { atomicWrite, hashBuffer } from "./fsutil.ts";
import { readLock, serializeLock, writeLock, type Lock, type LockEntry, type SkipReason } from "./lock.ts";

export interface PlanItem {
  /** Lock key: "[<prefix>:]<typedir>/<name>", e.g. "skills/perl-moo". Without the
   *  prefix it is the item's own path under its root (spec §6.3): a skill's directory. */
  key: string;
  type: ItemType;
  name: string;
  source: string;
  version: string;
  /** Install-relative path -> bytes. */
  output: Map<string, Buffer>;
  /** Not applicable in this scope: write nothing, remove an installed copy,
   *  keep a file-less lock entry carrying the reason. `output` is ignored. */
  skipped?: SkipReason;
  /** A section of a file assembled from several items (the Codex rules file, spec
   *  §14.8): recorded in the lock and reported by hash, never written or deleted
   *  here — the caller rebuilds the file from the new lock. */
  inBlock?: boolean;
  /** Recorded in the lock entry as is (the bundles that declared the item). */
  via?: string[];
  /** Paths the item claims without writing them (an agent's plain file name next to
   *  its `.local.` file, spec §6.3). A file there that the item's lock entry does not
   *  own is a conflict like any other; with `force` it is deleted instead of adopted. */
  claims?: string[];
}

export interface ApplyOptions {
  /** Scope root (the `.claude` directory): holds the lock, and every key's files
   *  unless `rootOf` says otherwise. */
  targetDir: string;
  /** Root directory a lock key's files live under (e.g. `.agents` for a Codex
   *  key); default `targetDir`. Must answer for every key in the plan and every
   *  old lock key not in `keep`. */
  rootOf?: (key: string) => string;
  force?: boolean;
  /** Lock keys to preserve untouched even if absent from the plan (e.g. an
   *  offline or untrusted source whose items must not be deleted). */
  keep?: string[];
}

export interface ApplyResult {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  /** Plan items marked skipped (also in `removed` if files were deleted). */
  skipped: string[];
  /** A conflict blocks its whole item (spec §6.3). `replace`: a claimed path, or a link
   *  (or file) where the item needs a directory – `force` deletes it rather than adopts. */
  conflicts: { key: string; path: string; replace?: true }[];
  overwritten: { key: string; path: string }[];
  /** Paths written this run, or adopted into the lock with `force` (spec §6.4: the
   *  tracked-file check looks at these only). */
  written: { key: string; path: string }[];
  /** Symbolic links at or below the path of an item being removed (no longer declared,
   *  or skipped): the lock-owned files behind them were not deleted, and the lock lets
   *  go of them (spec §6.3). One entry per item and link. */
  leftInPlace: { key: string; path: string }[];
}

export class ApplyError extends Error {
  override name = "ApplyError";
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** True if `apply` accepts this item name (callers can skip instead of failing the plan). */
export function isValidItemName(name: string): boolean {
  return NAME_RE.test(name);
}

export function apply(plan: PlanItem[], opts: ApplyOptions): ApplyResult {
  const targetDir = resolvePath(opts.targetDir);
  const lockPath = join(targetDir, "skilletor.lock.json");
  const oldLock = readLock(lockPath);
  const newLock: Lock = {};
  const res: ApplyResult = {
    added: [], updated: [], removed: [], unchanged: [], skipped: [], conflicts: [], overwritten: [], written: [],
    leftInPlace: [],
  };
  const dirsTouched = new Map<string, Set<string>>(); // root -> dirs deleted from
  const rootFor = (key: string): string => resolvePath(opts.rootOf ? opts.rootOf(key) : targetDir);
  const touched = (root: string): Set<string> => {
    let set = dirsTouched.get(root);
    if (!set) dirsTouched.set(root, (set = new Set()));
    return set;
  };

  const planned = new Set(plan.map((i) => i.key));

  for (const it of plan) {
    if (!NAME_RE.test(it.name)) throw new ApplyError(`invalid item name: ${it.name}`);
    if (it.inBlock) {
      recordBlockItem(it, oldLock[it.key], newLock, res);
      continue;
    }
    const root = rootFor(it.key);
    if (it.skipped) {
      // Owns no paths: delete only what the lock says we installed.
      const files = Object.keys(oldLock[it.key]?.files ?? {});
      removeItemFiles(it.key, root, files, touched(root), res);
      if (files.length > 0) res.removed.push(it.key);
      res.skipped.push(it.key);
      newLock[it.key] = withVia({ source: it.source, version: it.version, files: {}, skipped: it.skipped }, it);
      continue;
    }
    // A previous skip entry owns nothing: treat the item as not yet installed.
    const existing = oldLock[it.key]?.skipped ? undefined : oldLock[it.key];
    const owned = (rel: string): boolean => existing?.files[rel] !== undefined;
    const own = ownPath(it.key);
    const removals = Object.keys(existing?.files ?? {}).filter((rel) => !it.output.has(rel));

    // Check every path of the item before its first write (spec §6.3). A soft conflict
    // blocks the item unless `force`; a hard one (a directory where a file goes, which
    // is never deleted) blocks it with `force` too.
    const found: { c: { key: string; path: string; replace?: true }; hard: boolean }[] = [];
    // Deleted before the writes: the item's own files where it now has a directory, and
    // with force the links/files in the way and foreign files at claimed paths.
    const deleteFirst: string[] = [];
    const conflict = (path: string, hard: boolean, replace: boolean): void => {
      if (found.some((f) => f.c.path === path)) return;
      found.push({ c: replace ? { key: it.key, path, replace: true } : { key: it.key, path }, hard });
      if (replace && !hard) deleteFirst.push(path);
    };
    const claims = new Set(it.claims ?? []);
    for (const rel of new Set([...claims, ...it.output.keys(), ...removals])) {
      const at = inspect(root, rel, own);
      const isOutput = it.output.has(rel);
      if (at.kind === "blocked") {
        // A link, or a file, where the item needs a directory: a conflict – unless it is
        // one of the item's own files (the source turned it into a directory).
        if (at.link || !owned(at.path)) conflict(at.path, false, true);
        else if (!deleteFirst.includes(at.path)) deleteFirst.push(at.path);
      } else if (!isOutput && !claims.has(rel)) {
        continue; // only a removal: done after the writes
      } else if (at.kind === "other" && (isOutput || !owned(rel))) {
        conflict(rel, true, false);
      } else if ((at.kind === "file" || at.kind === "link") && !owned(rel)) {
        conflict(rel, false, !isOutput);
      }
    }
    const blocking = found.filter((f) => f.hard || !opts.force).map((f) => f.c);
    if (blocking.length > 0) {
      res.conflicts.push(...blocking);
      if (oldLock[it.key]) newLock[it.key] = oldLock[it.key]!; // left as it was
      res.unchanged.push(it.key);
      continue;
    }
    for (const rel of deleteFirst) removeFile(safeJoin(root, rel), touched(root));

    const entryFiles: Record<string, string> = {};
    let wrote = false;
    let removedFile = false;

    for (const [rel, buf] of it.output) {
      const abs = safeJoin(root, rel);
      const desired = hashBuffer(buf);
      const locked = existing?.files[rel];
      const st = lstatOrUndefined(abs);

      if (st?.isFile()) {
        const diskHash = hashBuffer(readFileSync(abs));
        if (diskHash === desired) {
          // Already correct; adopt into the lock (updates a stale hash silently).
          entryFiles[rel] = desired;
          if (locked === undefined) res.written.push({ key: it.key, path: rel }); // adopted (force)
          continue;
        }
        atomicWrite(abs, buf);
        if (locked !== undefined && diskHash !== locked) {
          res.overwritten.push({ key: it.key, path: rel }); // local drift
        }
      } else {
        // Missing, or a link the lock owns (or `force` adopts): the rename replaces the
        // link itself, its target stays untouched.
        atomicWrite(abs, buf);
        if (st && locked !== undefined) res.overwritten.push({ key: it.key, path: rel });
      }
      wrote = true;
      entryFiles[rel] = desired;
      res.written.push({ key: it.key, path: rel });
    }

    // Files this item no longer contains but the lock still tracks.
    if (removeItemFiles(it.key, root, removals, touched(root), res)) removedFile = true;

    if (Object.keys(entryFiles).length > 0) {
      newLock[it.key] = withVia({ source: it.source, version: it.version, files: entryFiles }, it);
    }

    if (existing === undefined) {
      if (wrote) res.added.push(it.key);
      else res.unchanged.push(it.key); // fully conflicted, nothing installed
    } else if (wrote || removedFile) {
      res.updated.push(it.key);
    } else {
      res.unchanged.push(it.key);
    }
  }

  const keep = new Set(opts.keep ?? []);
  // Items no longer declared: delete their locked files (unless kept).
  for (const key of Object.keys(oldLock)) {
    if (planned.has(key)) continue;
    if (keep.has(key)) {
      newLock[key] = oldLock[key]!; // preserve untouched
      continue;
    }
    if (!oldLock[key]!.block) {
      const root = rootFor(key);
      removeItemFiles(key, root, Object.keys(oldLock[key]!.files), touched(root), res);
    }
    if (!oldLock[key]!.skipped) res.removed.push(key); // a skip entry had nothing installed
  }

  for (const [root, dirs] of dirsTouched) pruneEmptyDirs(dirs, root);

  // Only rewrite the lock when it actually changed (keep no-op runs write-free). Without
  // entries it goes, a `{}` an earlier version left included (spec §6.4).
  const emptyLeft = Object.keys(newLock).length === 0 && existsSync(lockPath);
  if (emptyLeft || serializeLock(newLock) !== serializeLock(oldLock)) {
    writeLock(lockPath, newLock);
  }

  return res;
}

/** Lock and report a block section by its hash; no disk access. */
function recordBlockItem(it: PlanItem, prev: LockEntry | undefined, newLock: Lock, res: ApplyResult): void {
  const had = prev !== undefined && !prev.skipped;
  if (it.skipped) {
    if (had) res.removed.push(it.key);
    res.skipped.push(it.key);
    newLock[it.key] = withVia({ source: it.source, version: it.version, files: {}, skipped: it.skipped, block: true }, it);
    return;
  }
  const files: Record<string, string> = {};
  for (const [rel, buf] of it.output) files[rel] = hashBuffer(buf);
  newLock[it.key] = withVia({ source: it.source, version: it.version, files, block: true }, it);
  if (!had) res.added.push(it.key);
  else if (JSON.stringify(prev!.files) !== JSON.stringify(files)) res.updated.push(it.key);
  else res.unchanged.push(it.key);
}

function withVia(entry: LockEntry, it: PlanItem): LockEntry {
  if (it.via?.length) entry.via = [...it.via];
  return entry;
}

function safeJoin(root: string, rel: string): string {
  const abs = resolvePath(join(root, rel));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ApplyError(`path escapes target: ${rel}`);
  }
  return abs;
}

/** The item's own path under its root: the lock key without a `<prefix>:`. */
function ownPath(key: string): string {
  const colon = key.indexOf(":");
  const slash = key.indexOf("/");
  return colon !== -1 && (slash === -1 || colon < slash) ? key.slice(colon + 1) : key;
}

/** lstat that answers `undefined` for a missing path (also below a non-directory). */
function lstatOrUndefined(abs: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw err;
  }
}

type PathState =
  | { kind: "absent" | "file" | "link" | "other" }
  /** A component at or below the item's own path that is a link or no directory. */
  | { kind: "blocked"; path: string; link: boolean };

/**
 * What is at `rel` (spec §6.3), looking at every component from the item's own path
 * down without following links: `skills/foo` and everything under it for a skill, only
 * the file itself for a file outside that path (an agent). Components above are the
 * user's setup and followed. `link`: the path itself is a link; `other`: a directory
 * or special file where a file belongs.
 */
function inspect(root: string, rel: string, own: string): PathState {
  const parts = relative(root, safeJoin(root, rel)).split(sep);
  const ownParts = own.split("/");
  const under = parts.length > ownParts.length && ownParts.every((p, i) => p === parts[i]);
  const first = under ? ownParts.length - 1 : parts.length - 1;
  for (let i = first; i < parts.length; i++) {
    const st = lstatOrUndefined(join(root, ...parts.slice(0, i + 1)));
    if (!st) return { kind: "absent" };
    if (i < parts.length - 1) {
      if (!st.isDirectory()) return { kind: "blocked", path: parts.slice(0, i + 1).join("/"), link: st.isSymbolicLink() };
    } else if (st.isSymbolicLink()) {
      return { kind: "link" };
    } else {
      return { kind: st.isFile() ? "file" : "other" };
    }
  }
  return { kind: "absent" };
}

/** Delete an item's lock-owned files – a link there itself, never through a link at or
 *  below the item's path (reported in `leftInPlace`). True if anything was deleted. */
function removeItemFiles(key: string, root: string, files: string[], dirsTouched: Set<string>, res: ApplyResult): boolean {
  const own = ownPath(key);
  let removed = false;
  for (const rel of files) {
    const at = inspect(root, rel, own);
    if (at.kind === "blocked") {
      if (at.link && !res.leftInPlace.some((l) => l.key === key && l.path === at.path)) {
        res.leftInPlace.push({ key, path: at.path });
      }
    } else if (at.kind === "file" || at.kind === "link") {
      removeFile(safeJoin(root, rel), dirsTouched);
      removed = true;
    }
  }
  return removed;
}

/** Delete a file or link (never a directory, never through the final link). */
function removeFile(abs: string, dirsTouched: Set<string>): void {
  const st = lstatOrUndefined(abs);
  if (st && !st.isDirectory()) {
    rmSync(abs, { force: true });
    dirsTouched.add(dirname(abs));
  }
}

/** Remove now-empty directories we deleted from, walking up to (not incl.) root; a link
 *  on the way (a linked `skills` dir) ends the walk. */
function pruneEmptyDirs(dirs: Set<string>, root: string): void {
  const sorted = [...dirs].sort((a, b) => b.length - a.length); // deepest first
  for (let dir of sorted) {
    while (dir !== root && dir.startsWith(root + sep)) {
      const st = lstatOrUndefined(dir);
      if (!st?.isDirectory() || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  }
}
