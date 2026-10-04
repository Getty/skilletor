// The `hermes` target through the engine (spec §16): detection, the layout in both scopes,
// what Hermes gets no copy of, the one Hermes home a user-scope lock serves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { buildToString } from "../scripts/esbuild.config.mjs";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";
import { check, status, sync, type EngineContext } from "../src/engine.ts";
import { reportHook, reportText } from "../src/report.ts";
import { runHook } from "../src/hooks.ts";
import { readLock } from "../src/lock.ts";
import { loadConfig, type Harness } from "../src/config.ts";
import { State } from "../src/state.ts";
import { SKILL_GITIGNORE } from "../src/gitignore.ts";
import {
  allRoots, defaultMarkers, detectHarnesses, lockKey, parseLockKey, receivers, rootOfKey, selectTargets, targetGaps,
  TargetError,
} from "../src/targets.ts";

function env(harnesses: Harness[]) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  const hermesHome = join(tmp.dir, "hermes-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  // A marker per harness "in use"; the helper never touches the real machine.
  const markerOf = (h: Harness) => join(tmp.dir, `marker-${h}`);
  for (const h of harnesses) writeFileSync(markerOf(h), "");
  const ctx: EngineContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: { claude: [markerOf("claude")], codex: [markerOf("codex")], hermes: [markerOf("hermes")] },
    codexHome: join(home, ".codex"), // never the real $CODEX_HOME
    hermesHome, // never the real $HERMES_HOME
    isGitWorkTree: () => false,
  };
  const writeCfg = (which: "user" | "project", obj: unknown) => {
    const file = join(which === "user" ? home : projectDir, ".claude", "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  return { tmp, ctx, home, projectDir, hermesHome, writeCfg, cleanup: () => tmp.cleanup() };
}

/** A local source with the given files (relative path -> content). */
function source(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return resolvePath(dir);
}

const SKILL = (n: string, body = "BODY") => `---\nname: ${n}\ndescription: ${n}\n---\n${body}\n`;
const AGENT = (n: string) => `---\nname: ${n}\ndescription: ${n}\n---\nYou are ${n}.\n`;
/** The drift a check found, per kind – a local source itself always counts as changed (spec §4.4). */
const driftOf = async (ctx: EngineContext, opts: { scope?: "user" | "project" } = {}) => {
  const c = await check(ctx, opts);
  assert.equal(c.error, undefined);
  return { targets: c.targetsChanged, layout: c.layoutChanged, declared: c.declaredChanged, vars: c.varsChanged };
};
const NONE = { targets: undefined, layout: undefined, declared: undefined, vars: undefined };
const userLock = (e: { home: string }) => readLock(join(e.home, ".claude/skilletor.lock.json"));
const projectLock = (e: { projectDir: string }) => readLock(join(e.projectDir, ".claude/skilletor.lock.json"));

// ---- targets.ts -------------------------------------------------------------------------

test("default markers: Hermes by the files it creates in its home, never by skills/ alone", () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp.dir, "home");
    mkdirSync(join(home, ".hermes", "skills"), { recursive: true }); // skilletor makes this one itself
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined, undefined)), []);
    writeFileSync(join(home, ".hermes", "SOUL.md"), "");
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined, undefined)), ["hermes"]);

    const other = join(tmp.dir, "hh");
    mkdirSync(other);
    assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined, other)), []); // ~/.hermes ignored
    for (const marker of ["config.yaml", ".env", "sessions"]) {
      writeFileSync(join(other, marker), "");
      assert.deepEqual(detectHarnesses(defaultMarkers(home, undefined, other)), ["hermes"], marker);
      rmSync(join(other, marker));
    }
  } finally {
    tmp.cleanup();
  }
});

test("a marker set without a hermes entry means Hermes is not in use", () => {
  const tmp = makeTmpDir();
  try {
    assert.deepEqual(detectHarnesses({ claude: [tmp.dir], codex: [] }), ["claude"]);
    assert.throws(() => selectTargets({}, [], { claude: [], codex: [] }), (err: Error) =>
      err instanceof TargetError && /no agent harness detected/.test(err.message) && /"hermes"/.test(err.message));
  } finally {
    tmp.cleanup();
  }
});

test("lock keys and roots: hermes: prefix; the Hermes home for the user scope, <repo>/.hermes for a project", () => {
  assert.equal(lockKey("hermes", "skills/foo"), "hermes:skills/foo");
  assert.deepEqual(parseLockKey("hermes:skills/foo"), { harness: "hermes", target: "skills/foo", type: "skill", name: "foo" });
  assert.equal(rootOfKey({ base: "/h", scope: "user" }, "hermes:skills/foo"), join("/h", ".hermes"));
  assert.equal(rootOfKey({ base: "/h", scope: "user", hermesHome: "/srv/hermes" }, "hermes:skills/foo"), "/srv/hermes");
  assert.equal(rootOfKey({ base: "/p", scope: "project", hermesHome: "/srv/hermes" }, "hermes:skills/foo"), join("/p", ".hermes"));
  // No counterpart for agents and rules (spec §16.2): such a key has no root.
  assert.equal(rootOfKey({ base: "/h", scope: "user" }, "hermes:agents/foo"), undefined);
  assert.equal(rootOfKey({ base: "/h", scope: "user" }, "hermes:rules/foo"), undefined);
});

test("receivers: who gets a copy of a type; a project skill reaches Hermes through the Codex copy", () => {
  const all: Harness[] = ["claude", "codex", "hermes"];
  assert.deepEqual(receivers(all, "skill", "user"), ["claude", "codex", "hermes"]);
  assert.deepEqual(receivers(all, "skill", "project"), ["claude", "codex"]);
  assert.deepEqual(receivers(["claude", "hermes"], "skill", "project"), ["claude", "hermes"]);
  assert.deepEqual(receivers(all, "agent", "user"), ["claude", "codex"]);
  assert.deepEqual(receivers(all, "rule", "project"), ["claude", "codex"]);
  assert.deepEqual(receivers(["hermes"], "agent", "user"), []);
});

test("targetGaps: a Hermes copy is missing in the user scope, superfluous in a project Codex serves", () => {
  assert.deepEqual(targetGaps(["skills/foo"], ["claude", "hermes"]), [{ key: "skills/foo", missing: "hermes:skills/foo" }]);
  assert.deepEqual(targetGaps(["skills/foo", "hermes:skills/foo"], ["claude", "hermes"], "project"), []);
  assert.deepEqual(targetGaps(["skills/foo", "codex:skills/foo"], ["claude", "codex", "hermes"], "project"), []);
  assert.deepEqual(
    targetGaps(["codex:skills/foo", "hermes:skills/foo"], ["codex", "hermes"], "project"), [{ key: "hermes:skills/foo" }]);
  // An agent is never missing for Hermes.
  assert.deepEqual(targetGaps(["agents/a"], ["claude", "hermes"]), []);
});

test("allRoots: a Hermes root is none of the roots that hold a .gitignore block", () => {
  const roots = allRoots({ base: "/p", scope: "project", hermesHome: "/srv/hermes" });
  assert.deepEqual(roots, [join("/p", ".claude"), join("/p", ".agents"), join("/p", ".codex")]);
});

test("config: targets accepts hermes", () => {
  const e = env([]);
  try {
    e.writeCfg("user", { targets: ["hermes"] });
    assert.deepEqual(loadConfig({ home: e.home }).user.targets, ["hermes"]);
  } finally {
    e.cleanup();
  }
});

// ---- sync: the layout -------------------------------------------------------------------

test("hermes only: a user skill goes to <Hermes home>/skills, nothing to ~/.claude/skills", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "skills/foo/references/a.md": "A\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.equal(readFileSync(join(e.hermesHome, "skills/foo/SKILL.md"), "utf8"), SKILL("foo"));
    assert.equal(readFileSync(join(e.hermesHome, "skills/foo/references/a.md"), "utf8"), "A\n");
    assert.equal(readFileSync(join(e.hermesHome, "skills/foo/.gitignore"), "utf8"), SKILL_GITIGNORE);
    assert.equal(existsSync(join(e.home, ".claude/skills")), false);
    assert.equal(existsSync(join(e.home, ".hermes")), false); // the injected home, not the default
    assert.deepEqual(Object.keys(userLock(e)), ["hermes:skills/foo"]);
    assert.deepEqual(Object.keys(userLock(e)["hermes:skills/foo"]!.files),
      ["skills/foo/.gitignore", "skills/foo/SKILL.md", "skills/foo/references/a.md"]);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["hermes:skills/foo"]);
    assert.match(reportText(r), /\+ hermes:skills\/foo \(active from the next Hermes session\)/);
    assert.equal(reportHook(r).additionalContext,
      "skilletor synced items:\n- skill foo@mine (hermes): active from the next Hermes session");
    assert.equal(r.notes, undefined);
    assert.deepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
  } finally {
    e.cleanup();
  }
});

test("a project skill goes to <repo>/.hermes/skills; the .hermes root gets no .gitignore block", async () => {
  const e = env(["claude", "hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md.njk": SKILL("foo", "for {{ harness }} in {{ target.dir }}") });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx);
    assert.equal(r.error, undefined);
    const root = join(e.projectDir, ".hermes");
    assert.equal(readFileSync(join(root, "skills/foo/SKILL.md"), "utf8"), SKILL("foo", `for hermes in ${root}`));
    assert.equal(readFileSync(join(root, "skills/foo/.gitignore"), "utf8"), SKILL_GITIGNORE);
    assert.equal(existsSync(join(root, ".gitignore")), false);
    assert.match(readFileSync(join(e.projectDir, ".claude/skills/foo/SKILL.md"), "utf8"), /for claude in /);
    assert.deepEqual(Object.keys(projectLock(e)).sort(), ["hermes:skills/foo", "skills/foo"]);
    assert.deepEqual(r.scopes[1]!.added.map((i) => i.key), ["skills/foo", "hermes:skills/foo"]);
  } finally {
    e.cleanup();
  }
});

test("a .gitignore of the user's in a Hermes root is left byte for byte", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    mkdirSync(join(e.projectDir, ".hermes"));
    const mine = "notes/\n\n\n# no newline at the end";
    writeFileSync(join(e.hermesHome, ".gitignore"), mine);
    writeFileSync(join(e.projectDir, ".hermes", ".gitignore"), mine);
    assert.equal((await sync({ ...e.ctx, isGitWorkTree: () => true })).error, undefined);
    assert.equal(readFileSync(join(e.hermesHome, ".gitignore"), "utf8"), mine);
    assert.equal(readFileSync(join(e.projectDir, ".hermes", ".gitignore"), "utf8"), mine);
  } finally {
    e.cleanup();
  }
});

test("uninstalling removes the Hermes copy and its directory; a foreign skill beside it stays", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    mkdirSync(join(e.hermesHome, "skills/own"), { recursive: true });
    writeFileSync(join(e.hermesHome, "skills/own/SKILL.md"), SKILL("own"));
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["hermes:skills/foo"]);
    assert.equal(existsSync(join(e.hermesHome, "skills/foo")), false);
    assert.equal(readFileSync(join(e.hermesHome, "skills/own/SKILL.md"), "utf8"), SKILL("own"));
    assert.deepEqual(userLock(e), {});
  } finally {
    e.cleanup();
  }
});

test("a skill directory skilletor did not install is a conflict and is not touched", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    mkdirSync(join(e.hermesHome, "skills/foo"), { recursive: true });
    writeFileSync(join(e.hermesHome, "skills/foo/SKILL.md"), "MINE\n");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.conflicts, [{ path: join(e.hermesHome, "skills/foo/SKILL.md") }]);
    assert.equal(readFileSync(join(e.hermesHome, "skills/foo/SKILL.md"), "utf8"), "MINE\n");
    assert.equal(existsSync(join(e.hermesHome, "skills/foo/.gitignore")), false);
    assert.deepEqual(userLock(e), {});
  } finally {
    e.cleanup();
  }
});

// ---- what Hermes gets no copy of --------------------------------------------------------

test("agents and rules install for Claude only; one note names what Hermes does not get", async () => {
  const e = env(["claude", "hermes"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "skills/foo/SKILL.md": SKILL("foo"),
      "agents/helper.md": AGENT("helper"),
      "agents/other.md": AGENT("other"),
      "rules/style.md": "Be terse.\n",
    });
    e.writeCfg("user", {
      sources: { mine: { local: src } },
      install: { skills: ["foo@mine"], agents: ["*@mine"], rules: ["style@mine"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(Object.keys(userLock(e)).sort(),
      ["agents/helper", "agents/other", "hermes:skills/foo", "rules/style", "skills/foo"]);
    assert.equal(existsSync(join(e.hermesHome, "agents")), false);
    assert.equal(existsSync(join(e.hermesHome, "rules")), false);
    assert.deepEqual(r.notes,
      ["2 agent(s) and 1 rule(s) not installed for Hermes (Hermes has no agent files and no rules directory)"]);
    assert.match(reportText(r), /^skilletor: note: 2 agent\(s\) and 1 rule\(s\) not installed for Hermes/m);
    // A note is not a warning: the hooks stay quiet about it (spec §16.3).
    const hook = reportHook(r);
    assert.doesNotMatch(`${hook.systemMessage}\n${hook.additionalContext}`, /not installed for Hermes|warning/);
    // Nothing to do next time, and still said by a sync that changes nothing.
    assert.deepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
    const again = await sync(e.ctx, { scope: "user" });
    assert.equal(again.notes?.length, 1);
    assert.equal(reportHook(again).systemMessage, undefined);
    // status: one row per harness that gets a copy.
    assert.deepEqual(status(e.ctx, { scope: "user" }).scopes[0]!.declared.map((d) => d.key).sort(),
      ["agents/helper", "agents/other", "hermes:skills/foo", "rules/style", "skills/foo"]);
  } finally {
    e.cleanup();
  }
});

test("hermes only: an agent is not installed anywhere, and that is no drift", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/helper.md": AGENT("helper") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(userLock(e), {});
    assert.deepEqual(r.notes, ["1 agent(s) not installed for Hermes (Hermes has no agent files and no rules directory)"]);
    assert.deepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
  } finally {
    e.cleanup();
  }
});

test("Claude and Codex without Hermes: no note, the report as before", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "agents/helper.md": AGENT("helper") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"], agents: ["helper@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.notes, undefined);
    assert.equal(existsSync(e.hermesHome + "/skills"), false);
    assert.deepEqual(Object.keys(userLock(e)).sort(), ["agents/helper", "codex:agents/helper", "codex:skills/foo", "skills/foo"]);
    assert.equal(reportHook(r).additionalContext, [
      "skilletor synced items:",
      "- skill foo@mine: active now",
      "- skill foo@mine (codex): active from the next Codex session",
      "- agent helper@mine: active after /reload-plugins or restart",
      "- agent helper@mine (codex): active from the next Codex session",
    ].join("\n"));
  } finally {
    e.cleanup();
  }
});

// ---- project skills where Codex is active too -------------------------------------------

test("a project with Codex active: Hermes gets no copy of its own, the Codex copy serves it", async () => {
  const e = env(["codex", "hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "skills/bar/SKILL.md": SKILL("bar") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    e.writeCfg("project", { install: { skills: ["foo@mine", "bar@mine"] } });
    const r = await sync(e.ctx);
    assert.equal(r.error, undefined);
    // User scope: Hermes does not read ~/.agents/skills, so it gets its copy.
    assert.deepEqual(Object.keys(userLock(e)).sort(), ["codex:skills/foo", "hermes:skills/foo"]);
    assert.deepEqual(Object.keys(projectLock(e)).sort(), ["codex:skills/bar", "codex:skills/foo"]);
    assert.equal(existsSync(join(e.projectDir, ".hermes")), false);
    assert.deepEqual(r.notes,
      ["2 skill(s) not installed for Hermes in the project scope (Hermes reads the Codex copy in .agents/skills)"]);
    assert.deepEqual(await driftOf(e.ctx), NONE);
    assert.deepEqual(status(e.ctx, { scope: "project" }).scopes[0]!.declared.map((d) => d.key),
      ["codex:skills/foo", "codex:skills/bar"]);
  } finally {
    e.cleanup();
  }
});

test("Codex becomes active in a project: check reports it, the sync removes Hermes' own copy", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    await sync(e.ctx);
    assert.equal(existsSync(join(e.projectDir, ".hermes/skills/foo/SKILL.md")), true);

    writeFileSync(join(e.tmp.dir, "marker-codex"), "");
    const chk = await check(e.ctx);
    assert.equal(chk.changed, true);
    assert.deepEqual(chk.targetsChanged, ["project"]);
    const r = await sync(e.ctx);
    assert.deepEqual(r.scopes[1]!.removed.map((i) => i.key), ["hermes:skills/foo"]);
    assert.deepEqual(r.scopes[1]!.added.map((i) => i.key), ["codex:skills/foo"]);
    assert.equal(existsSync(join(e.projectDir, ".hermes/skills")), false); // the root itself stays, as .agents does
    assert.equal(existsSync(join(e.projectDir, ".agents/skills/foo/SKILL.md")), true);
    assert.deepEqual(await driftOf(e.ctx), NONE);

    // And back: Codex gone, Hermes gets its own again.
    rmSync(join(e.tmp.dir, "marker-codex"));
    assert.notDeepEqual(await driftOf(e.ctx), NONE);
    await sync(e.ctx);
    assert.deepEqual(Object.keys(projectLock(e)), ["hermes:skills/foo"]);
    assert.equal(existsSync(join(e.projectDir, ".agents/skills")), false);
    assert.equal(existsSync(join(e.projectDir, ".hermes/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

// ---- the Hermes home --------------------------------------------------------------------

/** An env whose Hermes is detected by its own markers under the home a run is given. */
function homes() {
  const e = env([]);
  const { markers: _m, hermesHome: _h, ...ctx } = e.ctx;
  const make = (name: string) => {
    const dir = join(e.tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "");
    return dir;
  };
  writeFileSync(join(e.home, ".claude.json"), "{}"); // Claude Code is in use too
  return { ...e, ctx: ctx as EngineContext, make, state: () => new State(e.ctx.stateRoot) };
}

test("a sync under a Hermes home of its own records it; a run without one serves the same home", async () => {
  const e = homes();
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    // A Claude Code session before Hermes ever ran here: no ~/.hermes, so Claude alone.
    await sync(e.ctx, { scope: "user" });
    assert.deepEqual(Object.keys(userLock(e)), ["skills/foo"]);
    assert.equal(e.state().hermesHome(), undefined);

    // The plugin's run: $HERMES_HOME names the home.
    const a = e.make("home-a");
    const inHermes: EngineContext = { ...e.ctx, hermesHome: a };
    assert.notDeepEqual(await driftOf(inHermes, { scope: "user" }), NONE);
    await sync(inHermes, { scope: "user" });
    assert.equal(existsSync(join(a, "skills/foo/SKILL.md")), true);
    assert.equal(e.state().hermesHome(), a);

    // The next Claude Code session has no $HERMES_HOME: same targets, same root, nothing to do.
    assert.deepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.unchanged.map((i) => i.key).sort(), ["hermes:skills/foo", "skills/foo"]);
    assert.deepEqual(status(e.ctx, { scope: "user" }).scopes[0]!.targets, ["claude", "hermes"]);
    assert.equal(existsSync(join(e.home, ".hermes")), false);

    // A source that moves is brought to the Hermes home by that session too.
    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL("foo", "NEW"));
    await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(a, "skills/foo/SKILL.md"), "utf8"), SKILL("foo", "NEW"));
  } finally {
    e.cleanup();
  }
});

test("the default home needs no record", async () => {
  const e = homes();
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    mkdirSync(join(e.home, ".hermes"));
    writeFileSync(join(e.home, ".hermes", "SOUL.md"), "");
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".hermes/skills/foo/SKILL.md")), true);
    assert.equal(e.state().hermesHome(), undefined);
    // Named explicitly, it is the same home.
    assert.deepEqual(await driftOf({ ...e.ctx, hermesHome: join(e.home, ".hermes") }, { scope: "user" }), NONE);
  } finally {
    e.cleanup();
  }
});

test("another Hermes home: check reports it, the sync moves the items and takes nothing there for its own", async () => {
  const e = homes();
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "skills/bar/SKILL.md": SKILL("bar") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine", "bar@mine"] } });
    const a = e.make("home-a");
    const b = e.make("home-b");
    await sync({ ...e.ctx, hermesHome: a }, { scope: "user" });
    // Home b holds a skill of the user's own under a name skilletor installs.
    mkdirSync(join(b, "skills/bar"), { recursive: true });
    writeFileSync(join(b, "skills/bar/SKILL.md"), "MINE\n");

    const inB: EngineContext = { ...e.ctx, hermesHome: b };
    const chk = await check(inB, { scope: "user" });
    assert.equal(chk.changed, true);
    assert.deepEqual(chk.targetsChanged, ["user"]);
    const r = await sync(inB, { scope: "user" });
    assert.equal(existsSync(join(a, "skills")), false); // nothing left behind
    assert.equal(readFileSync(join(b, "skills/foo/SKILL.md"), "utf8"), SKILL("foo"));
    assert.equal(readFileSync(join(b, "skills/bar/SKILL.md"), "utf8"), "MINE\n");
    assert.deepEqual(r.scopes[0]!.conflicts, [{ path: join(b, "skills/bar/SKILL.md") }]);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["hermes:skills/foo"]);
    assert.match(r.scopes[0]!.warnings.join("\n"),
      new RegExp(`Hermes home changed from ${a} to ${b}: 2 item\\(s\\) removed from the old home`));
    assert.equal(e.state().hermesHome(), b);
    assert.deepEqual(Object.keys(userLock(e)).sort(), ["hermes:skills/foo", "skills/bar", "skills/foo"]);
    // Settled: the conflict is what the last sync could not reach (spec §14.3).
    assert.deepEqual(await driftOf(inB, { scope: "user" }), NONE);
    assert.deepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
  } finally {
    e.cleanup();
  }
});

test("a recorded home that is gone: Hermes is no target any more, its entries go, the record with them", async () => {
  const e = homes();
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const a = e.make("home-a");
    await sync({ ...e.ctx, hermesHome: a }, { scope: "user" });
    rmSync(a, { recursive: true });
    assert.notDeepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["hermes:skills/foo"]);
    assert.deepEqual(Object.keys(userLock(e)), ["skills/foo"]);
    assert.equal(e.state().hermesHome(), undefined);
    assert.equal(existsSync(join(e.home, ".hermes")), false);
    assert.deepEqual(await driftOf(e.ctx, { scope: "user" }), NONE);
  } finally {
    e.cleanup();
  }
});

test("a project-scope sync leaves the home record to the user scope", async () => {
  const e = homes();
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const a = e.make("home-a");
    const b = e.make("home-b");
    await sync({ ...e.ctx, hermesHome: a });
    await sync({ ...e.ctx, hermesHome: b }, { scope: "project" });
    assert.equal(e.state().hermesHome(), a);
    assert.equal(existsSync(join(a, "skills/foo/SKILL.md")), true);
    assert.equal(existsSync(join(b, "skills")), false);
    // The user scope still owes the move.
    assert.notDeepEqual(await driftOf({ ...e.ctx, hermesHome: b }, { scope: "user" }), NONE);
  } finally {
    e.cleanup();
  }
});

// ---- the hook under Hermes --------------------------------------------------------------

test("session-start for Hermes: the sync, and the report the plugin hands to the model", async () => {
  const e = env(["hermes"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const out = await runHook("session-start", { source: "startup" }, { ...e.ctx, harness: "hermes" });
    assert.equal(out.systemMessage, "skilletor: 1 item(s) updated");
    assert.deepEqual(out.hookSpecificOutput, {
      hookEventName: "SessionStart",
      additionalContext: "skilletor synced items:\n- skill foo@mine (hermes): active from the next Hermes session",
    });
    assert.equal(existsSync(join(e.hermesHome, "skills/foo/SKILL.md")), true);
    // Nothing changed: silent.
    assert.deepEqual(await runHook("session-start", { source: "startup" }, { ...e.ctx, harness: "hermes" }), {});
  } finally {
    e.cleanup();
  }
});

// ---- the built CLI ----------------------------------------------------------------------

let built: TmpDir;
let bundle: string;

before(async () => {
  built = makeTmpDir();
  bundle = join(built.dir, "skilletor.mjs");
  writeFileSync(bundle, await buildToString());
});

after(() => built.cleanup());

/** A machine where only Hermes is in use, its home outside ~ and named by $HERMES_HOME. */
function machine() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const hermesHome = join(tmp.dir, "srv", "hermes");
  const cwd = join(tmp.dir, "no-project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(hermesHome, "config.yaml"), "plugins:\n  enabled:\n    - skilletor\n");
  const { HERMES_HOME: _h, CODEX_HOME: _c, ...rest } = process.env;
  const plain = { ...rest, HOME: home, CODEX_HOME: join(home, ".no-codex") };
  const run = (args: string[], env: NodeJS.ProcessEnv, input?: string) =>
    spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env, input, cwd });
  return { tmp, home, hermesHome, cwd, plain, inHermes: { ...plain, HERMES_HOME: hermesHome }, run, cleanup: () => tmp.cleanup() };
}

test("CLI: under $HERMES_HOME a sync installs for Hermes; a later run without it serves the same home", () => {
  const m = machine();
  try {
    const src = source(m.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "agents/helper.md": AGENT("helper") });
    writeFileSync(join(m.home, ".claude/skilletor.json"),
      JSON.stringify({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"], agents: ["helper@mine"] } }));

    // Not from here: no harness is in use as far as this run can see.
    const blind = m.run(["sync"], m.plain);
    assert.equal(blind.status, 2);
    assert.match(blind.stderr, /no agent harness detected/);
    assert.match(blind.stderr, new RegExp(`hermes: ${join(m.home, ".hermes", "config.yaml")}`));
    assert.match(blind.stderr, /"targets": \["claude"\], "codex" and\/or "hermes"/);

    const r = m.run(["sync"], m.inHermes);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, [
      "skilletor: user scope",
      "  + hermes:skills/foo (active from the next Hermes session)",
      "skilletor: note: 1 agent(s) not installed for Hermes (Hermes has no agent files and no rules directory)",
      "",
    ].join("\n"));
    assert.equal(readFileSync(join(m.hermesHome, "skills/foo/SKILL.md"), "utf8"), SKILL("foo"));

    const again = m.run(["sync"], m.plain);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, [
      "skilletor: up to date",
      "skilletor: note: 1 agent(s) not installed for Hermes (Hermes has no agent files and no rules directory)",
      "",
    ].join("\n"));
    assert.equal(existsSync(join(m.home, ".hermes")), false);
    const st = m.run(["status", "--scope", "user"], m.plain);
    assert.equal(st.stdout, "user scope (hermes):\n  ✓ hermes:skills/foo @mine\n");
    assert.deepEqual(JSON.parse(m.run(["sync", "--json"], m.plain).stdout).notes,
      ["1 agent(s) not installed for Hermes (Hermes has no agent files and no rules directory)"]);
  } finally {
    m.cleanup();
  }
});

test("CLI: hook session-start --harness hermes syncs and answers in the hook's JSON", () => {
  const m = machine();
  try {
    const src = source(m.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    writeFileSync(join(m.home, ".claude/skilletor.json"),
      JSON.stringify({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } }));
    const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: m.cwd, session_id: "s1" });
    const r = m.run(["hook", "session-start", "--harness", "hermes"], m.inHermes, input);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      systemMessage: "skilletor: 1 item(s) updated",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "skilletor synced items:\n- skill foo@mine (hermes): active from the next Hermes session",
      },
    });
    assert.equal(existsSync(join(m.hermesHome, "skills/foo/SKILL.md")), true);
    const prompt = m.run(["hook", "user-prompt-submit", "--harness", "hermes"], m.inHermes,
      JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: m.cwd, session_id: "s1" }));
    assert.deepEqual([prompt.status, prompt.stdout], [0, ""]);
  } finally {
    m.cleanup();
  }
});
