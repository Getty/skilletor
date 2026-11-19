// The plugin starter bin/skilletor-start (k190): the release binary cached for the plugin's
// version, else downloaded once – by a CLI command, by SessionStart in the background, never by
// --version – and checked against the checksum pinned in the plugin (the house route's
// SHA256SUMS), else Node, else Perl (lib/, script/skilletor), else one line – on `hook …` the
// hook's warning line with exit 0. Wired by k191: bin/skilletor, which every hook command names,
// execs it; the last section starts it the way the harnesses do. Every start gets an
// environment of its own: a temp HOME and CLAUDE_CONFIG_DIR, and a PATH of symlinked tools, so
// a case decides which of curl, wget, sha256sum, shasum, setsid, node and perl exist (with
// neither setsid nor perl a SessionStart provision is a plain background start). A case that
// starts one waits for what it leaves before it ends. The "binary" is a sh script served by a
// local HTTP server (or file://), which the starter fetches only behind its test gate; the
// engines are stubs that print their name, arguments and stdin. Every case runs a temp plugin
// copy, so a pinned checksum file in this checkout changes nothing here.
// POSIX only: Windows starts bin/skilletor.exe, which runs Node (decision k169).
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
/** A dist version, as the house binary route names its assets with. */
const VERSION = "9.876";
const ASSET = `skilletor-${VERSION}-${OS}-${ARCH}`;
const HOOK_INPUT = '{"cwd":"/nowhere","prompt":"hi"}';
const CLI_ARGS = ["status", "--json"];
const HOOK_ARGS = ["hook", "user-prompt-submit"];
const SESSION_START_ARGS = ["hook", "session-start"];
const NON_START_HOOK_ARGS = [
  HOOK_ARGS,
  ["hook", "__sync-background"],
  ["hook", "cwd-changed"],
  ["hook", "post-tool-use"],
];

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

/** The stand-in for the PAR binary: `--version` (or `-v`) "unpacks" into $PAR_GLOBAL_TEMP (a
 *  marker) and prints the version, a run says whether it found the unpacked files there – `warm`
 *  – or had to unpack – `cold`. */
const BINARY = `#!/bin/sh
case $1 in --version | -v) mkdir -p "$PAR_GLOBAL_TEMP" && : >"$PAR_GLOBAL_TEMP/unpacked"; echo ${VERSION}; exit 0 ;; esac
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
// `gate` route answers only once the case releases it; a `stall` route sends the first bytes
// and then nothing.
let server: Server;
let base: string;
interface Route { body: string; hold?: number; gate?: boolean; stall?: boolean; waiting: (() => void)[] }
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
    if (route.gate) {
      route.waiting.push(send);
      return;
    }
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

/** Serve `body` as this case's asset; returns the base URL to give the starter, its hits, and
 *  `release` for a gate: the waiting requests are answered, later ones at once. */
function serve(body: string, how: { hold?: number; gate?: boolean; stall?: boolean } = {}) {
  const prefix = `/case-${++n}`;
  const route: Route = { body, ...how, waiting: [] };
  routes.set(`${prefix}/${ASSET}`, route);
  const release = () => {
    route.gate = false;
    route.waiting.splice(0).forEach((f) => f());
  };
  return { url: base + prefix, hits: () => hits.get(`${prefix}/${ASSET}`) ?? 0, release };
}

/** Wait until `done()` holds – what a background provision leaves once it ends – or fail. */
async function until(done: () => boolean, what: string, ms = 10_000): Promise<void> {
  for (let waited = 0; !done(); waited += 20) {
    assert.ok(waited < ms, `${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The environment that points the starter at a release served here – http://127.0.0.1 or
 *  file:// – which it fetches only behind its test gate (k253). */
const testRelease = (url: string): NodeJS.ProcessEnv => ({ SKILLETOR_BINARY_BASE_URL: url, SKILLETOR_STARTER_TESTING: "1" });

/** A base URL nothing listens on: the machine is offline. */
async function offlineUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** The platforms the house binary route builds for skilletor, in its order. */
const PLATFORMS = ["linux-x86_64", "linux-arm64", "macos-arm64", "windows-x86_64"];

/** The pinned file as the release's SHA256SUMS is: a line per binary, in the house order, the
 *  Windows one with .exe; `sum` on this machine's line, named `asset` (ours by default). */
function pinned(sum: string, asset = ASSET): string {
  const names = PLATFORMS.map((p) => `skilletor-${VERSION}-${p}${p.startsWith("windows") ? ".exe" : ""}`);
  if (!names.includes(ASSET)) names.unshift(ASSET); // a platform the route does not build (macOS x86_64)
  return names.map((name) => (name === ASSET ? `${sum}  ${asset}` : `${sha256(name)}  ${name}`)).join("\n") + "\n";
}

/** The stub port's cpanfile: core modules at runtime, and a test-phase module that is nowhere –
 *  the check reads the runtime phase only. */
const CPANFILE =
  "requires 'perl', '5.020';\nrequires 'JSON::PP', '2.0';\nrequires 'File::Spec';\n\n" +
  "on test => sub {\n  requires 'Skilletor::Test::Only::Dependency';\n};\n";

interface PerlOpts {
  /** The port module that does not compile: a dependency of its own is missing. */
  broken?: "Skilletor::CLI" | "Skilletor::Engine";
  /** cpanfile; null = none (default CPANFILE). */
  cpanfile?: string | null;
}

interface PluginOpts {
  /** The plugin directory's name (default "my plugin": its path has a space). */
  name?: string;
  /** Contents of bin/skilletor-binaries.sha256; absent = no file. */
  pinned?: string;
  /** bin/skilletor-start: there (default), gone, or there but not executable. */
  starter?: "missing" | "not-executable";
  /** dist/skilletor.js present (default true). */
  dist?: boolean;
  /** The stub port at the root – lib/, script/skilletor, cpanfile – (default: one that loads);
   *  false = none of them. */
  perl?: PerlOpts | false;
}

/** A plugin checkout – its path has a space – with the real bin/skilletor, starter and hook
 *  files, and stub engines. Never this checkout's pinned checksums: only `pinned` writes them. */
function makePlugin(opts: PluginOpts = {}): string {
  const root = join(fresh("plugin"), opts.name ?? "my plugin");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "hooks"));
  for (const file of ["skilletor", "skilletor-start"]) {
    if (file === "skilletor-start" && opts.starter === "missing") continue;
    copyFileSync(join(repo, "bin", file), join(root, "bin", file));
    chmodSync(join(root, "bin", file), file === "skilletor-start" && opts.starter ? 0o644 : 0o755);
  }
  for (const file of ["hooks.json", "codex-hooks.json"]) {
    copyFileSync(join(repo, "hooks", file), join(root, "hooks", file));
  }
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
    mkdirSync(join(root, "script"));
    mkdirSync(join(root, "lib", "Skilletor"), { recursive: true });
    writeFileSync(
      join(root, "script", "skilletor"),
      "use strict;\nuse warnings;\nuse Skilletor::CLI;\nexit Skilletor::CLI::run(@ARGV);\n",
    );
    const head = (module: string) =>
      `package ${module};\nuse strict;\nuse warnings;\n` +
      (perl.broken === module ? "use Skilletor::Some::Missing::Dependency;\n" : "");
    writeFileSync(
      join(root, "lib", "Skilletor", "CLI.pm"),
      head("Skilletor::CLI") +
        "sub run { my $in = do { local $/; <STDIN> }; $in = '' unless defined $in; print \"perl @_ | $in\\n\"; return 0 }\n1;\n",
    );
    // The CLI loads it only for a command that runs it, as the real port does.
    writeFileSync(join(root, "lib", "Skilletor", "Engine.pm"), head("Skilletor::Engine") + "1;\n");
    if (perl.cpanfile !== null) writeFileSync(join(root, "cpanfile"), perl.cpanfile ?? CPANFILE);
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

/** An explicit CLI start, then a prompt hook start, of the same plugin on the same machine. */
async function cliThenHook(root: string, m: Machine): Promise<[Run, Run]> {
  const cli = await start(starter(root), CLI_ARGS, m.env);
  const hook = await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT);
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
const retryFile = (m: Machine) => join(versionDir(m), `.${ASSET}.failed-at`);

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

test("the starter and bin/skilletor are POSIX sh: they parse under sh -n (and dash, shellcheck when present)", { skip }, () => {
  for (const file of [starter(repo), join(repo, "bin", "skilletor")]) {
    execFileSync("sh", ["-n", file]);
    const dash = ["/bin/dash", "/usr/bin/dash"].find((p) => existsSync(p));
    if (dash) execFileSync(dash, ["-n", file]);
    if (spawnSync("shellcheck", ["--version"]).status === 0) {
      const r = spawnSync("shellcheck", ["-s", "sh", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout);
    }
  }
});

// k190 asserted that nothing wired named the starter. k191 wires it through bin/skilletor: the
// hooks, npm and the Hermes adapter keep naming bin/skilletor – on Windows a command naming it
// starts its .exe twin, which the starter has not – and bin/skilletor execs the starter beside
// it. That every wired entry really ends in the starter, the "wired:" cases below show.
test("wired (k191): hooks, package and adapter name bin/skilletor, never the starter; bin/skilletor runs the starter", () => {
  for (const file of [
    "hooks/hooks.json", "hooks/codex-hooks.json", "hermes/skilletor/__init__.py",
    "package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
  ]) {
    assert.ok(!readFileSync(join(repo, file), "utf8").includes("skilletor-start"), file);
  }
  const launcher = readFileSync(join(repo, "bin", "skilletor"), "utf8");
  assert.match(launcher, /^start=.*\/skilletor-start$/m);
  assert.match(launcher, /^if \[ -x "\$start" \]; then exec "\$start" "\$@"; fi$/m);
});

// --- no pinned checksums: Node, nothing fetched ------------------------------------------------

test("without pinned checksums it runs Node and fetches nothing", { skip }, async () => {
  const root = makePlugin();
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "node");
  assert.equal(s.hits(), 0);
  assert.ok(!existsSync(join(m.config, "skilletor")), "no binary cache");
});

// --- the binary ------------------------------------------------------------------------------

test("non-start hooks never provision a missing binary", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  for (const args of NON_START_HOOK_ARGS) {
    assertEngine(await start(starter(root), args, m.env, HOOK_INPUT), "node", args, HOOK_INPUT);
  }
  assert.equal(s.hits(), 0);
  assert.ok(!existsSync(join(m.config, "skilletor")), "a non-start hook leaves no cache state");
});

test("a verified cached binary runs before fallbacks and clears a failed SessionStart state", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sum)), BINARY);
  chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
  writeFileSync(retryFile(m), "1000\n");
  const r = await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT);
  assertEngine(r, "binary", HOOK_ARGS, HOOK_INPUT);
  assert.equal(s.hits(), 0);
  assert.ok(!existsSync(retryFile(m)), "a verified cache clears stale retry state");
});

test("a non-start hook refuses an unverified cache even with malformed retry state", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sum)), BINARY.replace("warm", "evil"));
  chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
  mkdirSync(retryFile(m));
  assertEngine(await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT), "node", HOOK_ARGS, HOOK_INPUT);
  assert.equal(s.hits(), 0);
});

test("a failed SessionStart provision backs off by version and platform while CLI retries immediately", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY.replace("warm", "evil"));
  const m = machine(makeTools(["node", "curl", SUM]), { ...testRelease(s.url), SKILLETOR_STARTER_NOW: "1000" });
  const session = (now: string) => ({ ...m.env, SKILLETOR_STARTER_NOW: now });
  const failedAt = (now: string) => () => existsSync(retryFile(m)) && readFileSync(retryFile(m), "utf8") === `${now}\n`;

  // The download runs in the background: the hook has answered by then, the failure is recorded
  // when it ends.
  assertEngine(await start(starter(root), SESSION_START_ARGS, session("1000"), HOOK_INPUT), "node", SESSION_START_ARGS, HOOK_INPUT);
  await until(failedAt("1000"), "the background provision records its failure");
  assert.equal(s.hits(), 1);

  // Backed off before anything starts: nothing runs in the background to wait for.
  assertEngine(await start(starter(root), SESSION_START_ARGS, session("1001"), HOOK_INPUT), "node", SESSION_START_ARGS, HOOK_INPUT);
  assert.equal(s.hits(), 1, "a repeated SessionStart is backed off");

  assertEngine(await start(starter(root), CLI_ARGS, session("1001")), "node", CLI_ARGS, "");
  assert.equal(s.hits(), 2, "an explicit CLI command retries immediately");

  assertEngine(await start(starter(root), SESSION_START_ARGS, session("1900"), HOOK_INPUT), "node", SESSION_START_ARGS, HOOK_INPUT);
  await until(failedAt("1900"), "the 15-minute backoff expires without a sleep");
  assert.equal(s.hits(), 3);
});

test("noncanonical retry timestamps never crash SessionStart hooks", { skip: noBinary }, async () => {
  for (const [failedAt, now] of [["08", "1000"], ["1000", "08"]]) {
    const sum = sha256(BINARY);
    const root = makePlugin({ pinned: pinned(sum) });
    const s = serve(BINARY);
    const m = machine(makeTools(["node", "curl", SUM]), {
      ...testRelease(s.url),
      SKILLETOR_STARTER_NOW: now,
    });
    mkdirSync(versionDir(m), { recursive: true });
    writeFileSync(retryFile(m), `${failedAt}\n`);

    const r = await start(starter(root), SESSION_START_ARGS, m.env, HOOK_INPUT);
    assertEngine(r, "node", SESSION_START_ARGS, HOOK_INPUT);
    await until(() => existsSync(join(versionDir(m), cachedName(sum))) && !existsSync(retryFile(m)),
      `${failedAt}/${now} permits a verified retry, which clears the malformed state`);
    assert.equal(s.hits(), 1);
    assertEngine(await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT), "binary", HOOK_ARGS, HOOK_INPUT);
  }
});

test("a directory retry state cannot break a failed SessionStart fallback", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY.replace("warm", "evil"));
  const m = machine(makeTools(["node", "curl", SUM]), {
    ...testRelease(s.url),
    SKILLETOR_STARTER_NOW: "1000",
  });
  mkdirSync(versionDir(m), { recursive: true });
  mkdirSync(retryFile(m));

  assertEngine(await start(starter(root), SESSION_START_ARGS, m.env, HOOK_INPUT), "node", SESSION_START_ARGS, HOOK_INPUT);
  // The failure's record ends inside the directory (mv into it): the provision is over.
  await until(() => readdirSync(retryFile(m)).length > 0, "the background provision ends");
  assert.equal(s.hits(), 1);
  assert.ok(statSync(retryFile(m)).isDirectory(), "bad retry state is left alone when it cannot be replaced");
});

test("a successful explicit provision clears a failed SessionStart state and serves later hooks from cache", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), { ...testRelease(s.url), SKILLETOR_STARTER_NOW: "1000" });
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(retryFile(m), "1000\n");

  assertEngine(await start(starter(root), CLI_ARGS, m.env), "binary", CLI_ARGS, "");
  assert.ok(!existsSync(retryFile(m)), "successful provision clears retry state");
  assertEngine(await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT), "binary", HOOK_ARGS, HOOK_INPUT);
  assert.equal(s.hits(), 1, "the prompt hook uses the verified cache");
});

test("a pinned binary is downloaded once, checked, warmed and then run from the cache", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  const [hook, cli] = await cliThenHook(root, m);
  assertBoth([hook, cli], "binary");
  assertWarmBinary(hook, m, sum);
  assertWarmBinary(cli, m, sum);
  assert.equal(s.hits(), 1, "downloaded once");
  assertCached(m, sum, BINARY);
});

test("the release's SHA256SUMS as is: another binary of the dist and the .exe line are passed over", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  // Sorted by name, as the house route writes it, a dist's second binary would follow ours –
  // here it comes first, for this platform too, and is still not taken.
  const other = `skilletor-helper-${VERSION}-${OS}-${ARCH}`;
  const root = makePlugin({ pinned: `${sha256(other)}  ${other}\n` + pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  assertEngine(await start(starter(root), CLI_ARGS, m.env), "binary", CLI_ARGS, "");
  assert.equal(s.hits(), 1);
  assertCached(m, sum, BINARY);
});

test("a file:// release works with curl", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const release = fresh("release");
  writeFileSync(join(release, ASSET), BINARY);
  const m = machine(makeTools(["curl", SUM]), testRelease(pathToFileURL(release).href));
  assertBoth(await cliThenHook(root, m), "binary");
  assertCached(m, sum, BINARY);
});

test("without curl it downloads with wget", { skip: noWget }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["wget", SUM]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "binary");
  assert.equal(s.hits(), 1);
  assertCached(m, sum, BINARY);
});

test("without sha256sum it checks with shasum -a 256", { skip: noShasum }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum), dist: false, perl: false });
  const s = serve(BINARY);
  const m = machine(makeTools(["curl", "shasum", ...(realPerl ? ["perl"] : [])]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "binary");
  assertCached(m, sum, BINARY);
});

test("a binary already cached runs without a download, PAR_GLOBAL_TEMP beside it", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  // No CLAUDE_CONFIG_DIR: the cache is under $HOME/.claude.
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url), false);
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sum)), BINARY);
  chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
  const [hook, cli] = await cliThenHook(root, m);
  assertBoth([hook, cli], "binary");
  assert.equal(hook.stdout.split("\n")[1], `par ${join(versionDir(m), `${cachedName(sum)}.par`)} cold`);
  assert.equal(s.hits(), 0);
});

test("a binary cached for other bytes of the same version is not run: the pinned one is fetched", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  const stale = "#!/bin/sh\necho stale\n";
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sha256(stale))), stale);
  chmodSync(join(versionDir(m), cachedName(sha256(stale))), 0o755);
  assertBoth(await cliThenHook(root, m), "binary");
  assert.equal(s.hits(), 1);
});

test("a symlink to the starter finds the pinned checksums beside the real file", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY);
  const m = machine(makeTools(["curl", SUM]), testRelease(s.url));
  const link = join(fresh("links"), "skilletor");
  symlinkSync(starter(root), link);
  assertEngine(await start(link, CLI_ARGS, m.env), "binary", CLI_ARGS, "");
});

test("two first starts at once each download into a temp file of their own; one binary remains", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const root = makePlugin({ pinned: pinned(sum) });
  const s = serve(BINARY, { hold: 2 });
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  const runs = await Promise.all([
    start(starter(root), CLI_ARGS, m.env),
    start(starter(root), CLI_ARGS, m.env),
  ]);
  for (const r of runs) {
    assertEngine(r, "binary", CLI_ARGS, "");
    assertWarmBinary(r, m, sum);
  }
  assert.equal(s.hits(), 2, "both were inside their download at once");
  assertCached(m, sum, BINARY);
});

// --- a download that does not happen or fails: Node, nothing left behind ---------------------

/** Start bin/skilletor's SessionStart hook as Hermes does – a process group of its own – and
 *  collect its answer; fails if it has not answered within `ms`. */
async function sessionStartInGroup(root: string, env: NodeJS.ProcessEnv, ms = 10_000) {
  const child = spawn(join(root, "bin", "skilletor"), SESSION_START_ARGS, { cwd: tmp.dir, env, detached: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.end(HOOK_INPUT);
  let timer: NodeJS.Timeout | undefined;
  const status = await Promise.race([
    new Promise<number | null>((resolve) => child.on("close", resolve)),
    new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms))),
  ]);
  clearTimeout(timer);
  assert.notEqual(status, "late", `the SessionStart hook did not answer within ${ms} ms`);
  return { group: child.pid!, run: { status: status as number | null, stdout, stderr } };
}

/** How the starter leaves a SessionStart provision running: [label, the tools it needs, whether
 *  it is out of the hook's process group]. null: this machine has not the tool. */
const DETACHERS: [string, string[] | null, boolean][] = [
  ["setsid(1)", findOnPath("setsid") ? ["setsid"] : null, true],
  ["perl's setsid()", realPerl ? ["perl"] : null, true],
  ["neither: a plain background start", [], false],
];

// The SessionStart budget (k191): the download may take download_max_time and the warm-up more,
// against hook limits of 30 s (Hermes 20 s) that the sync shares. So the hook never waits: it
// starts the provision in the background and answers with Node; the binary runs from the next
// start on. Here the download is held open until the hook has answered – a hook that waited for
// it would not answer at all – and then the hook's process group is killed, as Hermes kills a
// hook that ran out of time.
test("SessionStart provisions in the background: the hook answers first; out of its process group the provision survives a kill of it", { skip: noBinary }, async () => {
  for (const [label, detacher, survives] of DETACHERS) {
    if (!detacher) continue; // this machine has not the tool: the other detachers still run
    const sum = sha256(BINARY);
    const root = makePlugin({ pinned: pinned(sum) });
    const s = serve(BINARY, { gate: true });
    const m = machine(makeTools(["node", "curl", SUM, ...detacher]), testRelease(s.url));
    const { group, run } = await sessionStartInGroup(root, m.env);
    assertEngine(run, "node", SESSION_START_ARGS, HOOK_INPUT);
    await until(() => s.hits() === 1, `${label}: the background download asks for the asset`);
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // the group is empty: nothing of the hook is left in it
    }
    s.release();
    if (survives) {
      await until(() => existsSync(join(versionDir(m), cachedName(sum))), `${label}: the provision completes`);
    } else {
      // Gone with the hook: no binary, no backoff recorded - the next SessionStart tries again.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!existsSync(join(versionDir(m), cachedName(sum))), `${label}: killed with the hook's group`);
      assert.ok(!existsSync(retryFile(m)), `${label}: a killed provision records no backoff`);
      assertEngine(await start(starter(root), SESSION_START_ARGS, m.env, HOOK_INPUT), "node", SESSION_START_ARGS, HOOK_INPUT);
      await until(() => existsSync(join(versionDir(m), cachedName(sum))), `${label}: the next SessionStart provisions`);
      assert.equal(s.hits(), 2, label);
    }
    await until(() => readdirSync(versionDir(m)).length === 2, `${label}: the provision ends`);
    assertCached(m, sum, BINARY);
    const next = await start(starter(root), HOOK_ARGS, m.env, HOOK_INPUT);
    assertEngine(next, "binary", HOOK_ARGS, HOOK_INPUT);
    assertWarmBinary(next, m, sum);
  }
});

test("a background provision stopped by SIGTERM removes its temp file and backs off", { skip: noBinary }, async () => {
  const detacher = DETACHERS.find(([, tools, out]) => tools && out)?.[1];
  if (!detacher) return; // neither setsid nor perl: the provision would share the hook's group
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY, { stall: true });
  const m = machine(makeTools(["node", "curl", SUM, ...detacher]), {
    ...testRelease(s.url),
    SKILLETOR_STARTER_NOW: "1000",
  });
  const { run } = await sessionStartInGroup(root, m.env);
  assertEngine(run, "node", SESSION_START_ARGS, HOOK_INPUT);
  const temp = () => (existsSync(versionDir(m)) ? readdirSync(versionDir(m)) : []).filter((f) => f.endsWith(".tmp"));
  await until(() => temp().length === 1, "the stalled download has its temp file");
  // .<asset>.<pid>.tmp: the provision's own pid, which leads a session and a group of its own.
  const pid = Number(/\.(\d+)\.tmp$/.exec(temp()[0]!)![1]);
  process.kill(-pid, "SIGTERM"); // as a shutdown stops it, curl with it
  await until(() => existsSync(retryFile(m)), "a stopped provision backs off the next one");
  assert.equal(readFileSync(retryFile(m), "utf8"), "1000\n");
  assert.deepEqual(temp(), [], "no temp file left");
});

test("a checksum mismatch is refused, leaves nothing behind, and Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY.replace("warm", "evil"));
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "node");
  assert.equal(s.hits(), 1, "the explicit CLI start refused it; the prompt hook did not provision");
  assert.ok(!existsSync(versionDir(m)), "no binary, no temp file, no empty version directory");
});

test("a mismatch with neither Node nor Perl: the line names the refusal", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)), perl: false });
  const s = serve("not the pinned bytes");
  const m = machine(makeTools(["curl", SUM]), testRelease(s.url));
  const r = await start(starter(root), CLI_ARGS, m.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`; the downloaded ${ASSET} does not match its pinned checksum and was refused\\.\\n$`));
  assert.ok(!existsSync(versionDir(m)));
});

// k252: a cached binary of other bytes is refused and never run, and every start that falls
// through to the line says so – first, before what happens next – where it said "not cached" or
// gave only its own reason. A cache that is not there still says "not cached".
test("a refused cache is named in the line on every path, an absent one says 'not cached'", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const TAMPERED = BINARY.replace("warm", "evil");
  const refused = `the cached ${ASSET} does not match its pinned checksum and was refused`;
  const line = (why: string) =>
    "skilletor: Node.js is required but was not found on PATH (need >= 18); " +
    `perl was not found on PATH (need >= 5.40); ${why}.`;
  /** A hook: the line as its systemMessage, exit 0. The CLI: the line on stderr, exit 1. */
  const answer = (args: string[], why: string): Run =>
    args[0] === "hook"
      ? { status: 0, stdout: JSON.stringify({ systemMessage: line(why) }) + "\n", stderr: "" }
      : { status: 1, stdout: "", stderr: line(why) + "\n" };
  const tamper = (m: Machine) => {
    mkdirSync(versionDir(m), { recursive: true });
    writeFileSync(join(versionDir(m), cachedName(sum)), TAMPERED);
    chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
  };
  const toFetch = "a SessionStart hook or a CLI command other than --version fetches it";
  const backoff = "the last SessionStart binary provision failed; retrying after 900 seconds";
  // [args, the reason with no cache, the reason with a refused one], in this order: the CLI's
  // failed download records no backoff, the first SessionStart's does.
  const paths: [string[], string, string][] = [
    [["--version"], `the pinned binary is not cached; ${toFetch}`, `${refused}; ${toFetch}`],
    [["-v"], `the pinned binary is not cached; ${toFetch}`, `${refused}; ${toFetch}`],
    [HOOK_ARGS, `the pinned binary is not cached; ${toFetch}`, `${refused}; ${toFetch}`],
    [CLI_ARGS, `the download of ${ASSET} failed`, `${refused}; the download of ${ASSET} failed`],
    [SESSION_START_ARGS, "the pinned binary is not cached; it is being fetched in the background",
      `${refused}; it is being fetched in the background`],
    [SESSION_START_ARGS, backoff, `${refused}; ${backoff}`],
  ];
  for (const tampered of [false, true]) {
    const root = makePlugin({ pinned: pinned(sum), perl: false });
    // Neither Node nor Perl, and every download fails: what the binary step says reaches the line.
    const recorder = fetchRecorder([SUM]);
    const m = machine(recorder.tools, { SKILLETOR_STARTER_NOW: "1000" });
    if (tampered) tamper(m);
    for (const [i, [args, absent, refusal]] of paths.entries()) {
      const label = `${tampered ? "refused" : "absent"} cache, start ${i + 1}: ${args.join(" ")}`;
      assert.deepEqual(await start(starter(root), args, m.env, HOOK_INPUT), answer(args, tampered ? refusal : absent), label);
      if (args === SESSION_START_ARGS) await until(() => existsSync(retryFile(m)), `${label}: the background provision ends`);
    }
    assert.equal(recorder.fetched().length, 2, "the CLI command and the first SessionStart tried the release");
    if (tampered) assert.equal(readFileSync(join(versionDir(m), cachedName(sum)), "utf8"), TAMPERED, "nothing replaced it");
  }

  // What the lines promise: a CLI command fetches the pinned bytes over the refused ones.
  const s = serve(BINARY);
  const m = machine(makeTools(["curl", SUM]), testRelease(s.url));
  tamper(m);
  assertEngine(await start(starter(makePlugin({ pinned: pinned(sum), perl: false })), CLI_ARGS, m.env), "binary", CLI_ARGS, "");
  assert.equal(s.hits(), 1);
  assertCached(m, sum, BINARY);
});

// k253: a base URL in SKILLETOR_BINARY_BASE_URL is fetched only over https://, as the release
// prefix is. Another scheme – the http:// and file:// the cases here serve – only with
// SKILLETOR_STARTER_TESTING=1, as briefing's starter has it (BRIEFING_STARTER_TESTING=1): the
// pinned checksum guards the bytes, the gate keeps a real fetch off plaintext. A refused URL is
// a download that did not happen – nothing fetches, the line says why, SessionStart backs off.
test("SKILLETOR_BINARY_BASE_URL: https:// is fetched; http:// and file:// only with SKILLETOR_STARTER_TESTING=1, else refused with why", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const line = (why: string) =>
    "skilletor: Node.js is required but was not found on PATH (need >= 18); " +
    `perl was not found on PATH (need >= 5.40); ${why}.`;
  const release = fresh("release");
  writeFileSync(join(release, ASSET), BINARY);
  const s = serve(BINARY);
  const refused = `SKILLETOR_BINARY_BASE_URL is not an https:// URL, so ${ASSET} was not downloaded ` +
    "(another scheme is for tests, with SKILLETOR_STARTER_TESTING=1)";
  const cases: [string, string, NodeJS.ProcessEnv][] = [
    ["http://", s.url, {}],
    ["file://", pathToFileURL(release).href, {}],
    ["http:// with the gate not 1", s.url, { SKILLETOR_STARTER_TESTING: "true" }],
  ];
  for (const [label, url, gate] of cases) {
    const root = makePlugin({ pinned: pinned(sum), perl: false });
    const recorder = fetchRecorder([SUM]);
    const m = machine(recorder.tools, { SKILLETOR_BINARY_BASE_URL: url, SKILLETOR_STARTER_NOW: "1000", ...gate });
    assert.deepEqual(await start(starter(root), CLI_ARGS, m.env), { status: 1, stdout: "", stderr: line(refused) + "\n" }, label);
    const session = await start(starter(root), SESSION_START_ARGS, m.env, HOOK_INPUT);
    assert.deepEqual(session, {
      status: 0,
      stdout: JSON.stringify({ systemMessage: line("the pinned binary is not cached; it is being fetched in the background") }) + "\n",
      stderr: "",
    }, label);
    await until(() => existsSync(retryFile(m)), `${label}: the background provision refuses it and backs off`);
    assert.deepEqual(recorder.fetched(), [], `${label}: neither curl nor wget started`);
    assert.ok(!existsSync(join(versionDir(m), cachedName(sum))), label);
  }
  assert.equal(s.hits(), 0);

  // With the gate: what the cases serve is fetched, checked and run.
  for (const url of [s.url, pathToFileURL(release).href]) {
    const m = machine(makeTools(["curl", SUM]), { SKILLETOR_BINARY_BASE_URL: url, SKILLETOR_STARTER_TESTING: "1" });
    assertEngine(await start(starter(makePlugin({ pinned: pinned(sum), perl: false })), CLI_ARGS, m.env), "binary", CLI_ARGS, "");
    assertCached(m, sum, BINARY);
  }
  assert.equal(s.hits(), 1, "the gated http:// download");

  // https:// needs no gate: the download is tried (here it fails), as before.
  const recorder = fetchRecorder([SUM]);
  const m = machine(recorder.tools, { SKILLETOR_BINARY_BASE_URL: "https://mirror.invalid/skilletor" });
  const r = await start(starter(makePlugin({ pinned: pinned(sum), perl: false })), CLI_ARGS, m.env);
  assert.deepEqual(r, { status: 1, stdout: "", stderr: line(`the download of ${ASSET} failed`) + "\n" });
  assert.equal(recorder.fetched().length, 1);
  assert.ok(recorder.fetched()[0]!.includes(`https://mirror.invalid/skilletor/${ASSET}`), recorder.fetched()[0]);
});

test("a binary that does not run here is not cached, and Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BROKEN_BINARY)) });
  const s = serve(BROKEN_BINARY);
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "node");
  assert.ok(!existsSync(versionDir(m)));
});

test("offline: the download fails, Node runs, nothing is left", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const m = machine(makeTools(["node", "curl", SUM]), testRelease(await offlineUrl()));
  assertBoth(await cliThenHook(root, m), "node");
  assert.ok(!existsSync(versionDir(m)));
});

test("neither curl nor wget: no download, Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", SUM]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "node");
  assert.ok(!existsSync(versionDir(m)));
});

test("neither sha256sum nor shasum: nothing is fetched that cannot be checked", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY);
  const m = machine(makeTools(["node", "curl"]), testRelease(s.url));
  assertBoth(await cliThenHook(root, m), "node");
  assert.equal(s.hits(), 0);
});

test("no pinned line for this platform, or a malformed one: no download, Node runs", { skip: noBinary }, async () => {
  const s = serve(BINARY);
  const tools = makeTools(["node", "curl", SUM]);
  for (const file of [
    pinned(sha256(BINARY), `skilletor-${VERSION}-plan9-mips`),
    pinned("F".repeat(64)),
    pinned(sha256(BINARY), `skilletor-..-${OS}-${ARCH}`),
    pinned(sha256(BINARY), `skilletor-helper-${VERSION}-${OS}-${ARCH}`), // another binary's line only
    pinned(sha256(BINARY), `skilletor-${VERSION}_-${OS}-${ARCH}`),
  ]) {
    const m = machine(tools, testRelease(s.url));
    assertBoth(await cliThenHook(makePlugin({ pinned: file }), m), "node");
    assert.ok(!existsSync(join(m.config, "skilletor")));
  }
  assert.equal(s.hits(), 0);
});

test("no HOME and no CLAUDE_CONFIG_DIR: no binary cache, Node runs", { skip: noBinary }, async () => {
  const root = makePlugin({ pinned: pinned(sha256(BINARY)) });
  const s = serve(BINARY);
  const env = { PATH: makeTools(["node", "curl", SUM]), ...testRelease(s.url) };
  assertEngine(await start(starter(root), HOOK_ARGS, env, HOOK_INPUT), "node", HOOK_ARGS, HOOK_INPUT);
  assert.equal(s.hits(), 0);
});

// --- Perl, then the line ---------------------------------------------------------------------

test("no Node: Perl runs once its modules load", { skip: noPerl }, async () => {
  const m = machine(makeTools([], { perl: PERL_540 }));
  assertBoth(await cliThenHook(makePlugin(), m), "perl");
});

test("Node too old, or dist/ missing: Perl runs", { skip: noPerl }, async () => {
  const old = machine(makeTools([], { perl: PERL_540, node: NODE_16 }));
  assertBoth(await cliThenHook(makePlugin(), old), "perl");
  const unbuilt = machine(makeTools(["node"], { perl: PERL_540 }));
  assertBoth(await cliThenHook(makePlugin({ dist: false }), unbuilt), "perl");
});

/** The line: on stderr with exit 1; on a hook its one warning line on stdout, with exit 0. */
async function assertLine(root: string, m: Machine, line: string) {
  const [hook, cli] = await cliThenHook(root, m);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, line + "\n");
  assert.equal(hook.status, 0, "a hook never fails");
  assert.equal(hook.stderr, "");
  assert.equal(hook.stdout, JSON.stringify({ systemMessage: line }) + "\n");
}

test("nothing to run: one line, Node's message first; exit 1, a hook exit 0", { skip }, async () => {
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
    [{ cpanfile: null }, "cpanfile is missing"],
    [false, "script/skilletor is missing"],
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
    assertBoth(await cliThenHook(root, m), "perl");
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

// --- the wired entry points (k191) ------------------------------------------------------------
// What a harness or a user starts: every hook of hooks/hooks.json as Claude Code runs it (exec
// form, ${CLAUDE_PLUGIN_ROOT} replaced, no shell), every hook of hooks/codex-hooks.json as Codex
// runs it (a shell command, CLAUDE_PLUGIN_ROOT in its environment; under a root without a space,
// as the command does not quote it), bin/skilletor as a CLI, and bin/skilletor through a link on
// PATH (npm link, install.sh). The Hermes adapter's way: test/hermes-plugin.test.ts.

interface Entry { label: string; hook: boolean; session: boolean; args: string[]; input: string; run: (env: NodeJS.ProcessEnv) => Promise<Run> }

type HookFile = Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
const hookFile = (root: string, file: string) =>
  (JSON.parse(readFileSync(join(root, "hooks", file), "utf8")) as { hooks: HookFile }).hooks;

/** Two plugin copies made with `opts` – one with a space in its path, one for Codex without –
 *  and every entry point into them, in the order of the hook files. */
function wiredEntries(opts: PluginOpts = {}): Entry[] {
  const claudeRoot = makePlugin(opts);
  const codexRoot = makePlugin({ ...opts, name: "plugin" });
  const out: Entry[] = [];
  for (const [event, groups] of Object.entries(hookFile(claudeRoot, "hooks.json"))) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      const file = h.command.replace("${CLAUDE_PLUGIN_ROOT}", claudeRoot);
      const args = h.args ?? [];
      out.push({
        label: `hooks.json ${event}`, hook: true, session: event === "SessionStart", args, input: HOOK_INPUT,
        run: (env) => start(file, args, { ...env, CLAUDE_PLUGIN_ROOT: claudeRoot }, HOOK_INPUT),
      });
    }
  }
  for (const [event, groups] of Object.entries(hookFile(codexRoot, "codex-hooks.json"))) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      out.push({
        label: `codex-hooks.json ${event}`, hook: true, session: event === "SessionStart",
        args: h.command.split(" ").slice(1), input: HOOK_INPUT,
        run: (env) => start("/bin/sh", ["-c", h.command], { ...env, CLAUDE_PLUGIN_ROOT: codexRoot }, HOOK_INPUT),
      });
    }
  }
  const cli = join(claudeRoot, "bin", "skilletor");
  const link = join(fresh("on-path"), "skilletor");
  symlinkSync(cli, link);
  for (const [label, file] of [["bin/skilletor", cli], ["bin/skilletor linked on PATH", link]]) {
    out.push({ label, hook: false, session: false, args: CLI_ARGS, input: "", run: (env) => start(file, CLI_ARGS, env) });
  }
  return out;
}

/** Tools as makeTools gives them, and a curl and a wget that only write down that they ran. */
function fetchRecorder(links: string[] = [], scripts: Record<string, string> = {}) {
  const record = join(fresh("fetched"), "calls");
  const shim = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${record}'\nexit 7\n`;
  const tools = makeTools(links, { ...scripts, curl: shim, wget: shim });
  const fetched = () => (existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : []);
  return { tools, fetched };
}

/** A hook: exit 0, the one line as its systemMessage on stdout. The CLI: exit 1, the line on stderr. */
function assertFailOpen(r: Run, e: Entry, line: string | RegExp) {
  if (e.hook) {
    assert.equal(r.status, 0, `${e.label}: a hook never fails`);
    assert.equal(r.stderr, "", e.label);
    const answer = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(answer), ["systemMessage"], e.label);
    assert.match(r.stdout, /^\{.*\}\n$/, `${e.label}: one line`);
    if (typeof line === "string") assert.equal(answer.systemMessage, line, e.label);
    else assert.match(answer.systemMessage as string, line, e.label);
  } else {
    assert.equal(r.status, 1, e.label);
    assert.equal(r.stdout, "", e.label);
    if (typeof line === "string") assert.equal(r.stderr, line + "\n", e.label);
    else assert.match(r.stderr, line, e.label);
  }
}

test("wired: without pinned checksums every hook and the CLI run Node, and nothing is fetched", { skip }, async () => {
  const recorder = fetchRecorder(["node", ...(noBinary ? [] : [SUM])]);
  const m = machine(recorder.tools);
  const entries = wiredEntries();
  assert.equal(entries.length, 8, entries.map((e) => e.label).join(", "));
  for (const e of entries) assertEngine(await e.run(m.env), "node", e.args, e.input);
  assert.deepEqual(recorder.fetched(), []);
  assert.ok(!existsSync(join(m.config, "skilletor")), "no binary cache");
});

// The state after the first release, while the binary is not cached yet: a pin in the plugin
// changes nothing a non-start hook does or answers. Only SessionStart (in the background) and an
// explicit CLI command may try a download (here one that fails); they answer as without a pin
// too. A SessionStart's background provision is waited for before the next entry runs: its
// recorded failure is what it leaves once it ends.
test("wired: a pinned binary that is not cached – non-start hooks fetch nothing, and every answer is as without a pin", { skip: noBinary }, async () => {
  const recorder = fetchRecorder(["node", SUM]);
  const m = machine(recorder.tools, { SKILLETOR_STARTER_NOW: "1000" });
  const unpinned = wiredEntries();
  const pinnedEntries = wiredEntries({ pinned: pinned(sha256(BINARY)) });
  for (const [i, e] of pinnedEntries.entries()) {
    const without = await unpinned[i]!.run(m.env);
    const before = recorder.fetched().length;
    const withPin = await e.run(m.env);
    assertEngine(withPin, "node", e.args, e.input);
    assert.deepEqual(withPin, without, e.label);
    if (e.session) await until(() => existsSync(retryFile(m)), `${e.label}: the background provision ends`);
    if (e.hook && !e.session) assert.equal(recorder.fetched().length, before, `${e.label} fetched`);
  }
  const fetched = recorder.fetched();
  assert.ok(fetched.length > 0, "SessionStart or the CLI tried the release");
  // The house route tags a release with the bare version.
  for (const call of fetched) assert.ok(call.includes(`https://github.com/Getty/skilletor/releases/download/${VERSION}/${ASSET}`), call);
});

// --version and -v answer from the runtime that runs, as it prints them – ack-doctor reads it
// (hub finding ACK c14) – and never provision: a pin without a cached binary fetches nothing.
test("wired: --version and -v never provision; they answer from Node, else Perl, else a cached binary, as the engine prints it", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  for (const flag of ["--version", "-v"]) {
    const root = makePlugin({ pinned: pinned(sum) });
    const cli = join(root, "bin", "skilletor");
    const answer = (stdout: string): Run => ({ status: 0, stdout, stderr: "" });

    const withNode = fetchRecorder(["node", SUM]);
    const m = machine(withNode.tools);
    assert.deepEqual(await start(cli, [flag], m.env), answer(`node ${flag} | \n`), `${flag}: Node`);
    assert.deepEqual(withNode.fetched(), [], `${flag}: nothing fetched with Node`);
    assert.ok(!existsSync(join(m.config, "skilletor")), `${flag}: no binary cache state`);

    if (realPerl) {
      const withPerl = fetchRecorder([SUM], { perl: PERL_540 });
      assert.deepEqual(await start(cli, [flag], machine(withPerl.tools).env), answer(`perl ${flag} | \n`), `${flag}: Perl`);
      assert.deepEqual(withPerl.fetched(), [], `${flag}: nothing fetched with Perl`);
    }

    // Nothing to run: the line, and still no download.
    const bare = fetchRecorder([SUM]);
    const r = await start(cli, [flag], machine(bare.tools).env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /; the pinned binary is not cached; a SessionStart hook or a CLI command other than --version fetches it\.\n$/);
    assert.deepEqual(bare.fetched(), [], `${flag}: nothing fetched with nothing to run`);

    // A cached, verified binary answers itself, before Node.
    mkdirSync(versionDir(m), { recursive: true });
    writeFileSync(join(versionDir(m), cachedName(sum)), BINARY);
    chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
    assert.deepEqual(await start(cli, [flag], m.env), answer(`${VERSION}\n`), `${flag}: the binary`);
    assert.deepEqual(withNode.fetched(), []);
  }
});

test("wired: without Node every hook and the CLI run Perl, and nothing is fetched", { skip: noPerl }, async () => {
  const recorder = fetchRecorder([], { perl: PERL_540 });
  const m = machine(recorder.tools);
  for (const e of wiredEntries()) assertEngine(await e.run(m.env), "perl", e.args, e.input);
  assert.deepEqual(recorder.fetched(), []);
});

test("wired: with neither Node nor Perl on PATH a cached, verified binary runs every hook and the CLI", { skip: noBinary }, async () => {
  const sum = sha256(BINARY);
  const recorder = fetchRecorder([SUM]);
  const m = machine(recorder.tools);
  mkdirSync(versionDir(m), { recursive: true });
  writeFileSync(join(versionDir(m), cachedName(sum)), BINARY);
  chmodSync(join(versionDir(m), cachedName(sum)), 0o755);
  for (const e of wiredEntries({ pinned: pinned(sum) })) assertEngine(await e.run(m.env), "binary", e.args, e.input);
  assert.deepEqual(recorder.fetched(), []);
});

test("wired: with nothing to run every hook exits 0 with the one warning line; the CLI exits 1", { skip }, async () => {
  const recorder = fetchRecorder();
  const m = machine(recorder.tools, { SKILLETOR_STARTER_NOW: "1000" });
  const line = "skilletor: Node.js is required but was not found on PATH (need >= 18); " +
    "perl was not found on PATH (need >= 5.40); no binary checksums are pinned in the plugin.";
  for (const e of wiredEntries()) assertFailOpen(await e.run(m.env), e, line);
  assert.deepEqual(recorder.fetched(), []);
  if (noBinary) return;
  // Pinned but not cached, and the download fails: the line ends with why, a hook still exits 0.
  const pinnedRecorder = fetchRecorder([SUM]);
  const pm = machine(pinnedRecorder.tools, { SKILLETOR_STARTER_NOW: "1000" });
  const why = /^skilletor: Node\.js is required [^;]*; perl was not found [^;]*; (the pinned binary is not cached|the download of|the last SessionStart binary provision failed).*\.\n?$/;
  for (const e of wiredEntries({ pinned: pinned(sha256(BINARY)) })) {
    assertFailOpen(await e.run(pm.env), e, why);
    if (e.session) await until(() => existsSync(retryFile(pm)), `${e.label}: the background provision ends`);
  }
  assert.ok(pinnedRecorder.fetched().length > 0, "SessionStart or the CLI tried the release");
});

test("wired: bin/skilletor without a runnable starter still exits 0 on every hook, with one line", { skip }, async () => {
  const m = machine(makeTools(["node"]));
  const line = "skilletor: bin/skilletor-start is missing or not executable; reinstall skilletor.";
  for (const starterState of ["missing", "not-executable"] as const) {
    for (const e of wiredEntries({ starter: starterState })) assertFailOpen(await e.run(m.env), e, line);
  }
});
