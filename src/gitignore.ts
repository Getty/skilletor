// Managed .gitignore block in a project (spec §6.4).
//
// Maintains a single marked block in <project>/.claude/.gitignore listing the
// exact managed paths plus the lock and skilletor.local.json. Content outside
// the block is untouched; the block is rewritten idempotently (no change → no
// write). With gitignore disabled the block is removed, and the file is deleted
// if only the block remained. Project scope only.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

const BEGIN = "# >>> skilletor >>>";
const END = "# <<< skilletor <<<";

export interface GitignoreOptions {
  /** The project's `.claude` directory. */
  claudeDir: string;
  /** Install-relative managed paths (from the lock). */
  managedPaths: string[];
  /** From config; default true. */
  enabled: boolean;
}

export function updateGitignore(opts: GitignoreOptions): void {
  const path = join(opts.claudeDir, ".gitignore");
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];

  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  const hasBlock = begin !== -1 && end !== -1 && end > begin;
  const outside = hasBlock ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;

  let out: string[];
  if (opts.enabled) {
    const block = [BEGIN, ...blockEntries(opts.managedPaths), END];
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

function blockEntries(managedPaths: string[]): string[] {
  const set = new Set([...managedPaths, "skilletor.lock.json", "skilletor.local.json"]);
  return [...set].sort();
}

function trimTrailingEmpty(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}
