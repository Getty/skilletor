// Skills check for installed agents (spec §6.7): an agent declares the skills Claude
// Code preloads for it in its top-level `skills:` frontmatter; Claude Code skips a name
// it cannot find without a word. This reads the installed agent file (never renders) and
// names the bare skill names that no root Claude Code's lookup searches holds. Only
// Claude agents are checked: the Codex role file carries no skills. Read-only; a file it
// cannot parse yields nothing – the conversion or render warning already covers it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "./config.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { claudeConfigDirOf } from "./fsutil.ts";

export interface SkillRoots {
  home: string;
  /** The Claude config dir (k145); unset means `<home>/.claude`. */
  claudeConfigDir?: string;
  /** The project root, for a project-scope agent. */
  projectDir?: string;
}

export interface SkillsMissing {
  /** The agent's lock key. */
  key: string;
  harness: Harness;
  missing: string[];
}

/** The skills an installed agent file declares; undefined when it cannot be read. */
export function declaredSkills(text: string): string[] | undefined {
  let data: ReturnType<typeof splitFrontmatter>["data"];
  try {
    data = splitFrontmatter(text).data;
  } catch {
    return undefined;
  }
  const skills = data.skills;
  return Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

/** The skill roots Claude Code searches for an agent of this scope. */
export function skillRoots(scope: "user" | "project", r: SkillRoots): string[] {
  const project = scope === "project" && r.projectDir ? r.projectDir : undefined;
  const claudeDir = claudeConfigDirOf(r.home, r.claudeConfigDir);
  const user = join(claudeDir, "skills");
  return [...(project ? [join(project, ".claude", "skills")] : []), user, ...pluginCacheRoots(claudeDir)];
}

/** `<claude config dir>/plugins/cache/*\/skills` and `…/cache/*\/*\/skills`, as far as they exist. */
function pluginCacheRoots(claudeDir: string): string[] {
  const cache = join(claudeDir, "plugins", "cache");
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
export function missingSkills(file: string, roots: string[]): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const declared = declaredSkills(text);
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
export function skillsWarning(name: string, harness: Harness, missing: string[]): string {
  return `agent ${name} (${harness}): skills not installed: ${missing.join(", ")} — ` +
    "install them, or ship the agent and its skills together as a bundle";
}
