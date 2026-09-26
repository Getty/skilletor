// Instance state under ~/.claude/skilletor/ (spec §4.3, §6.5). The root is
// injectable. Nothing here uses CLAUDE_PLUGIN_DATA, so the CLI runs identically
// without Claude Code.
import { randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

/** What trust is stored for (spec §4.3): the backend in use – its kind and its effective
 *  address (a `local` path as an absolute real path). */
export interface TrustedBackend {
  kind: "git" | "url" | "local";
  address: string;
}

/** A backend to check: `user` origin is trusted as is, `project` origin needs an entry. */
export interface TrustCheck extends TrustedBackend {
  origin: "user" | "project";
}

/** The version of a source a sync read, and the backend it read it through (spec §14.3,
 *  k80): kind, address and – git only – the ref, which picks the cache (k69). */
export interface SourceRead extends TrustedBackend {
  ref?: string;
  version: string;
}

/** Timings of `withLock` (spec §6.5); only tests set them. */
export interface WithLockOptions {
  /** How long to wait for another holder before failing (default 5 s). */
  timeoutMs?: number;
  /** A lock whose owner record was not refreshed for this long is stale (default 300 s). */
  staleMs?: number;
  /** How often a holder refreshes its owner record (default 10 s, at most a third of `staleMs`). */
  refreshMs?: number;
  /** How long an owner-less lock dir counts as a run between its mkdir and its owner write
   *  (default 2 s). */
  graceMs?: number;
  pollMs?: number;
  /** Test seam: awaited after a lock was judged stale, before it is broken. */
  beforeBreak?: () => Promise<void>;
  /** Test seam: called after this run made the lock dir, before it writes its owner record. */
  afterMkdir?: () => void;
}

/** `withLock` gave up waiting for another holder of the lock (spec §6.5). */
export class SyncLockTimeoutError extends Error {
  override name = "SyncLockTimeoutError";
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

const LOCK = "sync.lock";
/** What a lock leaves beside it: a broken lock's tombstone, a released lock on its way out. */
const LEFTOVER = `${LOCK}.`;

/** What a waiter saw of a lock it judged stale: the stat of its owner record, or of the dir
 *  itself when it has none. */
interface StaleLock {
  ownerless: boolean;
  ino: number;
  mtimeMs: number;
}

export class State {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  private path(name: string): string {
    return join(this.root, name);
  }

  private readJson(name: string): Record<string, unknown> {
    try {
      const value = JSON.parse(readFileSync(this.path(name), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private writeJson(name: string, value: unknown): void {
    atomicWrite(this.path(name), JSON.stringify(value, null, 2) + "\n");
  }

  // ---- trust ----------------------------------------------------------------

  /** Trust source `name` for exactly this backend; replaces an earlier entry of the name. */
  trust(name: string, backend: TrustedBackend): void {
    const trust = this.readJson("trust.json");
    trust[name] = { kind: backend.kind, address: backend.address };
    this.writeJson("trust.json", trust);
  }

  /** Is source `name` trusted with this backend? An entry written before k66 is the URL
   *  alone: it counts for a git or url backend at exactly that URL, never for a local one. */
  isTrusted(name: string, backend: TrustCheck): boolean {
    if (backend.origin === "user") return true;
    const entry = this.readJson("trust.json")[name];
    if (typeof entry === "string") return backend.kind !== "local" && entry === backend.address;
    if (entry === null || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    return e.kind === backend.kind && e.address === backend.address;
  }

  // ---- last-check -----------------------------------------------------------

  isDue(scopeKey: string, intervalSeconds: number): boolean {
    const last = this.readJson("last-check.json")[scopeKey];
    if (typeof last !== "number") return true;
    return Date.now() - last >= intervalSeconds * 1000;
  }

  markChecked(scopeKey: string): void {
    const checks = this.readJson("last-check.json");
    checks[scopeKey] = Date.now();
    this.writeJson("last-check.json", checks);
  }

  /** Drop a mark: the next check is due at once. */
  clearChecked(scopeKey: string): void {
    const checks = this.readJson("last-check.json");
    if (!(scopeKey in checks)) return;
    delete checks[scopeKey];
    this.writeJson("last-check.json", checks);
  }

  // ---- unreached ------------------------------------------------------------

  /** The drift the last sync of a scope (keyed by its lock path) left in place although
   *  every source it needed was at hand (spec §14.3, k70): `check` does not count it again. */
  unreached(scopeKey: string): string[] {
    const ids = this.readJson("unreached.json")[scopeKey];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  /** Replace a scope's unreached drift; the file is written only when it changes. */
  putUnreached(scopeKey: string, ids: string[]): void {
    const all = this.readJson("unreached.json");
    const next = [...new Set(ids)].sort();
    if (JSON.stringify(all[scopeKey] ?? []) === JSON.stringify(next)) return;
    if (next.length > 0) all[scopeKey] = next;
    else delete all[scopeKey];
    this.writeJson("unreached.json", all);
  }

  // ---- sources read ---------------------------------------------------------

  /** What the last sync of a scope (keyed by its lock path) read of each source (spec §14.3,
   *  k80): `check` compares a source with it. A malformed entry counts as none. */
  sourcesRead(scopeKey: string): Record<string, SourceRead> {
    const record = this.readJson("sources-read.json")[scopeKey];
    const out: Record<string, SourceRead> = {};
    if (record === null || typeof record !== "object" || Array.isArray(record)) return out;
    for (const [name, value] of Object.entries(record as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if ((v.kind !== "git" && v.kind !== "url" && v.kind !== "local") || typeof v.address !== "string" ||
        typeof v.version !== "string" || (v.ref !== undefined && typeof v.ref !== "string")) continue;
      out[name] = { kind: v.kind, address: v.address, version: v.version };
      if (typeof v.ref === "string") out[name].ref = v.ref;
    }
    return out;
  }

  /** Replace a scope's record of sources read; the file is written only when it changes. */
  putSourcesRead(scopeKey: string, record: Record<string, SourceRead>): void {
    const all = this.readJson("sources-read.json");
    const next: Record<string, SourceRead> = {};
    for (const name of Object.keys(record).sort()) {
      const r = record[name]!;
      next[name] = { kind: r.kind, address: r.address, version: r.version };
      if (r.ref !== undefined) next[name].ref = r.ref;
    }
    if (JSON.stringify(all[scopeKey] ?? {}) === JSON.stringify(next)) return;
    if (Object.keys(next).length > 0) all[scopeKey] = next;
    else delete all[scopeKey];
    this.writeJson("sources-read.json", all);
  }

  // ---- render inputs --------------------------------------------------------

  /** The hash of what the last sync of a scope (keyed by its lock path) rendered its items
   *  with (spec §14.3, k76): `check` compares the scope's current inputs with it. A malformed
   *  entry counts as none. */
  renderInputs(scopeKey: string): string | undefined {
    const hash = this.readJson("render-inputs.json")[scopeKey];
    return typeof hash === "string" ? hash : undefined;
  }

  /** Replace a scope's render-inputs hash, or drop it (undefined); the file is written only
   *  when it changes. */
  putRenderInputs(scopeKey: string, hash: string | undefined): void {
    const all = this.readJson("render-inputs.json");
    if (all[scopeKey] === hash) return;
    if (hash === undefined) delete all[scopeKey];
    else all[scopeKey] = hash;
    this.writeJson("render-inputs.json", all);
  }

  // ---- pending report -------------------------------------------------------

  putPendingReport(projectKey: string, report: unknown): void {
    const pending = this.readJson("pending-report.json");
    pending[projectKey] = report;
    this.writeJson("pending-report.json", pending);
  }

  takePendingReport(projectKey: string): unknown {
    const pending = this.readJson("pending-report.json");
    if (!(projectKey in pending)) return undefined;
    const report = pending[projectKey];
    delete pending[projectKey];
    this.writeJson("pending-report.json", pending);
    return report;
  }

  // ---- mutex ----------------------------------------------------------------

  /**
   * Run `fn` holding `sync.lock/` (spec §6.5). The dir is made with mkdir, the owner record in
   * it (`owner.json`: pid, host, token, refresh interval) is created exclusively: of two runs
   * that each made the dir (one broke the other's as owner-less), the one that creates the
   * record holds the lock. While `fn` runs, a timer refreshes the record's mtime. A record not
   * refreshed for `staleMs` – or for two of its refreshes when its pid on this host is gone –
   * marks a lock a dead run left; an owner-less dir older than `graceMs`, one that died before
   * writing its record. A stale lock is renamed to a tombstone named after what the waiter saw,
   * so of two waiters that judged it stale only one moves it.
   */
  async withLock<T>(fn: () => Promise<T> | T, opts: WithLockOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const staleMs = opts.staleMs ?? 300_000;
    const refreshMs = Math.max(1, opts.refreshMs ?? Math.min(10_000, Math.floor(staleMs / 3)));
    const graceMs = opts.graceMs ?? 2_000;
    const pollMs = opts.pollMs ?? 25;
    const lockDir = this.path(LOCK);
    const ownerFile = join(lockDir, "owner.json");
    const token = randomBytes(8).toString("hex");
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (acquire(lockDir, ownerFile, token, refreshMs, opts.afterMkdir)) break;
      const stale = judge(lockDir, ownerFile, staleMs, graceMs);
      if (stale) {
        if (opts.beforeBreak) await opts.beforeBreak();
        if (this.breakLock(lockDir, ownerFile, stale)) continue;
      }
      if (Date.now() >= deadline) {
        throw new SyncLockTimeoutError(`timed out acquiring sync lock at ${lockDir}`);
      }
      await delay(pollMs);
    }

    const heartbeat = setInterval(() => touch(ownerFile), refreshMs);
    heartbeat.unref(); // never what keeps the process alive
    try {
      this.sweepLeftovers(staleMs);
      return await fn();
    } finally {
      clearInterval(heartbeat);
      this.release(lockDir, ownerFile, token);
    }
  }

  /** Break a lock judged stale; true when it is gone, so taking it is worth a try at once. */
  private breakLock(lockDir: string, ownerFile: string, stale: StaleLock): boolean {
    if (stale.ownerless) {
      // rmdir removes an empty dir only; should its run still write the record, the exclusive
      // create in `acquire` decides who holds the lock.
      try {
        rmdirSync(lockDir);
        return true;
      } catch (err) {
        if (errCode(err) === "ENOENT") return true;
        if (existsSync(ownerFile)) return false; // its run wrote the record meanwhile: live
        // Neither empty nor owned – no run made that: moved aside like a stale lock.
      }
    }
    // A second waiter that judged the same lock stale renames onto the same tombstone and
    // fails, since it is not empty: it cannot move the lock that replaced the stale one. The
    // tombstone stays until it is older than the stale age; its mtime is the break's.
    const tomb = this.path(`${LEFTOVER}broken-${stale.ino}-${Math.floor(stale.mtimeMs)}`);
    touch(lockDir);
    try {
      renameSync(lockDir, tomb);
      return true;
    } catch (err) {
      const code = errCode(err);
      if (code === "ENOENT") return true;
      if (code === "ENOTEMPTY" || code === "EEXIST") return false; // another waiter broke it
      throw err;
    }
  }

  /** Give the lock up – only this run's own: one broken while this run stalled past the stale
   *  age is another run's by now. Renamed away first, so no waiter sees it half removed. */
  private release(lockDir: string, ownerFile: string, token: string): void {
    try {
      if ((JSON.parse(readFileSync(ownerFile, "utf8")) as { token?: unknown }).token !== token) return;
    } catch {
      return;
    }
    const gone = this.path(`${LEFTOVER}released-${token}`);
    try {
      renameSync(lockDir, gone);
    } catch {
      return; // gone already, or it cannot move: without refreshes it goes stale
    }
    try {
      rmSync(gone, { recursive: true, force: true });
    } catch {
      // a leftover: the next holder sweeps it
    }
  }

  /** Remove what earlier locks left beside `sync.lock/` once it is older than the stale age:
   *  no waiter can still act on having judged that lock stale. Silent; the next holder retries. */
  private sweepLeftovers(staleMs: number): void {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(LEFTOVER)) continue;
      const p = this.path(name);
      try {
        if (Date.now() - lstatSync(p).mtimeMs > staleMs) rmSync(p, { recursive: true, force: true });
      } catch {
        // swept by another run first, or it cannot go yet
      }
    }
  }
}

/** Try to take `sync.lock/`: mkdir, then create the owner record exclusively. A run whose dir
 *  was broken as owner-less before it wrote the record loses to whichever run creates one
 *  first (EEXIST), or finds the dir gone (ENOENT). */
function acquire(lockDir: string, ownerFile: string, token: string, refreshMs: number, afterMkdir?: () => void): boolean {
  try {
    mkdirSync(lockDir); // atomic: fails if it exists
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw err;
  }
  afterMkdir?.();
  const record = { pid: process.pid, host: hostname(), token, at: Date.now(), refreshMs };
  try {
    writeFileSync(ownerFile, JSON.stringify(record), { flag: "wx" });
  } catch (err) {
    const code = errCode(err);
    if (code === "EEXIST" || code === "ENOENT") return false;
    try {
      rmSync(ownerFile, { force: true });
      rmdirSync(lockDir);
    } catch {
      // not ours to clear any more
    }
    throw err;
  }
  touch(ownerFile);
  return true;
}

/** Is the lock stale? What the waiter saw of it when it is, else undefined. */
function judge(lockDir: string, ownerFile: string, staleMs: number, graceMs: number): StaleLock | undefined {
  let owner: Stats;
  try {
    owner = statSync(ownerFile);
  } catch {
    let dir: Stats;
    try {
      dir = statSync(lockDir);
    } catch {
      return undefined; // released meanwhile: the next attempt takes it
    }
    if (Date.now() - dir.mtimeMs <= graceMs) return undefined;
    return { ownerless: true, ino: dir.ino, mtimeMs: dir.mtimeMs };
  }
  const age = Date.now() - owner.mtimeMs;
  if (age <= staleMs && !deadOwner(ownerFile, age)) return undefined;
  return { ownerless: false, ino: owner.ino, mtimeMs: owner.mtimeMs };
}

/** Did the lock's owner die? Only for a record of this host whose pid is gone and that missed
 *  two of its own refreshes: a live holder in another pid namespace keeps refreshing. */
function deadOwner(ownerFile: string, age: number): boolean {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(ownerFile, "utf8"));
  } catch {
    return false;
  }
  if (record === null || typeof record !== "object") return false;
  const { pid, host, refreshMs } = record as Record<string, unknown>;
  if (host !== hostname() || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof refreshMs !== "number" || !(refreshMs > 0) || age <= 2 * refreshMs) return false;
  try {
    process.kill(pid, 0); // signal 0 sends nothing: it only asks whether the pid exists
    return false;
  } catch (err) {
    return errCode(err) === "ESRCH"; // EPERM: alive, another user's
  }
}

/** Stamp `path` with this run's clock (a network file system would stamp the server's). */
function touch(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // gone: released, or broken while this run stalled
  }
}
