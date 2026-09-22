// Blackbox tests for the hooks (spec §8): input in, output out; never disturbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
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
