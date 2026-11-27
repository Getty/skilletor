// install.sh (k141, GitHub issue #1): set skilletor up from a plain shell and leave a stable
// `skilletor` on PATH. With `claude` on PATH it installs the Claude Code plugin and writes a
// shim that runs the user-scope install's bundle through its getty-bun starter, whichever version
// that is; without (or with --no-plugin) it clones the repository and links the clone's launcher.
// Since k281 neither the script nor the shim needs Node.js or Bun: sh, awk and git; the starter
// installs Bun. Every run gets a temp HOME, a GETTY_HOME with a ready slot (nothing is
// downloaded, test/helpers/gettybun.ts) and a PATH of its own: a fake `claude` that logs its
// calls (test/helpers/fake-claude.mjs), or none at all – never the machine's. POSIX only.
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
import { readySlot } from "./helpers/gettybun.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = join(repo, "install.sh");
const fakeClaude = fileURLToPath(new URL("./helpers/fake-claude.mjs", import.meta.url));
const skip = process.platform === "win32" ? "install.sh is a POSIX sh script" : false;
const SYSTEM_PATH = ["/usr/bin", "/bin"];
/** All a run needs, install.sh and starter alike: no node, no bun. */
const BARE_TOOLS = ["sh", "awk", "git", "uname", "mkdir", "mv", "rm", "chmod", "cmp", "ln", "readlink", "dirname", "grep", "sort", "cat"];

let tmp: TmpDir;
/** git, linked alone: its own directory may hold a real `claude`. */
let tools: string;
/** Only BARE_TOOLS, for the run that proves no Node and no Bun are needed. */
let bareTools: string | undefined;
/** A `claude` that runs the fake. */
let fakeBin: string;
/** What the fake installs: the real launcher and starter, and a bundle that names its root and arguments. */
let pluginSrc: string;
/** A copy of install.sh outside any checkout: run as this checkout's, it would link this checkout. */
let loose: string;
/** GETTY_HOME with a ready slot, for every run. */
let getty: NodeJS.ProcessEnv;

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
}

function findOnPath(name: string): string {
  const found = onPath(name);
  if (found) return found;
  throw new Error(`${name} not found on PATH`);
}

const bareMissing = BARE_TOOLS.filter((name) => !onPath(name));
const bareSkip = skip || (bareMissing.length > 0 ? `a bare PATH needs: ${bareMissing.join(", ")}` : false);

/** This checkout's launcher and starter in `dir`, as a checkout has them. */
function copyLaunchers(dir: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "bootstrap"), { recursive: true });
  copyFileSync(join(repo, "bin", "skilletor"), join(dir, "bin", "skilletor"));
  chmodSync(join(dir, "bin", "skilletor"), 0o755);
  copyFileSync(join(repo, "bootstrap", "getty-bun.sh"), join(dir, "bootstrap", "getty-bun.sh"));
}

before(() => {
  if (skip) return;
  tmp = makeTmpDir();
  mkdirSync(join(tmp.dir, "loose"));
  loose = join(tmp.dir, "loose", "install.sh");
  copyFileSync(script, loose);
  tools = join(tmp.dir, "tools");
  mkdirSync(tools);
  symlinkSync(findOnPath("git"), join(tools, "git"));
  if (!bareSkip) {
    bareTools = join(tmp.dir, "bare-tools");
    mkdirSync(bareTools);
    for (const name of BARE_TOOLS) symlinkSync(findOnPath(name), join(bareTools, name));
  }
  fakeBin = join(tmp.dir, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
  pluginSrc = join(tmp.dir, "plugin-src");
  copyLaunchers(pluginSrc);
  mkdirSync(join(pluginSrc, "dist"));
  writeFileSync(join(pluginSrc, "dist", "skilletor.js"),
    'console.log(JSON.stringify({ root: require("path").dirname(__dirname), args: process.argv.slice(2) }));\n');
  getty = readySlot(join(tmp.dir, "getty"));
});

after(() => tmp?.cleanup());

interface Machine {
  home: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

/** A fresh HOME; `claude` on PATH unless `claude: false`. */
function machine(name: string, opts: { claude?: boolean; env?: NodeJS.ProcessEnv; toolPath?: string } = {}): Machine {
  const home = join(tmp.dir, name);
  mkdirSync(home);
  const log = join(tmp.dir, `${name}.claude.log`);
  writeFileSync(log, "");
  const path = [...(opts.claude === false ? [] : [fakeBin]), opts.toolPath ?? tools, ...(opts.toolPath ? [] : SYSTEM_PATH)].join(delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: path, HOME: home, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_PLUGIN: pluginSrc, ...getty, ...opts.env,
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

/** A bare repository like github.com/Getty/skilletor: the real launcher, starter, bundle and script. */
function sourceRepo(name: string): { bare: string; work: string } {
  const work = join(tmp.dir, `${name}-work`);
  const bare = join(tmp.dir, `${name}.git`);
  copyLaunchers(work);
  mkdirSync(join(work, "dist"));
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

test("neither Node.js nor Bun on PATH: sh, awk and git install the plugin's shim and a clone, and both run", { skip: bareSkip }, () => {
  for (const [name, claude] of [["bare-plugin", true], ["bare-cli", false]] as const) {
    const m = machine(name, { claude, toolPath: bareTools });
    const absent = spawnSync(join(bareTools!, "sh"), ["-c", "command -v node || command -v bun"], { encoding: "utf8", env: m.env });
    assert.notEqual(absent.status, 0, absent.stdout);
    const src = sourceRepo(name);
    const r = pipeScript(m, [], { SKILLETOR_REPO: `file://${src.bare}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const target = join(m.home, ".local", "bin", "skilletor");
    if (claude) {
      assert.ok(!lstatSync(target).isSymbolicLink());
      assert.deepEqual(stubRun(m, target, ["status", "--json"]).args, ["status", "--json"]);
    } else {
      assert.ok(lstatSync(target).isSymbolicLink());
      const v = runCli(m, target, ["--version"]);
      assert.equal(v.status, 0, v.stderr);
      assert.equal(v.stdout.trim(), pkgVersion());
    }
    assert.match(r.stdout, /is ready/);
  }
});

test("a starter that cannot run fails the install with its own line", { skip }, () => {
  const m = machine("nostarter", { claude: false });
  const src = sourceRepo("nostarter");
  const r = runScript(m, [], { SKILLETOR_REPO: `file://${src.bare}`, GETTY_HOME: "relative" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^getty-bun: GETTY_HOME must be an absolute path/m);
  assert.match(r.stderr, /--version failed/);
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

// The awk JSON reader install.sh and its shim use instead of Node (k281): Claude Code's --json
// lists are compact, its installed_plugins.json is indented; anything else is refused.
test("json_has reads compact and indented JSON arrays and refuses anything else", { skip }, () => {
  const lib = join(tmp.dir, "install-lib.sh");
  writeFileSync(lib, readFileSync(script, "utf8").replace(/\nmain "\$@"\n$/, "\n"));
  const has = (json: string, ...want: string[]) =>
    spawnSync("sh", ["-c", `. "$0"; json_has "$@"`, lib, ...want], { input: json, encoding: "utf8" }).status;
  const list = [{ id: "skilletor@getty", scope: "project", note: "a \"quoted\" \\ value" }, { id: "skilletor@getty", scope: "user" }];
  assert.equal(has(JSON.stringify(list), "id=skilletor@getty", "scope=user"), 0);
  assert.equal(has(JSON.stringify(list, null, 2), "id=skilletor@getty", "scope=user"), 0);
  assert.equal(has(JSON.stringify([list[0]]), "id=skilletor@getty", "scope=user"), 1);
  assert.equal(has(JSON.stringify([{ id: "skilletor@getty" }, { scope: "user" }]), "id=skilletor@getty", "scope=user"), 1);
  assert.equal(has("[]", "name=getty"), 1);
  assert.equal(has(JSON.stringify([{ nested: { name: "getty" } }]), "name=getty"), 1);
  for (const bad of ["", "not json", "{\"name\":\"getty\"}", "[{\"name\":\"getty\"}", "[1] 2", "[\"open]"]) {
    assert.equal(has(bad, "name=getty"), 2, bad);
  }
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
