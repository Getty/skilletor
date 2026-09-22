// Git source backend (spec §4.4).
//
// resolve(): shallow clone/fetch into cache/<hash-of-url>/, hard reset to ref.
// check():   `git ls-remote` vs the cached commit (a pinned commit never moves).
// Git runs via execFile (no shell), with GIT_TERMINAL_PROMPT=0 so a hook never
// blocks on a credential prompt. When the remote is unreachable but a cache
// exists, resolve reuses it and reports a warning; without a cache it errors.
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

export class GitSource implements Source {
  private readonly opts: GitSourceOptions;

  constructor(opts: GitSourceOptions) {
    this.opts = opts;
  }

  private cacheDir(): string {
    const hash = createHash("sha256").update(this.opts.url).digest("hex").slice(0, 16);
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

  async resolve(): Promise<SourceLocation> {
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
        } catch {
          // fall through
        }
      }
      throw new Error(`git source ${this.opts.url} failed: ${(err as Error).message}`);
    }
  }

  private async version(dir: string): Promise<string> {
    const sha = (await this.run(dir, ["rev-parse", "--short", "HEAD"])).trim();
    return `git:${sha}`;
  }

  async check(cachedVersion: string | undefined): Promise<boolean> {
    const ref = this.opts.ref;
    // A pinned commit never moves.
    if (ref && isCommitish(ref)) return false;
    if (!cachedVersion) return true;

    const out = await this.run("", ["ls-remote", this.opts.url, ref ?? "HEAD"], this.opts.timeoutMs);
    const remote = out.split(/\s+/)[0] ?? "";
    const cached = cachedVersion.replace(/^git:/, "");
    return !(cached.length > 0 && remote.startsWith(cached));
  }
}

/** A full or abbreviated commit SHA. */
function isCommitish(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}
