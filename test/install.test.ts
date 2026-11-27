// install.sh (k141, GitHub issue #1): set skilletor up from a plain shell and leave a stable
// `skilletor` on PATH. With `claude` on PATH it installs the Claude Code plugin and writes a
// shim that runs the user-scope install's bin/skilletor, whichever version that is; without
// (or with --no-plugin) it clones the repository and links the clone's launcher. Without Node,
// it preflights and links bin/skilletor-start instead, never touching Claude plugin state. Every
// run gets a temp HOME and a PATH of its own: a fake `claude` that logs its calls
// (test/helpers/fake-claude.mjs), or none at all – never the machine's. POSIX only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
// The suite runs on Bun, linked in as `node`; install.sh's shim runs `node -e <code> A B`, and Bun
// started as node drops A. k281 rewrites install.sh onto the getty-bun starter; until then the
// tests that run the shim skip.
const shimSkip = skip || "k281: install.sh's shim needs a real node (Bun as node drops an -e argument)";
const SYSTEM_PATH = ["/usr/bin", "/bin"];
const NO_NODE_TOOLS = ["sh", "git", "uname", "sha256sum", "curl", "mkdir", "mv", "rm", "rmdir", "chmod", "env", "readlink", "dirname", "cat", "ln"];

let tmp: TmpDir;
/** node and git, linked one by one: their own directories may hold a real `claude`. */
let tools: string;
/** Only the tools a Linux no-Node/no-Perl installer run needs. */
let noNodeTools: string | undefined;
/** A `claude` that runs the fake. */
let fakeBin: string;
/** What the fake installs: the real launcher and a bundle that names its root and arguments. */
let pluginSrc: string;
/** A copy of install.sh outside any checkout: run as this checkout's, it would link this checkout. */
let loose: string;

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

const noNodeMissingTools = NO_NODE_TOOLS.filter((name) => !onPath(name));
const noNodeSkip = skip || (process.platform !== "linux"
  ? "the no-Node/no-Perl binary proof uses Linux sha256sum"
  : noNodeMissingTools.length > 0
    ? `no-Node binary proof needs: ${noNodeMissingTools.join(", ")}`
    : false);

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
  if (!noNodeSkip) {
    noNodeTools = join(tmp.dir, "no-node-tools");
    mkdirSync(noNodeTools);
    for (const name of NO_NODE_TOOLS) {
      symlinkSync(findOnPath(name), join(noNodeTools, name));
    }
  }
  fakeBin = join(tmp.dir, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
  pluginSrc = join(tmp.dir, "plugin-src");
  mkdirSync(join(pluginSrc, "bin"), { recursive: true });
  mkdirSync(join(pluginSrc, "dist"));
  // bin/skilletor runs the starter beside it (k191); never this checkout's pinned checksums.
  for (const file of ["skilletor", "skilletor-start"]) {
    copyFileSync(join(repo, "bin", file), join(pluginSrc, "bin", file));
    chmodSync(join(pluginSrc, "bin", file), 0o755);
  }
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
function machine(name: string, opts: { claude?: boolean; env?: NodeJS.ProcessEnv; toolPath?: string } = {}): Machine {
  const home = join(tmp.dir, name);
  mkdirSync(home);
  const log = join(tmp.dir, `${name}.claude.log`);
  writeFileSync(log, "");
  const path = [...(opts.claude === false ? [] : [fakeBin]), opts.toolPath ?? tools, ...(opts.toolPath ? [] : SYSTEM_PATH)].join(delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: path, HOME: home, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_PLUGIN: pluginSrc, ...opts.env,
  };
  return { home, log, env };
}

/** A fresh machine whose PATH has neither Node nor a system Perl. */
function noNodeMachine(name: string, opts: { claude?: boolean; env?: NodeJS.ProcessEnv } = {}): Machine {
  if (!noNodeTools) throw new Error("no-Node test tools were not prepared");
  return machine(name, { ...opts, toolPath: noNodeTools });
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

function runScriptAsync(m: Machine, args: string[] = [], env: NodeJS.ProcessEnv = {}, file = loose) {
  return runShellAsync(m, [file, ...args], "y\n", env);
}

function pipeScriptAsync(m: Machine, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return runShellAsync(m, ["-s", "--", ...args], readFileSync(script, "utf8"), env);
}

function runShellAsync(m: Machine, args: string[], input: string, env: NodeJS.ProcessEnv) {
  return runCommandAsync("sh", args, m, input, env);
}

function runCliAsync(m: Machine, cli: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return runCommandAsync(cli, args, m, "", env);
}

function runCommandAsync(command: string, args: string[], m: Machine, input: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: m.home, env: { ...m.env, ...env }, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
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

test("piped into sh, it adds the marketplace, installs the plugin and writes a shim", { skip: shimSkip }, () => {
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

test("run again, it updates instead of reinstalling, and the shim follows the new version", { skip: shimSkip }, () => {
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

test("the shim takes the user-scope install, never a project's, and says so when there is none", { skip: shimSkip }, () => {
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

test("a bin dir off PATH is warned about; --bin-dir and SKILLETOR_BIN_DIR choose it", { skip: shimSkip }, () => {
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
function sourceRepo(name: string, opts: { pinned?: string } = {}): { bare: string; work: string } {
  const work = join(tmp.dir, `${name}-work`);
  const bare = join(tmp.dir, `${name}.git`);
  mkdirSync(join(work, "bin"), { recursive: true });
  mkdirSync(join(work, "dist"));
  copyFileSync(join(repo, "bin", "skilletor"), join(work, "bin", "skilletor"));
  chmodSync(join(work, "bin", "skilletor"), 0o755);
  copyFileSync(join(repo, "bin", "skilletor-start"), join(work, "bin", "skilletor-start"));
  chmodSync(join(work, "bin", "skilletor-start"), 0o755);
  if (opts.pinned !== undefined) writeFileSync(join(work, "bin", "skilletor-binaries.sha256"), opts.pinned);
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

function binaryAsset(): string {
  const os = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim() === "Linux" ? "linux" : "macos";
  const machine = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
  const arch = ["x86_64", "amd64"].includes(machine) ? "x86_64" : "arm64";
  return `skilletor-1.2.3-${os}-${arch}`;
}

function pinnedBinary(body: string): string {
  return `${createHash("sha256").update(body).digest("hex")}  ${binaryAsset()}\n`;
}

/** The release asset over http://127.0.0.1: the starter fetches it only with
 *  SKILLETOR_STARTER_TESTING=1 next to SKILLETOR_BINARY_BASE_URL (k253). */
async function serveBinary(body: string, unavailable = false) {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    response.setHeader("connection", "close");
    if (unavailable) {
      response.destroy();
      return;
    }
    assert.equal(request.url, `/${binaryAsset()}`);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local binary server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function writePluginMetadata(m: Machine): { file: string; contents: string } {
  const file = join(m.home, ".claude", "plugins", "installed_plugins.json");
  const contents = "not JSON and not the installer's business\n";
  mkdirSync(join(m.home, ".claude", "plugins"), { recursive: true });
  writeFileSync(file, contents);
  return { file, contents };
}

function oldLink(m: Machine): { target: string; old: string } {
  const bin = join(m.home, ".local", "bin");
  const target = join(bin, "skilletor");
  const old = join(m.home, "old-skilletor");
  mkdirSync(bin, { recursive: true });
  writeFileSync(old, "#!/bin/sh\nprintf old\\n\n");
  chmodSync(old, 0o755);
  symlinkSync(old, target);
  return { target, old };
}

const FAKE_BINARY = "#!/bin/sh\ncase ${1-} in --version) printf 'fake binary 1.2.3\\n' ;; *) printf 'fake binary\\n' ;; esac\n";

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

test("without Node or Perl it installs a verified binary starter without touching Claude plugin state", { skip: noNodeSkip }, async () => {
  const release = await serveBinary(FAKE_BINARY);
  const src = sourceRepo("no-node", { pinned: pinnedBinary(FAKE_BINARY) });
  try {
    for (const [name, claude, metadata] of [
      ["no-node-plugin", true, true],
      ["no-node-cli", false, false],
    ] as const) {
      const m = noNodeMachine(name, { claude });
      const absent = spawnSync(join(noNodeTools!, "sh"), ["-c", "command -v node; command -v perl"], {
        encoding: "utf8", env: m.env,
      });
      assert.notEqual(absent.status, 0);
      assert.equal(absent.stdout, "");
      const plugin = metadata ? writePluginMetadata(m) : undefined;
      const env = { SKILLETOR_REPO: `file://${src.bare}`, SKILLETOR_BINARY_BASE_URL: release.url, SKILLETOR_STARTER_TESTING: "1" };

      const first = await pipeScriptAsync(m, [], env);
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const clone = join(m.home, ".local", "share", "skilletor");
      const link = join(m.home, ".local", "bin", "skilletor");
      assert.equal(readlinkSync(link), join(clone, "bin", "skilletor-start"));
      assert.equal(runCli(m, link, ["--version"]).stdout, "fake binary 1.2.3\n");
      assert.match(first.stdout, /plugin untouched/);
      assert.deepEqual(calls(m), []);
      if (plugin) assert.equal(readFileSync(plugin.file, "utf8"), plugin.contents);
      else assert.ok(!existsSync(join(m.home, ".claude", "plugins", "installed_plugins.json")));

      const hits = release.hits();
      const again = runScript(m, [], env);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.equal(release.hits(), hits, "the verified binary cache avoids another download");
      assert.match(readlinkSync(link), /\.next\.[^/]+\/bin\/skilletor-start$/);
      assert.deepEqual(calls(m), []);
      if (plugin) assert.equal(readFileSync(plugin.file, "utf8"), plugin.contents);
    }
  } finally {
    await release.close();
  }
});

test("without Node, a retained PID candidate does not block a later update", { skip: noNodeSkip }, async () => {
  const collisionTools = join(tmp.dir, "no-node-collision-tools");
  mkdirSync(collisionTools);
  for (const name of NO_NODE_TOOLS) {
    if (name !== "git") symlinkSync(join(noNodeTools!, name), join(collisionTools, name));
  }
  const realGitDir = join(collisionTools, "real");
  mkdirSync(realGitDir);
  symlinkSync(findOnPath("git"), join(realGitDir, "git"));
  writeFileSync(join(collisionTools, "git"), [
    "#!/bin/sh",
    "if [ \"$1\" = -C ] && [ \"$3\" = remote ] && [ \"$4\" = get-url ]; then",
    "  : > \"$HOME/retained-candidates\"",
    "  pid=$PPID",
    "  depth=0",
    "  while [ \"$depth\" -lt 4 ]; do",
    "    retained=\"$HOME/.local/share/skilletor.next.$pid\"",
    "    mkdir -p \"$retained\"",
    "    printf 'retained\\n' > \"$retained/KEEP\"",
    "    printf '%s\\n' \"$retained\" >> \"$HOME/retained-candidates\"",
    "    [ -r \"/proc/$pid/stat\" ] || break",
    "    read -r stat_pid stat_name stat_state parent rest < \"/proc/$pid/stat\" || break",
    "    [ \"$parent\" -gt 1 ] || break",
    "    pid=$parent",
    "    depth=$((depth + 1))",
    "  done",
    "fi",
    "base=${0%/*}",
    "exec \"$base/real/git\" \"$@\"",
    "",
  ].join("\n"));
  chmodSync(join(collisionTools, "git"), 0o755);

  const release = await serveBinary(FAKE_BINARY);
  const src = sourceRepo("no-node-candidate-collision", { pinned: pinnedBinary(FAKE_BINARY) });
  const m = noNodeMachine("no-node-candidate-collision", {
    claude: false,
    env: { PATH: collisionTools },
  });
  const env = { SKILLETOR_REPO: `file://${src.bare}`, SKILLETOR_BINARY_BASE_URL: release.url, SKILLETOR_STARTER_TESTING: "1" };
  try {
    const first = await pipeScriptAsync(m, [], env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const clone = join(m.home, ".local", "share", "skilletor");
    const link = join(m.home, ".local", "bin", "skilletor");

    const update = await runScriptAsync(m, [], env);
    assert.equal(update.status, 0, update.stdout + update.stderr);
    const retained = readFileSync(join(m.home, "retained-candidates"), "utf8").trim().split("\n");
    for (const candidate of retained) {
      assert.equal(readFileSync(join(candidate, "KEEP"), "utf8"), "retained\n");
    }
    const active = readlinkSync(link);
    assert.notEqual(active, join(clone, "bin", "skilletor-start"));
    assert.ok(retained.every((candidate) => active !== join(candidate, "bin", "skilletor-start")),
      "the launcher does not use a retained candidate");
    assert.ok(existsSync(active), "the launcher points to the separately allocated update");
  } finally {
    await release.close();
  }
});

test("without Node, a failed checkout update leaves the installed starter working", { skip: noNodeSkip }, async () => {
  const release = await serveBinary(FAKE_BINARY);
  const src = sourceRepo("no-node-update", { pinned: pinnedBinary(FAKE_BINARY) });
  const m = noNodeMachine("no-node-update", { claude: false });
  const env = { SKILLETOR_REPO: `file://${src.bare}`, SKILLETOR_BINARY_BASE_URL: release.url, SKILLETOR_STARTER_TESTING: "1" };
  try {
    const first = await pipeScriptAsync(m, [], env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const clone = join(m.home, ".local", "share", "skilletor");
    const link = join(m.home, ".local", "bin", "skilletor");
    const localChange = join(clone, "LOCAL");
    assert.equal(readlinkSync(link), join(clone, "bin", "skilletor-start"));
    writeFileSync(localChange, "leave this checkout alone\n");

    const nextBinary = FAKE_BINARY.replace("fake binary", "next binary");
    writeFileSync(join(src.work, "bin", "skilletor-binaries.sha256"), pinnedBinary(nextBinary));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: src.work, stdio: "pipe" });
    git("add", "bin/skilletor-binaries.sha256");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "new pin");
    git("push", "-q", "origin", "main");

    const retry = await runScriptAsync(m, [], env);
    assert.equal(retry.status, 1, retry.stdout + retry.stderr);
    assert.match(retry.stderr, /does not match its pinned checksum/);
    assert.equal(readlinkSync(link), join(clone, "bin", "skilletor-start"));
    assert.equal(readFileSync(localChange, "utf8"), "leave this checkout alone\n");
    const still = await runCliAsync(m, link, ["--version"]);
    assert.equal(still.status, 0, still.stdout + still.stderr);
    assert.equal(still.stdout, "fake binary 1.2.3\n");
  } finally {
    await release.close();
  }
});


test("without Node, starter provisioning failures leave the existing command and plugin metadata alone", { skip: noNodeSkip }, async () => {
  const bad = FAKE_BINARY.replace("fake binary", "wrong binary");
  const unavailable = await serveBinary(FAKE_BINARY, true);
  const broken = "#!/bin/sh\nexit 1\n";
  const cases = [
    ["checksum", pinnedBinary(FAKE_BINARY), await serveBinary(bad), /does not match its pinned checksum/],
    ["offline", pinnedBinary(FAKE_BINARY), unavailable, /download.*failed/],
    ["preflight", pinnedBinary(broken), await serveBinary(broken), /does not run here/],
    ["missing-pin", undefined, undefined, /no binary checksums are pinned/],
  ] as const;
  try {
    for (const [name, pinned, release, error] of cases) {
      const src = sourceRepo(`no-node-${name}`, { pinned });
      const m = noNodeMachine(`no-node-${name}`);
      const plugin = writePluginMetadata(m);
      const { target, old } = oldLink(m);
      const env = {
        SKILLETOR_REPO: `file://${src.bare}`,
        ...(release ? { SKILLETOR_BINARY_BASE_URL: release.url, SKILLETOR_STARTER_TESTING: "1" } : {}),
      };

      const r = await runScriptAsync(m, [], env);
      assert.equal(r.status, 1);
      assert.match(r.stderr, error);
      assert.equal(readlinkSync(target), old);
      assert.equal(readFileSync(plugin.file, "utf8"), plugin.contents);
      assert.deepEqual(calls(m), []);
    }
  } finally {
    await Promise.all(cases.flatMap(([, , release]) => release ? [release.close()] : []));
  }
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

test("switching from the plugin to a clone replaces the shim with a link", { skip: shimSkip }, () => {
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

test("a Node.js version below 18 stops before calling anything", { skip }, () => {
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
