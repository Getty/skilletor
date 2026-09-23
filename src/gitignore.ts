// Managed .gitignore block in a project (spec §6.4).
//
// Maintains a single marked block in <project>/.claude/.gitignore listing the
// exact managed paths plus the lock and skilletor.local.json, and the same kind
// of block (managed paths only) in <project>/.agents/.gitignore for Codex
// (spec §14.3). A block with no entries is removed. Content outside
// the block is untouched; the block is rewritten idempotently (no change → no
// write). With gitignore disabled the block is removed, and the file is deleted
// if only the block remained. Project scope only.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

const BEGIN = "# >>> skilletor >>>";
const END = "# <<< skilletor <<<";

export interface GitignoreOptions {
  /** The directory whose `.gitignore` holds the block (a project's `.claude` or `.agents`). */
  dir: string;
  /** Managed paths relative to `dir` (from the lock). */
  managedPaths: string[];
  /** Always-listed entries (default: the lock and skilletor.local.json, which live in `.claude`). */
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
