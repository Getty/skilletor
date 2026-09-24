// The engine: wire config, sources, catalog, render, apply, lock, state and
// report into sync / check / status (spec §6.1, §6.6, §7). Never throws through
// to process exit without a message: a config error touches nothing, a fetch
// error falls back to the cache with a warning, a template error leaves the item
// as it was.
import { execFileSync } from "node:child_process";
import { hostname, platform, userInfo } from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  loadConfig, WILDCARD, type BundleItem, type Harness, type ItemType, type LoadedConfig, type ResolvedSource, type ScopeConfig,
  type WildcardItem,
} from "./config.ts";
import {
  BundleError, entryMiss, expandBundle, matchEntry, matchesPattern, sameIdentity, type Chain,
} from "./bundles.ts";
import {
  defaultMarkers, detectHarnesses, lockKey, parseLockKey, rootOf, rootOfKey, selectTargets, supports, targetDrift,
  allRoots, isBlockType, type HarnessMarkers, type RootContext, type TargetSelection,
} from "./targets.ts";
import {
  codexHookTrusted, inspectAgentsMd, parseRulesFile, pointerLines, projectDocLimit, rulesFileText, RULES_FILE, withBlock,
  type Inspection, type Section,
} from "./agentsmd.ts";
import { atomicWrite, hashBuffer, sameFile, samePath } from "./fsutil.ts";
import { convertForTarget } from "./convert.ts";
import { LocalSource } from "./sources/local.ts";
import { GitSource } from "./sources/git.ts";
import { UrlSource } from "./sources/url.ts";
import type { Source } from "./sources/types.ts";
import { scan, type Catalog } from "./catalog.ts";
import { build, rendersEmpty, type RenderContext } from "./render.ts";
import { apply, isValidItemName, type PlanItem } from "./apply.ts";
import { readLock, writeLock, type Lock, type SkipReason } from "./lock.ts";
import { State } from "./state.ts";
import { isGitWorkTree, updateGitignore } from "./gitignore.ts";
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
  /** Does a user-scope root lie inside a git work tree (spec §6.4)? Default: ask git. */
  isGitWorkTree?: (dir: string) => boolean;
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

/**
 * The project dir, unless it is the home dir itself (a session started in `~`, or `~`
 * a git checkout): then there is no project scope (spec §6.1) – its config, lock and
 * target dir would be the user scope's.
 */
export function projectDirOf(ctx: EngineContext): string | undefined {
  if (!ctx.projectDir || samePath(ctx.projectDir, ctx.home)) return undefined;
  return ctx.projectDir;
}

/** True when a project dir was given but it is the home dir (no project scope). */
export function projectIsHome(ctx: EngineContext): boolean {
  return Boolean(ctx.projectDir) && projectDirOf(ctx) === undefined;
}

/** `ctx` with the project scope dropped when the project dir is the home dir. */
function scoped(ctx: EngineContext): EngineContext {
  return projectIsHome(ctx) ? { ...ctx, projectDir: undefined } : ctx;
}

/** The CLAUDE.md files Claude Code reads for a scope (spec §14.8). */
function claudeMemoryFiles(ctx: EngineContext, scope: ScopeName): string[] {
  const base = baseOf(ctx, scope);
  return scope === "user" ? [join(base, ".claude", "CLAUDE.md")] : [join(base, "CLAUDE.md"), join(base, ".claude", "CLAUDE.md")];
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

/** Every source a scope references, through explicit entries, wildcards or bundles. */
export function scopeSources(scopeCfg: ScopeConfig): string[] {
  return [...new Set([...scopeCfg.install, ...scopeCfg.wildcards, ...scopeCfg.bundles].map((i) => i.source))];
}

/** How a bundle entry is named in reports, `status` and the lock's `via`: `bundle:perl@shared`. */
export function bundleLabel(b: { name: string; source: string }): string {
  return `bundle:${b.name}@${b.source}`;
}

const TYPE_DIR: Record<ItemType, string> = { skill: "skills", agent: "agents", rule: "rules" };

function sourceVersion(lock: Lock, sourceName: string): string | undefined {
  for (const entry of Object.values(lock)) if (entry.source === sourceName) return entry.version;
  return undefined;
}

/** Fixed entries of the user `~/.claude` block: the lock, and the state dir when it lies
 *  under `~/.claude` (spec §6.4). Never `skilletor.json`. */
function userClaudeFixed(claudeDir: string, stateRoot: string): string[] {
  const rel = relative(claudeDir, stateRoot);
  const under = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return under ? ["skilletor.lock.json", rel.split(sep).join("/") + "/"] : ["skilletor.lock.json"];
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
  bundleVars: Record<string, unknown> = {},
): RenderContext {
  return {
    // source defaults < bundle vars (bundle items only) < user < project < local (spec §5, §15.3)
    vars: { ...sourceVars, ...bundleVars, ...scopeVars },
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

/**
 * The configured source that serves a bundle entry of another source (spec §15.6): the one
 * whose `git`/`url` identity is `url`, among the sources visible to the scope (the user
 * scope sees the user config's sources, the project scope all). Config names do not
 * matter; with several matches the first in config order serves.
 */
export function servingSource(config: LoadedConfig, scope: ScopeName, url: string): string | undefined {
  for (const src of config.sources.values()) {
    if (scope === "user" && !config.userSources.has(src.name)) continue;
    const id = src.git ?? src.url;
    if (id !== undefined && sameIdentity(id, url)) return src.name;
  }
  return undefined;
}

/**
 * Bundle vars for one item from every chain it was reached through (spec §15.3): a key
 * every setting chain agrees on applies; a key set to different values applies from no
 * chain, and `conflict` gets the key and the bundles (labels) that set it.
 */
function mergeChainVars(
  chains: Chain[], source: string, conflict: (key: string, setters: string[]) => void,
): Record<string, unknown> {
  const values = new Map<string, { value: unknown; setter: string }[]>();
  for (const c of chains) {
    for (const [key, value] of Object.entries(c.vars)) {
      const setter = bundleLabel({ name: c.setters[key]!, source });
      values.set(key, [...(values.get(key) ?? []), { value, setter }]);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, list] of values) {
    if (new Set(list.map((v) => JSON.stringify(v.value))).size === 1) {
      out[key] = list[0]!.value;
    } else {
      conflict(key, [...new Set(list.map((v) => v.setter))]);
    }
  }
  return out;
}

// ---- sync -------------------------------------------------------------------

export async function sync(ctx: EngineContext, opts: SyncOptions = {}): Promise<SyncReport> {
  const state = new State(ctx.stateRoot);
  return state.withLock(() => syncInner(scoped(ctx), opts, state));
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
  const trust = hookTrustWarning(ctx, targets);
  if (trust) report.warnings = [trust];
  return report;
}

/**
 * Codex skips plugin hooks the user has not trusted, silently (spec §14.8): when Codex
 * is a machine target and its config.toml has no trusted SessionStart hook for
 * skilletor, one warning for the run.
 */
function hookTrustWarning(ctx: EngineContext, targets: TargetSelection): string | undefined {
  if (!targets.user.includes("codex")) return undefined;
  const codexHome = codexHomeOf(ctx) || join(ctx.home, ".codex");
  if (codexHookTrusted(codexHome)) return undefined;
  return `Codex has not trusted skilletor's SessionStart hook (no trusted_hash for it in ${join(codexHome, "config.toml")}); ` +
    "until you trust it with /hooks in Codex, Codex sessions get no syncs and no rules";
}

/** Count one occurrence of a note kind ("briefing <harness>"). */
function bump(counts: Map<string, number>, kind: string): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

const HARNESS_LABEL: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** The run's notes (spec §14.7): one line per harness and kind. */
function runNotes(counts: Map<string, number>): string[] {
  const notes: string[] = [];
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
  const resolveAll = (names: string[]) => Promise.all(
    names.filter((n) => !resolved.has(n)).map(async (name) => {
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
  await resolveAll(needed);

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

  const buildItem = (
    item: { type: ItemType; name: string; source: string; target: string },
    extra: { bundleVars?: Record<string, unknown>; via?: string[] } = {},
  ) => {
    const targets = harnessesFor(item.type);
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
        output = build(
          catItem, r.dir, makeContext(ctx, scope, h, root, item, scopeCfg.vars, cat.meta.vars ?? {}, extra.bundleVars),
        );
      } catch (err) {
        const where = harnesses.length > 1 ? ` (${h})` : "";
        rep.warnings.push(`template error in ${item.type} ${item.name}${where}: ${(err as Error).message}`);
        if (key in oldLock) keep.push(key);
        continue;
      }
      const planItem: PlanItem = { key, type: item.type, name: item.name, source: item.source, version: r.version, output };
      if (extra.via?.length) planItem.via = extra.via;
      if (isBlockType(h, item.type)) planItem.inBlock = true;
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

  // Expand wildcards and bundles (spec §3, §6.1, §15.2) into offers per target. An
  // unresolvable source (or a bundle that cannot be expanded) offers what it installed
  // before, so those items are kept and still count for collisions.
  interface Offer {
    /** The declaring entry as shown in warnings: `*@shared`, `bundle:perl@shared`. */
    from: string;
    source: string;
    live: boolean;
    /** Bundle offers: the label recorded in the lock's `via`. */
    via?: string;
    /** Live bundle offers: the chains the item was reached through. */
    chains?: Chain[];
  }
  const offers = new Map<string, { type: ItemType; name: string; offers: Offer[] }>();
  const offer = (type: ItemType, name: string, o: Offer) => {
    const target = `${TYPE_DIR[type]}/${name}`;
    const entry = offers.get(target) ?? { type, name, offers: [] };
    if (!entry.offers.some((x) => x.from === o.from)) entry.offers.push(o);
    offers.set(target, entry);
  };
  /** Lock entries of this scope, per item (any target), as type + name. */
  const lockedItems = Object.entries(oldLock).map(([key, entry]) => ({ ...keyToTypeName(key), entry }));
  for (const w of scopeCfg.wildcards) {
    const cat = catalogOf(w.source);
    if (cat) {
      const hits = cat.items.filter((ci) => ci.type === w.type && matchesPattern(w.pattern, ci.name));
      // A bare `*` may legitimately match nothing (a source without rules): silent (spec §3).
      if (hits.length === 0 && w.pattern !== WILDCARD) rep.warnings.push(`${w.type} wildcard ${w.raw} matches nothing in source ${w.source}`);
      for (const ci of hits) offer(w.type, ci.name, { from: w.raw, source: w.source, live: true });
    } else {
      for (const l of lockedItems) {
        if (l.entry.source === w.source && l.type === w.type && matchesPattern(w.pattern, l.name)) {
          offer(l.type, l.name, { from: w.raw, source: w.source, live: false });
        }
      }
    }
  }
  // Bundles: expand against their own source first; entries of other sources (spec
  // §15.6) are served by a configured source with the same identity, resolved next.
  const expansions = scopeCfg.bundles.map((b) => {
    const label = bundleLabel(b);
    const cat = catalogOf(b.source);
    let expanded: ReturnType<typeof expandBundle> | undefined;
    if (cat) {
      try {
        expanded = expandBundle(cat, b.name);
      } catch (err) {
        if (!(err instanceof BundleError)) throw err;
        rep.warnings.push(`${label}: ${err.message}; its installed items are kept`);
      }
    }
    const foreign = (expanded?.foreign ?? []).map((f) => ({ f, served: servingSource(config, scope, f.url) }));
    return { b, label, expanded, foreign };
  });
  await resolveAll(expansions.flatMap((x) => x.foreign.flatMap((y) => (y.served ? [y.served] : []))));

  for (const { b, label, expanded, foreign } of expansions) {
    /** Keep what the bundle installed (from `from`, when given) while it cannot offer it live. */
    const keepFromLock = (match: (l: (typeof lockedItems)[number]) => boolean) => {
      for (const l of lockedItems) {
        if (l.entry.via?.includes(label) && match(l)) offer(l.type, l.name, { from: label, source: l.entry.source, live: false, via: label });
      }
    };
    if (!expanded) {
      keepFromLock(() => true);
      continue;
    }
    for (const w of expanded.warnings) rep.warnings.push(`bundle ${w.bundle}@${b.source}: ${w.message}`);
    for (const m of expanded.items) {
      offer(m.type, m.name, { from: label, source: b.source, live: true, via: label, chains: m.chains });
    }
    const missing: string[] = []; // identities already warned about for this bundle
    for (const { f, served } of foreign) {
      const cat = served ? catalogOf(served) : null;
      if (!served) {
        if (!missing.some((u) => sameIdentity(u, f.url))) {
          missing.push(f.url);
          rep.warnings.push(`bundle ${b.name}@${b.source} needs ${f.spec} (${f.url}): run skilletor install ${label}`);
        }
      }
      if (!cat) {
        // Missing, untrusted or unresolvable: installed copies stay (spec §15.6).
        keepFromLock((l) => l.type === f.type && l.entry.source !== b.source && matchesPattern(f.name, l.name) &&
          (!served || l.entry.source === served));
        continue;
      }
      const hits = matchEntry(cat, f.type, f.name);
      const miss = entryMiss(f.type, f.name, hits.length);
      if (miss) rep.warnings.push(`bundle ${f.chain.path.at(-1)}@${b.source}: ${miss.replace(/ in the source$/, "")} in ${served}`);
      for (const ci of hits) {
        offer(ci.type, ci.name, { from: label, source: served!, live: true, via: label, chains: [f.chain] });
      }
    }
  }
  // Explicit entries win over every offer; they get no bundle vars (spec §15.3), but the
  // lock records the same-source bundles that also yield them, for `uninstall` hints.
  const explicit = new Map<string, { source: string; raw: string }>();
  for (const item of scopeCfg.install) {
    explicit.set(item.target, { source: item.source, raw: item.raw });
    const via = (offers.get(item.target)?.offers ?? []).flatMap((x) => (x.via && x.source === item.source ? [x.via] : []));
    buildItem(item, { via });
  }
  // Bundle var conflicts (spec §15.3), reported once per key and pair of bundles.
  const varConflicts = new Map<string, string[]>();
  for (const [target, o] of offers) {
    const claim = explicit.get(target);
    if (claim) {
      for (const x of o.offers) {
        if (x.source !== claim.source) {
          rep.warnings.push(`${o.type} "${o.name}" from ${x.from} ignored: explicitly declared as ${claim.raw}`);
        }
      }
      continue;
    }
    if (new Set(o.offers.map((x) => x.source)).size > 1) {
      rep.warnings.push(`${o.type} "${o.name}" offered by ${o.offers.map((x) => x.from).join(" and ")}; skipped`);
      keepIfLocked(target, o.type);
      continue;
    }
    // One source: installed once, however many of its wildcards and bundles yield it.
    const source = o.offers[0]!.source;
    const live = o.offers.filter((x) => x.live);
    if (live.length === 0) {
      keepIfLocked(target, o.type);
      continue;
    }
    if (!isValidItemName(o.name)) {
      rep.warnings.push(`${o.type} "${o.name}" from ${live[0]!.from} skipped: invalid item name`);
      continue;
    }
    const via = o.offers.flatMap((x) => (x.via ? [x.via] : []));
    const chains = live.flatMap((x) => x.chains ?? []);
    const bundleVars = mergeChainVars(chains, source, (key, setters) => {
      const k = `"${key}": ${setters.join(" and ")}`;
      varConflicts.set(k, [...(varConflicts.get(k) ?? []), `${o.type} ${o.name}`]);
    });
    buildItem({ type: o.type, name: o.name, source, target }, { bundleVars, via });
  }
  for (const [k, items] of varConflicts) {
    rep.warnings.push(`bundle vars conflict on ${k} set different values; neither applies to ${items.join(", ")}`);
  }

  /** A path for the report: relative to the scope base when under it, else absolute. */
  const labelOf = (abs: string): string => {
    const rel = relative(base, abs);
    return rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
  };

  const result = apply(plan, {
    targetDir, force: opts.force, keep, rootOf: (key) => rootOfKey(rc, key) ?? targetDir,
  });

  // Codex rules (spec §14.8): the rules file and the AGENTS.md pointer, from the new lock.
  const rules = Object.values(oldLock).some((e) => e.block) || plan.some((p) => p.inBlock) ||
      existsSync(join(rootOf(rc, "codex", "rule")!, RULES_FILE))
    ? syncCodexRules({ ctx, scope, harnesses, rc, oldLock, plan, lockPath, labelOf, warnings: rep.warnings })
    : { overwritten: [], exists: false };

  {
    // One managed block per target root: `.claude/.gitignore` (with the lock, and the
    // local config or state dir), `.agents/.gitignore` and `.codex/.gitignore` (or
    // `$CODEX_HOME/.gitignore`) for Codex paths, the rules file included (spec §6.4,
    // §14.3, §14.8). User roots get a block only inside a git work tree.
    const newLock = readLock(lockPath);
    const rulesRoot = rootOf(rc, "codex", "rule")!;
    const inWorkTree = (dir: string): boolean => {
      try {
        return (ctx.isGitWorkTree ?? isGitWorkTree)(dir);
      } catch {
        return false;
      }
    };
    for (const rootDir of allRoots(rc)) {
      const managed = Object.entries(newLock)
        .filter(([key, e]) => !e.block && rootOfKey(rc, key) === rootDir)
        .flatMap(([, e]) => Object.keys(e.files));
      if (rules.exists && rootDir === rulesRoot) managed.push(RULES_FILE);
      const isClaude = rootDir === targetDir;
      const fixed = !isClaude ? [] : scope === "project" ? undefined : userClaudeFixed(targetDir, ctx.stateRoot);
      let enabled = scopeCfg.gitignore !== false;
      if (enabled && scope === "user") {
        // Ask git only when there is something to list or clean (the hook path stays fast).
        const relevant = managed.length > 0 || fixed!.length > 0 || existsSync(join(rootDir, ".gitignore"));
        enabled = relevant && inWorkTree(rootDir);
      }
      updateGitignore({ dir: rootDir, managedPaths: managed, fixed, enabled });
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
    return { path: root === targetDir ? c.path : labelOf(join(root, c.path)) };
  };
  rep.conflicts = result.conflicts.map(shown);
  rep.overwritten = [...result.overwritten.map(shown), ...rules.overwritten.map((path) => ({ path }))];
  return rep;
}

/**
 * Rebuild a scope's Codex rules file from the new lock, then its AGENTS.md pointer
 * (spec §14.8). Planned rules take their rendered section; kept ones (source
 * unreachable) their text from the file – or, for an entry of the first design
 * (#41, keyed `AGENTS.md`), from the old rules block in AGENTS.md, and the entry is
 * rewritten under the new file name. A pointer refusal is a warning and touches
 * neither the rules file nor the lock. Returns the overwritten local changes
 * (`<file>#rules/<name>`) and whether the rules file exists now.
 */
function syncCodexRules(a: {
  ctx: EngineContext;
  scope: ScopeName;
  harnesses: Harness[];
  rc: RootContext;
  oldLock: Lock;
  plan: PlanItem[];
  lockPath: string;
  labelOf: (abs: string) => string;
  warnings: string[];
}): { overwritten: string[]; exists: boolean } {
  const { ctx, scope, rc, oldLock, labelOf, warnings } = a;
  const rulesFile = join(rootOf(rc, "codex", "rule")!, RULES_FILE);
  const rulesLabel = labelOf(rulesFile);
  const agentsFile = join(scope === "user" ? rootOf(rc, "codex", "rule")! : rc.base, "AGENTS.md");
  const agentsLabel = labelOf(agentsFile);
  const LEGACY = "AGENTS.md"; // the files key of a first-design entry

  let fileText: string | null = null;
  try {
    fileText = readFileSync(rulesFile, "utf8");
  } catch {
    // missing (or unreadable: rewritten below)
  }
  const current = fileText === null ? new Map<string, { source: string; text: string }>() : parseRulesFile(fileText);
  const agents = inspectAgentsMd(agentsFile);
  const legacy = agents.ok ? agents.parsed?.sections : undefined;
  const planned = new Map(
    a.plan.filter((p) => p.inBlock && !p.skipped).map((p) => [p.key, p.output.get(RULES_FILE)!.toString("utf8")]),
  );

  const newLock = readLock(a.lockPath);
  let lockMigrated = false;
  const sections: Section[] = [];
  const overwritten: string[] = [];
  for (const [key, entry] of Object.entries(newLock)) {
    if (!entry.block || entry.skipped) continue;
    const name = parseLockKey(key).name;
    const prevHash = oldLock[key]?.skipped ? undefined : oldLock[key]?.files[RULES_FILE];
    const onDisk = current.get(name) ?? (oldLock[key]?.files[LEGACY] !== undefined ? legacy?.get(name) : undefined);
    if (entry.files[LEGACY] !== undefined && entry.files[RULES_FILE] === undefined) {
      entry.files = { [RULES_FILE]: entry.files[LEGACY]! }; // kept first-design entry: same section, new file
      lockMigrated = true;
    }
    const text = planned.get(key) ?? onDisk?.text;
    if (text === undefined) continue;
    // Edited or deleted by hand; a first-design entry (no hash for this file) moves silently.
    if (prevHash !== undefined && (!onDisk || hashBuffer(Buffer.from(onDisk.text, "utf8")) !== prevHash)) {
      overwritten.push(`${rulesLabel}#rules/${name}`);
    }
    sections.push({ name, source: entry.source, text });
  }
  if (lockMigrated) writeLock(a.lockPath, newLock);
  sections.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  const next = rulesFileText(scope, sections);
  let exists = fileText !== null;
  try {
    if (next !== fileText) {
      if (next === null) rmSync(rulesFile, { force: true });
      else atomicWrite(rulesFile, next);
    }
    exists = next !== null;
  } catch (err) {
    warnings.push(`${rulesLabel}: cannot write the Codex rules file (${(err as Error).message})`);
  }

  // The pointer: present exactly when the rules file is.
  const want = exists;
  let state: Inspection = agents;
  // Claude Code reads CLAUDE.md: when that is this AGENTS.md, Claude would be sent to the Codex rules.
  const memory = want && a.harnesses.includes("claude")
    ? claudeMemoryFiles(ctx, scope).find((f) => sameFile(f, agentsFile))
    : undefined;
  if (state.ok && memory) state = { ok: false, reason: `is the same file as ${labelOf(memory)} (Claude Code would read it)` };
  if (!state.ok) {
    const why = state.reason;
    if (want || state.reason.startsWith("malformed")) {
      warnings.push(`${agentsLabel}${why.startsWith("is ") ? " " : ": "}${why}; pointer to the Codex rules not written`);
    }
    return { overwritten, exists };
  }
  const shownRules = scope === "user" ? rulesFile : `.codex/${RULES_FILE}`;
  const agentsNext = withBlock(state.text, want ? pointerLines(scope, shownRules) : null);
  if (agentsNext !== state.text) {
    if (agentsNext === null) rmSync(agentsFile, { force: true });
    else atomicWrite(agentsFile, agentsNext);
  }
  if (want) {
    const override = join(dirname(agentsFile), "AGENTS.override.md");
    if (existsSync(override)) {
      warnings.push(`${labelOf(override)} exists; Codex reads it instead of AGENTS.md, so the pointer to the skilletor rules is not seen`);
    }
    if (scope === "project" && agentsNext !== null) {
      const limit = projectDocLimit(codexHomeOf(ctx) || join(ctx.home, ".codex"));
      const bytes = Buffer.byteLength(agentsNext, "utf8");
      if (bytes > limit) {
        warnings.push(
          `${agentsLabel} is ${bytes} bytes; Codex reads at most ${limit} bytes of project instructions ` +
            "(project_doc_max_bytes), so the pointer to the rules at its end may be cut off",
        );
      }
    }
  }
  return { overwritten, exists };
}

/**
 * The Codex rules files the SessionStart hook injects (spec §14.8): the user scope's,
 * then the project's, each when it exists and Codex is a target of that scope. When
 * the config or the targets cannot be loaded, every existing file (the last good
 * state). Reads no source and never throws.
 */
export function codexRulesFiles(given: EngineContext): string[] {
  const ctx = scoped(given);
  const loaded = loadWithTargets(ctx);
  const out: string[] = [];
  const scopes: ScopeName[] = ctx.projectDir ? ["user", "project"] : ["user"];
  for (const scope of scopes) {
    if (!("error" in loaded) && !loaded.targets[scope].includes("codex")) continue;
    const file = join(rootOf({ base: baseOf(ctx, scope), scope, codexHome: codexHomeOf(ctx) }, "codex", "rule")!, RULES_FILE);
    if (existsSync(file)) out.push(file);
  }
  return out;
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

export async function check(given: EngineContext, opts: SyncOptions = {}): Promise<CheckReport> {
  const ctx = scoped(given);
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
    // Sources a bundle pulled items from (spec §15.6) are not declared here; the lock names them.
    const viaSources = Object.values(oldLock).flatMap((e) => (e.via?.length ? [e.source] : []));
    for (const name of new Set([...scopeSources(scopeCfg), ...viaSources])) {
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
    /** `via` names the wildcard entry or bundle (`bundle:perl@shared`) an item was installed through. */
    declared: { key: string; source: string; installed: boolean; via?: string; skipped?: SkipReason }[];
    orphans: string[];
    /** Each wildcard with the number of items currently installed through it. */
    wildcards: { type: ItemType; source: string; entry: string; installed: number }[];
    /** Each bundle entry with the number of items currently installed through it (spec §15.5). */
    bundles: { name: string; source: string; entry: string; installed: number }[];
    trustRequests: { name: string; url: string }[];
    sourceVersions: Record<string, string>;
  }[];
  /** The project dir is the home dir, so there is no project scope. Absent otherwise. */
  projectIsHome?: true;
  /** Once per run, not per scope (the untrusted Codex hook, spec §14.8). Absent when empty. */
  warnings?: string[];
  error?: string;
}

export function status(given: EngineContext, opts: SyncOptions = {}): StatusReport {
  const ctx = scoped(given);
  const loaded = loadWithTargets(ctx);
  if ("error" in loaded) return { scopes: [], error: loaded.error };
  const { config, targets } = loaded;
  const state = new State(ctx.stateRoot);
  const sel = opts.scope ?? "all";
  const scopes: [ScopeName, ScopeConfig][] = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);

  const out: StatusReport = { scopes: [] };
  if (sel !== "user" && projectIsHome(given)) out.projectIsHome = true;
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
    const via = new Map<WildcardItem | BundleItem, Set<string>>(); // distinct item targets per entry
    const orphans: string[] = [];
    for (const [key, entry] of Object.entries(lock)) {
      if (declaredKeys.has(key)) continue;
      const k = parseLockKey(key);
      const covering: (WildcardItem | BundleItem)[] = [];
      if (k.harness && active.includes(k.harness)) {
        covering.push(...scopeCfg.bundles.filter((b) => entry.via?.includes(bundleLabel(b))));
        covering.push(...scopeCfg.wildcards.filter((x) =>
          x.source === entry.source && x.type === k.type && matchesPattern(x.pattern, k.name)));
      }
      const first = covering[0];
      if (!first) {
        orphans.push(key);
        continue;
      }
      const label = "pattern" in first ? first.raw : bundleLabel(first);
      if (entry.skipped) {
        declared.push({ key, source: entry.source, installed: false, via: label, skipped: entry.skipped });
        continue;
      }
      declared.push({ key, source: entry.source, installed: true, via: label });
      for (const c of covering) via.set(c, (via.get(c) ?? new Set()).add(k.target));
    }
    out.scopes.push({
      scope,
      targets: active,
      declared,
      orphans,
      wildcards: scopeCfg.wildcards.map((w) => ({
        type: w.type, source: w.source, entry: w.raw, installed: via.get(w)?.size ?? 0,
      })),
      bundles: scopeCfg.bundles.map((b) => ({
        name: b.name, source: b.source, entry: b.raw, installed: via.get(b)?.size ?? 0,
      })),
      trustRequests,
      sourceVersions,
    });
  }
  const trust = hookTrustWarning(ctx, targets);
  if (trust) out.warnings = [trust];
  return out;
}
