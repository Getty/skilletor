// The Hermes plugin, hermes/skilletor (spec §16.4), outside Hermes: the adapter in front of a
// stand-in for the skilletor CLI – a shell script that logs what it is called with and prints
// what a test tells it to. Driven through test/helpers/hermes_plugin_driver.py by the system
// python3; skipped without one. What real Hermes makes of the plugin: test/hermes-real.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(root, "hermes", "skilletor");
const DRIVER = join(root, "test", "helpers", "hermes_plugin_driver.py");
const python = spawnSync("python3", ["--version"]).status === 0;
// The stand-in is a sh script, which Windows does not start; the Windows launcher is chosen by
// find_cli(…, windows=True), tested here.
const skip = process.platform === "win32" ? "the stand-in CLI is a sh script" : python ? false : "no python3";

/** The stand-in: logs argv, stdin (per event) and its environment beside itself, then does
 *  what the files beside it say – `<script>.<event>` is its answer to that event. */
const STANDIN = [
  "#!/bin/sh",
  "printf '%s\\n' \"$*\" >> \"$0.argv\"",
  "cat > \"$0.stdin.$2\"",
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
  limits?: { session_start_s?: number; prompt_s?: number };
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
      "hook session-start --harness hermes",
      "hook user-prompt-submit --harness hermes",
      "hook user-prompt-submit --harness hermes",
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

test("nothing to say: no context, on the first turn and after", { skip }, () => {
  const f = fixture();
  try {
    const out = drive({ mode: "adapter", environ: f.environ, cwd: f.cwd, steps: [START(), TURN(), TURN()] });
    assert.deepEqual(out.results.map((r) => r.ret), [null, null, null]);
    assert.deepEqual(f.calls(), ["hook session-start --harness hermes", "hook user-prompt-submit --harness hermes"]);
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
    assert.deepEqual(f.calls(), ["hook session-start --harness hermes", "hook user-prompt-submit --harness hermes"]);
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
    assert.deepEqual(f.calls(), ["hook session-start --harness hermes", "hook session-start --harness hermes"]);
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

test("on Windows the checkout's CLI is bin/skilletor.exe, which runs without a shell", { skip }, () => {
  const f = fixture();
  try {
    // A checkout of its own: the plugin in it, dist/ and only the Windows launcher in bin/.
    const checkout = join(f.tmp.dir, "checkout");
    const plugin = join(checkout, "hermes", "skilletor");
    mkdirSync(plugin, { recursive: true });
    mkdirSync(join(checkout, "bin"));
    mkdirSync(join(checkout, "dist"));
    writeFileSync(join(plugin, "__init__.py"), readFileSync(join(PLUGIN, "__init__.py")));
    writeFileSync(join(checkout, "dist", "skilletor.js"), "");
    writeFileSync(join(checkout, "bin", "skilletor.exe"), "");
    chmodSync(join(checkout, "bin", "skilletor.exe"), 0o755);
    const environ = { PATH: join(f.tmp.dir, "empty"), HOME: f.tmp.dir };
    // The plugin resolves its checkout through realpath (macOS: /var is /private/var).
    const cli = drive({ mode: "adapter", plugin, environ, windows: true, steps: [] }).cli;
    assert.equal(typeof cli === "string" ? realpathSync(cli) : cli, realpathSync(join(checkout, "bin", "skilletor.exe")));
    assert.equal(drive({ mode: "adapter", plugin, environ, windows: false, steps: [] }).cli, null);
  } finally {
    f.cleanup();
  }
});

test("the CLI: $SKILLETOR_BIN, else the checkout the plugin is linked into, else PATH", { skip }, () => {
  const f = fixture();
  try {
    const base = { PATH: process.env.PATH ?? "", HOME: f.tmp.dir };
    // Linked: this checkout's bin/skilletor (dist/ is committed).
    const linked = join(f.tmp.dir, "linked");
    symlinkSync(PLUGIN, linked);
    assert.equal(drive({ mode: "adapter", plugin: linked, environ: base, steps: [] }).cli, join(root, "bin", "skilletor"));
    assert.equal(drive({ mode: "adapter", plugin: linked, environ: f.environ, steps: [] }).cli, f.bin);
    // Copied: no checkout around it, so PATH.
    const copied = join(f.tmp.dir, "plugins", "skilletor");
    mkdirSync(copied, { recursive: true });
    writeFileSync(join(copied, "__init__.py"), readFileSync(join(PLUGIN, "__init__.py")));
    const onPath = join(f.tmp.dir, "onpath");
    mkdirSync(onPath);
    writeFileSync(join(onPath, "skilletor"), STANDIN);
    chmodSync(join(onPath, "skilletor"), 0o755);
    assert.equal(drive({ mode: "adapter", plugin: copied, environ: { ...base, PATH: onPath }, steps: [] }).cli, join(onPath, "skilletor"));
    assert.equal(drive({ mode: "adapter", plugin: copied, environ: { ...base, PATH: join(f.tmp.dir, "empty") }, steps: [] }).cli, null);
  } finally {
    f.cleanup();
  }
});
