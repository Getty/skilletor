// Managed .gitignore blocks (spec §6.4, §14.3).
//
// Maintains a single marked block in a target root's `.gitignore` listing the
// exact managed paths under that root plus fixed entries. Project scope: the
// block in <project>/.claude/.gitignore also lists the lock and
// skilletor.local.json; <project>/.agents and <project>/.codex get managed paths
// only; written whether or not the project is a git repository. User scope
// (~/.claude, ~/.agents, $CODEX_HOME): a block only while that root lies inside a
// git work tree (`isGitWorkTree`); the ~/.claude block lists the lock and the
// state dir, never skilletor.json. A block with no entries is removed. Content
// outside the block is untouched; the block is rewritten idempotently (no change
// → no write). With gitignore disabled the block is removed, and the file is
// deleted if only the block remained.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

const BEGIN = "# >>> skilletor >>>";
const END = "# <<< skilletor <<<";

export interface GitignoreOptions {
  /** The directory whose `.gitignore` holds the block (a target root of either scope). */
  dir: string;
  /** Managed paths relative to `dir` (from the lock). */
  managedPaths: string[];
  /** Always-listed entries (default: the lock and skilletor.local.json of a project's `.claude`). */
  fixed?: string[];
  /** From config; default true. */
  enabled: boolean;
}

export function updateGitignore(opts: GitignoreOptions): void {
  const path = join(opts.dir, ".gitignore");
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];

  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  const hasBlock = begin !== -1 && end !== -1 && end > begin;
  const outside = hasBlock ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;

  const entries = blockEntries(opts.managedPaths, opts.fixed ?? ["skilletor.lock.json", "skilletor.local.json"]);
  let out: string[];
  if (opts.enabled && entries.length > 0) {
    const block = [BEGIN, ...entries, END];
    if (hasBlock) {
      out = [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)];
    } else {
      const trimmed = trimTrailingEmpty(outside);
      out = trimmed.length ? [...trimmed, "", ...block] : [...block];
    }
  } else {
    out = trimTrailingEmpty(outside);
  }

  const result = out.length && out.some((l) => l.trim() !== "") ? out.join("\n").replace(/\n*$/, "") + "\n" : "";

  if (result === "") {
    if (existed) rmSync(path, { force: true });
    return;
  }
  if (result !== existing) atomicWrite(path, result);
}

function blockEntries(managedPaths: string[], fixed: string[]): string[] {
  const set = new Set([...managedPaths, ...fixed]);
  return [...set].sort();
}

function trimTrailingEmpty(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/** Does `dir` lie inside a git work tree? Git missing or failing counts as no (spec §6.4). */
export function isGitWorkTree(dir: string): boolean {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim() === "true";
  } catch {
    return false;
  }
}
