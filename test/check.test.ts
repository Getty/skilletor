// `check` against the declared state (k70; spec §4.4, §8, §14.3): SessionStart syncs when
// the config no longer matches the lock – a declaration removed or added, an item moved to
// another source, a SHA pin – and names untrusted sources without syncing. What the last
// sync could not reach with its source at hand does not make every session sync again.
// No network: git sources are file:// bare repos; hooks are driven as a black box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { check, sync } from "../src/engine.ts";
import { cmdTrust } from "../src/commands.ts";
import { readLock } from "../src/lock.ts";
import { runHook, type HookContext } from "../src/hooks.ts";

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
  const url = "file://" + realpathSync(bare);
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
