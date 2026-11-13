// The plugin starter bin/skilletor-start (k190), prepared and not wired: the release binary
// cached for the plugin's version, else downloaded once and checked against the checksum
// pinned in the plugin, else Node, else Perl, else one line – on `hook …` the hook's warning
// line with exit 0. Every start gets an environment of its own: a temp HOME and
// CLAUDE_CONFIG_DIR, and a PATH of symlinked tools, so a case decides which of curl, wget,
// sha256sum, shasum, node and perl exist. The "binary" is a sh script served by a local HTTP
// server (or file://); the engines are stubs that print their name, arguments and stdin.
// POSIX only: Windows starts bin/skilletor.exe (decision k169).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const skip = process.platform === "win32" ? "the sh starter does not run on Windows (k169)" : false;
const OS = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : "";
const ARCH = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : "";
const noBinary = skip || (!OS || !ARCH ? `no binary is built for ${process.platform}-${process.arch}` : false);
const VERSION = "9.8.7";
const ASSET = `skilletor-${VERSION}-${OS}-${ARCH}`;
const HOOK_INPUT = '{"cwd":"/nowhere","prompt":"hi"}';
const CLI_ARGS = ["status", "--json"];
const HOOK_ARGS = ["hook", "user-prompt-submit"];

/** What every case's PATH holds: the starter's own tools, and cat for the stub binary. */
const BASE_TOOLS = ["uname", "mkdir", "mv", "rm", "rmdir", "chmod", "env", "readlink", "dirname", "cat"];

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // not here
    }
  }
  return undefined;
}

const realPerl = findOnPath("perl");
const noPerl = skip || (realPerl ? false : "no perl on PATH");
const noWget = noBinary || (findOnPath("wget") ? false : "no wget on PATH");
const noShasum = noBinary || (findOnPath("shasum") ? false : "no shasum on PATH");
/** The checksum tool the cases link: sha256sum, else (macOS) shasum. */
const SUM = findOnPath("sha256sum") ? "sha256sum" : "shasum";

/** The stand-in for the PAR binary: `--version` "unpacks" into $PAR_GLOBAL_TEMP (a marker), a
 *  run says whether it found the unpacked files there – `warm` – or had to unpack – `cold`. */
const BINARY = `#!/bin/sh
if [ "$1" = --version ]; then mkdir -p "$PAR_GLOBAL_TEMP" && : >"$PAR_GLOBAL_TEMP/unpacked"; echo ${VERSION}; exit 0; fi
if [ -f "$PAR_GLOBAL_TEMP/unpacked" ]; then state=warm; else state=cold; fi
printf 'binary %s | %s\\npar %s %s\\n' "$*" "$(cat)" "$PAR_GLOBAL_TEMP" "$state"
`;
/** A binary that does not run on this machine. */
const BROKEN_BINARY = "#!/bin/sh\necho 'cannot execute: wrong libc' >&2\nexit 1\n";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

let tmp: TmpDir;
let n = 0;
const fresh = (name: string) => {
  const dir = join(tmp.dir, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// --- the server: one route per case, a hit count per route; a `hold` route answers only once
// that many requests wait (or after 5 s), so two starts are inside their downloads at once; a
// `stall` route sends the first bytes and then nothing.
let server: Server;
let base: string;
interface Route { body: string; hold?: number; stall?: boolean; waiting: (() => void)[] }
const routes = new Map<string, Route>();
const hits = new Map<string, number>();

before(async () => {
  tmp = makeTmpDir();
  if (skip) return;
  server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.set(url, (hits.get(url) ?? 0) + 1);
    const route = routes.get(url);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    if (route.stall) {
      res.write(route.body.slice(0, 10));
      return;
    }
    const send = (): ServerResponse => res.end(route.body);
    if (!route.hold) return send();
    route.waiting.push(send);
    const flush = () => route.waiting.splice(0).forEach((f) => f());
    if (route.waiting.length >= route.hold) flush();
    else setTimeout(flush, 5_000).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections(); // a stalled download's
    await new Promise((resolve) => server.close(resolve));
  }
  tmp?.cleanup();
});

/** Serve `body` as this case's asset; returns the base URL to give the starter, and its hits. */
function serve(body: string, how: { hold?: number; stall?: boolean } = {}) {
  const prefix = `/case-${++n}`;
  routes.set(`${prefix}/${ASSET}`, { body, ...how, waiting: [] });
  return { url: base + prefix, hits: () => hits.get(`${prefix}/${ASSET}`) ?? 0 };
}

/** A base URL nothing listens on: the machine is offline. */
async function offlineUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** The pinned file: the tarball's line first (skipped) and another platform's, then ours. */
function pinned(sum: string, asset = ASSET): string {
  return [
    `${sha256("tarball")}  ${asset}.tar.gz`,
    `${sha256("windows")}  skilletor-${VERSION}-windows-x86_64.exe`,
    `${sum}  ${asset}`,
    "",
  ].join("\n");
}

/** The stub port's cpanfile: core modules at runtime, and a test-phase module that is nowhere –
 *  the check reads the runtime phase only. */
const CPANFILE =
  "requires 'perl', '5.020';\nrequires 'JSON::PP', '2.0';\nrequires 'File::Spec';\n\n" +
  "on test => sub {\n  requires 'Skilletor::Test::Only::Dependency';\n};\n";

interface PerlOpts {
  /** The port module that does not compile: a dependency of its own is missing. */
  broken?: "Skilletor::CLI" | "Skilletor::Engine";
  /** perl/cpanfile; null = none (default CPANFILE). */
  cpanfile?: string | null;
}

interface PluginOpts {
  /** Contents of bin/skilletor-binaries.sha256; absent = no file. */
  pinned?: string;
  /** dist/skilletor.js present (default true). */
  dist?: boolean;
  /** The stub port under perl/ (default: one that loads); false = no perl/. */
  perl?: PerlOpts | false;
}

/** A plugin checkout – its path has a space – with the real starter and stub engines. */
function makePlugin(opts: PluginOpts = {}): string {
  const root = join(fresh("plugin"), "my plugin");
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(join(repo, "bin", "skilletor-start"), join(root, "bin", "skilletor-start"));
  chmodSync(join(root, "bin", "skilletor-start"), 0o755);
  if (opts.pinned !== undefined) writeFileSync(join(root, "bin", "skilletor-binaries.sha256"), opts.pinned);
  if (opts.dist !== false) {
    mkdirSync(join(root, "dist"));
    writeFileSync(
      join(root, "dist", "skilletor.js"),
      'process.stdout.write(`node ${process.argv.slice(2).join(" ")} | ${require("node:fs").readFileSync(0, "utf8")}\\n`);\n',
    );
  }
  const perl = opts.perl ?? {};
  if (perl) {
    mkdirSync(join(root, "perl", "bin"), { recursive: true });
    mkdirSync(join(root, "perl", "lib", "Skilletor"), { recursive: true });
    writeFileSync(
      join(root, "perl", "bin", "skilletor"),
      "use strict;\nuse warnings;\nuse Skilletor::CLI;\nexit Skilletor::CLI::run(@ARGV);\n",
    );
    const head = (module: string) =>
      `package ${module};\nuse strict;\nuse warnings;\n` +
      (perl.broken === module ? "use Skilletor::Some::Missing::Dependency;\n" : "");
    writeFileSync(
      join(root, "perl", "lib", "Skilletor", "CLI.pm"),
      head("Skilletor::CLI") +
        "sub run { my $in = do { local $/; <STDIN> }; $in = '' unless defined $in; print \"perl @_ | $in\\n\"; return 0 }\n1;\n",
    );
    // The CLI loads it only for a command that runs it, as the real port does.
    writeFileSync(join(root, "perl", "lib", "Skilletor", "Engine.pm"), head("Skilletor::Engine") + "1;\n");
    if (perl.cpanfile !== null) writeFileSync(join(root, "perl", "cpanfile"), perl.cpanfile ?? CPANFILE);
  }
  return root;
}

const starter = (root: string) => join(root, "bin", "skilletor-start");

/** A PATH directory with BASE_TOOLS and `links` symlinked from this machine (node: the node
 *  running the tests), plus `scripts` written as executables. */
function makeTools(links: string[] = [], scripts: Record<string, string> = {}): string {
  const dir = fresh("tools");
  for (const name of [...BASE_TOOLS, ...links]) {
    const target = name === "node" ? process.execPath : findOnPath(name);
    assert.ok(target, `${name} is not on this machine's PATH`);
    symlinkSync(target, join(dir, name));
  }
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** perl, except that it answers the starter's version question – the one whose code reads
 *  `$]` – with `answer`: the Perl path runs on a machine whose perl is older than 5.40. */
const fakePerl = (answer: string) =>
  `#!/bin/sh\ncase "$*" in *'$]'*) printf '%s' '${answer}'; exit 0 ;; esac\nexec '${realPerl}' "$@"\n`;
const PERL_540 = fakePerl("5040 5.40.0");
const NODE_16 = "#!/bin/sh\ncase \"$1\" in -e) printf 16 ;; --version) echo v16.20.2 ;; *) echo \"node 16 ran $*\" >&2; exit 9 ;; esac\n";

interface Machine { env: NodeJS.ProcessEnv; config: string; home: string }

/** The environment of one start: nothing of the test process's, so no CLAUDE_CONFIG_DIR,
 *  PERL5LIB or PAR_GLOBAL_TEMP of the developer's leaks in. */
function machine(tools: string, extra: NodeJS.ProcessEnv = {}, withConfigDir = true): Machine {
  const home = fresh("home");
  const config = withConfigDir ? fresh("claude-config") : join(home, ".claude");
  const env: NodeJS.ProcessEnv = { PATH: tools, HOME: home, ...extra };
  if (withConfigDir) env.CLAUDE_CONFIG_DIR = config;
  return { env, config, home };
}

interface Run { status: number | null; stdout: string; stderr: string }

/** Start `file` with `input` on stdin; async, so the in-process server can answer. */
function start(file: string, args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: tmp.dir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.stdin.on("error", () => {}); // a start that never reads its stdin
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** A hook start, then a CLI start, of the same plugin on the same machine. */
async function hookThenCli(root: string, m: Machine): Promise<[Run, Run]> {
  const hook = await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT);
  const cli = await start(starter(root), CLI_ARGS, m.env);
  return [hook, cli];
}

/** The engine ran, with the start's arguments and stdin: on a hook, exit 0 too. */
function assertEngine(r: Run, engine: string, args: string[], input: string) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n")[0], `${engine} ${args.join(" ")} | ${input}`);
  assert.equal(r.stderr, "");
}

function assertBoth([hook, cli]: [Run, Run], engine: string) {
  assertEngine(hook, engine, HOOK_ARGS, HOOK_INPUT);
  assertEngine(cli, engine, CLI_ARGS, "");
}

const versionDir = (m: Machine) => join(m.config, "skilletor", "bin", VERSION);
const cachedName = (sum: string) => `${ASSET}-${sum}`;

/** The binary cache holds exactly the binary and its unpacked files: no temp file. */
function assertCached(m: Machine, sum: string, body: string) {
  const file = join(versionDir(m), cachedName(sum));
  assert.deepEqual(readdirSync(versionDir(m)).sort(), [cachedName(sum), `${cachedName(sum)}.par`]);
  assert.equal(readFileSync(file, "utf8"), body);
  assert.equal(statSync(file).mode & 0o777, 0o755);
}

/** The binary's run, warm: PAR_GLOBAL_TEMP beside the cached binary, unpacked before it ran. */
function assertWarmBinary(r: Run, m: Machine, sum: string) {
  const par = join(versionDir(m), `${cachedName(sum)}.par`);
  assert.equal(r.stdout.split("\n")[1], `par ${par} warm`);
}

// --- the file itself -------------------------------------------------------------------------

test("the starter is POSIX sh: it parses under sh -n (and dash, shellcheck when present)", { skip }, () => {
  const file = starter(repo);
  execFileSync("sh", ["-n", file]);
  const dash = ["/bin/dash", "/usr/bin/dash"].find((p) => existsSync(p));
  if (dash) execFileSync(dash, ["-n", file]);
  if (spawnSync("shellcheck", ["--version"]).status === 0) {
    const r = spawnSync("shellcheck", ["-s", "sh", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
  }
});

test("prepared, not wired: no hook, launcher, adapter or package entry starts it (k191 wires it)", () => {
  for (const file of [
    "hooks/hooks.json", "hooks/codex-hooks.json", "bin/skilletor", "hermes/skilletor/__init__.py",
    "package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
  ]) {
    assert.ok(!readFileSync(join(repo, file), "utf8").includes("skilletor-start"), file);
  }
});

// --- no pinned checksums: Node, nothing fetched ------------------------------------------------

test("without pinned checksums it runs Node and fetches nothing", { skip }, async () => {
  const root = makePlugin();
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "node");
  assert.equal(s.hits(), 0);
  assert.ok(!existsSync(join(m.config, "skilletor")), "no binary cache");
});

// --- the binary ------------------------------------------------------------------------------

test("a pinned binary is downloaded once, checked, warmed and then run from the cache", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  const [hook, cli] = await hookThenCli(root, m);
  assertBoth([hook, cli], "binary");
  assertWarmBinary(hook, m, sum);
  assertWarmBinary(cli, m, sum);
  assert.equal(s.hits(), 1, "downloaded once");
  assertCached(m, sum, BINARY);
});

test("a file:// release works with curl", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const release = fresh("release");
  writeFileSync(join(release, ASSET), BINARY);
  const m = machine(makeTools(["curl", SUM]), { SKILLETOR_BINARY_BASE_URL: pathToFileURL(release).href });
  assertBoth(await hookThenCli(root, m), "binary");
  assertCached(m, sum, BINARY);
});

test("without curl it downloads with wget", { skip: noWget }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["wget", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "binary");
  assert.equal(s.hits(), 1);
  assertCached(m, sum, BINARY);
});

test("without sha256sum it checks with shasum -a 256", { skip: noShasum }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum), dist: false, perl: false });
  const s = serve(BINARY);
  const m = machine(makeTools(["curl", "shasum", ...(realPerl ? ["perl"] : [])]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "binary");
  assertCached(m, sum, BINARY);
});

test("a binary already cached runs without a download, PAR_GLOBAL_TEMP beside it", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  // No CLAUDE_CONFIG_DIR: the cache is under $HOME/.claude.
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url }, false);
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sum)), BINARY);
  chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
  const [hook, cli] = await hookThenCli(root, m);
  assertBoth([hook, cli], "binary");
  assert.equal(hook.stdout.split("\n")[1], `par ${join(versionDir(m), `${cachedName(sum)}.par`)} cold`);
  assert.equal(s.hits(), 0);
});

test("a binary cached for other bytes of the same version is not run: the pinned one is fetched", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  const stale = "#!/bin/sh\necho stale\n";
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sha256(stale))), stale);
  chmodSync(join(versionDir(m), cachedName(sha256(stale))), 0o755);
  assertBoth(await hookThenCli(root, m), "binary");
  assert.equal(s.hits(), 1);
});

test("a symlink to the starter finds the pinned checksums beside the real file", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  const link = join(fresh("links"), "skilletor");
  symlinkSync(starter(root), link);
  assertEngine(await start(link, HOOK_ARGS, m.env, HOOK_INPUT), "binary", HOOK_ARGS, HOOK_INPUT);
});

test("two first starts at once each download into a temp file of their own; one binary remains", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY, { hold: 2 });
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  const runs = await Promise.all([
    start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT),
    start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT),
  ]);
  for (const r of runs) {
    assertEngine(r, "binary", HOOK_ARGS, HOOK_INPUT);
    assertWarmBinary(r, m, sum);
  }
  assert.equal(s.hits(), 2, "both were inside their download at once");
  assertCached(m, sum, BINARY);
});

// --- a download that does not happen or fails: Node, nothing left behind ---------------------

test("a start stopped inside its download removes its temp file; a hook still exits 0", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY, { stall: true });
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  // Its own process group: stopped as a harness stops a hook that ran out of time, curl with it.
  const child = spawn(starter(root), HOOK_ARGS, { cwd: tmp.dir, env: m.env, detached: true });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.stdin.end(HOOK_INPUT);
  const temp = () => (existsSync(versionDir(m)) ? readdirSync(versionDir(m)) : []).filter((f) => f.endsWith(".tmp"));
  for (let waited = 0; temp().length === 0; waited += 20) {
    assert.ok(waited < 5_000, "the download never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.kill(-child.pid!, "SIGTERM");
  assert.equal(await closed, 0);
  assert.ok(!existsSync(versionDir(m)) || temp().length === 0, "no temp file left");
});

test("a checksum mismatch is refused, leaves nothing behind, and Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY.replace("warm", "evil"));
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "node");
  assert.equal(s.hits(), 2, "refused at each start, never cached");
  assert.ok(!existsSync(versionDir(m)), "no binary, no temp file, no empty version directory");
});

test("a mismatch with neither Node nor Perl: the line names the refusal", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)), perl: false });
  const s = serve("not the pinned bytes");
  const m = machine(makeTools(["curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  const r = await start(starter(root), CLI_ARGS, m.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`; the downloaded ${ASSET} does not match its pinned checksum and was refused\\.\\n$`));
  assert.ok(!existsSync(versionDir(m)));
});

test("a binary that does not run here is not cached, and Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BROKEN_BINARY)) });
  const s = serve(BROKEN_BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "node");
  assert.ok(!existsSync(versionDir(m)));
});

test("offline: the download fails, Node runs, nothing is left", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const m = machine(makeTools(["node", "curl", SUM]), { SKILLETOR_BINARY_BASE_URL: await offlineUrl() });
  assertBoth(await hookThenCli(root, m), "node");
  assert.ok(!existsSync(versionDir(m)));
});

test("neither curl nor wget: no download, Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", SUM]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "node");
  assert.ok(!existsSync(versionDir(m)));
});

test("neither sha256sum nor shasum: nothing is fetched that cannot be checked", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl"]), { SKILLETOR_BINARY_BASE_URL: s.url });
  assertBoth(await hookThenCli(root, m), "node");
  assert.equal(s.hits(), 0);
});

test("no pinned line for this platform, or a malformed one: no download, Node runs", { skip: noBinary }, async () => {
  const s = serve(BINARY);
  const tools = makeTools(["node", "curl", SUM]);
  for (const file of [
    pinned(sha256(BINARY), `skilletor-${VERSION}-plan9-mips`),
    pinned("F".repeat(64)),
    pinned(sha256(BINARY), `skilletor-..-${OS}-${ARCH}`),
  ]) {
    const m = machine(tools, { SKILLETOR_BINARY_BASE_URL: s.url });
    assertBoth(await hookThenCli(makePlugin({ pinned: file }), m), "node");
    assert.ok(!existsSync(join(m.config, "skilletor")));
  }
  assert.equal(s.hits(), 0);
});

test("no HOME and no CLAUDE_CONFIG_DIR: no binary cache, Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY);
  const env = { PATH: makeTools(["node", "curl", SUM]), SKILLETOR_BINARY_BASE_URL: s.url };
  assertEngine(await start(starter(root), HOOK_ARGS, env, HOOK_INPUT), "node", HOOK_ARGS, HOOK_INPUT);
  assert.equal(s.hits(), 0);
});

// --- Perl, then the line ---------------------------------------------------------------------

test("no Node: Perl runs once its modules load", { skip: noPerl }, async () => {
  const m = machine(makeTools([], { perl: PERL_540 }));
  assertBoth(await hookThenCli(makePlugin(), m), "perl");
});

test("Node too old, or dist/ missing: Perl runs", { skip: noPerl }, async () => {
  const old = machine(makeTools([], { perl: PERL_540, node: NODE_16 }));
  assertBoth(await hookThenCli(makePlugin(), old), "perl");
  const unbuilt = machine(makeTools(["node"], { perl: PERL_540 }));
  assertBoth(await hookThenCli(makePlugin({ dist: false }), unbuilt), "perl");
});

/** The line: on stderr with exit 1; on a hook its one warning line on stdout, with exit 0. */
async function assertLine(root: string, m: Machine, line: string) {
  const [hook, cli] = await hookThenCli(root, m);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, line + "\n");
  assert.equal(hook.status, 0, "a hook never fails");
  assert.equal(hook.stderr, "");
  assert.equal(hook.stdout, JSON.stringify({ systemMessage: line }) + "\n");
}

test("nothing to run: one line, bin/skilletor's Node message first; exit 1, a hook exit 0", { skip }, async () => {
  await assertLine(
    makePlugin(),
    machine(makeTools()),
    "skilletor: Node.js is required but was not found on PATH (need >= 18); " +
      "perl was not found on PATH (need >= 5.40); no binary checksums are pinned in the plugin.",
  );
});

test("Node too old and Perl too old: the line names both versions", { skip: noPerl }, async () => {
  await assertLine(
    makePlugin(),
    machine(makeTools([], { perl: fakePerl("5038 5.38.2"), node: NODE_16 })),
    "skilletor: Node.js >= 18 is required, but found v16.20.2; " +
      "Perl >= 5.40 is required, but found 5.38.2; no binary checksums are pinned in the plugin.",
  );
});

test("a Perl port that cannot run – a module, a dependency or its version, a file – : the line names why", { skip: noPerl }, async () => {
  const cases: [PluginOpts["perl"], string][] = [
    [{ broken: "Skilletor::CLI" }, "Skilletor::CLI does not load"],
    // The CLI loads, the engine its commands load does not.
    [{ broken: "Skilletor::Engine" }, "Skilletor::Engine does not load"],
    // A dependency the port loads only when a command needs it (as Text::Nunjucks): the
    // cpanfile names it.
    [{ cpanfile: CPANFILE + "requires 'Skilletor::Test::Lazy::Dependency';\n" }, "Skilletor::Test::Lazy::Dependency is missing"],
    [{ cpanfile: CPANFILE.replace("'2.0'", "'999'") }, "JSON::PP is older than 999"],
    [{ cpanfile: null }, "perl/cpanfile is missing"],
    [false, "perl/bin/skilletor is missing"],
  ];
  for (const [perl, problem] of cases) {
    await assertLine(
      makePlugin({ perl }),
      machine(makeTools([], { perl: PERL_540 })),
      "skilletor: Node.js is required but was not found on PATH (need >= 18); " +
        `skilletor's Perl port cannot run: ${problem}; no binary checksums are pinned in the plugin.`,
    );
  }
});

test("this machine's own perl: the starter reads its version", { skip: noPerl }, async () => {
  const m = machine(makeTools(["perl"]));
  const root = makePlugin();
  const recent = execFileSync(realPerl!, ["-e", "print $] >= 5.040 ? 1 : 0"], { encoding: "utf8" }) === "1";
  if (recent) {
    assertBoth(await hookThenCli(root, m), "perl");
  } else {
    const found = execFileSync(realPerl!, ["-e", 'printf "%vd", $^V'], { encoding: "utf8" });
    await assertLine(
      root,
      m,
      "skilletor: Node.js is required but was not found on PATH (need >= 18); " +
        `Perl >= 5.40 is required, but found ${found}; no binary checksums are pinned in the plugin.`,
    );
  }
});
