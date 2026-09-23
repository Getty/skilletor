// Harness targets (spec §14): detection markers, the targets merge rule, lock keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import {
  defaultMarkers, detectHarnesses, lockKey, parseLockKey, rootOfKey, selectTargets, targetDrift, TargetError,
} from "../src/targets.ts";

test("default markers: Claude by its own files, never by ~/.claude alone", () => {
  const tmp = makeTmpDir();
  try {
    const home = tmp.dir;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "skilletor.json"), "{}"); // skilletor's own file
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined)), []);
    writeFileSync(join(home, ".claude.json"), "{}");
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined)), ["claude"]);
  } finally {
    tmp.cleanup();
  }
});

test("default markers: Codex under CODEX_HOME, else ~/.codex; an empty dir is not enough", () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp.dir, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined)), []);
    writeFileSync(join(home, ".codex", "installation_id"), "x");
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined)), ["codex"]);

    const codexHome = join(tmp.dir, "cx");
    mkdirSync(codexHome);
    assert.deepEqual(detectHarnesses(defaultMarkers(home, codexHome)), []); // ~/.codex ignored
    writeFileSync(join(codexHome, "config.toml"), "");
    assert.deepEqual(detectHarnesses(defaultMarkers(home, codexHome)), ["codex"]);
  } finally {
    tmp.cleanup();
  }
});

test("selectTargets: detected set when nothing is configured", () => {
  assert.deepEqual(selectTargets({}, ["claude", "codex"]), { user: ["claude", "codex"], project: ["claude", "codex"], warnings: [] });
  assert.deepEqual(selectTargets({}, ["codex"]).user, ["codex"]);
});

test("selectTargets: user targets override detection", () => {
  assert.deepEqual(selectTargets({ user: ["codex"] }, ["claude"]).user, ["codex"]);
  assert.deepEqual(selectTargets({ user: ["claude"] }, []).user, ["claude"]);
});

test("selectTargets: nothing detected and nothing configured is an error naming the fix", () => {
  assert.throws(() => selectTargets({}, []), (err: Error) =>
    err instanceof TargetError && /no agent harness detected/.test(err.message) && /"targets"/.test(err.message));
});

test("selectTargets: project targets only narrow the machine targets", () => {
  assert.deepEqual(selectTargets({ project: ["claude"] }, ["claude", "codex"]).project, ["claude"]);
  // A project cannot add a harness the machine does not use.
  const s = selectTargets({ project: ["claude", "codex"] }, ["claude"]);
  assert.deepEqual(s.project, ["claude"]);
  assert.deepEqual(s.warnings, []);
  const none = selectTargets({ project: ["codex"] }, ["claude"]);
  assert.deepEqual(none.project, []);
  assert.match(none.warnings[0] ?? "", /project targets \(codex\) are not in use/);
  assert.deepEqual(none.user, ["claude"]);
});

const u = (base: string) => ({ base, scope: "user" as const });

test("lock keys: claude unprefixed, codex prefixed; roots per harness and type", () => {
  assert.equal(lockKey("claude", "skills/foo"), "skills/foo");
  assert.equal(lockKey("codex", "skills/foo"), "codex:skills/foo");
  assert.deepEqual(parseLockKey("skills/foo"), { harness: "claude", target: "skills/foo", type: "skill", name: "foo" });
  assert.deepEqual(parseLockKey("codex:skills/foo"), { harness: "codex", target: "skills/foo", type: "skill", name: "foo" });
  assert.equal(parseLockKey("future:skills/foo").harness, undefined);
  assert.equal(rootOfKey(u("/b"), "skills/foo"), join("/b", ".claude"));
  assert.equal(rootOfKey(u("/b"), "codex:skills/foo"), join("/b", ".agents"));
  assert.equal(rootOfKey(u("/b"), "codex:agents/foo"), join("/b", ".codex")); // user: default Codex home
  assert.equal(rootOfKey({ ...u("/b"), codexHome: "/cx" }, "codex:agents/foo"), "/cx");
  assert.equal(rootOfKey({ base: "/p", scope: "project", codexHome: "/cx" }, "codex:agents/foo"), join("/p", ".codex"));
  assert.equal(rootOfKey(u("/b"), "codex:rules/foo"), undefined); // not written until phase 3
  assert.equal(rootOfKey(u("/b"), "future:skills/foo"), undefined);
});

test("targetDrift: the lock must cover every active target that takes the type, and no inactive one", () => {
  assert.equal(targetDrift([], ["claude", "codex"]), false);
  assert.equal(targetDrift(["skills/a"], ["claude"]), false);
  assert.equal(targetDrift(["skills/a"], ["claude", "codex"]), true); // codex copy missing
  assert.equal(targetDrift(["skills/a", "codex:skills/a"], ["claude", "codex"]), false);
  assert.equal(targetDrift(["skills/a", "codex:skills/a"], ["claude"]), true); // codex switched off
  assert.equal(targetDrift(["rules/y"], ["claude", "codex"]), false); // codex takes no rules (yet)
  assert.equal(targetDrift(["agents/x"], ["claude", "codex"]), true); // codex takes agents (phase 2)
  assert.equal(targetDrift(["future:skills/a"], ["claude"]), false); // unknown prefix: kept, no drift
});
