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

/** Does a file on disk with `mode` carry the executable bit `executable` as skilletor wants
 *  it? On Windows a file has no executable bit – its mode never shows one, a chmod does not
 *  set it – so there any mode matches and bytes alone decide. */
export function executableMatches(mode: number, executable: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || isExecutable(mode) === executable;
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
    // On Windows, the native resolver uses the platform's canonical DOS path. In particular,
    // Node 24 implements it with GetFinalPathNameByHandleW, so an existing 8.3 alias and Git's
    // long spelling become one project identity. Keep the established resolver on POSIX.
    return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
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

/**
 * JSON.parse with one error wording on every engine (k278): V8 and JavaScriptCore (Bun) word a
 * syntax error differently, and the message reaches the user (`invalid JSON (…)`). A failure is
 * a SyntaxError reading `unexpected end of input` or `unexpected 'x' at line L column C` (both
 * 1-based, the column in UTF-16 units), its place found by `jsonErrorAt`. Any other error (a
 * RangeError of a deep nesting) passes unchanged.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const at = jsonErrorAt(text);
    if (at < 0) throw new SyntaxError("not valid JSON"); // none found: never seen, but say something stable
    if (at >= text.length) throw new SyntaxError("unexpected end of input");
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const column = at - before.lastIndexOf("\n");
    throw new SyntaxError(`unexpected '${String.fromCodePoint(text.codePointAt(at)!)}' at line ${line} column ${column}`);
  }
}

/** The offset of the first character JSON (RFC 8259) does not allow in `text`; `text.length`
 *  for an early end; -1 if there is none. Only ever asked about text JSON.parse refused. */
function jsonErrorAt(text: string): number {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const digits = () => {
    if (!(text[i]! >= "0" && text[i]! <= "9")) fail();
    while (text[i]! >= "0" && text[i]! <= "9") i++;
  };
  const string = () => {
    i++; // the opening quote
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i]!;
      if (c === '"') return void i++;
      if (c === "\\") {
        i++;
        if (text[i] !== undefined && '"\\/bfnrt'.includes(text[i]!)) i++;
        else if (text[i] === "u") {
          i++;
          for (let k = 0; k < 4; k++) {
            if (!/^[0-9a-fA-F]$/.test(text[i] ?? "")) fail();
            i++;
          }
        } else fail();
      } else if (c < " ") fail();
      else i++;
    }
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (;;) {
        if (close === "}") {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ":") fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === close) return void i++;
        else fail();
      }
    }
    if (c === '"') return string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      if (text[i] === "-") i++;
      if (text[i] === "0") i++;
      else digits();
      if (text[i] === ".") {
        i++;
        digits();
      }
      if (text[i] === "e" || text[i] === "E") {
        i++;
        if (text[i] === "+" || text[i] === "-") i++;
        digits();
      }
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (c === word[0]) {
        for (const ch of word) {
          if (text[i] !== ch) fail();
          i++;
        }
        return;
      }
    }
    fail();
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
    return -1;
  } catch (at) {
    if (typeof at !== "number") throw at;
    return at;
  }
}
