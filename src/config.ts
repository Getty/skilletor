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

export interface ScopeConfig {
  scope: "user" | "project";
  install: InstallItem[];
  vars: Record<string, unknown>;
  /** Project scope only: maintain the managed gitignore block (default true). */
  gitignore?: boolean;
}

export interface LoadedConfig {
  sources: Map<string, ResolvedSource>;
  /** User-level throttle for the in-session check, in seconds (default 600). */
  checkInterval: number;
  user: ScopeConfig;
  project?: ScopeConfig;
}

export interface LoadOptions {
  /** Stands in for `~`; the user config is `<home>/.claude/skilletor.json`. */
  home: string;
  /** Project root; omit to load only the user scope. */
  projectDir?: string;
}

const ALLOWED_KEYS = new Set(["sources", "install", "vars", "gitignore", "checkInterval"]);
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

/** Parse one file's `install` into items, given which sources are legal to reference. */
function parseInstall(
  obj: Json,
  path: string,
  scope: "user" | "project",
  known: Map<string, ResolvedSource>,
): InstallItem[] {
  const install = asObject(obj.install, path, "install");
  for (const key of Object.keys(install)) {
    if (!(key in INSTALL_KEYS)) {
      throw new ConfigError(`${path}: install.${key} is not a valid type (skills, agents, rules)`);
    }
  }
  const items: InstallItem[] = [];
  const seen = new Map<string, string>(); // "type/name" -> raw declaration
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
      const targetKey = `${item.type}/${item.name}`;
      const prev = seen.get(targetKey);
      if (prev !== undefined) {
        throw new ConfigError(
          `${path}: duplicate ${item.type} target "${item.name}" declared as ${prev} and ${entry}`,
        );
      }
      seen.set(targetKey, entry);
      items.push(item);
    });
  }
  return items;
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

  const userScope: ScopeConfig = {
    scope: "user",
    install: parseInstall(user, userPath, "user", userSources),
    vars: mergeVars(asObject(user.vars, userPath, "vars")),
  };

  let projectScope: ScopeConfig | undefined;
  if (hasProject) {
    // Project install can be declared in the project file and the local file.
    const projectInstall = parseInstall(project, projectPath, "project", sources);
    const localInstall = parseInstall(local, localPath, "project", sources);
    projectScope = {
      scope: "project",
      install: dedupeAcross(projectInstall, localInstall, projectPath),
      vars: mergeVars(
        asObject(user.vars, userPath, "vars"),
        asObject(project.vars, projectPath, "vars"),
        asObject(local.vars, localPath, "vars"),
      ),
      gitignore: boolOr(local.gitignore ?? project.gitignore, true, projectPath, "gitignore"),
    };
  }

  return { sources, checkInterval, user: userScope, project: projectScope };
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

/** Remove install entries matching a name (optionally scoped to a source). */
export function removeInstallEntries(path: string, name: string, source?: string): number {
  const cfg = loadRaw(path);
  const install = cfg.install as Record<string, unknown> | undefined;
  if (!install) return 0;
  let removed = 0;
  for (const key of Object.values(INSTALL_KEY)) {
    const list = install[key];
    if (!Array.isArray(list)) continue;
    const kept = (list as string[]).filter((e) => {
      const at = e.lastIndexOf("@");
      const eName = (at > 0 ? e.slice(0, at) : e).replace(/^[a-z]+:/, "");
      const eSource = at > 0 ? e.slice(at + 1) : undefined;
      const match = eName === name && (source === undefined || eSource === source);
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
