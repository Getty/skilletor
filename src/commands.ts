// CLI edit commands (spec §7, §4.3). Each edits only the target config file
// (user by default, project with --project), then syncs. Editing goes through
// config.ts so the declarative config stays the single source of truth.
import { join } from "node:path";
import {
  addInstallEntry, addSource, loadConfig, removeInstallEntries, removeSource,
  type ItemType, type LoadedConfig, type SourceDef,
} from "./config.ts";
import { resolveSpec, type Probe } from "./spec.ts";
import { makeProbe } from "./probe.ts";
import { cacheRootOf, identityOf, makeBackend, sync, type EngineContext } from "./engine.ts";
import type { SyncReport } from "./report.ts";
import { scan } from "./catalog.ts";
import { State } from "./state.ts";
import { readLock } from "./lock.ts";

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
  const inUse = declaredItems(config).some((i) => i.source === args.name);
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

export async function cmdUninstall(
  ctx: CommandContext,
  args: { items: string[]; project?: boolean },
): Promise<SyncReport> {
  const path = configPath(ctx, Boolean(args.project));
  for (const spec of args.items) {
    const { name, source } = parseItemSpec(spec);
    removeInstallEntries(path, name, source);
  }
  return sync(ctx);
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
  return { type, name, source };
}

function declaredItems(config: LoadedConfig): { key: string; source: string }[] {
  const items = [...config.user.install];
  if (config.project) items.push(...config.project.install);
  return items.map((i) => ({ key: i.target, source: i.source }));
}

/** Set of "<typedir>/<name>@<source>" for every declared or locked item. */
function installedSet(ctx: CommandContext, config: LoadedConfig): Set<string> {
  const set = new Set<string>();
  for (const i of declaredItems(config)) set.add(`${i.key}@${i.source}`);
  for (const scope of ["user", "project"] as const) {
    const dir = join(scope === "user" ? ctx.home : ctx.projectDir ?? "", ".claude");
    if (scope === "project" && !ctx.projectDir) continue;
    for (const [key, entry] of Object.entries(readLock(join(dir, "skilletor.lock.json")))) {
      set.add(`${key}@${entry.source}`);
    }
  }
  return set;
}
