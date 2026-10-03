// `check` against the declared state (k70; spec §4.4, §8, §14.3): SessionStart syncs when
// the config no longer matches the lock – a declaration removed or added, an item moved to
// another source, a SHA pin – and names untrusted sources without syncing. What the last
// sync could not reach with its source at hand does not make every session sync again.
// No network: git sources are file:// bare repos; hooks are driven as a black box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { check, status, sync } from "../src/engine.ts";
import { cmdTrust } from "../src/commands.ts";
import { readLock } from "../src/lock.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { NO_SYMLINKS } from "./helpers/symlink.ts";

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  const cacheRoot = join(tmp.dir, "cache");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    cacheRoot,
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false, // never the real location of the temp dir
    gitTracked: () => [],
    background: () => {},
  };
  const writeCfg = (which: "user" | "project", obj: unknown) =>
    writeFileSync(join(which === "user" ? home : projectDir, ".claude", "skilletor.json"), JSON.stringify(obj, null, 2));
  const session = (c: HookContext = ctx) => runHook("session-start", { source: "startup", cwd: projectDir }, c);
  const userFile = (p: string) => join(home, ".claude", p);
  const cacheEmpty = () => !existsSync(cacheRoot) || readdirSync(cacheRoot).length === 0;
  return { tmp, ctx, home, projectDir, writeCfg, session, userFile, cacheEmpty };
}

const SKILL = (name: string, body = name.toUpperCase()) => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
};

/** A bare repo reachable as file://, seeded with `files`; `push` adds a commit and returns its sha. */
function gitSource(root: string, name: string, files: Record<string, string>) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: GIT_ENV, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare], { env: GIT_ENV });
  mkdirSync(work, { recursive: true });
  git("init", "-q", "-b", "main");
  const url = pathToFileURL(realpathSync(bare)).href;
  const push = (next: Record<string, string>): string => {
    writeFiles(work, next);
    git("add", ".");
    git("commit", "-qm", "c");
    git("push", "-q", url, "main");
    return git("rev-parse", "HEAD");
  };
  const first = push(files);
  return { url, bare: realpathSync(bare), first, push };
}

// ---- the audit probes ------------------------------------------------------------------

// Asserts: a declaration removed from the config is removed at the next SessionStart
// although its source did not move – also when the source goes with it (probe 04).
test("k70 probe 04: session-start removes an item whose declaration is gone, though no source moved", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo"), "skills/bar/SKILL.md": SKILL("bar") });
    const sources = { g: { git: repo.url } };
    e.writeCfg("user", { sources, install: { skills: ["foo@g", "bar@g"] }, checkInterval: 0 });
    assert.equal((await e.session()).systemMessage, "skilletor: 2 item(s) updated");
    assert.deepEqual(await e.session(), {}); // nothing moved: no sync

    e.writeCfg("user", { sources, install: { skills: ["foo@g"] }, checkInterval: 0 });
    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.declaredChanged, chk.sources], [true, ["user"], [{ name: "g", scope: "user", changed: false }]]);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 removed");
    assert.equal(existsSync(e.userFile("skills/bar")), false);
    assert.equal(existsSync(e.userFile("skills/foo/SKILL.md")), true);
    assert.deepEqual(await e.session(), {});

    // The probe's shape: the last item goes with its source, so no source is left to check.
    e.writeCfg("user", { checkInterval: 0 });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 removed");
    assert.equal(existsSync(e.userFile("skills/foo")), false);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a project whose only source is untrusted gets the trust request at every
// SessionStart, with nothing fetched or synced; once trusted, the next session installs (probe 05).
test("k70 probe 05: session-start names an untrusted project source each session, fetching nothing; trusted, the next installs", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "team", { "skills/foo/SKILL.md": SKILL("foo", "TEAM") });
    e.writeCfg("user", {});
    e.writeCfg("project", { sources: { team: { git: repo.url } }, install: { skills: ["foo@team"] } });
    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.declaredChanged, chk.trustRequests],
      [false, undefined, [{ scope: "project", name: "team", kind: "git", url: repo.url }]]);
    for (const n of [1, 2]) {
      const out = await e.session();
      assert.equal(out.systemMessage, "skilletor: 1 warning(s)", `session ${n}`);
      assert.equal(out.hookSpecificOutput?.additionalContext, `- untrusted source team (git ${repo.url}); run: skilletor trust team`);
      assert.equal(e.cacheEmpty(), true, `session ${n}: nothing fetched`);
      assert.equal(existsSync(join(e.projectDir, ".claude/skills")), false);
    }

    cmdTrust(e.ctx, { name: "team" });
    assert.match((await e.session()).systemMessage ?? "", /^skilletor: 1 item\(s\) updated/);
    assert.match(readFileSync(join(e.projectDir, ".claude/skills/foo/SKILL.md"), "utf8"), /TEAM/);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a first SHA pin is installed at SessionStart, a held pin needs neither a sync
// nor the remote, and a pin change or rollback is followed (probe 09).
test("k70 probe 09: session-start installs a first SHA pin and follows a pin change and its rollback", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo", "FIRST") });
    const second = repo.push({ "skills/foo/SKILL.md": SKILL("foo", "SECOND") });
    const pin = (ref: string) =>
      e.writeCfg("user", { sources: { g: { git: repo.url, ref } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    const foo = () => readFileSync(e.userFile("skills/foo/SKILL.md"), "utf8");
    pin(repo.first);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(foo(), /FIRST/);
    renameSync(repo.bare, repo.bare + ".off");
    assert.deepEqual(await e.session(), {}); // the lock holds the pin: no sync, no remote asked
    renameSync(repo.bare + ".off", repo.bare);
    for (const [ref, body] of [[second, /SECOND/], [repo.first, /FIRST/], [second.slice(0, 7), /SECOND/]] as const) {
      pin(ref);
      assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated", ref);
      assert.match(foo(), body, ref);
      assert.deepEqual(await e.session(), {}, ref);
    }
  } finally {
    e.tmp.cleanup();
  }
});

// ---- declarations added or moved -------------------------------------------------------

// Asserts: an item, a wildcard and a bundle declared over a source that did not move are
// each installed at the next SessionStart.
test("k70: session-start installs what was newly declared from an unchanged source: an item, a wildcard, a bundle", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", {
      "skills/foo/SKILL.md": SKILL("foo"), "skills/bar/SKILL.md": SKILL("bar"), "skills/baz/SKILL.md": SKILL("baz"),
      "rules/r1.md": "R1\n", "bundles/b.yaml": "description: B\nskills: [baz]\n",
    });
    const declare = (install: unknown) => e.writeCfg("user", { sources: { g: { git: repo.url } }, install });
    declare({ skills: ["foo@g"] });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    const steps: [unknown, string][] = [
      [{ skills: ["foo@g", "bar@g"] }, "skills/bar/SKILL.md"],
      [{ skills: ["foo@g", "bar@g"], rules: ["*@g"] }, "rules/.local.r1.md"],
      [{ skills: ["foo@g", "bar@g"], rules: ["*@g"], bundles: ["b@g"] }, "skills/baz/SKILL.md"],
    ];
    for (const [install, file] of steps) {
      declare(install);
      assert.deepEqual((await check(e.ctx)).declaredChanged, ["user"], file);
      assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated", file);
      assert.equal(existsSync(e.userFile(file)), true, file);
      assert.deepEqual(await e.session(), {}, file);
    }
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: an explicit item switched to another already-installed (unchanged) source is
// rebuilt from that source at the next SessionStart.
test("k70: session-start rebuilds an explicit item moved to another source that did not move", async () => {
  const e = env();
  try {
    const one = gitSource(e.tmp.dir, "one", { "skills/foo/SKILL.md": SKILL("foo", "ONE") });
    const two = gitSource(e.tmp.dir, "two", { "skills/foo/SKILL.md": SKILL("foo", "TWO"), "skills/bar/SKILL.md": SKILL("bar") });
    const sources = { one: { git: one.url }, two: { git: two.url } };
    e.writeCfg("user", { sources, install: { skills: ["foo@one", "bar@two"] } });
    assert.equal((await e.session()).systemMessage, "skilletor: 2 item(s) updated");
    e.writeCfg("user", { sources, install: { skills: ["foo@two", "bar@two"] } });
    assert.deepEqual((await check(e.ctx)).declaredChanged, ["user"]);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(readFileSync(e.userFile("skills/foo/SKILL.md"), "utf8"), /TWO/);
    assert.equal(readLock(e.userFile("skilletor.lock.json"))["skills/foo"]!.source, "two");
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// ---- the bound: what a sync could not reach is not retried every session --------------

// Asserts: a missing item, a bare wildcard that matches nothing and a lasting conflict make
// one sync, not one per session; the source moving tries everything open again.
test("k70: session-start syncs once for what its source cannot give – a missing item, an empty wildcard, a conflict", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo"), "skills/bar/SKILL.md": SKILL("bar") });
    mkdirSync(e.userFile("skills/bar"), { recursive: true });
    writeFileSync(e.userFile("skills/bar/SKILL.md"), "MINE\n"); // a foreign copy where bar goes
    // `nope` is not in the source; `rules: *@g` matches nothing there (silent, spec §3).
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g", "bar@g", "nope@g"], rules: ["*@g"] } });
    const first = await e.session();
    assert.equal(first.systemMessage, "skilletor: 1 item(s) updated, 2 warning(s)");
    assert.match(first.hookSpecificOutput?.additionalContext ?? "", /item not found in source g: skill nope/);
    assert.deepEqual(await e.session(), {}); // no second sync, no repeated warnings
    assert.equal((await check(e.ctx)).changed, false);

    repo.push({ "skills/nope/SKILL.md": SKILL("nope"), "rules/r.md": "R\n" });
    assert.equal((await e.session()).systemMessage, "skilletor: 2 item(s) updated, 1 warning(s)"); // bar still conflicts
    assert.equal(existsSync(e.userFile("skills/nope/SKILL.md")), true);
    assert.equal(existsSync(e.userFile("rules/.local.r.md")), true);
    assert.equal(readFileSync(e.userFile("skills/bar/SKILL.md"), "utf8"), "MINE\n");
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: an item whose template fails for one harness leaves that target's lock entry
// missing; the target test does not make every session sync for it.
test("k70: a template failing for one harness syncs once; the target gap it leaves is not retried each session", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", {
      "skills/foo/SKILL.md.njk": "---\nname: foo\ndescription: foo\n---\n{% if harness == \"codex\" %}{{ nope }}{% endif %}FOO\n",
    });
    const ctx: HookContext = { ...e.ctx, markers: { claude: [e.home], codex: [e.home] }, codexHome: join(e.home, ".codex") };
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] } });
    const first = await e.session(ctx);
    assert.equal(first.systemMessage, "skilletor: 1 item(s) updated, 1 warning(s)");
    assert.match(first.hookSpecificOutput?.additionalContext ?? "", /template error in skill foo \(codex\)/);
    const chk = await check(ctx);
    assert.deepEqual([chk.changed, chk.targetsChanged, chk.declaredChanged], [false, undefined, undefined]);
    assert.deepEqual(await e.session(ctx), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: layout drift an item's own conflict blocks is recorded and no longer counts; drift
// kept because its source failed stays open until a sync with the source reaches it (k64).
test("k70: layout drift blocked by a conflict stops counting after one sync; drift kept by a failing source stays open", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "a");
    const b = join(e.tmp.dir, "b");
    writeFiles(a, { "skills/y/SKILL.md": SKILL("y") });
    writeFiles(b, { "skills/x/SKILL.md": SKILL("x") });
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { skills: ["y@a", "x@b"] } });
    await sync(e.ctx, { scope: "user" });
    // As an earlier version left them: no skilletor .gitignore in either skill; at y's, a foreign one.
    const lockPath = e.userFile("skilletor.lock.json");
    const lock = readLock(lockPath);
    for (const s of ["x", "y"]) delete lock[`skills/${s}`]!.files[`skills/${s}/.gitignore`];
    writeFileSync(lockPath, JSON.stringify(lock));
    rmSync(e.userFile("skills/x/.gitignore"));
    writeFileSync(e.userFile("skills/y/.gitignore"), "own\n");
    const hidden = b + ".off";
    renameSync(b, hidden);
    // Local sources always count as changed; layoutChanged is the signal under test.
    const layout = async () => (await check(e.ctx, { scope: "user" })).layoutChanged;
    assert.deepEqual(await layout(), ["user"]);

    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.conflicts, [{ path: "skills/y/.gitignore" }]);
    assert.match(r.scopes[0]!.warnings.join("\n"), /source b: /);
    assert.deepEqual(await layout(), ["user"]); // x: kept by its failing source, still open

    renameSync(hidden, b);
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(e.userFile("skills/x/.gitignore")), true);
    assert.equal(readFileSync(e.userFile("skills/y/.gitignore"), "utf8"), "own\n");
    assert.equal(await layout(), undefined); // y: blocked by its conflict, tried and recorded
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: the record is only a hint – unreadable or malformed, it counts as empty, the hook
// syncs as before and the next sync writes it anew; a hook never fails on it.
test("k70: a corrupt unreached.json counts as no record; session-start syncs and rewrites it", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g", "nope@g"] } });
    assert.match((await e.session()).systemMessage ?? "", /^skilletor: 1 item\(s\) updated, 1 warning\(s\)$/);
    const record = join(e.ctx.stateRoot, "unreached.json");
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { [e.userFile("skilletor.lock.json")]: ["missing:skills/nope@g"] });
    for (const junk of ["{ broken", JSON.stringify({ [e.userFile("skilletor.lock.json")]: "missing:skills/nope@g" })]) {
      writeFileSync(record, junk);
      assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)", junk); // counted again: one sync
      assert.deepEqual(await e.session(), {}, junk);
    }
  } finally {
    e.tmp.cleanup();
  }
});

// ---- a sync that failed midway (k71) ---------------------------------------------------

// Asserts: a lock entry an interrupted sync left partial is drift of its own – check asks
// for a sync though no source moved and every item is declared, and status marks it; the
// sync completes the entry, reports the item, and the next session is quiet.
test("k71: a partial lock entry makes check ask for a sync; the sync completes it", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    const lockFile = e.userFile("skilletor.lock.json");
    const lock = readLock(lockFile);
    writeFileSync(lockFile, JSON.stringify({ "skills/foo": { ...lock["skills/foo"], partial: true } }, null, 2) + "\n");

    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.declaredChanged, chk.sources], [true, ["user"], [{ name: "g", scope: "user", changed: false }]]);
    const row = () => status(e.ctx, { scope: "user" }).scopes[0]!.declared[0];
    assert.deepEqual(row(), { key: "skills/foo", source: "g", installed: true, partial: true });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.deepEqual(readLock(lockFile), lock);
    assert.deepEqual(row(), { key: "skills/foo", source: "g", installed: true });
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a session-start sync that fails after writing (here: ~/.claude/rules is a file,
// so the rule cannot land) is one warning line, not a crash; once the obstacle is gone the
// next session finishes the job with no conflict on skilletor's own earlier output.
test("k71: a session-start sync that fails midway warns; the next session resumes without conflicts", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo"), "rules/r.md": "R\n" });
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"], rules: ["r@g"] }, checkInterval: 0 });
    writeFileSync(e.userFile("rules"), "a file where the rules dir goes");
    const failed = await e.session();
    assert.match(failed.systemMessage ?? "", /^skilletor: .*(EEXIST|ENOTDIR)/);
    assert.equal(existsSync(e.userFile("skills/foo/SKILL.md")), true, "foo landed before the failure");
    assert.equal(readLock(e.userFile("skilletor.lock.json"))["skills/foo"]?.partial, true);

    rmSync(e.userFile("rules"));
    const out = await e.session();
    assert.equal(out.systemMessage, "skilletor: 2 item(s) updated");
    assert.doesNotMatch(out.hookSpecificOutput?.additionalContext ?? "", /conflict/);
    assert.equal(readFileSync(e.userFile("rules/.local.r.md"), "utf8"), "R\n");
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a sync that fails midway clears the scope's unreached record. The record comes
// from an earlier sync that left a partial entry blocked (a linked skill dir) and so keeps
// `check` quiet about it; once the link is gone, a sync that fails again leaves the entry
// partial – and `check` must count that again, though no source moved and nothing else
// differs, so the next session finishes it.
test("k71: a sync that fails midway clears the unreached record; check counts the partial entry again", { skip: NO_SYMLINKS }, async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo"), "rules/r.md": "R\n", "agents/a.md": "---\nname: a\n---\nA\n" });
    const sources = { g: { git: repo.url } };
    const declare = (install: unknown) => e.writeCfg("user", { sources, install, checkInterval: 0 });
    declare({ skills: ["foo@g"], rules: ["r@g"] });
    writeFileSync(e.userFile("rules"), "a file where the rules dir goes");
    assert.match((await e.session()).systemMessage ?? "", /EEXIST|ENOTDIR/); // foo lands, partial
    rmSync(e.userFile("rules"));
    rmSync(e.userFile("skills/foo"), { recursive: true });
    mkdirSync(join(e.tmp.dir, "elsewhere"));
    symlinkSync(join(e.tmp.dir, "elsewhere"), e.userFile("skills/foo")); // blocks foo's retry
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated, 1 warning(s)"); // r; foo conflicts
    assert.deepEqual(await e.session(), {}, "the blocked partial entry is recorded as unreached");

    rmSync(e.userFile("skills/foo"));
    declare({ skills: ["foo@g"], agents: ["a@g"], rules: ["r@g"] });
    writeFileSync(e.userFile("agents"), "a file where the agents dir goes");
    assert.match((await e.session()).systemMessage ?? "", /EEXIST|ENOTDIR/); // foo lands again, a fails
    assert.equal(readLock(e.userFile("skilletor.lock.json"))["skills/foo"]?.partial, true);
    rmSync(e.userFile("agents"));
    declare({ skills: ["foo@g"], rules: ["r@g"] });

    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.declaredChanged], [true, ["user"]]);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.equal(readLock(e.userFile("skilletor.lock.json"))["skills/foo"]?.partial, undefined);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// ---- a source with nothing in the lock, or entries of several versions (k80) ------------

// Asserts: a git source whose only item is blocked by a conflict leaves no lock entry, yet
// the session after that sync neither syncs nor fetches: `check` compares the source with
// the version the last sync read, not with an empty lock. An upstream move still syncs, once.
test("k80: a source with nothing in the lock syncs once; the next session is silent and fetches nothing; a move syncs again", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    mkdirSync(e.userFile("skills/foo"), { recursive: true });
    writeFileSync(e.userFile("skills/foo/SKILL.md"), "MINE\n"); // a foreign copy where foo goes
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    const first = await e.session();
    assert.equal(first.systemMessage, "skilletor: 1 warning(s)");
    assert.match(first.hookSpecificOutput?.additionalContext ?? "", /conflict/);
    assert.equal(existsSync(e.userFile("skilletor.lock.json")), false, "nothing of g is in the lock");

    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.sources], [false, [{ name: "g", scope: "user", changed: false }]]);
    rmSync(e.ctx.cacheRoot!, { recursive: true });
    assert.deepEqual(await e.session(), {});
    assert.equal(e.cacheEmpty(), true, "the second session fetched nothing");

    repo.push({ "skills/foo/SKILL.md": SKILL("foo", "MOVED") });
    const moved = await e.session();
    assert.equal(moved.systemMessage, "skilletor: 1 warning(s)"); // synced; foo still conflicts
    assert.match(moved.hookSpecificOutput?.additionalContext ?? "", /conflict/);
    assert.equal(e.cacheEmpty(), false, "the move was fetched");
    assert.deepEqual(await e.session(), {});
    assert.equal(readFileSync(e.userFile("skills/foo/SKILL.md"), "utf8"), "MINE\n");
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: with nothing recorded – before a first sync, or with the record gone – a source
// with nothing in the lock counts as changed, as before k80: the session syncs, then is quiet.
test("k80: with no recorded version a source with nothing in the lock counts as changed; one session syncs", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    mkdirSync(e.userFile("skills/foo"), { recursive: true });
    writeFileSync(e.userFile("skills/foo/SKILL.md"), "MINE\n");
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    assert.deepEqual((await check(e.ctx)).sources, [{ name: "g", scope: "user", changed: true }], "first sync");
    assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)");
    assert.deepEqual(await e.session(), {});

    rmSync(join(e.ctx.stateRoot, "sources-read.json"));
    assert.deepEqual((await check(e.ctx)).sources, [{ name: "g", scope: "user", changed: true }], "record gone");
    assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)");
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: the recorded version is bound to the backend that read it. Pointed at another URL
// – a mirror at the very same commit – or given a ref, the source counts as changed and syncs
// once: a version one backend read proves nothing for another. A source removed from the
// config leaves the record with the next sync.
test("k80: a recorded version counts only for the backend that read it; a removed source leaves the record", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    const mirror = join(e.tmp.dir, "mirror.git");
    execFileSync("git", ["clone", "-q", "--bare", repo.bare, mirror], { env: GIT_ENV });
    mkdirSync(e.userFile("skills/foo"), { recursive: true });
    writeFileSync(e.userFile("skills/foo/SKILL.md"), "MINE\n");
    const declare = (g: unknown) => e.writeCfg("user", { sources: { g }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    declare({ git: repo.url });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)");
    assert.deepEqual(await e.session(), {});

    for (const g of [{ git: pathToFileURL(realpathSync(mirror)).href }, { git: pathToFileURL(realpathSync(mirror)).href, ref: "main" }]) {
      declare(g);
      assert.deepEqual((await check(e.ctx)).sources, [{ name: "g", scope: "user", changed: true }], JSON.stringify(g));
      assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)", JSON.stringify(g));
      assert.deepEqual(await e.session(), {}, JSON.stringify(g));
    }

    const record = join(e.ctx.stateRoot, "sources-read.json");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(record, "utf8"))[e.userFile("skilletor.lock.json")]), ["g"]);
    e.writeCfg("user", { checkInterval: 0 });
    assert.deepEqual(await e.session(), {}); // foo was never installed: nothing to remove
    await sync(e.ctx);
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a source whose lock entries carry different versions – an item removed upstream
// is kept at the version it was installed from, the rest moves on – is compared with the
// version the last sync read, not with whichever entry comes first: one sync, then quiet.
test("k80: lock entries of one source at different versions do not make every session sync", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/aaa/SKILL.md": SKILL("aaa"), "skills/zzz/SKILL.md": SKILL("zzz") });
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["aaa@g", "zzz@g"] }, checkInterval: 0 });
    assert.equal((await e.session()).systemMessage, "skilletor: 2 item(s) updated");

    rmSync(join(e.tmp.dir, "g-work", "skills", "aaa"), { recursive: true });
    repo.push({ "skills/zzz/SKILL.md": SKILL("zzz", "MOVED") });
    const moved = await e.session();
    assert.equal(moved.systemMessage, "skilletor: 1 item(s) updated, 1 warning(s)");
    assert.match(moved.hookSpecificOutput?.additionalContext ?? "", /item not found in source g: skill aaa/);
    const lock = readLock(e.userFile("skilletor.lock.json"));
    assert.notEqual(lock["skills/aaa"]!.version, lock["skills/zzz"]!.version, "aaa kept at the version it came from");

    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.sources], [false, [{ name: "g", scope: "user", changed: false }]]);
    assert.deepEqual(await e.session(), {});
    assert.equal(existsSync(e.userFile("skills/aaa/SKILL.md")), true);
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a sync that stops with an error clears the recorded versions with the unreached
// record (k71): `check` falls back to the lock, which holds nothing of g – so g counts as
// changed again, and the next session syncs although no source moved.
test("k80: a sync that fails midway clears the recorded versions; the source counts as changed again", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo"), "rules/r.md": "R\n" });
    mkdirSync(e.userFile("skills/foo"), { recursive: true });
    writeFileSync(e.userFile("skills/foo/SKILL.md"), "MINE\n");
    const declare = (install: unknown) => e.writeCfg("user", { sources: { g: { git: repo.url } }, install, checkInterval: 0 });
    declare({ skills: ["foo@g"] });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)");
    assert.deepEqual((await check(e.ctx)).sources, [{ name: "g", scope: "user", changed: false }]);

    declare({ skills: ["foo@g"], rules: ["r@g"] });
    writeFileSync(e.userFile("rules"), "a file where the rules dir goes");
    assert.match((await e.session()).systemMessage ?? "", /EEXIST|ENOTDIR/);
    rmSync(e.userFile("rules"));
    declare({ skills: ["foo@g"] });
    assert.deepEqual((await check(e.ctx)).sources, [{ name: "g", scope: "user", changed: true }]);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)");
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: the record is only a hint – unreadable, malformed, or an entry of the wrong shape,
// it counts as no record: the hook syncs once as before k80 and the sync writes it anew.
test("k80: a corrupt sources-read.json counts as no record; session-start syncs once and rewrites it", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    mkdirSync(e.userFile("skills/foo"), { recursive: true });
    writeFileSync(e.userFile("skills/foo/SKILL.md"), "MINE\n");
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)");
    const record = join(e.ctx.stateRoot, "sources-read.json");
    const lockPath = e.userFile("skilletor.lock.json");
    const good = JSON.parse(readFileSync(record, "utf8"));
    const version: string = good[lockPath]?.g?.version ?? "";
    assert.equal(version.startsWith("git:") && repo.first.startsWith(version.slice(4)), true, version);
    assert.deepEqual(good, { [lockPath]: { g: { kind: "git", address: repo.url, version } } });
    for (const junk of ["{ broken", JSON.stringify({ [lockPath]: ["g"] }), JSON.stringify({ [lockPath]: { g: "git:abc" } })]) {
      writeFileSync(record, junk);
      assert.equal((await e.session()).systemMessage, "skilletor: 1 warning(s)", junk); // counted again: one sync
      assert.deepEqual(await e.session(), {}, junk);
      assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), good, junk);
    }
  } finally {
    e.tmp.cleanup();
  }
});

// ---- a source pinned to an annotated tag (k75) ------------------------------------------

// Asserts: the session after syncing a source pinned to an annotated tag is silent and
// fetches nothing – check compares the commit the tag names, not the tag object – also when
// the branch moves on; moving the tag syncs once, and the session after that is silent again.
test("k75: a source pinned to an annotated tag: the next session is silent and fetches nothing; moving the tag syncs once", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo", "FIRST") });
    const upstream = (...args: string[]) => execFileSync("git", ["--git-dir", repo.bare, ...args], { env: GIT_ENV });
    upstream("tag", "-a", "-m", "v1", "v1", repo.first);
    e.writeCfg("user", { sources: { g: { git: repo.url, ref: "v1" } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    const foo = () => readFileSync(e.userFile("skills/foo/SKILL.md"), "utf8");
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(foo(), /FIRST/);

    const second = repo.push({ "skills/foo/SKILL.md": SKILL("foo", "SECOND") }); // main moves on, v1 stays
    rmSync(e.ctx.cacheRoot!, { recursive: true });
    assert.deepEqual(await e.session(), {});
    assert.equal(e.cacheEmpty(), true, "the second session fetched nothing");

    upstream("tag", "-f", "-a", "-m", "v1 moved", "v1", second);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(foo(), /SECOND/);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// ---- what a sync rendered with (k76) ---------------------------------------------------

/** A skill whose body is rendered from `body` (a Nunjucks expression list). */
const TEMPLATE = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

// Asserts: a var a template uses, changed in the config while no source moved, makes the next
// SessionStart re-render the item with the new value – check names the scope in varsChanged –
// and the session after that is silent; the same vars written again (keys in another order)
// sync nothing.
test("k76: a changed var re-renders at the next session; unchanged vars stay silent", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/greet/SKILL.md.njk": TEMPLATE("greet", "{{ vars.greeting }}") });
    const declare = (vars: unknown) =>
      e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["greet@g"] }, vars, checkInterval: 0 });
    const greet = () => readFileSync(e.userFile("skills/greet/SKILL.md"), "utf8");
    declare({ greeting: "hi", other: 1 });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(greet(), /\nhi\n$/);
    assert.deepEqual(await e.session(), {});

    declare({ other: 1, greeting: "hi" });
    assert.equal((await check(e.ctx)).changed, false, "same vars, other key order");
    assert.deepEqual(await e.session(), {});

    declare({ other: 1, greeting: "hello" });
    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.varsChanged, chk.sources], [true, ["user"], [{ name: "g", scope: "user", changed: false }]]);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(greet(), /\nhello\n$/);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: the project scope counts what its items render with – a var set in
// skilletor.local.json over the user's, and the project's git remote – so each change
// re-renders the project item at the next SessionStart; the user scope, which declares
// nothing, is not named.
test("k76: a var from skilletor.local.json and a changed git remote re-render the project's items", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", {
      "skills/greet/SKILL.md.njk": TEMPLATE("greet", "{{ vars.greeting }} from {{ project.git_remote }}"),
    });
    const inProject = (...args: string[]) => execFileSync("git", args, { cwd: e.projectDir, env: GIT_ENV });
    inProject("init", "-q", "-b", "main");
    inProject("remote", "add", "origin", "https://example.com/a.git");
    e.writeCfg("user", { sources: { g: { git: repo.url } }, vars: { greeting: "hi" }, checkInterval: 0 });
    e.writeCfg("project", { install: { skills: ["greet@g"] } });
    const greet = () => readFileSync(join(e.projectDir, ".claude/skills/greet/SKILL.md"), "utf8");
    assert.match((await e.session()).systemMessage ?? "", /^skilletor: 1 item\(s\) updated/);
    assert.match(greet(), /\nhi from https:\/\/example\.com\/a\.git\n$/);
    assert.deepEqual(await e.session(), {});

    writeFileSync(join(e.projectDir, ".claude/skilletor.local.json"), JSON.stringify({ vars: { greeting: "yo" } }));
    assert.deepEqual((await check(e.ctx)).varsChanged, ["project"], "local var");
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(greet(), /\nyo from https:\/\/example\.com\/a\.git\n$/);
    assert.deepEqual(await e.session(), {});

    inProject("remote", "set-url", "origin", "https://example.com/b.git");
    assert.deepEqual((await check(e.ctx)).varsChanged, ["project"], "git remote");
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(greet(), /\nyo from https:\/\/example\.com\/b\.git\n$/);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: with no record – the first session after an upgrade, or the record unreadable or
// malformed – a scope in use counts as changed: one session syncs (silently: nothing
// differs; the fetch shows it ran), writes the record, and the next is quiet. A scope that
// declares nothing and holds nothing records nothing and never counts.
test("k76: with no record an in-use scope syncs once, silently; a scope with nothing declared records nothing", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo") });
    e.writeCfg("user", { sources: { g: { git: repo.url } }, install: { skills: ["foo@g"] }, checkInterval: 0 });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.deepEqual(await e.session(), {});
    const record = join(e.ctx.stateRoot, "render-inputs.json");
    const lockPath = e.userFile("skilletor.lock.json");
    const good = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(Object.keys(good), [lockPath], "the project scope declares nothing: no record");
    assert.match(good[lockPath], /^sha256:[0-9a-f]{64}$/);

    for (const junk of [undefined, "{ broken", JSON.stringify({ [lockPath]: 42 })]) {
      if (junk === undefined) rmSync(record); // as left by a version before k76
      else writeFileSync(record, junk);
      const chk = await check(e.ctx);
      assert.deepEqual([chk.changed, chk.varsChanged], [true, ["user"]], String(junk));
      rmSync(e.ctx.cacheRoot!, { recursive: true, force: true });
      assert.deepEqual(await e.session(), {}, String(junk));
      assert.equal(e.cacheEmpty(), false, `${junk}: the session synced`);
      assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), good, String(junk));
      rmSync(e.ctx.cacheRoot!, { recursive: true, force: true });
      assert.deepEqual(await e.session(), {}, String(junk));
      assert.equal(e.cacheEmpty(), true, `${junk}: the next session fetched nothing`);
    }
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a sync that stops with an error clears the scope's record with unreached.json and
// sources-read.json (k71, k80): what it rendered before it stopped is unknown, so check
// counts the vars again; the next sync finishes and records them, and the session after is quiet.
test("k76: a sync that fails midway clears the record; check counts the vars again", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/foo/SKILL.md": SKILL("foo"), "rules/r.md": "R\n" });
    const declare = (install: unknown) => e.writeCfg("user", { sources: { g: { git: repo.url } }, install, checkInterval: 0 });
    const record = join(e.ctx.stateRoot, "render-inputs.json");
    const lockPath = e.userFile("skilletor.lock.json");
    const recorded = () => (existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : {})[lockPath];
    declare({ skills: ["foo@g"] });
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    const hash = recorded();
    assert.match(hash ?? "", /^sha256:/);

    declare({ skills: ["foo@g"], rules: ["r@g"] });
    writeFileSync(e.userFile("rules"), "a file where the rules dir goes");
    assert.match((await e.session()).systemMessage ?? "", /EEXIST|ENOTDIR/);
    assert.equal(recorded(), undefined, "cleared");
    assert.deepEqual((await check(e.ctx)).varsChanged, ["user"]);

    rmSync(e.userFile("rules"));
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.equal(recorded(), hash);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});

// Asserts: a sync that could not read a source its scope needs – here: no cache and the remote
// gone – leaves that source's items as they were, so it keeps the earlier record: once the
// source is back, the next session re-renders them with the changed var, though the source
// did not move and the lock matches the config.
test("k76: a var changed while a source cannot be read re-renders its items once the source is back", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "g", { "skills/greet/SKILL.md.njk": TEMPLATE("greet", "{{ vars.greeting }}") });
    const declare = (greeting: string) => e.writeCfg("user", {
      sources: { g: { git: repo.url } }, install: { skills: ["greet@g"] }, vars: { greeting }, checkInterval: 0,
    });
    const greet = () => readFileSync(e.userFile("skills/greet/SKILL.md"), "utf8");
    declare("hi");
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");

    declare("hello");
    renameSync(repo.bare, repo.bare + ".off");
    rmSync(e.ctx.cacheRoot!, { recursive: true });
    const offline = await e.session();
    assert.match(offline.systemMessage ?? "", /warning/);
    assert.match(offline.hookSpecificOutput?.additionalContext ?? "", /source g: /);
    assert.match(greet(), /\nhi\n$/, "kept while its source cannot be read");

    renameSync(repo.bare + ".off", repo.bare);
    assert.deepEqual((await check(e.ctx)).varsChanged, ["user"]);
    assert.equal((await e.session()).systemMessage, "skilletor: 1 item(s) updated");
    assert.match(greet(), /\nhello\n$/);
    assert.deepEqual(await e.session(), {});
  } finally {
    e.tmp.cleanup();
  }
});
