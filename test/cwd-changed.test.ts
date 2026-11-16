// k147 (spec §8): the CwdChanged hook syncs the checkout a session moves into, and so – awaited,
// on a Bash call with a `cd` – does PostToolUse. Black box through runHook, against temp dirs:
// `ctx.projectDir` plays CLAUDE_PROJECT_DIR – the session's own project, which a move never syncs
// instead of the checkout it moved into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { runHook, syncMovedCheckout, type HookContext, type HookOutput } from "../src/hooks.ts";
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
  const started = await runHook("session-start", { source: "startup", cwd: e.main, session_id: "s1" }, e.ctx);
  assert.match(started.systemMessage ?? "", /item\(s\) updated/);
  git(e.main, "add", ".claude/.gitignore", ".worktreeinclude");
  git(e.main, "commit", "-qm", "blocks");
  return addWorktree(e, "backlog");
}

/** A plain `git worktree add` of `main` under `.claude/worktrees/`: the config, no lock. */
function addWorktree(e: Env, name: string): string {
  const wt = join(e.main, ".claude", "worktrees", name);
  git(e.main, "worktree", "add", "-q", "-b", name, wt);
  assert.equal(existsSync(join(wt, ".claude", "skilletor.json")), true);
  assert.equal(existsSync(join(wt, ".claude", "skilletor.lock.json")), false);
  return wt;
}

const move = (oldCwd: string, newCwd: string) =>
  ({ hook_event_name: "CwdChanged", old_cwd: oldCwd, new_cwd: newCwd, cwd: newCwd, session_id: "s1" });

/** PostToolUse after a Bash `cd`: `cwd` is where the command left the session; no old cwd. */
const bashCd = (cwd: string, session = "s1") => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `cd ${cwd}` }, cwd, session_id: session,
});

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

test("k239: a move hook accepts unchanged CRLF managed blocks without duplicating or reporting them", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine"] });
    const managed = [join(wt, ".claude", ".gitignore"), join(wt, ".worktreeinclude")];
    for (const path of managed) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n"));
      assert.doesNotMatch(readFileSync(path, "utf8"), /\r\r\n/, `${path}: exactly one CR per line ending`);
    }

    const out = await runHook("cwd-changed", move(e.main, wt), e.ctx);
    assert.deepEqual(out, { systemMessage: `skilletor: 1 item(s) updated in ${wt}` });
    for (const path of managed) {
      const text = readFileSync(path, "utf8");
      assert.match(text, /\r\n/);
      assert.equal((text.match(/# >>> skilletor >>>/g) ?? []).length, 1);
    }
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
      systemMessage: `skilletor: cannot sync ${wt}: sync stopped before applying the project scope: its sources took too long — run there: skilletor sync`,
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

// ---- PostToolUse: the awaited move hook, on a Bash call with a `cd` ---------------------------

// Asserts: a `cd` into a worktree without a lock syncs it before the hook returns – the hook
// Claude Code awaits, so the next tool call finds both items – and answers with the line for the
// user and a context for the model, its first line naming the worktree. The session's record
// moves to the worktree; the session's own project is left as it was.
test("k147: PostToolUse after a cd into a worktree without a lock syncs it, with a context for the model", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine", "bar@mine"] });
    const mainLock = readFileSync(join(e.main, ".claude", "skilletor.lock.json"), "utf8");

    const out = await runHook("post-tool-use", bashCd(wt), e.ctx);
    assert.deepEqual(out, {
      systemMessage: `skilletor: 2 item(s) updated in ${wt}`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: [`skilletor: in ${wt}:`, "skilletor synced items:", "- skill foo@mine: active now", "- skill bar@mine: active now"].join("\n"),
      },
    });
    assert.equal(readFileSync(join(wt, ".claude", "skills", "foo", "SKILL.md"), "utf8"), SKILL("foo"));
    assert.equal(readFileSync(join(wt, ".claude", "skills", "bar", "SKILL.md"), "utf8"), SKILL("bar"));
    assert.equal(readFileSync(join(e.main, ".claude", "skilletor.lock.json"), "utf8"), mainLock);
    assert.equal(new State(e.ctx.stateRoot).sessionCwd("s1"), wt);
  } finally {
    e.cleanup();
  }
});

// Asserts: within the checkout its SessionStart looked at, a `cd` asks nothing – not even when
// the checkout's lock lags its config (a skill added since), where a look would sync: the
// session's record says it is the same checkout. A `cd` into another checkout still syncs it.
test("k147: PostToolUse after a cd within the same checkout syncs nothing", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine"] });
    e.writeJson(join(e.main, ".claude", "skilletor.json"), { install: { skills: ["foo@mine", "bar@mine"] } });
    const sub = join(e.main, "src", "deep");
    mkdirSync(sub, { recursive: true });
    assert.deepEqual(await runHook("post-tool-use", bashCd(sub), e.ctx), {});
    assert.deepEqual(await runHook("post-tool-use", bashCd(e.main), e.ctx), {});
    assert.deepEqual(await runHook("post-tool-use", bashCd(e.main), e.ctx), {}); // `cd . && …`: the same cwd
    assert.equal(existsSync(join(e.main, ".claude", "skills", "bar")), false);
    // Control: the worktree is another checkout.
    assert.equal((await runHook("post-tool-use", bashCd(wt), e.ctx)).systemMessage, `skilletor: 1 item(s) updated in ${wt}`);
  } finally {
    e.cleanup();
  }
});

// Asserts: a `cd` into a directory that is no skilletor project – a git checkout without a
// config, a plain directory, the home dir – is silent and writes nothing there; nor does input
// without a usable cwd.
test("k147: PostToolUse after a cd into a directory without a skilletor project is a no-op", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } }, install: { skills: ["foo@mine"] } });
    const repo = join(e.dir, "repo");
    const plain = join(e.dir, "plain");
    mkdirSync(repo);
    mkdirSync(plain);
    git(repo, "init", "-q", "-b", "main");
    for (const dir of [repo, plain, e.home]) {
      assert.deepEqual(await runHook("post-tool-use", bashCd(dir, `s-${dir}`), e.ctx), {}, dir);
    }
    assert.equal(existsSync(join(repo, ".claude")), false);
    assert.equal(existsSync(join(plain, ".claude")), false);
    assert.equal(existsSync(join(e.home, ".claude", "skills")), false); // the user scope never syncs on a move
    assert.deepEqual(await runHook("post-tool-use", { hook_event_name: "PostToolUse", session_id: "s1" }, e.ctx), {});
    assert.deepEqual(await runHook("post-tool-use", { cwd: 42 as unknown as string }, e.ctx), {});
  } finally {
    e.cleanup();
  }
});

// Asserts: a `cd` into a checkout whose project config declares its own, untrusted source gets
// the line naming the checkout and the `skilletor trust` to run there, the model the same in its
// context; nothing is fetched or installed. A further `cd … && …` there says it no more.
test("k147: PostToolUse after a cd into a checkout with an untrusted source warns once, fetches nothing", async () => {
  const e = env();
  try {
    e.userCfg({});
    const url = gitSource(e);
    const other = join(e.dir, "other");
    e.writeJson(join(other, ".claude", "skilletor.json"), { sources: { team: { git: url } }, install: { skills: ["foo@team"] } });
    git(other, "init", "-q", "-b", "main");

    const out = await runHook("post-tool-use", bashCd(other), e.ctx);
    assert.deepEqual(out, {
      systemMessage: `skilletor: 1 warning(s) in ${other} — run there: skilletor trust team`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `skilletor: in ${other}:\n- untrusted source team (git ${url}); run: skilletor trust team`,
      },
    });
    assert.equal(existsSync(join(e.ctx.stateRoot, "cache")), false);
    assert.equal(existsSync(join(other, ".claude", "skills")), false);
    assert.equal(existsSync(join(other, ".claude", "skilletor.lock.json")), false);
    assert.deepEqual(await runHook("post-tool-use", bashCd(other), e.ctx), {});
  } finally {
    e.cleanup();
  }
});

// Asserts the race of one `cd` (spec §8): Claude Code fires CwdChanged and PostToolUse together,
// both see the worktree's lock missing, and one syncs while the other waits on the sync lock. In
// either order the PostToolUse returns only once the items are on disk, the update line comes
// once, and the hook that waited syncs nothing again – the source changes the moment the first
// hook returns, which a second sync would install.
test("k147: CwdChanged and PostToolUse of one cd: one syncs, PostToolUse returns with the items there", async () => {
  for (const first of ["cwd-changed", "post-tool-use"] as const) {
    const e = env();
    try {
      const src = localSource(e);
      e.userCfg({ sources: { mine: { local: src } } });
      const wt = await mainWithWorktree(e, { skills: ["foo@mine", "bar@mine"] });
      const fooAt = join(wt, ".claude", "skills", "foo", "SKILL.md");
      const order: string[] = [];
      let itemsWhenPostReturned = false;
      const returned = (event: string) => (out: HookOutput) => {
        if (order.length === 0) writeFileSync(join(src, "skills", "foo", "SKILL.md"), SKILL("foo") + "CHANGED\n");
        order.push(event);
        if (event === "post-tool-use") {
          itemsWhenPostReturned = readFileSync(fooAt, "utf8") === SKILL("foo") &&
            existsSync(join(wt, ".claude", "skills", "bar", "SKILL.md")) && existsSync(join(wt, ".claude", "skilletor.lock.json"));
        }
        return out;
      };
      const fire = (event: "cwd-changed" | "post-tool-use") =>
        runHook(event, event === "cwd-changed" ? move(e.main, wt) : bashCd(wt), e.ctx).then(returned(event));
      const second = first === "cwd-changed" ? "post-tool-use" : "cwd-changed";
      const outs = await Promise.all([fire(first), fire(second)]);

      assert.deepEqual(order, [first, second], first);
      assert.equal(outs[0]!.systemMessage, `skilletor: 2 item(s) updated in ${wt}`, first);
      assert.deepEqual(outs[1], {}, first);
      assert.equal(itemsWhenPostReturned, true, first);
      assert.equal(readFileSync(fooAt, "utf8"), SKILL("foo"), first); // no second sync
    } finally {
      e.cleanup();
    }
  }
});

// Asserts: a PostToolUse while another run holds the sync lock waits for it instead of returning
// early, and syncs once it is free; the wait ends at the move's deadline, past which its sync
// would write nothing – then the line says so, and nothing is written.
test("k147: PostToolUse waits on the sync lock up to its deadline", async () => {
  const e = env();
  try {
    e.userCfg({ sources: { mine: { local: localSource(e) } } });
    const wt = await mainWithWorktree(e, { skills: ["foo@mine"] });
    const state = new State(e.ctx.stateRoot);
    let settled = false;
    let post: Promise<HookOutput> | undefined;
    await state.withLock(async () => {
      post = runHook("post-tool-use", bashCd(wt), e.ctx);
      void post.then(() => (settled = true));
      await delay(300);
      assert.equal(settled, false);
    });
    assert.equal((await post!).systemMessage, `skilletor: 1 item(s) updated in ${wt}`);
    assert.equal(existsSync(join(wt, ".claude", "skills", "foo", "SKILL.md")), true);

    const wt2 = addWorktree(e, "other");
    const started = Date.now();
    const out = await state.withLock(() => runHook("post-tool-use", bashCd(wt2), { ...e.ctx, deadline: Date.now() + 300 }));
    assert.ok(Date.now() - started < 3_000, `waited ${Date.now() - started} ms`);
    assert.match(out.systemMessage ?? "", new RegExp(`^skilletor: cannot sync ${esc(wt2)}: timed out acquiring sync lock at .* — run there: skilletor sync$`));
    assert.equal(existsSync(join(wt2, ".claude", "skilletor.lock.json")), false);
    assert.equal(existsSync(join(wt2, ".claude", "skills")), false);
  } finally {
    e.cleanup();
  }
});
