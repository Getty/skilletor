// Briefing check for installed agents (spec §6.7): an agent may declare skills for
// the briefing plugin; one installed without them fails at spawn time. This reads
// the installed agent file (never renders) and names the bare skill names that no
// root the harness's briefing lookup searches holds. Read-only; a file it cannot
// parse yields nothing – the conversion or render warning already covers it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "./config.ts";
import { splitFrontmatter } from "./frontmatter.ts";

export interface BriefingRoots {
  home: string;
  /** `$CODEX_HOME`; unset means `<home>/.codex`. */
  codexHome?: string;
  /** The project root, for a project-scope agent. */
  projectDir?: string;
}

export interface BriefingMissing {
  /** The agent's lock key. */
  key: string;
  harness: Harness;
  missing: string[];
}

/** briefing's own matcher for the Codex comment line (spec §14.7). */
const COMMENT = /^[ \t]*#[ \t]*briefing:[ \t]*skills[ \t]*=[ \t]*\[([^\]\r\n]*)\]/;

/** The skills an installed agent file declares; undefined when it cannot be read. */
export function declaredSkills(harness: Harness, text: string): string[] | undefined {
  if (harness === "codex") {
    // Every line before developer_instructions is a single-line key or a comment:
    // skilletor writes the briefing line there, never inside the multi-line string.
    for (const line of text.split("\n")) {
      if (/^developer_instructions[ \t]*=/.test(line)) break;
      const m = COMMENT.exec(line);
      if (m) return [...m[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]!);
    }
    return [];
  }
  let data: ReturnType<typeof splitFrontmatter>["data"];
  try {
    data = splitFrontmatter(text).data;
  } catch {
    return undefined;
  }
  const briefing = data.briefing;
  if (briefing === null || typeof briefing !== "object" || Array.isArray(briefing)) return [];
  const skills = (briefing as Record<string, unknown>).skills;
  return Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

/** The skill roots the harness's briefing lookup searches for an agent of this scope. */
export function skillRoots(harness: Harness, scope: "user" | "project", r: BriefingRoots): string[] {
  const project = scope === "project" && r.projectDir ? r.projectDir : undefined;
  if (harness === "codex") {
    const codexHome = r.codexHome || join(r.home, ".codex");
    const user = [join(codexHome, "skills"), join(r.home, ".agents", "skills")];
    return project ? [join(project, ".agents", "skills"), join(project, ".codex", "skills"), ...user] : user;
  }
  const user = join(r.home, ".claude", "skills");
  return [...(project ? [join(project, ".claude", "skills")] : []), user, ...pluginCacheRoots(r.home)];
}

/** `~/.claude/plugins/cache/*\/skills` and `…/cache/*\/*\/skills`, as far as they exist. */
function pluginCacheRoots(home: string): string[] {
  const cache = join(home, ".claude", "plugins", "cache");
  const out: string[] = [];
  for (const a of subdirs(cache)) {
    out.push(join(cache, a, "skills"));
    for (const b of subdirs(join(cache, a))) out.push(join(cache, a, b, "skills"));
  }
  return out;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/**
 * Bare declared skill names of the agent file that resolve in none of `roots`
 * (`<root>/<name>/SKILL.md`); `plugin:skill` names are not checked. Undefined
 * when the file cannot be read or parsed.
 */
export function missingSkills(harness: Harness, file: string, roots: string[]): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const declared = declaredSkills(harness, text);
  if (declared === undefined) return undefined;
  const missing: string[] = [];
  for (const name of declared) {
    if (name.includes(":") || missing.includes(name)) continue;
    // A name that is not one path segment resolves nowhere (and is never probed).
    const segment = !/[\\/]/.test(name) && name !== "." && name !== "..";
    if (!segment || !roots.some((root) => existsSync(join(root, name, "SKILL.md")))) missing.push(name);
  }
  return missing;
}

/** The report line for one agent and target (spec §6.7). */
export function briefingWarning(name: string, harness: Harness, missing: string[]): string {
  return `agent ${name} (${harness}): briefing skills not installed: ${missing.join(", ")} — ` +
    "install them, or ship the agent and its skills together as a bundle";
}
