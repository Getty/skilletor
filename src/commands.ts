// CLI edit commands (spec §7, §4.3). Each edits only the target config file
// (user by default, project with --project), then syncs. Editing goes through
// config.ts so the declarative config stays the single source of truth.
import { join } from "node:path";
import {
  addInstallEntry, addSource, findInstallEntries, loadConfig, removeInstallEntries, removeSource, WILDCARD,
  type ItemType, type LoadedConfig, type SourceDef,
} from "./config.ts";
import { resolveSpec, type Probe } from "./spec.ts";
import { makeProbe } from "./probe.ts";
import { cacheRootOf, identityOf, makeBackend, sync, type EngineContext } from "./engine.ts";
import type { SyncReport } from "./report.ts";
import { scan } from "./catalog.ts";
import { State } from "./state.ts";
import { readLock, type Lock } from "./lock.ts";
import { parseLockKey } from "./targets.ts";

export interface CommandContext extends EngineContext {
  probe?: Probe;
}

export class CommandError extends Error {
  override name = "CommandError";
}

function configPath(ctx: CommandContext, project: boolean): string {
  const root = project ? ctx.projectDir! : ctx.home;
  return join(root, ".claude", "skilletor.json");
}

const TYPE_DIR: Record<ItemType, string> = { skill: "skills", agent: "agents", rule: "rules" };

// ---- add --------------------------------------------------------------------

export async function cmdAdd(
  ctx: CommandContext,
  args: { name?: string; spec: string; project?: boolean },
): Promise<{ name: string; def: SourceDef; report: SyncReport }> {
  const resolved = resolveSpec(args.spec, ctx.probe ?? makeProbe());
  const name = args.name ?? resolved.derivedName;
  const def: SourceDef =
    resolved.kind === "git" ? { git: resolved.value } : resolved.kind === "url" ? { url: resolved.value } : { local: resolved.value };

  addSource(configPath(ctx, Boolean(args.project)), name, def);
  // add is the trust act.
  new State(ctx.stateRoot).trust(name, resolved.value);

  const report = await sync(ctx);
  return { name, def, report };
}

// ---- source list / remove ---------------------------------------------------

export function cmdSourceList(ctx: CommandContext): { name: string; def: SourceDef; origin: "user" | "project" }[] {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  return [...config.sources.values()].map((s) => ({
    name: s.name,
    def: pickDef(s),
    origin: s.origin,
  }));
}

function pickDef(s: { git?: string; ref?: string; url?: string; local?: string }): SourceDef {
  const def: SourceDef = {};
  if (s.git) def.git = s.git;
  if (s.ref) def.ref = s.ref;
  if (s.url) def.url = s.url;
  if (s.local) def.local = s.local;
  return def;
}

export async function cmdSourceRemove(
  ctx: CommandContext,
  args: { name: string; project?: boolean; force?: boolean },
): Promise<SyncReport> {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const inUse = usedSources(config).has(args.name);
  if (inUse && !args.force) {
    throw new CommandError(`source "${args.name}" still has installed items; use --force to remove anyway`);
  }
  removeSource(configPath(ctx, Boolean(args.project)), args.name);
  return sync(ctx);
}

// ---- available --------------------------------------------------------------

export interface AvailableItem {
  type: ItemType;
  name: string;
  description?: string;
  source: string;
  installed: boolean;
}

export async function cmdAvailable(ctx: CommandContext, args: { source?: string } = {}): Promise<AvailableItem[]> {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const state = new State(ctx.stateRoot);
  const installedKeys = installedSet(ctx, config);
  const names = args.source ? [args.source] : [...config.sources.keys()];

  const out: AvailableItem[] = [];
  for (const name of names) {
    const src = config.sources.get(name);
    if (!src) throw new CommandError(`unknown source: ${name}`);
    if (!state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) continue; // only trusted
    const loc = await makeBackend(src, ctx.home, cacheRootOf(ctx)).resolve();
    for (const item of scan(loc.dir).items) {
      out.push({
        type: item.type,
        name: item.name,
        description: item.description,
        source: name,
        installed: installedKeys.has(`${TYPE_DIR[item.type]}/${item.name}@${name}`),
      });
    }
  }
  return out;
}

// ---- install / uninstall ----------------------------------------------------

export async function cmdInstall(
  ctx: CommandContext,
  args: { items: string[]; project?: boolean },
): Promise<SyncReport> {
  const path = configPath(ctx, Boolean(args.project));
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const state = new State(ctx.stateRoot);
  const catalogs = new Map<string, ReturnType<typeof scan>>();

  for (const spec of args.items) {
    const { type: explicitType, name, source } = parseItemSpec(spec);
    const src = config.sources.get(source);
    if (!src) throw new CommandError(`unknown source: ${source}`);
    if (!state.isTrusted({ name: source, resolved: identityOf(src), origin: src.origin })) {
      throw new CommandError(`source "${source}" is not trusted; run: skilletor trust ${source}`);
    }
    if (name === WILDCARD) {
      // Expanded at sync time; an empty type is fine (items may arrive later).
      addInstallEntry(path, explicitType!, `${WILDCARD}@${source}`);
      continue;
    }
    let cat = catalogs.get(source);
    if (!cat) {
      cat = scan((await makeBackend(src, ctx.home, cacheRootOf(ctx)).resolve()).dir);
      catalogs.set(source, cat);
    }
    const matches = cat.items.filter((i) => i.name === name && (!explicitType || i.type === explicitType));
    if (matches.length === 0) {
      const suggestions = cat.items.map((i) => `${i.type}:${i.name}`).slice(0, 8).join(", ");
      throw new CommandError(`unknown item "${name}" in ${source}${suggestions ? ` (available: ${suggestions})` : ""}`);
    }
    if (matches.length > 1) {
      const types = matches.map((m) => `${m.type}:${name}@${source}`).join(", ");
      throw new CommandError(`"${name}" is ambiguous in ${source}; use one of: ${types}`);
    }
    addInstallEntry(path, matches[0]!.type, `${name}@${source}`);
  }
  return sync(ctx);
}

export interface UninstallResult {
  report: SyncReport;
  /** One line per removed item that a wildcard in the same config still installs. */
  hints: string[];
}

/**
 * Remove install entries from one config (user, or project with --project),
 * then sync. A type prefix restricts removal to that type's list. Every item is
 * checked before anything is edited: an item with no explicit entry in that
 * config is an error (naming the wildcard that installs it, or the other
 * config that declares it) and leaves the config untouched.
 */
export async function cmdUninstall(
  ctx: CommandContext,
  args: { items: string[]; project?: boolean },
): Promise<UninstallResult> {
  const project = Boolean(args.project);
  const path = configPath(ctx, project);
  const scopeName = project ? "project" : "user";
  const lock = readLock(join(project ? ctx.projectDir! : ctx.home, ".claude", "skilletor.lock.json"));
  const parsed = args.items.map((spec) => ({ spec, ...parseItemSpec(spec) }));

  const errors: string[] = [];
  const hints: string[] = [];
  for (const p of parsed) {
    const label = p.type ? `${p.type}:${p.name}@${p.source}` : `${p.name}@${p.source}`;
    const explicit = findInstallEntries(path, p.name, p.source, p.type);
    const cover = p.name === WILDCARD
      ? { types: [], confirmed: false }
      : coveringWildcards(path, lock, p.name, p.source, p.type, explicit.map((e) => e.type));
    const wild = cover.types.length ? wildcardText(cover.types, p.source) : "";
    const where = `the ${scopeName} config`;
    if (explicit.length === 0) {
      if (wild && cover.confirmed) {
        errors.push(
          `${label} is not declared explicitly; it is installed by the ${wild} in ${where}. To drop it, ` +
            wayOut(cover.types, p.source, project),
        );
      } else if (wild) {
        errors.push(
          `${label} is not declared in ${where} (${path}); the ${wild} there installs every item of its type ` +
            `from ${p.source}, so if ${p.source} offers it: ${wayOut(cover.types, p.source, project)}`,
        );
      } else {
        errors.push(`${label} is not declared in ${where} (${path})${declaredElsewhere(ctx, path, p, project)}`);
      }
    } else if (wild) {
      hints.push(
        `${label} removed, but the ${wild} in ${where} still installs it on the next sync. To drop it, ` +
          wayOut(cover.types, p.source, project),
      );
    }
  }
  if (errors.length) throw new CommandError(errors.join("\n"));

  for (const p of parsed) removeInstallEntries(path, p.name, p.source, p.type);
  return { report: await sync(ctx), hints };
}

/**
 * Wildcards in one config that install `name@source`. The item's type comes from
 * the prefix, else from the explicit entries being removed plus the scope's lock;
 * if neither knows it, every wildcard of the source counts. `confirmed` = the
 * scope's lock shows the item installed (or skipped) under a covering wildcard's type.
 */
function coveringWildcards(
  path: string, lock: Lock, name: string, source: string, type: ItemType | undefined, explicitTypes: ItemType[],
): { types: ItemType[]; confirmed: boolean } {
  const found = findInstallEntries(path, WILDCARD, source, type).map((w) => w.type);
  // Any target's entry counts (claude `skills/x`, codex `codex:skills/x`, spec §14.3).
  const inLock = (t: ItemType) => Object.entries(lock).some(([key, e]) => {
    const k = parseLockKey(key);
    return k.target === `${TYPE_DIR[t]}/${name}` && e.source === source;
  });
  const confirmed = found.some(inLock);
  if (type) return { types: found, confirmed };
  const known = found.filter((t) => explicitTypes.includes(t) || inLock(t));
  return { types: known.length || explicitTypes.length ? known : found, confirmed };
}

function wildcardText(types: ItemType[], source: string): string {
  const names = types.map((t) => `${t}:${WILDCARD}@${source}`);
  return names.length === 1 ? `wildcard ${names[0]}` : `wildcards ${names.join(", ")}`;
}

function wayOut(types: ItemType[], source: string, project: boolean): string {
  const flag = project ? " --project" : "";
  const cmds = types.map((t) => `skilletor uninstall '${t}:${WILDCARD}@${source}'${flag}`).join(" or ");
  return `uninstall the wildcard (${cmds}), or keep it and gate the item via vars ` +
    `if its template renders empty for some value (an empty render is skipped).`;
}

/** Where else the item is declared: under another type here, or in the other scope's config. */
function declaredElsewhere(
  ctx: CommandContext, path: string, p: { name: string; source: string; type?: ItemType }, project: boolean,
): string {
  if (p.type) {
    const other = findInstallEntries(path, p.name, p.source).map((e) => `${e.type}:${p.name}@${p.source}`);
    if (other.length) return `; it is declared as ${other.join(", ")}`;
  }
  if (!project && !ctx.projectDir) return "";
  const otherPath = configPath(ctx, !project);
  const hit = findInstallEntries(otherPath, p.name, p.source, p.type).length > 0 ||
    (p.name !== WILDCARD && findInstallEntries(otherPath, WILDCARD, p.source, p.type).length > 0);
  if (!hit) return "";
  return project
    ? "; the user config declares it (run without --project)"
    : "; the project config declares it (use --project)";
}

// ---- trust ------------------------------------------------------------------

export function cmdTrust(ctx: CommandContext, args: { name: string }): { name: string; url: string } {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const src = config.sources.get(args.name);
  if (!src) throw new CommandError(`unknown source: ${args.name}`);
  const url = identityOf(src);
  new State(ctx.stateRoot).trust(args.name, url);
  return { name: args.name, url };
}

// ---- helpers ----------------------------------------------------------------

function parseItemSpec(spec: string): { type?: ItemType; name: string; source: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new CommandError(`item "${spec}" must be name@source (or type:name@source)`);
  }
  const source = spec.slice(at + 1);
  let name = spec.slice(0, at);
  let type: ItemType | undefined;
  const colon = name.indexOf(":");
  if (colon !== -1) {
    const prefix = name.slice(0, colon);
    if (prefix !== "skill" && prefix !== "agent" && prefix !== "rule") {
      throw new CommandError(`unknown type prefix "${prefix}" in "${spec}"`);
    }
    type = prefix;
    name = name.slice(colon + 1);
  }
  if (name === WILDCARD && !type) {
    throw new CommandError(
      `wildcard "${spec}" needs a type prefix: rule:*@${source}, skill:*@${source} or agent:*@${source}`,
    );
  }
  return { type, name, source };
}

function declaredItems(config: LoadedConfig): { key: string; source: string }[] {
  const items = [...config.user.install];
  if (config.project) items.push(...config.project.install);
  return items.map((i) => ({ key: i.target, source: i.source }));
}

/** Sources referenced by an explicit entry or a wildcard, in any scope. */
function usedSources(config: LoadedConfig): Set<string> {
  const used = new Set(declaredItems(config).map((i) => i.source));
  for (const w of [...config.user.wildcards, ...(config.project?.wildcards ?? [])]) used.add(w.source);
  return used;
}

/** Set of "<typedir>/<name>@<source>" for every declared or locked item. */
function installedSet(ctx: CommandContext, config: LoadedConfig): Set<string> {
  const set = new Set<string>();
  for (const i of declaredItems(config)) set.add(`${i.key}@${i.source}`);
  for (const scope of ["user", "project"] as const) {
    const dir = join(scope === "user" ? ctx.home : ctx.projectDir ?? "", ".claude");
    if (scope === "project" && !ctx.projectDir) continue;
    for (const [key, entry] of Object.entries(readLock(join(dir, "skilletor.lock.json")))) {
      if (entry.skipped) continue; // renders empty here: nothing installed
      set.add(`${parseLockKey(key).target}@${entry.source}`); // any target counts
    }
  }
  return set;
}
