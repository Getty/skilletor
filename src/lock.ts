// Per-scope lock file (spec §6.2): what skilletor installed, with output hashes.
//
//   { "skills/perl-moo": {
//       "source": "shared", "version": "git:ab12cd3",
//       "files": { "skills/perl-moo/SKILL.md": "sha256:…" } },
//     "rules/k8s": { …, "files": {}, "skipped": "renders-empty" } }
//
// Serialized deterministically (sorted keys) so a no-op run produces identical
// bytes and never rewrites the file.
import { readFileSync } from "node:fs";
import { atomicWrite } from "./fsutil.ts";

export interface LockEntry {
  source: string;
  version: string;
  /** Install-relative path -> content hash. */
  files: Record<string, string>;
  /** Declared but not applicable in this scope: owns no files (spec §5, §6.2). */
  skipped?: SkipReason;
}

export type SkipReason = "renders-empty";

export type Lock = Record<string, LockEntry>;

export class LockError extends Error {
  override name = "LockError";
}

export function readLock(path: string): Lock {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new LockError(`${path}: cannot read lock (${(err as Error).message})`);
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected an object");
    }
    return value as Lock;
  } catch (err) {
    throw new LockError(`${path}: invalid lock JSON (${(err as Error).message})`);
  }
}

/** Serialize with sorted keys at every level for stable output. */
export function serializeLock(lock: Lock): string {
  const out: Lock = {};
  for (const key of Object.keys(lock).sort()) {
    const entry = lock[key]!;
    const files: Record<string, string> = {};
    for (const f of Object.keys(entry.files).sort()) files[f] = entry.files[f]!;
    out[key] = { source: entry.source, version: entry.version, files };
    if (entry.skipped) out[key].skipped = entry.skipped;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

export function writeLock(path: string, lock: Lock): void {
  atomicWrite(path, serializeLock(lock));
}
