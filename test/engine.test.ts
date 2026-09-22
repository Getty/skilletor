// Integration tests for the engine (spec §6.1, §6.6, §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { sync, check, status, type EngineContext } from "../src/engine.ts";
import { reportText } from "../src/report.ts";
import { readLock } from "../src/lock.ts";

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  const stateRoot = join(tmp.dir, "state");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: EngineContext = {
    home,
    projectDir,
    stateRoot,
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
  };
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => {
    const file =
      which === "user"
        ? join(home, ".claude", "skilletor.json")
        : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  return { tmp, ctx, home, projectDir, stateRoot, writeCfg, cleanup: () => tmp.cleanup() };
}

/** Create a local source dir with one skill. Returns its absolute path. */
function localSource(root: string, name: string, skill: string, body: string): string {
  const dir = join(root, name);
  const skillDir = join(dir, "skills", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} skill\n---\n${body}\n`);
  return resolvePath(dir);
}

test("sync installs a user-scope skill from a local source", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcA", "foo", "FOO-BODY");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const report = await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "utf8").includes("FOO-BODY"), true);
    assert.equal("skills/foo" in readLock(join(e.home, ".claude/skilletor.lock.json")), true);
    assert.deepEqual(report.scopes[0]!.added.map((i) => i.key), ["skills/foo"]);
  } finally {
    e.cleanup();
  }
});

test("sync installs a project-scope skill and writes a gitignore block", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcB", "bar", "BAR");
    // user source (trusted), declared in user config; installed at project scope.
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["bar@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/bar/SKILL.md")), true);
    const gi = readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8");
    assert.match(gi, /skills\/bar\/SKILL\.md/);
    assert.match(gi, /skilletor\.lock\.json/);
  } finally {
    e.cleanup();
  }
});

test("author mode: a user local override wins over a project git definition", async () => {
  const e = env();
  try {
    const local = localSource(e.tmp.dir, "authorLocal", "moo", "LOCAL-CONTENT");
    // Project declares shared via a bogus git URL; user overrides with a real local.
    e.writeCfg("project", { sources: { shared: { git: "file:///nonexistent.git" } }, install: { skills: ["moo@shared"] } });
    e.writeCfg("user", { sources: { shared: { local } } });
    const report = await sync(e.ctx, { scope: "project" });
    assert.equal(readFileSync(join(e.projectDir, ".claude/skills/moo/SKILL.md"), "utf8").includes("LOCAL-CONTENT"), true);
    assert.equal(report.scopes[0]!.warnings.length, 0); // no git fetch attempted
  } finally {
    e.cleanup();
  }
});

test("an untrusted project-only source is skipped with a trust request", async () => {
  const e = env();
  try {
    e.writeCfg("project", { sources: { team: { git: "file:///whatever.git" } }, install: { skills: ["x@team"] } });
    const report = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(report.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/x")), false);
  } finally {
    e.cleanup();
  }
});

test("a config error touches nothing and reports the error", async () => {
  const e = env();
  try {
    writeFileSync(join(e.home, ".claude/skilletor.json"), "{ broken json");
    const report = await sync(e.ctx, { scope: "user" });
    assert.match(report.error ?? "", /json/i);
    assert.equal(report.scopes.length, 0);
  } finally {
    e.cleanup();
  }
});

test("offline git source falls back to the cache and keeps the item", async () => {
  const e = env();
  try {
    // Build a bare repo with a skill.
    const bare = join(e.tmp.dir, "repo.git");
    const work = join(e.tmp.dir, "work");
    const G = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    execFileSync("git", ["init", "-q", "--bare", bare]);
    mkdirSync(join(work, "skills", "foo"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
    writeFileSync(join(work, "skills/foo/SKILL.md"), "---\ndescription: foo\n---\nGIT-BODY\n");
    execFileSync("git", ["add", "."], { cwd: work, env: { ...process.env, ...G } });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: work, env: { ...process.env, ...G } });
    const url = "file://" + resolvePath(bare);
    execFileSync("git", ["push", "-q", url, "main"], { cwd: work, env: { ...process.env, ...G } });

    e.writeCfg("user", { sources: { g: { git: url } }, install: { skills: ["foo@g"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);

    rmSync(bare, { recursive: true, force: true }); // go offline
    const report = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true); // kept
    assert.equal(report.scopes[0]!.warnings.some((w) => /cache/i.test(w)), true);
  } finally {
    e.cleanup();
  }
});

test("reportText renders a fresh install with the activation hint", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcR", "foo", "X");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const report = await sync(e.ctx, { scope: "user" });
    assert.match(reportText(report), /\+ skills\/foo \(active now\)/);
  } finally {
    e.cleanup();
  }
});

test("check reports change for a local source and status lists declared items", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcC", "foo", "X");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const chk = await check(e.ctx, { scope: "user" });
    assert.equal(chk.changed, true); // local is always "changed"
    const st = status(e.ctx, { scope: "user" });
    assert.deepEqual(st.scopes[0]!.declared.map((d) => d.key), ["skills/foo"]);
    assert.equal(st.scopes[0]!.declared[0]!.installed, false); // not synced yet
  } finally {
    e.cleanup();
  }
});

test("an item removed from config is deleted on the next sync", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcD", "foo", "X");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: [] } });
    const report = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false);
    assert.deepEqual(report.scopes[0]!.removed.map((i) => i.key), ["skills/foo"]);
  } finally {
    e.cleanup();
  }
});