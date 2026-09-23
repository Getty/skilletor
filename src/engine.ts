// The engine: wire config, sources, catalog, render, apply, lock, state and
// report into sync / check / status (spec §6.1, §6.6, §7). Never throws through
// to process exit without a message: a config error touches nothing, a fetch
// error falls back to the cache with a warning, a template error leaves the item
// as it was.
import { execFileSync } from "node:child_process";
import { hostname, platform, userInfo } from "node:os";
import { basename, join } from "node:path";
import {
  loadConfig, type ItemType, type LoadedConfig, type ResolvedSource, type ScopeConfig, type WildcardItem,
} from "./config.ts";
import { LocalSource } from "./sources/local.ts";
import { GitSource } from "./sources/git.ts";
import { UrlSource } from "./sources/url.ts";
import type { Source } from "./sources/types.ts";
import { scan, type Catalog } from "./catalog.ts";
import { build, type RenderContext } from "./render.ts";
import { apply, isValidItemName, type PlanItem } from "./apply.ts";
import { readLock, type Lock } from "./lock.ts";
import { State } from "./state.ts";
import { updateGitignore } from "./gitignore.ts";
import {
  emptyScopeReport, keyToTypeName, type ItemChange, type ScopeReport, type SyncReport,
} from "./report.ts";

export interface EngineContext {
  home: string;
  projectDir?: string;
  stateRoot: string;
  cacheRoot?: string;
  host?: { name: string; os: string };
  user?: { name: string; home: string };
  /** Per-source network timeout (the SessionStart hook uses 5 s). */
  timeoutMs?: number;
}

export interface SyncOptions {
  scope?: "user" | "project" | "all";
  force?: boolean;
}

type ScopeName = "user" | "project";

export function cacheRootOf(ctx: EngineContext): string {
  return ctx.cacheRoot ?? join(ctx.stateRoot, "cache");
}

export function targetDirOf(ctx: EngineContext, scope: ScopeName): string {
  return join(scope === "user" ? ctx.home : ctx.projectDir!, ".claude");
}

export function identityOf(src: ResolvedSource): string {
  return src.git ?? src.url ?? src.local ?? "";
}

export function makeBackend(src: ResolvedSource, home: string, cacheRoot: string, timeoutMs?: number): Source {
  if (src.local) {
    const ls = new LocalSource(src.local, home);
    if (ls.exists()) return ls; // author mode overrides git/url
  }
  if (src.git) return new GitSource({ url: src.git, ref: src.ref, cacheRoot, timeoutMs });
  if (src.url) return new UrlSource({ url: src.url, cacheRoot, timeoutMs });
  if (src.local) return new LocalSource(src.local, home); // missing dir -> resolve errors
  throw new Error(`source ${src.name} has no backend`);
}

/** Every source a scope references, through explicit entries or wildcards. */
export function scopeSources(scopeCfg: ScopeConfig): string[] {
  return [...new Set([...scopeCfg.install, ...scopeCfg.wildcards].map((i) => i.source))];
}

const TYPE_DIR: Record<ItemType, string> = { skill: "skills", agent: "agents", rule: "rules" };

function sourceVersion(lock: Lock, sourceName: string): string | undefined {
  for (const entry of Object.values(lock)) if (entry.source === sourceName) return entry.version;
  return undefined;
}

function gitRemote(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function makeContext(
  ctx: EngineContext,
  scope: ScopeName,
  targetDir: string,
  item: { type: ItemType; name: string; source: string },
  scopeVars: Record<string, unknown>,
  sourceVars: Record<string, unknown>,
): RenderContext {
  return {
    vars: { ...sourceVars, ...scopeVars },
    project:
      scope === "project"
        ? { dir: ctx.projectDir!, name: basename(ctx.projectDir!), git_remote: gitRemote(ctx.projectDir!) }
        : undefined,
    scope,
    target: { dir: targetDir },
    host: ctx.host ?? { name: hostname(), os: platform() },
    user: ctx.user ?? { name: userInfo().username, home: ctx.home },
    item: { name: item.name, type: item.type, source: item.source },
  };
}

// ---- sync -------------------------------------------------------------------

export async function sync(ctx: EngineContext, opts: SyncOptions = {}): Promise<SyncReport> {
  const state = new State(ctx.stateRoot);
  return state.withLock(() => syncInner(ctx, opts, state));
}

async function syncInner(ctx: EngineContext, opts: SyncOptions, state: State): Promise<SyncReport> {
  let config: LoadedConfig;
  try {
    config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  } catch (err) {
    return { scopes: [], error: (err as Error).message };
  }
  const sel = opts.scope ?? "all";
  const report: SyncReport = { scopes: [] };
  if (sel === "user" || sel === "all") {
    report.scopes.push(await syncScope(ctx, config, config.user, "user", opts, state));
  }
  if ((sel === "project" || sel === "all") && config.project) {
    report.scopes.push(await syncScope(ctx, config, config.project, "project", opts, state));
  }
  return report;
}

async function syncScope(
  ctx: EngineContext,
  config: LoadedConfig,
  scopeCfg: ScopeConfig,
  scope: ScopeName,
  opts: SyncOptions,
  state: State,
): Promise<ScopeReport> {
  const rep = emptyScopeReport(scope);
  const targetDir = targetDirOf(ctx, scope);
  const cacheRoot = cacheRootOf(ctx);
  const lockPath = join(targetDir, "skilletor.lock.json");
  const oldLock = readLock(lockPath);

  // Resolve every needed source in parallel (skip untrusted, warn on failure).
  const needed = scopeSources(scopeCfg);
  const resolved = new Map<string, { dir: string; version: string } | null>();
  await Promise.all(
    needed.map(async (name) => {
      const src = config.sources.get(name);
      if (!src) {
        rep.warnings.push(`unknown source: ${name}`);
        resolved.set(name, null);
        return;
      }
      if (!state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) {
        rep.trustRequests.push({ name, url: identityOf(src) });
        resolved.set(name, null);
        return;
      }
      try {
        const loc = await makeBackend(src, ctx.home, cacheRoot, ctx.timeoutMs).resolve(sourceVersion(oldLock, name));
        if (loc.warning) rep.warnings.push(loc.warning);
        resolved.set(name, { dir: loc.dir, version: loc.version });
      } catch (err) {
        rep.warnings.push(`source ${name}: ${(err as Error).message}`);
        resolved.set(name, null);
      }
    }),
  );

  // Build each declared item; keep (don't delete) items whose source is unavailable.
  const plan: PlanItem[] = [];
  const keep: string[] = [];
  const catalogs = new Map<string, Catalog | null>();
  const keyInfo = new Map<string, ItemChange>();

  /** The source's catalog, or null (warned once) when it is unresolved or unscannable. */
  const catalogOf = (source: string): Catalog | null => {
    if (catalogs.has(source)) return catalogs.get(source)!;
    const r = resolved.get(source);
    let cat: Catalog | null = null;
    if (r) {
      try {
        cat = scan(r.dir);
      } catch (err) {
        rep.warnings.push(`source ${source}: ${(err as Error).message}`);
      }
    }
    catalogs.set(source, cat);
    return cat;
  };
  const keepIfLocked = (key: string) => {
    if (key in oldLock) keep.push(key);
  };

  const buildItem = (item: { type: ItemType; name: string; source: string; target: string }) => {
    keyInfo.set(item.target, { key: item.target, type: item.type, name: item.name, source: item.source });
    const r = resolved.get(item.source);
    const cat = catalogOf(item.source);
    if (!r || !cat) {
      keepIfLocked(item.target);
      return;
    }
    const catItem = cat.items.find((ci) => ci.type === item.type && ci.name === item.name);
    if (!catItem) {
      rep.warnings.push(`item not found in source ${item.source}: ${item.type} ${item.name}`);
      keepIfLocked(item.target);
      return;
    }
    let output: Map<string, Buffer>;
    try {
      output = build(catItem, r.dir, makeContext(ctx, scope, targetDir, item, scopeCfg.vars, cat.meta.vars ?? {}));
    } catch (err) {
      rep.warnings.push(`template error in ${item.type} ${item.name}: ${(err as Error).message}`);
      keepIfLocked(item.target);
      return;
    }
    plan.push({ key: item.target, type: item.type, name: item.name, source: item.source, version: r.version, output });
  };

  const explicit = new Map<string, { source: string; raw: string }>();
  for (const item of scopeCfg.install) {
    explicit.set(item.target, { source: item.source, raw: item.raw });
    buildItem(item);
  }

  // Expand wildcards (spec §3, §6.1). An unresolvable source offers what it
  // installed before, so its items are kept and still count for collisions.
  const offers = new Map<string, { type: ItemType; name: string; from: WildcardItem[]; live: boolean }>();
  const offer = (w: WildcardItem, name: string, live: boolean) => {
    const target = `${TYPE_DIR[w.type]}/${name}`;
    const o = offers.get(target) ?? { type: w.type, name, from: [], live };
    o.from.push(w);
    offers.set(target, o);
  };
  for (const w of scopeCfg.wildcards) {
    const cat = catalogOf(w.source);
    if (cat) {
      for (const ci of cat.items) if (ci.type === w.type) offer(w, ci.name, true);
    } else {
      for (const [key, entry] of Object.entries(oldLock)) {
        const tn = keyToTypeName(key);
        if (entry.source === w.source && tn.type === w.type) offer(w, tn.name, false);
      }
    }
  }
  for (const [target, o] of offers) {
    const claim = explicit.get(target);
    if (claim) {
      for (const w of o.from) {
        if (w.source !== claim.source) {
          rep.warnings.push(`${o.type} "${o.name}" from ${w.raw} ignored: explicitly declared as ${claim.raw}`);
        }
      }
      continue;
    }
    if (o.from.length > 1) {
      rep.warnings.push(`${o.type} "${o.name}" offered by ${o.from.map((w) => w.raw).join(" and ")}; skipped`);
      keepIfLocked(target);
      continue;
    }
    const w = o.from[0]!;
    if (!o.live) {
      keepIfLocked(target);
      continue;
    }
    if (!isValidItemName(o.name)) {
      rep.warnings.push(`${o.type} "${o.name}" from ${w.raw} skipped: invalid item name`);
      continue;
    }
    buildItem({ type: o.type, name: o.name, source: w.source, target });
  }

  const result = apply(plan, { targetDir, force: opts.force, keep });

  if (scope === "project") {
    const newLock = readLock(lockPath);
    const managed = Object.values(newLock).flatMap((e) => Object.keys(e.files));
    updateGitignore({ claudeDir: targetDir, managedPaths: managed, enabled: scopeCfg.gitignore !== false });
  }

  const toChange = (key: string): ItemChange =>
    keyInfo.get(key) ?? { key, ...keyToTypeName(key), source: oldLock[key]?.source ?? "?" };
  rep.added = result.added.map(toChange);
  rep.updated = result.updated.map(toChange);
  rep.removed = result.removed.map(toChange);
  rep.unchanged = result.unchanged.map(toChange);
  rep.conflicts = result.conflicts.map((c) => ({ path: c.path }));
  rep.overwritten = result.overwritten.map((c) => ({ path: c.path }));
  return rep;
}

// ---- check ------------------------------------------------------------------

export interface CheckReport {
  changed: boolean;
  sources: { name: string; scope: ScopeName; changed: boolean }[];
  warnings: string[];
  error?: string;
}

export async function check(ctx: EngineContext, opts: SyncOptions = {}): Promise<CheckReport> {
  let config: LoadedConfig;
  try {
    config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  } catch (err) {
    return { changed: false, sources: [], warnings: [], error: (err as Error).message };
  }
  const state = new State(ctx.stateRoot);
  const cacheRoot = cacheRootOf(ctx);
  const sel = opts.scope ?? "all";
  const out: CheckReport = { changed: false, sources: [], warnings: [] };

  const scopes: [ScopeName, ScopeConfig][] = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);

  for (const [scope, scopeCfg] of scopes) {
    const oldLock = readLock(join(targetDirOf(ctx, scope), "skilletor.lock.json"));
    for (const name of scopeSources(scopeCfg)) {
      const src = config.sources.get(name);
      if (!src || !state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) continue;
      try {
        const changed = await makeBackend(src, ctx.home, cacheRoot, ctx.timeoutMs).check(sourceVersion(oldLock, name));
        out.sources.push({ name, scope, changed });
        if (changed) out.changed = true;
      } catch (err) {
        out.warnings.push(`source ${name}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

// ---- status -----------------------------------------------------------------

export interface StatusReport {
  scopes: {
    scope: ScopeName;
    /** `via` names the wildcard entry an item was installed through. */
    declared: { key: string; source: string; installed: boolean; via?: string }[];
    orphans: string[];
    /** Each wildcard with the number of items currently installed through it. */
    wildcards: { type: ItemType; source: string; entry: string; installed: number }[];
    trustRequests: { name: string; url: string }[];
    sourceVersions: Record<string, string>;
  }[];
  error?: string;
}

export function status(ctx: EngineContext, opts: SyncOptions = {}): StatusReport {
  let config: LoadedConfig;
  try {
    config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  } catch (err) {
    return { scopes: [], error: (err as Error).message };
  }
  const state = new State(ctx.stateRoot);
  const sel = opts.scope ?? "all";
  const scopes: [ScopeName, ScopeConfig][] = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);

  const out: StatusReport = { scopes: [] };
  for (const [scope, scopeCfg] of scopes) {
    const lock = readLock(join(targetDirOf(ctx, scope), "skilletor.lock.json"));
    const declaredKeys = new Set(scopeCfg.install.map((i) => i.target));
    const sourceVersions: Record<string, string> = {};
    for (const entry of Object.values(lock)) sourceVersions[entry.source] = entry.version;
    const trustRequests: { name: string; url: string }[] = [];
    for (const name of scopeSources(scopeCfg)) {
      const src = config.sources.get(name);
      if (src && !state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) {
        trustRequests.push({ name, url: identityOf(src) });
      }
    }
    const declared: StatusReport["scopes"][number]["declared"] = scopeCfg.install.map((i) => ({
      key: i.target, source: i.source, installed: i.target in lock,
    }));
    const viaCount = new Map<WildcardItem, number>();
    const orphans: string[] = [];
    for (const [key, entry] of Object.entries(lock)) {
      if (declaredKeys.has(key)) continue;
      const type = keyToTypeName(key).type;
      const w = scopeCfg.wildcards.find((x) => x.source === entry.source && x.type === type);
      if (!w) {
        orphans.push(key);
        continue;
      }
      declared.push({ key, source: entry.source, installed: true, via: w.raw });
      viaCount.set(w, (viaCount.get(w) ?? 0) + 1);
    }
    out.scopes.push({
      scope,
      declared,
      orphans,
      wildcards: scopeCfg.wildcards.map((w) => ({
        type: w.type, source: w.source, entry: w.raw, installed: viaCount.get(w) ?? 0,
      })),
      trustRequests,
      sourceVersions,
    });
  }
  return out;
}
