// Briefing check for installed agents (spec §6.7): declared briefing skills that
// would not resolve are warned about after sync, shown by status, and surfaced by
// the SessionStart hook only in runs that changed something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { status, sync, type EngineContext } from "../src/engine.ts";
import { reportText } from "../src/report.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import type { Harness } from "../src/config.ts";

function env(harnesses: Harness[]) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const markerOf = (h: Harness) => join(tmp.dir, `marker-${h}`);
  for (const h of harnesses) writeFileSync(markerOf(h), "");
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: { claude: [markerOf("claude")], codex: [markerOf("codex")] },
    codexHome: join(tmp.dir, "codex-home"), // not under home: $CODEX_HOME is its own root
    isGitWorkTree: () => false,
    background: () => {},
  };
  const writeCfg = (which: "user" | "project", obj: unknown) =>
    writeFileSync(join(which === "user" ? home : projectDir, ".claude", "skilletor.json"), JSON.stringify(obj, null, 2));
  return { tmp, ctx: ctx as EngineContext & HookContext, home, projectDir, writeCfg, cleanup: () => tmp.cleanup() };
}

function source(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return resolvePath(dir);
}

/** A skill directory someone else put there: `<root>/<name>/SKILL.md`. */
function placeSkill(root: string, name: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nB\n`);
}

const SKILL = (n: string) => `---\nname: ${n}\ndescription: ${n}\n---\nB\n`;
const AGENT = (skills: string[], body = "You review.\n") =>
  `---\ndescription: d\nbriefing:\n  skills:\n${skills.map((s) => `    - "${s}"\n`).join("")}---\n${body}`;

const briefingLines = (warnings: string[]) => warnings.filter((w) => /briefing skills not installed/.test(w));

test("claude: missing bare names are warned once per agent; plugin names and installed skills are not", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "agents/rev.md": AGENT(["present", "gone", "plug:thing", "gone2"]),
      "skills/present/SKILL.md": SKILL("present"),
    });
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s"], skills: ["present@s"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    const lines = briefingLines(r.scopes[0]!.warnings);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^agent rev \(claude\): briefing skills not installed: gone, gone2\b/);
    assert.match(lines[0]!, /bundle/);
    assert.deepEqual(r.scopes[0]!.briefingMissing, [{ key: "agents/rev", harness: "claude", missing: ["gone", "gone2"] }]);
    assert.match(reportText(r), /warning: agent rev \(claude\): briefing skills not installed: gone, gone2/);
    // Every sync shows it while it holds.
    const again = await sync(e.ctx, { scope: "user" });
    assert.equal(briefingLines(again.scopes[0]!.warnings).length, 1);
    // Installed by someone else: resolves too, the warning goes away.
    placeSkill(join(e.home, ".claude/skills"), "gone");
    placeSkill(join(e.home, ".claude/skills"), "gone2");
    const fixed = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(briefingLines(fixed.scopes[0]!.warnings), []);
    assert.equal(fixed.scopes[0]!.briefingMissing, undefined);
  } finally {
    e.cleanup();
  }
});

test("claude: a project skill does not follow a user agent; a project agent sees both roots", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "agents/uagent.md": AGENT(["pk", "uk"]),
      "agents/pagent.md": AGENT(["pk", "uk"]),
    });
    placeSkill(join(e.projectDir, ".claude/skills"), "pk");
    placeSkill(join(e.home, ".claude/skills"), "uk");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["uagent@s"] } });
    e.writeCfg("project", { install: { agents: ["pagent@s"] } });
    const r = await sync(e.ctx);
    const [user, project] = r.scopes;
    assert.deepEqual(briefingLines(user!.warnings).map((w) => w.split(" — ")[0]),
      ["agent uagent (claude): briefing skills not installed: pk"]);
    assert.deepEqual(briefingLines(project!.warnings), []);
  } finally {
    e.cleanup();
  }
});

test("claude: plugin caches resolve bare names (cache/*/skills and cache/*/*/skills under the given home)", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/rev.md": AGENT(["a", "b", "c"]) });
    placeSkill(join(e.home, ".claude/plugins/cache/mkt/skills"), "a");
    placeSkill(join(e.home, ".claude/plugins/cache/mkt/plug/skills"), "b");
    placeSkill(join(e.home, ".claude/plugins/cache/mkt/plug/1.0/skills"), "c"); // deeper: not searched
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.briefingMissing, [{ key: "agents/rev", harness: "claude", missing: ["c"] }]);
  } finally {
    e.cleanup();
  }
});

test("codex: reads the comment line; a skill installed only for claude is missing for codex", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/rev.md": AGENT(["onlyclaude", "inagents", "incodex"]) });
    placeSkill(join(e.home, ".claude/skills"), "onlyclaude");
    placeSkill(join(e.home, ".claude/skills"), "inagents");
    placeSkill(join(e.home, ".claude/skills"), "incodex");
    placeSkill(join(e.home, ".agents/skills"), "inagents");
    placeSkill(join(e.ctx.codexHome!, "skills"), "incodex");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.briefingMissing,
      [{ key: "codex:agents/rev", harness: "codex", missing: ["onlyclaude"] }]);
    assert.deepEqual(briefingLines(r.scopes[0]!.warnings).map((w) => w.split(" — ")[0]),
      ["agent rev (codex): briefing skills not installed: onlyclaude"]);
  } finally {
    e.cleanup();
  }
});

test("codex: user agent searches $CODEX_HOME/skills and ~/.agents/skills; project agent also the project's", async () => {
  const e = env(["codex"]);
  try {
    const src = source(e.tmp.dir, "s", {
      "agents/uagent.md": AGENT(["pa", "pc", "u"]),
      "agents/pagent.md": AGENT(["pa", "pc", "u"]),
    });
    placeSkill(join(e.projectDir, ".agents/skills"), "pa");
    placeSkill(join(e.projectDir, ".codex/skills"), "pc");
    placeSkill(join(e.home, ".agents/skills"), "u");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["uagent@s"] } });
    e.writeCfg("project", { install: { agents: ["pagent@s"] } });
    const r = await sync(e.ctx);
    assert.deepEqual(r.scopes[0]!.briefingMissing, [{ key: "codex:agents/uagent", harness: "codex", missing: ["pa", "pc"] }]);
    assert.equal(r.scopes[1]!.briefingMissing, undefined);
  } finally {
    e.cleanup();
  }
});

test("a # briefing: line in an agent's body is prose, not a declaration", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/rev.md": "---\ndescription: d\n---\n# briefing: skills = [\"evil\"]\n" });
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.scopes[0]!.briefingMissing, undefined);
  } finally {
    e.cleanup();
  }
});

test("status shows briefingMissing per agent, read-only; an unparseable file is skipped silently", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/rev.md": AGENT(["gone"]) });
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s"] } });
    await sync(e.ctx, { scope: "user" });
    const before = readdirSync(join(e.home, ".claude"), { recursive: true }).sort();
    const st = status(e.ctx, { scope: "user" });
    const byKey = Object.fromEntries(st.scopes[0]!.declared.map((d) => [d.key, d]));
    assert.deepEqual(byKey["agents/rev"]!.briefingMissing, ["gone"]);
    assert.deepEqual(byKey["codex:agents/rev"]!.briefingMissing, ["gone"]);
    assert.deepEqual(readdirSync(join(e.home, ".claude"), { recursive: true }).sort(), before);
    // Break the installed Claude file's frontmatter: skipped, no crash, no entry.
    writeFileSync(join(e.home, ".claude/agents/rev.md"), "---\ndescription: &anchor x\nbriefing:\n  skills: [gone]\n---\nB\n");
    const broken = status(e.ctx, { scope: "user" });
    const rev = broken.scopes[0]!.declared.find((d) => d.key === "agents/rev")!;
    assert.equal(rev.briefingMissing, undefined);
    const again = await sync(e.ctx, { scope: "user" }); // overwrites the diverged file again
    assert.equal(again.error, undefined);
  } finally {
    e.cleanup();
  }
});

test("hook: SessionStart surfaces the warning only in a run that changed something", async () => {
  const e = env(["claude"]);
  try {
    const src = source(e.tmp.dir, "s", { "agents/rev.md": AGENT(["gone"]) });
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s"] } });
    const first = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.match(first.hookSpecificOutput?.additionalContext ?? "", /agent rev \(claude\): briefing skills not installed: gone/);
    assert.match(first.systemMessage ?? "", /warning/);
    // A local source always "changed": the sync runs, changes nothing, and the hook stays quiet.
    const second = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.deepEqual(second, {});
    // A run that changes something shows it again, next to the change.
    writeFileSync(join(src, "agents/rev.md"), AGENT(["gone"], "Changed.\n"));
    const third = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.match(third.hookSpecificOutput?.additionalContext ?? "", /briefing skills not installed: gone/);
    // Other warnings in a no-change run still come through.
    e.writeCfg("user", { sources: { s: { local: src } }, install: { agents: ["rev@s", "nope@s"] } });
    const fourth = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.doesNotMatch(fourth.hookSpecificOutput?.additionalContext ?? "", /briefing/);
    assert.match(fourth.hookSpecificOutput?.additionalContext ?? "", /nope/);
  } finally {
    e.cleanup();
  }
});
