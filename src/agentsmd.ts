// The managed skilletor block in a Codex AGENTS.md (spec §14.8).
//
// One block per file, between `<!-- skilletor:begin -->` and
// `<!-- skilletor:end -->`, holding one section per rule. Content outside the
// markers is never modified. Malformed markers, and files skilletor must not
// write through (symlink, directory, unreadable), are refused — never repaired.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BEGIN = "<!-- skilletor:begin -->";
export const END = "<!-- skilletor:end -->";
export const NOTE = "<!-- managed by skilletor — edits inside are overwritten -->";
const RULE_RE = /^<!-- skilletor:rule (\S+) source=(.*) -->$/;
/** Any skilletor marker line; a rule body must not contain one. */
export const MARKER_LINE = /^<!-- skilletor:(begin|end|rule)\b/;

export class BlockError extends Error {
  override name = "BlockError";
}

export interface Section {
  name: string;
  source: string;
  /** Normalized section text (see `normalizeSection`). */
  text: string;
}

export interface ParsedBlock {
  /** Line indices of the begin and end markers. */
  begin: number;
  end: number;
  sections: Map<string, { source: string; text: string }>;
}

/** Leading blank lines and trailing whitespace dropped, one final newline. */
export function normalizeSection(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "") + "\n";
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

  const sections = new Map<string, { source: string; text: string }>();
  let current: { name: string; source: string; lines: string[] } | undefined;
  const flush = () => {
    if (current) sections.set(current.name, { source: current.source, text: normalizeSection(current.lines.join("\n")) });
  };
  for (const line of lines.slice(begin + 1, end)) {
    const m = RULE_RE.exec(line.trim());
    if (m) {
      flush();
      current = { name: m[1]!, source: m[2]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return { begin, end, sections };
}

function blockLines(sections: Section[]): string[] {
  const out = [BEGIN, NOTE, ""];
  for (const s of sections) {
    out.push(`<!-- skilletor:rule ${s.name} source=${s.source} -->`, ...s.text.replace(/\n$/, "").split("\n"), "");
  }
  out.push(END);
  return out;
}

/**
 * The file content with the block set to `sections` (in the given order), or
 * null when the file should not exist (no sections, and nothing but whitespace
 * outside the block). `text` null = the file does not exist.
 */
export function withBlock(text: string | null, sections: Section[]): string | null {
  const block = sections.length ? blockLines(sections) : null;
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

/** Codex's `project_doc_max_bytes`: a top-level key in `<codexHome>/config.toml`, default 32768. */
export function projectDocLimit(codexHome: string): number {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return 32768;
  }
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break; // a table header: no longer top level
    const m = /^\s*project_doc_max_bytes\s*=\s*(\d+)\s*(?:#.*)?$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 32768;
}
