// Codex rules on disk (spec §14.8): the rules file skilletor owns, the pointer
// block in a Codex AGENTS.md, and read-only checks of Codex's config.toml.
//
// The rules file (`skilletor-rules.md`) holds one section per rule under a
// header line; the hook injects it at session start. AGENTS.md carries only one
// managed block between `<!-- skilletor:begin -->` and `<!-- skilletor:end -->`
// that points to the file. Content outside the markers is never modified.
// Malformed markers, and files skilletor must not write through (symlink,
// directory, unreadable), are refused — never repaired.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BEGIN = "<!-- skilletor:begin -->";
export const END = "<!-- skilletor:end -->";
export const NOTE = "<!-- managed by skilletor — edits inside are overwritten -->";
/** The rules file's name, in `$CODEX_HOME` (user) or `<repo>/.codex` (project). */
export const RULES_FILE = "skilletor-rules.md";
/** How the rules file, and so the injected message, begins. */
export const RULES_MARKER = "<!-- skilletor:rules";
const RULES_NOTE = "<!-- managed by skilletor — edits are overwritten; change the rule in its source -->";
const RULE_RE = /^<!-- skilletor:rule (\S+) source=(.*) -->$/;
/** Any skilletor marker line; a rule body must not contain one. */
export const MARKER_LINE = /^<!-- skilletor:(begin|end|rules?)\b/;

export class BlockError extends Error {
  override name = "BlockError";
}

export interface Section {
  name: string;
  source: string;
  /** Normalized section text (see `normalizeSection`). */
  text: string;
}

export type Sections = Map<string, { source: string; text: string }>;

export interface ParsedBlock {
  /** Line indices of the begin and end markers. */
  begin: number;
  end: number;
  /** Rule sections inside the block: only the first design (#41) wrote any; read for migration. */
  sections: Sections;
}

/** Leading blank lines and trailing whitespace dropped, one final newline. */
export function normalizeSection(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "") + "\n";
}

/** The rule sections among `lines`, each running to the next rule marker. */
function parseSections(lines: string[]): Sections {
  const sections: Sections = new Map();
  let current: { name: string; source: string; lines: string[] } | undefined;
  const flush = () => {
    if (current) sections.set(current.name, { source: current.source, text: normalizeSection(current.lines.join("\n")) });
  };
  for (const line of lines) {
    const m = RULE_RE.exec(line.trim());
    if (m) {
      flush();
      current = { name: m[1]!, source: m[2]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

// ---- the rules file ---------------------------------------------------------------

/** The rules file for a scope, sections in the given order; null when there are none. */
export function rulesFileText(scope: "user" | "project", sections: Section[]): string | null {
  if (sections.length === 0) return null;
  const out = [`${RULES_MARKER} scope=${scope} -->`, RULES_NOTE, ""];
  for (const s of sections) {
    out.push(`<!-- skilletor:rule ${s.name} source=${s.source} -->`, ...s.text.replace(/\n$/, "").split("\n"), "");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** The sections of a rules file (whatever its header says). */
export function parseRulesFile(text: string): Sections {
  return parseSections(text.split("\n"));
}

// ---- the pointer block in AGENTS.md ---------------------------------------------------

/** The lines inside the pointer block; `file` is shown as given (relative or absolute). */
export function pointerLines(scope: "user" | "project", file: string): string[] {
  return [
    NOTE,
    `Additional rules for ${scope === "user" ? "all projects" : "this project"} are managed by skilletor. They are normally provided at`,
    `session start as a developer message beginning with \`${RULES_MARKER}\`. If that message`,
    "is not in your context (for example after context compaction), read",
    `\`${file}\` before you start a task, and follow it.`,
  ];
}

/** Find the block; null if there is none; BlockError if the markers are malformed. */
export function parseBlock(text: string): ParsedBlock | null {
  const lines = text.split("\n");
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t === BEGIN) begins.push(i);
    else if (t === END) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length > 1) throw new BlockError(`"${BEGIN}" appears ${begins.length} times`);
  if (ends.length > 1) throw new BlockError(`"${END}" appears ${ends.length} times`);
  if (begins.length === 0) throw new BlockError(`"${END}" without "${BEGIN}"`);
  if (ends.length === 0) throw new BlockError(`"${BEGIN}" without "${END}"`);
  const begin = begins[0]!;
  const end = ends[0]!;
  if (end < begin) throw new BlockError(`"${END}" before "${BEGIN}"`);
  return { begin, end, sections: parseSections(lines.slice(begin + 1, end)) };
}

/**
 * The file content with the block holding `body` (the lines between the markers),
 * or with no block when `body` is null; null when the file should not exist
 * (no block, and nothing but whitespace outside it). `text` null = no file.
 */
export function withBlock(text: string | null, body: string[] | null): string | null {
  const block = body ? [BEGIN, ...body, END] : null;
  if (text === null) return block ? block.join("\n") + "\n" : null;
  const parsed = parseBlock(text);
  const lines = text.split("\n");
  let out: string;
  if (parsed) {
    const before = lines.slice(0, parsed.begin);
    const after = lines.slice(parsed.end + 1);
    out = [...before, ...(block ?? []), ...after].join("\n");
    // A block that was the last content leaves no blank lines of ours behind.
    if (!block && after.every((l) => l.trim() === "")) out = out.replace(/\s*$/, "\n");
  } else {
    if (!block) return text;
    const base = text.replace(/\s*$/, "");
    out = (base.length ? base + "\n\n" : "") + block.join("\n") + "\n";
  }
  return out.trim() === "" ? null : out;
}

export type Inspection =
  | { ok: true; text: string | null; parsed: ParsedBlock | null }
  | { ok: false; reason: string };

/** May skilletor maintain a block in this file? Never throws. */
export function inspectAgentsMd(path: string): Inspection {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, text: null, parsed: null };
    return { ok: false, reason: `unreadable (${(err as Error).message})` };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "is a symlink (skilletor does not write through it)" };
  if (st.isDirectory()) return { ok: false, reason: "is a directory" };
  if (!st.isFile()) return { ok: false, reason: "is not a regular file" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `unreadable (${(err as Error).message})` };
  }
  try {
    return { ok: true, text, parsed: parseBlock(text) };
  } catch (err) {
    return { ok: false, reason: `malformed skilletor markers: ${(err as Error).message}` };
  }
}

// ---- Codex config.toml (read-only, line based: no TOML dependency at runtime) ----------

function readConfigToml(codexHome: string): string | undefined {
  try {
    return readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
}

/** Codex's `project_doc_max_bytes`: a top-level key in `<codexHome>/config.toml`, default 32768. */
export function projectDocLimit(codexHome: string): number {
  const text = readConfigToml(codexHome);
  if (text === undefined) return 32768;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break; // a table header: no longer top level
    const m = /^\s*project_doc_max_bytes\s*=\s*(\d+)\s*(?:#.*)?$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 32768;
}

/** A hooks.state key of skilletor's SessionStart handler, in any marketplace. */
const isSessionStartKey = (key: string) => key.startsWith("skilletor@") && key.includes(":session_start:");
const QUOTED_KEY = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;
const TRUSTED_HASH = /^\s*trusted_hash\s*=\s*["']/;

/**
 * Has the user trusted skilletor's Codex SessionStart hook (spec §14.8)? True when
 * `<codexHome>/config.toml` has a `trusted_hash` for a `hooks.state` key starting
 * with `skilletor@` and containing `:session_start:` – as a `[hooks.state."<key>"]`
 * table, or as a dotted or inline key under `[hooks.state]`. Whether the hash is
 * current is not checked. Never throws.
 */
export function codexHookTrusted(codexHome: string): boolean {
  const text = readConfigToml(codexHome);
  if (text === undefined) return false;
  let table: "hook" | "state" | "other" = "other";
  for (const line of text.split("\n")) {
    const header = /^\s*\[\s*([^\[\]]*?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      const name = header[1]!;
      const m = /^hooks\s*\.\s*state\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(name);
      if (m) table = isSessionStartKey(m[1] ?? m[2]!) ? "hook" : "other";
      else table = /^hooks\s*\.\s*state$/.test(name) ? "state" : "other";
      continue;
    }
    if (table === "hook" && TRUSTED_HASH.test(line)) return true;
    if (table === "state") {
      const k = QUOTED_KEY.exec(line);
      if (k && isSessionStartKey(k[1] ?? k[2]!) && /\btrusted_hash\s*=\s*["']/.test(line.slice(k[0].length))) return true;
    }
  }
  return false;
}
