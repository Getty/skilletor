// Blackbox tests for the hooks (spec §8): input in, output out; never disturbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { runHook, type HookContext, type HookOutput } from "../src/hooks.ts";
import { State } from "../src/state.ts";
import { NO_SYMLINKS } from "./helpers/symlink.ts";

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
    isGitWorkTree: () => false, // never the real location of the temp dir
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

// k67 (spec §6.3): the hook's sync never writes through a linked skill dir, and says so.
test("session-start with a linked skill dir of the same name: a conflict warning, nothing written through it", { skip: NO_SYMLINKS }, async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    writeFileSync(join(src, "skills/foo/reference.md"), "REF\n"); // a file the linked skill lacks
    const outside = join(e.tmp.dir, "foreign");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "FOREIGN\n");
    mkdirSync(join(e.home, ".claude/skills"), { recursive: true });
    symlinkSync(outside, join(e.home, ".claude/skills/foo"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.equal(out.systemMessage, "skilletor: 1 warning(s)"); // the conflict; no item installed
    assert.deepEqual(readdirSync(outside), ["SKILL.md"]);
    assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), "FOREIGN\n");
  } finally {
    e.cleanup();
  }
});

// k72 (spec §8): a conflict counted in the systemMessage is named in the context. Asserts:
// a hand-written SKILL.md and a directory where SKILL.md goes, both real on disk, each get
// one context line with scope, path and the text report's hint; neither is touched.
test("k72: session-start names each conflict on disk in the context, with path and hint", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    localSkill(e.tmp.dir, "s", "bar");
    mkdirSync(join(e.home, ".claude/skills/foo"), { recursive: true });
    writeFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "MINE\n");
    mkdirSync(join(e.home, ".claude/skills/bar/SKILL.md"), { recursive: true });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine", "bar@mine"] } });
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.equal(out.systemMessage, "skilletor: 2 warning(s)");
    assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
    const lines = (out.hookSpecificOutput?.additionalContext ?? "").split("\n").sort();
    assert.deepEqual(lines, [
      "- conflict in user scope: skills/bar/SKILL.md is not a file (move or remove it yourself; --force leaves it)",
      "- conflict in user scope: skills/foo/SKILL.md already exists (use --force to adopt)",
    ]);
    assert.equal(readFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "utf8"), "MINE\n");
    assert.deepEqual(readdirSync(join(e.home, ".claude/skills/bar/SKILL.md")), []);
  } finally {
    e.cleanup();
  }
});

// k72: the UserPromptSubmit path renders its pending report through the same function.
// Asserts: a background sync that overwrites a local edit and meets a conflict stores a
// report whose context names both, and the next prompt delivers exactly that.
test("k72: the pending report names an overwritten local change and a conflict in the context", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    localSkill(e.tmp.dir, "s", "bar");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await runHook("session-start", { source: "startup" }, e.ctx);
    writeFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "EDITED\n"); // local drift
    mkdirSync(join(e.home, ".claude/skills/bar"), { recursive: true });
    writeFileSync(join(e.home, ".claude/skills/bar/SKILL.md"), "MINE\n");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine", "bar@mine"] } });
    await runHook("__sync-background", {}, e.ctx);
    const out = await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(out.systemMessage, "skilletor: 1 item(s) updated, 2 warning(s)"); // foo restored
    assert.equal(out.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
    assert.deepEqual((out.hookSpecificOutput?.additionalContext ?? "").split("\n"), [
      "skilletor synced items:",
      "- skill foo@mine: active now",
      "- overwrote local change in user scope: skills/foo/SKILL.md",
      "- conflict in user scope: skills/bar/SKILL.md already exists (use --force to adopt)",
    ]);
  } finally {
    e.cleanup();
  }
});

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

// k86: a background sync that met a config error stored "skilletor: changes applied". Asserts:
// with a malformed project config, __sync-background stores a pending report and the next
// user-prompt-submit delivers exactly the line SessionStart gives for the same config – the
// error, naming the file – with no context and no "changes applied"; the prompt after that
// is silent again (the report is consumed, nothing else is said).
test("k86: a config error in a background sync reaches the next prompt as that error", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const projectCfg = join(e.projectDir, ".claude/skilletor.json");
    writeFileSync(projectCfg, "{ not json");
    const start = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.match(start.systemMessage ?? "", /^skilletor: .*skilletor\.json: invalid JSON/);

    await runHook("__sync-background", {}, e.ctx);
    const out = await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(out.systemMessage, start.systemMessage);
    assert.ok(out.systemMessage?.includes(projectCfg));
    assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
    assert.doesNotMatch(JSON.stringify(out), /changes applied/);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false); // nothing touched
    assert.deepEqual(await runHook("user-prompt-submit", {}, e.ctx), {});
  } finally {
    e.cleanup();
  }
});

// k89: a background sync that threw – here a write error in apply (k71): ~/.claude/rules is a
// file where the rule must land – stored no report, so the error never reached a prompt.
// Asserts: __sync-background itself returns nothing and stores a pending report; the next
// user-prompt-submit delivers exactly the one line SessionStart gives for the same failure,
// naming the path, with no context; the prompt after that is silent (the report consumed).
test("k89: a background sync that fails with a write error reaches the next prompt as that error", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    mkdirSync(join(src, "rules"));
    writeFileSync(join(src, "rules/r.md"), "R\n");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"], rules: ["r@mine"] } });
    const rulesPath = join(e.home, ".claude/rules");
    writeFileSync(rulesPath, "a file where the rules dir goes");
    const start = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.match(start.systemMessage ?? "", /^skilletor: .*(EEXIST|ENOTDIR)/);

    assert.deepEqual(await runHook("__sync-background", {}, e.ctx), {});
    const out = await runHook("user-prompt-submit", {}, e.ctx);
    assert.deepEqual(out, { systemMessage: start.systemMessage });
    assert.ok(out.systemMessage?.includes(rulesPath));
    assert.deepEqual(await runHook("user-prompt-submit", {}, e.ctx), {});
  } finally {
    e.cleanup();
  }
});

// k89: a sync-lock timeout is the one throw a background sync keeps to itself – the run that
// holds the lock reports its own sync, and the next due check retries – while SessionStart,
// which the session waits on, says it in its one warning line (spec §6.5). Asserts: with the
// lock held by another run, session-start warns with exactly the timeout; __sync-background
// returns nothing and stores no pending report, so the next prompt is silent; nothing synced.
test("k89: a sync-lock timeout: session-start warns in one line, the background sync leaves no report", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const ctx: HookContext = { ...e.ctx, lockTimeoutMs: 100 };
    const lockDir = join(e.ctx.stateRoot, "sync.lock");
    await new State(e.ctx.stateRoot).withLock(async () => {
      const start = await runHook("session-start", { source: "startup" }, ctx);
      assert.deepEqual(start, { systemMessage: `skilletor: timed out acquiring sync lock at ${lockDir}` });
      assert.deepEqual(await runHook("__sync-background", {}, ctx), {});
    });
    assert.deepEqual(await runHook("user-prompt-submit", {}, ctx), {});
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false); // nothing synced
  } finally {
    e.cleanup();
  }
});

// k89: a background sync that timed out on the sync lock synced nothing, yet the prompt that
// started it had marked the project checked – the retry waited a full checkInterval. Asserts
// (the background runs the real __sync-background, as the detached child does): with the
// lock held, a due prompt returns at once, before its background sync ends, and that sync
// times out silently; once the lock is free, the next prompt is due again and starts a new
// background sync, which installs the item; its report reaches the prompt after, which is
// not due – one background sync per due prompt, never one per prompt.
test("k89: a background sync that timed out on the lock leaves the project due; the next prompt's sync installs", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const runs: Promise<HookOutput>[] = [];
    const ctx: HookContext = { ...e.ctx, lockTimeoutMs: 100, background: (c) => void runs.push(runHook("__sync-background", {}, c)) };
    await new State(e.ctx.stateRoot).withLock(async () => {
      let settled = false;
      assert.deepEqual(await runHook("user-prompt-submit", {}, ctx), {});
      assert.equal(runs.length, 1);
      void runs[0]!.then(() => (settled = true));
      await Promise.resolve();
      assert.equal(settled, false, "the prompt does not wait for its background sync");
      assert.deepEqual(await runs[0], {});
    });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false);

    assert.deepEqual(await runHook("user-prompt-submit", {}, ctx), {});
    assert.equal(runs.length, 2, "due again after the timeout");
    await runs[1];
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    assert.equal((await runHook("user-prompt-submit", {}, ctx)).systemMessage, "skilletor: 1 item(s) updated");
    assert.equal(runs.length, 2, "checked: not due");
  } finally {
    e.cleanup();
  }
});

// k89: the same for SessionStart, whose check marks the project before it syncs. Asserts: a
// session-start that timed out on the lock warns once and leaves the project due, so the
// first prompt starts a background sync; a session-start that synced leaves it checked.
test("k89: a session-start that timed out on the lock leaves the project due for the first prompt", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const ctx: HookContext = { ...e.ctx, lockTimeoutMs: 100 };
    await new State(e.ctx.stateRoot).withLock(async () => {
      assert.match((await runHook("session-start", { source: "startup" }, ctx)).systemMessage ?? "", /timed out acquiring sync lock/);
    });
    assert.deepEqual(await runHook("user-prompt-submit", {}, ctx), {});
    assert.equal(e.backgroundCalls.length, 1, "due after the timeout");

    assert.equal((await runHook("session-start", { source: "startup" }, ctx)).systemMessage, "skilletor: 1 item(s) updated");
    assert.deepEqual(await runHook("user-prompt-submit", {}, ctx), {});
    assert.equal(e.backgroundCalls.length, 1, "checked after a sync: not due");
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

test("k51: session-start writes the user block inside a work tree and stays quiet when the test throws", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const out = await runHook("session-start", { cwd: e.projectDir }, { ...e.ctx, isGitWorkTree: () => true });
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /skill foo@mine/);
    assert.match(readFileSync(join(e.home, ".claude/.gitignore"), "utf8"), /^skilletor\.lock\.json$/m);
    const boom = () => { throw new Error("git exploded"); };
    const again = await runHook("session-start", { cwd: e.projectDir }, { ...e.ctx, isGitWorkTree: boom });
    assert.equal(again.systemMessage, undefined);
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), false); // a failing test counts as "no"
  } finally {
    e.cleanup();
  }
});

test("k62: session-start asks once to commit a new .gitignore block, in the message and the context", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } } });
    writeFileSync(join(e.projectDir, ".claude/skilletor.json"), JSON.stringify({ install: { skills: ["foo@mine"] } }));
    const out = await runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx);
    assert.equal(out.systemMessage, "skilletor: 1 item(s) updated, .claude/.gitignore updated — commit it");
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /^- \.claude\/\.gitignore updated — commit it$/m);
    // Nothing changed since: no second hint, the hook stays silent.
    assert.deepEqual(await runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx), {});
  } finally {
    e.cleanup();
  }
});

// k65 (spec §6.4): a user-scope change syncs the project scope too; unused, it writes nothing there.
test("k65: session-start in a project that never used skilletor writes nothing there and asks for no commit", async () => {
  const e = env();
  try {
    rmSync(join(e.projectDir, ".claude"), { recursive: true });
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const out = await runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx);
    assert.equal(out.systemMessage, "skilletor: 1 item(s) updated");
    assert.doesNotMatch(out.hookSpecificOutput?.additionalContext ?? "", /gitignore/);
    assert.deepEqual(readdirSync(e.projectDir), []);

    // A block an earlier version left there goes on the next sync, just as silently.
    mkdirSync(join(e.projectDir, ".claude"));
    writeFileSync(join(e.projectDir, ".claude/.gitignore"), "# >>> skilletor >>>\nskilletor.local.json\nskilletor.lock.json\n# <<< skilletor <<<\n");
    writeFileSync(join(src, "skills/foo/SKILL.md"), "---\nname: foo\ndescription: foo\n---\nCHANGED\n");
    const again = await runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx);
    assert.equal(again.systemMessage, "skilletor: 1 item(s) updated");
    assert.doesNotMatch(again.hookSpecificOutput?.additionalContext ?? "", /gitignore/);
    assert.equal(existsSync(join(e.projectDir, ".claude/.gitignore")), false);
  } finally {
    e.cleanup();
  }
});

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

/** A bare git repo holding `files` in one commit; returns its file:// URL. */
function gitSource(root: string, files: Record<string, string>): string {
  const work = join(root, "git-work");
  const bare = join(root, "git-src.git");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(work, rel, ".."), { recursive: true });
    writeFileSync(join(work, rel), content);
  }
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
  git(root, "init", "-q", "-b", "main", "--bare", bare);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  const url = pathToFileURL(resolvePath(bare)).href;
  git(work, "push", "-q", url, "main");
  return url;
}

// k64 (spec §14.3): the source does not move, so only check's layout test can start the sync.
test("k64: session-start migrates a pre-k62 install of an unchanged git source in one session, both harnesses", async () => {
  const e = env();
  try {
    const url = gitSource(e.tmp.dir, {
      "skills/foo/SKILL.md": "---\nname: foo\ndescription: foo\n---\nFOO\n",
      "agents/a.md": "---\nname: a\ndescription: A\n---\nAGENT\n",
      "rules/r.md": "RULE\n",
    });
    const codexHome = join(e.tmp.dir, "codex");
    const ctx: HookContext = { ...e.ctx, markers: { claude: [e.home], codex: [e.home] }, codexHome };
    e.writeUserCfg({ sources: { g: { git: url } }, install: { skills: ["foo@g"], agents: ["a@g"], rules: ["r@g"] } });
    const input = { source: "startup", cwd: e.projectDir };
    assert.match((await runHook("session-start", input, ctx)).systemMessage ?? "", /6 item\(s\) updated/);
    assert.deepEqual(await runHook("session-start", input, ctx), {}); // nothing moved: no sync

    // What 0.2.0 left: plain agent and rule files, skills without .gitignore (both harnesses).
    const claude = join(e.home, ".claude");
    const lockPath = join(claude, "skilletor.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const unprefix = (root: string, key: string, from: string, to: string) => {
      renameSync(join(root, from), join(root, to));
      lock[key].files = { [to]: lock[key].files[from] };
    };
    unprefix(claude, "agents/a", "agents/.local.a.md", "agents/a.md");
    unprefix(claude, "rules/r", "rules/.local.r.md", "rules/r.md");
    unprefix(codexHome, "codex:agents/a", "agents/.local.a.toml", "agents/a.toml");
    for (const [root, key] of [[claude, "skills/foo"], [join(e.home, ".agents"), "codex:skills/foo"]] as const) {
      rmSync(join(root, "skills/foo/.gitignore"));
      delete lock[key].files["skills/foo/.gitignore"];
    }
    writeFileSync(lockPath, JSON.stringify(lock));

    const out = await runHook("session-start", input, ctx);
    assert.match(out.systemMessage ?? "", /5 item\(s\) updated/);
    assert.deepEqual(readdirSync(join(claude, "agents")), [".local.a.md"]);
    assert.deepEqual(readdirSync(join(claude, "rules")), [".local.r.md"]);
    assert.deepEqual(readdirSync(join(codexHome, "agents")), [".local.a.toml"]);
    assert.equal(existsSync(join(claude, "skills/foo/.gitignore")), true);
    assert.equal(existsSync(join(e.home, ".agents/skills/foo/.gitignore")), true);
    assert.deepEqual(await runHook("session-start", input, ctx), {}); // migrated: silent again
  } finally {
    e.cleanup();
  }
});

// k84 (spec §6.5, §8): a git killed midway through a session-start fetch (SIGKILL on a hook
// timeout) leaves its lock files in the source's cache, and every later fetch fell back to the
// cache with a warning. Asserts: once upstream moved, the next session-start clears the stale
// `shallow.lock` and `index.lock` before it fetches, so the update lands and the hook reports
// it without a warning, and no lock file is left.
test("k84: session-start after a killed fetch clears the stale git locks; the update lands, no warning", async () => {
  const e = env();
  try {
    const skill = (body: string) => `---\nname: foo\ndescription: foo\n---\n${body}\n`;
    const url = gitSource(e.tmp.dir, { "skills/foo/SKILL.md": skill("FIRST") });
    e.writeUserCfg({ sources: { g: { git: url } }, install: { skills: ["foo@g"] } });
    const input = { source: "startup", cwd: e.projectDir };
    assert.equal((await runHook("session-start", input, e.ctx)).systemMessage, "skilletor: 1 item(s) updated");

    const work = join(e.tmp.dir, "git-work");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
    writeFileSync(join(work, "skills/foo/SKILL.md"), skill("SECOND"));
    git("commit", "-qam", "second");
    git("push", "-q", url, "main");
    const cacheRoot = join(e.ctx.stateRoot, "cache");
    const gitDir = join(cacheRoot, readdirSync(cacheRoot)[0]!, ".git");
    const killed = new Date(Date.now() - 10 * 60_000);
    for (const name of ["shallow.lock", "index.lock"]) {
      writeFileSync(join(gitDir, name), "");
      utimesSync(join(gitDir, name), killed, killed);
    }

    assert.equal((await runHook("session-start", input, e.ctx)).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(readFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "utf8"), /SECOND/);
    assert.deepEqual(readdirSync(gitDir).filter((n) => n.endsWith(".lock")), []);
  } finally {
    e.cleanup();
  }
});

test("k64: session-start in an unused project removes 0.2.0's block though nothing else changed, silently", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    const gi = join(e.projectDir, ".claude/.gitignore");
    writeFileSync(gi, "# >>> skilletor >>>\nskilletor.local.json\nskilletor.lock.json\n# <<< skilletor <<<\n");
    mkdirSync(join(e.projectDir, ".codex"));
    writeFileSync(join(e.projectDir, ".codex/.gitignore"), "own\n\n# >>> skilletor >>>\nagents/x.toml\n# <<< skilletor <<<\n");
    assert.deepEqual(await runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx), {});
    assert.equal(existsSync(gi), false);
    assert.equal(readFileSync(join(e.projectDir, ".codex/.gitignore"), "utf8"), "own\n");
  } finally {
    e.cleanup();
  }
});

test("k63: session-start puts the tracked-file warning into the context; a failing tracked test stays silent", async () => {
  const e = env();
  try {
    const src = localSkill(e.tmp.dir, "s", "foo");
    e.writeUserCfg({ sources: { mine: { local: src } } });
    writeFileSync(join(e.projectDir, ".claude/skilletor.json"), JSON.stringify({ install: { skills: ["foo@mine"] } }));
    const tracked = (_dir: string, paths: string[]) => paths.filter((p) => p === "skills/foo/SKILL.md");
    const out = await runHook("session-start", { source: "startup", cwd: e.projectDir }, { ...e.ctx, gitTracked: tracked });
    assert.match(out.systemMessage ?? "", /1 warning\(s\)/);
    const lines = (out.hookSpecificOutput?.additionalContext ?? "").split("\n");
    assert.equal(lines.includes(
      "- warning: skills/foo is tracked by git although skilletor manages it — untrack it: git rm -r --cached .claude/skills/foo",
    ), true);

    writeFileSync(join(src, "skills/foo/SKILL.md"), "---\nname: foo\ndescription: foo\n---\nCHANGED\n");
    const boom = () => { throw new Error("git exploded"); };
    const again = await runHook("session-start", { source: "startup", cwd: e.projectDir }, { ...e.ctx, gitTracked: boom });
    assert.equal(again.systemMessage, "skilletor: 1 item(s) updated");
    assert.doesNotMatch(JSON.stringify(again), /tracked by git|exploded/);
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

test("k50: codex session-start puts the user, then the project rules file first, the sync report after", async () => {
  const e = env();
  try {
    const { first, userFile, projectFile } = await codexRules(e);
    assert.match(userFile, /^<!-- skilletor:rules scope=user -->\n[\s\S]*User rule\.\n$/);
    assert.match(projectFile, /^<!-- skilletor:rules scope=project -->\n[\s\S]*Project rule\.\n$/);
    const ctxText = first.hookSpecificOutput?.additionalContext ?? "";
    // The message begins with the marker, as the AGENTS.md pointer says (spec §14.8).
    assert.ok(ctxText.startsWith(userFile + "\n" + projectFile + "\nskilletor synced items:\n"), ctxText);
    assert.match(first.systemMessage ?? "", /^skilletor: 2 item\(s\) updated/);
  } finally {
    e.cleanup();
  }
});

test("k50: a sync with warnings: rules first, the report's warnings after them", async () => {
  const e = env();
  try {
    const { ctx, userFile, projectFile, src } = await codexRules(e);
    e.writeUserCfg({ sources: { mine: { local: resolvePath(src) } }, install: { rules: ["urule@mine", "nope@mine"] } });
    const out = await runHook("session-start", { source: "startup" }, ctx);
    const ctxText = out.hookSpecificOutput?.additionalContext ?? "";
    assert.ok(ctxText.startsWith(userFile + "\n" + projectFile + "\n"), ctxText);
    assert.match(ctxText.slice((userFile + projectFile).length), /- warning: item not found in source mine: rule nope/);
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

test("k50: a failed sync still delivers the last good rules as the whole context; the warning is the systemMessage", async () => {
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

// k74 (spec §6.5, §8): every sync, the hooks' too, first sweeps what a dead run left in the
// source cache, under the sync lock. Asserts: SessionStart syncs and reports exactly as it
// would without leftovers (no word about the sweep), and the leftovers are gone; with a cache
// root that cannot be read (a file), the hook reports the same and never throws.
test("k74: session-start's sync sweeps cache leftovers silently; an unreadable cache root changes nothing", async () => {
  for (const broken of [false, true]) {
    const e = env();
    try {
      const src = localSkill(e.tmp.dir, "s", "foo");
      e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
      const cache = join(e.tmp.dir, "cache");
      if (broken) {
        writeFileSync(cache, "not a dir");
      } else {
        mkdirSync(join(cache, "0123456789abcdef/skills/new"), { recursive: true });
        mkdirSync(join(cache, "0123456789abcdef.stage-Ab12Cd/skills/half"), { recursive: true });
        mkdirSync(join(cache, "0123456789abcdef.backup-Ef34Gh/tree/skills/old"), { recursive: true });
      }
      const out = await runHook("session-start", { source: "startup" }, { ...e.ctx, cacheRoot: cache });
      assert.deepEqual(out, {
        systemMessage: "skilletor: 1 item(s) updated",
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "skilletor synced items:\n- skill foo@mine: active now" },
      }, broken ? "unreadable cache root" : "with leftovers");
      if (broken) assert.equal(readFileSync(cache, "utf8"), "not a dir");
      else assert.deepEqual(readdirSync(cache), ["0123456789abcdef"]);
    } finally {
      e.cleanup();
    }
  }
});

// k85: trust binds a source's kind and address, not its ref, so a project config (a cloned
// repo) could turn a trusted source's ref into `--upload-pack=<cmd>` and run <cmd> at the next
// SessionStart. Asserts: that session-start returns exactly one warning line naming the file,
// the source and the key; <cmd> never runs (no marker), nothing is fetched and the installed
// skill stays as it was; the in-session background sync never throws and runs nothing either.
test("k85: a trusted project source whose ref turns into an option: one warning naming it, no command run", async () => {
  const e = env();
  try {
    const url = gitSource(e.tmp.dir, { "skills/foo/SKILL.md": "---\nname: foo\ndescription: foo\n---\nFOO\n" });
    const projectCfg = join(e.projectDir, ".claude/skilletor.json");
    const writeProjectCfg = (ref?: string) => writeFileSync(projectCfg, JSON.stringify({
      sources: { team: ref === undefined ? { git: url } : { git: url, ref } },
      install: { skills: ["foo@team"] },
    }));
    new State(e.ctx.stateRoot).trust("team", { kind: "git", address: url });
    writeProjectCfg();
    const input = { source: "startup", cwd: e.projectDir };
    assert.match((await runHook("session-start", input, e.ctx)).systemMessage ?? "", /1 item\(s\) updated/);
    const skill = join(e.projectDir, ".claude/skills/foo/SKILL.md");
    assert.equal(readFileSync(skill, "utf8"), "---\nname: foo\ndescription: foo\n---\nFOO\n");
    const cache = readdirSync(join(e.ctx.stateRoot, "cache")).sort();

    const marker = join(e.tmp.dir, "pwned");
    const ref = `--upload-pack=touch '${marker}'`;
    writeProjectCfg(ref);
    const out = await runHook("session-start", input, e.ctx);
    assert.deepEqual(out, {
      systemMessage: `skilletor: ${projectCfg}: sources.team.ref ${JSON.stringify(ref)} must not start with "-" (git would read it as an option)`,
    });
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readdirSync(join(e.ctx.stateRoot, "cache")).sort(), cache); // nothing fetched
    assert.equal(readFileSync(skill, "utf8"), "---\nname: foo\ndescription: foo\n---\nFOO\n");

    await runHook("__sync-background", {}, e.ctx);
    const delivered = await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(delivered.systemMessage, out.systemMessage); // k86: the error, not "changes applied"
    assert.equal(existsSync(marker), false);
  } finally {
    e.cleanup();
  }
});

// ---- k87: strings from a config, a source or git are display-safe --------------------

/** An ANSI color escape, a BEL, a right-to-left override and a newline. */
const EVIL = "\u001b[31mred\u0007\u202eevil\nnext";
/** How EVIL shows: each of them escaped the JSON way, the text around them as it was. */
const SHOWN = "\\u001b[31mred\\u0007\\u202eevil\\nnext";
/** A character hook output never carries raw (a tab may; a newline only between context lines). */
const RAW = /(?![\t\n])[\p{Cc}\p{Bidi_Control}\u200b\u2028\u2029\u2060\ufeff]/u;

/** The output's systemMessage is one clean line; its context has no raw character. */
function assertDisplaySafe(out: HookOutput): void {
  assert.doesNotMatch(out.systemMessage ?? "", /\n/);
  assert.doesNotMatch(out.systemMessage ?? "", RAW);
  assert.doesNotMatch(out.hookSpecificOutput?.additionalContext ?? "", RAW);
}

// Asserts: a cloned project config that declares a source whose local path carries EVIL gets
// its trust request into the context escaped – the address, beside the name and the command to
// run – on one line, the systemMessage counting it; nothing raw reaches the output. (A name
// with EVIL is a config error since k95: the next test.)
test("k87: session-start names an untrusted project source escaped, on one context line", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    const payload = join(e.tmp.dir, "payload");
    writeFileSync(join(e.projectDir, ".claude/skilletor.json"), JSON.stringify({
      sources: { team: { local: payload + EVIL } },
      install: { skills: ["foo@team"] },
    }));
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assertDisplaySafe(out);
    assert.match(out.systemMessage ?? "", /^skilletor: 1 warning\(s\)/);
    const lines = (out.hookSpecificOutput?.additionalContext ?? "").split("\n");
    assert.ok(
      lines.includes(`- untrusted source team (local ${payload}${SHOWN}); run: skilletor trust team`),
      lines.join("\n"),
    );
  } finally {
    e.cleanup();
  }
});

// Asserts: a source name with EVIL – a config error (k95), found before the source's unknown
// key; the warning SessionStart gives in one line – is that one line with EVIL escaped, and the
// background sync's report the next prompt delivers is the same line.
test("k87: a config error naming such a source is one escaped warning line, now and on the next prompt", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    const cfg = join(e.projectDir, ".claude/skilletor.json");
    writeFileSync(cfg, JSON.stringify({ sources: { [`team${EVIL}`]: { local: "/src", x: 1 } } }));
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.deepEqual(out, {
      systemMessage: `skilletor: ${cfg}: source name "team${SHOWN}" is not valid ` +
        `(ASCII letters, digits, ".", "_" and "-", starting with a letter or digit)`,
    });
    await runHook("__sync-background", {}, e.ctx);
    const delivered = await runHook("user-prompt-submit", {}, e.ctx);
    assert.equal(delivered.systemMessage, out.systemMessage);
  } finally {
    e.cleanup();
  }
});

// Asserts: git's stderr, which spans lines ("fatal: …\nfatal: …\n\nPlease make sure …"), is
// one context line for the one warning the systemMessage counts (k72's claim held only for
// one-line messages), its line breaks escaped – and not the newline git ends it with.
test("k87: a git failure's multi-line stderr stays one context line", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { shared: { git: "file:///nonexistent/skilletor-k87/never.git" } }, install: { skills: ["foo@shared"] } });
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assertDisplaySafe(out);
    assert.equal(out.systemMessage, "skilletor: 1 warning(s)");
    const context = out.hookSpecificOutput?.additionalContext ?? "";
    assert.equal(context.split("\n").length, 1, context);
    assert.match(context, /^- warning: source shared: git source .* failed: .*fatal: .*\\nfatal: /);
    assert.doesNotMatch(context, /\\n$/); // git's final newline is trimmed, not shown escaped
  } finally {
    e.cleanup();
  }
});

// Asserts: a Codex rules file that cannot be read, in a project directory whose name carries
// EVIL, is named in the systemMessage escaped, on its one line.
// Windows allows no control characters in a file name: the project directory cannot exist there.
test("k87: codex session-start names an unreadable rules file escaped", { skip: process.platform === "win32" && "control characters in a directory name" }, async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    const projectDir = join(e.tmp.dir, `proj${EVIL}`);
    mkdirSync(join(projectDir, ".codex", "skilletor-rules.md"), { recursive: true }); // a directory: unreadable
    const ctx: HookContext = {
      ...e.ctx, projectDir, markers: { claude: [], codex: [e.home] }, codexHome: join(e.home, ".codex"), harness: "codex",
    };
    const out = await runHook("session-start", { source: "startup" }, ctx);
    assertDisplaySafe(out);
    const message = out.systemMessage ?? "";
    assert.match(message, /^skilletor: cannot read /);
    assert.ok(message.includes(`${join(e.tmp.dir, "proj")}${SHOWN}/.codex/skilletor-rules.md (EISDIR`), message);
  } finally {
    e.cleanup();
  }
});
