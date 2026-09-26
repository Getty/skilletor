// Managed .gitignore blocks and per-skill .gitignore files (spec §6.4, §14.3).
//
// The ignore rules are fixed, so a committed .gitignore does not change with the
// installed items: every installed skill directory carries its own `.gitignore`
// (`SKILL_GITIGNORE`, an ordinary managed file of the item), and agents and rules are
// installed as `.local.<name>` files that fixed patterns cover. A target root's
// `.gitignore` holds one marked block with fixed entries only; the engine decides
// which root gets which entries. Content outside the block is untouched; the block is
// rewritten idempotently (no change → no write). A block with no entries, or with
// gitignore disabled, is removed, and the file is deleted if only the block remained.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

const BEGIN = "# >>> skilletor >>>";
const END = "# <<< skilletor <<<";

/** The `.gitignore` written into every installed skill directory: ignores the directory,
 *  itself included (spec §6.4). */
export const SKILL_GITIGNORE = '# installed by skilletor, not committed ("gitignore": false in skilletor.json to commit)\n*\n';

/** Block entries of a project's `.claude/.gitignore` (spec §6.4). */
export const PROJECT_CLAUDE_ENTRIES = ["skilletor.lock.json", "skilletor.local.json", "agents/**/.local.*", "rules/**/.local.*"];

/** Agent and rule patterns of a user's `~/.claude/.gitignore`; the lock and the state dir join them. */
export const LOCAL_ENTRIES = ["agents/**/.local.*", "rules/**/.local.*"];

/** Block entries of a Codex root (`<project>/.codex`, `$CODEX_HOME`) holding managed agents or the rules file. */
export const CODEX_ENTRIES = ["agents/**/.local.*", "skilletor-rules.md"];

export interface GitignoreOptions {
  /** The directory whose `.gitignore` holds the block (a target root of either scope). */
  dir: string;
  /** The block's entries, relative to `dir`; none removes the block. */
  entries: string[];
  /** From config and, in the user scope, the work-tree test; false removes the block. */
  enabled: boolean;
}

/** What happened to the block. `created` and `changed` ask for a commit (spec §6.4). */
export type BlockChange = "created" | "changed" | "removed" | "unchanged";

export function updateGitignore(opts: GitignoreOptions): BlockChange {
  const path = join(opts.dir, ".gitignore");
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];

  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  const hasBlock = begin !== -1 && end !== -1 && end > begin;
  const outside = hasBlock ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;

  const entries = [...new Set(opts.entries)].sort();
  const write = opts.enabled && entries.length > 0;
  let out: string[];
  let change: BlockChange;
  if (write) {
    const block = [BEGIN, ...entries, END];
    if (hasBlock) {
      out = [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)];
      change = lines.slice(begin + 1, end).join("\n") === entries.join("\n") ? "unchanged" : "changed";
    } else {
      const trimmed = trimTrailingEmpty(outside);
      out = trimmed.length ? [...trimmed, "", ...block] : [...block];
      change = "created";
    }
  } else {
    out = trimTrailingEmpty(outside);
    change = hasBlock ? "removed" : "unchanged";
  }

  const result = out.length && out.some((l) => l.trim() !== "") ? out.join("\n").replace(/\n*$/, "") + "\n" : "";

  if (result === "") {
    if (existed) rmSync(path, { force: true });
    return change;
  }
  if (result !== existing) atomicWrite(path, result);
  return change;
}

/** Where skilletor's `.gitignore` of the skill `name` goes, relative to the skills' root. */
export function skillGitignorePath(name: string): string {
  return join("skills", name, ".gitignore");
}

/** `output` of a skill named `name` with skilletor's `.gitignore` at the skill's root,
 *  replacing one the source ships there (spec §6.4). */
export function withSkillGitignore(output: Map<string, Buffer>, name: string): Map<string, Buffer> {
  const out = new Map(output);
  out.set(skillGitignorePath(name), Buffer.from(SKILL_GITIGNORE, "utf8"));
  return out;
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
