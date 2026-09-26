// Instance state under ~/.claude/skilletor/ (spec §4.3, §6.5). The root is
// injectable. Nothing here uses CLAUDE_PLUGIN_DATA, so the CLI runs identically
// without Claude Code.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export interface WithLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  async withLock<T>(fn: () => Promise<T> | T, opts: WithLockOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const staleMs = opts.staleMs ?? 300_000;
    const pollMs = opts.pollMs ?? 25;
    const lockDir = this.path("sync.lock");
    const ownerFile = join(lockDir, "owner.json");
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        mkdirSync(lockDir); // atomic: fails if it already exists
        writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (this.isStale(ownerFile, staleMs)) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring sync lock at ${lockDir}`);
        }
        await delay(pollMs);
      }
    }

    try {
      return await fn();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  private isStale(ownerFile: string, staleMs: number): boolean {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { at?: unknown };
      if (typeof owner.at !== "number") return true;
      return Date.now() - owner.at > staleMs;
    } catch {
      // No owner file (crashed between mkdir and write) or unreadable -> stale.
      return existsSync(ownerFile) ? false : true;
    }
  }
}
