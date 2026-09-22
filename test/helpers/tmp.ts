// Temp-directory fixture helper for tests.
import { mkdtempSync, rmSync } from "node:fs";
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
