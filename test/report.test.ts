// Tests for report formatting (spec §8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportText, reportHook, hasChanges, hasNotable, emptyScopeReport, type SyncReport } from "../src/report.ts";

function sample(): SyncReport {
  const s = emptyScopeReport("user");
  s.added = [{ key: "skills/foo", type: "skill", name: "foo", source: "shared" }];
  s.updated = [{ key: "agents/bar", type: "agent", name: "bar", source: "shared" }];
  s.warnings = ["source team offline"];
  s.trustRequests = [{ name: "team", url: "https://github.com/Getty/skills" }];
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
  assert.match(text, /trust: source "team"/);
  assert.match(text, /warning: source team offline/);
});

test("hook output has a one-line systemMessage and a per-item additionalContext", () => {
  const hook = reportHook(sample());
  assert.equal(hook.systemMessage?.split("\n").length, 1);
  assert.match(hook.additionalContext ?? "", /skill foo@shared: active now/);
  assert.match(hook.additionalContext ?? "", /agent bar@shared: active after \/reload-plugins/);
  assert.match(hook.additionalContext ?? "", /untrusted source team/);
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
