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
// The project root's `.worktreeinclude` gets a block of the same form (k124), listing what
// Claude Code copies into a new worktree; the engine decides its entries.
// `gitTracked` answers which managed paths git still tracks, for the report's warning. Both
// questions are about the repository git finds from the directory, never one an exported GIT_DIR
// names (k91).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { atomicWrite } from "./fsutil.ts";
import { gitEnv } from "./gitenv.ts";

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
  /** The directory whose `.gitignore` holds the block (a target root of either scope), or
   *  the project root for `.worktreeinclude`. */
  dir: string;
  /** The block's entries, relative to `dir`; none removes the block. */
  entries: string[];
  /** From config and, in the user scope, the work-tree test; false removes the block. */
  enabled: boolean;
}

/** What happened to the block. `created` and `changed` ask for a commit (spec §6.4). */
export type BlockChange = "created" | "changed" | "removed" | "unchanged";

export function updateGitignore(opts: GitignoreOptions): BlockChange {
  return updateBlockFile(join(opts.dir, ".gitignore"), opts);
}

/** The file at a project root whose gitignored matches Claude Code copies into every worktree
 *  it creates with git (spec §6.4, k124); its block is written like a `.gitignore`'s. */
export const WORKTREE_INCLUDE = ".worktreeinclude";

/** The block of `<dir>/.worktreeinclude` (`dir`: the project root), by `updateGitignore`'s rules. */
export function updateWorktreeInclude(opts: GitignoreOptions): BlockChange {
  return updateBlockFile(join(opts.dir, WORKTREE_INCLUDE), opts);
}

/** A text line with its exact byte-preserving bounds and line ending. */
interface TextLine {
  text: string;
  start: number;
  end: number;
  eol: string;
}

/** Lines without their CRLF/LF endings, while retaining the offsets needed for surgical edits. */
function textLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), start, end: text.length, eol: "" });
      break;
    }
    const contentEnd = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ text: text.slice(start, contentEnd), start, end: newline + 1, eol: text.slice(contentEnd, newline + 1) });
    start = newline + 1;
  }
  return lines;
}

/** The entries of the skilletor block in the file at `path`; none for a missing or unreadable
 *  file, or one without a block (the `check` test, spec §6.4). */
export function blockEntries(path: string): string[] {
  try {
    const lines = textLines(readFileSync(path, "utf8"));
    const { begin, end, hasBlock } = blockOf(lines);
    return hasBlock ? lines.slice(begin + 1, end).map((line) => line.text) : [];
  } catch {
    return [];
  }
}

function updateBlockFile(path: string, opts: GitignoreOptions): BlockChange {
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";
  const lines = textLines(existing);
  const block = blockOf(lines);
  const entries = [...new Set(opts.entries)].sort();
  const write = opts.enabled && entries.length > 0;
  let result = existing;
  let change: BlockChange;

  if (block.hasBlock) {
    const current = lines.slice(block.begin + 1, block.end).map((line) => line.text);
    if (write && current.length === entries.length && current.every((entry, i) => entry === entries[i])) {
      return "unchanged";
    }
    const first = lines[block.begin]!;
    const last = lines[block.end]!;
    if (write) {
      const newline = first.eol || last.eol || lines.find((line) => line.eol)?.eol || "\n";
      const replacement = [BEGIN, ...entries, END].join(newline) + last.eol;
      result = existing.slice(0, first.start) + replacement + existing.slice(last.end);
      change = "changed";
    } else {
      const before = existing.slice(0, first.start);
      const after = existing.slice(last.end);
      result = before + after;
      change = "removed";
    }
  } else if (write) {
    const newline = lines.find((line) => line.eol)?.eol || "\n";
    let separator = "";
    if (existing.length > 0) {
      separator = existing.endsWith(newline + newline) ? "" : existing.endsWith(newline) ? newline : newline + newline;
    }
    result = existing + separator + [BEGIN, ...entries, END].join(newline) + newline;
    change = "created";
  } else {
    return "unchanged";
  }

  if (result === "") {
    if (existed) rmSync(path, { force: true });
    return change;
  }
  if (result !== existing) atomicWrite(path, result);
  return change;
}

/** The block's marker lines in a `.gitignore`'s lines; a block needs both, in order. */
function blockOf(lines: TextLine[]): { begin: number; end: number; hasBlock: boolean } {
  const begin = lines.findIndex((line) => line.text === BEGIN);
  const end = lines.findIndex((line) => line.text === END);
  return { begin, end, hasBlock: begin !== -1 && end !== -1 && end > begin };
}

/** Does `<dir>/.gitignore` hold a skilletor block – one `updateGitignore` would find?
 *  One read; a missing or unreadable file holds none (spec §14.3, the `check` test). */
export function hasBlock(dir: string): boolean {
  try {
    return blockOf(textLines(readFileSync(join(dir, ".gitignore"), "utf8"))).hasBlock;
  } catch {
    return false;
  }
}

/** Where skilletor's `.gitignore` of the skill `name` goes, relative to the skills' root. */
export function skillGitignorePath(name: string): string {
  return posix.join("skills", name, ".gitignore");
}

/** `output` of a skill named `name` with skilletor's `.gitignore` at the skill's root,
 *  replacing one the source ships there (spec §6.4). */
export function withSkillGitignore(output: Map<string, Buffer>, name: string): Map<string, Buffer> {
  const out = new Map(output);
  out.set(skillGitignorePath(name), Buffer.from(SKILL_GITIGNORE, "utf8"));
  return out;
}

/** Paths per `git ls-files` call: keeps the command line short however much one sync wrote. */
const LS_FILES_BATCH = 500;

/**
 * The ones among `paths` (relative to `dir`) that git tracks (spec §6.4, "Tracked managed
 * files"): one `git ls-files` (per 500 paths), pathspecs taken literally. Outside a work
 * tree, or when git is missing or fails, none.
 */
export function gitTracked(dir: string, paths: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < paths.length; i += LS_FILES_BATCH) {
    try {
      const listed = execFileSync(
        "git", ["-C", dir, "--literal-pathspecs", "ls-files", "-z", "--", ...paths.slice(i, i + LS_FILES_BATCH)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, env: gitEnv() },
      );
      out.push(...listed.split("\0").filter(Boolean));
    } catch {
      return [];
    }
  }
  return out;
}

/** Does `dir` lie inside a git work tree? Git missing or failing counts as no (spec §6.4). */
export function isGitWorkTree(dir: string): boolean {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env: gitEnv(),
    }).trim() === "true";
  } catch {
    return false;
  }
}
