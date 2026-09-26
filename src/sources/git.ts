// Git source backend (spec §4.4).
//
// resolve(): shallow clone/fetch into a URL/ref-specific cache, hard reset to ref.
//   The unpinned source retains its legacy URL-only cache; explicit refs never share it.
// check():   a SHA pin against the locked commit, without the remote when they match;
//            otherwise `git ls-remote` vs the locked commit.
// Git runs via execFile (no shell), with GIT_TERMINAL_PROMPT=0 so a hook never
// blocks on a credential prompt. When the remote is unreachable but a cache
// exists, resolve reuses it and reports a warning; without a cache, or with one
// that holds another commit than a SHA pin, it errors.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Source, SourceLocation } from "./types.ts";

export interface GitSourceOptions {
  url: string;
  ref?: string;
  cacheRoot: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The cache holds another commit than the SHA pin asks for. */
class PinMismatch extends Error {}

export class GitSource implements Source {
  private readonly opts: GitSourceOptions;

  constructor(opts: GitSourceOptions) {
    this.opts = opts;
  }

  private cacheDir(): string {
    const identity = this.opts.ref ? JSON.stringify([this.opts.url, this.opts.ref]) : this.opts.url;
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    return join(this.opts.cacheRoot, hash);
  }

  private run(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: cwd || undefined,
          timeout: timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 32 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
          else resolvePromise(stdout.toString());
        },
      );
    });
  }

  private isRepo(dir: string): boolean {
    return existsSync(join(dir, ".git"));
  }

  async resolve(_cachedVersion?: string): Promise<SourceLocation> {
    const dir = this.cacheDir();
    const ref = this.opts.ref;
    try {
      if (!this.isRepo(dir)) {
        mkdirSync(dir, { recursive: true });
        await this.run(dir, ["init", "-q"]);
        await this.run(dir, ["remote", "add", "origin", this.opts.url]);
      } else {
        await this.run(dir, ["remote", "set-url", "origin", this.opts.url]).catch(() => {});
      }

      let resetTarget = "FETCH_HEAD";
      if (ref && isCommitish(ref)) {
        try {
          await this.run(dir, ["fetch", "--depth", "1", "origin", ref]);
        } catch {
          await this.run(dir, ["fetch", "origin"]);
          resetTarget = ref;
        }
      } else {
        await this.run(dir, ["fetch", "--depth", "1", "origin", ref ?? "HEAD"]);
      }
      await this.run(dir, ["reset", "--hard", resetTarget]);

      return { dir, version: await this.version(dir) };
    } catch (err) {
      if (this.isRepo(dir)) {
        try {
          return {
            dir,
            version: await this.version(dir),
            warning: `git fetch failed for ${this.opts.url}, using cache (${(err as Error).message})`,
          };
        } catch (cacheError) {
          // A repo without a commit is no cache; only a refused pin is worth naming.
          if (cacheError instanceof PinMismatch) {
            throw new Error(`git source ${this.opts.url} failed: ${(err as Error).message}; ` +
              `cache rejected (${cacheError.message})`);
          }
        }
      }
      throw new Error(`git source ${this.opts.url} failed: ${(err as Error).message}`);
    }
  }

  private async version(dir: string): Promise<string> {
    const ref = this.opts.ref;
    if (ref && isCommitish(ref)) {
      // Validate even on fallback: a repo's existence is no proof it holds this pin.
      const head = (await this.run(dir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      // What the pin names in this cache; "" for nothing: ambiguous, absent, or a tag or
      // branch named like a SHA prefix (a date) that the fetch resolved by name.
      const pin = await this.run(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
        .then((out) => out.trim(), () => "");
      // A prefix of HEAD must resolve to HEAD unambiguously. Any other ref counts as such a
      // name unless it names another commit here – or is a full SHA, which git fetch only
      // ever reads as an object id.
      const byName = ref.length < 40 && (pin === "" || pin === head);
      const held = head.startsWith(ref.toLowerCase()) ? pin === head : byName;
      if (!held) throw new PinMismatch(`cached commit ${head} does not match requested pin ${ref}`);
    }
    const sha = (await this.run(dir, ["rev-parse", "--short", "HEAD"])).trim();
    return `git:${sha}`;
  }

  async check(cachedVersion: string | undefined): Promise<boolean> {
    if (!cachedVersion) return true;
    const ref = this.opts.ref;
    const cached = cachedVersion.replace(/^git:/, "").toLowerCase();
    // A SHA pin the lock already holds never moves: decided without the remote.
    if (ref && isCommitish(ref) && samePrefix(cached, ref.toLowerCase())) return false;

    // What the ref names upstream. Nothing – a SHA pin the lock does not hold, or a ref
    // that is gone – counts as changed; a tag named like a SHA (a date) compares by name.
    const out = await this.run("", ["ls-remote", this.opts.url, ref ?? "HEAD"], this.opts.timeoutMs);
    const remote = out.split(/\s+/)[0] ?? "";
    return !(cached.length > 0 && remote.startsWith(cached));
  }
}

/** A full or abbreviated commit SHA. */
function isCommitish(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** Do two (lowercase) SHAs, either abbreviated, name the same commit? */
function samePrefix(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}
