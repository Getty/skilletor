// Load, merge and validate skilletor config (spec §3).
//
// Three files, discovered from an injectable home dir and project root:
//   <home>/.claude/skilletor.json              — user level
//   <projectDir>/.claude/skilletor.json         — project level (committed)
//   <projectDir>/.claude/skilletor.local.json   — machine-local overrides
//
// Missing files are not an error; they read as an empty config. Everything
// that can go wrong throws a ConfigError naming the file and the offending key.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

export type ItemType = "skill" | "agent" | "rule";
export const ITEM_TYPES: readonly ItemType[] = ["skill", "agent", "rule"];
/** Config install keys (`skills`/`agents`/`rules`) mapped to the item type. */
const INSTALL_KEYS: Record<string, ItemType> = { skills: "skill", agents: "agent", rules: "rule" };
/** Agent harnesses skilletor can install for (spec §14). */
export type Harness = "claude" | "codex";
export const HARNESSES: readonly Harness[] = ["claude", "codex"];
/** The item name that declares every item of a type in a source (`*@source`); in a
 *  name it matches any run of characters, so `perl-*@source` is a pattern (spec §3). */
export const WILDCARD = "*";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ResolvedSource {
  name: string;
  git?: string;
  ref?: string;
  url?: string;
  local?: string;
  /** "user" = declared in the user or local config (trusted); "project" = only in the committed project config. */
  origin: "user" | "project";
}

export interface InstallItem {
  type: ItemType;
  name: string;
  source: string;
  /** Install path relative to the scope's `.claude/`, e.g. `skills/perl-moo`. */
  target: string;
  /** The raw declaration, for error messages. */
  raw: string;
}

/** `*@source` or a pattern (`perl-*@source`) under one type: every item of that type in
 *  the source whose name matches, expanded at sync time (spec §3). */
export interface WildcardItem {
  type: ItemType;
  source: string;
  /** The name part, containing at least one `*`: `*`, `perl-*`, `*-style`. */
  pattern: string;
  /** The raw declaration, e.g. `*@shared` or `rule:perl-*@shared`. */
  raw: string;
}

/** `name@source` under `install.bundles`: a bundle of that source, expanded at sync time (spec §15). */
export interface BundleItem {
  name: string;
  source: string;
  /** The raw declaration, e.g. `perl@shared` or `bundle:perl@shared`. */
  raw: string;
}

export interface ScopeConfig {
  scope: "user" | "project";
  install: InstallItem[];
  wildcards: WildcardItem[];
  bundles: BundleItem[];
  vars: Record<string, unknown>;
  /** Project scope only: maintain the managed gitignore block (default true). */
  gitignore?: boolean;
  /** `targets` as written (project: local over committed); unset = not restricted (spec §14.1). */
  targets?: Harness[];
}

export interface LoadedConfig {
  sources: Map<string, ResolvedSource>;
  /**
   * User-level throttle for the in-session check, in seconds (default 1800).
   * hooks.ts DEFAULT_INTERVAL=600 is only the fallback used if config loading fails.
   */
  checkInterval: number;
  user: ScopeConfig;
  project?: ScopeConfig;
  /** Sources the user config declares: the ones visible to the user scope (spec §15.6).
   *  The project scope sees every source. */
  userSources: Set<string>;
}

export interface LoadOptions {
  /** Stands in for `~`; the user config is `<home>/.claude/skilletor.json`. */
  home: string;
  /** Project root; omit to load only the user scope. */
  projectDir?: string;
}

const ALLOWED_KEYS = new Set(["sources", "install", "vars", "gitignore", "checkInterval", "targets"]);
const SOURCE_KEYS = new Set(["git", "ref", "url", "local"]);

type Json = Record<string, unknown>;

/** Read and parse one config file; a missing file is an empty object. */
function readConfigFile(path: string): Json {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`${path}: cannot read config (${(err as Error).message})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${path}: top level must be a JSON object`);
  }
  validateKeys(value as Json, path);
  return value as Json;
}

function validateKeys(obj: Json, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(
        `${path}: unknown key "${key}" (allowed: ${[...ALLOWED_KEYS].join(", ")})`,
      );
    }
  }
}

function asObject(value: unknown, path: string, where: string): Json {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${path}: ${where} must be an object`);
  }
  return value as Json;
}

/** Parse and validate the `sources` object of one file. */
function parseSources(obj: Json, path: string): Map<string, ResolvedSource> {
  const sources = new Map<string, ResolvedSource>();
  const raw = asObject(obj.sources, path, "sources");
  for (const [name, def] of Object.entries(raw)) {
    const d = asObject(def, path, `sources.${name}`);
    for (const key of Object.keys(d)) {
      if (!SOURCE_KEYS.has(key)) {
        throw new ConfigError(`${path}: sources.${name}: unknown key "${key}"`);
      }
    }
    const src: ResolvedSource = { name, origin: "project" };
    if (typeof d.git === "string") src.git = d.git;
    if (typeof d.ref === "string") src.ref = d.ref;
    if (typeof d.local === "string") src.local = d.local;
    if (d.url !== undefined) {
      if (typeof d.url !== "string" || !d.url.startsWith("https://")) {
        throw new ConfigError(`${path}: sources.${name}.url must be an https:// URL`);
      }
      src.url = d.url;
    }
    if (src.git === undefined && src.url === undefined && src.local === undefined) {
      throw new ConfigError(`${path}: sources.${name} needs one of "git", "url" or "local"`);
    }
    sources.set(name, src);
  }
  return sources;
}

/** Merge `incoming` source fields over `base`, keeping the higher-precedence origin. */
function mergeSource(base: ResolvedSource | undefined, incoming: ResolvedSource, origin: "user" | "project"): ResolvedSource {
  const merged: ResolvedSource = { ...(base ?? { name: incoming.name, origin }), ...incoming };
  merged.origin = base?.origin === "user" || origin === "user" ? "user" : "project";
  return merged;
}

interface ParsedInstall {
  install: InstallItem[];
  wildcards: WildcardItem[];
  bundles: BundleItem[];
}

/** The `install` key that lists bundles rather than items of one type. */
const BUNDLES_KEY = "bundles";

/** Parse one file's `install` into items and wildcards, given which sources are legal to reference. */
function parseInstall(
  obj: Json,
  path: string,
  scope: "user" | "project",
  known: Map<string, ResolvedSource>,
): ParsedInstall {
  const install = asObject(obj.install, path, "install");
  for (const key of Object.keys(install)) {
    if (!(key in INSTALL_KEYS) && key !== BUNDLES_KEY) {
      throw new ConfigError(`${path}: install.${key} is not a valid type (skills, agents, rules, bundles)`);
    }
  }
  const items: InstallItem[] = [];
  const wildcards: WildcardItem[] = [];
  const seen = new Map<string, string>(); // "type/name" (or "type/*@source") -> raw declaration
  for (const [key, type] of Object.entries(INSTALL_KEYS)) {
    const list = install[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new ConfigError(`${path}: install.${key} must be an array`);
    list.forEach((entry, i) => {
      if (typeof entry !== "string") {
        throw new ConfigError(`${path}: install.${key}[${i}] must be a string`);
      }
      const item = parseEntry(entry, type, path, `install.${key}[${i}]`);
      if (!known.has(item.source)) {
        throw new ConfigError(
          `${path}: ${scope} install "${entry}" references unknown source "${item.source}"`,
        );
      }
      const targetKey = seenKey(item);
      const prev = seen.get(targetKey);
      if (prev !== undefined) {
        throw new ConfigError(
          `${path}: duplicate ${item.type} target "${item.name}" declared as ${prev} and ${entry}`,
        );
      }
      seen.set(targetKey, entry);
      if (item.name.includes(WILDCARD)) {
        wildcards.push({ type: item.type, source: item.source, pattern: item.name, raw: entry });
      } else {
        items.push(item);
      }
    });
  }
  return { install: items, wildcards, bundles: parseBundles(install[BUNDLES_KEY], path, scope, known) };
}

/** Parse `install.bundles`: `[bundle:]name@source`, no patterns (spec §3, §15). */
function parseBundles(
  list: unknown, path: string, scope: "user" | "project", known: Map<string, ResolvedSource>,
): BundleItem[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ConfigError(`${path}: install.${BUNDLES_KEY} must be an array`);
  const out: BundleItem[] = [];
  list.forEach((entry, i) => {
    const where = `install.${BUNDLES_KEY}[${i}]`;
    if (typeof entry !== "string") throw new ConfigError(`${path}: ${where} must be a string`);
    const b = parseBundleEntry(entry, path, where);
    if (!known.has(b.source)) {
      throw new ConfigError(`${path}: ${scope} install "${entry}" references unknown source "${b.source}"`);
    }
    out.push(b);
  });
  return dedupeBundles(out, [], path);
}

/** Parse `[bundle:]name@source`. */
function parseBundleEntry(entry: string, path: string, where: string): BundleItem {
  const at = entry.lastIndexOf("@");
  if (at <= 0 || at === entry.length - 1) {
    throw new ConfigError(`${path}: ${where} "${entry}" must be name@source`);
  }
  let name = entry.slice(0, at);
  const colon = name.indexOf(":");
  if (colon !== -1) {
    const prefix = name.slice(0, colon);
    if (prefix !== "bundle") {
      throw new ConfigError(`${path}: ${where} "${entry}" declares type "${prefix}" but is under bundles`);
    }
    name = name.slice(colon + 1);
  }
  if (name.length === 0) throw new ConfigError(`${path}: ${where} "${entry}" has an empty name`);
  if (name.includes(WILDCARD)) {
    throw new ConfigError(`${path}: ${where} "${entry}": patterns over bundle names are not supported`);
  }
  return { name, source: entry.slice(at + 1), raw: entry };
}

/** Concatenate two bundle lists, rejecting the same bundle twice in one scope. */
function dedupeBundles(a: BundleItem[], b: BundleItem[], path: string): BundleItem[] {
  const seen = new Map<string, string>();
  for (const x of [...a, ...b]) {
    const prev = seen.get(`${x.name}@${x.source}`);
    if (prev !== undefined) {
      throw new ConfigError(`${path}: duplicate bundle "${x.name}@${x.source}" declared as ${prev} and ${x.raw}`);
    }
    seen.set(`${x.name}@${x.source}`, x.raw);
  }
  return [...a, ...b];
}

/** Duplicate key: a name per type, or a wildcard pattern per type and source. */
function seenKey(item: { type: ItemType; name: string; source: string }): string {
  return item.name.includes(WILDCARD) ? `${item.type}/${item.name}@${item.source}` : `${item.type}/${item.name}`;
}

/** Parse `[type:]name@source`. The array's type wins; an explicit prefix must match it. */
function parseEntry(entry: string, type: ItemType, path: string, where: string): InstallItem {
  const at = entry.lastIndexOf("@");
  if (at <= 0 || at === entry.length - 1) {
    throw new ConfigError(`${path}: ${where} "${entry}" must be name@source`);
  }
  const source = entry.slice(at + 1);
  let name = entry.slice(0, at);
  const colon = name.indexOf(":");
  if (colon !== -1) {
    const prefix = name.slice(0, colon);
    if (prefix !== type) {
      throw new ConfigError(
        `${path}: ${where} "${entry}" declares type "${prefix}" but is under ${type}s`,
      );
    }
    name = name.slice(colon + 1);
  }
  if (name.length === 0) throw new ConfigError(`${path}: ${where} "${entry}" has an empty name`);
  return { type, name, source, target: `${type}s/${name}`, raw: entry };
}

function mergeVars(...objs: (Json | undefined)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of objs) if (o) Object.assign(out, o);
  return out;
}

export function loadConfig(opts: LoadOptions): LoadedConfig {
  const userPath = join(opts.home, ".claude", "skilletor.json");
  const user = readConfigFile(userPath);
  if ("gitignore" in user) {
    throw new ConfigError(`${userPath}: "gitignore" is project-only`);
  }

  const hasProject = opts.projectDir !== undefined;
  const projectPath = hasProject ? join(opts.projectDir!, ".claude", "skilletor.json") : "";
  const localPath = hasProject ? join(opts.projectDir!, ".claude", "skilletor.local.json") : "";
  const project = hasProject ? readConfigFile(projectPath) : {};
  const local = hasProject ? readConfigFile(localPath) : {};
  for (const [obj, p] of [[project, projectPath], [local, localPath]] as const) {
    if (p && "checkInterval" in obj) {
      throw new ConfigError(`${p}: "checkInterval" is user-only`);
    }
  }

  // Build the merged source map: project (base) < user < local.
  const userSources = parseSources(user, userPath);
  const projectSources = hasProject ? parseSources(project, projectPath) : new Map();
  const localSources = hasProject ? parseSources(local, localPath) : new Map();

  const sources = new Map<string, ResolvedSource>();
  for (const [name, s] of projectSources) sources.set(name, { ...s, origin: "project" });
  for (const [name, s] of userSources) sources.set(name, mergeSource(sources.get(name), s, "user"));
  for (const [name, s] of localSources) sources.set(name, mergeSource(sources.get(name), s, "user"));

  // Default 30 min. 0 (or negative) disables the in-session check; SessionStart still syncs.
  const checkInterval = numberOr(user.checkInterval, 1800, userPath, "checkInterval");

  const userInstall = parseInstall(user, userPath, "user", userSources);
  const userScope: ScopeConfig = {
    scope: "user",
    install: userInstall.install,
    wildcards: userInstall.wildcards,
    bundles: userInstall.bundles,
    vars: mergeVars(asObject(user.vars, userPath, "vars")),
  };
  const userTargets = targetsOf(user.targets, userPath);
  if (userTargets) userScope.targets = userTargets;

  let projectScope: ScopeConfig | undefined;
  if (hasProject) {
    // Project install can be declared in the project file and the local file.
    const projectInstall = parseInstall(project, projectPath, "project", sources);
    const localInstall = parseInstall(local, localPath, "project", sources);
    projectScope = {
      scope: "project",
      install: dedupeAcross(projectInstall.install, localInstall.install, projectPath),
      wildcards: dedupeWildcards(projectInstall.wildcards, localInstall.wildcards, projectPath),
      bundles: dedupeBundles(projectInstall.bundles, localInstall.bundles, projectPath),
      vars: mergeVars(
        asObject(user.vars, userPath, "vars"),
        asObject(project.vars, projectPath, "vars"),
        asObject(local.vars, localPath, "vars"),
      ),
      gitignore: boolOr(local.gitignore ?? project.gitignore, true, projectPath, "gitignore"),
    };
    const projectTargets = targetsOf(project.targets, projectPath);
    const localTargets = targetsOf(local.targets, localPath);
    if (localTargets ?? projectTargets) projectScope.targets = localTargets ?? projectTargets;
  }

  return { sources, checkInterval, user: userScope, project: projectScope, userSources: new Set(userSources.keys()) };
}

/** Concatenate two install lists, rejecting duplicate targets across them. */
function dedupeAcross(a: InstallItem[], b: InstallItem[], path: string): InstallItem[] {
  const seen = new Map<string, string>();
  const out: InstallItem[] = [];
  for (const item of [...a, ...b]) {
    const key = `${item.type}/${item.name}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new ConfigError(
        `${path}: duplicate ${item.type} target "${item.name}" declared as ${prev} and ${item.raw}`,
      );
    }
    seen.set(key, item.raw);
    out.push(item);
  }
  return out;
}

/** Concatenate two wildcard lists, rejecting the same type+pattern+source twice. */
function dedupeWildcards(a: WildcardItem[], b: WildcardItem[], path: string): WildcardItem[] {
  const seen = new Map<string, string>();
  const out: WildcardItem[] = [];
  for (const w of [...a, ...b]) {
    const key = seenKey({ type: w.type, name: w.pattern, source: w.source });
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new ConfigError(`${path}: duplicate ${w.type} wildcard for "${w.source}" declared as ${prev} and ${w.raw}`);
    }
    seen.set(key, w.raw);
    out.push(w);
  }
  return out;
}

/** Validate a `targets` value: a non-empty array of known harnesses, no duplicates. */
function targetsOf(value: unknown, path: string): Harness[] | undefined {
  if (value === undefined) return undefined;
  const allowed = HARNESSES.join(", ");
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${path}: "targets" must be a non-empty array (of ${allowed})`);
  }
  const out: Harness[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !(HARNESSES as readonly string[]).includes(v)) {
      throw new ConfigError(`${path}: "targets" has unknown harness ${JSON.stringify(v)} (allowed: ${allowed})`);
    }
    if (out.includes(v as Harness)) throw new ConfigError(`${path}: "targets" lists "${v}" twice`);
    out.push(v as Harness);
  }
  return out;
}

function numberOr(value: unknown, fallback: number, path: string, key: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path}: "${key}" must be a number`);
  }
  return value;
}

function boolOr(value: unknown, fallback: boolean, path: string, key: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path}: "${key}" must be a boolean`);
  return value;
}

// ---- edit operations (spec §7) ----------------------------------------------
//
// These mutate a single config file, creating it if needed and writing 2-space
// JSON with a trailing newline (diff-friendly). They preserve existing key order.

export interface SourceDef {
  git?: string;
  ref?: string;
  url?: string;
  local?: string;
}

type RawConfig = Record<string, unknown>;

function loadRaw(path: string): RawConfig {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level must be an object");
    }
    return value as RawConfig;
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
}

function saveRaw(path: string, cfg: RawConfig): void {
  atomicWrite(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function addSource(path: string, name: string, def: SourceDef): void {
  const cfg = loadRaw(path);
  const sources = (cfg.sources as Record<string, unknown>) ?? {};
  sources[name] = def;
  cfg.sources = sources;
  saveRaw(path, cfg);
}

export function removeSource(path: string, name: string): void {
  const cfg = loadRaw(path);
  const sources = cfg.sources as Record<string, unknown> | undefined;
  if (sources && name in sources) {
    delete sources[name];
    if (Object.keys(sources).length === 0) delete cfg.sources;
    saveRaw(path, cfg);
  }
}

const INSTALL_KEY: Record<ItemType, string> = { skill: "skills", agent: "agents", rule: "rules" };

export function addInstallEntry(path: string, type: ItemType, entry: string): void {
  const cfg = loadRaw(path);
  const install = (cfg.install as Record<string, unknown>) ?? {};
  const key = INSTALL_KEY[type];
  const list = Array.isArray(install[key]) ? (install[key] as string[]) : [];
  if (!list.includes(entry)) list.push(entry);
  install[key] = list;
  cfg.install = install;
  saveRaw(path, cfg);
}

/** Does raw install entry `e` (`[type:]name@source`) declare `name` (from `source`, if given)? */
function entryMatches(e: string, name: string, source?: string): boolean {
  const at = e.lastIndexOf("@");
  const eName = (at > 0 ? e.slice(0, at) : e).replace(/^[a-z]+:/, "");
  const eSource = at > 0 ? e.slice(at + 1) : undefined;
  return eName === name && (source === undefined || eSource === source);
}

/**
 * Install entries in one config file matching a name (optionally scoped to a
 * source and to one type's list), without changing anything. `entry` is raw.
 */
export function findInstallEntries(
  path: string, name: string, source?: string, type?: ItemType,
): { type: ItemType; entry: string }[] {
  const install = loadRaw(path).install as Record<string, unknown> | undefined;
  if (!install) return [];
  const out: { type: ItemType; entry: string }[] = [];
  for (const t of type ? [type] : ITEM_TYPES) {
    const list = install[INSTALL_KEY[t]];
    if (!Array.isArray(list)) continue;
    for (const e of list as string[]) if (typeof e === "string" && entryMatches(e, name, source)) out.push({ type: t, entry: e });
  }
  return out;
}

/** Remove install entries matching a name (optionally scoped to a source and to one type's list). */
export function removeInstallEntries(path: string, name: string, source?: string, type?: ItemType): number {
  const cfg = loadRaw(path);
  const install = cfg.install as Record<string, unknown> | undefined;
  if (!install) return 0;
  let removed = 0;
  for (const key of type ? [INSTALL_KEY[type]] : Object.values(INSTALL_KEY)) {
    const list = install[key];
    if (!Array.isArray(list)) continue;
    const kept = (list as string[]).filter((e) => {
      const match = entryMatches(e, name, source);
      if (match) removed++;
      return !match;
    });
    if (kept.length) install[key] = kept;
    else delete install[key];
  }
  if (Object.keys(install).length === 0) delete cfg.install;
  if (removed) saveRaw(path, cfg);
  return removed;
}

/** Install entries in one config file whose name is a pattern (contains `*`), per type. */
export function findWildcardEntries(
  path: string, source: string, type?: ItemType,
): { type: ItemType; entry: string; pattern: string }[] {
  const install = loadRaw(path).install as Record<string, unknown> | undefined;
  if (!install) return [];
  const out: { type: ItemType; entry: string; pattern: string }[] = [];
  for (const t of type ? [type] : ITEM_TYPES) {
    const list = install[INSTALL_KEY[t]];
    if (!Array.isArray(list)) continue;
    for (const e of list as unknown[]) {
      if (typeof e !== "string") continue;
      const at = e.lastIndexOf("@");
      if (at <= 0 || e.slice(at + 1) !== source) continue;
      const pattern = e.slice(0, at).replace(/^[a-z]+:/, "");
      if (pattern.includes(WILDCARD)) out.push({ type: t, entry: e, pattern });
    }
  }
  return out;
}

/** Split a raw bundle entry `[bundle:]name@source`. */
function bundleParts(e: string): { name: string; source: string } | undefined {
  const at = e.lastIndexOf("@");
  if (at <= 0) return undefined;
  return { name: e.slice(0, at).replace(/^bundle:/, ""), source: e.slice(at + 1) };
}

/** `install.bundles` of one config file as raw entries with their parts. */
export function bundleEntries(path: string): { name: string; source: string; entry: string }[] {
  const list = (loadRaw(path).install as Record<string, unknown> | undefined)?.[BUNDLES_KEY];
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).flatMap((e) => {
    const p = typeof e === "string" ? bundleParts(e) : undefined;
    return p ? [{ ...p, entry: e as string }] : [];
  });
}

export function addBundleEntry(path: string, entry: string): void {
  const cfg = loadRaw(path);
  const install = (cfg.install as Record<string, unknown>) ?? {};
  const list = Array.isArray(install[BUNDLES_KEY]) ? (install[BUNDLES_KEY] as string[]) : [];
  const p = bundleParts(entry)!;
  if (!list.some((e) => { const q = bundleParts(e); return q?.name === p.name && q.source === p.source; })) list.push(entry);
  install[BUNDLES_KEY] = list;
  cfg.install = install;
  saveRaw(path, cfg);
}

/** Remove `install.bundles` entries naming `name@source`; returns how many. */
export function removeBundleEntries(path: string, name: string, source: string): number {
  const cfg = loadRaw(path);
  const install = cfg.install as Record<string, unknown> | undefined;
  const list = install?.[BUNDLES_KEY];
  if (!install || !Array.isArray(list)) return 0;
  const kept = (list as unknown[]).filter((e) => {
    const p = typeof e === "string" ? bundleParts(e) : undefined;
    return !(p && p.name === name && p.source === source);
  });
  const removed = list.length - kept.length;
  if (!removed) return 0;
  if (kept.length) install[BUNDLES_KEY] = kept;
  else delete install[BUNDLES_KEY];
  if (Object.keys(install).length === 0) delete cfg.install;
  saveRaw(path, cfg);
  return removed;
}
