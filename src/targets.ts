// Harness targets (spec §14): which agent harnesses skilletor installs for,
// where each harness reads each item type, and how a lock key names its target.
//
// Detection looks only at markers the harness itself creates (never at
// `~/.claude/` alone: skilletor's own config lives there); Hermes is never detected, it
// is a target only when `targets` names it (spec §16.2). The layout table is
// the seam later phases extend (Codex agents as TOML, rules in a rules file;
// Hermes Agent, spec §16: skills only).
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { HARNESSES, type Harness, type ItemType } from "./config.ts";
import { SKILL_GITIGNORE } from "./gitignore.ts";
import type { Lock } from "./lock.ts";

export type { Harness } from "./config.ts";

export class TargetError extends Error {
  override name = "TargetError";
}

/** Where a scope's roots live: its base (`~` or the project root), and the Codex and Hermes homes. */
export interface RootContext {
  base: string;
  scope: "user" | "project";
  /** Claude Code's config dir (k145; only the user scope uses it); unset or empty means `<home>/.claude`. */
  claudeDir?: string;
  /** `$CODEX_HOME`; unset or empty means `<home>/.codex` (only the user scope uses it). */
  codexHome?: string;
  /** The Hermes home (spec §16.2); unset or empty means Hermes' default for `<home>`
   *  (`defaultHermesHome`; only the user scope uses it). */
  hermesHome?: string;
}

export interface TargetLayout {
  harness: Harness;
  /** Lock-key prefix; "" keeps claude keys exactly as they were before targets. */
  keyPrefix: string;
  /** Per supported item type: the root directory for a scope. Lock file paths are
   *  relative to it. A type missing here is not written for this harness. */
  roots: Partial<Record<ItemType, (r: RootContext) => string>>;
  /** Types whose items are sections of one skilletor-owned file,
   *  `<root>/skilletor-rules.md`, rather than files of their own (spec §14.8). */
  blockTypes?: readonly ItemType[];
  /** Types whose files install as `.local.<file>` (spec §6.3, §6.4): the fixed ignore
   *  pattern `agents/**\/.local.*` covers them, and the plain name stays claimed. */
  localTypes?: readonly ItemType[];
  /** Types this harness also reads from another harness's project root (spec §16.2): while
   *  that harness is an active target of a project scope, this one gets no copy of its own
   *  there – the harness refuses a name it finds in both roots. */
  projectVia?: Partial<Record<ItemType, Harness>>;
  /** No root of this harness ever holds a skilletor `.gitignore` block (its items carry
   *  their own): the roots stay out of the per-root block pass, so a `.gitignore` there is
   *  never read or rewritten (spec §16.2). */
  noGitignoreBlock?: true;
}

const under = (dir: string) => (r: RootContext) => join(r.base, dir);
const claudeDir = (r: RootContext) => (r.scope === "user" && r.claudeDir) || join(r.base, ".claude");
const codexHomeDir = (r: RootContext) => r.codexHome || join(r.base, ".codex");
const hermesHomeDir = (r: RootContext) => r.hermesHome || defaultHermesHome(r.base);

export const LAYOUTS: Record<Harness, TargetLayout> = {
  claude: {
    harness: "claude",
    keyPrefix: "",
    roots: { skill: claudeDir, agent: claudeDir, rule: claudeDir },
    localTypes: ["agent", "rule"],
  },
  // Skills (phase 1), agents as TOML (phase 2, convert.ts), rules as sections of
  // the rules file next to the agents (phase 3, agentsmd.ts).
  codex: {
    harness: "codex",
    keyPrefix: "codex:",
    roots: {
      skill: under(".agents"),
      agent: (r) => (r.scope === "user" ? codexHomeDir(r) : join(r.base, ".codex")),
      rule: (r) => (r.scope === "user" ? codexHomeDir(r) : join(r.base, ".codex")),
    },
    blockTypes: ["rule"],
    localTypes: ["agent"],
  },
  // Skills only (spec §16): Hermes has no agent files and no rules directory. It reads
  // `<repo>/.agents/skills` as well, where the Codex copy of a project skill lives.
  hermes: {
    harness: "hermes",
    keyPrefix: "hermes:",
    roots: { skill: (r) => (r.scope === "user" ? hermesHomeDir(r) : join(r.base, ".hermes")) },
    projectVia: { skill: "codex" },
    noGitignoreBlock: true,
  },
};

/** The file-name prefix of installed agents and rules (spec §6.4). */
const LOCAL_PREFIX = ".local.";

/**
 * An item's built output as the harness installs it (spec §6.3): for a `localTypes`
 * type every file name gets the `.local.` prefix (`agents/foo.md` → `agents/.local.foo.md`,
 * `rules/lang/perl.md` → `rules/lang/.local.perl.md`), and `claims` lists the plain
 * paths the item still owns against foreign files. Other types pass through unchanged.
 */
export function placeOutput(
  harness: Harness, type: ItemType, output: Map<string, Buffer>,
): { output: Map<string, Buffer>; claims: string[] } {
  if (!LAYOUTS[harness].localTypes?.includes(type)) return { output, claims: [] };
  const placed = new Map<string, Buffer>();
  const claims: string[] = [];
  for (const [rel, buf] of output) {
    const cut = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1;
    placed.set(rel.slice(0, cut) + LOCAL_PREFIX + rel.slice(cut), buf);
    claims.push(rel);
  }
  return { output: placed, claims };
}

/** Does an installed item own a file without the `.local.` prefix its type takes for the
 *  harness – the layout before k62 (spec §6.4, §14.3)? Always false for other types. */
export function lacksLocalPrefix(harness: Harness, type: ItemType, paths: string[]): boolean {
  if (!LAYOUTS[harness].localTypes?.includes(type)) return false;
  return paths.some((rel) => !rel.slice(Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1).startsWith(LOCAL_PREFIX));
}

/** The harnesses detection can find; Hermes is a target only by `targets` (spec §16.2). */
const DETECTED = ["claude", "codex"] as const satisfies readonly Harness[];

/** Per detectable harness: absolute paths whose existence means the harness is in use. */
export type HarnessMarkers = Record<(typeof DETECTED)[number], string[]>;

/**
 * Hermes' own default home (`_get_platform_default_hermes_home` in `hermes_constants.py`,
 * spec §16.2): on native Windows `%LOCALAPPDATA%\hermes`, with `<home>\AppData\Local` for
 * an unset or blank `LOCALAPPDATA`; elsewhere `~/.hermes`.
 */
export function defaultHermesHome(
  home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return join(home, ".hermes");
  return win32.join(env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local"), "hermes");
}

/** `claudeDir` is an explicit `CLAUDE_CONFIG_DIR`: Claude Code keeps `.claude.json` inside it then. */
export function defaultMarkers(home: string, codexHome: string | undefined, claudeDir?: string): HarnessMarkers {
  const cx = codexHome || join(home, ".codex");
  return {
    claude: claudeDir
      ? [join(claudeDir, ".claude.json"), join(claudeDir, "settings.json"), join(claudeDir, "projects")]
      : [join(home, ".claude.json"), join(home, ".claude", "settings.json"), join(home, ".claude", "projects")],
    codex: ["config.toml", "auth.json", "sessions", "installation_id"].map((f) => join(cx, f)),
  };
}

export function detectHarnesses(markers: HarnessMarkers): Harness[] {
  return DETECTED.filter((h) => (markers[h] ?? []).some((p) => existsSync(p)));
}

type EvidenceVerdict = "inspect" | "skip" | "evidence";

/** A path explicitly present at the project root is evidence even when it is a link. */
function pathIsEvidence(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function pathIsLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Does a root contain a user-owned entry? Symlinks are evidence but are never traversed. */
function rootHasEvidence(
  root: string,
  classify: (rel: string, abs: string, directory: boolean) => EvidenceVerdict,
): boolean {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return false;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return true;

  const visit = (dir: string, prefix: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      const verdict = classify(rel, abs, entry.isDirectory());
      if (verdict === "skip") continue;
      if (verdict === "evidence" || entry.isSymbolicLink() || !entry.isDirectory()) return true;
      if (visit(abs, rel)) return true;
    }
    return false;
  };
  return visit(root, "");
}

/** Skill directories a valid current lock identifies as generated for one harness. */
function ownedSkills(lock: Lock, harness: Harness): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(lock)) {
    const parsed = parseLockKey(key);
    if (parsed.harness === harness && parsed.type === "skill") out.add(parsed.target);
  }
  return out;
}

function ownedFiles(lock: Lock, harness: Harness, types: readonly ItemType[]): Set<string> {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(lock)) {
    const parsed = parseLockKey(key);
    if (parsed.harness !== harness || !types.includes(parsed.type)) continue;
    const files = entry !== null && typeof entry === "object" && entry.files !== null && typeof entry.files === "object"
      ? Object.keys(entry.files)
      : [];
    for (const file of files) out.add(file);
  }
  return out;
}

function inOwnedSkill(rel: string, owned: Set<string>): boolean {
  for (const target of owned) if (rel === target || rel.startsWith(`${target}/`)) return true;
  return false;
}

/** The fixed per-skill ignore file identifies a generated skill even without its lock entry. */
function generatedSkillDir(rel: string, abs: string, directory: boolean): boolean {
  if (!directory || !/^skills\/[^/]+$/.test(rel)) return false;
  try {
    return readFileSync(join(abs, ".gitignore"), "utf8") === SKILL_GITIGNORE;
  } catch {
    return false;
  }
}

/** A committed Claude settings file with something other than skilletor's generated
 * plugin/marketplace declarations is project-owned Claude evidence. */
function claudeSettingsAreEvidence(path: string, text?: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text ?? readFileSync(path, "utf8"));
  } catch {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some((key) => key !== "enabledPlugins" && key !== "extraKnownMarketplaces")) return true;
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const enabled = settings.enabledPlugins;
  const marketplaces = settings.extraKnownMarketplaces;
  if (Object.hasOwn(settings, "enabledPlugins") && !object(enabled)) return true;
  if (Object.hasOwn(settings, "extraKnownMarketplaces") && !object(marketplaces)) return true;
  const enabledEntries = Object.entries(object(enabled) ? enabled : {});
  const marketplaceKeys = Object.keys(object(marketplaces) ? marketplaces : {});
  if (enabledEntries.length === 0) return marketplaceKeys.length > 0;
  if (enabledEntries.length !== 1) return true;
  const [key, pluginValue] = enabledEntries[0]!;
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1 || key.slice(0, at) !== "skilletor" || pluginValue !== true) return true;
  const marketplace = key.slice(at + 1);
  return marketplaceKeys.some((name) => name !== marketplace);
}

/** A direct skill entry is evidence only when it is a linked entry or contains SKILL.md.
 * A leftover directory containing unrelated foreign files must not re-enable its harness. */
function skillEvidenceVerdict(rel: string, abs: string, directory: boolean): EvidenceVerdict | undefined {
  if (!/^skills\/[^/]+$/.test(rel)) return undefined;
  if (!directory) return pathIsLink(abs) ? "evidence" : "skip";
  return pathIsEvidence(join(abs, "SKILL.md")) ? "evidence" : "skip";
}

/**
 * Project-local harness evidence (k229), read without following symlink trees. Current lock
 * ownership, generated `.local.*` files, per-skill ignore markers and skilletor's fixed files
 * are excluded so a sync cannot opt the project into another harness on its next run.
 * `settingsText` substitutes a proposed .claude/settings.json in memory, even if absent on disk.
 */
export function detectProjectHarnesses(projectDir: string, lock: Lock, settingsText?: string): Harness[] {
  const evidence = new Set<Harness>();
  const claudeOwned = ownedSkills(lock, "claude");
  const claudeFiles = ownedFiles(lock, "claude", ["skill", "agent", "rule"]);
  const projectedSettings = settingsText === undefined ? undefined
    : !claudeFiles.has("settings.json") && claudeSettingsAreEvidence(join(projectDir, ".claude", "settings.json"), settingsText);
  if (pathIsEvidence(join(projectDir, "CLAUDE.md")) || projectedSettings || rootHasEvidence(join(projectDir, ".claude"), (rel, abs, directory) => {
    if (["skilletor.json", "skilletor.local.json", "skilletor.lock.json", ".gitignore", "skilletor"].includes(rel)) return "skip";
    if (claudeFiles.has(rel)) return "skip";
    if (rel === "settings.json") return (projectedSettings ?? claudeSettingsAreEvidence(abs)) ? "evidence" : "skip";
    if (inOwnedSkill(rel, claudeOwned) || generatedSkillDir(rel, abs, directory)) return "skip";
    const skill = skillEvidenceVerdict(rel, abs, directory);
    if (skill) return skill;
    const [top, ...rest] = rel.split("/");
    if ((top === "agents" || top === "rules") && rest.at(-1)?.startsWith(".local.")) return "skip";
    return "inspect";
  })) evidence.add("claude");

  const codexOwned = ownedSkills(lock, "codex");
  const codexFiles = ownedFiles(lock, "codex", ["agent", "rule"]);
  const agents = rootHasEvidence(join(projectDir, ".agents"), (rel, abs, directory) => {
    const top = rel.split("/")[0];
    if (rel === ".gitignore" || top !== "skills") return "skip";
    if (inOwnedSkill(rel, codexOwned) || generatedSkillDir(rel, abs, directory)) return "skip";
    return skillEvidenceVerdict(rel, abs, directory) ?? "inspect";
  });
  const codex = rootHasEvidence(join(projectDir, ".codex"), (rel) => {
    if (rel === ".gitignore" || rel === RULES_EVIDENCE_EXCLUSION || codexFiles.has(rel)) return "skip";
    const parts = rel.split("/");
    if (parts[0] === "agents" && parts.at(-1)?.startsWith(".local.")) return "skip";
    return "inspect";
  });
  if (agents || codex || pathIsEvidence(join(projectDir, "AGENTS.override.md"))) evidence.add("codex");

  const hermesOwned = ownedSkills(lock, "hermes");
  if (rootHasEvidence(join(projectDir, ".hermes"), (rel, abs, directory) => {
    if (rel === ".gitignore") return "skip";
    if (inOwnedSkill(rel, hermesOwned) || generatedSkillDir(rel, abs, directory)) return "skip";
    return skillEvidenceVerdict(rel, abs, directory) ?? "inspect";
  })) evidence.add("hermes");

  return HARNESSES.filter((h) => evidence.has(h));
}

/** The one Codex rules file skilletor itself assembles. */
const RULES_EVIDENCE_EXCLUSION = "skilletor-rules.md";

export interface TargetSelection {
  user: Harness[];
  project: Harness[];
  warnings: string[];
  /** Several machine targets but no explicit project target or reliable local evidence: callers
   *  must not reconcile the project scope. `project` remains the machine set for read-only
   *  consumers and is not a destructive empty-target sentinel. */
  projectUnresolved?: true;
}

/**
 * Machine = user `targets` ?? detected (empty is an error); user scope = machine. A project
 * with explicit targets narrows the machine set. Otherwise project evidence decides inside
 * that set; one machine target remains the bootstrap default, while a multi-target project
 * without evidence is explicitly unresolved and must be left untouched.
 */
export function selectTargets(
  configured: { user?: Harness[]; project?: Harness[]; projectEvidence?: Harness[] },
  detected: Harness[],
  markers?: HarnessMarkers,
): TargetSelection {
  const machine = configured.user ?? detected;
  if (machine.length === 0) {
    const looked = markers
      ? ` (looked for ${DETECTED.filter((h) => markers[h]).map((h) => `${h}: ${markers[h].join(", ")}`).join("; ")})`
      : "";
    throw new TargetError(
      `no agent harness detected${looked}; set "targets": ["claude"], "codex" and/or "hermes" in ~/.claude/skilletor.json`,
    );
  }
  const warnings: string[] = [];
  let project = machine;
  let projectUnresolved: true | undefined;
  if (configured.project) {
    project = machine.filter((h) => configured.project!.includes(h));
    if (project.length === 0) {
      warnings.push(
        `project targets (${configured.project.join(", ")}) are not in use on this machine ` +
          `(${machine.join(", ")}); nothing is installed for the project`,
      );
    }
  } else if (configured.projectEvidence !== undefined) {
    if (configured.projectEvidence.length > 0) {
      project = machine.filter((h) => configured.projectEvidence!.includes(h));
      if (project.length === 0) {
        warnings.push(
          `project harness evidence (${configured.projectEvidence.join(", ")}) is not in use on this machine ` +
            `(${machine.join(", ")}); nothing is installed for the project`,
        );
      }
    } else if (machine.length === 1) {
      project = [...machine];
    } else {
      project = [...machine];
      projectUnresolved = true;
      warnings.push(
        `project targets are ambiguous: no project-local harness evidence for machine targets (${machine.join(", ")}); ` +
          `set "targets" in the project's .claude/skilletor.json or .claude/skilletor.local.json; ` +
          "project scope is left unchanged",
      );
    }
  }
  return { user: [...machine], project, warnings, ...(projectUnresolved ? { projectUnresolved } : {}) };
}

// ---- lock keys ----------------------------------------------------------------

const TYPE_OF_DIR: Record<string, ItemType> = { skills: "skill", agents: "agent", rules: "rule" };

/** "skills/foo" for harness h → its lock key. */
export function lockKey(harness: Harness, target: string): string {
  return LAYOUTS[harness].keyPrefix + target;
}

/** Split a lock key. `harness` is undefined for a prefix this version does not know. */
export function parseLockKey(key: string): { harness?: Harness; target: string; type: ItemType; name: string } {
  const colon = key.indexOf(":");
  const slash = key.indexOf("/");
  let harness: Harness | undefined = "claude";
  let target = key;
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    const prefix = key.slice(0, colon + 1);
    harness = HARNESSES.find((h) => LAYOUTS[h].keyPrefix === prefix);
    target = key.slice(colon + 1);
  }
  const [dir, ...rest] = target.split("/");
  return { harness, target, type: TYPE_OF_DIR[dir!] ?? "rule", name: rest.join("/") };
}

/** Does the harness receive items of this type? */
export function supports(harness: Harness, type: ItemType): boolean {
  return LAYOUTS[harness].roots[type] !== undefined;
}

/** Absolute root for an item of `type` in a scope for a harness (undefined if not written). */
export function rootOf(r: RootContext, harness: Harness, type: ItemType): string | undefined {
  return LAYOUTS[harness].roots[type]?.(r);
}

/** Absolute root a lock key's files live under; undefined for unknown or unsupported keys. */
export function rootOfKey(r: RootContext, key: string): string | undefined {
  const k = parseLockKey(key);
  return k.harness ? rootOf(r, k.harness, k.type) : undefined;
}

/**
 * The active harnesses that get a copy of their own of a type in a scope (spec §14.2,
 * §16.2): those that have a place for the type, minus one that reads the type from another
 * active harness's project root (Hermes: a project skill through the Codex copy).
 */
export function receivers(active: Harness[], type: ItemType, scope: "user" | "project"): Harness[] {
  return active.filter((h) => supports(h, type) && servedVia(active, h, type, scope) === undefined);
}

/** The other active harness whose copy of a type serves `harness` in a scope (spec §16.2), if any. */
export function servedVia(
  active: Harness[], harness: Harness, type: ItemType, scope: "user" | "project",
): Harness | undefined {
  const via = scope === "project" ? LAYOUTS[harness].projectVia?.[type] : undefined;
  return via !== undefined && active.includes(via) ? via : undefined;
}

/** Is this harness's copy of the type a section of a managed block (spec §14.8)? */
export function isBlockType(harness: Harness, type: ItemType): boolean {
  return LAYOUTS[harness].blockTypes?.includes(type) ?? false;
}

/** Every distinct root of a scope that can hold a gitignore block, the root of the Codex
 *  rules file included; never a root of a harness without blocks (Hermes, spec §16.2). */
export function allRoots(r: RootContext): string[] {
  const roots = new Set<string>();
  for (const h of HARNESSES) {
    if (LAYOUTS[h].noGitignoreBlock) continue;
    for (const f of Object.values(LAYOUTS[h].roots)) if (f) roots.add(f(r));
  }
  return [...roots];
}

/**
 * Where the lock disagrees with the active targets (spec §14.3), one gap each: an entry
 * of a (known) harness that gets no copy in this scope – inactive, or served by another
 * harness's copy (spec §16.2) – (`key` alone), or an item locked for one target but missing
 * for another active target that gets a copy of its type (`missing`: the key it lacks).
 */
export function targetGaps(
  keys: string[], active: Harness[], scope: "user" | "project" = "user",
): { key: string; missing?: string }[] {
  const set = new Set(keys);
  const gaps: { key: string; missing?: string }[] = [];
  for (const key of keys) {
    const k = parseLockKey(key);
    if (!k.harness || !supports(k.harness, k.type)) continue; // kept untouched, never drift
    const receiving = receivers(active, k.type, scope);
    if (!receiving.includes(k.harness)) {
      gaps.push({ key });
      continue;
    }
    for (const h of receiving) {
      const missing = lockKey(h, k.target);
      if (!set.has(missing)) gaps.push({ key, missing });
    }
  }
  return gaps;
}
