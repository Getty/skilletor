// Tests for report formatting (spec §8).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportText, reportHook, hasChanges, hasNotable, emptyScopeReport, conflictHint, displaySafe, type SyncReport,
} from "../src/report.ts";

function sample(): SyncReport {
  const s = emptyScopeReport("user");
  s.added = [{ key: "skills/foo", type: "skill", name: "foo", source: "shared" }];
  s.updated = [{ key: "agents/bar", type: "agent", name: "bar", source: "shared" }];
  s.warnings = ["source team offline"];
  s.trustRequests = [{ name: "team", kind: "local", url: "/src/team" }];
  return { scopes: [s] };
}

test("empty report renders as empty text and is not notable", () => {
  const r: SyncReport = { scopes: [emptyScopeReport("user")] };
  assert.equal(reportText(r), "");
  assert.equal(hasNotable(r), false);
  assert.deepEqual(reportHook(r), {});
});

test("text lists items with the right activation hint per type", () => {
  const text = reportText(sample());
  assert.match(text, /\+ skills\/foo \(active now\)/);
  assert.match(text, /~ agents\/bar \(active after \/reload-plugins or restart\)/);
  assert.match(text, /trust: source "team" \(local \/src\/team\) — run: skilletor trust team/);
  assert.match(text, /warning: source team offline/);
});

test("hook output has a one-line systemMessage and a per-item additionalContext", () => {
  const hook = reportHook(sample());
  assert.equal(hook.systemMessage?.split("\n").length, 1);
  assert.match(hook.additionalContext ?? "", /skill foo@shared: active now/);
  assert.match(hook.additionalContext ?? "", /agent bar@shared: active after \/reload-plugins/);
  assert.match(hook.additionalContext ?? "", /untrusted source team \(local \/src\/team\); run: skilletor trust team/);
});

test("a config error is notable and reported", () => {
  const r: SyncReport = { scopes: [], error: "invalid JSON" };
  assert.equal(hasNotable(r), true);
  assert.match(reportText(r), /config error.*invalid JSON/);
});

// k86: a config error rendered for a hook (the pending report of a background sync) said
// "changes applied". Asserts: the hook output is exactly SessionStart's check-error shape –
// one systemMessage line "skilletor: <error>", no additionalContext.
test("k86: a config error renders as one warning line in the hook, never 'changes applied'", () => {
  const r: SyncReport = { scopes: [], error: "/p/.claude/skilletor.json: invalid JSON (x)" };
  assert.deepEqual(reportHook(r), { systemMessage: "skilletor: /p/.claude/skilletor.json: invalid JSON (x)" });
});

// k86: an error means nothing was touched (the engine sends no scopes with it). Asserts: a
// report that carries scopes anyway renders the error alone in the hook, as it does in text.
test("k86: an error wins over scope contents in the hook, as in the text report", () => {
  const r: SyncReport = { ...sample(), error: "invalid JSON" };
  assert.deepEqual(reportHook(r), { systemMessage: "skilletor: invalid JSON" });
  assert.equal(reportText(r), "skilletor: config error, nothing changed — invalid JSON");
});

test("hasChanges is true only for add/update/remove", () => {
  const onlyWarn = emptyScopeReport("user");
  onlyWarn.warnings = ["x"];
  assert.equal(hasChanges({ scopes: [onlyWarn] }), false);
  assert.equal(hasNotable({ scopes: [onlyWarn] }), true);
  assert.equal(hasChanges(sample()), true);
});

// ---- skipped items (k35) ----------------------------------------------------

test("skipped items get their own text line and do not make a hook report", () => {
  const s = emptyScopeReport("project");
  s.skipped = [{ key: "rules/k8s", type: "rule", name: "k8s", source: "shared" }];
  const r: SyncReport = { scopes: [s] };
  assert.match(reportText(r), /rules\/k8s skipped \(renders empty\)/);
  assert.doesNotMatch(reportText(r), /warning|error/i);
  assert.equal(hasNotable(r), false);
  assert.deepEqual(reportHook(r), {});
});

test("a skipped item that was removed shows as one removal line", () => {
  const s = emptyScopeReport("user");
  const it = { key: "rules/k8s", type: "rule" as const, name: "k8s", source: "shared" };
  s.removed = [it];
  s.skipped = [it];
  const text = reportText({ scopes: [s] });
  assert.match(text, /- rules\/k8s \(removed: renders empty\)/);
  assert.equal(text.split("\n").filter((l) => l.includes("rules/k8s")).length, 1);
});

// ---- k62: commit hint, plain-path conflicts --------------------------------------

test("a created or changed .gitignore block is notable and asks for a commit in text and hook", () => {
  const user = emptyScopeReport("user");
  user.gitignoreUpdated = ["~/.claude/.gitignore"];
  const project = emptyScopeReport("project");
  project.gitignoreUpdated = [".claude/.gitignore"];
  const one: SyncReport = { scopes: [project] };
  assert.equal(hasNotable(one), true);
  assert.equal(hasChanges(one), false);
  assert.equal(reportText(one), "skilletor: project scope\n  .claude/.gitignore updated — commit it");
  assert.deepEqual(reportHook(one), {
    systemMessage: "skilletor: .claude/.gitignore updated — commit it",
    additionalContext: "- .claude/.gitignore updated — commit it",
  });
  const both = reportHook({ scopes: [user, project] });
  assert.equal(both.systemMessage, "skilletor: ~/.claude/.gitignore, .claude/.gitignore updated — commit them");
  assert.equal(both.additionalContext, "- ~/.claude/.gitignore updated — commit it\n- .claude/.gitignore updated — commit it");
});

test("a plain-path conflict says --force replaces the file; an ordinary one says it adopts", () => {
  const s = emptyScopeReport("project");
  s.conflicts = [{ path: "agents/a.md", replace: true }, { path: "skills/x/SKILL.md" }];
  const text = reportText({ scopes: [s] });
  assert.match(text, /^ {2}conflict: agents\/a\.md already exists \(use --force to replace it\)$/m);
  assert.match(text, /^ {2}conflict: skills\/x\/SKILL\.md already exists \(use --force to adopt\)$/m);
});

// k71: a directory (or other non-file) where an item has a file is a conflict --force does
// not resolve (skilletor never deletes a directory tree). Asserts: its hint says so and
// names what the user does instead; the hint is one function of the conflict's data, so a
// hook can show the same words (k72).
test("a conflict that is not a file says to move or remove it, not --force", () => {
  const s = emptyScopeReport("user");
  s.conflicts = [{ path: "skills/x/SKILL.md", notFile: true }, { path: "agents/a.md", replace: true }, { path: "skills/y/SKILL.md" }];
  const text = reportText({ scopes: [s] });
  assert.match(text, /^ {2}conflict: skills\/x\/SKILL\.md is not a file \(move or remove it yourself; --force leaves it\)$/m);
  assert.match(text, /^ {2}conflict: agents\/a\.md already exists \(use --force to replace it\)$/m);
  assert.match(text, /^ {2}conflict: skills\/y\/SKILL\.md already exists \(use --force to adopt\)$/m);
  assert.deepEqual(s.conflicts.map(conflictHint), [
    "is not a file (move or remove it yourself; --force leaves it)",
    "already exists (use --force to replace it)",
    "already exists (use --force to adopt)",
  ]);
});

// ---- k72: the hook context names what the systemMessage counts -------------------

// Asserts: every conflict gets one context line – its scope, its path and the same hint the
// text report shows (`conflictHint`, so the two cannot drift apart); the scope is named
// because a Claude path is relative to `.claude` and would not say which one.
test("the hook context names every conflict with its scope, path and the text report's hint", () => {
  const user = emptyScopeReport("user");
  user.conflicts = [{ path: "skills/x/SKILL.md", notFile: true }, { path: "agents/a.md", replace: true }];
  const project = emptyScopeReport("project");
  project.conflicts = [{ path: "skills/y/SKILL.md" }];
  const r: SyncReport = { scopes: [user, project] };
  const hook = reportHook(r);
  assert.equal(hook.systemMessage, "skilletor: 3 warning(s)");
  assert.equal(hook.additionalContext, [
    `- conflict in user scope: skills/x/SKILL.md ${conflictHint({ notFile: true })}`,
    `- conflict in user scope: agents/a.md ${conflictHint({ replace: true })}`,
    `- conflict in project scope: skills/y/SKILL.md ${conflictHint({})}`,
  ].join("\n"));
  assert.match(hook.additionalContext ?? "", /skills\/x\/SKILL\.md is not a file \(move or remove it yourself; --force leaves it\)/);
  // The text report carries the same path and hint.
  for (const c of [...user.conflicts, ...project.conflicts]) {
    assert.ok(reportText(r).includes(`conflict: ${c.path} ${conflictHint(c)}`));
  }
});

// Asserts: a managed file whose local change the sync overwrote is named in the context
// too, with its scope – it is counted as a warning like a conflict.
test("the hook context names every overwritten local change with its scope", () => {
  const s = emptyScopeReport("project");
  s.overwritten = [{ path: "skills/x/SKILL.md" }, { path: ".codex/skilletor-rules.md#rules/k8s" }];
  const hook = reportHook({ scopes: [s] });
  assert.equal(hook.systemMessage, "skilletor: 2 warning(s)");
  assert.equal(hook.additionalContext, [
    "- overwrote local change in project scope: skills/x/SKILL.md",
    "- overwrote local change in project scope: .codex/skilletor-rules.md#rules/k8s",
  ].join("\n"));
});

// Asserts the card's claim in general: the systemMessage's warning count equals the number
// of context lines the model gets for them – one per warning, conflict, trust request and
// overwritten file – so "N warning(s)" never comes without N things to act on.
test("every warning the systemMessage counts has its own context line", () => {
  const s = emptyScopeReport("user");
  s.warnings = ["source team offline"];
  s.conflicts = [{ path: "skills/y/SKILL.md" }];
  s.trustRequests = [{ name: "team", kind: "local", url: "/src/team" }];
  s.overwritten = [{ path: "skills/x/SKILL.md" }];
  const hook = reportHook({ scopes: [s] });
  assert.equal(hook.systemMessage, "skilletor: 4 warning(s)");
  assert.equal(hook.additionalContext?.split("\n").length, 4);
});

// ---- k87: strings from a config, a source or git are display-safe ----------------------

/** An ANSI color escape, a BEL, a right-to-left override and a newline: what a cloned
 *  project config, a source's files or git's stderr can put into a report. */
const EVIL = "\u001b[31mred\u0007\u202eevil\nnext";
/** How EVIL shows: each of them escaped the JSON way, the text around them as it was. */
const SHOWN = "\\u001b[31mred\\u0007\\u202eevil\\nnext";
/** A character no display line carries raw (a tab may; a newline only between lines). */
const RAW = /(?![\t\n])[\p{Cc}\p{Bidi_Control}\u200b\u2028\u2029\u2060\ufeff]/u;

// Asserts: every character that can move the cursor, recolor, reorder or hide text – C0
// controls but tab (as JSON.stringify writes them), DEL, C1, the Unicode bidi controls, the
// line and paragraph separators, the invisible zero-width space, word joiner and BOM – shows
// as its escape; ordinary text (umlauts, CJK, emoji with a ZWJ, Persian with a ZWNJ, a tab,
// backslashes, a literal "\u001b") comes back unchanged.
test("k87: displaySafe escapes control, bidi and invisible characters and keeps ordinary text", () => {
  const cases: [string, string][] = [
    ["\u0000", "\\u0000"], ["\u0007", "\\u0007"], ["\b", "\\b"], ["\n", "\\n"], ["\u000b", "\\u000b"], ["\f", "\\f"],
    ["\r", "\\r"], ["\u001b", "\\u001b"], ["\u001f", "\\u001f"], ["\u007f", "\\u007f"], ["\u0085", "\\u0085"],
    ["\u009b", "\\u009b"], ["\u061c", "\\u061c"], ["\u200e", "\\u200e"], ["\u200f", "\\u200f"], ["\u202a", "\\u202a"],
    ["\u202e", "\\u202e"], ["\u2066", "\\u2066"], ["\u2069", "\\u2069"], ["\u2028", "\\u2028"], ["\u2029", "\\u2029"],
    ["\u200b", "\\u200b"], ["\u2060", "\\u2060"], ["\ufeff", "\\ufeff"],
  ];
  for (const [raw, shown] of cases) assert.equal(displaySafe(`a${raw}b`), `a${shown}b`, JSON.stringify(raw));
  const ordinary = "Grüße, 日本語, 🍳 👨\u200d👩\u200d👧, می\u200cخواهم, a\ttab, C:\\dir\\x, literal \\u001b — ‹ok›";
  assert.equal(displaySafe(ordinary), ordinary);
  assert.equal(displaySafe(EVIL), SHOWN);
});

// Asserts: a trust request whose name and address carry EVIL, a conflict path from a source's
// file names, a scope warning and a run-level warning show escaped in the text report, each
// still on one line of its own, no raw character anywhere; the report's own line breaks stay.
// A config error naming such a source is one escaped line too.
test("k87: reportText escapes config-, source- and git-derived strings, one line each", () => {
  const s = emptyScopeReport("project");
  s.conflicts = [{ path: `skills/foo/${EVIL}.md` }];
  s.trustRequests = [{ name: `team${EVIL}`, kind: "local", url: `/src/${EVIL}` }];
  s.warnings = [`git fetch failed: ${EVIL}`];
  const text = reportText({ scopes: [s], warnings: [`codex: ${EVIL}`] });
  assert.doesNotMatch(text, RAW);
  assert.deepEqual(text.split("\n"), [
    "skilletor: project scope",
    `  conflict: skills/foo/${SHOWN}.md already exists (use --force to adopt)`,
    `  trust: source "team${SHOWN}" (local /src/${SHOWN}) — run: skilletor trust team${SHOWN}`,
    `  warning: git fetch failed: ${SHOWN}`,
    `skilletor: warning: codex: ${SHOWN}`,
  ]);
  assert.equal(
    reportText({ scopes: [], error: `sources.team${EVIL}: unknown key` }),
    `skilletor: config error, nothing changed — sources.team${SHOWN}: unknown key`,
  );
});

// Asserts: the hook output escapes the same strings – a synced item's source name, an
// overwritten path, a trust request, a warning – with the systemMessage one line and exactly
// one context line per counted warning (a newline inside a value no longer splits one in
// two); a config error is one escaped systemMessage line.
test("k87: reportHook escapes them too: one systemMessage line, one context line per warning", () => {
  const s = emptyScopeReport("project");
  s.added = [{ key: "skills/foo", type: "skill", name: "foo", source: `team${EVIL}` }];
  s.overwritten = [{ path: `skills/foo/${EVIL}.md` }];
  s.trustRequests = [{ name: `team${EVIL}`, kind: "local", url: `/src/${EVIL}` }];
  s.warnings = [`git fetch failed: ${EVIL}`];
  const hook = reportHook({ scopes: [s] });
  assert.equal(hook.systemMessage, "skilletor: 1 item(s) updated, 3 warning(s)");
  assert.doesNotMatch(hook.additionalContext ?? "", RAW);
  assert.deepEqual(hook.additionalContext?.split("\n"), [
    "skilletor synced items:",
    `- skill foo@team${SHOWN}: active now`,
    `- overwrote local change in project scope: skills/foo/${SHOWN}.md`,
    `- untrusted source team${SHOWN} (local /src/${SHOWN}); run: skilletor trust team${SHOWN}`,
    `- warning: git fetch failed: ${SHOWN}`,
  ]);
  assert.deepEqual(reportHook({ scopes: [], error: `sources.team${EVIL}: unknown key` }), {
    systemMessage: `skilletor: sources.team${SHOWN}: unknown key`,
  });
});
