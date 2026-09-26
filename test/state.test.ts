// Tests for state: trust, mutex, last-check, pending-report (spec §4.3, §6.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  } finally {
    tmp.cleanup();
  }
});

test("a stale lock is taken over", async () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    mkdirSync(join(tmp.dir, "sync.lock"), { recursive: true });
    writeFileSync(join(tmp.dir, "sync.lock", "owner.json"), JSON.stringify({ pid: 999999, at: Date.now() - 10_000 }));
    let ran = false;
    await state.withLock(() => { ran = true; }, { staleMs: 1000, timeoutMs: 2000 });
    assert.equal(ran, true);
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
