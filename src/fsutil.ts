// Small filesystem helpers shared by the engine.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** sha256 of a buffer, as "sha256:<hex>". */
export function hashBuffer(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/** Write atomically: temp file in the same directory, then rename. */
export function atomicWrite(path: string, data: string | Buffer): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.skilletor-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The real path of `path`, or its resolved form when it cannot be resolved (missing). */
export function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when both paths name the same location once symlinks are resolved. */
export function samePath(a: string, b: string): boolean {
  return realOrResolved(a) === realOrResolved(b);
}

/**
 * Where a file path ends up once symlinks are followed, also for a missing file
 * or a dangling link (then: the real parent dir joined with the final name).
 */
function fileTarget(path: string): string {
  let p = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    try {
      return realpathSync(p);
    } catch {
      // missing, or a link that dangles: follow one link by hand
    }
    try {
      if (!lstatSync(p).isSymbolicLink()) break;
      p = resolve(dirname(p), readlinkSync(p));
    } catch {
      break;
    }
  }
  return join(realOrResolved(dirname(p)), basename(p));
}

/** True when writing `a` would write `b`: same target path, or the same inode (hard link). Never throws. */
export function sameFile(a: string, b: string): boolean {
  if (fileTarget(a) === fileTarget(b)) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}
