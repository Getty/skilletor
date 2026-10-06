// k99: a source file's executable bit survives render and apply (spec §5, §6.2) – for local,
// git and url sources, a skill under `skills/` and one in the Claude project layout
// (`.claude/skills/`) alike. The lock hashes content only: a file whose bytes match but whose
// bit does not is rewritten by the next sync, reported as an update and never as a local
// overwrite, and `check` does not count it.
//
// k107: what an earlier version installed – scripts without their bit, a `url` cache
// extracted without modes – gets the bit in the first session after the upgrade, once.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { check, sync, type EngineContext } from "../src/engine.ts";
import { hashBuffer } from "../src/fsutil.ts";
import { readLock } from "../src/lock.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { URL_VERSION_FILE } from "../src/sources/url.ts";

const SKILL = (n: string) => `---\nname: ${n}\ndescription: ${n} skill\n---\nRun the scripts.\n`;

/** A published skill and one in the Claude project layout (App::karr's shape), each with an
 *  executable script next to plain files; `gen.sh.njk` is an executable template, and the
 *  `.gitignore` skilletor replaces with its own (spec §6.4) comes executable too. */
const FILES: { path: string; data: string; exec: boolean }[] = [
  { path: "skills/pub/SKILL.md", data: SKILL("pub"), exec: false },
  { path: "skills/pub/scripts/run.sh", data: "#!/bin/sh\necho pub\n", exec: true },
  { path: "skills/pub/scripts/gen.sh.njk", data: "#!/bin/sh\necho {{ item.name }}\n", exec: true },
  { path: "skills/pub/.gitignore", data: "*.tmp\n", exec: true },
  { path: ".claude/skills/proj/SKILL.md", data: SKILL("proj"), exec: false },
  { path: ".claude/skills/proj/scripts/benchmark.sh", data: "#!/bin/sh\necho bench\n", exec: true },
  { path: ".claude/skills/proj/references/notes.md", data: "notes\n", exec: false },
];

/** Installed path (under `~/.claude`) -> whether it must be executable. */
const INSTALLED: [string, boolean][] = [
  ["skills/pub/SKILL.md", false],
  ["skills/pub/scripts/run.sh", true],
  ["skills/pub/scripts/gen.sh", true],
  ["skills/pub/.gitignore", false],
  ["skills/proj/SKILL.md", false],
  ["skills/proj/scripts/benchmark.sh", true],
  ["skills/proj/references/notes.md", false],
];

const INSTALL = { skills: ["pub@s", "proj@s"] };

/** Windows files carry no executable bit: a mode read there never has one, chmod sets none. */
const NO_EXEC_BIT = process.platform === "win32" && "Windows files have no executable bit";

/** The owner's executable bit – the one git records. */
const isExec = (path: string) => (statSync(path).mode & 0o100) !== 0;

function env(t: TestContext) {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const ctx: EngineContext = {
    home,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false,
  };
  const writeCfg = (source: unknown) =>
    writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: source }, install: INSTALL }));
  const installed = (rel: string) => join(home, ".claude", rel);
  const assertModes = () => {
    for (const [rel, exec] of INSTALLED) assert.equal(isExec(installed(rel)), exec, `${rel} executable: ${exec}`);
  };
  return { tmp, home, ctx, writeCfg, installed, assertModes };
}

/** FILES written under `dir` with 0o755 / 0o644. */
function writeSource(dir: string): string {
  for (const f of FILES) {
    const path = join(dir, f.path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, f.data);
    chmodSync(path, f.exec ? 0o755 : 0o644);
  }
  return resolvePath(dir);
}

test("k99: a local source's executable scripts install executable, in both layouts and from a template", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const src = writeSource(join(e.tmp.dir, "src"));
  e.writeCfg({ local: src });
  const report = await sync(e.ctx, { scope: "user" });
  assert.equal(report.error, undefined);
  assert.deepEqual(report.scopes[0]!.added.map((i) => i.key).sort(), ["skills/proj", "skills/pub"]);
  e.assertModes();
});

test("k99: a mode change in the source reaches the installed file; the lock hash stays the content's", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const src = writeSource(join(e.tmp.dir, "src"));
  e.writeCfg({ local: src });
  await sync(e.ctx, { scope: "user" });
  const lockPath = join(e.home, ".claude", "skilletor.lock.json");
  const before = readLock(lockPath);

  chmodSync(join(src, ".claude/skills/proj/scripts/benchmark.sh"), 0o644);
  chmodSync(join(src, ".claude/skills/proj/references/notes.md"), 0o755);
  const report = await sync(e.ctx, { scope: "user" });
  const s = report.scopes[0]!;
  assert.deepEqual(s.updated.map((i) => i.key), ["skills/proj"]);
  assert.deepEqual(s.unchanged.map((i) => i.key), ["skills/pub"]);
  assert.deepEqual(s.overwritten, []);
  assert.equal(isExec(e.installed("skills/proj/scripts/benchmark.sh")), false);
  assert.equal(isExec(e.installed("skills/proj/references/notes.md")), true);
  assert.deepEqual(readLock(lockPath), before);

  // A run with nothing to change writes nothing.
  const again = await sync(e.ctx, { scope: "user" });
  assert.deepEqual(again.scopes[0]!.updated, []);
});

test("k99: a git source's executable scripts install executable; a local chmod is no check drift, the next sync restores it", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const bare = join(e.tmp.dir, "repo.git");
  const work = join(e.tmp.dir, "work");
  const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: G, encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
  mkdirSync(work);
  git("init", "-q", "-b", "main");
  writeSource(work);
  git("add", ".");
  git("commit", "-qm", "init");
  const url = "file://" + resolvePath(bare);
  git("push", "-q", url, "main");

  e.writeCfg({ git: url });
  const first = await sync(e.ctx, { scope: "user" });
  assert.equal(first.error, undefined);
  assert.deepEqual(first.scopes[0]!.added.map((i) => i.key).sort(), ["skills/proj", "skills/pub"]);
  e.assertModes();

  const script = e.installed("skills/proj/scripts/benchmark.sh");
  chmodSync(script, 0o644);
  // Like a local edit of a managed file: `check` stays offline and never reads installed files.
  assert.equal((await check(e.ctx, { scope: "user" })).changed, false);
  const report = await sync(e.ctx, { scope: "user" });
  const s = report.scopes[0]!;
  assert.equal(isExec(script), true);
  assert.deepEqual(s.updated.map((i) => i.key), ["skills/proj"]);
  assert.deepEqual(s.overwritten, []);
});

test("k99: a url source's executable tar entries install executable", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const archive = makeTarGz(FILES.map((f) => ({ name: `pkg/${f.path}`, data: f.data, mode: f.exec ? 0o755 : 0o644 })));
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(archive), { headers: { etag: '"v1"' } }));
  e.writeCfg({ url: "https://example.invalid/skills.tar.gz" });
  const report = await sync(e.ctx, { scope: "user" });
  assert.equal(report.error, undefined);
  assert.deepEqual(report.scopes[0]!.warnings, []);
  assert.deepEqual(report.scopes[0]!.added.map((i) => i.key).sort(), ["skills/proj", "skills/pub"]);
  e.assertModes();
});

// ---- installs an earlier version made (k107) --------------------------------------------

/** What skilletor <= 0.4.1 recorded in render-inputs.json for a user scope without vars
 *  (k76): the hash of the inputs' canonical JSON, with no format in it. */
const LEGACY_RENDER_INPUTS = hashBuffer(Buffer.from('{"vars":{}}', "utf8"));

/** Turn a current install into one an earlier version made: its scripts without their bit
 *  (created 0666 less the umask), and the render-inputs record it wrote. */
function legacyInstall(e: ReturnType<typeof env>): void {
  for (const [rel, exec] of INSTALLED) if (exec) chmodSync(e.installed(rel), 0o644);
  const lockPath = join(e.home, ".claude", "skilletor.lock.json");
  writeFileSync(join(e.ctx.stateRoot, "render-inputs.json"), JSON.stringify({ [lockPath]: LEGACY_RENDER_INPUTS }));
}

/** The one source cache under the default cache root. */
function cacheDir(e: ReturnType<typeof env>): string {
  const root = join(e.ctx.stateRoot, "cache");
  const dirs = readdirSync(root);
  assert.equal(dirs.length, 1, "one source cache");
  return join(root, dirs[0]!);
}

// Asserts: after an upgrade from a version before k99 – its scripts installed without their bit,
// its render-inputs record without a format – the first session's check counts the scope
// (varsChanged; the git source did not move), and the sync it starts gives the scripts their
// bit from the git cache as it stands (the same cache dir, no new pack), reporting both skills
// updated and nothing overwritten. It fires once: the next check, session and sync change nothing.
test("k107: scripts an earlier version installed from git get their bit in the first session after the upgrade, once", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const bare = join(e.tmp.dir, "repo.git");
  const work = join(e.tmp.dir, "work");
  const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: G, encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
  mkdirSync(work);
  git("init", "-q", "-b", "main");
  writeSource(work);
  git("add", ".");
  git("commit", "-qm", "init");
  const url = "file://" + resolvePath(bare);
  git("push", "-q", url, "main");
  e.writeCfg({ git: url });
  const projectDir = join(e.tmp.dir, "proj");
  mkdirSync(projectDir);
  const hookCtx: HookContext = { ...e.ctx, projectDir, gitTracked: () => [], background: () => {} };
  const session = () => runHook("session-start", { source: "startup", cwd: projectDir }, hookCtx);

  assert.equal((await session()).systemMessage, "skilletor: 2 item(s) updated");
  e.assertModes();
  assert.deepEqual(await session(), {});
  const cache = cacheDir(e);
  const packs = () => readdirSync(join(cache, ".git", "objects", "pack")).sort();
  const before = { ino: statSync(cache).ino, packs: packs() };

  legacyInstall(e);
  const chk = await check(e.ctx);
  assert.deepEqual([chk.changed, chk.varsChanged, chk.sources], [true, ["user"], [{ name: "s", scope: "user", changed: false }]]);
  const upgraded = await session();
  assert.equal(upgraded.systemMessage, "skilletor: 2 item(s) updated");
  assert.doesNotMatch(upgraded.hookSpecificOutput?.additionalContext ?? "", /overwritten|warning/i);
  e.assertModes();
  assert.deepEqual({ ino: statSync(cache).ino, packs: packs() }, before, "the git cache is reused, nothing downloaded");

  assert.equal((await check(e.ctx)).changed, false, "fires once");
  assert.deepEqual(await session(), {});
  const again = await sync(e.ctx, { scope: "user" });
  assert.deepEqual(again.scopes[0]!.updated, []);
});

/** A url source serving `archive` with ETag "v1" – a GET that names it gets a 304 – and the
 *  If-None-Match of every GET (null: none) in `sent`; `offline` fails every request. */
function serveUrl(t: TestContext, archive: Buffer) {
  const net = { sent: [] as (string | null)[], offline: false };
  t.mock.method(globalThis, "fetch", async (...[, opts]: Parameters<typeof fetch>) => {
    if (net.offline) throw new Error("offline");
    if (opts?.method === "HEAD") return new Response(null, { headers: { etag: '"v1"' } });
    const inm = new Headers(opts?.headers).get("If-None-Match");
    net.sent.push(inm);
    if (inm === '"v1"') return new Response(null, { status: 304 });
    return new Response(new Uint8Array(archive), { headers: { etag: '"v1"' } });
  });
  return net;
}

const ARCHIVE = () => makeTarGz(FILES.map((f) => ({ name: `pkg/${f.path}`, data: f.data, mode: f.exec ? 0o755 : 0o644 })));

/** Turn the url cache into one skilletor 0.3.1–0.4.1 extracted: every file without its bit,
 *  and a version file that holds the version alone (k82). */
function legacyUrlCache(e: ReturnType<typeof env>): string {
  const dir = cacheDir(e);
  writeFileSync(join(dir, URL_VERSION_FILE), 'etag:"v1"');
  for (const f of FILES) if (f.exec) chmodSync(join(dir, f.path), 0o644);
  return dir;
}

const lockVersion = (e: ReturnType<typeof env>) => readLock(join(e.home, ".claude", "skilletor.lock.json"))["skills/pub"]?.version;

// Asserts: a url cache an earlier version extracted without modes, and the scripts it installed
// from it, get their bit in the first sync after the upgrade – check counts the scope once
// (varsChanged; the archive did not change), and the sync's GET carries no If-None-Match, so
// the server's 200 is extracted anew, bits and all. It fires once: the next check is quiet and
// the next sync asks with "v1", gets a 304 and changes nothing.
test("k107: a url cache an earlier version extracted without modes is extracted anew once; its scripts get their bit", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const net = serveUrl(t, ARCHIVE());
  e.writeCfg({ url: "https://example.invalid/skills.tar.gz" });
  assert.equal((await sync(e.ctx)).error, undefined);
  e.assertModes();
  assert.deepEqual(net.sent, [null]);

  legacyInstall(e);
  const cache = legacyUrlCache(e);
  const chk = await check(e.ctx);
  assert.deepEqual([chk.changed, chk.varsChanged, chk.sources], [true, ["user"], [{ name: "s", scope: "user", changed: false }]]);
  net.sent.length = 0;
  const report = await sync(e.ctx);
  const s = report.scopes[0]!;
  assert.deepEqual(net.sent, [null], "no If-None-Match: a cache of an earlier format has no known version");
  assert.deepEqual([s.warnings, s.overwritten], [[], []]);
  assert.deepEqual(s.updated.map((i) => i.key).sort(), ["skills/proj", "skills/pub"]);
  e.assertModes();
  assert.equal(isExec(join(cache, ".claude/skills/proj/scripts/benchmark.sh")), true, "the cache holds the bit again");
  assert.equal(lockVersion(e), 'etag:"v1"');

  assert.equal((await check(e.ctx)).changed, false, "fires once");
  net.sent.length = 0;
  const again = await sync(e.ctx);
  assert.deepEqual(net.sent, ['"v1"']);
  assert.deepEqual(again.scopes[0]!.updated, []);
});

// Asserts: when the first sync after the upgrade is offline, it serves the url cache of an
// earlier format as a cache of unknown version (k82), so the lock and the record of what it
// read say "unknown"; the next check online counts the url source as changed, and its sync
// extracts the archive anew and gives the scripts their bit – once.
test("k107: a url cache of an earlier format served offline counts as changed until a download gives the bits", { skip: NO_EXEC_BIT }, async (t) => {
  const e = env(t);
  const net = serveUrl(t, ARCHIVE());
  e.writeCfg({ url: "https://example.invalid/skills.tar.gz" });
  await sync(e.ctx);
  legacyInstall(e);
  legacyUrlCache(e);

  net.offline = true;
  const offline = await sync(e.ctx);
  assert.match(offline.scopes[0]!.warnings.join("\n"), /using cache/);
  assert.equal(lockVersion(e), "unknown");
  assert.equal(isExec(e.installed("skills/proj/scripts/benchmark.sh")), false, "no bits without a download");

  net.offline = false;
  const chk = await check(e.ctx);
  assert.deepEqual([chk.changed, chk.varsChanged, chk.sources], [true, undefined, [{ name: "s", scope: "user", changed: true }]]);
  net.sent.length = 0;
  await sync(e.ctx);
  assert.deepEqual(net.sent, [null]);
  e.assertModes();
  assert.equal(lockVersion(e), 'etag:"v1"');
  assert.equal((await check(e.ctx)).changed, false, "fires once");
});
