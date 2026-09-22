// Tests for applying a build plan to disk (spec §6.1–6.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { apply, type PlanItem } from "../src/apply.ts";
import { readLock } from "../src/lock.ts";
import type { ItemType } from "../src/config.ts";

const TYPE_DIR: Record<ItemType, string> = { skill: "skills", agent: "agents", rule: "rules" };

function item(type: ItemType, name: string, files: Record<string, string>): PlanItem {
  const output = new Map<string, Buffer>();
  for (const [rel, content] of Object.entries(files)) output.set(rel, Buffer.from(content));
  return { key: `${TYPE_DIR[type]}/${name}`, type, name, source: "shared", version: "git:aa", output };
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

test("first install writes files and a lock", () => {
  const tmp = makeTmpDir();
  try {
    const plan = [item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })];
    const res = apply(plan, { targetDir: tmp.dir });
    assert.deepEqual(res.added, ["skills/moo"]);
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "S");
    assert.equal(read(tmp.dir, "skills/moo/ref.md"), "R");
    const lock = readLock(join(tmp.dir, "skilletor.lock.json"));
    assert.equal(lock["skills/moo"]?.source, "shared");
    assert.equal(Object.keys(lock["skills/moo"]!.files).length, 2);
  } finally {
    tmp.cleanup();
  }
});

test("a second identical run writes nothing (no-op)", () => {
  const tmp = makeTmpDir();
  try {
    const plan = () => [item("skill", "moo", { "skills/moo/SKILL.md": "S" })];
    apply(plan(), { targetDir: tmp.dir });
    const file = join(tmp.dir, "skills/moo/SKILL.md");
    const lockFile = join(tmp.dir, "skilletor.lock.json");
    const fileMtime = statSync(file).mtimeMs;
    const lockMtime = statSync(lockFile).mtimeMs;
    const res = apply(plan(), { targetDir: tmp.dir });
    assert.deepEqual(res.unchanged, ["skills/moo"]);
    assert.equal(statSync(file).mtimeMs, fileMtime, "file untouched");
    assert.equal(statSync(lockFile).mtimeMs, lockMtime, "lock untouched");
  } finally {
    tmp.cleanup();
  }
});

test("a changed file is updated", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "one" })], { targetDir: tmp.dir });
    const res = apply([item("skill", "moo", { "skills/moo/SKILL.md": "two" })], { targetDir: tmp.dir });
    assert.deepEqual(res.updated, ["skills/moo"]);
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "two");
  } finally {
    tmp.cleanup();
  }
});

test("a file dropped from an item is deleted from disk and lock", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })], { targetDir: tmp.dir });
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    assert.equal(existsSync(join(tmp.dir, "skills/moo/ref.md")), false);
    const lock = readLock(join(tmp.dir, "skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock["skills/moo"]!.files), ["skills/moo/SKILL.md"]);
  } finally {
    tmp.cleanup();
  }
});

test("an item no longer declared is removed, its dir cleaned up", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    const res = apply([], { targetDir: tmp.dir });
    assert.deepEqual(res.removed, ["skills/moo"]);
    assert.equal(existsSync(join(tmp.dir, "skills/moo")), false);
    assert.deepEqual(readLock(join(tmp.dir, "skilletor.lock.json")), {});
  } finally {
    tmp.cleanup();
  }
});

test("a foreign (unmanaged) target path is a conflict, left untouched without --force", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills/moo"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/moo/SKILL.md"), "MINE");
    const res = apply([item("skill", "moo", { "skills/moo/SKILL.md": "SOURCE" })], { targetDir: tmp.dir });
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "MINE"); // untouched
    assert.equal(res.conflicts.some((c) => c.path === "skills/moo/SKILL.md"), true);
    assert.equal("skills/moo" in readLock(join(tmp.dir, "skilletor.lock.json")), false);
  } finally {
    tmp.cleanup();
  }
});

test("--force adopts a foreign path", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills/moo"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/moo/SKILL.md"), "MINE");
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "SOURCE" })], { targetDir: tmp.dir, force: true });
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "SOURCE");
    assert.equal("skills/moo" in readLock(join(tmp.dir, "skilletor.lock.json")), true);
  } finally {
    tmp.cleanup();
  }
});

test("local drift is overwritten and reported", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    writeFileSync(join(tmp.dir, "skills/moo/SKILL.md"), "hand-edited"); // drift
    const res = apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "S");
    assert.equal(res.overwritten.some((o) => o.path === "skills/moo/SKILL.md"), true);
  } finally {
    tmp.cleanup();
  }
});

test("an invalid item name is rejected", () => {
  const tmp = makeTmpDir();
  try {
    const bad = item("skill", "moo", {});
    bad.name = "../evil";
    assert.throws(() => apply([bad], { targetDir: tmp.dir }));
  } finally {
    tmp.cleanup();
  }
});

test("agent and rule items install as single files", () => {
  const tmp = makeTmpDir();
  try {
    apply(
      [item("agent", "karr", { "agents/karr.md": "A" }), item("rule", "cs", { "rules/cs.md": "R" })],
      { targetDir: tmp.dir },
    );
    assert.equal(read(tmp.dir, "agents/karr.md"), "A");
    assert.equal(read(tmp.dir, "rules/cs.md"), "R");
  } finally {
    tmp.cleanup();
  }
});
