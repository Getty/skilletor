// k147 (spec §8): the CwdChanged hook syncs the checkout a session moves into. Black box through
// runHook, against temp dirs: `ctx.projectDir` plays CLAUDE_PROJECT_DIR – the session's own
// project, which a move never syncs instead of the checkout it moved into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { runHook, syncMovedCheckout, type HookContext } from "../src/hooks.ts";
import { State } from "../src/state.ts";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nBODY\n`;

function env() {
  const tmp = makeTmpDir();
  const dir = realpathSync(tmp.dir);
  const home = join(dir, "home");
  const main = join(dir, "main");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(main, ".claude"), { recursive: true });
  const ctx: HookContext = {
    home,
    projectDir: main, // CLAUDE_PROJECT_DIR: the session started in `main`
    stateRoot: join(dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false, // never the real location of the temp dir
    background: () => assert.fail("a move never starts a background sync"),
  };
  const writeJson = (path: string, obj: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(obj, null, 2));
  };
  const userCfg = (obj: unknown) => writeJson(join(home, ".claude", "skilletor.json"), obj);
  return { tmp, dir, home, main, ctx, writeJson, userCfg, cleanup: () => tmp.cleanup() };
}

type Env = ReturnType<typeof env>;

/** A local source with skills `foo` and `bar`, in the user config as `mine` (trusted). */
function localSource(e: Env): string {
  const src = join(e.dir, "src");
  for (const name of ["foo", "bar"]) {
    mkdirSync(join(src, "skills", name), { recursive: true });
    writeFileSync(join(src, "skills", name, "SKILL.md"), SKILL(name));
  }
  return src;
}

/** A bare git repo serving skill `foo`; its file:// URL. */
function gitSource(e: Env): string {
  const work = join(e.dir, "git-work");
  const bare = join(e.dir, "git-src.git");
  mkdirSync(join(work, "skills", "foo"), { recursive: true });
  writeFileSync(join(work, "skills", "foo", "SKILL.md"), SKILL("foo"));
  git(e.dir, "init", "-q", "-b", "main", "--bare", bare);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  const url = pathToFileURL(resolvePath(bare)).href;
  git(work, "push", "-q", url, "main");
  return url;
}

/**
 * `main`: a git checkout whose committed `.claude/skilletor.json` declares `install`, synced by
 * its SessionStart, with the blocks that sync wrote committed too. Then a plain `git worktree
 * add` under `.claude/worktrees/`: git copies the tracked files only, so the worktree has the
 * config but no lock and no items.
 */
async function mainWithWorktree(e: Env, install: Record<string, string[]>): Promise<string> {
  e.writeJson(join(e.main, ".claude", "skilletor.json"), { install });
  git(e.main, "init", "-q", "-b", "main");
  git(e.main, "add", ".claude/skilletor.json");
  git(e.main, "commit", "-qm", "config");
  const started = await runHook("session-start", { source: "startup", cwd: e.main }, e.ctx);
  assert.match(started.systemMessage ?? "", /item\(s\) updated/);
  git(e.main, "add", ".claude/.gitignore", ".worktreeinclude");
  git(e.main, "commit", "-qm", "blocks");
  const wt = join(e.main, ".claude", "worktrees", "backlog");
  git(e.main, "worktree", "add", "-q", "-b", "backlog", wt);
  assert.equal(existsSync(join(wt, ".claude", "skilletor.json")), true);
  assert.equal(existsSync(join(wt, ".claude", "skilletor.lock.json")), false);
  return wt;
}

const move = (oldCwd: string, newCwd: string) =>
  ({ hook_event_name: "CwdChanged", old_cwd: oldCwd, new_cwd: newCwd, cwd: newCwd, session_id: "s1" });

// Asserts: a `cd` into a worktree that has the config but no lock syncs the worktree's project
// scope – both items land there, with its own lock – and answers with the one line naming the
// worktree, no context (CwdChanged takes none). The session's project is left as it was.
test("k147: a move into a worktree without a lock syncs it, one line names the worktree", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine", "bar@mine"] });
    const mainLock = readFileSync(join(e.main, ".claude", "skilletor.lock.json"), "utf8");

    const out = await runHook("cwd-changed", move(e.main, wt), e.ctx);
    assert.deepEqual(out, { systemMessage: `skilletor: 2 item(s) updated in ${wt}` });
    assert.equal(readFileSync(join(wt, ".claude", "skills", "foo", "SKILL.md"), "utf8"), SKILL("foo"));
    assert.equal(readFileSync(join(wt, ".claude", "skills", "bar", "SKILL.md"), "utf8"), SKILL("bar"));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(wt, ".claude", "skilletor.lock.json"), "utf8"))).sort(),
      ["skills/bar", "skills/foo"]);
    assert.equal(readFileSync(join(e.main, ".claude", "skilletor.lock.json"), "utf8"), mainLock);
  } finally {
    e.cleanup();
  }
});

// Asserts: a move within one checkout – into a subdirectory and back – syncs nothing, even
// though that checkout has no lock and a sync would install there: no lock, no items, silent.
test("k147: a move within the same checkout syncs nothing", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    e.writeJson(join(e.main, ".claude", "skilletor.json"), { install: { skills: ["foo@mine"] } });
    git(e.main, "init", "-q", "-b", "main");
    const sub = join(e.main, "src", "deep");
    mkdirSync(sub, { recursive: true });
    assert.deepEqual(await runHook("cwd-changed", move(e.main, sub), e.ctx), {});
    assert.deepEqual(await runHook("cwd-changed", move(sub, e.main), e.ctx), {});
    assert.equal(existsSync(join(e.main, ".claude", "skilletor.lock.json")), false);
    assert.equal(existsSync(join(e.main, ".claude", "skills")), false);
  } finally {
    e.cleanup();
  }
});

// Asserts: a move into a directory that is no skilletor project – a git checkout without a
// config, a plain directory, the home dir (whose `.claude/skilletor.json` is the user config) –
// is silent and writes nothing there, not even a `.claude` dir; nor does input without a cwd.
test("k147: a move into a directory without a skilletor project is a no-op", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } }, install: { skills: ["foo@mine"] } });
    const repo = join(e.dir, "repo");
    const plain = join(e.dir, "plain");
    mkdirSync(repo);
    mkdirSync(plain);
    git(repo, "init", "-q", "-b", "main");
    for (const dir of [repo, plain, e.home]) {
      assert.deepEqual(await runHook("cwd-changed", move(e.main, dir), e.ctx), {}, dir);
    }
    assert.equal(existsSync(join(repo, ".claude")), false);
    assert.equal(existsSync(join(plain, ".claude")), false);
    assert.equal(existsSync(join(e.home, ".claude", "skills")), false); // the user scope never syncs on a move
    assert.deepEqual(await runHook("cwd-changed", { hook_event_name: "CwdChanged" }, e.ctx), {});
    assert.deepEqual(await runHook("cwd-changed", { new_cwd: 42 as unknown as string }, e.ctx), {});
  } finally {
    e.cleanup();
  }
});

// Asserts: a checkout whose project config declares its own source – untrusted – gets the one
// line naming the checkout and the `skilletor trust` to run there; nothing is fetched (no cache
// dir) or installed. Once trusted, the next move into it installs.
test("k147: a move into a checkout with an untrusted source warns and fetches nothing", async () => {
  const e = env();
  try {
    e.userCfg({});
    const url = gitSource(e);
    const other = join(e.dir, "other");
    e.writeJson(join(other, ".claude", "skilletor.json"), { sources: { team: { git: url } }, install: { skills: ["foo@team"] } });
    git(other, "init", "-q", "-b", "main");

    const out = await runHook("cwd-changed", move(e.main, other), e.ctx);
    assert.deepEqual(out, { systemMessage: `skilletor: 1 warning(s) in ${other} — run there: skilletor trust team` });
    assert.equal(existsSync(join(e.ctx.stateRoot, "cache")), false);
    assert.equal(existsSync(join(other, ".claude", "skills")), false);
    assert.equal(existsSync(join(other, ".claude", "skilletor.lock.json")), false);

    new State(e.ctx.stateRoot).trust("team", { kind: "git", address: url });
    const trusted = await runHook("cwd-changed", move(e.main, other), e.ctx);
    assert.match(trusted.systemMessage ?? "", new RegExp(`^skilletor: 1 item\\(s\\) updated, .* in ${esc(other)}$`));
    assert.equal(readFileSync(join(other, ".claude", "skills", "foo", "SKILL.md"), "utf8"), SKILL("foo"));
  } finally {
    e.cleanup();
  }
});

// Asserts: once a worktree's lock matches its config, a move into it leaves it alone and asks
// no source – its git remote is gone, and a move that asked would warn, as SessionStart there
// does with its `ls-remote` (the control) – so the move is silent and the lock unchanged.
test("k147: a move into a checkout whose lock matches its config: no sync, no source asked", async () => {
  const e = env();
  try {
    const url = gitSource(e);
    e.userCfg({ sources: { team: { git: url } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@team"] });
    assert.deepEqual(await runHook("cwd-changed", move(e.main, wt), e.ctx), { systemMessage: `skilletor: 1 item(s) updated in ${wt}` });
    const lock = readFileSync(join(wt, ".claude", "skilletor.lock.json"), "utf8");

    renameSync(join(e.dir, "git-src.git"), join(e.dir, "gone.git"));
    assert.deepEqual(await runHook("cwd-changed", move(e.main, wt), e.ctx), {});
    assert.equal(readFileSync(join(wt, ".claude", "skilletor.lock.json"), "utf8"), lock);
    const control = await runHook("session-start", { source: "startup", cwd: wt }, { ...e.ctx, projectDir: wt });
    assert.match(control.systemMessage ?? "", /^skilletor: source team: git ls-remote -- /);
  } finally {
    e.cleanup();
  }
});

// Asserts: a config error in the checkout moved into is the one line naming the checkout, the
// error and `skilletor sync` to run there; nothing is written.
test("k147: a config error in the checkout moved into: one line with the fix, nothing written", async () => {
  const e = env();
  try {
    e.userCfg({});
    const other = join(e.dir, "other");
    const cfg = join(other, ".claude", "skilletor.json");
    e.writeJson(cfg, { install: { skills: ["foo"] } }); // no @source
    git(other, "init", "-q", "-b", "main");
    const out = await runHook("cwd-changed", move(e.main, other), e.ctx);
    assert.match(out.systemMessage ?? "", new RegExp(`^skilletor: cannot sync ${esc(other)}: .*skilletor\\.json.* — run there: skilletor sync$`));
    assert.equal(out.hookSpecificOutput, undefined);
    assert.deepEqual(readdirSync(join(other, ".claude")), ["skilletor.json"]);
  } finally {
    e.cleanup();
  }
});

// Asserts: a move whose sources are resolved only after its deadline writes nothing – no lock,
// no item, no block – so the hook's own timeout can never kill it midway; the line says so.
test("k147: past its deadline a move's sync writes nothing and says so", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine"] });
    const out = await runHook("cwd-changed", move(e.main, wt), { ...e.ctx, deadline: Date.now() - 1 });
    assert.deepEqual(out, {
      systemMessage: `skilletor: cannot sync ${wt}: sync stopped before writing anything: its sources took too long — run there: skilletor sync`,
    });
    assert.equal(existsSync(join(wt, ".claude", "skilletor.lock.json")), false);
    assert.equal(existsSync(join(wt, ".claude", "skills")), false);
    // The next move, in time, installs.
    assert.deepEqual(await runHook("cwd-changed", move(e.main, wt), e.ctx), { systemMessage: `skilletor: 1 item(s) updated in ${wt}` });
  } finally {
    e.cleanup();
  }
});

// Asserts (for k149's callers): the core answers the event it is given, with the context a
// harness that takes one hands the model – its first line names the checkout.
test("k147: syncMovedCheckout answers the caller's event, with a context naming the checkout", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine"] });
    const out = await syncMovedCheckout({ cwd: wt, eventName: "PostToolUse" }, e.ctx);
    assert.equal(out.systemMessage, `skilletor: 1 item(s) updated in ${wt}`);
    assert.equal(out.hookSpecificOutput?.hookEventName, "PostToolUse");
    assert.deepEqual(out.hookSpecificOutput?.additionalContext?.split("\n"), [
      `skilletor: in ${wt}:`,
      "skilletor synced items:",
      "- skill foo@mine: active now",
    ]);
  } finally {
    e.cleanup();
  }
});
