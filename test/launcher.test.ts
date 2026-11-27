// The sh launcher bin/skilletor and the plugin's hook lines on the getty-bun starter (k281).
// bin/skilletor, reached through a symlink – one on PATH, a global package install – still finds
// the checkout it belongs to (k139), and runs dist/skilletor.js there through
// bootstrap/getty-bun.sh with every argument, options included (F4). The hook lines of
// hooks/hooks.json and hooks/codex-hooks.json, run as each host spells them, reach the entry as
// `hook <event> <host>`, also from a plugin root with a space (k244). Every run uses a GETTY_HOME
// of the test's own with a ready slot (test/helpers/gettybun.ts): nothing is downloaded.
// POSIX only: Windows has no sh launcher, and its Claude Code path is open (F2).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homeEnv } from "./helpers/harness.ts";
import { gettyEnv, readySlot } from "./helpers/gettybun.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const skip = process.platform === "win32" ? "the sh launcher and the sh starter do not run on Windows" : false;

let tmp: TmpDir;
// A copy of the launcher and the starter in a checkout whose path has a space, with a stub
// bundle that echoes its arguments and the directory it runs in.
let checkout: string;
let launcher: string;
let getty: NodeJS.ProcessEnv;
/** The same with this checkout's real bundle. */
let real: string;

/** This checkout's bin/skilletor and bootstrap/getty-bun.sh in `dir`. */
function copyLaunchers(dir: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "bootstrap"), { recursive: true });
  copyFileSync(join(repo, "bin", "skilletor"), join(dir, "bin", "skilletor"));
  copyFileSync(join(repo, "bootstrap", "getty-bun.sh"), join(dir, "bootstrap", "getty-bun.sh"));
}

before(() => {
  if (skip) return;
  tmp = makeTmpDir();
  checkout = join(tmp.dir, "my clone");
  copyLaunchers(checkout);
  // As git checks it out: executable. The hooks run the starter through `sh`, which needs no bit.
  spawnSync("chmod", ["755", join(checkout, "bin", "skilletor")]);
  mkdirSync(join(checkout, "dist"));
  launcher = join(checkout, "bin", "skilletor");
  writeFileSync(join(checkout, "dist", "skilletor.js"),
    'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin: require("fs").readFileSync(0, "utf8") }));\n');
  getty = readySlot(join(tmp.dir, "getty home"));
  real = join(tmp.dir, "real checkout");
  copyLaunchers(real);
  spawnSync("chmod", ["755", join(real, "bin", "skilletor")]);
  mkdirSync(join(real, "dist"));
  copyFileSync(join(repo, "dist", "skilletor.js"), join(real, "dist", "skilletor.js"));
});

after(() => tmp?.cleanup());

function run(path: string, args: string[], env: NodeJS.ProcessEnv = getty, input = "") {
  return spawnSync(path, args, { encoding: "utf8", cwd: tmp.dir, input, env: { PATH: process.env.PATH, ...homeEnv(tmp.dir), ...env } });
}

function assertStub(path: string) {
  // Options pass through unchanged on POSIX (F4); the cwd stays the caller's.
  const args = ["--version", "a b", "-x", "--scope=user", "--json"];
  const r = run(path, args);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { args: string[]; cwd: string };
  assert.deepEqual(out.args, args);
  assert.equal(out.cwd, tmp.dir);
}

test("the launcher runs dist/ of its own checkout through the starter, every argument passed on", { skip }, () => {
  assertStub(launcher);
});

test("an absolute symlink to the launcher runs the checkout's dist/", { skip }, () => {
  const dir = join(tmp.dir, "abs");
  mkdirSync(dir);
  symlinkSync(launcher, join(dir, "skilletor"));
  assertStub(join(dir, "skilletor"));
});

test("a relative symlink resolves against the link's directory, not the cwd", { skip }, () => {
  // npm install -g: <prefix>/bin/skilletor -> ../lib/node_modules/skilletor/bin/skilletor
  const prefix = join(tmp.dir, "prefix");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
  symlinkSync(join("..", "..", "..", "my clone"), join(prefix, "lib", "node_modules", "skilletor"));
  symlinkSync(join("..", "lib", "node_modules", "skilletor", "bin", "skilletor"), join(prefix, "bin", "skilletor"));
  assertStub(join(prefix, "bin", "skilletor"));
});

test("a chain of symlinks, each relative to its own directory, is followed to the end", { skip }, () => {
  const a = join(tmp.dir, "chain", "a");
  const b = join(tmp.dir, "chain", "b", "deeper");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  symlinkSync(join("..", "..", "..", "my clone", "bin", "skilletor"), join(b, "hop"));
  symlinkSync(join(b, "hop"), join(a, "hop"));
  symlinkSync(join("..", "b", "deeper", "hop"), join(a, "skilletor"));
  assertStub(join(a, "skilletor"));
});

test("a symlink to the bin/ directory finds the checkout's dist/, not one beside the link", { skip }, () => {
  const dir = join(tmp.dir, "dirlink");
  mkdirSync(dir);
  symlinkSync(join(checkout, "bin"), join(dir, "skilletor-bin"));
  assertStub(join(dir, "skilletor-bin", "skilletor"));
});

test("run through sh, without its executable bit, it works the same", { skip }, () => {
  const r = run("sh", [launcher, "status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((JSON.parse(r.stdout) as { args: string[] }).args, ["status"]);
});

test("a starter failure is the starter's one line and exit 1; the entry never runs", { skip }, () => {
  // No slot and a mirror that is not there: the install fails, nothing is fetched.
  const missing = run(launcher, ["--version"], gettyEnv(join(tmp.dir, "empty getty home")));
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /^getty-bun: /m);
  const relative = run(launcher, ["--version"], { GETTY_HOME: "relative" });
  assert.equal(relative.status, 1);
  assert.equal(relative.stdout, "");
  assert.match(relative.stderr, /^getty-bun: GETTY_HOME must be an absolute path/m);
});

test("this checkout's launcher and bundle, linked, print the package version", { skip }, () => {
  const dir = join(tmp.dir, "real");
  mkdirSync(dir);
  symlinkSync(join(real, "bin", "skilletor"), join(dir, "skilletor"));
  const r = run(join(dir, "skilletor"), ["--version"]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  assert.equal(r.stdout.trim(), pkg.version);
});

type Hook = { command: string; args?: string[]; commandWindows?: string };
const hookFile = (name: string) =>
  JSON.parse(readFileSync(join(repo, "hooks", name), "utf8")).hooks as Record<string, { hooks: Hook[] }[]>;
const EVENTS: Record<string, string> = {
  SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", CwdChanged: "cwd-changed", PostToolUse: "post-tool-use",
};

test("Claude Code's hook lines, in exec form with the plugin root substituted, run the entry with event and host", { skip }, () => {
  for (const [event, groups] of Object.entries(hookFile("hooks.json"))) {
    const h = groups[0]!.hooks[0]!;
    assert.equal(h.command, "sh");
    const args = h.args!.map((a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", checkout));
    const input = JSON.stringify({ hook_event_name: event, cwd: tmp.dir });
    const r = run(h.command, args, getty, input);
    assert.equal(r.status, 0, `${event}: ${r.stderr}`);
    const out = JSON.parse(r.stdout) as { args: string[]; stdin: string };
    assert.deepEqual(out.args, ["hook", EVENTS[event], "claude-code"], event);
    assert.equal(out.stdin, input, event);
  }
});

test("Codex's hook lines, substituted as text and run by sh -c, survive a plugin root with a space (k244)", { skip }, () => {
  assert.ok(checkout.includes(" "));
  for (const [event, groups] of Object.entries(hookFile("codex-hooks.json"))) {
    const h = groups[0]!.hooks[0]!;
    // Codex replaces ${PLUGIN_ROOT} in the string before a shell sees it (codex.md).
    const line = h.command.replaceAll("${PLUGIN_ROOT}", checkout);
    const r = run("sh", ["-c", line], getty, "{}");
    assert.equal(r.status, 0, `${event}: ${r.stderr}`);
    assert.deepEqual((JSON.parse(r.stdout) as { args: string[] }).args, ["hook", EVENTS[event], "codex"], event);
    assert.equal(h.commandWindows,
      `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\${PLUGIN_ROOT}\\bootstrap\\getty-bun.ps1" run dist/skilletor.js hook ${EVENTS[event]} codex`);
  }
});

test("the real bundle behind a real hook line exits 0 with at most one JSON object, on any input", { skip }, () => {
  const home = join(tmp.dir, "hook home");
  mkdirSync(home);
  const h = hookFile("hooks.json").SessionStart![0]!.hooks[0]!;
  const args = h.args!.map((a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", real));
  for (const input of ["", "not json", JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: home })]) {
    const r = spawnSync("sh", args, {
      encoding: "utf8", cwd: home, input,
      env: { PATH: process.env.PATH, ...homeEnv(home), CODEX_HOME: join(home, ".no-codex"), ...getty },
    });
    assert.equal(r.status, 0, r.stderr);
    if (r.stdout.trim()) assert.equal(typeof JSON.parse(r.stdout), "object");
  }
});
