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
import { readLock, serializeLock, writeLock, type Lock, type LockEntry } from "./lock.ts";

export interface PlanItem {
  /** Lock key: "<typedir>/<name>", e.g. "skills/perl-moo". */
  key: string;
  type: ItemType;
  name: string;
  source: string;
  version: string;
  /** Install-relative path -> bytes. */
  output: Map<string, Buffer>;
}

export interface ApplyOptions {
  /** Scope root (the `.claude` directory). */
  targetDir: string;
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
  conflicts: { key: string; path: string }[];
  overwritten: { key: string; path: string }[];
}

export class ApplyError extends Error {
  override name = "ApplyError";
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function apply(plan: PlanItem[], opts: ApplyOptions): ApplyResult {
  const targetDir = resolvePath(opts.targetDir);
  const lockPath = join(targetDir, "skilletor.lock.json");
  const oldLock = readLock(lockPath);
  const newLock: Lock = {};
  const res: ApplyResult = { added: [], updated: [], removed: [], unchanged: [], conflicts: [], overwritten: [] };
  const dirsTouched = new Set<string>();

  const planned = new Set(plan.map((i) => i.key));

  for (const it of plan) {
    if (!NAME_RE.test(it.name)) throw new ApplyError(`invalid item name: ${it.name}`);
    const existing = oldLock[it.key];
    const entryFiles: Record<string, string> = {};
    let wrote = false;
    let removedFile = false;

    for (const [rel, buf] of it.output) {
      const abs = safeJoin(targetDir, rel);
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
          removeFile(safeJoin(targetDir, rel), dirsTouched);
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
    for (const rel of Object.keys(oldLock[key]!.files)) {
      removeFile(safeJoin(targetDir, rel), dirsTouched);
    }
    res.removed.push(key);
  }

  pruneEmptyDirs(dirsTouched, targetDir);

  // Only rewrite the lock when it actually changed (keep no-op runs write-free).
  if (serializeLock(newLock) !== serializeLock(oldLock)) {
    writeLock(lockPath, newLock);
  }

  return res;
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
