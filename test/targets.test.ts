// Harness targets (spec §14): detection markers, the targets merge rule, lock keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import {
  defaultMarkers, detectHarnesses, lacksLocalPrefix, lockKey, parseLockKey, placeOutput, rootOfKey, selectTargets, targetDrift,
  TargetError,
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
  assert.equal(rootOfKey(u("/b"), "codex:rules/foo"), join("/b", ".codex")); // $CODEX_HOME/skilletor-rules.md
  assert.equal(rootOfKey({ base: "/p", scope: "project" }, "codex:rules/foo"), join("/p", ".codex")); // <repo>/.codex/skilletor-rules.md
  assert.equal(rootOfKey(u("/b"), "future:skills/foo"), undefined);
});

test("targetDrift: the lock must cover every active target that takes the type, and no inactive one", () => {
  assert.equal(targetDrift([], ["claude", "codex"]), false);
  assert.equal(targetDrift(["skills/a"], ["claude"]), false);
  assert.equal(targetDrift(["skills/a"], ["claude", "codex"]), true); // codex copy missing
  assert.equal(targetDrift(["skills/a", "codex:skills/a"], ["claude", "codex"]), false);
  assert.equal(targetDrift(["skills/a", "codex:skills/a"], ["claude"]), true); // codex switched off
  assert.equal(targetDrift(["rules/y"], ["claude", "codex"]), true); // codex takes rules (phase 3)
  assert.equal(targetDrift(["rules/y", "codex:rules/y"], ["claude", "codex"]), false);
  assert.equal(targetDrift(["agents/x"], ["claude", "codex"]), true); // codex takes agents (phase 2)
  assert.equal(targetDrift(["future:skills/a"], ["claude"]), false); // unknown prefix: kept, no drift
});

// k62: agents and rules install as `.local.<name>`, claiming their plain path (spec §6.3).
test("placeOutput prefixes Claude agents and rules and Codex agents; skills and Codex rules keep their paths", () => {
  const out = (...paths: string[]) => new Map(paths.map((p) => [p, Buffer.from(p)]));
  const placed = (h: "claude" | "codex", t: "skill" | "agent" | "rule", ...paths: string[]) => {
    const r = placeOutput(h, t, out(...paths));
    return { paths: [...r.output.keys()], claims: r.claims };
  };
  assert.deepEqual(placed("claude", "agent", "agents/a.md"), { paths: ["agents/.local.a.md"], claims: ["agents/a.md"] });
  assert.deepEqual(placed("claude", "rule", "rules/lang/perl.md"), { paths: ["rules/lang/.local.perl.md"], claims: ["rules/lang/perl.md"] });
  assert.deepEqual(placed("codex", "agent", "agents/a.toml"), { paths: ["agents/.local.a.toml"], claims: ["agents/a.toml"] });
  assert.deepEqual(placed("codex", "rule", "skilletor-rules.md"), { paths: ["skilletor-rules.md"], claims: [] });
  assert.deepEqual(placed("claude", "skill", "skills/s/SKILL.md"), { paths: ["skills/s/SKILL.md"], claims: [] });
  assert.deepEqual(placed("codex", "skill", "skills/s/SKILL.md"), { paths: ["skills/s/SKILL.md"], claims: [] });
  // The bytes travel with the renamed path.
  assert.equal(placeOutput("claude", "agent", out("agents/a.md")).output.get("agents/.local.a.md")!.toString(), "agents/a.md");
});

// k64: `check` spots the layout before k62 by the installed paths alone (spec §14.3).
test("lacksLocalPrefix: a plain file of an agent or rule is the old layout; skills and Codex rules never are", () => {
  assert.equal(lacksLocalPrefix("claude", "agent", ["agents/.local.a.md"]), false);
  assert.equal(lacksLocalPrefix("claude", "agent", ["agents/a.md"]), true);
  assert.equal(lacksLocalPrefix("claude", "rule", ["rules/lang/.local.perl.md"]), false);
  assert.equal(lacksLocalPrefix("claude", "rule", ["rules/.local.lang/perl.md"]), true); // the file name counts
  assert.equal(lacksLocalPrefix("codex", "agent", ["agents/.local.a.toml", "agents/b.toml"]), true);
  assert.equal(lacksLocalPrefix("codex", "rule", ["skilletor-rules.md"]), false);
  assert.equal(lacksLocalPrefix("claude", "skill", ["skills/s/SKILL.md"]), false);
});
