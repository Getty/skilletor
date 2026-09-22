// Tests for state: trust, mutex, last-check, pending-report (spec §4.3, §6.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { State } from "../src/state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- trust ------------------------------------------------------------------

test("user-origin sources are always trusted", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    assert.equal(state.isTrusted({ name: "mine", resolved: "https://x", origin: "user" }), true);
  } finally {
    tmp.cleanup();
  }
});

test("project-only sources need a matching trust entry", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    const src = { name: "team", resolved: "https://github.com/Getty/skills", origin: "project" as const };
    assert.equal(state.isTrusted(src), false);
    state.trust("team", "https://github.com/Getty/skills");
    assert.equal(state.isTrusted(src), true);
  } finally {
    tmp.cleanup();
  }
});

test("trust lapses when the resolved URL changes", () => {
  const tmp = makeTmpDir();
  try {
    const state = new State(tmp.dir);
    state.trust("team", "https://github.com/Getty/skills");
    assert.equal(
      state.isTrusted({ name: "team", resolved: "https://evil.example/skills", origin: "project" }),
      false,
    );
  } finally {
    tmp.cleanup();
  }
});

test("trust survives a reload from disk", () => {
  const tmp = makeTmpDir();
  try {
    new State(tmp.dir).trust("team", "https://x");
    assert.equal(new State(tmp.dir).isTrusted({ name: "team", resolved: "https://x", origin: "project" }), true);
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
