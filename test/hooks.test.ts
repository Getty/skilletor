// Blackbox tests for the hooks (spec §8): input in, output out; never disturbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
test("session-start with a linked skill dir of the same name: a conflict warning, nothing written through it", async () => {
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
  const url = "file://" + resolvePath(bare);
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
