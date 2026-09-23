// Apply a build plan to disk (spec §6.1–6.3).
//
// Compares each item's built output against disk and the lock, writes only
// differences (atomically), removes files an item no longer contains, and
// deletes items no longer declared. Foreign paths (present but not in the lock)
// are never overwritten without --force; managed files that drifted from their
// lock hash are overwritten and reported. `apply` knows nothing about sources.
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import type { ItemType } from "./config.ts";
import { atomicWrite, hashBuffer } from "./fsutil.ts";
import { readLock, serializeLock, writeLock, type Lock, type LockEntry, type SkipReason } from "./lock.ts";

export interface PlanItem {
  /** Lock key: "<typedir>/<name>", e.g. "skills/perl-moo". */
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
  /** A section of a shared file's managed block (spec §14.8): recorded in the lock
   *  and reported by hash, never written or deleted here — the caller maintains
   *  the block from the new lock. */
  inBlock?: boolean;
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
  conflicts: { key: string; path: string }[];
  overwritten: { key: string; path: string }[];
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
  const res: ApplyResult = { added: [], updated: [], removed: [], unchanged: [], skipped: [], conflicts: [], overwritten: [] };
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
      for (const rel of files) removeFile(safeJoin(root, rel), touched(root));
      if (files.length > 0) res.removed.push(it.key);
      res.skipped.push(it.key);
      newLock[it.key] = { source: it.source, version: it.version, files: {}, skipped: it.skipped };
      continue;
    }
    // A previous skip entry owns nothing: treat the item as not yet installed.
    const existing = oldLock[it.key]?.skipped ? undefined : oldLock[it.key];
    const entryFiles: Record<string, string> = {};
    let wrote = false;
    let removedFile = false;

    for (const [rel, buf] of it.output) {
      const abs = safeJoin(root, rel);
      const desired = hashBuffer(buf);
      const locked = existing?.files[rel];
      const onDisk = existsSync(abs);

      if (onDisk) {
        const diskHash = hashBuffer(readFileSync(abs));
        if (locked === undefined && !opts.force) {
          // Foreign, unmanaged path: never clobbered.
          res.conflicts.push({ key: it.key, path: rel });
          continue;
        }
        if (diskHash === desired) {
          // Already correct; adopt into the lock (updates a stale hash silently).
          entryFiles[rel] = desired;
          continue;
        }
        atomicWrite(abs, buf);
        wrote = true;
        entryFiles[rel] = desired;
        if (locked !== undefined && diskHash !== locked) {
          res.overwritten.push({ key: it.key, path: rel }); // local drift
        }
      } else {
        atomicWrite(abs, buf);
        wrote = true;
        entryFiles[rel] = desired;
      }
    }

    // Files this item no longer contains but the lock still tracks.
    if (existing) {
      for (const rel of Object.keys(existing.files)) {
        if (!it.output.has(rel)) {
          removeFile(safeJoin(root, rel), touched(root));
          removedFile = true;
        }
      }
    }

    if (Object.keys(entryFiles).length > 0) {
      newLock[it.key] = { source: it.source, version: it.version, files: entryFiles };
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
      for (const rel of Object.keys(oldLock[key]!.files)) {
        removeFile(safeJoin(root, rel), touched(root));
      }
    }
    if (!oldLock[key]!.skipped) res.removed.push(key); // a skip entry had nothing installed
  }

  for (const [root, dirs] of dirsTouched) pruneEmptyDirs(dirs, root);

  // Only rewrite the lock when it actually changed (keep no-op runs write-free).
  if (serializeLock(newLock) !== serializeLock(oldLock)) {
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
    newLock[it.key] = { source: it.source, version: it.version, files: {}, skipped: it.skipped, block: true };
    return;
  }
  const files: Record<string, string> = {};
  for (const [rel, buf] of it.output) files[rel] = hashBuffer(buf);
  newLock[it.key] = { source: it.source, version: it.version, files, block: true };
  if (!had) res.added.push(it.key);
  else if (JSON.stringify(prev!.files) !== JSON.stringify(files)) res.updated.push(it.key);
  else res.unchanged.push(it.key);
}

function safeJoin(root: string, rel: string): string {
  const abs = resolvePath(join(root, rel));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ApplyError(`path escapes target: ${rel}`);
  }
  return abs;
}

function removeFile(abs: string, dirsTouched: Set<string>): void {
  if (existsSync(abs)) {
    rmSync(abs, { force: true });
    dirsTouched.add(dirname(abs));
  }
}

/** Remove now-empty directories we deleted from, walking up to (not incl.) root. */
function pruneEmptyDirs(dirs: Set<string>, root: string): void {
  const sorted = [...dirs].sort((a, b) => b.length - a.length); // deepest first
  for (let dir of sorted) {
    while (dir !== root && dir.startsWith(root + sep)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  }
}
