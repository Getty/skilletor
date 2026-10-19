// Small filesystem helpers shared by the engine.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** `p` with "/" between its parts: the form of every path inside an item, a lock key or a
 *  `.gitignore` line, on Windows too. The identity where the separator already is "/". */
/**
 * Claude Code's config dir (k145): the injected one, else `$CLAUDE_CONFIG_DIR` (empty means
 * unset), else `<home>/.claude`. The user scope's config, lock, state and roots, and Claude's
 * own plugin state, all live under it.
 */
export function claudeConfigDirOf(home: string, injected?: string): string {
  return injected || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** The segments of `entry`, a path relative to some root ("\" separates like "/", empty and
 *  "." segments are dropped) – or why it names nothing beneath that root: it is absolute,
 *  contains "..", or is the root itself ("", "."). What a plugin.json `skills` path and a
 *  source's `path` are held to before the file system is asked (spec §3, §4.1). */
export function innerSegments(entry: string): string[] | "absolute" | "dotdot" | "root" {
  if (isAbsolute(entry) || entry.startsWith("/") || entry.startsWith("\\")) return "absolute";
  const segments = entry.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return "dotdot";
  return segments.length === 0 ? "root" : segments;
}

/** sha256 of a buffer, as "sha256:<hex>". */
export function hashBuffer(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/** The owner's executable bit of a file mode: the one bit of a mode skilletor carries from a
 *  source to its install, as git records no other (k99). */
export function isExecutable(mode: number): boolean {
  return (mode & 0o100) !== 0;
}

/** Write atomically: temp file in the same directory, then rename. An `executable` file is
 *  created with mode 0777 instead of 0666, both less the umask. */
export function atomicWrite(path: string, data: string | Buffer, executable = false): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.skilletor-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, data, { mode: executable ? 0o777 : 0o666 });
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
