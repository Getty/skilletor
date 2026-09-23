// Harness targets through the engine (spec §14): skills for Codex in .agents/,
// one lock per scope with codex:-prefixed keys, per-target render and removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { check, status, sync, type EngineContext } from "../src/engine.ts";
import { reportHook, reportText } from "../src/report.ts";
import { readLock } from "../src/lock.ts";
import type { Harness } from "../src/config.ts";
import { cmdAvailable, cmdUninstall } from "../src/commands.ts";
import { State } from "../src/state.ts";

function env(harnesses: Harness[]) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  // A marker per harness "in use"; the helper never touches the real machine.
  const markerOf = (h: Harness) => join(tmp.dir, `marker-${h}`);
  for (const h of harnesses) writeFileSync(markerOf(h), "");
  const ctx: EngineContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: { claude: [markerOf("claude")], codex: [markerOf("codex")] },
    codexHome: join(home, ".codex"), // never the real $CODEX_HOME
  };
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => {
    const file = which === "user"
      ? join(home, ".claude", "skilletor.json")
      : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  return { tmp, ctx, home, projectDir, writeCfg, cleanup: () => tmp.cleanup() };
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

test("codex only: a user skill goes to ~/.agents/skills, nothing to ~/.claude/skills", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.equal(readFileSync(join(e.home, ".agents/skills/foo/SKILL.md"), "utf8"), SKILL("foo"));
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock), ["codex:skills/foo"]);
    assert.deepEqual(Object.keys(lock["codex:skills/foo"]!.files), ["skills/foo/SKILL.md"]);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["codex:skills/foo"]);
    assert.match(reportText(r), /\+ codex:skills\/foo/);
  } finally {
    e.cleanup();
  }
});

test("both harnesses: one skill is installed twice, rendered with its harness", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "skills/foo/SKILL.md.njk": "---\nname: foo\ndescription: foo\n---\nfor {{ harness }} in {{ target.dir }}\n",
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "utf8"), new RegExp(`for claude in ${join(e.home, ".claude")}`));
    assert.match(readFileSync(join(e.home, ".agents/skills/foo/SKILL.md"), "utf8"), new RegExp(`for codex in ${join(e.home, ".agents")}`));
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock).sort(), ["codex:skills/foo", "skills/foo"]);
  } finally {
    e.cleanup();
  }
});

test("empty-render skip applies per target", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "skills/only-claude/SKILL.md.njk": "---\nname: only-claude\ndescription: x\n---\n{% if harness == \"claude\" %}CLAUDE{% endif %}\n",
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["only-claude@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/only-claude/SKILL.md")), true);
    assert.equal(existsSync(join(e.home, ".agents/skills/only-claude")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["codex:skills/only-claude"]);
    assert.equal(readLock(join(e.home, ".claude/skilletor.lock.json"))["codex:skills/only-claude"]?.skipped, "renders-empty");
  } finally {
    e.cleanup();
  }
});

test("claude only: output and lock are exactly as before targets", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "agents/a.md": "---\ndescription: a\n---\nA\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"], agents: ["a@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.notes, undefined);
    assert.equal(
      reportText(r),
      "skilletor: user scope\n  + skills/foo (active now)\n  + agents/a (active after /reload-plugins or restart)",
    );
    assert.equal(existsSync(join(e.home, ".agents")), false);
  } finally {
    e.cleanup();
  }
});

test("a target switched off removes its files on the next sync; the other stays", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".agents/skills/foo/SKILL.md")), true);

    e.writeCfg("user", { targets: ["claude"], sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    // Local sources always count as changed; targetsChanged is the signal under test.
    assert.deepEqual((await check(e.ctx, { scope: "user" })).targetsChanged, ["user"]); // inactive target in lock
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["codex:skills/foo"]);
    assert.equal(existsSync(join(e.home, ".agents/skills")), false); // emptied dirs pruned
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    assert.deepEqual(Object.keys(readLock(join(e.home, ".claude/skilletor.lock.json"))), ["skills/foo"]);
    assert.equal((await check(e.ctx, { scope: "user" })).targetsChanged, undefined);
  } finally {
    e.cleanup();
  }
});

test("check reports a newly enabled harness even when no source changed", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" });
    // Local sources always count as changed; targetsChanged is the signal under test.
    assert.equal((await check(e.ctx, { scope: "user" })).targetsChanged, undefined);
    e.writeCfg("user", { targets: ["claude", "codex"], sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const chk = await check(e.ctx, { scope: "user" });
    assert.equal(chk.changed, true);
    assert.deepEqual(chk.targetsChanged, ["user"]);
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".agents/skills/foo/SKILL.md")), true);
    assert.equal((await check(e.ctx, { scope: "user" })).targetsChanged, undefined);
  } finally {
    e.cleanup();
  }
});

test("a foreign skill in .agents/skills is a conflict, untouched; --force adopts it", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    mkdirSync(join(e.home, ".agents/skills/foo"), { recursive: true });
    writeFileSync(join(e.home, ".agents/skills/foo/SKILL.md"), "MINE\n");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.conflicts, [{ path: ".agents/skills/foo/SKILL.md" }]);
    assert.equal(readFileSync(join(e.home, ".agents/skills/foo/SKILL.md"), "utf8"), "MINE\n");
    await sync(e.ctx, { scope: "user", force: true });
    assert.equal(readFileSync(join(e.home, ".agents/skills/foo/SKILL.md"), "utf8"), SKILL("foo"));
  } finally {
    e.cleanup();
  }
});

test("project: codex skills go to <repo>/.agents/skills with their own gitignore block", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/bar/SKILL.md": SKILL("bar") });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["bar@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".agents/skills/bar/SKILL.md")), true);
    const claudeGi = readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8");
    assert.match(claudeGi, /^skills\/bar\/SKILL\.md$/m);
    assert.doesNotMatch(claudeGi, /codex/);
    const agentsGi = readFileSync(join(e.projectDir, ".agents/.gitignore"), "utf8");
    assert.equal(agentsGi, "# >>> skilletor >>>\nskills/bar/SKILL.md\n# <<< skilletor <<<\n");

    // Project narrows to claude: the codex copy and its gitignore go away.
    e.writeCfg("project", { targets: ["claude"], install: { skills: ["bar@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".agents/skills")), false);
    assert.equal(existsSync(join(e.projectDir, ".agents/.gitignore")), false);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/bar/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

test("claude-only project never creates .agents/", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/bar/SKILL.md": SKILL("bar") });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["bar@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".agents")), false);
  } finally {
    e.cleanup();
  }
});

test("no harness detected and no targets: sync, check and status fail touching nothing", async () => {
  const e = env([]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx);
    assert.match(r.error ?? "", /no agent harness detected.*"targets"/);
    assert.deepEqual(r.scopes, []);
    assert.equal(existsSync(join(e.home, ".claude/skilletor.lock.json")), false);
    assert.match((await check(e.ctx)).error ?? "", /no agent harness detected/);
    assert.match(status(e.ctx).error ?? "", /no agent harness detected/);

    // Setting targets explicitly is the way out.
    e.writeCfg("user", { targets: ["claude"], sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    assert.equal((await sync(e.ctx)).error, undefined);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

test("status lists each declared item per target and names the targets", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo"), "rules/r.md": "R\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"], rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    const s = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(s.targets, ["claude", "codex"]);
    assert.deepEqual(
      s.declared.map((d) => [d.key, d.installed]),
      [["skills/foo", true], ["codex:skills/foo", true], ["rules/r", true], ["codex:rules/r", true]],
    );
    assert.deepEqual(s.orphans, []);
  } finally {
    e.cleanup();
  }
});

test("an offline source keeps its codex items too", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["*@mine"] } });
    await sync(e.ctx, { scope: "user" });
    // Point the source at a missing directory: it cannot be resolved.
    e.writeCfg("user", { sources: { mine: { local: join(e.tmp.dir, "gone") } }, install: { skills: ["*@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.equal(r.scopes[0]!.warnings.some((w) => /offered by/.test(w)), false);
    assert.equal(existsSync(join(e.home, ".agents/skills/foo/SKILL.md")), true);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

test("hook context marks codex items and states their activation", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const h = reportHook(await sync(e.ctx, { scope: "user" }));
    assert.match(h.additionalContext ?? "", /^- skill foo@mine: active now$/m);
    assert.match(h.additionalContext ?? "", /^- skill foo@mine \(codex\): active from the next Codex session$/m);
  } finally {
    e.cleanup();
  }
});

test("commands see codex lock keys: available marks the item installed, wildcard uninstall hints work", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["*@mine"] } });
    await sync(e.ctx, { scope: "user" });
    const ctx = e.ctx; // no probe needed: available and uninstall never resolve a spec
    new State(e.ctx.stateRoot).trust("mine", src);
    const items = await cmdAvailable(ctx);
    assert.deepEqual(items.map((i) => [i.name, i.installed]), [["foo", true]]);
    await assert.rejects(cmdUninstall(ctx, { items: ["foo@mine"] }), /installed by the wildcard skill:\*@mine/);
  } finally {
    e.cleanup();
  }
});

// ---- phase 2: agents as Codex agent-role TOML (spec §14.7) -------------------------

const AGENT = (desc: string, body: string, extra = "") => `---\nname: helper\ndescription: ${desc}\nmodel: sonnet\n${extra}---\n${body}`;

test("codex only: an agent becomes $CODEX_HOME/agents/<name>.toml, nothing in .claude/agents", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/helper.md": AGENT("Helps", "You are helper.\n") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.equal(
      readFileSync(join(e.home, ".codex/agents/helper.toml"), "utf8"),
      "name = \"helper\"\ndescription = \"Helps\"\ndeveloper_instructions = '''\nYou are helper.\n'''\n",
    );
    assert.equal(existsSync(join(e.home, ".claude/agents")), false);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock), ["codex:agents/helper"]);
    assert.deepEqual(Object.keys(lock["codex:agents/helper"]!.files), ["agents/helper.toml"]);
    assert.match(reportText(r), /\+ codex:agents\/helper \(active from the next Codex session\)/);
    assert.equal(r.notes, undefined); // agents no longer "not installed for Codex"
  } finally {
    e.cleanup();
  }
});

test("both harnesses: the agent is rendered per harness, Markdown for Claude, TOML for Codex", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "agents/helper.md.njk": AGENT("Helps", "{% if harness == \"codex\" %}CODEX-BODY{% else %}CLAUDE-BODY{% endif %}\n"),
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/agents/helper.md"), "utf8"), /CLAUDE-BODY/);
    const toml = readFileSync(join(e.home, ".codex/agents/helper.toml"), "utf8");
    assert.match(toml, /CODEX-BODY/);
    assert.doesNotMatch(toml, /model|sonnet/); // Claude-only keys are not carried over
  } finally {
    e.cleanup();
  }
});

test("user agents follow CODEX_HOME, even outside the home directory", async () => {
  const e = env(["codex"]);
  try {
    const codexHome = join(e.tmp.dir, "elsewhere", "codex");
    const ctx = { ...e.ctx, codexHome };
    const src = source(e.tmp.dir, "s", { "agents/helper.md": AGENT("Helps", "B\n") });
    mkdirSync(join(codexHome, "agents"), { recursive: true });
    writeFileSync(join(codexHome, "agents/helper.toml"), "MINE\n");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    const r = await sync(ctx, { scope: "user" });
    // A conflict outside the home is shown with its absolute path.
    assert.deepEqual(r.scopes[0]!.conflicts, [{ path: join(codexHome, "agents/helper.toml") }]);
    await sync(ctx, { scope: "user", force: true });
    assert.match(readFileSync(join(codexHome, "agents/helper.toml"), "utf8"), /developer_instructions/);
    assert.equal(existsSync(join(e.home, ".codex/agents")), false);
    // Removing the agent deletes the file under CODEX_HOME.
    e.writeCfg("user", { sources: { mine: { local: src } } });
    await sync(ctx, { scope: "user" });
    assert.equal(existsSync(join(codexHome, "agents/helper.toml")), false);
  } finally {
    e.cleanup();
  }
});

test("project agents go to <repo>/.codex/agents with a gitignore block there", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/helper.md": AGENT("Helps", "B\n") });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { agents: ["helper@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".codex/agents/helper.toml")), true);
    assert.equal(existsSync(join(e.home, ".codex/agents")), false);
    assert.equal(readFileSync(join(e.projectDir, ".codex/.gitignore"), "utf8"), "# >>> skilletor >>>\nagents/helper.toml\n# <<< skilletor <<<\n");
    assert.equal(existsSync(join(e.projectDir, ".agents")), false); // no skills, no .agents
    e.writeCfg("project", { targets: ["claude"], install: { agents: ["helper@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".codex/agents")), false);
    assert.equal(existsSync(join(e.projectDir, ".codex/.gitignore")), false);
  } finally {
    e.cleanup();
  }
});

test("an agent without a description is not written for Codex (one warning); Claude still gets it", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/nodesc.md": "---\nname: nodesc\n---\nB\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["nodesc@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/agents/nodesc.md")), true);
    assert.equal(existsSync(join(e.home, ".codex/agents")), false);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /agent nodesc \(codex\).*description/);
  } finally {
    e.cleanup();
  }
});

test("a conversion error keeps an installed Codex copy, like a template error", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/helper.md": AGENT("Helps", "B\n") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    await sync(e.ctx, { scope: "user" });
    writeFileSync(join(src, "agents/helper.md"), "---\ndescription: &anchor x\n---\nB\n");
    const r = await sync(e.ctx, { scope: "user" });
    assert.match(r.scopes[0]!.warnings.join("\n"), /agent helper \(codex\).*line 2/);
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.match(readFileSync(join(e.home, ".codex/agents/helper.toml"), "utf8"), /Helps/);
  } finally {
    e.cleanup();
  }
});

test("an agent with a blank body is skipped for Codex only (Codex rejects blank instructions)", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/empty.md": "---\ndescription: d\n---\n\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["empty@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/agents/empty.md")), true); // not a template: Claude unchanged
    assert.equal(existsSync(join(e.home, ".codex/agents")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["codex:agents/empty"]);
  } finally {
    e.cleanup();
  }
});

test("briefing.skills is not written for Codex; one note per run counts the agents", async () => {
  const e = env(["codex"]);
  try {
    const briefed = (n: string) => `---\nname: ${n}\ndescription: d\nbriefing:\n  skills:\n    - a\n---\nB\n`;
    const src = source(e.tmp.dir, "s", { "agents/b1.md": briefed("b1"), "agents/b2.md": briefed("b2") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["b1@mine", "b2@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.doesNotMatch(readFileSync(join(e.home, ".codex/agents/b1.toml"), "utf8"), /briefing/);
    assert.equal(r.notes?.length, 1);
    assert.match(r.notes![0]!, /briefing\.skills of 2 agent\(s\) not written for Codex/);
    assert.equal(reportHook(r).additionalContext?.includes("briefing"), false);
  } finally {
    e.cleanup();
  }
});

test("a dropped codex: key is a warning naming the item; the rest is written", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "agents/helper.md": AGENT("Helps", "B\n", "codex:\n  model_reasoning_effort: high\n  bad: ~\n"),
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, ["agent helper (codex): codex.bad: null has no TOML form; dropped"]);
    assert.match(readFileSync(join(e.home, ".codex/agents/helper.toml"), "utf8"), /^model_reasoning_effort = "high"$/m);
  } finally {
    e.cleanup();
  }
});

test("status and drift cover codex agents", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/helper.md": AGENT("Helps", "B\n") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { targets: ["claude", "codex"], sources: { mine: { local: src } }, install: { agents: ["helper@mine"] } });
    assert.deepEqual((await check(e.ctx, { scope: "user" })).targetsChanged, ["user"]);
    await sync(e.ctx, { scope: "user" });
    assert.deepEqual(status(e.ctx, { scope: "user" }).scopes[0]!.declared.map((d) => [d.key, d.installed]),
      [["agents/helper", true], ["codex:agents/helper", true]]);
  } finally {
    e.cleanup();
  }
});

// ---- phase 3: rules via the hook, a rules file and an AGENTS.md pointer (spec §14.8) ----

const RULES = (scope: "user" | "project", ...sections: [string, string, string][]) => [
  `<!-- skilletor:rules scope=${scope} -->`,
  "<!-- managed by skilletor — edits are overwritten; change the rule in its source -->",
  "",
  ...sections.flatMap(([name, source, text]) => [`<!-- skilletor:rule ${name} source=${source} -->`, ...text.replace(/\n$/, "").split("\n"), ""]),
].join("\n").replace(/\n+$/, "") + "\n";

const POINTER = (scope: "user" | "project", file: string) => [
  "<!-- skilletor:begin -->",
  "<!-- managed by skilletor — edits inside are overwritten -->",
  `Additional rules for ${scope === "user" ? "all projects" : "this project"} are managed by skilletor. They are normally provided at`,
  "session start as a developer message beginning with `<!-- skilletor:rules`. If that message",
  "is not in your context (for example after context compaction), read",
  `\`${file}\` before you start a task, and follow it.`,
  "<!-- skilletor:end -->",
].join("\n") + "\n";

/** A config.toml in which the user trusted skilletor's Codex SessionStart hook. */
function trustHook(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"),
    "[hooks.state.\"skilletor@getty:hooks/codex-hooks.json:session_start:0:0\"]\ntrusted_hash = \"sha256:00\"\n");
}

test("codex only: rules become a sorted rules file in $CODEX_HOME, AGENTS.md only points to it", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "rules/zeta.md": "Zeta rule.\n",
      "rules/alpha.md": "---\npaths:\n  - \"k8s/**\"\n---\nAlpha rule.\n",
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["zeta@mine", "alpha@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.equal(r.notes, undefined);
    const rulesFile = join(e.home, ".codex/skilletor-rules.md");
    assert.equal(readFileSync(rulesFile, "utf8"), RULES("user",
      ["alpha", "mine", "Applies when working with files matching: `k8s/**`.\n\nAlpha rule.\n"],
      ["zeta", "mine", "Zeta rule.\n"],
    ));
    assert.equal(readFileSync(join(e.home, ".codex/AGENTS.md"), "utf8"), POINTER("user", rulesFile));
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock).sort(), ["codex:rules/alpha", "codex:rules/zeta"]);
    assert.equal(lock["codex:rules/zeta"]!.block, true);
    assert.deepEqual(Object.keys(lock["codex:rules/zeta"]!.files), ["skilletor-rules.md"]);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["codex:rules/alpha", "codex:rules/zeta"]);
    assert.equal(existsSync(join(e.home, ".claude/rules")), false);
    // A second run changes nothing.
    const again = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(again.scopes[0]!.unchanged.map((i) => i.key).sort(), ["codex:rules/alpha", "codex:rules/zeta"]);
  } finally {
    e.cleanup();
  }
});

test("an existing AGENTS.md keeps everything outside the pointer; removing the rules restores it", async () => {
  const e = env(["codex"]);
  try {
    const own = "# My global instructions\n\nBe terse.\n";
    mkdirSync(join(e.home, ".codex"), { recursive: true });
    writeFileSync(join(e.home, ".codex/AGENTS.md"), own);
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".codex/AGENTS.md"), "utf8"),
      own + "\n" + POINTER("user", join(e.home, ".codex/skilletor-rules.md")));
    e.writeCfg("user", { sources: { mine: { local: src } } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["codex:rules/r"]);
    assert.equal(readFileSync(join(e.home, ".codex/AGENTS.md"), "utf8"), own);
    assert.equal(existsSync(join(e.home, ".codex/skilletor-rules.md")), false);
  } finally {
    e.cleanup();
  }
});

test("switching Codex off deletes the rules file and the AGENTS.md skilletor created", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".codex/AGENTS.md")), true);
    assert.equal(existsSync(join(e.home, ".codex/skilletor-rules.md")), true);
    assert.equal(existsSync(join(e.home, ".claude/rules/r.md")), true);
    e.writeCfg("user", { targets: ["claude"], sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    assert.deepEqual((await check(e.ctx, { scope: "user" })).targetsChanged, ["user"]);
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["codex:rules/r"]);
    assert.equal(existsSync(join(e.home, ".codex/AGENTS.md")), false);
    assert.equal(existsSync(join(e.home, ".codex/skilletor-rules.md")), false);
    assert.equal(existsSync(join(e.home, ".claude/rules/r.md")), true);
  } finally {
    e.cleanup();
  }
});

test("project rules: .codex/skilletor-rules.md, gitignored there; <repo>/AGENTS.md gets the pointer", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(readFileSync(join(e.projectDir, ".codex/skilletor-rules.md"), "utf8"), RULES("project", ["r", "mine", "R.\n"]));
    assert.equal(readFileSync(join(e.projectDir, "AGENTS.md"), "utf8"), POINTER("project", ".codex/skilletor-rules.md"));
    assert.match(readFileSync(join(e.projectDir, ".codex/.gitignore"), "utf8"), /^skilletor-rules\.md$/m);
    assert.equal(existsSync(join(e.projectDir, ".gitignore")), false);
    assert.doesNotMatch(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), /AGENTS|skilletor-rules/);
    assert.equal(existsSync(join(e.home, ".codex/AGENTS.md")), false);
    assert.equal(existsSync(join(e.home, ".codex/skilletor-rules.md")), false);
    // The last rule gone: file, gitignore line and pointer go too.
    e.writeCfg("project", {});
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".codex/skilletor-rules.md")), false);
    assert.equal(existsSync(join(e.projectDir, "AGENTS.md")), false);
    assert.doesNotMatch(
      existsSync(join(e.projectDir, ".codex/.gitignore")) ? readFileSync(join(e.projectDir, ".codex/.gitignore"), "utf8") : "",
      /skilletor-rules/,
    );
  } finally {
    e.cleanup();
  }
});

test("a symlinked AGENTS.md is never written through: one warning, the rules file is still written", async () => {
  const e = env(["claude", "codex"]);
  try {
    writeFileSync(join(e.projectDir, "CLAUDE.md"), "shared\n");
    symlinkSync("CLAUDE.md", join(e.projectDir, "AGENTS.md"));
    const src = source(e.tmp.dir, "s", { "rules/r1.md": "R1.\n", "rules/r2.md": "R2.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { rules: ["r1@mine", "r2@mine"] } });
    const r = await sync(e.ctx, { scope: "project", force: true });
    assert.equal(readFileSync(join(e.projectDir, "CLAUDE.md"), "utf8"), "shared\n");
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /AGENTS\.md is a symlink.*pointer to the Codex rules not written/);
    assert.equal(existsSync(join(e.projectDir, ".claude/rules/r1.md")), true);
    assert.equal(readFileSync(join(e.projectDir, ".codex/skilletor-rules.md"), "utf8"),
      RULES("project", ["r1", "mine", "R1.\n"], ["r2", "mine", "R2.\n"]));
    assert.deepEqual(Object.keys(readLock(join(e.projectDir, ".claude/skilletor.lock.json"))).sort(),
      ["codex:rules/r1", "codex:rules/r2", "rules/r1", "rules/r2"]);
  } finally {
    e.cleanup();
  }
});

test("malformed markers: the pointer is left alone even with --force; the rules file follows the source", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    const broken = "<!-- skilletor:begin -->\nhalf a block\n";
    writeFileSync(join(e.home, ".codex/AGENTS.md"), broken);
    writeFileSync(join(src, "rules/r.md"), "R changed.\n");
    const r = await sync(e.ctx, { scope: "user", force: true });
    assert.match(r.scopes[0]!.warnings.join("\n"), /AGENTS\.md: malformed skilletor markers.*pointer to the Codex rules not written/);
    assert.equal(readFileSync(join(e.home, ".codex/AGENTS.md"), "utf8"), broken);
    assert.deepEqual(r.scopes[0]!.updated.map((i) => i.key), ["codex:rules/r"]);
    assert.equal(readFileSync(join(e.home, ".codex/skilletor-rules.md"), "utf8"), RULES("user", ["r", "mine", "R changed.\n"]));
  } finally {
    e.cleanup();
  }
});

test("empty render for Codex omits the rule from the rules file (per target)", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "rules/only-claude.md.njk": "{% if harness == \"claude\" %}Claude only.{% endif %}\n",
      "rules/both.md": "Both.\n",
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["only-claude@mine", "both@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".codex/skilletor-rules.md"), "utf8"), RULES("user", ["both", "mine", "Both.\n"]));
    assert.equal(existsSync(join(e.home, ".claude/rules/only-claude.md")), true);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["codex:rules/only-claude"]);
  } finally {
    e.cleanup();
  }
});

test("a hand edit in the rules file is overwritten and reported; an update rewrites the section", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    const f = join(e.home, ".codex/skilletor-rules.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("R.", "R. (edited by hand)"));
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.overwritten, [{ path: ".codex/skilletor-rules.md#rules/r" }]);
    assert.equal(readFileSync(f, "utf8"), RULES("user", ["r", "mine", "R.\n"]));
    // A deleted file is restored and reported the same way.
    rmSync(f);
    const d = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(d.scopes[0]!.overwritten, [{ path: ".codex/skilletor-rules.md#rules/r" }]);
    assert.equal(readFileSync(f, "utf8"), RULES("user", ["r", "mine", "R.\n"]));
    writeFileSync(join(src, "rules/r.md"), "R2.\n");
    const u = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(u.scopes[0]!.updated.map((i) => i.key), ["codex:rules/r"]);
    assert.deepEqual(u.scopes[0]!.overwritten, []);
    assert.equal(readFileSync(f, "utf8"), RULES("user", ["r", "mine", "R2.\n"]));
  } finally {
    e.cleanup();
  }
});

test("an unreachable source keeps its rule sections in the rules file", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    const other = source(e.tmp.dir, "o", { "rules/q.md": "Q.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } , oth: { local: other } }, install: { rules: ["*@mine", "q@oth"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { mine: { local: join(e.tmp.dir, "gone") }, oth: { local: other } }, install: { rules: ["*@mine", "q@oth"] } });
    writeFileSync(join(other, "rules/q.md"), "Q2.\n");
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.equal(readFileSync(join(e.home, ".codex/skilletor-rules.md"), "utf8"),
      RULES("user", ["q", "oth", "Q2.\n"], ["r", "mine", "R.\n"]));
  } finally {
    e.cleanup();
  }
});

test("a project AGENTS.md over project_doc_max_bytes warns about the pointer; AGENTS.override.md warns", async () => {
  const e = env(["codex"]);
  try {
    mkdirSync(join(e.home, ".codex"), { recursive: true });
    writeFileSync(join(e.home, ".codex/config.toml"), "project_doc_max_bytes = 200\n");
    writeFileSync(join(e.projectDir, "AGENTS.md"), "x".repeat(300) + "\n");
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { rules: ["r@mine"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.match(r.scopes[0]!.warnings.join("\n"),
      /AGENTS\.md is \d+ bytes; Codex reads at most 200 bytes of project instructions.*pointer to the rules/);
    writeFileSync(join(e.projectDir, "AGENTS.override.md"), "override\n");
    const o = await sync(e.ctx, { scope: "project" });
    assert.match(o.scopes[0]!.warnings.join("\n"), /AGENTS\.override\.md.*Codex reads it instead/);
  } finally {
    e.cleanup();
  }
});

test("status lists codex rules; drift notices a newly enabled Codex", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { targets: ["claude", "codex"], sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    assert.deepEqual((await check(e.ctx, { scope: "user" })).targetsChanged, ["user"]);
    await sync(e.ctx, { scope: "user" });
    assert.deepEqual(status(e.ctx, { scope: "user" }).scopes[0]!.declared.map((d) => [d.key, d.installed]),
      [["rules/r", true], ["codex:rules/r", true]]);
    assert.equal((await check(e.ctx, { scope: "user" })).targetsChanged, undefined);
  } finally {
    e.cleanup();
  }
});

// Migration from the first design (#41): rule sections in the AGENTS.md block, lock
// entries keyed "AGENTS.md". One sync moves them, silently.
test("migration: old AGENTS.md rule sections become the rules file plus the pointer, no local-change report", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    const other = source(e.tmp.dir, "o", { "rules/q.md": "Q.\n" });
    e.writeCfg("project", { install: { rules: ["r@mine", "q@oth"] } });
    e.writeCfg("user", { sources: { mine: { local: src }, oth: { local: other } } });
    await sync(e.ctx, { scope: "project" });
    // Rewrite what the new sync wrote into the old design's shape.
    const lockPath = join(e.projectDir, ".claude/skilletor.lock.json");
    const lock = readLock(lockPath);
    for (const entry of Object.values(lock)) entry.files = { "AGENTS.md": entry.files["skilletor-rules.md"]! };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    rmSync(join(e.projectDir, ".codex"), { recursive: true });
    const oldBlock = [
      "<!-- skilletor:begin -->", "<!-- managed by skilletor — edits inside are overwritten -->", "",
      "<!-- skilletor:rule q source=oth -->", "Q.", "", "<!-- skilletor:rule r source=mine -->", "R.", "",
      "<!-- skilletor:end -->",
    ].join("\n");
    writeFileSync(join(e.projectDir, "AGENTS.md"), `# Team\n\n${oldBlock}\n`);
    // Source oth is unreachable during the migration: its section comes from the old block.
    e.writeCfg("user", { sources: { mine: { local: src }, oth: { local: join(e.tmp.dir, "gone") } } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.overwritten, []);
    assert.equal(readFileSync(join(e.projectDir, "AGENTS.md"), "utf8"), "# Team\n\n" + POINTER("project", ".codex/skilletor-rules.md"));
    assert.equal(readFileSync(join(e.projectDir, ".codex/skilletor-rules.md"), "utf8"),
      RULES("project", ["q", "oth", "Q.\n"], ["r", "mine", "R.\n"]));
    const after = readLock(lockPath);
    assert.deepEqual(Object.keys(after["codex:rules/q"]!.files), ["skilletor-rules.md"]);
    assert.deepEqual(Object.keys(after["codex:rules/r"]!.files), ["skilletor-rules.md"]);
    // Settled: the next run is a no-op.
    const again = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(again.scopes[0]!.updated, []);
    assert.deepEqual(again.scopes[0]!.overwritten, []);
  } finally {
    e.cleanup();
  }
});

// k46: Claude Code reads CLAUDE.md; when that is the AGENTS.md the pointer would go
// into, Claude would be sent to the Codex rules.
const SAME_FILE = /AGENTS\.md is the same file as (\.claude\/)?CLAUDE\.md \(Claude Code would read it\); pointer to the Codex rules not written/;

test("k46: CLAUDE.md -> AGENTS.md with Claude a target: pointer refused, --force too; rules file written", async () => {
  const layouts: [string, (p: string) => void][] = [
    ["CLAUDE.md symlink", (p) => symlinkSync("AGENTS.md", join(p, "CLAUDE.md"))],
    [".claude/CLAUDE.md symlink", (p) => symlinkSync("../AGENTS.md", join(p, ".claude", "CLAUDE.md"))],
    ["hard link", (p) => linkSync(join(p, "AGENTS.md"), join(p, "CLAUDE.md"))],
  ];
  for (const [what, link] of layouts) {
    const e = env(["claude", "codex"]);
    try {
      writeFileSync(join(e.projectDir, "AGENTS.md"), "shared\n");
      link(e.projectDir);
      const src = source(e.tmp.dir, "s", { "rules/r1.md": "R1.\n" });
      e.writeCfg("user", { sources: { mine: { local: src } } });
      e.writeCfg("project", { install: { rules: ["r1@mine"] } });
      const r = await sync(e.ctx, { scope: "project", force: true });
      assert.equal(readFileSync(join(e.projectDir, "AGENTS.md"), "utf8"), "shared\n", what);
      assert.equal(r.scopes[0]!.warnings.length, 1, what);
      assert.match(r.scopes[0]!.warnings[0]!, SAME_FILE, what);
      assert.equal(existsSync(join(e.projectDir, ".claude/rules/r1.md")), true, what);
      assert.equal(existsSync(join(e.projectDir, ".codex/skilletor-rules.md")), true, what);
    } finally {
      e.cleanup();
    }
  }
});

test("k46: a dangling CLAUDE.md -> AGENTS.md is refused too (the pointer would create it)", async () => {
  const e = env(["claude", "codex"]);
  try {
    symlinkSync("AGENTS.md", join(e.projectDir, "CLAUDE.md"));
    const src = source(e.tmp.dir, "s", { "rules/r1.md": "R1.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { rules: ["r1@mine"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.match(r.scopes[0]!.warnings.join("\n"), SAME_FILE);
    assert.equal(existsSync(join(e.projectDir, "AGENTS.md")), false);
  } finally {
    e.cleanup();
  }
});

test("k46: CLAUDE.md -> AGENTS.md without Claude as a target: the pointer is written", async () => {
  const e = env(["codex"]);
  try {
    writeFileSync(join(e.projectDir, "AGENTS.md"), "shared\n");
    symlinkSync("AGENTS.md", join(e.projectDir, "CLAUDE.md"));
    const src = source(e.tmp.dir, "s", { "rules/r1.md": "R1.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { rules: ["r1@mine"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.match(readFileSync(join(e.projectDir, "AGENTS.md"), "utf8"), /^shared\n\n<!-- skilletor:begin -->/);
  } finally {
    e.cleanup();
  }
});

test("k46: user scope ~/.claude/CLAUDE.md -> $CODEX_HOME/AGENTS.md: pointer untouched, rules file follows", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "rules/r.md": "R.\n" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { rules: ["r@mine"] } });
    await sync(e.ctx, { scope: "user" });
    const agents = join(e.home, ".codex/AGENTS.md");
    const written = readFileSync(agents, "utf8");
    // The user now points Claude's memory at the Codex file.
    symlinkSync(agents, join(e.home, ".claude", "CLAUDE.md"));
    writeFileSync(join(src, "rules/r.md"), "R changed.\n");
    const r = await sync(e.ctx, { scope: "user", force: true });
    assert.match(r.scopes[0]!.warnings.join("\n"), /\.codex\/AGENTS\.md is the same file as \.claude\/CLAUDE\.md/);
    assert.equal(readFileSync(agents, "utf8"), written);
    assert.match(readFileSync(join(e.home, ".codex/skilletor-rules.md"), "utf8"), /R changed\./);
    // A regular ~/.claude/CLAUDE.md is a different file: no warning any more.
    rmSync(join(e.home, ".claude", "CLAUDE.md"));
    writeFileSync(join(e.home, ".claude", "CLAUDE.md"), "mine\n");
    const ok = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(ok.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

// ---- hook trust (spec §14.8) ---------------------------------------------------------

const UNTRUSTED = /Codex has not trusted skilletor's SessionStart hook/;

test("hook trust: sync and status warn once when Codex is a target and the hook is not trusted", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    e.writeCfg("project", {});
    const r = await sync(e.ctx);
    assert.equal(r.warnings?.length, 1);
    assert.match(r.warnings![0]!, UNTRUSTED);
    assert.equal(reportText(r).match(new RegExp(UNTRUSTED, "g"))?.length, 1);
    // The hook output stays quiet about it (the hook that runs is trusted by definition).
    assert.doesNotMatch(reportHook(r).additionalContext ?? "", UNTRUSTED);
    const st = status(e.ctx);
    assert.equal(st.warnings?.length, 1);
    assert.match(st.warnings![0]!, UNTRUSTED);
    trustHook(join(e.home, ".codex"));
    assert.equal((await sync(e.ctx)).warnings, undefined);
    assert.equal(status(e.ctx).warnings, undefined);
  } finally {
    e.cleanup();
  }
});

test("hook trust: no warning when Codex is not a machine target", async () => {
  const e = env(["claude"]);
  try {
    e.writeCfg("user", {});
    assert.equal((await sync(e.ctx)).warnings, undefined);
    assert.equal(status(e.ctx).warnings, undefined);
  } finally {
    e.cleanup();
  }
});
