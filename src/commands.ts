// CLI edit commands (spec §7, §4.3). Each edits only the target config file
// (user by default, project with --project), then syncs. Editing goes through
// config.ts so the declarative config stays the single source of truth.
import { dirname, join } from "node:path";
import {
  addBundleEntry, addInstallEntry, addSource, bundleEntries, findInstallEntries, findWildcardEntries, loadConfig,
  removeBundleEntries, removeInstallEntries, removeSource, WILDCARD, type BackendKind, type ItemType, type LoadedConfig,
  type Origin, type SourceDef,
} from "./config.ts";
import { BundleError, expandBundle, matchesPattern, sameIdentity, type ForeignEntry } from "./bundles.ts";
import { resolveSpec, type Probe } from "./spec.ts";
import { makeProbe } from "./probe.ts";
import {
  bundleLabel, servingSource, cacheRootOf, makeBackend, projectDirOf, resolveBackend, sourcesOf, sync, type EngineContext,
  type ResolvedBackend,
} from "./engine.ts";
import type { SyncReport } from "./report.ts";
import { scan, type Catalog } from "./catalog.ts";
import { State } from "./state.ts";
import { readLock, type Lock } from "./lock.ts";
import { parseLockKey } from "./targets.ts";

/** Asks the user one question and returns the answer line (spec §15.6). */
export interface Prompter {
  ask(question: string): Promise<string>;
}

export interface CommandContext extends EngineContext {
  probe?: Probe;
  /** Interactive questions; absent = no TTY (the CLI sets it only when stdin and stderr are TTYs). */
  prompt?: Prompter;
}

export class CommandError extends Error {
  override name = "CommandError";
}

/** The project root for --project edits; the home dir as project dir has no project scope. */
function projectRoot(ctx: CommandContext): string {
  const dir = projectDirOf(ctx);
  if (dir) return dir;
  throw new CommandError(
    ctx.projectDir
      ? `no project scope: the project directory is the home directory (${ctx.home}); ` +
          "run from a project, pass --project-dir, or drop --project to edit the user config"
      : "no project scope: no project directory",
  );
}

function configPath(ctx: CommandContext, project: boolean): string {
  const root = project ? projectRoot(ctx) : ctx.home;
  return join(root, ".claude", "skilletor.json");
}

/** Config as the engine sees it: no project config when the project dir is the home dir. */
function load(ctx: CommandContext): LoadedConfig {
  return loadConfig({ home: ctx.home, projectDir: projectDirOf(ctx) });
}

const TYPE_DIR: Record<ItemType, string> = { skill: "skills", agent: "agents", rule: "rules" };

// ---- add --------------------------------------------------------------------

export async function cmdAdd(
  ctx: CommandContext,
  args: { name?: string; spec: string; project?: boolean },
): Promise<{ name: string; def: SourceDef; report: SyncReport }> {
  const path = configPath(ctx, Boolean(args.project));
  const resolved = resolveSpec(args.spec, ctx.probe ?? makeProbe());
  const name = args.name ?? resolved.derivedName;
  const def: SourceDef =
    resolved.kind === "git" ? { git: resolved.value } : resolved.kind === "url" ? { url: resolved.value } : { local: resolved.value };

  addSource(path, name, def);
  // add is the trust act.
  trustDef(ctx, name, def);

  const report = await sync(ctx);
  return { name, def, report };
}

// ---- source list / remove ---------------------------------------------------

/** Every source as the project scope sees it; `origin` is that of the backend it would use. */
export function cmdSourceList(ctx: CommandContext): { name: string; def: SourceDef; origin: Origin }[] {
  const config = load(ctx);
  return [...config.sources.values()].map((s) => ({
    name: s.name,
    def: pickDef(s),
    origin: resolveBackend(s, ctx.home).origin,
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
  const path = configPath(ctx, Boolean(args.project));
  const config = load(ctx);
  const inUse = usedSources(config).has(args.name);
  if (inUse && !args.force) {
    throw new CommandError(`source "${args.name}" still has installed items; use --force to remove anyway`);
  }
  removeSource(path, args.name);
  return sync(ctx);
}

// ---- available --------------------------------------------------------------

export interface AvailableItem {
  /** `bundle` for a bundle of the source (spec §15.5). */
  type: ItemType | "bundle";
  name: string;
  description?: string;
  source: string;
  /** Items: installed in some scope. Bundles: declared in some scope's config. */
  installed: boolean;
  /** Bundles: the expanded members of this source, `type:name`, sorted. */
  members?: string[];
  /** Bundles: the var defaults the bundle file declares. */
  vars?: Record<string, unknown>;
  /** Bundles: why the bundle cannot be expanded (spec §15.4). */
  error?: string;
}

export async function cmdAvailable(ctx: CommandContext, args: { source?: string } = {}): Promise<AvailableItem[]> {
  const config = load(ctx);
  const state = new State(ctx.stateRoot);
  const installedKeys = installedSet(ctx, config);
  const declaredBundles = new Set([...config.user.bundles, ...(config.project?.bundles ?? [])].map(bundleLabel));
  const names = args.source ? [args.source] : [...config.sources.keys()];

  const out: AvailableItem[] = [];
  for (const name of names) {
    // What `install` would read: the user config's definition for a user source (the user
    // scope's, spec §3), the merged one for a source only a project declares.
    const src = config.userSources.get(name) ?? config.sources.get(name);
    if (!src) throw new CommandError(`unknown source: ${name}`);
    const backend = resolveBackend(src, ctx.home);
    if (!state.isTrusted(name, backend)) continue; // only trusted
    const loc = await makeBackend(backend, cacheRootOf(ctx)).resolve();
    const cat = scan(loc.dir);
    for (const item of cat.items) {
      out.push({
        type: item.type,
        name: item.name,
        description: item.description,
        source: name,
        installed: installedKeys.has(`${TYPE_DIR[item.type]}/${item.name}@${name}`),
      });
    }
    for (const b of cat.bundles) {
      const entry: AvailableItem = {
        type: "bundle", name: b.name, description: b.def?.description, source: name,
        installed: declaredBundles.has(bundleLabel({ name: b.name, source: name })),
      };
      try {
        const e = expandBundle(cat, b.name);
        // Members of other sources as written, with their address (spec §15.6).
        entry.members = [...e.items.map((m) => `${m.type}:${m.name}`), ...e.foreign.map((f) => `${f.type}:${f.entry}`)].sort();
        entry.vars = b.def!.vars;
      } catch (err) {
        if (!(err instanceof BundleError)) throw err;
        entry.error = err.message;
      }
      out.push(entry);
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
  const config = load(ctx);
  const state = new State(ctx.stateRoot);
  const catalogs = new Map<string, ReturnType<typeof scan>>();
  // The sources the target scope's sync resolves against (spec §3).
  const sources = sourcesOf(config, args.project ? "project" : "user");

  const catalogOf = async (source: string, backend: ResolvedBackend): Promise<Catalog> => {
    let cat = catalogs.get(source);
    if (!cat) {
      cat = scan((await makeBackend(backend, cacheRootOf(ctx)).resolve()).dir);
      catalogs.set(source, cat);
    }
    return cat;
  };

  // Plan every edit first: a failure (or a missing source without a TTY) edits nothing.
  const edits: (() => void)[] = [];
  const bundles: { name: string; foreign: ForeignEntry[] }[] = [];
  for (const spec of args.items) {
    const { type: explicitType, bundle, name, source } = parseItemSpec(spec);
    const src = sources.get(source);
    if (!src) {
      const hint = !args.project && config.sources.has(source) ? " in the user config (a project declares it: use --project)" : "";
      throw new CommandError(`unknown source: ${source}${hint}`);
    }
    const backend = resolveBackend(src, ctx.home);
    if (!state.isTrusted(source, backend)) {
      throw new CommandError(`source "${source}" is not trusted; run: skilletor trust ${source}`);
    }
    if (name.includes(WILDCARD)) {
      // Expanded at sync time; an empty match is fine here (items may arrive later).
      edits.push(() => addInstallEntry(path, explicitType!, `${name}@${source}`));
      continue;
    }
    const cat = await catalogOf(source, backend);
    const hasBundle = cat.bundles.some((b) => b.name === name);
    const matches = bundle ? [] : cat.items.filter((i) => i.name === name && (!explicitType || i.type === explicitType));
    // Without a prefix, a name only a bundle has is that bundle (spec §15.5).
    if (bundle || (!explicitType && hasBundle && matches.length === 0)) {
      bundles.push({ name, foreign: checkBundle(cat, name, source) });
      edits.push(() => addBundleEntry(path, `${name}@${source}`));
      continue;
    }
    if (matches.length === 0) {
      const suggestions = cat.items.map((i) => `${i.type}:${i.name}`).slice(0, 8).join(", ");
      throw new CommandError(`unknown item "${name}" in ${source}${suggestions ? ` (available: ${suggestions})` : ""}`);
    }
    if (matches.length > 1 || (!explicitType && hasBundle)) {
      const options = matches.map((m) => `${m.type}:${name}@${source}`);
      if (!explicitType && hasBundle) options.push(`bundle:${name}@${source}`);
      throw new CommandError(`"${name}" is ambiguous in ${source}; use one of: ${options.join(", ")}`);
    }
    const type = matches[0]!.type;
    edits.push(() => addInstallEntry(path, type, `${name}@${source}`));
  }
  const additions = await missingSources(ctx, config, bundles, Boolean(args.project));
  for (const a of additions) {
    edits.push(() => {
      addSource(path, a.name, a.def);
      trustDef(ctx, a.name, a.def); // as `add`: adding is the act of trust (§4.3)
    });
  }
  for (const edit of edits) edit();
  return sync(ctx);
}

/**
 * Sources the bundles name by address that no visible configured source serves
 * (spec §15.6). On a TTY each is offered for adding; without one the command fails,
 * printing the `skilletor add` commands. Returns the sources to add.
 */
async function missingSources(
  ctx: CommandContext, config: LoadedConfig, bundles: { name: string; foreign: ForeignEntry[] }[], project: boolean,
): Promise<{ name: string; def: SourceDef; url: string }[]> {
  const scope = project ? "project" : "user";
  const missing: { bundle: string; f: ForeignEntry }[] = [];
  for (const b of bundles) {
    for (const f of b.foreign) {
      if (servingSource(config, scope, f.url) !== undefined) continue;
      if (!missing.some((m) => sameIdentity(m.f.url, f.url))) missing.push({ bundle: b.name, f });
    }
  }
  if (missing.length === 0) return [];
  const taken = new Map([...config.sources.values()].map((s) => [s.name, s.git ?? s.url ?? s.local ?? ""]));
  /** A name is free unless a source with another address holds it. */
  const free = (name: string, url: string) => !taken.has(name) || sameIdentity(taken.get(name)!, url);
  const suggest = (f: ForeignEntry) => {
    if (free(f.derivedName, f.url)) return f.derivedName;
    let n = 2;
    while (!free(`${f.derivedName}-${n}`, f.url)) n++;
    return `${f.derivedName}-${n}`;
  };
  const flag = project ? " --project" : "";
  if (!ctx.prompt) {
    const lines = missing.map((m) => `  skilletor add ${suggest(m.f)} ${m.f.spec}${flag}`);
    const names = [...new Set(missing.map((m) => m.bundle))].join(", ");
    throw new CommandError(
      `bundle ${names} needs sources you don't have yet; nothing was changed. Add them, then install again:\n${lines.join("\n")}`,
    );
  }
  const out: { name: string; def: SourceDef; url: string }[] = [];
  for (const { bundle, f } of missing) {
    const fallback = suggest(f);
    const question = `bundle ${bundle} needs a source you don't have yet: ${f.spec} → ${f.url} — ` +
      `add it as [${fallback}]? (name, or n to skip)`;
    let note = "";
    for (;;) {
      const answer = (await ctx.prompt.ask(note + question)).trim();
      if (/^(n|no)$/i.test(answer)) break;
      const name = answer || fallback;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        note = `"${name}" is not a valid source name. `;
        continue;
      }
      if (!free(name, f.url)) {
        note = `"${name}" is already a source with another address (${taken.get(name)}). `;
        continue;
      }
      out.push({ name, def: f.kind === "git" ? { git: f.url } : { url: f.url }, url: f.url });
      taken.set(name, f.url);
      break;
    }
  }
  return out;
}

/** A bundle must exist and expand before it is declared (errors of spec §15.4); returns
 *  its entries of other sources. */
function checkBundle(cat: Catalog, name: string, source: string): ForeignEntry[] {
  if (!cat.bundles.some((b) => b.name === name)) {
    const known = cat.bundles.map((b) => b.name).slice(0, 8).join(", ");
    throw new CommandError(`unknown bundle "${name}" in ${source}${known ? ` (available bundles: ${known})` : ""}`);
  }
  try {
    return expandBundle(cat, name).foreign;
  } catch (err) {
    if (err instanceof BundleError) throw new CommandError(`${source}: ${err.message}`);
    throw err;
  }
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
  const lock = readLock(join(dirname(path), "skilletor.lock.json"));
  const parsed = args.items.map((spec) => ({ spec, ...parseItemSpec(spec) }));

  const errors: string[] = [];
  const hints: string[] = [];
  const where = `the ${scopeName} config`;
  const bundlesHere = bundleEntries(path);
  for (const p of parsed) {
    const explicit = p.bundle ? [] : findInstallEntries(path, p.name, p.source, p.type);
    const bundleHit = bundlesHere.some((b) => b.name === p.name && b.source === p.source);
    // Without a prefix, a name declared only as a bundle here is that bundle (spec §15.5).
    if (!p.bundle && !p.type && !p.name.includes(WILDCARD) && bundleHit) {
      if (explicit.length) {
        errors.push(`${p.name}@${p.source} is ambiguous in ${where}: it names a bundle and ` +
          `${explicit.map((e) => `${e.type}:${p.name}@${p.source}`).join(", ")}; use a prefix (bundle:${p.name}@${p.source})`);
      } else {
        p.bundle = true;
      }
      continue;
    }
    if (p.bundle) {
      if (!bundleHit) {
        errors.push(`bundle:${p.name}@${p.source} is not declared in ${where} (${path})${bundleElsewhere(ctx, p, project)}`);
      }
      continue;
    }
    const label = p.type ? `${p.type}:${p.name}@${p.source}` : `${p.name}@${p.source}`;
    const cover = p.name.includes(WILDCARD)
      ? { source: p.source, wilds: [], bundles: [], confirmed: false }
      : covering(path, lock, bundlesHere, p.name, p.source, p.type, explicit.map((e) => e.type));
    const text = coverText(cover);
    if (explicit.length === 0) {
      if (text && cover.confirmed) {
        errors.push(
          `${label} is not declared explicitly; it is installed by the ${text} in ${where}. To drop it, ` +
            wayOut(cover, project),
        );
      } else if (text) {
        errors.push(
          `${label} is not declared in ${where} (${path}); the ${text} there installs every matching item of its type ` +
            `from ${p.source}, so if ${p.source} offers it: ${wayOut(cover, project)}`,
        );
      } else {
        errors.push(`${label} is not declared in ${where} (${path})${declaredElsewhere(ctx, path, p, project)}`);
      }
    } else if (text) {
      hints.push(
        `${label} removed, but the ${text} in ${where} still installs it on the next sync. To drop it, ` +
          wayOut(cover, project),
      );
    }
  }
  if (errors.length) throw new CommandError(errors.join("\n"));

  for (const p of parsed) {
    if (p.bundle) removeBundleEntries(path, p.name, p.source);
    else removeInstallEntries(path, p.name, p.source, p.type);
  }
  return { report: await sync(ctx), hints };
}

interface Cover {
  source: string;
  /** Wildcards (patterns) of this config that match the item, per type. */
  wilds: { type: ItemType; pattern: string }[];
  /** Bundle labels of this config that the lock records as declaring the item. */
  bundles: string[];
  /** The scope's lock shows the item installed (or skipped) under a covering entry. */
  confirmed: boolean;
}

/**
 * Wildcards and bundles in one config that install `name@source`. A wildcard's type
 * comes from the prefix, else from the explicit entries being removed plus the scope's
 * lock; if neither knows it, every matching wildcard of the source counts. A bundle
 * counts when the lock records it in the item's `via` (spec §15.5).
 */
function covering(
  path: string, lock: Lock, bundlesHere: { name: string; source: string }[],
  name: string, source: string, type: ItemType | undefined, explicitTypes: ItemType[],
): Cover {
  const found = findWildcardEntries(path, source, type)
    .filter((w) => matchesPattern(w.pattern, name))
    .map((w) => ({ type: w.type, pattern: w.pattern }));
  // Any target's entry counts (claude `skills/x`, codex `codex:skills/x`, spec §14.3).
  const locked = (t?: ItemType) => Object.entries(lock).filter(([key, e]) => {
    const k = parseLockKey(key);
    return k.name === name && (!t || k.type === t) && e.source === source;
  });
  const inLock = (t: ItemType) => locked(t).length > 0;
  const labels = new Set(bundlesHere.map(bundleLabel));
  const bundles = [...new Set(locked(type).flatMap(([, e]) => (e.via ?? []).filter((v) => labels.has(v))))];
  const confirmed = bundles.length > 0 || found.some((w) => inLock(w.type));
  if (type) return { source, wilds: found, bundles, confirmed };
  const known = found.filter((w) => explicitTypes.includes(w.type) || inLock(w.type));
  return { source, wilds: known.length || explicitTypes.length ? known : found, bundles, confirmed };
}

/** The covering wildcards as written with their type (`rule:perl-*@shared`), then the bundles. */
function coverEntries(c: Cover): string[] {
  return [...c.wilds.map((w) => `${w.type}:${w.pattern}@${c.source}`), ...c.bundles];
}

function coverText(c: Cover): string {
  const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
  const parts: string[] = [];
  const wilds = coverEntries(c).slice(0, c.wilds.length);
  if (wilds.length) parts.push(`${plural(wilds.length, "wildcard")} ${wilds.join(", ")}`);
  if (c.bundles.length) parts.push(`${plural(c.bundles.length, "bundle")} ${c.bundles.join(", ")}`);
  return parts.join(" and ");
}

function wayOut(c: Cover, project: boolean): string {
  const flag = project ? " --project" : "";
  const cmds = coverEntries(c).map((e) => `skilletor uninstall '${e}'${flag}`).join(" or ");
  const what = !c.bundles.length ? "the wildcard" : !c.wilds.length ? "the bundle" : "them";
  return `uninstall ${what} (${cmds}), or keep it and gate the item via vars ` +
    `if its template renders empty for some value (an empty render is skipped).`;
}

/** Where else a bundle is declared: the other scope's config. */
function bundleElsewhere(ctx: CommandContext, p: { name: string; source: string }, project: boolean): string {
  if (!project && !projectDirOf(ctx)) return "";
  const hit = bundleEntries(configPath(ctx, !project)).some((b) => b.name === p.name && b.source === p.source);
  if (!hit) return "";
  return project
    ? "; the user config declares it (run without --project)"
    : "; the project config declares it (use --project)";
}

/** Where else the item is declared: under another type here, or in the other scope's config. */
function declaredElsewhere(
  ctx: CommandContext, path: string, p: { name: string; source: string; type?: ItemType }, project: boolean,
): string {
  if (p.type) {
    const other = findInstallEntries(path, p.name, p.source).map((e) => `${e.type}:${p.name}@${p.source}`);
    if (other.length) return `; it is declared as ${other.join(", ")}`;
  }
  if (!project && !projectDirOf(ctx)) return "";
  const otherPath = configPath(ctx, !project);
  const hit = findInstallEntries(otherPath, p.name, p.source, p.type).length > 0 ||
    (!p.name.includes(WILDCARD) &&
      findWildcardEntries(otherPath, p.source, p.type).some((w) => matchesPattern(w.pattern, p.name)));
  if (!hit) return "";
  return project
    ? "; the user config declares it (run without --project)"
    : "; the project config declares it (use --project)";
}

// ---- trust ------------------------------------------------------------------

/**
 * Trust a source for the backend the project scope would use now (spec §3, §4.3): its kind
 * and address (`url`; a local path for a local backend). Replaces an earlier entry, so trust
 * does not carry over when the chosen backend switches.
 */
export function cmdTrust(ctx: CommandContext, args: { name: string }): { name: string; kind: BackendKind; url: string } {
  const config = load(ctx);
  const src = config.sources.get(args.name);
  if (!src) throw new CommandError(`unknown source: ${args.name}`);
  const backend = resolveBackend(src, ctx.home);
  new State(ctx.stateRoot).trust(args.name, backend);
  return { name: args.name, kind: backend.kind, url: backend.address };
}

/** Trust a source definition just written by `add` (or a bundle's missing source): the
 *  backend it names, normalized by the one resolver (spec §4.3). */
function trustDef(ctx: CommandContext, name: string, def: SourceDef): void {
  new State(ctx.stateRoot).trust(name, resolveBackend({ name, ...def, origins: {} }, ctx.home));
}

// ---- helpers ----------------------------------------------------------------

/** `[type:]name@source`, `type:pattern@source` or `bundle:name@source` (spec §7, §15.5). */
function parseItemSpec(spec: string): { type?: ItemType; bundle?: boolean; name: string; source: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new CommandError(`item "${spec}" must be name@source (or type:name@source)`);
  }
  const source = spec.slice(at + 1);
  let name = spec.slice(0, at);
  let type: ItemType | undefined;
  let bundle: boolean | undefined;
  const colon = name.indexOf(":");
  if (colon !== -1) {
    const prefix = name.slice(0, colon);
    if (prefix === "bundle") bundle = true;
    else if (prefix === "skill" || prefix === "agent" || prefix === "rule") type = prefix;
    else throw new CommandError(`unknown type prefix "${prefix}" in "${spec}"`);
    name = name.slice(colon + 1);
  }
  if (name === "") throw new CommandError(`item "${spec}" has an empty name`);
  if (bundle) {
    if (name.includes(WILDCARD)) throw new CommandError(`"${spec}": patterns over bundle names are not supported`);
    return { bundle, name, source };
  }
  if (name.includes(WILDCARD) && !type) {
    throw new CommandError(
      `wildcard "${spec}" needs a type prefix: rule:${name}@${source}, skill:${name}@${source} or agent:${name}@${source}`,
    );
  }
  return { type, name, source };
}

function declaredItems(config: LoadedConfig): { key: string; source: string }[] {
  const items = [...config.user.install];
  if (config.project) items.push(...config.project.install);
  return items.map((i) => ({ key: i.target, source: i.source }));
}

/** Sources referenced by an explicit entry, a wildcard or a bundle, in any scope. */
function usedSources(config: LoadedConfig): Set<string> {
  const used = new Set(declaredItems(config).map((i) => i.source));
  for (const scope of [config.user, config.project]) {
    for (const w of [...(scope?.wildcards ?? []), ...(scope?.bundles ?? [])]) used.add(w.source);
  }
  return used;
}

/** Set of "<typedir>/<name>@<source>" for every declared or locked item. */
function installedSet(ctx: CommandContext, config: LoadedConfig): Set<string> {
  const set = new Set<string>();
  for (const i of declaredItems(config)) set.add(`${i.key}@${i.source}`);
  const projectDir = projectDirOf(ctx);
  for (const scope of ["user", "project"] as const) {
    const dir = join(scope === "user" ? ctx.home : projectDir ?? "", ".claude");
    if (scope === "project" && !projectDir) continue;
    for (const [key, entry] of Object.entries(readLock(join(dir, "skilletor.lock.json")))) {
      if (entry.skipped) continue; // renders empty here: nothing installed
      set.add(`${parseLockKey(key).target}@${entry.source}`); // any target counts
    }
  }
  return set;
}
