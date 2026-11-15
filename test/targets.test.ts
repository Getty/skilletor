// Harness targets (spec §14): detection markers, the targets merge rule, lock keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { SKILL_GITIGNORE } from "../src/gitignore.ts";
import {
  defaultMarkers, detectHarnesses, detectProjectHarnesses, lacksLocalPrefix, lockKey, parseLockKey, placeOutput, rootOfKey, selectTargets, targetGaps,
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

test("selectTargets: project evidence decides inside the machine allowlist, including explicit global both", () => {
  const both = ["claude", "codex"] as const;
  assert.deepEqual(selectTargets({ projectEvidence: ["claude"] }, [...both]), {
    user: [...both], project: ["claude"], warnings: [],
  });
  assert.deepEqual(selectTargets({ projectEvidence: ["codex"] }, [...both]).project, ["codex"]);
  assert.deepEqual(selectTargets({ projectEvidence: [...both] }, [...both]).project, [...both]);
  assert.deepEqual(selectTargets({ user: [...both], projectEvidence: ["claude"] }, []), {
    user: [...both], project: ["claude"], warnings: [],
  });
});

test("selectTargets: explicit project targets beat evidence; one machine target bootstraps", () => {
  assert.deepEqual(
    selectTargets({ project: ["codex"], projectEvidence: ["claude"] }, ["claude", "codex"]).project,
    ["codex"],
  );
  assert.deepEqual(selectTargets({ projectEvidence: [] }, ["codex"]), {
    user: ["codex"], project: ["codex"], warnings: [],
  });
});

test("selectTargets: no evidence with several machine targets is explicitly unresolved", () => {
  const s = selectTargets({ projectEvidence: [] }, ["claude", "codex"]);
  assert.deepEqual(s.user, ["claude", "codex"]);
  assert.deepEqual(s.project, ["claude", "codex"]);
  assert.equal(s.projectUnresolved, true);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0]!, /ambiguous.*set "targets".*left unchanged/i);
});

test("detectProjectHarnesses: genuine Claude and Codex evidence, both, and linked roots", () => {
  const tmp = makeTmpDir();
  try {
    const project = join(tmp.dir, "project");
    mkdirSync(project);
    writeFileSync(join(project, "CLAUDE.md"), "Use Claude.\n");
    assert.deepEqual(detectProjectHarnesses(project, {}), ["claude"]);

    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "config.toml"), "model = 'x'\n");
    assert.deepEqual(detectProjectHarnesses(project, {}), ["claude", "codex"]);

    const linked = join(tmp.dir, "linked");
    mkdirSync(linked);
    const other = join(tmp.dir, "other");
    mkdirSync(other);
    symlinkSync(other, join(linked, ".agents"));
    assert.deepEqual(detectProjectHarnesses(linked, {}), ["codex"]);

    const settingsOnly = join(tmp.dir, "settings-only");
    mkdirSync(join(settingsOnly, ".claude"), { recursive: true });
    writeFileSync(join(settingsOnly, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
    assert.deepEqual(detectProjectHarnesses(settingsOnly, {}), ["claude"]);
  } finally {
    tmp.cleanup();
  }
});

test("detectProjectHarnesses: empty and skilletor-only settings stay non-evidence beside genuine Codex config", () => {
  const tmp = makeTmpDir();
  try {
    const project = join(tmp.dir, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".claude/settings.json"), "{}\n");
    writeFileSync(join(project, ".codex/config.toml"), "model = 'x'\n");
    assert.deepEqual(detectProjectHarnesses(project, {}), ["codex"], "empty settings are not Claude evidence");

    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({
      enabledPlugins: { "skilletor@getty": true },
      extraKnownMarketplaces: { getty: { source: { source: "github", repo: "example/marketplace" } } },
    }));
    assert.deepEqual(detectProjectHarnesses(project, {}), ["codex"], "generated declarations do not change selection");

    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({
      extraKnownMarketplaces: { team: { source: { source: "github", repo: "example/team" } } },
    }));
    assert.deepEqual(detectProjectHarnesses(project, {}), ["claude", "codex"], "marketplace-only user config is evidence");

    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "skilletor@getty": false } }));
    assert.deepEqual(detectProjectHarnesses(project, {}), ["claude", "codex"], "an explicit false value is user evidence");

    for (const key of ["enabledPlugins", "extraKnownMarketplaces"]) {
      writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({ [key]: null }));
      assert.deepEqual(detectProjectHarnesses(project, {}), ["claude", "codex"], `${key}: explicit null is evidence`);
    }

    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
    assert.deepEqual(detectProjectHarnesses(project, {}), ["claude", "codex"], "genuine settings remain Claude evidence");
  } finally {
    tmp.cleanup();
  }
});

test("detectProjectHarnesses: leftover skill directories need SKILL.md for every harness", () => {
  const tmp = makeTmpDir();
  try {
    const roots = [[".claude", "claude"], [".agents", "codex"], [".hermes", "hermes"]] as const;
    for (const [root, harness] of roots) {
      const project = join(tmp.dir, harness);
      mkdirSync(join(project, root, "skills", "foo"), { recursive: true });
      writeFileSync(join(project, root, "skills", "foo", "MINE.txt"), "foreign\n");
      assert.deepEqual(detectProjectHarnesses(project, {}), [], `${harness}: a residual foreign file is no skill`);
      writeFileSync(join(project, root, "skills", "foo", "SKILL.md"), "owned\n");
      assert.deepEqual(detectProjectHarnesses(project, {}), [harness], `${harness}: a complete skill is evidence`);
    }
  } finally {
    tmp.cleanup();
  }
});

test("detectProjectHarnesses: skilletor outputs and generated-only roots are not evidence", () => {
  const tmp = makeTmpDir();
  try {
    const project = join(tmp.dir, "project");
    mkdirSync(join(project, ".claude", "agents"), { recursive: true });
    mkdirSync(join(project, ".claude", "skills", "foo"), { recursive: true });
    mkdirSync(join(project, ".agents", "skills", "foo"), { recursive: true });
    mkdirSync(join(project, ".codex", "agents"), { recursive: true });
    mkdirSync(join(project, ".hermes", "skills", "foo"), { recursive: true });
    writeFileSync(join(project, ".claude", "skilletor.json"), "{}\n");
    writeFileSync(join(project, ".claude", "skilletor.local.json"), "{}\n");
    writeFileSync(join(project, ".claude", ".gitignore"), "# >>> skilletor >>>\n# <<< skilletor <<<\n");
    writeFileSync(join(project, ".claude", "agents", ".local.helper.md"), "generated\n");
    writeFileSync(join(project, ".codex", "agents", ".local.helper.toml"), "generated\n");
    writeFileSync(join(project, ".codex", "skilletor-rules.md"), "<!-- skilletor:rules scope=project -->\n");
    for (const root of [join(project, ".claude"), join(project, ".agents"), join(project, ".hermes")]) {
      writeFileSync(join(root, "skills", "foo", "SKILL.md"), "generated\n");
      writeFileSync(join(root, "skills", "foo", ".gitignore"), SKILL_GITIGNORE);
    }
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: { "skilletor@getty": true },
      extraKnownMarketplaces: { getty: { source: { source: "github", repo: "example/marketplace" } } },
    }));
    const lock = {
      "skills/foo": { source: "s", version: "v", files: { "skills/foo/SKILL.md": "h" } },
      "agents/legacy": { source: "s", version: "v", files: { "agents/legacy.md": "h" } },
      "codex:skills/foo": { source: "s", version: "v", files: { "skills/foo/SKILL.md": "h" } },
      "codex:agents/legacy": { source: "s", version: "v", files: { "agents/legacy.toml": "h" } },
      "hermes:skills/foo": { source: "s", version: "v", files: { "skills/foo/SKILL.md": "h" } },
    };
    assert.deepEqual(detectProjectHarnesses(project, {}), [], "markers exclude known generated artifacts without a lock");
    writeFileSync(join(project, ".claude/agents/legacy.md"), "old generated layout\n");
    writeFileSync(join(project, ".codex/agents/legacy.toml"), "old_generated = true\n");
    assert.deepEqual(detectProjectHarnesses(project, lock), []);
  } finally {
    tmp.cleanup();
  }
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

test("targetGaps: the lock must cover every active target that takes the type, and no inactive one", () => {
  assert.deepEqual(targetGaps([], ["claude", "codex"]), []);
  assert.deepEqual(targetGaps(["skills/a"], ["claude"]), []);
  assert.deepEqual(targetGaps(["skills/a"], ["claude", "codex"]), [{ key: "skills/a", missing: "codex:skills/a" }]); // codex copy missing
  assert.deepEqual(targetGaps(["skills/a", "codex:skills/a"], ["claude", "codex"]), []);
  assert.deepEqual(targetGaps(["skills/a", "codex:skills/a"], ["claude"]), [{ key: "codex:skills/a" }]); // codex switched off
  assert.deepEqual(targetGaps(["rules/y"], ["claude", "codex"]), [{ key: "rules/y", missing: "codex:rules/y" }]); // codex takes rules (phase 3)
  assert.deepEqual(targetGaps(["rules/y", "codex:rules/y"], ["claude", "codex"]), []);
  assert.deepEqual(targetGaps(["agents/x"], ["claude", "codex"]), [{ key: "agents/x", missing: "codex:agents/x" }]); // codex takes agents (phase 2)
  assert.deepEqual(targetGaps(["future:skills/a"], ["claude"]), []); // unknown prefix: kept, no drift
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
