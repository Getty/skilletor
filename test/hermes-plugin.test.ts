// The Hermes plugin, hermes/skilletor (spec §16.4), outside Hermes: the adapter in front of a
// stand-in for the skilletor CLI – a shell script that logs what it is called with and prints
// what a test tells it to. Driven through test/helpers/hermes_plugin_driver.py by the system
// python3; skipped without one. What real Hermes makes of the plugin: test/hermes-real.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { readySlot } from "./helpers/gettybun.ts";
import { MOVE_DEADLINE_MS } from "../src/hooks.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(root, "hermes", "skilletor");
const DRIVER = join(root, "test", "helpers", "hermes_plugin_driver.py");
const python = spawnSync("python3", ["--version"]).status === 0;
// The stand-in is a sh script, which Windows does not start; the Windows starter line is chosen by
// find_cli(…, windows=True), tested here.
const skip = process.platform === "win32" ? "the stand-in CLI is a sh script" : python ? false : "no python3";

/** The stand-in: logs argv, stdin (per event) and its environment beside itself, then does
 *  what the files beside it say – `<script>.<event>` is its answer to that event. */
const STANDIN = [
  "#!/bin/sh",
  "printf '%s\\n' \"$*\" >> \"$0.argv\"",
  "cat > \"$0.stdin.$2\"",
  "{ cat \"$0.stdin.$2\"; echo; } >> \"$0.stdins\"",
  "env > \"$0.env\"",
  "printf '%s' \"$$\" > \"$0.pid\"",
  "pwd > \"$0.pwd\"",
  "[ -f \"$0.sleep\" ] && sleep \"$(cat \"$0.sleep\")\"",
  "[ -f \"$0.$2\" ] && cat \"$0.$2\"",
  "[ -f \"$0.exit\" ] && exit \"$(cat \"$0.exit\")\"",
  "exit 0",
  "",
].join("\n");

const answer = (context?: string, line?: string, event = "SessionStart") => JSON.stringify({
  ...(line === undefined ? {} : { systemMessage: line }),
  hookSpecificOutput: { hookEventName: event, ...(context === undefined ? {} : { additionalContext: context }) },
});

function fixture() {
  const tmp = makeTmpDir("skilletor-hermes-plugin-");
  const bin = join(tmp.dir, "skilletor-standin");
  const cwd = join(tmp.dir, "work");
  mkdirSync(cwd);
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const says = (what: string, text: string) => writeFileSync(`${bin}.${what}`, text);
  const read = (what: string) => (existsSync(`${bin}.${what}`) ? readFileSync(`${bin}.${what}`, "utf8") : undefined);
  const calls = () => (read("argv") ?? "").split("\n").filter(Boolean);
  const environ = { PATH: process.env.PATH ?? "", HOME: tmp.dir, SKILLETOR_BIN: bin } as Record<string, string>;
  return { tmp, bin, cwd, says, read, calls, environ, cleanup: () => tmp.cleanup() };
}

interface Job {
  mode: "register" | "adapter";
  plugin?: string;
  environ?: Record<string, string>;
  home?: string | null;
  cwd?: string;
  limits?: { session_start_s?: number; prompt_s?: number; ensure_s?: number };
  steps?: [string, Record<string, unknown>][];
  windows?: boolean;
  no_killpg?: boolean;
}

function drive(job: Job) {
  // -B: no __pycache__ beside the plugin in this checkout.
  const r = spawnSync("python3", ["-B", DRIVER], {
    input: JSON.stringify({ plugin: PLUGIN, ...job }), encoding: "utf8", env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as {
    hooks: Record<string, boolean[]>; cli: unknown; hooks_without_cli: string[]; limits: number[];
    results: { ret?: unknown; raised?: string; took: number }[]; sessions: number; kept: number;
  };
}

const START = (id = "s1", more: Record<string, unknown> = {}): [string, Record<string, unknown>] =>
  ["on_session_start", { session_id: id, model: "m", platform: "cli", telemetry_schema_version: 1, ...more }];
const TURN = (id = "s1", more: Record<string, unknown> = {}): [string, Record<string, unknown>] => ["pre_llm_call", {
  session_id: id, task_id: "t1", turn_id: "turn1", user_message: "hi", conversation_history: [], is_first_turn: true,
  model: "m", platform: "cli", parent_session_id: "", sender_id: "", telemetry_schema_version: 1, ...more,
}];

test("register: the two hooks the manifest declares, each taking **kwargs; a CLI command; nothing started", { skip }, () => {
  const out = drive({ mode: "register" });
  assert.deepEqual(out.hooks, { on_session_start: [true], pre_llm_call: [true] });
  const manifest = readFileSync(join(PLUGIN, "plugin.yaml"), "utf8");
  assert.deepEqual([...manifest.matchAll(/^ {2}- (\w+)$/gm)].map((m) => m[1]), Object.keys(out.hooks));
  assert.deepEqual(Object.keys(out.cli as object), ["skilletor"]);
  // A Hermes without register_cli_command still gets the hooks.
  assert.deepEqual(out.hooks_without_cli, ["on_session_start", "pre_llm_call"]);
  // Below Hermes' own limit for a hook callback (plugins.hook_callback_timeout, 30 s).
  assert.ok(out.limits.every((s) => s > 0 && s < 30), String(out.limits));
  // k149: a prompt that moved into another checkout syncs it, awaited; past MOVE_DEADLINE_MS
  // that sync writes nothing, so the plugin's own kill must come later, never during a write.
  assert.ok(out.limits[1]! * 1000 > MOVE_DEADLINE_MS, String(out.limits));
});

test("the plugin carries the package's version", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const manifest = readFileSync(join(PLUGIN, "plugin.yaml"), "utf8");
  assert.match(manifest, /^name: skilletor$/m);
  assert.equal(/^version: "(.+)"$/m.exec(manifest)?.[1], pkg.version);
});

test("a session start runs session-start; its context goes to the model with the first turn", { skip }, () => {
  const f = fixture();
  try {
    f.says("session-start", answer("skilletor synced items:\n- skill foo@mine (hermes): active from the next Hermes session",
      "skilletor: 1 item(s) updated"));
    f.says("user-prompt-submit", answer("- warning: late", "skilletor: 1 warning(s)", "UserPromptSubmit"));
    const out = drive({
      mode: "adapter", environ: f.environ, home: "/srv/hermes-home", cwd: f.cwd,
      steps: [START(), TURN(), TURN("s1", { is_first_turn: false }), TURN("s1", { is_first_turn: false })],
    });
    const [start, first, second, third] = out.results;
    assert.equal(start!.ret, null); // Hermes ignores it anyway
    assert.deepEqual(first!.ret,
      { context: "skilletor synced items:\n- skill foo@mine (hermes): active from the next Hermes session" });
    // Later turns are prompts: the report of a background sync, when there is one.
    assert.deepEqual(second!.ret, { context: "- warning: late" });
    assert.deepEqual(third!.ret, { context: "- warning: late" });
    assert.deepEqual(f.calls(), [
      "hook session-start hermes",
      "hook user-prompt-submit hermes",
      "hook user-prompt-submit hermes",
    ]);
    assert.deepEqual(JSON.parse(f.read("stdin.session-start")!),
      { hook_event_name: "SessionStart", session_id: "s1", cwd: f.cwd, source: "startup" });
    assert.deepEqual(JSON.parse(f.read("stdin.user-prompt-submit")!),
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: f.cwd });
    assert.match(f.read("env")!, /^HERMES_HOME=\/srv\/hermes-home$/m);
    assert.equal(realpathSync(f.read("pwd")!.trim()), realpathSync(f.cwd)); // the child runs where the session works
    assert.equal(out.kept, 0);
  } finally {
    f.cleanup();
  }
});

// k149 (spec §16.4): Hermes moves a session only between turns (`/worktree new`, a gateway's
// re-anchor), and the next pre_llm_call is the first hook to see it. Asserts: each turn's
// user-prompt-submit is sent the cwd the session resolves at that turn – the child runs there –
// and the move's answer from the CLI reaches the model as the turn's context.
test("a session that moved between turns: the next turn's prompt hook is sent the new cwd, its answer reaches the model", { skip }, () => {
  const f = fixture();
  try {
    const wt = join(f.tmp.dir, "worktree");
    mkdirSync(wt);
    const moved = `skilletor: in ${wt}:\nskilletor synced items:\n- skill foo@mine (hermes): active from the next Hermes session`;
    f.says("user-prompt-submit", answer(moved, `skilletor: 1 item(s) updated in ${wt}`, "UserPromptSubmit"));
    const out = drive({
      mode: "adapter", environ: f.environ, cwd: f.cwd,
      steps: [START(), TURN(), ["_cd", { cwd: wt }], TURN("s1", { is_first_turn: false })],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null, { context: moved }]);
    assert.deepEqual(f.read("stdins")!.trim().split("\n").map((line) => JSON.parse(line)), [
      { hook_event_name: "SessionStart", session_id: "s1", cwd: f.cwd, source: "startup" },
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: wt },
    ]);
    assert.equal(realpathSync(f.read("pwd")!.trim()), realpathSync(wt));
  } finally {
    f.cleanup();
  }
});

test("nothing to say: no context, on the first turn and after", { skip }, () => {
  const f = fixture();
  try {
    const out = drive({ mode: "adapter", environ: f.environ, cwd: f.cwd, steps: [START(), TURN(), TURN()] });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null]);
    assert.deepEqual(f.calls(), ["hook session-start hermes", "hook user-prompt-submit hermes"]);
    // No home known: the child keeps the environment it has.
    assert.doesNotMatch(f.read("env")!, /^HERMES_HOME=/m);
  } finally {
    f.cleanup();
  }
});

test("a systemMessage alone – a config error, a warning line – is what the model gets", { skip }, () => {
  const f = fixture();
  try {
    f.says("session-start", JSON.stringify({ systemMessage: "skilletor: ~/.claude/skilletor.json: unknown key \"x\"" }));
    const out = drive({ mode: "adapter", environ: f.environ, cwd: f.cwd, steps: [START(), TURN()] });
    assert.deepEqual(out.results[1]!.ret, { context: "skilletor: ~/.claude/skilletor.json: unknown key \"x\"" });
  } finally {
    f.cleanup();
  }
});

test("a resumed session fires no on_session_start: its first turn here runs session-start as a resume", { skip }, () => {
  const f = fixture();
  try {
    f.says("session-start", answer("synced"));
    const out = drive({
      mode: "adapter", environ: f.environ, cwd: f.cwd,
      steps: [TURN("old", { is_first_turn: false }), TURN("old", { is_first_turn: false })],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [{ context: "synced" }, null]);
    assert.deepEqual(f.calls(), ["hook session-start hermes", "hook user-prompt-submit hermes"]);
    assert.equal(JSON.parse(f.read("stdin.session-start")!).source, "resume");
  } finally {
    f.cleanup();
  }
});

test("a delegated child is no session of the user's: nothing runs for it", { skip }, () => {
  const f = fixture();
  try {
    f.says("session-start", answer("synced"));
    const out = drive({
      mode: "adapter", environ: f.environ, cwd: f.cwd,
      steps: [
        START("child", { platform: "subagent" }), TURN("child", { platform: "subagent", parent_session_id: "s1" }),
        TURN("child2", { parent_session_id: "s1" }),
      ],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null]);
    assert.deepEqual(f.calls(), []);
    assert.equal(out.sessions, 0);
  } finally {
    f.cleanup();
  }
});

test("each session gets its own start and its own message", { skip }, () => {
  const f = fixture();
  try {
    f.says("session-start", answer("synced"));
    const out = drive({
      mode: "adapter", environ: f.environ, cwd: f.cwd, steps: [START("a"), START("b"), START("a"), TURN("b"), TURN("a")],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null, { context: "synced" }, { context: "synced" }]);
    assert.deepEqual(f.calls(), ["hook session-start hermes", "hook session-start hermes"]);
  } finally {
    f.cleanup();
  }
});

test("the project of a surrounding Claude Code session is not handed to the hook", { skip }, () => {
  const f = fixture();
  try {
    const environ = { ...f.environ, CLAUDE_PROJECT_DIR: "/elsewhere", SKILLETOR_PROJECT_DIR: "/elsewhere", KEEP: "1" };
    drive({ mode: "adapter", environ, cwd: f.cwd, steps: [START()] });
    const env = f.read("env")!;
    assert.doesNotMatch(env, /^(CLAUDE|SKILLETOR)_PROJECT_DIR=/m);
    assert.match(env, /^KEEP=1$/m);
  } finally {
    f.cleanup();
  }
});

test("fail open: no CLI, one that fails, one that prints no JSON object – the turn runs without a message", { skip }, () => {
  const f = fixture();
  try {
    const steps = [START(), TURN(), TURN()];
    const quiet = (out: ReturnType<typeof drive>, why: string) =>
      assert.deepEqual(out.results.map((r) => ("raised" in r ? r.raised : r.ret)), [null, null, null], why);

    // $SKILLETOR_BIN names nothing runnable: that or nothing, never another one from PATH.
    for (const bin of [join(f.tmp.dir, "missing"), f.cwd]) {
      const out = drive({ mode: "adapter", environ: { ...f.environ, SKILLETOR_BIN: bin }, cwd: f.cwd, steps });
      quiet(out, bin);
      assert.equal(out.cli, null);
    }
    // No CLI anywhere: an empty PATH, a plugin directory that is no checkout's.
    const lone = join(f.tmp.dir, "plugins", "skilletor");
    mkdirSync(lone, { recursive: true });
    writeFileSync(join(lone, "__init__.py"), readFileSync(join(PLUGIN, "__init__.py")));
    quiet(drive({ mode: "adapter", plugin: lone, environ: { PATH: join(f.tmp.dir, "empty"), HOME: f.tmp.dir }, cwd: f.cwd, steps }), "none");
    assert.deepEqual(f.calls(), []);

    f.says("session-start", answer("never shown"));
    f.says("user-prompt-submit", answer("never shown"));
    f.says("exit", "3");
    quiet(drive({ mode: "adapter", environ: f.environ, cwd: f.cwd, steps }), "exit 3");
    f.says("exit", "0");
    for (const garbage of ["not json", "[1, 2]", "\"text\"", "{\"hookSpecificOutput\": 7}", "{\"systemMessage\": 7}"]) {
      f.says("session-start", garbage);
      f.says("user-prompt-submit", garbage);
      quiet(drive({ mode: "adapter", environ: f.environ, cwd: f.cwd, steps }), garbage);
    }
    // A session whose working directory is gone still runs the hook.
    f.says("session-start", answer("synced"));
    const gone = drive({ mode: "adapter", environ: f.environ, cwd: join(f.tmp.dir, "gone"), steps: [START(), TURN()] });
    assert.deepEqual(gone.results[1]!.ret, { context: "synced" });
    assert.equal(f.read("pwd")!.trim(), "/");
  } finally {
    f.cleanup();
  }
});

test("fail open: a CLI that hangs is killed at the plugin's own limit, well before Hermes' 30 s", { skip }, () => {
  const f = fixture();
  try {
    f.says("sleep", "30");
    f.says("session-start", answer("never shown"));
    const out = drive({
      mode: "adapter", environ: f.environ, cwd: f.cwd, limits: { session_start_s: 0.4, prompt_s: 0.4 },
      steps: [START(), TURN(), TURN()],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null]);
    for (const r of [out.results[0]!, out.results[2]!]) assert.ok(r.took >= 0.4 && r.took < 5, `took ${r.took}`);
    // The child is gone, not left sleeping.
    const pid = Number(f.read("pid"));
    assert.ok(pid > 1);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    f.cleanup();
  }
});

test("fail open where os.killpg is missing (Windows): a CLI that hangs is still killed at the limit", { skip }, () => {
  const f = fixture();
  try {
    f.says("sleep", "30");
    f.says("session-start", answer("never shown"));
    const out = drive({
      mode: "adapter", environ: f.environ, cwd: f.cwd, limits: { session_start_s: 0.4, prompt_s: 0.4 },
      no_killpg: true, steps: [START(), TURN()],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null]);
    assert.ok(out.results[0]!.took >= 0.4 && out.results[0]!.took < 5, `took ${out.results[0]!.took}`);
    const pid = Number(f.read("pid"));
    assert.ok(pid > 1);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    f.cleanup();
  }
});

const POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

/** A stand-in for the getty-bun starter: logs each call beside itself; `ensure` writes its pid,
 *  sleeps and exits as the files beside it say; `run <entry> …` answers a hook with what it was
 *  called with as the context. */
const FAKE_STARTER = [
  "#!/bin/sh",
  "d=${0%/*}",
  "printf '%s\\n' \"$*\" >> \"$d/log\"",
  "case $1 in",
  "  ensure)",
  "    printf '%s' \"$$\" > \"$d/ensure.pid\"",
  "    [ -f \"$d/ensure.sleep\" ] && sleep \"$(cat \"$d/ensure.sleep\")\"",
  "    if [ -f \"$d/ensure.exit\" ]; then echo 'getty-bun: a test failure' >&2; exit \"$(cat \"$d/ensure.exit\")\"; fi",
  "    exit 0 ;;",
  "  run)",
  "    shift 2",
  "    cat > /dev/null",
  "    printf '{\"hookSpecificOutput\":{\"additionalContext\":\"%s\"}}\\n' \"$*\" ;;",
  "esac",
  "",
].join("\n");

/** A checkout of its own with this one's plugin, a bundle, and in bootstrap/ the stand-in
 *  starter (or with `real`, this checkout's getty-bun.sh); `files` beside the starter. */
function starterCheckout(f: ReturnType<typeof fixture>, opts: { real?: boolean; dist?: boolean; ps1?: boolean } = {}) {
  const checkout = join(f.tmp.dir, "starter checkout");
  const plugin = join(checkout, "hermes", "skilletor");
  const boot = join(checkout, "bootstrap");
  mkdirSync(plugin, { recursive: true });
  mkdirSync(boot);
  writeFileSync(join(plugin, "__init__.py"), readFileSync(join(PLUGIN, "__init__.py")));
  writeFileSync(join(boot, "getty-bun.sh"), opts.real ? readFileSync(join(root, "bootstrap", "getty-bun.sh")) : FAKE_STARTER);
  if (opts.ps1) writeFileSync(join(boot, "getty-bun.ps1"), "");
  if (opts.dist !== false) {
    mkdirSync(join(checkout, "dist"));
    writeFileSync(join(checkout, "dist", "skilletor.js"), [
      'require("node:fs").readFileSync(0);',
      'const context = `bun ${process.argv.slice(2).join(" ")}`;',
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: context } }) + \"\\n\");",
      "",
    ].join("\n"));
  }
  const log = () => (existsSync(join(boot, "log")) ? readFileSync(join(boot, "log"), "utf8").split("\n").filter(Boolean) : []);
  const file = (name: string) => join(boot, name);
  return { checkout, plugin, boot, log, file, environ: { PATH: process.env.PATH ?? "", HOME: f.tmp.dir } as Record<string, string> };
}

const RUN = "run dist/skilletor.js hook";

// k281 (F6): the starter installs Bun on its first call, which may take minutes; Hermes abandons a
// hook callback after 30 s. So the adapter runs the starter's `ensure` once, in the background,
// before the first hook, and every hook stays within its own limit.
test("through the checkout's starter: ensure once, in the background, then each hook with the host as an argument", { skip }, () => {
  const f = fixture();
  try {
    const c = starterCheckout(f);
    const out = drive({
      mode: "adapter", plugin: c.plugin, environ: c.environ, cwd: f.cwd,
      steps: [START(), TURN(), TURN("s1", { is_first_turn: false }), START("b"), TURN("b")],
    });
    const cli = out.cli as string[];
    assert.deepEqual([cli[0], realpathSync(cli[1]!), ...cli.slice(2)], ["sh", realpathSync(join(c.boot, "getty-bun.sh")), "run", "dist/skilletor.js"]);
    assert.deepEqual(out.results.map((r) => r.ret), [
      null, { context: "hook session-start hermes" }, { context: "hook user-prompt-submit hermes" },
      null, { context: "hook session-start hermes" },
    ]);
    assert.deepEqual(c.log(), ["ensure", `${RUN} session-start hermes`, `${RUN} user-prompt-submit hermes`, `${RUN} session-start hermes`]);
  } finally {
    f.cleanup();
  }
});

test("an ensure slower than a hook's limit: the hook is skipped at its limit, the install goes on, a later hook runs", { skip }, () => {
  const f = fixture();
  try {
    const c = starterCheckout(f);
    writeFileSync(c.file("ensure.sleep"), "1.5");
    const out = drive({
      mode: "adapter", plugin: c.plugin, environ: c.environ, cwd: f.cwd, limits: { session_start_s: 0.4, prompt_s: 0.4 },
      steps: [START(), TURN(), ["_sleep", { s: 1.5 }], TURN("s1", { is_first_turn: false })],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null, { context: "hook user-prompt-submit hermes" }]);
    assert.ok(out.results[0]!.took >= 0.4 && out.results[0]!.took < 1.2, `took ${out.results[0]!.took}`);
    assert.deepEqual(c.log(), ["ensure", `${RUN} user-prompt-submit hermes`]);
  } finally {
    f.cleanup();
  }
});

test("a failed ensure skips the hooks; the next session start tries it again", { skip }, () => {
  const f = fixture();
  try {
    const c = starterCheckout(f);
    writeFileSync(c.file("ensure.exit"), "1");
    const out = drive({
      mode: "adapter", plugin: c.plugin, environ: c.environ, cwd: f.cwd,
      steps: [
        START(), TURN(), TURN("s1", { is_first_turn: false }), ["_rm", { path: c.file("ensure.exit") }],
        TURN("s1", { is_first_turn: false }), START("b"), TURN("b"),
      ],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null, null, null, null, { context: "hook session-start hermes" }]);
    assert.deepEqual(c.log(), ["ensure", "ensure", `${RUN} session-start hermes`]);
  } finally {
    f.cleanup();
  }
});

test("an ensure that outlives its own limit is killed with its process group; the hooks are skipped", { skip }, () => {
  const f = fixture();
  try {
    const c = starterCheckout(f);
    writeFileSync(c.file("ensure.sleep"), "30");
    const out = drive({
      mode: "adapter", plugin: c.plugin, environ: c.environ, cwd: f.cwd,
      limits: { session_start_s: 3, prompt_s: 3, ensure_s: 0.5 }, steps: [START(), TURN()],
    });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null]);
    assert.ok(out.results[0]!.took >= 0.5 && out.results[0]!.took < 2.5, `took ${out.results[0]!.took}`);
    const pid = Number(readFileSync(c.file("ensure.pid"), "utf8"));
    assert.ok(pid > 1);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.deepEqual(c.log(), ["ensure"]);
  } finally {
    f.cleanup();
  }
});

test("on Windows the checkout's CLI is the PowerShell starter, only beside dist/", { skip }, () => {
  const f = fixture();
  try {
    const c = starterCheckout(f, { ps1: true });
    const environ = { PATH: join(f.tmp.dir, "empty"), HOME: f.tmp.dir };
    const cli = drive({ mode: "adapter", plugin: c.plugin, environ, windows: true, steps: [] }).cli as string[];
    assert.deepEqual(cli.slice(0, POWERSHELL.length), POWERSHELL);
    assert.equal(realpathSync(cli[POWERSHELL.length]!), realpathSync(join(c.boot, "getty-bun.ps1")));
    assert.deepEqual(cli.slice(POWERSHELL.length + 1), ["run", "dist/skilletor.js"]);
    rmSync(join(c.checkout, "dist", "skilletor.js"));
    assert.equal(drive({ mode: "adapter", plugin: c.plugin, environ, windows: true, steps: [] }).cli, null);
    assert.equal(drive({ mode: "adapter", plugin: c.plugin, environ, windows: false, steps: [] }).cli, null);
  } finally {
    f.cleanup();
  }
});

test("through the real starter with a ready Bun: the bundle's answer reaches the model", { skip }, () => {
  const f = fixture();
  try {
    const c = starterCheckout(f, { real: true });
    const environ = { ...c.environ, ...readySlot(join(f.tmp.dir, "getty home")) } as Record<string, string>;
    const steps = [START(), TURN(), TURN("s1", { is_first_turn: false })];
    const out = drive({ mode: "adapter", plugin: c.plugin, environ, cwd: f.cwd, steps });
    assert.deepEqual(out.results.map((r) => r.ret), [
      null,
      { context: "bun hook session-start hermes" },
      { context: "bun hook user-prompt-submit hermes" },
    ]);
  } finally {
    f.cleanup();
  }
});

test("the CLI: $SKILLETOR_BIN, else the checkout the plugin is linked into, else PATH", { skip }, () => {
  const f = fixture();
  try {
    const base = { PATH: process.env.PATH ?? "", HOME: f.tmp.dir };
    // Linked: this checkout's starter and bundle (both committed).
    const linked = join(f.tmp.dir, "linked");
    symlinkSync(PLUGIN, linked);
    assert.deepEqual(drive({ mode: "adapter", plugin: linked, environ: base, windows: false, steps: [] }).cli,
      ["sh", join(root, "bootstrap", "getty-bun.sh"), "run", "dist/skilletor.js"]);
    assert.deepEqual(drive({ mode: "adapter", plugin: linked, environ: f.environ, steps: [] }).cli, [f.bin]);
    // Copied: no checkout around it, so PATH.
    const copied = join(f.tmp.dir, "plugins", "skilletor");
    mkdirSync(copied, { recursive: true });
    writeFileSync(join(copied, "__init__.py"), readFileSync(join(PLUGIN, "__init__.py")));
    const onPath = join(f.tmp.dir, "onpath");
    mkdirSync(onPath);
    writeFileSync(join(onPath, "skilletor"), STANDIN);
    chmodSync(join(onPath, "skilletor"), 0o755);
    assert.deepEqual(drive({ mode: "adapter", plugin: copied, environ: { ...base, PATH: onPath }, steps: [] }).cli, [join(onPath, "skilletor")]);
    assert.equal(drive({ mode: "adapter", plugin: copied, environ: { ...base, PATH: join(f.tmp.dir, "empty") }, steps: [] }).cli, null);
  } finally {
    f.cleanup();
  }
});
