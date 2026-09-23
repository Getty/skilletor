// Harness targets through the engine (spec §14): skills for Codex in .agents/,
// one lock per scope with codex:-prefixed keys, per-target render and removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("codex: agents and rules are not written; the report notes it once, the hook stays quiet", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "agents/a1.md": "---\ndescription: a\n---\nA\n",
      "agents/a2.md": "---\ndescription: a\n---\nA\n",
      "rules/r1.md": "R\n",
    });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { agents: ["a1@mine", "a2@mine"], rules: ["r1@mine"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".agents/agents")), false);
    assert.equal(existsSync(join(e.home, ".claude/agents")), false);
    assert.deepEqual(readLock(join(e.home, ".claude/skilletor.lock.json")), {});
    const text = reportText(r);
    assert.equal(text.match(/not installed for Codex/g)?.length, 1, text);
    assert.match(text, /2 agent\(s\) and 1 rule\(s\)/);
    assert.deepEqual(reportHook(r), {});
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
      [["skills/foo", true], ["codex:skills/foo", true], ["rules/r", true]],
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
