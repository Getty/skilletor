// Turn a sync result into text (human), JSON, and hook output (spec §8).
//
// Per-item activation hints come from the spike (design §12): skills are active
// immediately; agents and rules need /reload-plugins or a restart. Codex items
// (lock key `codex:…`, spec §14.4) carry their own, unmeasured-so-conservative hint.
import type { ItemType } from "./config.ts";
import { parseLockKey } from "./targets.ts";
import { briefingWarning, type BriefingMissing } from "./briefing.ts";

export const ACTIVATION: Record<ItemType, string> = {
  skill: "active now",
  agent: "active after /reload-plugins or restart",
  rule: "active after /reload-plugins or restart",
};

/** Codex: every item type, unmeasured, so conservatively the next session (spec §14.4). */
export const CODEX_ACTIVATION = "active from the next Codex session";

function activationOf(it: ItemChange): string {
  return parseLockKey(it.key).harness === "codex" ? CODEX_ACTIVATION : ACTIVATION[it.type];
}

export interface ItemChange {
  key: string;
  type: ItemType;
  name: string;
  source: string;
}

export interface ScopeReport {
  scope: "user" | "project";
  added: ItemChange[];
  updated: ItemChange[];
  removed: ItemChange[];
  unchanged: ItemChange[];
  /** Declared items that render empty (spec §5): not applicable, not an error.
   *  An item also in `removed` had an installed copy deleted this run. */
  skipped: ItemChange[];
  conflicts: { path: string }[];
  overwritten: { path: string }[];
  warnings: string[];
  trustRequests: { name: string; url: string }[];
  /** Installed agents whose briefing skills do not resolve (spec §6.7); each also has
   *  its line in `warnings`. Absent when empty. */
  briefingMissing?: BriefingMissing[];
}

export interface SyncReport {
  scopes: ScopeReport[];
  /** Once per run, not per scope (the untrusted Codex hook, spec §14.8). Shown by
   *  `reportText`, never by the hooks (a hook that runs is trusted). Absent when empty. */
  warnings?: string[];
  /** Config error: nothing was touched. */
  error?: string;
}

export function emptyScopeReport(scope: "user" | "project"): ScopeReport {
  return {
    scope, added: [], updated: [], removed: [], unchanged: [], skipped: [], conflicts: [], overwritten: [], warnings: [],
    trustRequests: [],
  };
}

/** "skills/perl-moo" (or "codex:skills/perl-moo") -> { type: "skill", name: "perl-moo" }. */
export function keyToTypeName(key: string): { type: ItemType; name: string } {
  const { type, name } = parseLockKey(key);
  return { type, name };
}

export function hasChanges(r: SyncReport): boolean {
  return r.scopes.some((s) => s.added.length || s.updated.length || s.removed.length);
}

function isNotable(s: ScopeReport): boolean {
  return Boolean(
    s.added.length || s.updated.length || s.removed.length ||
    s.conflicts.length || s.overwritten.length || s.warnings.length || s.trustRequests.length,
  );
}

export function hasNotable(r: SyncReport): boolean {
  return Boolean(r.error) || r.scopes.some(isNotable);
}

export function reportJson(r: SyncReport): string {
  return JSON.stringify(r, null, 2);
}

/** Human-readable text; empty string when there is nothing to say. */
export function reportText(r: SyncReport): string {
  if (r.error) return `skilletor: config error, nothing changed — ${r.error}`;
  const lines: string[] = [];
  for (const s of r.scopes) {
    // Skips are informational: shown here, but not "notable" (the hook stays quiet).
    if (!isNotable(s) && s.skipped.length === 0) continue;
    const skipped = new Set(s.skipped.map((it) => it.key));
    lines.push(`skilletor: ${s.scope} scope`);
    for (const it of s.added) lines.push(`  + ${it.key} (${activationOf(it)})`);
    for (const it of s.updated) lines.push(`  ~ ${it.key} (${activationOf(it)})`);
    for (const it of s.removed) lines.push(`  - ${it.key} (${skipped.has(it.key) ? "removed: renders empty" : "removed"})`);
    const removed = new Set(s.removed.map((it) => it.key));
    for (const it of s.skipped) if (!removed.has(it.key)) lines.push(`  · ${it.key} skipped (renders empty)`);
    for (const c of s.overwritten) lines.push(`  overwrote local change: ${c.path}`);
    for (const c of s.conflicts) lines.push(`  conflict: ${c.path} already exists (use --force to adopt)`);
    for (const t of s.trustRequests) lines.push(`  trust: source "${t.name}" (${t.url}) — run: skilletor trust ${t.name}`);
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
  }
  for (const w of r.warnings ?? []) lines.push(`skilletor: warning: ${w}`);
  return lines.join("\n");
}

/** `r` without its briefing warnings (spec §6.7): the hooks show them only in a run
 *  that changed something, instead of in every session. */
function withoutBriefing(r: SyncReport): SyncReport {
  return {
    ...r,
    scopes: r.scopes.map((s) => {
      if (!s.briefingMissing?.length) return s;
      const lines = new Set(s.briefingMissing.map((b) => briefingWarning(parseLockKey(b.key).name, b.harness, b.missing)));
      const { briefingMissing: _, ...rest } = s;
      return { ...rest, warnings: s.warnings.filter((w) => !lines.has(w)) };
    }),
  };
}

/** Hook output: a one-line systemMessage and a terse additionalContext. */
export function reportHook(report: SyncReport): { systemMessage?: string; additionalContext?: string } {
  const r = hasChanges(report) ? report : withoutBriefing(report);
  if (!hasNotable(r)) return {};
  const changed: ItemChange[] = [];
  let warnings = 0;
  for (const s of r.scopes) {
    changed.push(...s.added, ...s.updated);
    warnings += s.warnings.length + s.conflicts.length + s.trustRequests.length + s.overwritten.length;
  }
  const removed = r.scopes.reduce((n, s) => n + s.removed.length, 0);

  const parts: string[] = [];
  if (changed.length) parts.push(`${changed.length} item(s) updated`);
  if (removed) parts.push(`${removed} removed`);
  if (warnings) parts.push(`${warnings} warning(s)`);
  const systemMessage = `skilletor: ${parts.join(", ") || "changes applied"}`;

  const ctx: string[] = [];
  if (changed.length) {
    ctx.push("skilletor synced items:");
    for (const it of changed) {
      const codex = parseLockKey(it.key).harness === "codex" ? " (codex)" : "";
      ctx.push(`- ${it.type} ${it.name}@${it.source}${codex}: ${activationOf(it)}`);
    }
  }
  for (const s of r.scopes) {
    for (const t of s.trustRequests) ctx.push(`- untrusted source ${t.name} (${t.url}); run: skilletor trust ${t.name}`);
    for (const w of s.warnings) ctx.push(`- warning: ${w}`);
  }
  return { systemMessage, additionalContext: ctx.length ? ctx.join("\n") : undefined };
}
