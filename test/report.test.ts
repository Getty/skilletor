// Tests for report formatting (spec §8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportText, reportHook, hasChanges, hasNotable, emptyScopeReport, type SyncReport } from "../src/report.ts";

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
