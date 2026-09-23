// Blackbox tests for the hooks (spec §8): input in, output out; never disturbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { State } from "../src/state.ts";

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const backgroundCalls: number[] = [];
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    background: () => backgroundCalls.push(Date.now()),
  };
  const writeUserCfg = (obj: unknown) =>
    writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify(obj, null, 2));
  return { tmp, ctx, home, projectDir, backgroundCalls, writeUserCfg, cleanup: () => tmp.cleanup() };
}

function localSkill(root: string, srcName: string, skill: string): string {
  const dir = join(root, srcName, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill}\n---\nBODY\n`);
  return resolvePath(join(root, srcName));
}

test("session-start is silent with nothing declared", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    assert.deepEqual(await runHook("session-start", {}, e.ctx), {});
  } finally {
    e.cleanup();
  }
});

test("session-start syncs a change and reports with an activation hint", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.match(out.systemMessage ?? "", /skilletor/);
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /active now/);
    assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
  } finally {
    e.cleanup();
  }
});

test("user-prompt-submit spawns a background sync only when due", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    // First prompt: due (never checked) -> background triggered.
    await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(e.backgroundCalls.length, 1);
    // Second prompt right away: not due (default 600s throttle) -> no background.
    await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(e.backgroundCalls.length, 1);
  } finally {
    e.cleanup();
  }
});

test("checkInterval: 0 disables the in-session check entirely", async () => {
  const e = env();
  try {
    e.writeUserCfg({ checkInterval: 0 });
    await runHook("user-prompt-submit", {}, e.ctx);
    await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(e.backgroundCalls.length, 0); // never spawns a background sync
  } finally {
    e.cleanup();
  }
});

test("the non-due path is fast and silent (<100ms)", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    new State(e.ctx.stateRoot).markChecked(e.projectDir); // make it not due
    const start = Date.now();
    const out = await runHook("user-prompt-submit", {}, e.ctx);
    assert.ok(Date.now() - start < 100, "should return quickly");
    assert.deepEqual(out, {});
    assert.equal(e.backgroundCalls.length, 0);
  } finally {
    e.cleanup();
  }
});

test("a pending report is delivered and consumed on the next prompt", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    const pending = {
      systemMessage: "skilletor: 1 item updated",
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "- skill foo@mine: active now" },
    };
    new State(e.ctx.stateRoot).putPendingReport(e.projectDir, pending);
    const out = await runHook("user-prompt-submit", {}, e.ctx);
    assert.deepEqual(out, pending);
    // Consumed: nothing left next time (but background may fire since it's due).
    assert.equal(new State(e.ctx.stateRoot).takePendingReport(e.projectDir), undefined);
  } finally {
    e.cleanup();
  }
});

test("the background sync stores a pending report for later", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await runHook("__sync-background", {}, e.ctx);
    const stored = new State(e.ctx.stateRoot).takePendingReport(e.projectDir) as { systemMessage?: string };
    assert.match(stored?.systemMessage ?? "", /skilletor/);
  } finally {
    e.cleanup();
  }
});

test("an unknown hook event never throws, returns a warning", async () => {
  const e = env();
  try {
    const out = await runHook("bogus", {}, e.ctx);
    assert.match(out.systemMessage ?? "", /unknown hook event/);
  } finally {
    e.cleanup();
  }
});

// ---- Codex: no CLAUDE_PROJECT_DIR, the project root comes from cwd (spec §14.5) ----

/** A git repo with a project config installing skill `bar`, and a subdirectory. */
function repoWithProjectSkill(e: ReturnType<typeof env>): { repo: string; sub: string } {
  const src = localSkill(e.tmp.dir, "s", "bar");
  e.writeUserCfg({ sources: { mine: { local: src } } });
  const repo = join(e.tmp.dir, "repo");
  const sub = join(repo, "src", "deep");
  mkdirSync(sub, { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["bar@mine"] } }));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  return { repo: realpathSync(repo), sub };
}

test("codex session-start without a project dir: the git top level of cwd is the project", async () => {
  const e = env();
  try {
    const { repo, sub } = repoWithProjectSkill(e);
    const ctx: HookContext = {
      ...e.ctx, projectDir: undefined, markers: { claude: [], codex: [e.home] }, codexHome: join(e.home, ".codex"),
    };
    const input = { hook_event_name: "SessionStart", source: "startup", cwd: sub, session_id: "x", model: "gpt" };
    const out = await runHook("session-start", input, ctx);
    assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /skill bar@mine \(codex\)/);
    assert.equal(existsSync(join(repo, ".agents/skills/bar/SKILL.md")), true);
    assert.equal(existsSync(join(sub, ".agents")), false);
    assert.equal(existsSync(join(sub, ".claude")), false);
  } finally {
    e.cleanup();
  }
});

test("without a project dir and outside git, cwd itself is the project", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "bar");
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const dir = join(e.tmp.dir, "plain");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["bar@mine"] } }));
    const ctx: HookContext = { ...e.ctx, projectDir: undefined };
    await runHook("session-start", { cwd: dir }, ctx);
    assert.equal(existsSync(join(dir, ".claude/skills/bar/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

test("user-prompt-submit without a project dir delivers the repo root's pending report from a subdir", async () => {
  const e = env();
  try {
    const { repo, sub } = repoWithProjectSkill(e);
    const pending = { systemMessage: "skilletor: 1 item(s) updated" };
    new State(e.ctx.stateRoot).putPendingReport(repo, pending);
    const ctx: HookContext = { ...e.ctx, projectDir: undefined };
    assert.deepEqual(await runHook("user-prompt-submit", { cwd: sub }, ctx), pending);
  } finally {
    e.cleanup();
  }
});

test("no harness detected: session-start warns in one line, never throws", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const out = await runHook("session-start", {}, { ...e.ctx, markers: { claude: [], codex: [] } });
    assert.match(out.systemMessage ?? "", /^skilletor: no agent harness detected/);
    assert.equal(out.systemMessage?.includes("\n"), false);
  } finally {
    e.cleanup();
  }
});

test("k44: session-start started in ~ syncs the user scope only, once", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const ctx: HookContext = { ...e.ctx, projectDir: undefined };
    const out = await runHook("session-start", { cwd: e.home }, ctx);
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /skill foo@mine/);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), false);
    // With CLAUDE_PROJECT_DIR=~ the same.
    const again = await runHook("session-start", { cwd: e.home }, { ...e.ctx, projectDir: e.home });
    assert.deepEqual(again, {});
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), false);
    assert.deepEqual(await runHook("user-prompt-submit", { cwd: e.home }, ctx), {});
  } finally {
    e.cleanup();
  }
});

// k48: bundle expansion runs inside the hook's sync; a broken bundle is one warning.
test("session-start with a broken bundle and a good one: installs the good one, warns, never throws", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "b", "foo");
    mkdirSync(join(src, "bundles"), { recursive: true });
    writeFileSync(join(src, "bundles", "good.yaml"), "description: G\nskills: [foo]\n");
    writeFileSync(join(src, "bundles", "bad.yaml"), "description: B\nbundles: [bad]\n");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { bundles: ["good@mine", "bad@mine"] } });
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.match(out.systemMessage ?? "", /1 item\(s\) updated, 1 warning/);
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /bundle:bad@mine: bundle cycle bad → bad/);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

// ---- k50: Codex rules through SessionStart (spec §14.8) ------------------------------

/** A Codex-only hook env with one user rule and one project rule synced once. */
async function codexRules(e: ReturnType<typeof env>) {
  const src = join(e.tmp.dir, "rsrc");
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "urule.md"), "User rule.\n");
  writeFileSync(join(src, "rules", "prule.md"), "Project rule.\n");
  e.writeUserCfg({ sources: { mine: { local: resolvePath(src) } }, install: { rules: ["urule@mine"] } });
  writeFileSync(join(e.projectDir, ".claude", "skilletor.json"), JSON.stringify({ install: { rules: ["prule@mine"] } }));
  const codexHome = join(e.home, ".codex");
  const ctx: HookContext = { ...e.ctx, markers: { claude: [], codex: [e.home] }, codexHome, harness: "codex" };
  const first = await runHook("session-start", { source: "startup" }, ctx);
  const userFile = readFileSync(join(codexHome, "skilletor-rules.md"), "utf8");
  const projectFile = readFileSync(join(e.projectDir, ".codex", "skilletor-rules.md"), "utf8");
  return { ctx, first, userFile, projectFile, src };
}

test("k50: codex session-start appends the user, then the project rules file after the sync report", async () => {
  const e = env();
  try {
    const { first, userFile, projectFile } = await codexRules(e);
    assert.match(userFile, /^<!-- skilletor:rules scope=user -->\n[\s\S]*User rule\.\n$/);
    assert.match(projectFile, /^<!-- skilletor:rules scope=project -->\n[\s\S]*Project rule\.\n$/);
    const ctxText = first.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctxText, /^skilletor synced items:/); // the sync report stays first
    assert.ok(ctxText.endsWith(userFile + "\n" + projectFile), ctxText);
  } finally {
    e.cleanup();
  }
});

test("k50: nothing changed: startup, clear and a missing source get exactly the rules; resume gets none", async () => {
  const e = env();
  try {
    const { ctx, userFile, projectFile } = await codexRules(e);
    for (const source of ["startup", "clear", undefined]) {
      const out = await runHook("session-start", source ? { source } : {}, ctx);
      assert.deepEqual(out, {
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: userFile + "\n" + projectFile },
      }, String(source));
    }
    assert.deepEqual(await runHook("session-start", { source: "resume" }, ctx), {});
  } finally {
    e.cleanup();
  }
});

test("k50: user-prompt-submit never appends rules; without --harness codex session-start does not either", async () => {
  const e = env();
  try {
    const { ctx } = await codexRules(e);
    assert.deepEqual(await runHook("user-prompt-submit", {}, ctx), {});
    assert.deepEqual(await runHook("session-start", { source: "startup" }, { ...ctx, harness: undefined }), {});
  } finally {
    e.cleanup();
  }
});

test("k50: a failed sync still delivers the last good rules, after the warning", async () => {
  const e = env();
  try {
    const { ctx, userFile, projectFile } = await codexRules(e);
    writeFileSync(join(e.home, ".claude", "skilletor.json"), "{ broken");
    const out = await runHook("session-start", { source: "startup" }, ctx);
    assert.match(out.systemMessage ?? "", /^skilletor: /);
    assert.equal(out.hookSpecificOutput?.additionalContext, userFile + "\n" + projectFile);
  } finally {
    e.cleanup();
  }
});

test("k50: a scope Codex is not a target of contributes no rules, even with a stale file", async () => {
  const e = env();
  try {
    const { ctx, userFile } = await codexRules(e);
    writeFileSync(join(e.home, "marker-claude"), "");
    const both: HookContext = { ...ctx, markers: { claude: [join(e.home, "marker-claude")], codex: [e.home] } };
    writeFileSync(join(e.projectDir, ".claude", "skilletor.json"), JSON.stringify({ targets: ["claude"] }));
    // Sync removes the project file; a stale copy written back afterwards is still ignored.
    await runHook("session-start", { source: "startup" }, both);
    assert.equal(existsSync(join(e.projectDir, ".codex", "skilletor-rules.md")), false);
    mkdirSync(join(e.projectDir, ".codex"), { recursive: true });
    writeFileSync(join(e.projectDir, ".codex", "skilletor-rules.md"), "stale\n");
    const out = await runHook("session-start", { source: "startup" }, both);
    assert.equal(out.hookSpecificOutput?.additionalContext, userFile);
  } finally {
    e.cleanup();
  }
});
