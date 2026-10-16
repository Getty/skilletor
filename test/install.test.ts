// install.sh (k141, GitHub issue #1): set skilletor up from a plain shell and leave a stable
// `skilletor` on PATH. With `claude` on PATH it installs the Claude Code plugin and writes a
// shim that runs the user-scope install's bin/skilletor, whichever version that is; without
// (or with --no-plugin) it clones the repository and links the clone's launcher. Every run
// gets a temp HOME and a PATH of its own: a fake `claude` that logs its calls
// (test/helpers/fake-claude.mjs), or none at all – never the machine's. POSIX only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = join(repo, "install.sh");
const fakeClaude = fileURLToPath(new URL("./helpers/fake-claude.mjs", import.meta.url));
const skip = process.platform === "win32" ? "install.sh is a POSIX sh script" : false;
const SYSTEM_PATH = ["/usr/bin", "/bin"];

let tmp: TmpDir;
/** node and git, linked one by one: their own directories may hold a real `claude`. */
let tools: string;
/** A `claude` that runs the fake. */
let fakeBin: string;
/** What the fake installs: the real launcher and a bundle that names its root and arguments. */
let pluginSrc: string;
/** A copy of install.sh outside any checkout: run as this checkout's, it would link this checkout. */
let loose: string;

function findOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(`${name} not found on PATH`);
}

before(() => {
  if (skip) return;
  tmp = makeTmpDir();
  mkdirSync(join(tmp.dir, "loose"));
  loose = join(tmp.dir, "loose", "install.sh");
  copyFileSync(script, loose);
  tools = join(tmp.dir, "tools");
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, "node"));
  symlinkSync(findOnPath("git"), join(tools, "git"));
  fakeBin = join(tmp.dir, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
  pluginSrc = join(tmp.dir, "plugin-src");
  mkdirSync(join(pluginSrc, "bin"), { recursive: true });
  mkdirSync(join(pluginSrc, "dist"));
  copyFileSync(join(repo, "bin", "skilletor"), join(pluginSrc, "bin", "skilletor"));
  chmodSync(join(pluginSrc, "bin", "skilletor"), 0o755);
  writeFileSync(join(pluginSrc, "dist", "skilletor.js"),
    'console.log(JSON.stringify({ root: require("path").dirname(__dirname), args: process.argv.slice(2) }));\n');
});

after(() => tmp?.cleanup());

interface Machine {
  home: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

/** A fresh HOME; `claude` on PATH unless `claude: false`. */
function machine(name: string, opts: { claude?: boolean; env?: NodeJS.ProcessEnv } = {}): Machine {
  const home = join(tmp.dir, name);
  mkdirSync(home);
  const log = join(tmp.dir, `${name}.claude.log`);
  writeFileSync(log, "");
  const path = [...(opts.claude === false ? [] : [fakeBin]), tools, ...SYSTEM_PATH].join(delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: path, HOME: home, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_PLUGIN: pluginSrc, ...opts.env,
  };
  return { home, log, env };
}

// Something on stdin, which no command the script runs may read (the fake claude fails then).
function runScript(m: Machine, args: string[] = [], env: NodeJS.ProcessEnv = {}, file = loose) {
  return spawnSync("sh", [file, ...args], { encoding: "utf8", cwd: m.home, env: { ...m.env, ...env }, input: "y\n" });
}

/** The way the README runs it: the script on sh's stdin (`curl … | sh -s -- <args>`). */
function pipeScript(m: Machine, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", ["-s", "--", ...args], {
    encoding: "utf8", cwd: m.home, env: { ...m.env, ...env }, input: readFileSync(script, "utf8"),
  });
}

function calls(m: Machine): string[] {
  return readFileSync(m.log, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as string[]).join(" "));
}

function runCli(m: Machine, cli: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(cli, args, { encoding: "utf8", cwd: m.home, env: { ...m.env, ...env } });
}

function stubRun(m: Machine, cli: string, args: string[]) {
  const r = runCli(m, cli, args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { root: string; args: string[] };
}

const cachePath = (m: Machine, version: string) =>
  join(m.home, ".claude", "plugins", "cache", "getty", "skilletor", version);

test("install.sh is POSIX sh: it parses under sh -n (and dash, shellcheck when present)", { skip }, () => {
  execFileSync("sh", ["-n", script]);
  const dash = ["/bin/dash", "/usr/bin/dash"].find((p) => existsSync(p));
  if (dash) execFileSync(dash, ["-n", script]);
  if (spawnSync("shellcheck", ["--version"]).status === 0) {
    const r = spawnSync("shellcheck", ["-s", "sh", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
  }
});

test("piped into sh, it adds the marketplace, installs the plugin and writes a shim", { skip }, () => {
  const m = machine("fresh");
  const r = pipeScript(m);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(m), [
    "plugin marketplace list --json",
    "plugin marketplace add Getty/marketplace",
    "plugin list --json",
    "plugin install skilletor@getty --scope user",
  ]);
  const shim = join(m.home, ".local", "bin", "skilletor");
  assert.ok(!lstatSync(shim).isSymbolicLink(), "a shim, not a link into the versioned cache");
  assert.equal(lstatSync(shim).mode & 0o111, 0o111);
  const out = stubRun(m, shim, ["install", "a b@getty"]);
  assert.equal(realpathSync(out.root), realpathSync(cachePath(m, "1.0.0")));
  assert.deepEqual(out.args, ["install", "a b@getty"]);
  assert.match(r.stdout, /skilletor@getty/);
  assert.match(r.stdout, new RegExp(shim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("run again, it updates instead of reinstalling, and the shim follows the new version", { skip }, () => {
  const m = machine("again");
  assert.equal(runScript(m).status, 0);
  const shim = join(m.home, ".local", "bin", "skilletor");
  const before = readFileSync(shim, "utf8");
  writeFileSync(m.log, "");
  const r = runScript(m, [], { FAKE_CLAUDE_VERSION: "1.1.0" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(m), [
    "plugin marketplace list --json",
    "plugin marketplace update getty",
    "plugin list --json",
    "plugin update skilletor@getty --scope user",
  ]);
  assert.equal(readFileSync(shim, "utf8"), before);
  assert.match(r.stdout, /unchanged/);
  // The old version stays in the cache, as Claude Code leaves it; the shim takes the new one.
  assert.ok(existsSync(cachePath(m, "1.0.0")));
  assert.equal(realpathSync(stubRun(m, shim, []).root), realpathSync(cachePath(m, "1.1.0")));
});

test("the shim takes the user-scope install, never a project's, and says so when there is none", { skip }, () => {
  const m = machine("scopes");
  assert.equal(runScript(m).status, 0);
  const shim = join(m.home, ".local", "bin", "skilletor");
  const file = join(m.home, ".claude", "plugins", "installed_plugins.json");
  const old = join(tmp.dir, "scopes-old");
  cpSync(pluginSrc, old, { recursive: true });
  const user = { scope: "user", installPath: cachePath(m, "1.0.0"), version: "1.0.0" };
  const project = { scope: "project", projectPath: m.home, installPath: old, version: "0.9.0" };
  const other = { scope: "user", installPath: old, version: "0.9.0" };

  // Project entries before the user's, another marketplace's sorting first: getty's user install.
  writeFileSync(file, JSON.stringify({ version: 2, plugins: {
    "skilletor@aaa": [other], "skilletor@getty": [project, user], "other@getty": [other] } }));
  assert.equal(realpathSync(stubRun(m, shim, []).root), realpathSync(cachePath(m, "1.0.0")));

  // No user install from getty: another marketplace's user install will do.
  writeFileSync(file, JSON.stringify({ version: 2, plugins: { "skilletor@getty": [project], "skilletor@dev": [other] } }));
  assert.equal(realpathSync(stubRun(m, shim, []).root), realpathSync(old));

  // Only project installs (or a user entry whose directory is gone): an error naming the fix.
  writeFileSync(file, JSON.stringify({ version: 2, plugins: {
    "skilletor@getty": [project, { ...user, installPath: join(tmp.dir, "gone") }] } }));
  const r = runCli(m, shim, ["status"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no skilletor plugin installed in user scope/);
  assert.match(r.stderr, /claude plugin install skilletor@getty/);

  // CLAUDE_CONFIG_DIR moves Claude Code's files, the shim reads them there.
  const config = join(tmp.dir, "scopes-config");
  mkdirSync(join(config, "plugins"), { recursive: true });
  writeFileSync(join(config, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "skilletor@getty": [user] } }));
  const viaConfig = runCli(m, shim, [], { CLAUDE_CONFIG_DIR: config });
  assert.equal(viaConfig.status, 0, viaConfig.stderr);
});

test("a bin dir off PATH is warned about; --bin-dir and SKILLETOR_BIN_DIR choose it", { skip }, () => {
  const m = machine("bindir");
  const r = runScript(m);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\.local\/bin is not on your PATH/);
  assert.match(r.stderr, /export PATH=/);

  const flag = join(m.home, "flag bin");
  const viaFlag = runScript(m, ["--bin-dir", flag]);
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.ok(existsSync(join(flag, "skilletor")));

  const env = join(m.home, "env-bin");
  const viaEnv = runScript(m, [], { SKILLETOR_BIN_DIR: env, PATH: `${env}${delimiter}${m.env.PATH}` });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.ok(existsSync(join(env, "skilletor")));
  assert.doesNotMatch(viaEnv.stderr, /not on your PATH/);

  const relative = runScript(m, ["--bin-dir", "bin"]);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /absolute/);
});

test("a skilletor in the bin dir that is not the script's own is left alone", { skip }, () => {
  const m = machine("foreign");
  const target = join(m.home, ".local", "bin", "skilletor");
  mkdirSync(join(m.home, ".local", "bin"), { recursive: true });
  writeFileSync(target, "#!/bin/sh\necho mine\n");
  const r = runScript(m);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not one this script wrote/);
  assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho mine\n");
});

/** A bare repository like github.com/Getty/skilletor: the real launcher, bundle and script. */
function sourceRepo(name: string): { bare: string; work: string } {
  const work = join(tmp.dir, `${name}-work`);
  const bare = join(tmp.dir, `${name}.git`);
  mkdirSync(join(work, "bin"), { recursive: true });
  mkdirSync(join(work, "dist"));
  copyFileSync(join(repo, "bin", "skilletor"), join(work, "bin", "skilletor"));
  chmodSync(join(work, "bin", "skilletor"), 0o755);
  copyFileSync(join(repo, "dist", "skilletor.js"), join(work, "dist", "skilletor.js"));
  copyFileSync(join(repo, "package.json"), join(work, "package.json"));
  copyFileSync(script, join(work, "install.sh"));
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { stdio: "pipe" });
  git(work, "remote", "add", "origin", bare);
  return { bare, work };
}

const pkgVersion = () => (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;

test("without claude it clones the repository and links the clone's launcher; again, it pulls", { skip }, () => {
  const m = machine("noclaude", { claude: false });
  assert.notEqual(spawnSync("sh", ["-c", "command -v claude"], { env: m.env }).status, 0, "a claude on the system PATH");
  const src = sourceRepo("noclaude");
  const env = { SKILLETOR_REPO: `file://${src.bare}` };
  const r = pipeScript(m, [], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const clone = join(m.home, ".local", "share", "skilletor");
  const link = join(m.home, ".local", "bin", "skilletor");
  assert.equal(readlinkSync(link), join(clone, "bin", "skilletor"));
  const v = runCli(m, link, ["--version"]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), pkgVersion());
  assert.match(r.stdout, /Claude Code not found/);

  writeFileSync(join(src.work, "NEW"), "x\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: src.work, stdio: "pipe" });
  git("add", "NEW");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "next");
  git("push", "-q", "origin", "main");
  const again = runScript(m, [], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(existsSync(join(clone, "NEW")), "the rerun pulled the clone");
  assert.match(again.stdout, /unchanged/);

  // XDG_DATA_HOME moves the clone.
  const xdg = join(m.home, "xdg");
  rmSync(link);
  assert.equal(runScript(m, [], { ...env, XDG_DATA_HOME: xdg }).status, 0);
  assert.equal(readlinkSync(link), join(xdg, "skilletor", "bin", "skilletor"));
});

test("--no-plugin (or SKILLETOR_NO_PLUGIN=1) never calls claude, even when it is there", { skip }, () => {
  const src = sourceRepo("noplugin");
  for (const [name, args, env] of [
    ["noplugin-flag", ["--no-plugin"], {}],
    ["noplugin-env", [], { SKILLETOR_NO_PLUGIN: "1" }],
  ] as const) {
    const m = machine(name);
    const r = runScript(m, [...args], { ...env, SKILLETOR_REPO: `file://${src.bare}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(calls(m), []);
    assert.ok(lstatSync(join(m.home, ".local", "bin", "skilletor")).isSymbolicLink());
  }
});

test("switching from the plugin to a clone replaces the shim with a link", { skip }, () => {
  const m = machine("switch");
  assert.equal(runScript(m).status, 0);
  const src = sourceRepo("switch");
  const r = runScript(m, ["--no-plugin"], { SKILLETOR_REPO: `file://${src.bare}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(lstatSync(join(m.home, ".local", "bin", "skilletor")).isSymbolicLink());
});

test("run from a clone without claude, it links that clone instead of cloning another", { skip }, () => {
  const m = machine("fromclone", { claude: false });
  const src = sourceRepo("fromclone");
  const r = runScript(m, [], { SKILLETOR_REPO: "file:///nonexistent" }, join(src.work, "install.sh"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readlinkSync(join(m.home, ".local", "bin", "skilletor")), join(realpathSync(src.work), "bin", "skilletor"));
  assert.ok(!existsSync(join(m.home, ".local", "share", "skilletor")));
});

test("without Node.js >= 18 it stops before calling anything", { skip }, () => {
  const old = join(tmp.dir, "old-tools");
  mkdirSync(old);
  writeFileSync(join(old, "node"), "#!/bin/sh\nprintf 16\n");
  chmodSync(join(old, "node"), 0o755);
  symlinkSync(join(tools, "git"), join(old, "git"));
  const m = machine("oldnode");
  const r = runScript(m, [], { PATH: [fakeBin, old, ...SYSTEM_PATH].join(delimiter) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Node\.js >= 18/);
  assert.deepEqual(calls(m), []);
});

test("unknown options are refused before anything runs; --help prints the usage", { skip }, () => {
  const m = machine("usage");
  const bad = runScript(m, ["--frobnicate"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option: --frobnicate/);
  assert.deepEqual(calls(m), []);
  const help = runScript(m, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--bin-dir/);
  assert.match(help.stdout, /--no-plugin/);
  assert.deepEqual(calls(m), []);
});
