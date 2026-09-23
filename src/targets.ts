// Harness targets (spec §14): which agent harnesses skilletor installs for,
// where each harness reads each item type, and how a lock key names its target.
//
// Detection looks only at markers the harness itself creates (never at
// `~/.claude/` alone: skilletor's own config lives there). The layout table is
// the seam later phases extend (Codex agents as TOML, rules in a rules file).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, type Harness, type ItemType } from "./config.ts";

export type { Harness } from "./config.ts";

export class TargetError extends Error {
  override name = "TargetError";
}

/** Where a scope's roots live: its base (`~` or the project root), and the Codex home. */
export interface RootContext {
  base: string;
  scope: "user" | "project";
  /** `$CODEX_HOME`; unset or empty means `<home>/.codex` (only the user scope uses it). */
  codexHome?: string;
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
}

const under = (dir: string) => (r: RootContext) => join(r.base, dir);
const codexHomeDir = (r: RootContext) => r.codexHome || join(r.base, ".codex");

export const LAYOUTS: Record<Harness, TargetLayout> = {
  claude: { harness: "claude", keyPrefix: "", roots: { skill: under(".claude"), agent: under(".claude"), rule: under(".claude") } },
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
  },
};

/** Per harness: absolute paths whose existence means the harness is in use. */
export type HarnessMarkers = Record<Harness, string[]>;

export function defaultMarkers(home: string, codexHome: string | undefined): HarnessMarkers {
  const cx = codexHome || join(home, ".codex");
  return {
    claude: [join(home, ".claude.json"), join(home, ".claude", "settings.json"), join(home, ".claude", "projects")],
    codex: ["config.toml", "auth.json", "sessions", "installation_id"].map((f) => join(cx, f)),
  };
}

export function detectHarnesses(markers: HarnessMarkers): Harness[] {
  return HARNESSES.filter((h) => markers[h].some((p) => existsSync(p)));
}

export interface TargetSelection {
  user: Harness[];
  project: Harness[];
  warnings: string[];
}

/**
 * The merge rule (spec §14.1): machine = user `targets` ?? detected (empty is an
 * error); user scope = machine; project scope = machine, narrowed to the
 * project's `targets` (local over committed) when one is set.
 */
export function selectTargets(
  configured: { user?: Harness[]; project?: Harness[] },
  detected: Harness[],
  markers?: HarnessMarkers,
): TargetSelection {
  const machine = configured.user ?? detected;
  if (machine.length === 0) {
    const looked = markers
      ? ` (looked for ${HARNESSES.map((h) => `${h}: ${markers[h].join(", ")}`).join("; ")})`
      : "";
    throw new TargetError(
      `no agent harness detected${looked}; set "targets": ["claude"] and/or "codex" in ~/.claude/skilletor.json`,
    );
  }
  const warnings: string[] = [];
  let project = machine;
  if (configured.project) {
    project = machine.filter((h) => configured.project!.includes(h));
    if (project.length === 0) {
      warnings.push(
        `project targets (${configured.project.join(", ")}) are not in use on this machine ` +
          `(${machine.join(", ")}); nothing is installed for the project`,
      );
    }
  }
  return { user: [...machine], project, warnings };
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

/** Is this harness's copy of the type a section of a managed block (spec §14.8)? */
export function isBlockType(harness: Harness, type: ItemType): boolean {
  return LAYOUTS[harness].blockTypes?.includes(type) ?? false;
}

/** Every distinct root of a scope (for per-root gitignore blocks), the root of
 *  the Codex rules file included. */
export function allRoots(r: RootContext): string[] {
  const roots = new Set<string>();
  for (const h of HARNESSES) {
    for (const f of Object.values(LAYOUTS[h].roots)) if (f) roots.add(f(r));
  }
  return [...roots];
}

/**
 * Does the lock disagree with the active targets? True when an entry belongs to
 * an inactive (known) harness, or an item locked for one target is missing for
 * another active target that supports its type (spec §14.3).
 */
export function targetDrift(keys: string[], active: Harness[]): boolean {
  const set = new Set(keys);
  for (const key of keys) {
    const k = parseLockKey(key);
    if (!k.harness || !supports(k.harness, k.type)) continue; // kept untouched, never drift
    if (!active.includes(k.harness)) return true;
    for (const h of active) if (supports(h, k.type) && !set.has(lockKey(h, k.target))) return true;
  }
  return false;
}
