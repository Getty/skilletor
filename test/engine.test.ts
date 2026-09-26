// Integration tests for the engine (spec §6.1, §6.6, §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { sync, check, status, type EngineContext } from "../src/engine.ts";
import { reportHook, reportText } from "../src/report.ts";
import { readLock } from "../src/lock.ts";
import { SKILL_GITIGNORE } from "../src/gitignore.ts";
import { hashBuffer } from "../src/fsutil.ts";

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
    markers: claudeOnly(home),
    isGitWorkTree: () => false, // never the real location of the temp dir
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

const BLOCK = (...entries: string[]) => ["# >>> skilletor >>>", ...entries, "# <<< skilletor <<<"].join("\n") + "\n";
/** The fixed block of a project's `.claude/.gitignore` (spec §6.4). */
const PROJECT_BLOCK = BLOCK("agents/**/.local.*", "rules/**/.local.*", "skilletor.local.json", "skilletor.lock.json");

test("sync installs a project-scope skill with its own .gitignore and writes the fixed block", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcB", "bar", "BAR");
    // user source (trusted), declared in user config; installed at project scope.
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["bar@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/bar/SKILL.md")), true);
    assert.equal(readFileSync(join(e.projectDir, ".claude/skills/bar/.gitignore"), "utf8"), SKILL_GITIGNORE);
    assert.equal(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), PROJECT_BLOCK);
    const lock = readLock(join(e.projectDir, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock["skills/bar"]!.files), ["skills/bar/.gitignore", "skills/bar/SKILL.md"]);
  } finally {
    e.cleanup();
  }
});

// ---- k51: user-scope gitignore blocks (spec §6.4) ---------------------------

test("user scope inside a git work tree: ~/.claude/.gitignore lists lock, state dir and patterns, never skilletor.json", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcU", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    writeFileSync(join(e.home, ".claude/.gitignore"), "own-entry\n");
    const asked: string[] = [];
    const ctx: EngineContext = {
      ...e.ctx,
      stateRoot: join(e.home, ".claude", "skilletor"),
      isGitWorkTree: (dir) => (asked.push(dir), true),
    };
    await sync(ctx, { scope: "user" });
    const gi = readFileSync(join(e.home, ".claude/.gitignore"), "utf8");
    assert.equal(gi, "own-entry\n\n" + BLOCK("agents/**/.local.*", "rules/**/.local.*", "skilletor.lock.json", "skilletor/"));
    assert.equal(asked.includes(join(e.home, ".claude")), true);
    // Claude only: nothing managed under ~/.agents or the Codex home, so no block there.
    assert.equal(existsSync(join(e.home, ".agents/.gitignore")), false);
    // A state root outside ~/.claude is not listed.
    await sync({ ...ctx, stateRoot: e.stateRoot }, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".claude/.gitignore"), "utf8"),
      "own-entry\n\n" + BLOCK("agents/**/.local.*", "rules/**/.local.*", "skilletor.lock.json"));
  } finally {
    e.cleanup();
  }
});

test("user scope outside a git work tree: no block; leaving a work tree removes it", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcV", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" }); // env: isGitWorkTree → false
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), false);
    assert.equal(readFileSync(join(e.home, ".claude/skills/foo/.gitignore"), "utf8"), SKILL_GITIGNORE); // no git state
    await sync({ ...e.ctx, isGitWorkTree: () => true }, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/.gitignore"), "utf8"), /^skilletor\.lock\.json$/m);
    // Out of the work tree again: the block goes, own lines stay.
    writeFileSync(join(e.home, ".claude/.gitignore"),
      "mine\n" + readFileSync(join(e.home, ".claude/.gitignore"), "utf8"));
    await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".claude/.gitignore"), "utf8"), "mine\n");
  } finally {
    e.cleanup();
  }
});

test("user gitignore false removes the user blocks; project blocks follow the project config", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcW", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const ctx: EngineContext = { ...e.ctx, isGitWorkTree: () => true };
    await sync(ctx);
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), true);
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] }, gitignore: false });
    const r = await sync(ctx);
    assert.equal(r.error, undefined);
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), false);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/.gitignore")), false);
    assert.equal(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), PROJECT_BLOCK);
    assert.equal(readFileSync(join(e.projectDir, ".claude/skills/foo/.gitignore"), "utf8"), SKILL_GITIGNORE);
  } finally {
    e.cleanup();
  }
});

test("project blocks do not depend on the work-tree test", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcX", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const asked: string[] = [];
    await sync({ ...e.ctx, isGitWorkTree: (dir) => (asked.push(dir), false) }, { scope: "project" });
    assert.equal(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), PROJECT_BLOCK);
    assert.deepEqual(asked, []);
  } finally {
    e.cleanup();
  }
});

// ---- k62: fixed ignore rules, `.local.` agents and rules (spec §6.3, §6.4) -----

/** A local source with the given files (relative path -> content). */
function filesSource(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return resolvePath(dir);
}

const SKILL_MD = "---\nname: foo\ndescription: foo\n---\nFOO\n";
const AGENT_MD = "---\nname: a\ndescription: A\n---\nAGENT\n";
const RULE_MD = "RULE\n";
const K62_FILES = { "skills/foo/SKILL.md": SKILL_MD, "agents/a.md": AGENT_MD, "rules/r.md": RULE_MD };
const K62_INSTALL = { skills: ["foo@mine"], agents: ["a@mine"], rules: ["r@mine"] };

test("k62: agents and rules install as .local.<name>.md under their old lock keys; skills keep their name", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62a", K62_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: K62_INSTALL });
    const r = await sync(e.ctx, { scope: "project" });
    const claude = join(e.projectDir, ".claude");
    assert.equal(readFileSync(join(claude, "agents/.local.a.md"), "utf8"), AGENT_MD);
    assert.equal(readFileSync(join(claude, "rules/.local.r.md"), "utf8"), RULE_MD);
    assert.equal(existsSync(join(claude, "agents/a.md")), false);
    assert.equal(existsSync(join(claude, "rules/r.md")), false);
    assert.equal(readFileSync(join(claude, "skills/foo/SKILL.md"), "utf8"), SKILL_MD);
    const lock = readLock(join(claude, "skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock).sort(), ["agents/a", "rules/r", "skills/foo"]);
    assert.deepEqual(Object.keys(lock["agents/a"]!.files), ["agents/.local.a.md"]);
    assert.deepEqual(Object.keys(lock["rules/r"]!.files), ["rules/.local.r.md"]);
    assert.deepEqual(r.scopes[0]!.conflicts, []);
    assert.match(reportText(r), /^ {2}\+ agents\/a \(active after/m);
  } finally {
    e.cleanup();
  }
});

test("k62: the first sync after the upgrade moves old-layout files and replaces the per-path block", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62b", K62_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: K62_INSTALL });
    // What an earlier version left: plain agent and rule files, no skill .gitignore, a per-path block.
    const claude = join(e.projectDir, ".claude");
    const old: Record<string, string> = { "skills/foo/SKILL.md": SKILL_MD, "agents/a.md": AGENT_MD, "rules/r.md": RULE_MD };
    for (const [rel, text] of Object.entries(old)) {
      mkdirSync(join(claude, rel, ".."), { recursive: true });
      writeFileSync(join(claude, rel), text);
    }
    const entry = (rel: string) => ({ source: "mine", version: "local", files: { [rel]: hashBuffer(Buffer.from(old[rel]!)) } });
    writeFileSync(join(claude, "skilletor.lock.json"), JSON.stringify({
      "agents/a": entry("agents/a.md"), "rules/r": entry("rules/r.md"), "skills/foo": entry("skills/foo/SKILL.md"),
    }));
    writeFileSync(join(claude, ".gitignore"),
      "own\n\n" + BLOCK("agents/a.md", "rules/r.md", "skills/foo/SKILL.md", "skilletor.local.json", "skilletor.lock.json"));

    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.conflicts, []); // the old plain paths are lock-owned
    assert.deepEqual(r.scopes[0]!.updated.map((i) => i.key).sort(), ["agents/a", "rules/r", "skills/foo"]);
    assert.equal(existsSync(join(claude, "agents/a.md")), false);
    assert.equal(existsSync(join(claude, "rules/r.md")), false);
    assert.equal(readFileSync(join(claude, "agents/.local.a.md"), "utf8"), AGENT_MD);
    assert.equal(readFileSync(join(claude, "rules/.local.r.md"), "utf8"), RULE_MD);
    assert.equal(readFileSync(join(claude, "skills/foo/.gitignore"), "utf8"), SKILL_GITIGNORE);
    const lock = readLock(join(claude, "skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock["agents/a"]!.files), ["agents/.local.a.md"]);
    assert.deepEqual(Object.keys(lock["rules/r"]!.files), ["rules/.local.r.md"]);
    assert.equal(readFileSync(join(claude, ".gitignore"), "utf8"), "own\n\n" + PROJECT_BLOCK);
    assert.deepEqual(r.scopes[0]!.gitignoreUpdated, [".claude/.gitignore"]);

    const again = await sync(e.ctx, { scope: "project" });
    assert.equal(reportText(again), "");
    assert.equal(again.scopes[0]!.gitignoreUpdated, undefined);
  } finally {
    e.cleanup();
  }
});

test("k62: a foreign file at an agent's or rule's plain path is a conflict; --force replaces it", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62c", K62_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: K62_INSTALL });
    const claude = join(e.projectDir, ".claude");
    mkdirSync(join(claude, "agents"), { recursive: true });
    mkdirSync(join(claude, "rules"), { recursive: true });
    writeFileSync(join(claude, "agents/a.md"), "MINE-A\n");
    writeFileSync(join(claude, "rules/r.md"), "MINE-R\n");

    const r = await sync(e.ctx, { scope: "project" });
    const byPath = (c: { path: string }[]) => [...c].sort((x, y) => x.path.localeCompare(y.path));
    assert.deepEqual(byPath(r.scopes[0]!.conflicts), [{ path: "agents/a.md", replace: true }, { path: "rules/r.md", replace: true }]);
    assert.match(reportText(r), /^ {2}conflict: agents\/a\.md already exists \(use --force to replace it\)$/m);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["skills/foo"]);
    assert.equal(existsSync(join(claude, "agents/.local.a.md")), false);
    assert.equal(existsSync(join(claude, "rules/.local.r.md")), false);
    assert.equal(readFileSync(join(claude, "agents/a.md"), "utf8"), "MINE-A\n");
    assert.deepEqual(Object.keys(readLock(join(claude, "skilletor.lock.json"))), ["skills/foo"]);

    const forced = await sync(e.ctx, { scope: "project", force: true });
    assert.deepEqual(forced.scopes[0]!.conflicts, []);
    assert.deepEqual(forced.scopes[0]!.added.map((i) => i.key).sort(), ["agents/a", "rules/r"]);
    assert.equal(existsSync(join(claude, "agents/a.md")), false);
    assert.equal(existsSync(join(claude, "rules/r.md")), false);
    assert.equal(readFileSync(join(claude, "agents/.local.a.md"), "utf8"), AGENT_MD);
    assert.equal(readFileSync(join(claude, "rules/.local.r.md"), "utf8"), RULE_MD);
    assert.deepEqual(Object.keys(readLock(join(claude, "skilletor.lock.json"))["agents/a"]!.files), ["agents/.local.a.md"]);

    // A foreign plain file appearing later: a conflict again, the installed agent is left as it was.
    writeFileSync(join(claude, "agents/a.md"), "MINE-AGAIN\n");
    const lockBefore = readFileSync(join(claude, "skilletor.lock.json"), "utf8");
    const later = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(later.scopes[0]!.conflicts, [{ path: "agents/a.md", replace: true }]);
    assert.deepEqual(later.scopes[0]!.removed, []);
    assert.equal(readFileSync(join(claude, "agents/.local.a.md"), "utf8"), AGENT_MD);
    assert.equal(readFileSync(join(claude, "agents/a.md"), "utf8"), "MINE-AGAIN\n");
    assert.equal(readFileSync(join(claude, "skilletor.lock.json"), "utf8"), lockBefore);
  } finally {
    e.cleanup();
  }
});

test("k62: a hand-written or linked skill of the same name gets no .gitignore; --force adopts it with one", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62g", { "skills/foo/SKILL.md": SKILL_MD, "skills/bar/SKILL.md": SKILL_MD });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine", "bar@mine"] } });
    const skills = join(e.projectDir, ".claude/skills");
    mkdirSync(join(skills, "foo"), { recursive: true });
    writeFileSync(join(skills, "foo/SKILL.md"), "MY OWN FOO\n");
    const elsewhere = join(e.tmp.dir, "my-skills/bar"); // a manage-skills link
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "SKILL.md"), "MY OWN BAR\n");
    symlinkSync(elsewhere, join(skills, "bar"));

    const r = await sync(e.ctx, { scope: "project" });
    // k67: the linked skill's conflict is the link itself (spec §6.3).
    assert.deepEqual(r.scopes[0]!.conflicts.sort((a, b) => a.path.localeCompare(b.path)),
      [{ path: "skills/bar", replace: true }, { path: "skills/foo/SKILL.md" }]);
    assert.deepEqual(r.scopes[0]!.added, []);
    assert.equal(existsSync(join(skills, "foo/.gitignore")), false);
    assert.equal(existsSync(join(elsewhere, ".gitignore")), false); // never written through the link
    assert.deepEqual(readLock(join(e.projectDir, ".claude/skilletor.lock.json")), {});

    await sync(e.ctx, { scope: "project", force: true });
    assert.equal(readFileSync(join(skills, "foo/SKILL.md"), "utf8"), SKILL_MD);
    assert.equal(readFileSync(join(skills, "foo/.gitignore"), "utf8"), SKILL_GITIGNORE);
    // The link is replaced by a real directory; the linked skill is untouched.
    assert.equal(lstatSync(join(skills, "bar")).isDirectory(), true);
    assert.equal(readFileSync(join(skills, "bar/SKILL.md"), "utf8"), SKILL_MD);
    assert.deepEqual(readdirSync(elsewhere), ["SKILL.md"]);
    assert.equal(readFileSync(join(elsewhere, "SKILL.md"), "utf8"), "MY OWN BAR\n");
  } finally {
    e.cleanup();
  }
});

// k67 (audit probe 03): a linked foreign skill in ~/.claude/skills gets nothing written
// through the link, not even files it does not have yet (spec §6.3).
test("k67: a linked skill dir in the user scope: conflict at the link, nothing written through it; --force replaces the link", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k67", { "skills/foo/SKILL.md": SKILL_MD, "skills/foo/reference.md": "NEW SOURCE FILE\n" });
    const outside = join(e.tmp.dir, "foreign");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "FOREIGN\n");
    mkdirSync(join(e.home, ".claude/skills"), { recursive: true });
    const link = join(e.home, ".claude/skills/foo");
    symlinkSync(outside, link);
    e.writeCfg("user", { sources: { s: { local: src } }, install: { skills: ["foo@s"] } });

    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.conflicts, [{ path: "skills/foo", replace: true }]);
    assert.deepEqual(r.scopes[0]!.added, []);
    assert.deepEqual(readdirSync(outside), ["SKILL.md"], "no reference.md, no .gitignore through the link");
    assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), "FOREIGN\n");
    assert.match(reportText(r), /conflict: skills\/foo already exists \(use --force to replace it\)/);

    const forced = await sync(e.ctx, { scope: "user", force: true });
    assert.deepEqual(forced.scopes[0]!.conflicts, []);
    assert.equal(lstatSync(link).isDirectory(), true);
    assert.deepEqual(readdirSync(link).sort(), [".gitignore", "SKILL.md", "reference.md"]);
    assert.deepEqual(readdirSync(outside), ["SKILL.md"]);
    assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), "FOREIGN\n");

    // The installed skill becomes a link again, then its declaration goes: nothing is
    // deleted through the link, a warning says so, and the lock lets go of it.
    rmSync(link, { recursive: true });
    symlinkSync(outside, link);
    e.writeCfg("user", { sources: { s: { local: src } } });
    const gone = await sync(e.ctx, { scope: "user" });
    assert.ok(gone.scopes[0]!.warnings.some((w) => w === "skills/foo is a symbolic link: files of skills/foo behind it left in place (never deleted through a link)"),
      gone.scopes[0]!.warnings.join("\n"));
    assert.deepEqual(readdirSync(outside), ["SKILL.md"]);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(join(e.home, ".claude/skilletor.lock.json")), false);
  } finally {
    e.cleanup();
  }
});

test("k62: gitignore false writes no block and no skill .gitignore; the .local. names stay", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62d", K62_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    const claude = join(e.projectDir, ".claude");
    e.writeCfg("project", { install: K62_INSTALL, gitignore: false });
    const off = await sync(e.ctx, { scope: "project" });
    const gitignores = () => (readdirSync(claude, { recursive: true }) as string[]).filter((f) => basename(f) === ".gitignore");
    assert.deepEqual(gitignores(), []);
    assert.equal(off.scopes[0]!.gitignoreUpdated, undefined);
    assert.equal(existsSync(join(claude, "agents/.local.a.md")), true);
    assert.equal(existsSync(join(claude, "rules/.local.r.md")), true);

    // Switched on: the block and the skill's .gitignore appear; agents and rules keep their files.
    e.writeCfg("project", { install: K62_INSTALL });
    const on = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(gitignores().sort(), [".gitignore", join("skills", "foo", ".gitignore")]);
    assert.deepEqual(on.scopes[0]!.updated.map((i) => i.key), ["skills/foo"]);
    assert.deepEqual(on.scopes[0]!.gitignoreUpdated, [".claude/.gitignore"]);

    // Off again: both go (no commit hint for a removal), nothing is renamed.
    e.writeCfg("project", { install: K62_INSTALL, gitignore: false });
    const again = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(gitignores(), []);
    assert.deepEqual(again.scopes[0]!.updated.map((i) => i.key), ["skills/foo"]);
    assert.equal(again.scopes[0]!.gitignoreUpdated, undefined);
    assert.equal(readFileSync(join(claude, "agents/.local.a.md"), "utf8"), AGENT_MD);
  } finally {
    e.cleanup();
  }
});

test("k62: a .gitignore the source ships at the skill root is replaced; with gitignore false it installs as shipped", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62e", {
      "skills/foo/SKILL.md": SKILL_MD, "skills/foo/.gitignore": "node_modules/\n", "skills/foo/sub/.gitignore": "tmp/\n",
    });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    const skill = join(e.projectDir, ".claude/skills/foo");
    assert.equal(readFileSync(join(skill, ".gitignore"), "utf8"), SKILL_GITIGNORE);
    assert.equal(readFileSync(join(skill, "sub/.gitignore"), "utf8"), "tmp/\n"); // not at the skill root: the source's
    e.writeCfg("project", { install: { skills: ["foo@mine"] }, gitignore: false });
    await sync(e.ctx, { scope: "project" });
    assert.equal(readFileSync(join(skill, ".gitignore"), "utf8"), "node_modules/\n");
  } finally {
    e.cleanup();
  }
});

test("k62: the commit hint appears when a block is created or changed, never when items change", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k62f", {
      ...K62_FILES, "skills/bar/SKILL.md": "---\nname: bar\ndescription: bar\n---\nBAR\n", "agents/b.md": AGENT_MD,
    });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const gi = join(e.projectDir, ".claude/.gitignore");

    const first = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(first.scopes[0]!.gitignoreUpdated, [".claude/.gitignore"]);
    assert.match(reportText(first), /^ {2}\.claude\/\.gitignore updated — commit it$/m);
    const hook = reportHook(first);
    assert.match(hook.systemMessage ?? "", /^skilletor: 1 item\(s\) updated, \.claude\/\.gitignore updated — commit it$/);
    assert.match(hook.additionalContext ?? "", /^- \.claude\/\.gitignore updated — commit it$/m);

    // Items, files and vars change: the committed .gitignore does not.
    const committed = readFileSync(gi, "utf8");
    e.writeCfg("project", { install: { skills: ["foo@mine", "bar@mine"], agents: ["a@mine", "b@mine"], rules: ["r@mine"] } });
    const more = await sync(e.ctx, { scope: "project" });
    assert.equal(more.scopes[0]!.added.length, 4);
    assert.equal(readFileSync(gi, "utf8"), committed);
    assert.equal(more.scopes[0]!.gitignoreUpdated, undefined);
    assert.doesNotMatch(reportText(more), /commit it/);
    assert.doesNotMatch(reportHook(more).systemMessage ?? "", /commit it/);

    // A block edited by hand is restored, and that is a change to commit.
    writeFileSync(gi, committed.replace("skilletor.lock.json\n", ""));
    const restored = await sync(e.ctx, { scope: "project" });
    assert.equal(readFileSync(gi, "utf8"), committed);
    assert.deepEqual(restored.scopes[0]!.gitignoreUpdated, [".claude/.gitignore"]);
  } finally {
    e.cleanup();
  }
});

// ---- k63: tracked managed files (spec §6.4) -----------------------------------

/** A fake `gitTracked`: in `root`, the given paths are tracked; records every call. */
function fakeTracked(root: string, tracked: string[]) {
  const calls: { dir: string; paths: string[] }[] = [];
  const fn = (dir: string, paths: string[]): string[] => {
    calls.push({ dir, paths: [...paths].sort() });
    return dir === root ? paths.filter((p) => tracked.includes(p)) : [];
  };
  return { fn, calls };
}

const TRACKED = (item: string, cmd: string) =>
  `${item} is tracked by git although skilletor manages it — untrack it: ${cmd}`;
const K63_FILES = { ...K62_FILES, "skills/foo/ref.md": "REF\n" };

test("k63: files committed under gitignore false warn once per item when sync rewrites them", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k63a", K63_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: K62_INSTALL, gitignore: false });
    const claude = join(e.projectDir, ".claude");
    const t = fakeTracked(claude, ["skills/foo/SKILL.md", "skills/foo/ref.md", "agents/.local.a.md", "rules/.local.r.md"]);
    const ctx: EngineContext = { ...e.ctx, gitTracked: t.fn };

    // gitignore false: committable by design, git is never asked.
    const off = await sync(ctx, { scope: "project" });
    assert.deepEqual(off.scopes[0]!.warnings, []);
    assert.deepEqual(t.calls, []);

    // Switched on: only the skill's new .gitignore is written, and it is not tracked.
    e.writeCfg("project", { install: K62_INSTALL });
    const on = await sync(ctx, { scope: "project" });
    assert.deepEqual(on.scopes[0]!.warnings, []);
    assert.deepEqual(t.calls, [{ dir: claude, paths: ["skills/foo/.gitignore"] }]);

    // Upstream rewrites both skill files and the agent: one warning per item, one ask for all
    // written paths; the tracked but unchanged rule says nothing.
    t.calls.length = 0;
    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL_MD + "MORE\n");
    writeFileSync(join(src, "skills/foo/ref.md"), "REF2\n");
    writeFileSync(join(src, "agents/a.md"), AGENT_MD + "MORE\n");
    const r = await sync(ctx, { scope: "project" });
    const skillWarning = TRACKED("skills/foo", "git rm -r --cached .claude/skills/foo");
    const agentWarning = TRACKED("agents/a", "git rm --cached .claude/agents/.local.a.md");
    assert.deepEqual([...r.scopes[0]!.warnings].sort(), [agentWarning, skillWarning]);
    assert.deepEqual(t.calls, [{ dir: claude, paths: ["agents/.local.a.md", "skills/foo/SKILL.md", "skills/foo/ref.md"] }]);
    assert.equal(reportText(r).split("\n").includes(`  warning: ${skillWarning}`), true);
    assert.equal((reportHook(r).additionalContext ?? "").split("\n").includes(`- warning: ${agentWarning}`), true);

    // Nothing written: git is not asked, nothing is said.
    t.calls.length = 0;
    const again = await sync(ctx, { scope: "project" });
    assert.deepEqual(again.scopes[0]!.warnings, []);
    assert.deepEqual(t.calls, []);
  } finally {
    e.cleanup();
  }
});

test("k63: a committed skill adopted with --force warns; the conflicting run asks nothing", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k63b", { "skills/foo/SKILL.md": SKILL_MD, "skills/bar/SKILL.md": SKILL_MD });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine", "bar@mine"] } });
    const claude = join(e.projectDir, ".claude");
    mkdirSync(join(claude, "skills/foo"), { recursive: true });
    mkdirSync(join(claude, "skills/bar"), { recursive: true });
    writeFileSync(join(claude, "skills/foo/SKILL.md"), SKILL_MD); // same as the source: adopted, not written
    writeFileSync(join(claude, "skills/bar/SKILL.md"), "MY OWN BAR\n"); // differs: overwritten
    const t = fakeTracked(claude, ["skills/foo/SKILL.md", "skills/bar/SKILL.md"]);
    const ctx: EngineContext = { ...e.ctx, gitTracked: t.fn };

    const r = await sync(ctx, { scope: "project" });
    assert.equal(r.scopes[0]!.conflicts.length, 2);
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.deepEqual(t.calls, []);

    const forced = await sync(ctx, { scope: "project", force: true });
    assert.deepEqual([...forced.scopes[0]!.warnings].sort(), [
      TRACKED("skills/bar", "git rm -r --cached .claude/skills/bar"),
      TRACKED("skills/foo", "git rm -r --cached .claude/skills/foo"),
    ]);
    assert.deepEqual(t.calls, [{
      dir: claude, paths: ["skills/bar/.gitignore", "skills/bar/SKILL.md", "skills/foo/.gitignore", "skills/foo/SKILL.md"],
    }]);
  } finally {
    e.cleanup();
  }
});

test("k63: nothing tracked, or a failing tracked test, says nothing and never fails the sync", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k63c", K62_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: K62_INSTALL });
    const t = fakeTracked(join(e.projectDir, ".claude"), []);
    const r = await sync({ ...e.ctx, gitTracked: t.fn }, { scope: "project" });
    assert.equal(r.scopes[0]!.added.length, 3);
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.equal(t.calls.length, 1);

    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL_MD + "MORE\n");
    const boom = () => { throw new Error("git exploded"); };
    const failed = await sync({ ...e.ctx, gitTracked: boom }, { scope: "project" });
    assert.equal(failed.error, undefined);
    assert.deepEqual(failed.scopes[0]!.updated.map((i) => i.key), ["skills/foo"]);
    assert.deepEqual(failed.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("k63: user scope names the root with git -C in the ~/ form; the user switch turns it off", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k63d", K62_FILES);
    const install = { skills: ["foo@mine"], agents: ["a@mine"] };
    e.writeCfg("user", { sources: { mine: { local: src } }, install });
    const claude = join(e.home, ".claude");
    const t = fakeTracked(claude, ["skills/foo/SKILL.md", "agents/.local.a.md"]);
    const r = await sync({ ...e.ctx, gitTracked: t.fn }, { scope: "user" });
    assert.deepEqual([...r.scopes[0]!.warnings].sort(), [
      TRACKED("agents/a", "git -C ~/.claude rm --cached agents/.local.a.md"),
      TRACKED("skills/foo", "git -C ~/.claude rm -r --cached skills/foo"),
    ]);

    // gitignore false in the user file: rewritten tracked files, and not a word.
    t.calls.length = 0;
    e.writeCfg("user", { sources: { mine: { local: src } }, install, gitignore: false });
    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL_MD + "MORE\n");
    writeFileSync(join(src, "agents/a.md"), AGENT_MD + "MORE\n");
    const off = await sync({ ...e.ctx, gitTracked: t.fn }, { scope: "user" });
    assert.deepEqual(off.scopes[0]!.updated.map((i) => i.key).sort(), ["agents/a", "skills/foo"]);
    assert.deepEqual(off.scopes[0]!.warnings, []);
    assert.deepEqual(t.calls, []);
  } finally {
    e.cleanup();
  }
});

test("k63: against a real repo the printed command untracks the skill; outside a work tree nothing is said", async () => {
  const e = env();
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: e.projectDir, env: G, encoding: "utf8" });
    const src = filesSource(e.tmp.dir, "k63e", { "skills/foo/SKILL.md": SKILL_MD });
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] }, gitignore: false });
    git("init", "-q", "-b", "main");
    await sync(e.ctx, { scope: "project" }); // the default tracked test: git ls-files
    git("add", "-A");
    git("commit", "-qm", "committed while gitignore was false");
    assert.match(git("ls-files"), /^\.claude\/skills\/foo\/SKILL\.md$/m);

    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const on = await sync(e.ctx, { scope: "project" }); // writes only the skill's untracked .gitignore
    assert.deepEqual(on.scopes[0]!.warnings, []);

    // Not a work tree (the ceiling keeps a repo around the temp dir out): nothing to say.
    renameSync(join(e.projectDir, ".git"), join(e.projectDir, ".git-off"));
    process.env.GIT_CEILING_DIRECTORIES = e.tmp.dir;
    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL_MD + "1\n");
    const outside = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(outside.scopes[0]!.updated.map((i) => i.key), ["skills/foo"]);
    assert.deepEqual(outside.scopes[0]!.warnings, []);
    renameSync(join(e.projectDir, ".git-off"), join(e.projectDir, ".git"));

    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL_MD + "2\n");
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.warnings, [TRACKED("skills/foo", "git rm -r --cached .claude/skills/foo")]);

    // The command works as printed, from the project root; afterwards the skill is quiet.
    const [cmd, ...args] = r.scopes[0]!.warnings[0]!.split("untrack it: ")[1]!.split(" ");
    execFileSync(cmd!, args, { cwd: e.projectDir, env: G, stdio: "ignore" });
    assert.doesNotMatch(git("ls-files"), /skills\/foo/);
    writeFileSync(join(src, "skills/foo/SKILL.md"), SKILL_MD + "3\n");
    const after = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(after.scopes[0]!.updated.map((i) => i.key), ["skills/foo"]);
    assert.deepEqual(after.scopes[0]!.warnings, []);
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    e.cleanup();
  }
});

// ---- k65: project blocks only while the project scope is in use (spec §6.4) ----

const projectOf = (r: Awaited<ReturnType<typeof sync>>) => r.scopes.find((s) => s.scope === "project")!;

test("k65: a project without config or lock gets nothing written and no commit hint", async () => {
  const e = env();
  try {
    rmSync(join(e.projectDir, ".claude"), { recursive: true }); // a repository that never used skilletor
    const src = localSource(e.tmp.dir, "srcK1", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx);
    assert.equal(r.error, undefined);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    assert.deepEqual(readdirSync(e.projectDir), []);
    assert.equal(projectOf(r).gitignoreUpdated, undefined);
    assert.doesNotMatch(reportText(r), /project scope|commit it/);
    assert.doesNotMatch(reportHook(r).systemMessage ?? "", /commit it/);
  } finally {
    e.cleanup();
  }
});

test("k65: a block an earlier version left in an unused project is removed without a hint; own lines stay", async () => {
  const e = env();
  try {
    e.writeCfg("user", {});
    const p = e.projectDir;
    // What versions up to 0.2.0 wrote into every project a sync started in.
    writeFileSync(join(p, ".claude/.gitignore"), BLOCK("skilletor.local.json", "skilletor.lock.json"));
    mkdirSync(join(p, ".codex"));
    writeFileSync(join(p, ".codex/.gitignore"), "own-line\n\n" + BLOCK("agents/**/.local.*", "skilletor-rules.md"));
    const r = await sync(e.ctx);
    assert.equal(existsSync(join(p, ".claude/.gitignore")), false); // only the block: the file goes
    assert.equal(readFileSync(join(p, ".codex/.gitignore"), "utf8"), "own-line\n");
    assert.equal(projectOf(r).gitignoreUpdated, undefined);
    assert.equal(reportText(r), "");
  } finally {
    e.cleanup();
  }
});

test("k65: a project skilletor.json, even empty, or skilletor.local.json alone puts the project in use", async () => {
  const e = env();
  try {
    e.writeCfg("user", {});
    const gi = join(e.projectDir, ".claude/.gitignore");
    e.writeCfg("project", {});
    const first = await sync(e.ctx);
    assert.equal(readFileSync(gi, "utf8"), PROJECT_BLOCK);
    assert.deepEqual(projectOf(first).gitignoreUpdated, [".claude/.gitignore"]);
    rmSync(join(e.projectDir, ".claude/skilletor.json"));
    e.writeCfg("local", {});
    const local = await sync(e.ctx);
    assert.equal(readFileSync(gi, "utf8"), PROJECT_BLOCK);
    assert.equal(projectOf(local).gitignoreUpdated, undefined);
    rmSync(join(e.projectDir, ".claude/skilletor.local.json"));
    const none = await sync(e.ctx);
    assert.equal(existsSync(gi), false);
    assert.equal(projectOf(none).gitignoreUpdated, undefined);
  } finally {
    e.cleanup();
  }
});

test("k65: a project in use with nothing installed has a block but no lock, stable across syncs", async () => {
  const e = env();
  try {
    e.writeCfg("user", {});
    e.writeCfg("project", {});
    const gi = join(e.projectDir, ".claude/.gitignore");
    const lockPath = join(e.projectDir, ".claude/skilletor.lock.json");
    await sync(e.ctx);
    assert.equal(readFileSync(gi, "utf8"), PROJECT_BLOCK);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(join(e.home, ".claude/skilletor.lock.json")), false); // user scope: nothing either
    const mtime = statSync(gi).mtimeMs;
    const again = await sync(e.ctx);
    assert.equal(statSync(gi).mtimeMs, mtime);
    assert.equal(existsSync(lockPath), false);
    assert.equal(projectOf(again).gitignoreUpdated, undefined);
    assert.equal(reportText(again), "");
  } finally {
    e.cleanup();
  }
});

test("k65: config removed: the sync that removes the last item removes the block too, without a hint", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcK2", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const gi = join(e.projectDir, ".claude/.gitignore");
    await sync(e.ctx);
    assert.equal(readFileSync(gi, "utf8"), PROJECT_BLOCK);
    rmSync(join(e.projectDir, ".claude/skilletor.json"));
    const r = await sync(e.ctx);
    assert.deepEqual(projectOf(r).removed.map((i) => i.key), ["skills/foo"]);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills")), false);
    assert.equal(existsSync(gi), false);
    assert.equal(existsSync(join(e.projectDir, ".claude/skilletor.lock.json")), false); // never left as {}
    assert.deepEqual(readdirSync(join(e.projectDir, ".claude")), []);
    assert.equal(projectOf(r).gitignoreUpdated, undefined);
    assert.doesNotMatch(reportText(r), /commit it/);
  } finally {
    e.cleanup();
  }
});

test("k65: while the lock still holds entries the block stays; an emptied lock no longer counts", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcK3", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const gi = join(e.projectDir, ".claude/.gitignore");
    const lockPath = join(e.projectDir, ".claude/skilletor.lock.json");
    writeFileSync(gi, "own\n");
    await sync(e.ctx);
    // An entry of a harness a later version knows: kept untouched, so the lock stays non-empty.
    writeFileSync(lockPath, JSON.stringify({ ...readLock(lockPath), "later:skills/x": { source: "mine", version: "v1", files: {} } }));
    rmSync(join(e.projectDir, ".claude/skilletor.json"));
    const r = await sync(e.ctx);
    assert.deepEqual(projectOf(r).removed.map((i) => i.key), ["skills/foo"]);
    assert.deepEqual(Object.keys(readLock(lockPath)), ["later:skills/x"]);
    assert.equal(readFileSync(gi, "utf8"), "own\n\n" + PROJECT_BLOCK);
    assert.equal(projectOf(r).gitignoreUpdated, undefined);
    writeFileSync(lockPath, "{}\n"); // what earlier versions left when the last entry went
    const empty = await sync(e.ctx);
    assert.equal(readFileSync(gi, "utf8"), "own\n");
    assert.equal(existsSync(lockPath), false); // a lock without entries is deleted
    assert.equal(projectOf(empty).gitignoreUpdated, undefined);
  } finally {
    e.cleanup();
  }
});

// ---- k64: check sees an installed state off the §6.4 layout (spec §14.3) ----------

/** `check`'s layout verdict. Local sources always count as changed, so tests with one
 *  look at `layoutChanged`, the signal under test. */
const layoutOf = async (ctx: EngineContext, scope: "user" | "project" = "project") =>
  (await check(ctx, { scope })).layoutChanged;

test("k64: check reports pre-k62 lock entries (plain agent and rule files, a skill without .gitignore); one sync migrates", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k64a", { ...K62_FILES, "rules/lang/perl.md": RULE_MD });
    const install = { ...K62_INSTALL, rules: ["r@mine", "lang/perl@mine"] };
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install });
    await sync(e.ctx, { scope: "project" });
    assert.equal(await layoutOf(e.ctx), undefined);
    // One earlier-version entry at a time: the verdict comes from the lock alone.
    const lockPath = join(e.projectDir, ".claude/skilletor.lock.json");
    const current = readFileSync(lockPath, "utf8");
    const old: Record<string, string> = {
      "agents/a": "agents/a.md", "rules/r": "rules/r.md", "rules/lang/perl": "rules/lang/perl.md", "skills/foo": "skills/foo/SKILL.md",
    };
    for (const [key, rel] of Object.entries(old)) {
      writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(current), [key]: { source: "mine", version: "local", files: { [rel]: "sha256:x" } } }));
      assert.deepEqual(await layoutOf(e.ctx), ["project"], key);
      assert.equal(await layoutOf(e.ctx, "user"), undefined, key);
    }

    // The whole tree as 0.2.0 left it: check says so, the sync migrates, check is quiet.
    rmSync(join(e.projectDir, ".claude"), { recursive: true });
    const claude = join(e.projectDir, ".claude");
    const files: Record<string, string> = { "skills/foo/SKILL.md": SKILL_MD, "agents/a.md": AGENT_MD, "rules/r.md": RULE_MD };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(claude, rel, ".."), { recursive: true });
      writeFileSync(join(claude, rel), text);
    }
    const entry = (rel: string) => ({ source: "mine", version: "local", files: { [rel]: hashBuffer(Buffer.from(files[rel]!)) } });
    writeFileSync(lockPath, JSON.stringify({
      "agents/a": entry("agents/a.md"), "rules/r": entry("rules/r.md"), "skills/foo": entry("skills/foo/SKILL.md"),
    }));
    e.writeCfg("project", { install: K62_INSTALL });
    const chk = await check(e.ctx, { scope: "project" });
    assert.deepEqual([chk.changed, chk.layoutChanged, chk.targetsChanged], [true, ["project"], undefined]);
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.updated.map((i) => i.key).sort(), ["agents/a", "rules/r", "skills/foo"]);
    assert.equal(existsSync(join(claude, "agents/.local.a.md")), true);
    assert.equal(existsSync(join(claude, "skills/foo/.gitignore")), true);
    assert.equal(await layoutOf(e.ctx), undefined);
  } finally {
    e.cleanup();
  }
});

test("k64: a current lock is no layout drift; skip entries and entries of unknown harnesses are never drift", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k64b", K62_FILES);
    e.writeCfg("user", { sources: { mine: { local: src } }, install: K62_INSTALL });
    e.writeCfg("project", { install: K62_INSTALL });
    await sync(e.ctx);
    const chk = await check(e.ctx);
    assert.deepEqual([chk.error, chk.layoutChanged, chk.targetsChanged], [undefined, undefined, undefined]);
    const lockPath = join(e.projectDir, ".claude/skilletor.lock.json");
    writeFileSync(lockPath, JSON.stringify({
      ...readLock(lockPath),
      "skills/gated": { source: "mine", version: "local", files: {}, skipped: "renders-empty" },
      "agents/gated": { source: "mine", version: "local", files: {}, skipped: "renders-empty" },
      "later:agents/x": { source: "mine", version: "v1", files: { "agents/x.md": "sha256:x" } },
    }));
    assert.equal(await layoutOf(e.ctx), undefined);
  } finally {
    e.cleanup();
  }
});

test("k64: the gitignore switch: skilletor's skill .gitignore is drift while off, its absence while on; a shipped one is not", async () => {
  const e = env();
  try {
    const src = filesSource(e.tmp.dir, "k64c", {
      "skills/foo/SKILL.md": SKILL_MD, "skills/bar/SKILL.md": SKILL_MD, "skills/bar/.gitignore": "node_modules/\n",
    });
    const install = { skills: ["foo@mine", "bar@mine"] };
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install });
    await sync(e.ctx, { scope: "project" });
    assert.equal(await layoutOf(e.ctx), undefined);

    e.writeCfg("project", { install, gitignore: false });
    assert.deepEqual(await layoutOf(e.ctx), ["project"]);
    await sync(e.ctx, { scope: "project" });
    // bar installs the .gitignore its source ships: owned, but not skilletor's.
    assert.equal(readFileSync(join(e.projectDir, ".claude/skills/bar/.gitignore"), "utf8"), "node_modules/\n");
    assert.equal(await layoutOf(e.ctx), undefined);

    e.writeCfg("project", { install });
    assert.deepEqual(await layoutOf(e.ctx), ["project"]);
    await sync(e.ctx, { scope: "project" });
    assert.equal(await layoutOf(e.ctx), undefined);
  } finally {
    e.cleanup();
  }
});

test("k64: an unused project holding a skilletor block in any root is drift; the sync removes it, own lines stay", async () => {
  const e = env();
  try {
    e.writeCfg("user", {}); // no source: a change can only come from the layout
    const p = e.projectDir;
    assert.deepEqual(await check(e.ctx), { changed: false, sources: [], warnings: [] });
    writeFileSync(join(p, ".claude/.gitignore"), "own\n");
    assert.equal((await check(e.ctx)).changed, false);
    for (const root of [".claude", ".agents", ".codex"]) {
      mkdirSync(join(p, root), { recursive: true });
      writeFileSync(join(p, root, ".gitignore"), "own\n\n" + BLOCK("skilletor.local.json", "skilletor.lock.json"));
      const chk = await check(e.ctx);
      assert.deepEqual([chk.changed, chk.layoutChanged], [true, ["project"]], root);
      assert.equal(await layoutOf(e.ctx, "user"), undefined, root);
      const r = await sync(e.ctx);
      assert.equal(readFileSync(join(p, root, ".gitignore"), "utf8"), "own\n", root);
      assert.equal(reportText(r), "", root);
      assert.equal((await check(e.ctx)).changed, false, root);
    }
  } finally {
    e.cleanup();
  }
});

test("k64: a project in use with its block, and a user block in a work tree, are no drift; check asks git nothing", async () => {
  const e = env();
  try {
    e.writeCfg("user", {});
    e.writeCfg("project", {});
    await sync({ ...e.ctx, isGitWorkTree: () => true });
    assert.equal(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), PROJECT_BLOCK);
    assert.equal(existsSync(join(e.home, ".claude/.gitignore")), true);
    const asked: string[] = [];
    const ctx: EngineContext = {
      ...e.ctx,
      isGitWorkTree: (dir) => (asked.push(dir), true),
      gitTracked: (dir) => (asked.push(dir), []),
    };
    assert.deepEqual(await check(ctx), { changed: false, sources: [], warnings: [] });
    rmSync(join(e.projectDir, ".claude/skilletor.json"));
    e.writeCfg("local", {});
    assert.deepEqual(await check(ctx), { changed: false, sources: [], warnings: [] });
    assert.deepEqual(asked, []);
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
    execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
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
// ---- wildcards (k34) --------------------------------------------------------

/** Write a rule / agent / skill into a source dir (created on demand). */
function putItem(dir: string, type: "skill" | "agent" | "rule", name: string, body = name.toUpperCase()): void {
  if (type === "skill") {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\ndescription: ${name}\n---\n${body}\n`);
  } else {
    mkdirSync(join(dir, `${type}s`), { recursive: true });
    writeFileSync(join(dir, `${type}s`, `${name}.md`), `---\ndescription: ${name}\n---\n${body}\n`);
  }
}

test("wildcard installs every rule of a source, picks up additions and drops removals", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "wsrc");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    putItem(src, "skill", "notarule");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });

    const r1 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r1.scopes[0]!.added.map((i) => i.key).sort(), ["rules/alpha", "rules/beta"]);
    assert.deepEqual(r1.scopes[0]!.added.map((i) => i.source), ["shared", "shared"]);
    assert.equal(existsSync(join(e.home, ".claude/skills/notarule")), false); // other types untouched

    putItem(src, "rule", "gamma"); // upstream addition
    rmSync(join(src, "rules", "alpha.md")); // upstream removal
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r2.scopes[0]!.added.map((i) => i.key), ["rules/gamma"]);
    assert.deepEqual(r2.scopes[0]!.removed.map((i) => i.key), ["rules/alpha"]);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.alpha.md")), false);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.gamma.md")), true);
    assert.deepEqual(r2.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("wildcards work for skills and agents too", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "wall");
    putItem(src, "skill", "s1");
    putItem(src, "skill", "s2");
    putItem(src, "agent", "a1");
    e.writeCfg("user", {
      sources: { shared: { local: src } },
      install: { skills: ["*@shared"], agents: ["agent:*@shared"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["agents/a1", "skills/s1", "skills/s2"]);
  } finally {
    e.cleanup();
  }
});

test("an unresolvable wildcard source keeps everything it installed", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "gone");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });
    await sync(e.ctx, { scope: "user" });

    rmSync(src, { recursive: true, force: true }); // source can no longer be resolved
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.alpha.md")), true);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.beta.md")), true);
    assert.deepEqual(Object.keys(readLock(join(e.home, ".claude/skilletor.lock.json"))).sort(), ["rules/alpha", "rules/beta"]);
    assert.equal(r.scopes[0]!.warnings.some((w) => /shared/.test(w)), true);
  } finally {
    e.cleanup();
  }
});

test("an unresolvable wildcard source only keeps items of the wildcard's type and source", async () => {
  const e = env();
  try {
    const gone = join(e.tmp.dir, "gone2");
    const other = join(e.tmp.dir, "other2");
    putItem(gone, "rule", "alpha");
    putItem(other, "rule", "solo");
    e.writeCfg("user", {
      sources: { shared: { local: gone }, other: { local: other } },
      install: { rules: ["*@shared", "solo@other"] },
    });
    await sync(e.ctx, { scope: "user" });
    rmSync(gone, { recursive: true, force: true });
    e.writeCfg("user", { sources: { shared: { local: gone }, other: { local: other } }, install: { rules: ["*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["rules/solo"]); // undeclared, other source: removed
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.alpha.md")), true); // kept
  } finally {
    e.cleanup();
  }
});

test("explicit entry and wildcard of the same source dedupe silently", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "dd");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["alpha@shared", "*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/alpha", "rules/beta"]);
    assert.deepEqual(r.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("explicit entry beats a wildcard of another source, with a warning", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "ea");
    const b = join(e.tmp.dir, "eb");
    putItem(a, "rule", "alpha", "FROM-A");
    putItem(b, "rule", "alpha", "FROM-B");
    putItem(b, "rule", "beta");
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { rules: ["alpha@a", "*@b"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`).sort(), ["rules/alpha@a", "rules/beta@b"]);
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.alpha.md"), "utf8"), /FROM-A/);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /alpha/);
    assert.match(r.scopes[0]!.warnings[0]!, /\*@b/);
  } finally {
    e.cleanup();
  }
});

test("two wildcards yielding the same name skip only that name, with a warning", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "wa");
    const b = join(e.tmp.dir, "wb");
    putItem(a, "rule", "only-a");
    putItem(b, "rule", "only-b");
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { rules: ["*@a", "*@b"] } });
    const r1 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r1.scopes[0]!.warnings, []);

    putItem(a, "rule", "clash", "FROM-A"); // upstream addition in a …
    putItem(b, "rule", "clash", "FROM-B"); // … and in b
    putItem(b, "rule", "fresh");
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r2.scopes[0]!.added.map((i) => i.key), ["rules/fresh"]); // the rest proceeds
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.clash.md")), false);
    assert.equal(r2.scopes[0]!.warnings.length, 1);
    assert.match(r2.scopes[0]!.warnings[0]!, /clash/);
    assert.match(r2.scopes[0]!.warnings[0]!, /\*@a/);
    assert.match(r2.scopes[0]!.warnings[0]!, /\*@b/);
  } finally {
    e.cleanup();
  }
});

test("a wildcard collision keeps an already installed copy", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "ka");
    const b = join(e.tmp.dir, "kb");
    putItem(a, "rule", "clash", "FROM-A");
    mkdirSync(b, { recursive: true });
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { rules: ["*@a", "*@b"] } });
    await sync(e.ctx, { scope: "user" });
    putItem(b, "rule", "clash", "FROM-B");
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.clash.md"), "utf8"), /FROM-A/);
  } finally {
    e.cleanup();
  }
});

test("a wildcard skips an upstream item with an invalid name instead of failing the sync", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "bad");
    putItem(src, "rule", "good");
    putItem(src, "rule", "bad name");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/good"]);
    assert.equal(r.scopes[0]!.warnings.some((w) => /bad name/.test(w)), true);
  } finally {
    e.cleanup();
  }
});

test("a wildcard over an untrusted project-only source reports a trust request", async () => {
  const e = env();
  try {
    e.writeCfg("project", { sources: { team: { git: "file:///whatever.git" } }, install: { rules: ["*@team"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
    assert.deepEqual(r.scopes[0]!.added, []);
    const st = status(e.ctx, { scope: "project" });
    assert.deepEqual(st.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
  } finally {
    e.cleanup();
  }
});

test("status marks items that came from a wildcard and lists the wildcard", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "st");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["alpha@shared", "*@shared"] } });
    await sync(e.ctx, { scope: "user" });
    const s = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(
      s.declared.map((d) => ({ key: d.key, via: d.via, installed: d.installed })),
      [
        { key: "rules/alpha", via: undefined, installed: true },
        { key: "rules/beta", via: "*@shared", installed: true },
      ],
    );
    assert.deepEqual(s.orphans, []);
    assert.deepEqual(s.wildcards, [{ type: "rule", source: "shared", entry: "*@shared", installed: 1 }]);
  } finally {
    e.cleanup();
  }
});

test("check covers sources referenced only by a wildcard", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "ck");
    putItem(src, "rule", "alpha");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });
    const chk = await check(e.ctx, { scope: "user" });
    assert.deepEqual(chk.sources.map((s) => s.name), ["shared"]);
  } finally {
    e.cleanup();
  }
});

// ---- empty renders (k35) ----------------------------------------------------

/** Write a raw file into a source dir. */
function putRaw(dir: string, rel: string, content: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

const GATED = "---\npaths: [\"**/*.yaml\"]\n---\n{% if vars.k8s %}\nUse kubectl.\n{% endif %}\n";

test("a rule gated off by a var is not written and is reported as skipped", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g1");
    putRaw(src, "rules/k8s.md.njk", GATED);
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.k8s.md")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);
    assert.deepEqual([r.scopes[0]!.added, r.scopes[0]!.warnings], [[], []]);
    assert.match(reportText(r), /rules\/k8s skipped \(renders empty\)/);
    assert.deepEqual(reportHook(r), {}); // nothing changed: the hook stays silent
  } finally {
    e.cleanup();
  }
});

test("toggling the var off removes the installed rule; toggling it on reinstalls it", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g2");
    putRaw(src, "rules/k8s.md.njk", GATED);
    const cfg = (on: boolean) => ({ sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: on } });
    const target = join(e.home, ".claude/rules/.local.k8s.md");

    e.writeCfg("user", cfg(true));
    await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(target, "utf8"), /kubectl/);

    e.writeCfg("user", cfg(false));
    const off = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(target), false);
    assert.deepEqual(off.scopes[0]!.removed.map((i) => i.key), ["rules/k8s"]);
    assert.deepEqual(off.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);

    e.writeCfg("user", cfg(true));
    const on = await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(target, "utf8"), /kubectl/);
    assert.deepEqual(on.scopes[0]!.added.map((i) => i.key), ["rules/k8s"]);
    assert.deepEqual(on.scopes[0]!.skipped, []);
  } finally {
    e.cleanup();
  }
});

test("a project var can switch off a rule the user scope would install", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g3");
    putRaw(src, "rules/k8s.md.njk", GATED);
    e.writeCfg("user", { sources: { s: { local: src } }, vars: { k8s: true } });
    e.writeCfg("project", { install: { rules: ["k8s@s"] } });
    e.writeCfg("local", { vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".claude/rules/.local.k8s.md")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);
    assert.doesNotMatch(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), /k8s/);
  } finally {
    e.cleanup();
  }
});

test("a non-template empty rule is still installed", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g4");
    putRaw(src, "rules/blank.md", "");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["blank@s"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.blank.md")), true);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/blank"]);
    assert.deepEqual(r.scopes[0]!.skipped, []);
  } finally {
    e.cleanup();
  }
});

test("a skill whose SKILL.md renders empty skips all its files", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g5");
    putRaw(src, "skills/kube/SKILL.md.njk", "{% if vars.k8s %}---\ndescription: k\n---\nK{% endif %}");
    putRaw(src, "skills/kube/reference.md", "REFERENCE");
    putRaw(src, "skills/kube/extra.md.njk", "EXTRA");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { skills: ["kube@s"] }, vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/kube")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["skills/kube"]);
  } finally {
    e.cleanup();
  }
});

test("a wildcard item that renders empty is skipped without affecting its siblings", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g6");
    putRaw(src, "rules/k8s.md.njk", GATED);
    putRaw(src, "rules/plain.md", "PLAIN\n");
    putRaw(src, "rules/templ.md.njk", "T={{ vars.k8s }}\n");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["*@s"] }, vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/plain", "rules/templ"]);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.k8s.md")), false);
    const st = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(st.wildcards[0]!.installed, 2);
  } finally {
    e.cleanup();
  }
});

test("a render error is still an error: the installed copy stays, with a warning", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g7");
    putRaw(src, "rules/k8s.md.njk", GATED);
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: true } });
    await sync(e.ctx, { scope: "user" });
    putRaw(src, "rules/k8s.md.njk", "{{ vars.typo }}");
    const r = await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.k8s.md"), "utf8"), /kubectl/);
    assert.equal(r.scopes[0]!.warnings.some((w) => /template error/.test(w)), true);
    assert.deepEqual(r.scopes[0]!.skipped, []);
  } finally {
    e.cleanup();
  }
});

test("status tells a skipped item from one that is not installed, also when offline", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g8");
    putRaw(src, "rules/k8s.md.njk", GATED);
    putRaw(src, "rules/later.md", "L\n");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: false } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s", "later@s"] }, vars: { k8s: false } });
    const pick = () =>
      status(e.ctx, { scope: "user" }).scopes[0]!.declared.map((d) => ({ key: d.key, installed: d.installed, skipped: d.skipped }));
    const expected = [
      { key: "rules/k8s", installed: false, skipped: "renders-empty" },
      { key: "rules/later", installed: false, skipped: undefined },
    ];
    assert.deepEqual(pick(), expected);

    rmSync(src, { recursive: true, force: true }); // unresolvable: the skip marker is kept
    await sync(e.ctx, { scope: "user" });
    assert.deepEqual(pick(), expected);
  } finally {
    e.cleanup();
  }
});

// k44: a project dir that is the home dir (session started in ~, or ~ is a git
// checkout) must not read ~/.claude/skilletor.json a second time as project config.
test("a project dir equal to home has no project scope (sync, check, status)", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcH", "foo", "FOO");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const link = join(e.tmp.dir, "home-link");
    symlinkSync(e.home, link);
    for (const projectDir of [e.home, link]) {
      const ctx: EngineContext = { ...e.ctx, projectDir };
      const report = await sync(ctx);
      assert.deepEqual(report.scopes.map((s) => s.scope), ["user"], projectDir);
      assert.equal(existsSync(join(e.home, ".claude/.gitignore")), false, "no project gitignore in ~/.claude");
      const chk = await check(ctx);
      assert.deepEqual([...new Set(chk.sources.map((s) => s.scope))], ["user"]);
      const st = status(ctx);
      assert.deepEqual(st.scopes.map((s) => s.scope), ["user"]);
      assert.equal(st.projectIsHome, true);
      assert.equal((await sync(ctx, { scope: "project" })).scopes.length, 0);
    }
    assert.equal(status(e.ctx).projectIsHome, undefined);
  } finally {
    e.cleanup();
  }
});

// ---- patterns and bundles (k48, spec §3, §15) ---------------------------------

test("a pattern wildcard installs only matching items; a pattern matching nothing warns", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "pat");
    putItem(src, "rule", "perl-style");
    putItem(src, "rule", "perl-moo");
    putItem(src, "rule", "go-style");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["perl-*@shared", "zz-*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/perl-moo", "rules/perl-style"]);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /zz-\*@shared matches nothing/);
    const s = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(s.declared.map((d) => [d.key, d.via]).sort(), [["rules/perl-moo", "perl-*@shared"], ["rules/perl-style", "perl-*@shared"]]);
    assert.deepEqual(s.wildcards.map((w) => [w.entry, w.installed]), [["perl-*@shared", 2], ["zz-*@shared", 0]]);
  } finally {
    e.cleanup();
  }
});

test("the bare * matching nothing stays silent; a type prefix does not change that", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "norules");
    putItem(src, "skill", "s1");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"], agents: ["agent:*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("two patterns of the same source yielding one name install it once, silently", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "same");
    putItem(src, "rule", "perl-style");
    putItem(src, "rule", "perl-moo");
    putItem(src, "rule", "go-style");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["perl-*@shared", "*-style@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/go-style", "rules/perl-moo", "rules/perl-style"]);
    assert.deepEqual(r.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

/** A source with rules r1..r3, a template rule `t` printing vars, and bundles. */
function bundleSource(root: string, name: string, bundles: Record<string, string>, meta?: unknown): string {
  const src = join(root, name);
  for (const r of ["r1", "r2", "r3"]) putItem(src, "rule", r);
  putItem(src, "skill", "s1");
  putRaw(src, "rules/t.md.njk", "---\ndescription: t\n---\nv={{ vars.v }} w={{ vars.w }}\n");
  for (const [b, text] of Object.entries(bundles)) putRaw(src, `bundles/${b}.yaml`, text);
  if (meta) putRaw(src, "skilletor.json", JSON.stringify(meta));
  return src;
}

test("a bundle installs its items (names, patterns, nested bundles); dropping it removes them", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "b1", {
      perl: "description: P\nrules: [r1, \"r*\"]\nbundles: [base]\n",
      base: "description: B\nskills: [s1]\n",
    });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["perl@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/r1", "rules/r2", "rules/r3", "skills/s1"]);
    assert.deepEqual(r.scopes[0]!.warnings, []);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(lock["rules/r1"]!.via, ["bundle:perl@shared"]);

    const s = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(s.declared.map((d) => d.via), Array(4).fill("bundle:perl@shared"));
    assert.deepEqual(s.bundles, [{ name: "perl", source: "shared", entry: "perl@shared", installed: 4 }]);
    assert.deepEqual(s.orphans, []);

    e.writeCfg("user", { sources: { shared: { local: src } } });
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.equal(r2.scopes[0]!.removed.length, 4);
  } finally {
    e.cleanup();
  }
});

test("bundle vars: source defaults < bundle vars < user vars; the outer bundle wins along a chain", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bv", {
      outer: "description: O\nbundles: [inner]\nvars:\n  v: from-outer\n",
      inner: "description: I\nrules: [t]\nvars:\n  v: from-inner\n  w: from-inner\n",
    }, { vars: { v: "default", w: "default" } });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["outer@shared"] } });
    await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.t.md"), "utf8"), /v=from-outer w=from-inner/);

    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["outer@shared"] }, vars: { w: "user" } });
    await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.t.md"), "utf8"), /v=from-outer w=user/);
  } finally {
    e.cleanup();
  }
});

test("bundle vars conflict: neither value applies and one warning names both bundles", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bc", {
      a: "description: A\nrules: [t]\nvars:\n  v: from-a\n  w: same\n",
      b: "description: B\nrules: [t]\nvars:\n  v: from-b\n  w: same\n",
    }, { vars: { v: "default", w: "default" } });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["a@shared", "b@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.t.md"), "utf8"), /v=default w=same/);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /"v"/);
    assert.match(r.scopes[0]!.warnings[0]!, /bundle:a@shared/);
    assert.match(r.scopes[0]!.warnings[0]!, /bundle:b@shared/);
    assert.deepEqual(readLock(join(e.home, ".claude/skilletor.lock.json"))["rules/t"]!.via, ["bundle:a@shared", "bundle:b@shared"]);
  } finally {
    e.cleanup();
  }
});

test("an explicit item gets no bundle vars; same source silent, another source's bundle warns", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "be", { a: "description: A\nrules: [t, r1]\nvars:\n  v: from-a\n" }, { vars: { v: "default", w: "d" } });
    const other = bundleSource(e.tmp.dir, "bo", { o: "description: O\nrules: [r1, r2]\n" });
    e.writeCfg("user", {
      sources: { shared: { local: src }, other: { local: other } },
      install: { rules: ["t@shared", "r1@shared"], bundles: ["a@shared", "o@other"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.t.md"), "utf8"), /v=default/);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`).sort(), ["rules/r1@shared", "rules/r2@other", "rules/t@shared"]);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /r1.*bundle:o@other.*explicitly declared as r1@shared/);
    // The lock remembers that bundle a also declares the explicit items (for uninstall hints).
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(lock["rules/r1"]!.via, ["bundle:a@shared"]);
    assert.deepEqual(lock["rules/r2"]!.via, ["bundle:o@other"]);
    const st = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.equal(st.declared.find((d) => d.key === "rules/r1")!.via, undefined); // explicit
  } finally {
    e.cleanup();
  }
});

test("a bundle and a wildcard of different sources yielding one name skip it with a warning", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bw", { a: "description: A\nrules: [r1]\n" });
    const other = join(e.tmp.dir, "bw2");
    putItem(other, "rule", "r1");
    e.writeCfg("user", {
      sources: { shared: { local: src }, other: { local: other } },
      install: { rules: ["*@other", "r2@shared"], bundles: ["a@shared"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/r2"]);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /r1.*offered by .*skipped/);
    assert.match(r.scopes[0]!.warnings[0]!, /bundle:a@shared/);
    assert.match(r.scopes[0]!.warnings[0]!, /\*@other/);
  } finally {
    e.cleanup();
  }
});

test("a bundle and a wildcard of the same source yielding one name install it once, silently", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bs", { a: "description: A\nrules: [r1]\n" });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["r*@shared"], bundles: ["a@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/r1", "rules/r2", "rules/r3"]);
    assert.deepEqual(r.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("a bundle error affects only that bundle and keeps what it installed", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "berr", {
      a: "description: A\nrules: [r1]\n",
      b: "description: B\nrules: [r2]\n",
    });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["a@shared", "b@shared"] } });
    await sync(e.ctx, { scope: "user" });

    putRaw(src, "bundles/a.yaml", "description: A\nrules: [r1]\nbundles: [a]\n"); // now a cycle
    putRaw(src, "bundles/b.yaml", "description: B\nrules: [r2, r3]\n");
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/r3"]);
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), true);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /bundle:a@shared.*cycle a → a/);
    // Still kept, with its via, on the next run.
    await sync(e.ctx, { scope: "user" });
    assert.deepEqual(readLock(join(e.home, ".claude/skilletor.lock.json"))["rules/r1"]!.via, ["bundle:a@shared"]);
  } finally {
    e.cleanup();
  }
});

test("a missing bundle warns; an unresolvable source keeps what its bundle installed", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bgone", { a: "description: A\nrules: [r1]\n" });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["a@shared", "ghost@shared"] } });
    const r1 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r1.scopes[0]!.added.map((i) => i.key), ["rules/r1"]);
    assert.equal(r1.scopes[0]!.warnings.length, 1);
    assert.match(r1.scopes[0]!.warnings[0]!, /bundle:ghost@shared.*not found/);

    rmSync(src, { recursive: true, force: true });
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r2.scopes[0]!.removed, []);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), true);
  } finally {
    e.cleanup();
  }
});

test("bundle warnings (missing name, other source not supported yet) reach the report", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bwarn", { a: "description: A\nrules: [r1, nope, x@Getty]\n" });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["a@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/r1"]);
    assert.equal(r.scopes[0]!.warnings.length, 2);
    assert.match(r.scopes[0]!.warnings.join("\n"), /nope/);
    assert.match(r.scopes[0]!.warnings.join("\n"),
      /bundle a@shared needs Getty \(https:\/\/github\.com\/Getty\/skills\): run skilletor install bundle:a@shared/);
  } finally {
    e.cleanup();
  }
});

test("check covers sources referenced only by a bundle", async () => {
  const e = env();
  try {
    const src = bundleSource(e.tmp.dir, "bck", { a: "description: A\nrules: [r1]\n" });
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { bundles: ["a@shared"] } });
    const chk = await check(e.ctx, { scope: "user" });
    assert.deepEqual(chk.sources.map((s) => s.name), ["shared"]);
  } finally {
    e.cleanup();
  }
});

// ---- bundles naming items of other sources (k48 phase B, spec §15.6) -----------

/** A source with an identity (`git`) served offline by an author-mode `local` checkout. */
function foreignSource(root: string, name: string, rules: string[], meta?: unknown): string {
  const dir = join(root, name);
  for (const r of rules) putItem(dir, "rule", r, `${r.toUpperCase()}-FROM-${name}`);
  putRaw(dir, "rules/ft.md.njk", "---\ndescription: ft\n---\nv={{ vars.v }} d={{ vars.d }}\n");
  if (meta) putRaw(dir, "skilletor.json", JSON.stringify(meta));
  return dir;
}

test("a foreign entry is served by the source with the same identity, whatever its config name", async () => {
  const e = env();
  try {
    const own = bundleSource(e.tmp.dir, "fown", {
      perl: "description: P\nrules: [r1, \"p-*@gitlab.com/peter\", ft@gitlab.com/peter]\nvars:\n  v: bundle\n",
    }, { vars: { d: "own-default" } });
    const peter = foreignSource(e.tmp.dir, "fpeter", ["p-one", "p-two", "other"], { vars: { d: "peter-default", v: "peter" } });
    e.writeCfg("user", {
      sources: { shared: { local: own }, pm: { git: "https://GitLab.com/peter/skills.git", local: peter } },
      install: { bundles: ["perl@shared"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`).sort(),
      ["rules/ft@pm", "rules/p-one@pm", "rules/p-two@pm", "rules/r1@shared"]);
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.p-one.md"), "utf8"), /P-ONE-FROM-fpeter/);
    // Bundle vars apply; source defaults are the item's own source's (spec §15.3).
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.ft.md"), "utf8"), /v=bundle d=peter-default/);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(lock["rules/p-one"]!.via, ["bundle:perl@shared"]);
    const st = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.equal(st.declared.find((d) => d.key === "rules/p-one")!.via, "bundle:perl@shared");
    assert.deepEqual(st.bundles.map((b) => b.installed), [4]);
    const chk = await check(e.ctx, { scope: "user" });
    assert.deepEqual(chk.sources.map((s) => s.name).sort(), ["pm", "shared"]);
  } finally {
    e.cleanup();
  }
});

test("a foreign entry served by a file:// git source", async () => {
  const e = env();
  try {
    const bare = join(e.tmp.dir, "peter.git");
    const work = join(e.tmp.dir, "pwork");
    const G = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
    putItem(work, "rule", "g1", "G1-FROM-GIT");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
    execFileSync("git", ["add", "."], { cwd: work, env: { ...process.env, ...G } });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: work, env: { ...process.env, ...G } });
    const url = "file://" + resolvePath(bare);
    execFileSync("git", ["push", "-q", url, "main"], { cwd: work, env: { ...process.env, ...G } });

    const own = bundleSource(e.tmp.dir, "gown", { b: `description: B\nrules: [g1@${url}]\n` });
    e.writeCfg("user", { sources: { shared: { local: own }, whatever: { git: url } }, install: { bundles: ["b@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.match(readFileSync(join(e.home, ".claude/rules/.local.g1.md"), "utf8"), /G1-FROM-GIT/);
  } finally {
    e.cleanup();
  }
});

test("a missing foreign source: one warning per source and bundle, its items skipped, the rest proceeds", async () => {
  const e = env();
  try {
    const own = bundleSource(e.tmp.dir, "mown", {
      a: "description: A\nrules: [r1, x@gitlab.com/peter, y@gitlab.com/peter]\n",
      b: "description: B\nrules: [r2, z@gitlab.com/peter]\n",
    });
    e.writeCfg("user", { sources: { shared: { local: own } }, install: { bundles: ["a@shared", "b@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/r1", "rules/r2"]);
    assert.deepEqual(r.scopes[0]!.warnings, [
      "bundle a@shared needs gitlab.com/peter (https://gitlab.com/peter/skills): run skilletor install bundle:a@shared",
      "bundle b@shared needs gitlab.com/peter (https://gitlab.com/peter/skills): run skilletor install bundle:b@shared",
    ]);
  } finally {
    e.cleanup();
  }
});

test("a foreign source removed from the config keeps what the bundle installed from it", async () => {
  const e = env();
  try {
    const own = bundleSource(e.tmp.dir, "kown", { a: "description: A\nrules: [\"p-*@gitlab.com/peter\"]\n" });
    const peter = foreignSource(e.tmp.dir, "kpeter", ["p-one"]);
    const cfg = { shared: { local: own }, pm: { git: "https://gitlab.com/peter/skills", local: peter } };
    e.writeCfg("user", { sources: cfg, install: { bundles: ["a@shared"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { shared: { local: own } }, install: { bundles: ["a@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.p-one.md")), true);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    // Dropping the bundle removes it.
    e.writeCfg("user", { sources: { shared: { local: own } } });
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r2.scopes[0]!.removed.map((i) => i.key), ["rules/p-one"]);
  } finally {
    e.cleanup();
  }
});

test("a foreign entry matching nothing in its source warns; an untrusted project source asks for trust", async () => {
  const e = env();
  try {
    const own = bundleSource(e.tmp.dir, "town", { a: "description: A\nrules: [\"zz-*@gitlab.com/peter\", q@Getty]\n" });
    const peter = foreignSource(e.tmp.dir, "tpeter", ["p-one"]);
    e.writeCfg("user", { sources: { shared: { local: own }, pm: { git: "https://gitlab.com/peter/skills", local: peter } } });
    e.writeCfg("project", { sources: { team: { git: "https://github.com/Getty/skills" } }, install: { bundles: ["a@shared"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
    assert.deepEqual(r.scopes[0]!.warnings, ["bundle a@shared: pattern rule:zz-* matches nothing in pm"]);
  } finally {
    e.cleanup();
  }
});

test("a user-scope bundle does not see a source only the project declares", async () => {
  const e = env();
  try {
    const own = bundleSource(e.tmp.dir, "vown", { a: "description: A\nrules: [p-one@gitlab.com/peter]\n" });
    const peter = foreignSource(e.tmp.dir, "vpeter", ["p-one"]);
    e.writeCfg("user", { sources: { shared: { local: own } }, install: { bundles: ["a@shared"] } });
    e.writeCfg("local", { sources: { pm: { git: "https://gitlab.com/peter/skills", local: peter } } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.match(r.scopes[0]!.warnings.join("\n"), /bundle a@shared needs gitlab\.com\/peter/);
  } finally {
    e.cleanup();
  }
});
