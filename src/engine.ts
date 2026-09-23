// The engine: wire config, sources, catalog, render, apply, lock, state and
// report into sync / check / status (spec §6.1, §6.6, §7). Never throws through
// to process exit without a message: a config error touches nothing, a fetch
// error falls back to the cache with a warning, a template error leaves the item
// as it was.
import { execFileSync } from "node:child_process";
import { hostname, platform, userInfo } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  loadConfig, type Harness, type ItemType, type LoadedConfig, type ResolvedSource, type ScopeConfig, type WildcardItem,
} from "./config.ts";
import {
  defaultMarkers, detectHarnesses, lockKey, parseLockKey, rootOf, rootOfKey, selectTargets, supports, targetDrift,
  allRoots, type HarnessMarkers, type RootContext, type TargetSelection,
} from "./targets.ts";
import { convertForTarget } from "./convert.ts";
import { LocalSource } from "./sources/local.ts";
import { GitSource } from "./sources/git.ts";
import { UrlSource } from "./sources/url.ts";
import type { Source } from "./sources/types.ts";
import { scan, type Catalog } from "./catalog.ts";
import { build, rendersEmpty, type RenderContext } from "./render.ts";
import { apply, isValidItemName, type PlanItem } from "./apply.ts";
import { readLock, type Lock, type SkipReason } from "./lock.ts";
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
  /** Harness detection markers (spec §14.1); default from `home` and `$CODEX_HOME`. */
  markers?: HarnessMarkers;
  /** `$CODEX_HOME` (spec §14.2): root of user-scope Codex agents and markers; default from the env. */
  codexHome?: string;
}

export interface SyncOptions {
  scope?: "user" | "project" | "all";
  force?: boolean;
}

type ScopeName = "user" | "project";

export function cacheRootOf(ctx: EngineContext): string {
  return ctx.cacheRoot ?? join(ctx.stateRoot, "cache");
}

/** The scope's `.claude` directory: config, lock and the claude target root. */
export function targetDirOf(ctx: EngineContext, scope: ScopeName): string {
  return join(baseOf(ctx, scope), ".claude");
}

/** The directory every target root of a scope lives under: `~` or the project root. */
function baseOf(ctx: EngineContext, scope: ScopeName): string {
  return scope === "user" ? ctx.home : ctx.projectDir!;
}

/** `$CODEX_HOME`, injected or from the environment; empty means unset. */
function codexHomeOf(ctx: EngineContext): string | undefined {
  return (ctx.codexHome ?? process.env.CODEX_HOME) || undefined;
}

/** Active targets per scope (spec §14.1); throws a TargetError when none apply. */
export function targetsOf(ctx: EngineContext, config: LoadedConfig): TargetSelection {
  const markers = ctx.markers ?? defaultMarkers(ctx.home, codexHomeOf(ctx));
  return selectTargets({ user: config.user.targets, project: config.project?.targets }, detectHarnesses(markers), markers);
}

/** Load config and select targets; either failure is one message, nothing touched. */
function loadWithTargets(ctx: EngineContext): { config: LoadedConfig; targets: TargetSelection } | { error: string } {
  try {
    const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
    return { config, targets: targetsOf(ctx, config) };
  } catch (err) {
    return { error: (err as Error).message };
  }
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
  harness: Harness,
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
    harness,
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
  const loaded = loadWithTargets(ctx);
  if ("error" in loaded) return { scopes: [], error: loaded.error };
  const { config, targets } = loaded;
  const sel = opts.scope ?? "all";
  const report: SyncReport = { scopes: [] };
  const noteCounts = new Map<string, number>(); // note kind -> count, reported once per run
  if (sel === "user" || sel === "all") {
    report.scopes.push(await syncScope(ctx, config, config.user, "user", targets.user, opts, state, noteCounts));
  }
  if ((sel === "project" || sel === "all") && config.project) {
    const rep = await syncScope(ctx, config, config.project, "project", targets.project, opts, state, noteCounts);
    rep.warnings.unshift(...targets.warnings);
    report.scopes.push(rep);
  }
  const notes = runNotes(noteCounts);
  if (notes.length) report.notes = notes;
  return report;
}

/** Count one occurrence of a note kind ("unsupported <harness> <type>", "briefing <harness>"). */
function bump(counts: Map<string, number>, kind: string): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

const HARNESS_LABEL: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** The run's notes (spec §14.2, §14.7): one line per harness and kind. */
function runNotes(counts: Map<string, number>): string[] {
  const unsupported = new Map<Harness, string[]>();
  const notes: string[] = [];
  for (const [kind, n] of counts) {
    const [what, harness, type] = kind.split(" ") as [string, Harness, string?];
    if (what === "unsupported") unsupported.set(harness, [...(unsupported.get(harness) ?? []), `${n} ${type}(s)`]);
  }
  for (const [h, parts] of unsupported) {
    const label = HARNESS_LABEL[h];
    notes.push(`${parts.join(" and ")} not installed for ${label} (not supported for ${label} yet)`);
  }
  for (const [kind, n] of counts) {
    const [what, harness] = kind.split(" ") as [string, Harness];
    if (what === "briefing") {
      notes.push(`briefing.skills of ${n} agent(s) not written for ${HARNESS_LABEL[harness]} ` +
        "(Codex ignores an agent file with unknown keys)");
    }
  }
  return notes;
}

async function syncScope(
  ctx: EngineContext,
  config: LoadedConfig,
  scopeCfg: ScopeConfig,
  scope: ScopeName,
  harnesses: Harness[],
  opts: SyncOptions,
  state: State,
  noteCounts: Map<string, number>,
): Promise<ScopeReport> {
  const rep = emptyScopeReport(scope);
  const targetDir = targetDirOf(ctx, scope);
  const base = baseOf(ctx, scope);
  const rc: RootContext = { base, scope, codexHome: codexHomeOf(ctx) };
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
  // Entries this version cannot place (unknown harness prefix) are never touched.
  const keep: string[] = Object.keys(oldLock).filter((key) => rootOfKey(rc, key) === undefined);
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
  /** The active harnesses that receive this type (spec §14.2). */
  const harnessesFor = (type: ItemType) => harnesses.filter((h) => supports(h, type));
  /** Keep the item's lock entries, for every active target, untouched. */
  const keepIfLocked = (target: string, type: ItemType) => {
    for (const h of harnessesFor(type)) {
      const key = lockKey(h, target);
      if (key in oldLock) keep.push(key);
    }
  };

  const buildItem = (item: { type: ItemType; name: string; source: string; target: string }) => {
    const targets = harnessesFor(item.type);
    for (const h of harnesses) {
      if (!targets.includes(h)) bump(noteCounts, `unsupported ${h} ${item.type}`);
    }
    if (targets.length === 0) return;
    for (const h of targets) {
      const key = lockKey(h, item.target);
      keyInfo.set(key, { key, type: item.type, name: item.name, source: item.source });
    }
    const r = resolved.get(item.source);
    const cat = catalogOf(item.source);
    if (!r || !cat) {
      keepIfLocked(item.target, item.type);
      return;
    }
    const catItem = cat.items.find((ci) => ci.type === item.type && ci.name === item.name);
    if (!catItem) {
      rep.warnings.push(`item not found in source ${item.source}: ${item.type} ${item.name}`);
      keepIfLocked(item.target, item.type);
      return;
    }
    // Rendered once per target, with that target's harness and root (spec §14.3).
    for (const h of targets) {
      const key = lockKey(h, item.target);
      const root = rootOf(rc, h, item.type)!;
      let output: Map<string, Buffer>;
      try {
        output = build(catItem, r.dir, makeContext(ctx, scope, h, root, item, scopeCfg.vars, cat.meta.vars ?? {}));
      } catch (err) {
        const where = harnesses.length > 1 ? ` (${h})` : "";
        rep.warnings.push(`template error in ${item.type} ${item.name}${where}: ${(err as Error).message}`);
        if (key in oldLock) keep.push(key);
        continue;
      }
      const planItem: PlanItem = { key, type: item.type, name: item.name, source: item.source, version: r.version, output };
      // Main template renders empty: not applicable here (spec §5).
      if (rendersEmpty(catItem, output)) {
        planItem.output = new Map();
        planItem.skipped = "renders-empty";
      } else {
        // Per-target output mapping (spec §14.7): a Codex agent becomes TOML. A
        // conversion error leaves the target's copy as it was, like a template error.
        try {
          const conv = convertForTarget(h, item.type, item.name, output);
          for (const w of conv.warnings) rep.warnings.push(`${item.type} ${item.name} (${h}): ${w}`);
          if (conv.briefingDropped) bump(noteCounts, `briefing ${h}`);
          planItem.output = conv.output;
          if (conv.skipped) planItem.skipped = "renders-empty";
        } catch (err) {
          rep.warnings.push(`${item.type} ${item.name} (${h}): ${(err as Error).message}`);
          if (key in oldLock) keep.push(key);
          continue;
        }
      }
      plan.push(planItem);
    }
  };

  const explicit = new Map<string, { source: string; raw: string }>();
  for (const item of scopeCfg.install) {
    explicit.set(item.target, { source: item.source, raw: item.raw });
    buildItem(item);
  }

  // Expand wildcards (spec §3, §6.1). An unresolvable source offers what it
  // installed before (for any target), so its items are kept and still count
  // for collisions.
  const offers = new Map<string, { type: ItemType; name: string; from: WildcardItem[]; live: boolean }>();
  const offer = (w: WildcardItem, name: string, live: boolean) => {
    const target = `${TYPE_DIR[w.type]}/${name}`;
    const o = offers.get(target) ?? { type: w.type, name, from: [], live };
    if (!o.from.includes(w)) o.from.push(w);
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
      keepIfLocked(target, o.type);
      continue;
    }
    const w = o.from[0]!;
    if (!o.live) {
      keepIfLocked(target, o.type);
      continue;
    }
    if (!isValidItemName(o.name)) {
      rep.warnings.push(`${o.type} "${o.name}" from ${w.raw} skipped: invalid item name`);
      continue;
    }
    buildItem({ type: o.type, name: o.name, source: w.source, target });
  }

  const result = apply(plan, {
    targetDir, force: opts.force, keep, rootOf: (key) => rootOfKey(rc, key) ?? targetDir,
  });

  if (scope === "project") {
    // One managed block per target root: `.claude/.gitignore` (with the lock and
    // local config), `.agents/.gitignore` and `.codex/.gitignore` for Codex paths
    // (spec §6.4, §14.3).
    const newLock = readLock(lockPath);
    for (const rootDir of allRoots(rc)) {
      const managed = Object.entries(newLock)
        .filter(([key]) => rootOfKey(rc, key) === rootDir)
        .flatMap(([, e]) => Object.keys(e.files));
      const isClaude = rootDir === targetDir;
      updateGitignore({
        dir: rootDir,
        managedPaths: managed,
        fixed: isClaude ? undefined : [],
        enabled: scopeCfg.gitignore !== false,
      });
    }
  }

  const toChange = (key: string): ItemChange =>
    keyInfo.get(key) ?? { key, ...keyToTypeName(key), source: oldLock[key]?.source ?? "?" };
  rep.added = result.added.map(toChange);
  rep.updated = result.updated.map(toChange);
  rep.removed = result.removed.map(toChange);
  rep.unchanged = result.unchanged.map(toChange);
  rep.skipped = result.skipped.map(toChange);
  // Claude paths stay relative to `.claude` as before; other roots are named (`.agents/…`).
  // A root outside the base (a CODEX_HOME elsewhere) is shown absolute.
  const shown = (c: { key: string; path: string }) => {
    const root = rootOfKey(rc, c.key) ?? targetDir;
    if (root === targetDir) return { path: c.path };
    const rel = relative(base, root);
    return { path: rel.startsWith("..") || isAbsolute(rel) ? join(root, c.path) : join(rel, c.path) };
  };
  rep.conflicts = result.conflicts.map(shown);
  rep.overwritten = result.overwritten.map(shown);
  return rep;
}

// ---- check ------------------------------------------------------------------

export interface CheckReport {
  changed: boolean;
  sources: { name: string; scope: ScopeName; changed: boolean }[];
  /** Scopes whose lock does not match the active targets (spec §14.3). Absent when none. */
  targetsChanged?: ScopeName[];
  warnings: string[];
  error?: string;
}

export async function check(ctx: EngineContext, opts: SyncOptions = {}): Promise<CheckReport> {
  const loaded = loadWithTargets(ctx);
  if ("error" in loaded) return { changed: false, sources: [], warnings: [], error: loaded.error };
  const { config, targets } = loaded;
  const state = new State(ctx.stateRoot);
  const cacheRoot = cacheRootOf(ctx);
  const sel = opts.scope ?? "all";
  const out: CheckReport = { changed: false, sources: [], warnings: [] };

  const scopes: [ScopeName, ScopeConfig][] = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);

  for (const [scope, scopeCfg] of scopes) {
    const oldLock = readLock(join(targetDirOf(ctx, scope), "skilletor.lock.json"));
    if (targetDrift(Object.keys(oldLock), targets[scope])) {
      out.changed = true;
      (out.targetsChanged ??= []).push(scope);
    }
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
    /** The harnesses this scope installs for (spec §14.1). */
    targets: Harness[];
    /** `via` names the wildcard entry an item was installed through. */
    declared: { key: string; source: string; installed: boolean; via?: string; skipped?: SkipReason }[];
    orphans: string[];
    /** Each wildcard with the number of items currently installed through it. */
    wildcards: { type: ItemType; source: string; entry: string; installed: number }[];
    trustRequests: { name: string; url: string }[];
    sourceVersions: Record<string, string>;
  }[];
  error?: string;
}

export function status(ctx: EngineContext, opts: SyncOptions = {}): StatusReport {
  const loaded = loadWithTargets(ctx);
  if ("error" in loaded) return { scopes: [], error: loaded.error };
  const { config, targets } = loaded;
  const state = new State(ctx.stateRoot);
  const sel = opts.scope ?? "all";
  const scopes: [ScopeName, ScopeConfig][] = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);

  const out: StatusReport = { scopes: [] };
  for (const [scope, scopeCfg] of scopes) {
    const lock = readLock(join(targetDirOf(ctx, scope), "skilletor.lock.json"));
    const active = targets[scope];
    // One row per declared item and active target that receives its type.
    const rows = scopeCfg.install.flatMap((i) =>
      active.filter((h) => supports(h, i.type)).map((h) => ({ key: lockKey(h, i.target), source: i.source })));
    const declaredKeys = new Set(rows.map((r) => r.key));
    const sourceVersions: Record<string, string> = {};
    for (const entry of Object.values(lock)) sourceVersions[entry.source] = entry.version;
    const trustRequests: { name: string; url: string }[] = [];
    for (const name of scopeSources(scopeCfg)) {
      const src = config.sources.get(name);
      if (src && !state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) {
        trustRequests.push({ name, url: identityOf(src) });
      }
    }
    // A skip entry (spec §6.2) is declared but deliberately not installed.
    const declared: StatusReport["scopes"][number]["declared"] = rows.map((i) => {
      const entry = lock[i.key];
      const d: StatusReport["scopes"][number]["declared"][number] = {
        key: i.key, source: i.source, installed: entry !== undefined && !entry.skipped,
      };
      if (entry?.skipped) d.skipped = entry.skipped;
      return d;
    });
    const via = new Map<WildcardItem, Set<string>>(); // distinct item names per wildcard
    const orphans: string[] = [];
    for (const [key, entry] of Object.entries(lock)) {
      if (declaredKeys.has(key)) continue;
      const k = parseLockKey(key);
      const type = k.type;
      const w = k.harness && active.includes(k.harness)
        ? scopeCfg.wildcards.find((x) => x.source === entry.source && x.type === type)
        : undefined;
      if (!w) {
        orphans.push(key);
        continue;
      }
      if (entry.skipped) {
        declared.push({ key, source: entry.source, installed: false, via: w.raw, skipped: entry.skipped });
        continue;
      }
      declared.push({ key, source: entry.source, installed: true, via: w.raw });
      via.set(w, (via.get(w) ?? new Set()).add(k.target));
    }
    out.scopes.push({
      scope,
      targets: active,
      declared,
      orphans,
      wildcards: scopeCfg.wildcards.map((w) => ({
        type: w.type, source: w.source, entry: w.raw, installed: via.get(w)?.size ?? 0,
      })),
      trustRequests,
      sourceVersions,
    });
  }
  return out;
}
