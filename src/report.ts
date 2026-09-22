// Turn a sync result into text (human), JSON, and hook output (spec §8).
//
// Per-item activation hints come from the spike (design §12): skills are active
// immediately; agents and rules need /reload-plugins or a restart.
import type { ItemType } from "./config.ts";

export const ACTIVATION: Record<ItemType, string> = {
  skill: "active now",
  agent: "active after /reload-plugins or restart",
  rule: "active after /reload-plugins or restart",
};

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
  conflicts: { path: string }[];
  overwritten: { path: string }[];
  warnings: string[];
  trustRequests: { name: string; url: string }[];
}

export interface SyncReport {
  scopes: ScopeReport[];
  /** Config error: nothing was touched. */
  error?: string;
}

export function emptyScopeReport(scope: "user" | "project"): ScopeReport {
  return { scope, added: [], updated: [], removed: [], unchanged: [], conflicts: [], overwritten: [], warnings: [], trustRequests: [] };
}

/** "skills/perl-moo" -> { type: "skill", name: "perl-moo" }. */
export function keyToTypeName(key: string): { type: ItemType; name: string } {
  const [dir, ...rest] = key.split("/");
  const type: ItemType = dir === "skills" ? "skill" : dir === "agents" ? "agent" : "rule";
  return { type, name: rest.join("/") };
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
    if (!isNotable(s)) continue;
    lines.push(`skilletor: ${s.scope} scope`);
    for (const it of s.added) lines.push(`  + ${it.key} (${ACTIVATION[it.type]})`);
    for (const it of s.updated) lines.push(`  ~ ${it.key} (${ACTIVATION[it.type]})`);
    for (const it of s.removed) lines.push(`  - ${it.key} (removed)`);
    for (const c of s.overwritten) lines.push(`  overwrote local change: ${c.path}`);
    for (const c of s.conflicts) lines.push(`  conflict: ${c.path} already exists (use --force to adopt)`);
    for (const t of s.trustRequests) lines.push(`  trust: source "${t.name}" (${t.url}) — run: skilletor trust ${t.name}`);
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
  }
  return lines.join("\n");
}

/** Hook output: a one-line systemMessage and a terse additionalContext. */
export function reportHook(r: SyncReport): { systemMessage?: string; additionalContext?: string } {
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
    for (const it of changed) ctx.push(`- ${it.type} ${it.name}@${it.source}: ${ACTIVATION[it.type]}`);
  }
  for (const s of r.scopes) {
    for (const t of s.trustRequests) ctx.push(`- untrusted source ${t.name} (${t.url}); run: skilletor trust ${t.name}`);
    for (const w of s.warnings) ctx.push(`- warning: ${w}`);
  }
  return { systemMessage, additionalContext: ctx.length ? ctx.join("\n") : undefined };
}
