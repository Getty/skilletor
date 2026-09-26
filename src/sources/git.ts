// Git source backend (spec §4.4).
//
// resolve(): shallow clone/fetch into a URL/ref-specific cache, hard reset to ref.
//   The unpinned source retains its legacy URL-only cache; explicit refs never share it.
// check():   a SHA pin against the locked commit, without the remote when they match;
//            otherwise the commit the ref names per `git ls-remote` – the ref `git fetch`
//            would take, an annotated tag peeled – vs the locked commit.
// Git runs via execFile (no shell), with GIT_TERMINAL_PROMPT=0 so a hook never
// blocks on a credential prompt. The address and the ref follow `--` wherever git takes
// them, so it never reads one as an option (k85; `--`, unlike `--end-of-options`, predates
// git 2.24); only a SHA pin – hex, never an option – also reaches rev-parse and reset.
// When the remote is unreachable but a cache exists, resolve reuses it and reports a
// warning; without a cache – a repo without a commit is none – or with one that holds another
// commit than a SHA pin, it errors.
// The lock files a git killed midway leaves in a cache, `sweepGitCache` clears – the engine
// calls it only while it holds the sync lock, under which every resolve runs (spec §6.5).
// A cache a killed run was creating, resolve completes before it fetches (k90); in a cache,
// git never looks for a repository above it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
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
          // In a cache, git takes its `.git` or no repository (k90): one a killed `git init` left
          // unfinished is none to git, which would look further up – `~/.claude` may be a repo.
          env: {
            ...process.env, GIT_TERMINAL_PROMPT: "0",
            ...(cwd ? { GIT_CEILING_DIRECTORIES: resolvePath(cwd, "..") } : {}),
          },
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
        await this.run(dir, ["remote", "add", "--", "origin", this.opts.url]);
      } else {
        await this.repair(dir);
      }

      let resetTarget = "FETCH_HEAD";
      if (ref && isCommitish(ref)) {
        try {
          await this.run(dir, ["fetch", "--depth", "1", "--", "origin", ref]);
        } catch {
          await this.run(dir, ["fetch", "origin"]);
          resetTarget = ref;
        }
      } else {
        await this.run(dir, ["fetch", "--depth", "1", "--", "origin", ref ?? "HEAD"]);
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

  /**
   * Make a cache a run killed while creating it left fit to fetch into, keeping what it holds
   * (k90): a `.git` `git init` never finished is finished – a no-op on a whole repo – and a repo
   * without `origin` gets it. An `origin` naming another address is pointed at the source's; a
   * failure there fails the fetch. A whole cache costs one config read and no write.
   */
  private async repair(dir: string): Promise<void> {
    const origin = await this.run(dir, ["config", "--local", "--get", "remote.origin.url"])
      .then((out) => out.trim(), () => undefined);
    if (origin === undefined) {
      await this.run(dir, ["init", "-q"]);
      await this.run(dir, ["remote", "add", "--", "origin", this.opts.url]);
    } else if (origin !== this.opts.url) {
      await this.run(dir, ["remote", "set-url", "--", "origin", this.opts.url]);
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

    // The commit the ref names upstream. Nothing – a SHA pin the lock does not hold, or a
    // ref that is gone – counts as changed; a tag named like a SHA (a date) compares by name.
    // ls-remote lists every ref ending in `/<pattern>`, a tag's peeled line only when asked
    // for; these patterns cover each name in REF_RULES, and remoteCommit picks among them.
    const name = ref ?? "HEAD";
    const patterns = [name, `${name}/HEAD`].flatMap((p) => [p, `${p}^{}`]);
    const out = await this.run("", ["ls-remote", "--", this.opts.url, ...patterns], this.opts.timeoutMs);
    const remote = remoteCommit(out, name);
    return !(cached.length > 0 && remote.startsWith(cached));
  }
}

/** git's order for a short ref name (`ref_rev_parse_rules`): the ref `git fetch` takes. */
const REF_RULES: ((ref: string) => string)[] = [
  (r) => r, (r) => `refs/${r}`, (r) => `refs/tags/${r}`, (r) => `refs/heads/${r}`,
  (r) => `refs/remotes/${r}`, (r) => `refs/remotes/${r}/HEAD`,
];

/**
 * The commit `ref` names in `git ls-remote` output: of the refs listed, the one git ranks
 * first, through its peeled `^{}` line when it is a tag object. "" when none is listed.
 */
function remoteCommit(lsRemote: string, ref: string): string {
  const shas = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha && name) shas.set(name, sha.toLowerCase());
  }
  for (const rule of REF_RULES) {
    const name = rule(ref);
    const sha = shas.get(`${name}^{}`) ?? shas.get(name);
    if (sha) return sha;
  }
  return "";
}

/** The name `cacheDir` gives a cache: 16 hex digits of a sha256 (url caches share the scheme). */
const CACHE_NAME = /^[0-9a-f]{16}$/;

/**
 * The lock files, relative to `.git`, git takes for what resolve runs: `remote` (config),
 * `fetch` (shallow, packed-refs; reftable's table list), `reset` (index, HEAD, ORIG_HEAD) –
 * besides the ref locks under `refs/`, which `refLocks` finds.
 */
const LOCK_FILES = [
  "index.lock", "shallow.lock", "config.lock", "HEAD.lock", "ORIG_HEAD.lock", "packed-refs.lock",
  join("reftable", "tables.list.lock"),
];

/**
 * How old a lock file must be to count as a dead git's: the sync lock's stale age (spec §6.5).
 * No resolve runs while the sweep does, but git can run outside the sync lock: the
 * `maintenance run --auto --detach` each fetch starts, a git child that outlived its killed run.
 */
const STALE_LOCK_MS = 5 * 60_000;

/**
 * Remove the lock files a git killed midway left in the git caches of `cacheRoot` – git never
 * removes another process's lock, so each later fetch or reset of that cache would fail. A git
 * cache is a dir named like `cacheDir`'s with a real `.git` directory; only the names in
 * LOCK_FILES and `*.lock` files under `.git/refs` go, each once older than STALE_LOCK_MS.
 * Only safe while no resolve can run – the caller holds the sync lock (spec §6.5). Never
 * throws: whatever cannot be cleared now is tried again by the next run.
 */
export function sweepGitCache(cacheRoot: string): void {
  let names: string[];
  try {
    names = readdirSync(cacheRoot);
  } catch {
    return; // no cache yet, or none readable: nothing to sweep
  }
  const now = Date.now();
  for (const name of names) {
    if (!CACHE_NAME.test(name)) continue;
    const gitDir = join(cacheRoot, name, ".git");
    try {
      if (!lstatSync(gitDir).isDirectory()) continue; // a symlink or a gitfile: not one git init made
    } catch {
      continue;
    }
    for (const path of [...LOCK_FILES.map((f) => join(gitDir, f)), ...refLocks(join(gitDir, "refs"))]) {
      try {
        const st = lstatSync(path);
        if (st.isFile() && now - st.mtimeMs > STALE_LOCK_MS) rmSync(path, { force: true });
      } catch {
        // absent, or left for the next run
      }
    }
  }
}

/**
 * Every `*.lock` file under `dir` (a `.git/refs`), never through a symlink. A ref name cannot
 * end in `.lock` (git check-ref-format), so each is a ref lock. One readdir per directory: the
 * loose refs a cache holds – a few after a shallow fetch, every branch and tag after the full
 * fetch a SHA pin falls back to – never the object store.
 */
function refLocks(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...refLocks(path));
    else if (e.isFile() && e.name.endsWith(".lock")) out.push(path);
  }
  return out;
}

/** A full or abbreviated commit SHA. */
function isCommitish(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** Do two (lowercase) SHAs, either abbreviated, name the same commit? */
function samePrefix(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}
