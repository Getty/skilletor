// Temp-directory fixture helper for tests.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TmpDir {
  /** Absolute path of the created directory. */
  readonly dir: string;
  /** Remove the directory and everything under it. */
  cleanup(): void;
}

/** Create an isolated temp directory. Caller must call `cleanup()`. */
export function makeTmpDir(prefix = "skilletor-test-"): TmpDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** True when `dir`'s file system treats names equal ignoring case as one (macOS, Windows). */
export function caseInsensitive(dir: string): boolean {
  writeFileSync(join(dir, "CaseProbe"), "");
  try {
    return existsSync(join(dir, "caseprobe"));
  } finally {
    rmSync(join(dir, "CaseProbe"));
  }
}
