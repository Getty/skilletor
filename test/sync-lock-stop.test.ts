// A holder of the sync lock that is stopped (spec §6.5, k251), black box through the built CLI.
// Claude Code starts a hook in a process group of its own and cancels it at its time limit with
// SIGTERM to that group, SIGKILL 1.5 s later; Ctrl+C sends SIGINT, a closed terminal SIGHUP. A
// stop it can catch releases the lock, and the process still ends by that signal; SIGKILL cannot
// be caught, so the next run breaks the lock a dead owner left.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { buildTo } from "../scripts/bundle.mjs";
import { State } from "../src/state.ts";
import { claudeOnlyEnv } from "./helpers/harness.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32"
  ? "POSIX signals: Windows ends a process (TerminateProcess) without a signal it can catch"
  : false;

const GIT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const SOURCE = "https://stop.invalid/slow.git";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let bundleTmp: TmpDir;
let bundle: string;

before(async () => {
  bundleTmp = makeTmpDir();
  bundle = join(bundleTmp.dir, "skilletor.mjs");
  buildTo(bundle);
});
after(() => bundleTmp.cleanup());

interface Machine {
  tmp: TmpDir;
  home: string;
  cwd: string;
  state: string;
  owner: string;
  /** The env of a CLI whose fetch of the source takes a minute (`slow`) or none (`fast`). */
  env: (fetch: "slow" | "fast") => NodeJS.ProcessEnv;
}

/** A Claude-only machine whose user config installs one skill from a git source; git reaches the
 *  source through ext::, so a fetch can be made to sleep while its sync holds the lock. */
function machine(): Machine {
  const tmp = makeTmpDir();
  const repo = join(tmp.dir, "git", "slow");
  mkdirSync(join(repo, "skills", "lint"), { recursive: true });
  writeFileSync(join(repo, "skills", "lint", "SKILL.md"), "---\ndescription: lint\n---\nbody\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...GIT }, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "init");
  assert.doesNotMatch(repo, /[\s%;"\\]/, "a path ext:: can carry");
  writeFileSync(join(tmp.dir, "gitconfig-slow"),
    `[protocol "ext"]\n\tallow = always\n[url "ext::sh -c sleep% 60;exec% git-upload-pack% ${repo}"]\n\tinsteadOf = ${SOURCE}\n`);
  writeFileSync(join(tmp.dir, "gitconfig-fast"), `[url "file://${repo}"]\n\tinsteadOf = ${SOURCE}\n`);
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "skilletor.json"),
    JSON.stringify({ sources: { slow: { git: SOURCE } }, install: { skills: ["lint@slow"] } }));
  const cwd = join(tmp.dir, "cwd");
  mkdirSync(cwd);
  const state = join(home, ".claude", "skilletor");
  return {
    tmp, home, cwd, state,
    owner: join(state, "sync.lock", "owner.json"),
    env: (fetch) => claudeOnlyEnv(home, { GIT_CONFIG_GLOBAL: join(tmp.dir, `gitconfig-${fetch}`), GIT_CONFIG_NOSYSTEM: "1" }),
  };
}

/** What `sync.lock` left in the state dir besides itself: tombstones, released locks. */
const leftovers = (m: Machine) => existsSync(m.state) ? readdirSync(m.state).filter((n) => n.startsWith("sync.lock.")) : [];

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await delay(10);
  }
  return true;
}

/** The owner record, once it is written whole. */
function ownerRecord(m: Machine): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(m.owner, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Start the CLI as Claude Code starts a hook: a process group of its own. */
function start(m: Machine, args: string[], input = ""): { child: ChildProcess; exit: Promise<[number | null, NodeJS.Signals | null]>; stdout: () => string } {
  const child = spawn(process.execPath, [bundle, ...args], { cwd: m.cwd, env: m.env("slow"), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (s: string) => (out += s));
  child.stderr!.resume();
  child.stdin!.end(input);
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, exit, stdout: () => out };
}

/** The process group, ended for good: what a test leaves running is never a fetch of a minute. */
function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    // gone already
  }
}

/** Start a `sync` (or the args given) and wait until it holds the lock. */
async function holder(m: Machine, args = ["sync"], input = "") {
  const run = start(m, args, input);
  const held = await waitFor(() => ownerRecord(m)?.pid === run.child.pid, 15_000);
  if (!held) killGroup(run.child);
  assert.ok(held, `the ${args.join(" ")} took the lock`);
  return run;
}

/** Wait for the stopped CLI; the group is killed should it outlive 10 s. */
async function ended(run: { child: ChildProcess; exit: Promise<[number | null, NodeJS.Signals | null]> }) {
  const guard = setTimeout(() => killGroup(run.child), 10_000);
  try {
    return await run.exit;
  } finally {
    clearTimeout(guard);
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`k251: a sync stopped by ${signal} while it holds the lock releases it and ends by ${signal}`, { skip: POSIX_ONLY }, async () => {
    // Asserts: the stop reaches the holder while its fetch sleeps; it gives the lock up – the lock
    // dir gone, nothing left beside it – and dies of the very signal, as it would without the lock.
    const m = machine();
    try {
      const run = await holder(m);
      process.kill(-run.child.pid!, signal);
      const [code, got] = await ended(run);
      assert.deepEqual({ code, signal: got }, { code: null, signal }, "ended by the signal");
      assert.equal(existsSync(join(m.state, "sync.lock")), false, "the lock released");
      assert.deepEqual(leftovers(m), [], "nothing left beside it");
    } finally {
      m.tmp.cleanup();
    }
  });
}

test("k251: a SessionStart cancelled as Claude Code cancels it releases the lock and says nothing", { skip: POSIX_ONLY }, async () => {
  // Asserts: the reported case – a SessionStart whose sync holds the lock, SIGTERM to its process
  // group – leaves no lock and prints no hook output: the session no longer waits for one.
  const m = machine();
  try {
    const input = JSON.stringify({ session_id: "k251", cwd: m.cwd, source: "startup" });
    const run = await holder(m, ["hook", "session-start"], input);
    process.kill(-run.child.pid!, "SIGTERM");
    const [code, signal] = await ended(run);
    assert.deepEqual({ code, signal }, { code: null, signal: "SIGTERM" });
    assert.equal(existsSync(join(m.state, "sync.lock")), false, "the lock released");
    assert.equal(run.stdout(), "");
  } finally {
    m.tmp.cleanup();
  }
});

test("k251: a sync stopped while it waits for the lock leaves the holder's lock alone", { skip: POSIX_ONLY }, async () => {
  // Asserts: the release is the holder's only. A run that waits – here for a live holder, this
  // test's own pid – already listens for a stop, but its release checks its token and gives
  // nothing up: the stop ends it as before, the holder's record untouched.
  const m = machine();
  try {
    mkdirSync(join(m.state, "sync.lock"), { recursive: true });
    const record = JSON.stringify({ pid: process.pid, host: hostname(), token: "holder", at: Date.now(), refreshMs: 10_000 });
    writeFileSync(m.owner, record);
    const run = start(m, ["sync"]);
    await delay(500); // well inside its 5 s wait
    process.kill(-run.child.pid!, "SIGTERM");
    const [code, signal] = await ended(run);
    assert.deepEqual({ code, signal }, { code: null, signal: "SIGTERM" });
    assert.equal(readFileSync(m.owner, "utf8"), record, "the holder's lock untouched");
  } finally {
    m.tmp.cleanup();
  }
});

test("k251: a holder killed with SIGKILL leaves the lock; the next run breaks it once its record missed two refreshes", { skip: POSIX_ONLY }, async () => {
  // The contract for a stop no process can catch, green before k251 too (k81): the lock stays, its
  // record naming this host and a pid that is gone. Once the record is older than two of its
  // refreshes – 20 s at the default 10 s, here aged so – the next sync breaks it at once, far
  // below the stale age (300 s), and syncs; the broken lock is left as one tombstone.
  const m = machine();
  try {
    const run = await holder(m);
    process.kill(-run.child.pid!, "SIGKILL");
    const [, signal] = await ended(run);
    assert.equal(signal, "SIGKILL");
    const record = ownerRecord(m);
    assert.deepEqual({ pid: record?.pid, host: record?.host, refreshMs: record?.refreshMs },
      { pid: run.child.pid, host: hostname(), refreshMs: 10_000 }, "the lock left, a dead owner of this host");
    const then = new Date(Date.now() - 21_000);
    utimesSync(m.owner, then, then);
    const next = spawnSync(process.execPath, [bundle, "sync"], { cwd: m.cwd, env: m.env("fast"), encoding: "utf8" });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /skills\/lint/);
    assert.equal(existsSync(join(m.home, ".claude", "skills", "lint", "SKILL.md")), true, "the next run synced");
    assert.equal(existsSync(join(m.state, "sync.lock")), false);
    assert.equal(leftovers(m).filter((n) => n.startsWith("sync.lock.broken-")).length, 1, "broken, one tombstone");
  } finally {
    m.tmp.cleanup();
  }
});

test("k251: withLock listens for a stop only while it takes or holds a lock, and only where the stop would end the process", { skip: POSIX_ONLY }, async () => {
  // Asserts: no listener before or after a lock – a stop then is the default end, nothing to
  // release; one per stop signal while locks are taken or held, nested ones included; none for a
  // signal that already has a listener of its own, whose program decides what a stop does.
  const count = () => ["SIGTERM", "SIGINT", "SIGHUP"].map((s) => process.listenerCount(s));
  const tmp = makeTmpDir();
  const mine = () => {};
  try {
    const base = count();
    let inside: number[] = [];
    let nested: number[] = [];
    await new State(join(tmp.dir, "a")).withLock(async () => {
      inside = count();
      await new State(join(tmp.dir, "b")).withLock(() => { nested = count(); });
    });
    assert.deepEqual({ inside, nested, after: count() }, { inside: base.map((n) => n + 1), nested: base.map((n) => n + 1), after: base });
    process.on("SIGINT", mine);
    let withOwn: number[] = [];
    await new State(join(tmp.dir, "c")).withLock(() => { withOwn = count(); });
    assert.deepEqual(withOwn, [base[0]! + 1, base[1]! + 1, base[2]! + 1], "SIGINT keeps the program's own listener alone");
  } finally {
    process.removeListener("SIGINT", mine);
    tmp.cleanup();
  }
});
