// k99: a source file's executable bit survives render and apply (spec §5, §6.2) – for local,
// git and url sources, a skill under `skills/` and one in the Claude project layout
// (`.claude/skills/`) alike. The lock hashes content only: a file whose bytes match but whose
// bit does not is rewritten by the next sync, reported as an update and never as a local
// overwrite, and `check` does not count it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { check, sync, type EngineContext } from "../src/engine.ts";
import { readLock } from "../src/lock.ts";

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

test("k99: a local source's executable scripts install executable, in both layouts and from a template", async (t) => {
  const e = env(t);
  const src = writeSource(join(e.tmp.dir, "src"));
  e.writeCfg({ local: src });
  const report = await sync(e.ctx, { scope: "user" });
  assert.equal(report.error, undefined);
  assert.deepEqual(report.scopes[0]!.added.map((i) => i.key).sort(), ["skills/proj", "skills/pub"]);
  e.assertModes();
});

test("k99: a mode change in the source reaches the installed file; the lock hash stays the content's", async (t) => {
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

test("k99: a git source's executable scripts install executable; a local chmod is no check drift, the next sync restores it", async (t) => {
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

test("k99: a url source's executable tar entries install executable", async (t) => {
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
