// Tests for state: trust, mutex, last-check, pending-report (spec §4.3, §6.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { State } from "../src/state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- trust ------------------------------------------------------------------
// Trust is stored for the backend in use: kind + address (spec §4.3, k66).

const GIT = "https://github.com/Getty/skills";

test("user-origin backends are always trusted", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    assert.equal(state.isTrusted("mine", { kind: "git", address: "https://x", origin: "user" }), true);
    assert.equal(state.isTrusted("mine", { kind: "local", address: "/x", origin: "user" }), true);
  } finally {
    tmp.cleanup();
  }
});

test("project-origin backends need an entry for exactly their kind and address", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    const git = { kind: "git" as const, address: GIT, origin: "project" as const };
    assert.equal(state.isTrusted("team", git), false);
    state.trust("team", git);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp.dir, "trust.json"), "utf8")), { team: { kind: "git", address: GIT } });
    assert.equal(state.isTrusted("team", git), true);
    assert.equal(state.isTrusted("team", { ...git, kind: "url" }), false); // same address, other kind
    assert.equal(state.isTrusted("team", { ...git, address: "https://evil.example/skills" }), false);
    assert.equal(state.isTrusted("other", git), false); // per name
    // A new trust replaces the entry: the git backend is no longer trusted.
    state.trust("team", { kind: "local", address: "/src/team" });
    assert.equal(state.isTrusted("team", { kind: "local", address: "/src/team", origin: "project" }), true);
    assert.equal(state.isTrusted("team", git), false);
  } finally {
    tmp.cleanup();
  }
});

test("a pre-k66 entry (name -> URL) counts for git and url at exactly that URL, never for local", () => {
  const tmp = makeTmpDir();
  try {
    writeFileSync(join(tmp.dir, "trust.json"), JSON.stringify({ team: GIT, path: "/src/team" }));
    const state = new State(tmp.dir);
    assert.equal(state.isTrusted("team", { kind: "git", address: GIT, origin: "project" }), true);
    assert.equal(state.isTrusted("team", { kind: "url", address: GIT, origin: "project" }), true);
    assert.equal(state.isTrusted("team", { kind: "git", address: GIT + "x", origin: "project" }), false);
    assert.equal(state.isTrusted("team", { kind: "local", address: GIT, origin: "project" }), false);
    assert.equal(state.isTrusted("path", { kind: "local", address: "/src/team", origin: "project" }), false);
  } finally {
    tmp.cleanup();
  }
});

test("a malformed trust entry trusts nothing", () => {
  const tmp = makeTmpDir();
  try {
    writeFileSync(join(tmp.dir, "trust.json"), JSON.stringify({ a: null, b: 7, c: { kind: "git" }, d: [GIT] }));
    const state = new State(tmp.dir);
    for (const name of ["a", "b", "c", "d"]) {
      assert.equal(state.isTrusted(name, { kind: "git", address: GIT, origin: "project" }), false, name);
    }
  } finally {
    tmp.cleanup();
  }
});

test("trust survives a reload from disk", () => {
  const tmp = makeTmpDir();
  try {
    new State(tmp.dir).trust("team", { kind: "url", address: "https://x" });
    assert.equal(new State(tmp.dir).isTrusted("team", { kind: "url", address: "https://x", origin: "project" }), true);
  } finally {
    tmp.cleanup();
  }
});

// ---- last-check -------------------------------------------------------------

test("isDue is true before any check and false right after", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    assert.equal(state.isDue("user", 600), true);
    state.markChecked("user");
    assert.equal(state.isDue("user", 600), false);
    assert.equal(state.isDue("user", 0), true); // zero interval always due
  } finally {
    tmp.cleanup();
  }
});

// ---- pending report ---------------------------------------------------------

test("pending report is taken once and separated per project", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    state.putPendingReport("/proj/a", { msg: "a" });
    state.putPendingReport("/proj/b", { msg: "b" });
    assert.deepEqual(state.takePendingReport("/proj/a"), { msg: "a" });
    assert.equal(state.takePendingReport("/proj/a"), undefined); // consumed
    assert.deepEqual(state.takePendingReport("/proj/b"), { msg: "b" }); // untouched
  } finally {
    tmp.cleanup();
  }
});

// ---- mutex ------------------------------------------------------------------
// `sync.lock/` (spec §6.5, k81): a lock counts as stale once its owner record has not been
// refreshed for the stale age – a holder refreshes it while it runs – or once its owner died
// on this host; an owner-less dir is a run between mkdir and its owner write until the grace
// period is over. A stale lock is broken by moving it to a tombstone named after it, so of
// two waiters that judged it stale only one can break it.

const LOCK = "sync.lock";

/** Plant `sync.lock/owner.json` with `record`, last refreshed `ageMs` ago. */
function plantLock(root: string, record: Record<string, unknown>, ageMs: number): void {
  mkdirSync(join(root, LOCK), { recursive: true });
  const owner = join(root, LOCK, "owner.json");
  writeFileSync(owner, JSON.stringify(record));
  const then = new Date(Date.now() - ageMs);
  utimesSync(owner, then, then);
}

/** What `sync.lock` left in the state root besides itself: tombstones, released locks. */
const leftovers = (root: string) => readdirSync(root).filter((n) => n.startsWith(`${LOCK}.`));

/** A pid that is certainly not running: a child that has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

test("withLock serializes concurrent holders (no overlap)", async () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    const events: string[] = [];
    const hold = (id: string) =>
      state.withLock(async () => {
        events.push(`enter-${id}`);
        await delay(30);
        events.push(`exit-${id}`);
      });
    await Promise.all([hold("a"), hold("b")]);
    // Whatever the order, one fully finishes before the other enters.
    const first = events[0]!.slice(-1);
    assert.deepEqual(events, [`enter-${first}`, `exit-${first}`, ...(first === "a" ? ["enter-b", "exit-b"] : ["enter-a", "exit-a"])]);
    // A release takes the lock away whole: nothing is left behind.
    assert.equal(existsSync(join(tmp.dir, LOCK)), false);
    assert.deepEqual(leftovers(tmp.dir), []);
  } finally {
    tmp.cleanup();
  }
});

test("a stale lock is taken over", async () => {
  // Asserts: a lock whose owner record (here one a pre-k81 run wrote) was last refreshed
  // longer ago than the stale age is broken, and the waiter runs and releases.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    plantLock(tmp.dir, { pid: 999999, at: Date.now() - 10_000 }, 10_000);
    let ran = false;
    await state.withLock(() => { ran = true; }, { staleMs: 1000, timeoutMs: 2000 });
    assert.equal(ran, true);
    assert.equal(existsSync(join(tmp.dir, LOCK)), false);
  } finally {
    tmp.cleanup();
  }
});

test("acquire times out against a fresh live lock", async () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    mkdirSync(join(tmp.dir, "sync.lock"), { recursive: true });
    writeFileSync(join(tmp.dir, "sync.lock", "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await assert.rejects(() => state.withLock(() => {}, { staleMs: 60_000, timeoutMs: 150 }), /lock/i);
  } finally {
    tmp.cleanup();
  }
});

test("k81: an owner-less lock dir younger than the grace period is not broken", async () => {
  // Asserts: a lock dir without owner.json and a fresh mtime – a run caught between its
  // mkdir and its owner write – keeps a waiter out (it times out, never runs) and stays.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    mkdirSync(join(tmp.dir, LOCK));
    let ran = false;
    await assert.rejects(() => state.withLock(() => { ran = true; }, { timeoutMs: 150 }), /timed out acquiring sync lock/);
    assert.equal(ran, false);
    assert.equal(existsSync(join(tmp.dir, LOCK)), true);
  } finally {
    tmp.cleanup();
  }
});

test("k81: an owner-less lock dir older than the grace period is broken", async () => {
  // Asserts: an owner-less lock dir last changed a minute ago – a run that died between
  // mkdir and owner write – is taken over with the default timings.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    mkdirSync(join(tmp.dir, LOCK));
    const then = new Date(Date.now() - 60_000);
    utimesSync(join(tmp.dir, LOCK), then, then);
    let ran = false;
    await state.withLock(() => { ran = true; }, { timeoutMs: 1000 });
    assert.equal(ran, true);
  } finally {
    tmp.cleanup();
  }
});

test("k81: a run whose owner-less dir was broken and taken does not hold the lock too", async () => {
  // Asserts: when the dir a run just made is broken as owner-less and another run takes the
  // lock before this run writes its owner record, this run does not hold the lock: its
  // exclusive record create fails, it waits (and here times out), the other run's lock stays.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    const other = JSON.stringify({ pid: process.pid, host: hostname(), token: "other-run", at: Date.now(), refreshMs: 10_000 });
    let seamRan = 0;
    let ran = false;
    await assert.rejects(() => state.withLock(() => { ran = true; }, {
      timeoutMs: 150,
      afterMkdir: () => {
        if (seamRan++ > 0) return;
        rmdirSync(join(tmp.dir, LOCK)); // a waiter breaks the owner-less dir …
        mkdirSync(join(tmp.dir, LOCK)); // … and takes the lock
        writeFileSync(join(tmp.dir, LOCK, "owner.json"), other);
      },
    }), /timed out acquiring sync lock/);
    assert.equal(seamRan, 1);
    assert.equal(ran, false);
    assert.equal(readFileSync(join(tmp.dir, LOCK, "owner.json"), "utf8"), other);
  } finally {
    tmp.cleanup();
  }
});

test("k81: a holder running past the stale age refreshes its lock and is not joined", async () => {
  // Asserts: a holder that runs for more than twice the stale age keeps its lock fresh
  // (refreshMs), so a waiter that arrives meanwhile enters only after the holder left.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    const timings = { staleMs: 200, refreshMs: 20, timeoutMs: 3000 };
    const events: string[] = [];
    const a = state.withLock(async () => {
      events.push("enter-a");
      await delay(450);
      events.push("exit-a");
    }, timings);
    await delay(50);
    const b = state.withLock(() => { events.push("enter-b"); }, timings);
    await Promise.all([a, b]);
    assert.deepEqual(events, ["enter-a", "exit-a", "enter-b"]);
  } finally {
    tmp.cleanup();
  }
});

test("k81: of two waiters that judged the same lock stale, only one breaks it", async () => {
  // Asserts: waiter A judges the planted lock stale and is held before it breaks it; B breaks
  // the same lock and takes a fresh one. A's late break must not remove B's lock: A enters
  // only after B released. (`beforeBreak` is the seam that holds A; it must have run.)
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    plantLock(tmp.dir, { pid: 999999, at: Date.now() - 10_000 }, 10_000);
    const events: string[] = [];
    let judged!: () => void;
    const aJudged = new Promise<void>((r) => (judged = r));
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    let seamRan = 0;
    const a = state.withLock(() => { events.push("enter-a"); }, {
      staleMs: 1000, timeoutMs: 3000,
      beforeBreak: () => { seamRan++; judged(); return gate; },
    });
    await Promise.race([aJudged, delay(500)]);
    assert.equal(seamRan, 1, "A judged the planted lock stale and stopped before breaking it");

    let bEntered!: () => void;
    const bIn = new Promise<void>((r) => (bEntered = r));
    let bRelease!: () => void;
    const bHold = new Promise<void>((r) => (bRelease = r));
    const b = state.withLock(async () => {
      events.push("enter-b");
      bEntered();
      await bHold;
      events.push("exit-b");
    }, { staleMs: 1000, timeoutMs: 3000 });
    await bIn;
    openGate(); // A now breaks what it judged stale – which is gone; B's lock stands
    await delay(100);
    assert.deepEqual(events, ["enter-b"]);
    bRelease();
    await Promise.all([a, b]);
    assert.deepEqual(events, ["enter-b", "exit-b", "enter-a"]);
  } finally {
    tmp.cleanup();
  }
});

test("k81: a holder whose lock was broken leaves the lock that replaced it alone", async () => {
  // Asserts: when a holder's lock was broken and another run holds sync.lock by the time the
  // holder finishes, the holder's release does not remove that other run's lock.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    const other = JSON.stringify({ pid: process.pid, host: hostname(), token: "other-run", at: Date.now(), refreshMs: 10_000 });
    await state.withLock(() => {
      // What a waiter does to a lock it judged stale, then takes the lock itself.
      renameSync(join(tmp.dir, LOCK), join(tmp.dir, "moved-away"));
      mkdirSync(join(tmp.dir, LOCK));
      writeFileSync(join(tmp.dir, LOCK, "owner.json"), other);
    });
    assert.equal(readFileSync(join(tmp.dir, LOCK, "owner.json"), "utf8"), other);
  } finally {
    tmp.cleanup();
  }
});

test("k81: a lock whose owner died on this host is broken before the stale age", async () => {
  // Asserts: an owner record of this host whose pid no longer runs and that missed two of its
  // own refreshes is broken although the stale age (60 s) is far off.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    plantLock(tmp.dir, { pid: deadPid(), host: hostname(), token: "dead", at: Date.now() - 1000, refreshMs: 50 }, 1000);
    let ran = false;
    await state.withLock(() => { ran = true; }, { staleMs: 60_000, timeoutMs: 1000 });
    assert.equal(ran, true);
  } finally {
    tmp.cleanup();
  }
});

test("k81: a live owner, another host's owner, or one within its refreshes is not broken early", async () => {
  // Asserts: the dead-owner shortcut needs all of: this host, a pid that is gone, and two
  // missed refreshes. Each record below lacks one, so the waiter times out on it.
  const dead = deadPid();
  const records: [string, Record<string, unknown>, number][] = [
    ["live pid", { pid: process.pid, host: hostname(), refreshMs: 50 }, 1000],
    ["other host", { pid: dead, host: `not-${hostname()}`, refreshMs: 50 }, 1000],
    ["refreshed lately", { pid: dead, host: hostname(), refreshMs: 10_000 }, 1000],
    ["no refresh interval", { pid: dead, host: hostname() }, 1000],
  ];
  for (const [label, record, ageMs] of records) {
    const tmp = makeTmpDir();
    try {
      plantLock(tmp.dir, { token: "t", at: Date.now() - ageMs, ...record }, ageMs);
      await assert.rejects(
        () => new State(tmp.dir).withLock(() => {}, { staleMs: 60_000, timeoutMs: 60 }),
        /timed out acquiring sync lock/, label);
    } finally {
      tmp.cleanup();
    }
  }
});

test("k81: a broken lock leaves one tombstone, swept once older than the stale age", async () => {
  // Asserts: breaking a stale lock leaves exactly one sync.lock.* entry (what keeps a second
  // waiter from breaking the lock that replaced it); a later run sweeps it once it is older
  // than the stale age, so tombstones never pile up.
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    plantLock(tmp.dir, { pid: 999999, at: Date.now() - 10_000 }, 10_000);
    await state.withLock(() => {}, { staleMs: 1000, timeoutMs: 1000 });
    const tombs = leftovers(tmp.dir);
    assert.equal(tombs.length, 1);
    await state.withLock(() => {}, { staleMs: 1000, timeoutMs: 1000 });
    assert.deepEqual(leftovers(tmp.dir), tombs, "a fresh tombstone stays");
    const then = new Date(Date.now() - 5000);
    utimesSync(join(tmp.dir, tombs[0]!), then, then);
    await state.withLock(() => {}, { staleMs: 1000, timeoutMs: 1000 });
    assert.deepEqual(leftovers(tmp.dir), []);
  } finally {
    tmp.cleanup();
  }
});
