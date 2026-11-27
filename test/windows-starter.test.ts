// The Windows starter, bootstrap/getty-bun.ps1, as the plugin's Windows hosts start it (review V2):
// against a slot made ready from the Bun running the suite (readySlotWindows, nothing
// downloaded), Codex's `commandWindows` lines run verbatim through the shells Codex hands them to,
// and the Hermes adapter runs its hooks through `powershell -File`. Both reach the entry as
// `hook <event> <host>` from a plugin root with a space; the real bundle answers a session start
// with exit 0 and at most one JSON object. The process each line becomes is built by
// codexWindowsCommand and find_cli, both checked on every OS; the runs need Windows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homeEnv } from "./helpers/harness.ts";
import { codexWindowsCommand, POWERSHELL_FILE, readySlotWindows } from "./helpers/gettybun.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const windows = process.platform === "win32";
const skip = windows ? false : "getty-bun.ps1 runs on Windows only";
/** windows-latest has `python`; `python3` there may be the Store stub. */
const PYTHON = windows ? "python" : "python3";
const DRIVER = join(repo, "test", "helpers", "hermes_plugin_driver.py");

type Hook = { command: string; commandWindows?: string };
const codexHooks = JSON.parse(readFileSync(join(repo, "hooks", "codex-hooks.json"), "utf8")).hooks as Record<string, { hooks: Hook[] }[]>;
const EVENTS: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit" };

let tmp: TmpDir;
/** A plugin root with a space: the starter, the Hermes adapter, and a stub bundle that echoes
 *  its arguments, its stdin and the directory it runs in. */
let stub: string;
/** The same with this checkout's real bundle. */
let real: string;
let getty: NodeJS.ProcessEnv;

function pluginRoot(dir: string, bundle: string | Buffer): void {
  mkdirSync(join(dir, "bootstrap"), { recursive: true });
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "hermes", "skilletor"), { recursive: true });
  copyFileSync(join(repo, "bootstrap", "getty-bun.ps1"), join(dir, "bootstrap", "getty-bun.ps1"));
  copyFileSync(join(repo, "hermes", "skilletor", "__init__.py"), join(dir, "hermes", "skilletor", "__init__.py"));
  writeFileSync(join(dir, "dist", "skilletor.js"), bundle);
}

before(() => {
  if (skip) return;
  tmp = makeTmpDir();
  stub = join(tmp.dir, "my plugin");
  pluginRoot(stub, [
    'const stdin = require("node:fs").readFileSync(0, "utf8");',
    "const args = process.argv.slice(2);",
    // The Hermes adapter reads additionalContext; the Codex tests read args, stdin and cwd.
    "process.stdout.write(JSON.stringify({ args, stdin, cwd: process.cwd(), hookSpecificOutput: { additionalContext: `bun ${args.join(\" \")}` } }) + \"\\n\");",
    "",
  ].join("\n"));
  real = join(tmp.dir, "real plugin");
  pluginRoot(real, readFileSync(join(repo, "dist", "skilletor.js")));
  getty = readySlotWindows(join(tmp.dir, "getty home"));
});

after(() => tmp?.cleanup());

/** Run a Codex Windows line as Codex would under `shell`, fed `input`, from `cwd`. */
function runCodexLine(line: string, root: string, shell: "powershell" | "cmd", input: string, cwd: string, env: NodeJS.ProcessEnv) {
  const c = codexWindowsCommand(line, root, shell);
  const opts = { encoding: "utf8" as const, cwd, input, env: { ...process.env, ...env } };
  // `shell: true` on Windows is `%COMSPEC% /d /s /c "<line>"`: cmd parses the line itself.
  return "shellLine" in c ? spawnSync(c.shellLine, { ...opts, shell: true }) : spawnSync(c.file, c.args, opts);
}

// Asserts, on every OS: the process a Codex Windows line becomes – the plugin root (here with a
// space) substituted as text inside the line's own double quotes, then PowerShell's -Command or
// the line itself for cmd – so the run below executes exactly what hooks/codex-hooks.json says.
test("codexWindowsCommand substitutes the plugin root as text and hands the line on whole", () => {
  const line = codexHooks.SessionStart![0]!.hooks[0]!.commandWindows!;
  const root = "C:\\Users\\a b\\plugins\\skilletor";
  const expected = `${POWERSHELL_FILE.join(" ")} "${root}\\bootstrap\\getty-bun.ps1" run dist/skilletor.js hook session-start codex`;
  assert.deepEqual(codexWindowsCommand(line, root, "powershell"), { file: "powershell.exe", args: ["-NoProfile", "-Command", expected] });
  assert.deepEqual(codexWindowsCommand(line, root, "cmd"), { shellLine: expected });
});

// Asserts: each Codex `commandWindows` line, under PowerShell (Codex's default session shell) and
// under cmd (its fallback), runs the PowerShell starter on the ready slot, which runs the entry
// with `hook <event> codex`, the hook's JSON on its stdin and the caller's cwd: exit 0, the
// entry's one line on stdout, nothing from the starter on stderr.
test("Codex's commandWindows lines, verbatim under PowerShell and cmd, reach the entry with event and host", { skip }, () => {
  const cwd = join(tmp.dir, "session dir");
  mkdirSync(cwd, { recursive: true });
  for (const [event, groups] of Object.entries(codexHooks)) {
    const line = groups[0]!.hooks[0]!.commandWindows!;
    const input = JSON.stringify({ hook_event_name: event, session_id: "s1", cwd, ...(event === "SessionStart" ? { source: "startup" } : { prompt: "hi" }) });
    for (const shell of ["powershell", "cmd"] as const) {
      const r = runCodexLine(line, stub, shell, input, cwd, { ...homeEnv(tmp.dir), ...getty });
      const at = `${event} under ${shell}`;
      assert.equal(r.status, 0, `${at}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /getty-bun:/, at);
      const out = JSON.parse(r.stdout) as { args: string[]; stdin: string; cwd: string };
      assert.deepEqual(out.args, ["hook", EVENTS[event], "codex"], at);
      assert.equal(out.stdin, input, at);
      assert.equal(resolve(out.cwd).toLowerCase(), resolve(cwd).toLowerCase(), at);
    }
  }
});

// Asserts: behind the real bundle, a Codex session start under PowerShell exits 0 with nothing or
// one JSON object on stdout – a home without a config, so whatever skilletor says is one answer.
test("the real bundle behind Codex's session-start line exits 0 with at most one JSON object", { skip }, () => {
  const home = join(tmp.dir, "hook home");
  mkdirSync(home, { recursive: true });
  const line = codexHooks.SessionStart![0]!.hooks[0]!.commandWindows!;
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: home });
  const r = runCodexLine(line, real, "powershell", input, home, { ...homeEnv(home), CODEX_HOME: join(home, ".no-codex"), ...getty });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /getty-bun:/);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  assert.ok(lines.length <= 1, r.stdout);
  if (lines.length === 1) assert.equal(typeof JSON.parse(lines[0]!), "object");
});

// Asserts: the Hermes adapter on Windows finds the checkout's PowerShell starter (find_cli), runs
// its `ensure` through `powershell -File` on the ready slot, then each hook through the same line:
// the session start's answer reaches the first turn, a later turn gets its prompt hook's answer.
test("the Hermes adapter on Windows runs its hooks through powershell -File and the ready slot", { skip }, () => {
  const cwd = join(tmp.dir, "hermes work");
  mkdirSync(cwd, { recursive: true });
  const environ = { ...process.env, ...homeEnv(tmp.dir), ...getty } as Record<string, string>;
  delete environ.SKILLETOR_BIN;
  const plugin = join(stub, "hermes", "skilletor");
  const session = { session_id: "s1", model: "m", platform: "cli", telemetry_schema_version: 1 };
  const turn = (first: boolean) => ({ ...session, task_id: "t1", turn_id: "turn1", user_message: "hi", conversation_history: [],
    is_first_turn: first, parent_session_id: "", sender_id: "" });
  const job = {
    mode: "adapter", plugin, environ, cwd,
    steps: [["on_session_start", session], ["pre_llm_call", turn(true)], ["pre_llm_call", turn(false)]],
  };
  // -B: no __pycache__ beside the plugin; the driver's own environment is the runner's (Python on
  // Windows needs SYSTEMROOT).
  const r = spawnSync(PYTHON, ["-B", DRIVER], { input: JSON.stringify(job), encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { cli: string[]; results: { ret?: unknown; raised?: string }[] };
  assert.deepEqual(out.cli.slice(0, POWERSHELL_FILE.length), POWERSHELL_FILE);
  assert.equal(resolve(out.cli[POWERSHELL_FILE.length]!).toLowerCase(), resolve(stub, "bootstrap", "getty-bun.ps1").toLowerCase());
  assert.deepEqual(out.cli.slice(POWERSHELL_FILE.length + 1), ["run", "dist/skilletor.js"]);
  assert.deepEqual(out.results.map((x) => ("raised" in x ? x.raised : x.ret)), [
    null,
    { context: "bun hook session-start hermes" },
    { context: "bun hook user-prompt-submit hermes" },
  ]);
});
