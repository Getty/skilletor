// k149 (spec §8, §14.5, §16.4): under Codex and Hermes the prompt hook syncs the checkout a
// session moved into since its last turn – neither has a CwdChanged event, and both move only
// between turns. Black box through runHook, against temp dirs, once per harness. No
// `projectDir`: neither harness sets CLAUDE_PROJECT_DIR (the Hermes plugin drops it), so the
// project is the git top level of the input's cwd, as the CLI gives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { State } from "../src/state.ts";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nBODY\n`;
const HARNESSES = ["codex", "hermes"] as const;
type Harness = (typeof HARNESSES)[number];
const ACTIVE = { codex: "active from the next Codex session", hermes: "active from the next Hermes session" };
/** k152: what a Hermes move that put a skill into a checkout adds – to its line, and as the
 *  context's last line; nothing under Codex. */
const trustLine = (harness: Harness, dir: string) =>
  harness === "hermes" ? ` — if Hermes does not trust this project yet: hermes skills trust ${dir}` : "";
const trustContext = (harness: Harness, dir: string) =>
  harness === "hermes"
    ? [`- Hermes loads project skills only from a project it trusts; if this one is not yet, the user can run: hermes skills trust ${dir}`]
    : [];
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function env(harness: Harness) {
  const tmp = makeTmpDir();
  const dir = realpathSync(tmp.dir);
  const home = join(dir, "home");
  const main = join(dir, "main");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(main, ".claude"), { recursive: true });
  const background: string[] = [];
  const ctx: HookContext = {
    home,
    stateRoot: join(dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    // Codex is detected by its home; Hermes never is – the user config names it (userCfg).
    markers: harness === "codex" ? { claude: [], codex: [home] } : { claude: [], codex: [] },
    codexHome: join(home, ".codex"),
    hermesHome: join(dir, "hermes-home"),
    isGitWorkTree: () => false, // never the real location of the temp dir
    harness,
    background: (c) => void background.push(c.projectDir ?? ""),
  };
  const writeJson = (path: string, obj: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(obj, null, 2));
  };
  const userCfg = (obj: Record<string, unknown>) =>
    writeJson(join(home, ".claude", "skilletor.json"), harness === "hermes" ? { targets: ["hermes"], ...obj } : obj);
  /** Where a project skill lands for this harness. */
  const skillAt = (root: string, name: string) => join(root, harness === "codex" ? ".agents" : ".hermes", "skills", name, "SKILL.md");
  const prompt = (cwd: string | undefined, session = "s1", c: HookContext = ctx) =>
    runHook("user-prompt-submit", { hook_event_name: "UserPromptSubmit", session_id: session, ...(cwd ? { cwd } : {}) }, c);
  return { tmp, dir, home, main, ctx, background, writeJson, userCfg, skillAt, prompt, cleanup: () => tmp.cleanup() };
}

type Env = ReturnType<typeof env>;

/** A local source with skill `foo`, in the user config as `mine` (trusted). */
function localSource(e: Env): void {
  const src = join(e.dir, "src");
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), SKILL("foo"));
  e.userCfg({ sources: { mine: { local: src } } });
}

/**
 * `main`: a git checkout whose committed config installs `foo@mine`, where session `s1` started
 * – its SessionStart synced main and recorded where it looked – with what that sync wrote and
 * git tracks committed too. Then a plain `git worktree add`: the config, no lock, no items.
 */
async function mainWithWorktree(e: Env): Promise<string> {
  localSource(e);
  e.writeJson(join(e.main, ".claude", "skilletor.json"), { install: { skills: ["foo@mine"] } });
  git(e.main, "init", "-q", "-b", "main");
  const started = await runHook("session-start", { source: "startup", cwd: e.main, session_id: "s1" }, e.ctx);
  assert.match(started.systemMessage ?? "", /item\(s\) updated/);
  git(e.main, "add", "-A");
  git(e.main, "commit", "-qm", "config and blocks");
  const wt = join(e.main, ".claude", "worktrees", "backlog");
  git(e.main, "worktree", "add", "-q", "-b", "backlog", wt);
  assert.equal(existsSync(join(wt, ".claude", "skilletor.json")), true);
  assert.equal(existsSync(join(wt, ".claude", "skilletor.lock.json")), false);
  return wt;
}

for (const harness of HARNESSES) {
  // Asserts: SessionStart records where the session's hook looked; a prompt whose cwd is a
  // worktree with the config but no lock syncs it before it returns – the item lands there,
  // with its own lock – and answers with the one line naming the worktree and a context for
  // the model whose first line names it too – under Hermes both also name the `hermes skills
  // trust` that may be needed there (k152). The session's first checkout is left as it was.
  // A session without a record (one from before this build) looks once: the lock matches now.
  // Control: Claude Code's prompt hook is unchanged – it notices no move (CwdChanged does).
  test(`k149 ${harness}: a prompt in a worktree without a lock syncs it first; line and context name it`, async () => {
    const e = env(harness);
    try {
      const wt = await mainWithWorktree(e);
      assert.equal(new State(e.ctx.stateRoot).sessionCwd("s1"), e.main);
      const mainLock = readFileSync(join(e.main, ".claude", "skilletor.lock.json"), "utf8");

      assert.deepEqual(await e.prompt(wt, "s1", { ...e.ctx, harness: undefined, projectDir: e.main }), {});
      assert.equal(existsSync(join(wt, ".claude", "skilletor.lock.json")), false);

      const out = await e.prompt(wt);
      assert.deepEqual(out, {
        systemMessage: `skilletor: 1 item(s) updated in ${wt}${trustLine(harness, wt)}`,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: [
            `skilletor: in ${wt}:`, "skilletor synced items:", `- skill foo@mine (${harness}): ${ACTIVE[harness]}`,
            ...trustContext(harness, wt),
          ].join("\n"),
        },
      });
      assert.equal(readFileSync(e.skillAt(wt, "foo"), "utf8"), SKILL("foo"));
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(wt, ".claude", "skilletor.lock.json"), "utf8"))), [`${harness}:skills/foo`]);
      assert.equal(readFileSync(join(e.main, ".claude", "skilletor.lock.json"), "utf8"), mainLock);
      assert.equal(new State(e.ctx.stateRoot).sessionCwd("s1"), wt);

      assert.deepEqual(await e.prompt(wt, "s2"), {});
      assert.equal(new State(e.ctx.stateRoot).sessionCwd("s2"), wt);
    } finally {
      e.cleanup();
    }
  });

  // Asserts: prompts in the cwd the session last looked at, and in another directory of the
  // same checkout, sync nothing – though that checkout has no lock and a sync would install
  // there: no lock, no item, silent; the record follows the cwd.
  test(`k149 ${harness}: prompts within the same checkout sync nothing`, async () => {
    const e = env(harness);
    try {
      localSource(e);
      e.writeJson(join(e.main, ".claude", "skilletor.json"), { install: { skills: ["foo@mine"] } });
      git(e.main, "init", "-q", "-b", "main");
      new State(e.ctx.stateRoot).putSessionCwd("s1", e.main);
      const sub = join(e.main, "src", "deep");
      mkdirSync(sub, { recursive: true });
      assert.deepEqual(await e.prompt(e.main), {});
      assert.deepEqual(await e.prompt(sub), {});
      assert.equal(new State(e.ctx.stateRoot).sessionCwd("s1"), sub);
      assert.deepEqual(await e.prompt(e.main), {});
      assert.equal(existsSync(join(e.main, ".claude", "skilletor.lock.json")), false);
      assert.equal(existsSync(join(e.main, ".agents")), false);
      assert.equal(existsSync(join(e.main, ".hermes")), false);
    } finally {
      e.cleanup();
    }
  });

  // Asserts: a prompt in a directory that is no skilletor project – a git checkout without a
  // config, a plain directory, the home dir (whose `.claude/skilletor.json` is the user config) –
  // says nothing and writes nothing there, not even a `.claude` dir; nor does input without a cwd.
  test(`k149 ${harness}: a prompt in a directory without a skilletor project is a no-op`, async () => {
    const e = env(harness);
    try {
      localSource(e);
      e.userCfg({ sources: { mine: { local: join(e.dir, "src") } }, install: { skills: ["foo@mine"] } });
      new State(e.ctx.stateRoot).putSessionCwd("s1", e.main);
      const repo = join(e.dir, "repo");
      const plain = join(e.dir, "plain");
      mkdirSync(repo);
      mkdirSync(plain);
      git(repo, "init", "-q", "-b", "main");
      for (const dir of [repo, plain, e.home]) assert.deepEqual(await e.prompt(dir), {}, dir);
      assert.equal(existsSync(join(repo, ".claude")), false);
      assert.equal(existsSync(join(plain, ".claude")), false);
      assert.equal(existsSync(join(e.ctx.hermesHome!, "skills")), false); // the user scope never syncs on a move
      assert.equal(existsSync(join(e.home, ".agents")), false);
      assert.deepEqual(await e.prompt(undefined), {});
    } finally {
      e.cleanup();
    }
  });

  // Asserts: a checkout whose project config declares its own source – untrusted – gets the one
  // line naming the checkout and the `skilletor trust` to run there, and the context; nothing is
  // fetched (no cache dir) or installed – so no Hermes trust hint either (k152); the next prompt
  // there does not say it again, and no background sync starts to say it either. Once trusted,
  // the next move into it installs.
  test(`k149 ${harness}: a prompt in a checkout with an untrusted source warns once, fetches nothing`, async () => {
    const e = env(harness);
    try {
      e.userCfg({});
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
      const other = join(e.dir, "other");
      e.writeJson(join(other, ".claude", "skilletor.json"), { sources: { team: { git: url } }, install: { skills: ["foo@team"] } });
      git(other, "init", "-q", "-b", "main");
      new State(e.ctx.stateRoot).putSessionCwd("s1", e.main);

      const out = await e.prompt(other);
      assert.equal(out.systemMessage, `skilletor: 1 warning(s) in ${other} — run there: skilletor trust team`);
      const context = out.hookSpecificOutput?.additionalContext?.split("\n") ?? [];
      assert.equal(context[0], `skilletor: in ${other}:`);
      assert.match(context.slice(1).join("\n"), /skilletor trust team/);
      assert.equal(existsSync(join(e.ctx.stateRoot, "cache")), false);
      assert.equal(existsSync(e.skillAt(other, "foo")), false);
      assert.equal(existsSync(join(other, ".claude", "skilletor.lock.json")), false);
      assert.deepEqual(await e.prompt(other), {});
      assert.deepEqual(e.background, []);

      new State(e.ctx.stateRoot).trust("team", { kind: "git", address: url });
      assert.deepEqual(await e.prompt(e.main), {});
      const trusted = await e.prompt(other);
      assert.match(trusted.systemMessage ?? "", new RegExp(`^skilletor: 1 item\\(s\\) updated, .* in ${escaped(other + trustLine(harness, other))}$`));
      assert.equal(readFileSync(e.skillAt(other, "foo"), "utf8"), SKILL("foo"));
    } finally {
      e.cleanup();
    }
  });

  // Asserts: the checkout a prompt moved into is due for the interval check (never checked),
  // yet the prompt starts no background sync of it beside its own – the move marked it checked.
  // A move that only finds the lock matching marks nothing: the interval check runs as before
  // (the control). The pending report waiting for a checkout and the move's answer come as one
  // answer: both lines, and both in the context – the report's line standing in for its missing
  // context, since the Hermes plugin hands the model the context alone.
  test(`k149 ${harness}: one sync per move – none in the background beside it; a pending report joins its answer`, async () => {
    const e = env(harness);
    try {
      const wt = await mainWithWorktree(e);
      const state = new State(e.ctx.stateRoot);
      assert.equal(state.isDue(wt, 600), true);
      state.putPendingReport(wt, { systemMessage: "skilletor: cannot reach source x" });

      const out = await e.prompt(wt);
      assert.deepEqual(e.background, []);
      assert.equal(state.isDue(wt, 600), false);
      assert.equal(out.systemMessage, `skilletor: cannot reach source x; skilletor: 1 item(s) updated in ${wt}${trustLine(harness, wt)}`);
      assert.deepEqual(out.hookSpecificOutput?.additionalContext?.split("\n"), [
        "skilletor: cannot reach source x",
        `skilletor: in ${wt}:`,
        "skilletor synced items:",
        `- skill foo@mine (${harness}): ${ACTIVE[harness]}`,
        ...trustContext(harness, wt),
      ]);
      assert.equal(state.takePendingReport(wt), undefined);

      // Control: back to main and into wt again, its mark gone – the lock matches, so the move
      // says nothing and the interval check starts its background sync.
      state.clearChecked(wt);
      assert.deepEqual(await e.prompt(e.main), {});
      assert.deepEqual(await e.prompt(wt), {});
      assert.deepEqual(e.background, [wt]);
    } finally {
      e.cleanup();
    }
  });
}

// Asserts (k152): under Hermes the trust hint comes with a move that added or updated a skill
// Hermes loads from that checkout – its own copy, or the Codex copy in `.agents/skills` it reads
// instead while `codex` is a target too – and with nothing else: a move that installed only a
// Claude Code agent (Hermes gets none) or only removed a skill syncs and says so, without it.
test("k152 hermes: the trust hint comes with a skill Hermes loads, not with an agent or a removal", async () => {
  const e = env("hermes");
  try {
    const src = join(e.dir, "src");
    mkdirSync(join(src, "skills", "foo"), { recursive: true });
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "skills", "foo", "SKILL.md"), SKILL("foo"));
    writeFileSync(join(src, "agents", "bar.md"), "---\ndescription: bar\n---\nBODY\n");
    const sources = { mine: { local: src } };
    const checkout = (name: string, install: Record<string, string[]>) => {
      const dir = join(e.dir, name);
      e.writeJson(join(dir, ".claude", "skilletor.json"), { install });
      git(dir, "init", "-q", "-b", "main");
      return dir;
    };
    new State(e.ctx.stateRoot).putSessionCwd("s1", e.main);

    e.userCfg({ targets: ["codex", "hermes"], sources });
    const viaCodex = checkout("via-codex", { skills: ["foo@mine"] });
    const codexCopy = await e.prompt(viaCodex);
    assert.equal(existsSync(join(viaCodex, ".agents", "skills", "foo", "SKILL.md")), true);
    assert.equal(existsSync(join(viaCodex, ".hermes")), false);
    assert.equal(
      codexCopy.systemMessage,
      `skilletor: 1 item(s) updated, .claude/.gitignore, .worktreeinclude updated — commit them in ${viaCodex}${trustLine("hermes", viaCodex)}`,
    );
    assert.deepEqual(codexCopy.hookSpecificOutput?.additionalContext?.split("\n"), [
      `skilletor: in ${viaCodex}:`,
      "skilletor synced items:",
      `- skill foo@mine (codex): ${ACTIVE.codex}`,
      "- .claude/.gitignore updated — commit it",
      "- .worktreeinclude updated — commit it",
      ...trustContext("hermes", viaCodex),
    ]);

    e.userCfg({ targets: ["claude", "hermes"], sources });
    const agentOnly = checkout("agent-only", { agents: ["bar@mine"] });
    const agent = await e.prompt(agentOnly);
    assert.equal(existsSync(join(agentOnly, ".claude", "agents", ".local.bar.md")), true);
    assert.match(agent.systemMessage ?? "", /^skilletor: 1 item\(s\) updated\b/);
    assert.doesNotMatch(JSON.stringify(agent), /hermes skills trust/);

    e.userCfg({ targets: ["hermes"], sources });
    const removal = checkout("removal", { skills: ["foo@mine"] });
    assert.match((await e.prompt(removal)).systemMessage ?? "", /hermes skills trust/);
    e.writeJson(join(removal, ".claude", "skilletor.json"), { install: {} });
    assert.deepEqual(await e.prompt(e.main), {});
    assert.deepEqual(await e.prompt(removal), { systemMessage: `skilletor: 1 removed in ${removal}` });
    assert.equal(existsSync(e.skillAt(removal, "foo")), false);
  } finally {
    e.cleanup();
  }
});

// Asserts (k152): the hint follows the harness whose hook runs, not the targets – with `hermes`
// the only target, Claude Code's move hooks sync the Hermes copy into a worktree and answer as
// before, without it: PostToolUse with line and context, CwdChanged with the line alone.
test("k152: Claude Code's move hooks name no Hermes trust, even with Hermes a target", async () => {
  const e = env("hermes");
  try {
    const wt = await mainWithWorktree(e);
    const claude: HookContext = { ...e.ctx, harness: undefined };
    const bash = { cwd: wt, session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash" };
    assert.deepEqual(await runHook("post-tool-use", bash, claude), {
      systemMessage: `skilletor: 1 item(s) updated in ${wt}`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `skilletor: in ${wt}:\nskilletor synced items:\n- skill foo@mine (hermes): ${ACTIVE.hermes}`,
      },
    });
    assert.equal(readFileSync(e.skillAt(wt, "foo"), "utf8"), SKILL("foo"));

    const wt2 = join(e.main, ".claude", "worktrees", "second");
    git(e.main, "worktree", "add", "-q", "-b", "second", wt2);
    const moved = { cwd: wt, old_cwd: wt, new_cwd: wt2, hook_event_name: "CwdChanged" };
    assert.deepEqual(await runHook("cwd-changed", moved, claude), { systemMessage: `skilletor: 1 item(s) updated in ${wt2}` });
    assert.equal(readFileSync(e.skillAt(wt2, "foo"), "utf8"), SKILL("foo"));
  } finally {
    e.cleanup();
  }
});

// Asserts: the record keeps the 256 sessions written last – the one just written always among
// them – and is not rewritten for a cwd it already holds.
test("k149: the session-cwd record keeps the sessions written last", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(join(tmp.dir, "state"));
    const file = join(tmp.dir, "state", "session-cwd.json");
    const all = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`old${i}`, { cwd: `/d${i}`, at: 1000 + i }]));
    writeFileSync(file, JSON.stringify({ ...all, broken: "x", alsoBroken: { cwd: 7 } }));
    state.putSessionCwd("new", "/here");
    const kept = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(Object.keys(kept).length, 256);
    assert.equal(state.sessionCwd("new"), "/here");
    assert.equal(state.sessionCwd("old299"), "/d299");
    assert.equal(state.sessionCwd("old44"), undefined); // the 45 oldest and the malformed ones went
    assert.equal(state.sessionCwd("old0"), undefined);
    assert.equal(state.sessionCwd("old45"), "/d45");
    assert.equal(state.sessionCwd("broken"), undefined);
    const before = readFileSync(file, "utf8");
    state.putSessionCwd("new", "/here");
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    tmp.cleanup();
  }
});
