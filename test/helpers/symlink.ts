// Windows without developer mode or admin rights cannot create symlinks (EPERM). A test that
// needs one is skipped there with this reason; everywhere else it runs as before.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "skilletor-symlink-probe-"));
  try {
    symlinkSync("target", join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `false` where symlinks can be created, else the reason to skip a test that creates one. */
export const NO_SYMLINKS: string | false = canSymlink()
  ? false
  : "this system cannot create symlinks (Windows without developer mode or admin rights)";
