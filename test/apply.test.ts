// Tests for applying a build plan to disk (spec §6.1–6.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

// k65 (spec §6.4): a lock without entries is deleted, never written as `{}`.
test("removing the last item deletes the lock; an empty plan creates none and deletes an old {} lock", () => {
  const tmp = makeTmpDir();
  try {
    const lockFile = join(tmp.dir, "skilletor.lock.json");
    apply([], { targetDir: tmp.dir });
    assert.equal(existsSync(lockFile), false, "no lock where there was none");
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    const res = apply([], { targetDir: tmp.dir });
    assert.deepEqual(res.removed, ["skills/moo"]);
    assert.equal(existsSync(lockFile), false, "the last item takes the lock with it");
    writeFileSync(lockFile, "{}\n"); // what earlier versions left
    apply([], { targetDir: tmp.dir });
    assert.equal(existsSync(lockFile), false, "an old {} lock goes");
    // A skip entry is an entry: the lock stays while it is declared, and goes with it.
    apply([skipped("rule", "r")], { targetDir: tmp.dir });
    assert.deepEqual(Object.keys(readLock(lockFile)), ["rules/r"]);
    apply([], { targetDir: tmp.dir });
    assert.equal(existsSync(lockFile), false);
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

test("keep preserves a locked item that is absent from the plan", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    const res = apply([], { targetDir: tmp.dir, keep: ["skills/moo"] });
    assert.deepEqual(res.removed, []);
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "S");
    assert.equal("skills/moo" in readLock(join(tmp.dir, "skilletor.lock.json")), true);
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

// ---- skipped items (k35) ----------------------------------------------------

function skipped(type: ItemType, name: string): PlanItem {
  return { ...item(type, name, {}), skipped: "renders-empty" };
}

test("a skipped item writes nothing and records a file-less lock entry", () => {
  const tmp = makeTmpDir();
  try {
    const res = apply([skipped("rule", "r")], { targetDir: tmp.dir });
    assert.deepEqual(res.skipped, ["rules/r"]);
    assert.deepEqual([res.added, res.removed, res.unchanged], [[], [], []]);
    assert.equal(existsSync(join(tmp.dir, "rules")), false);
    assert.deepEqual(readLock(join(tmp.dir, "skilletor.lock.json"))["rules/r"], {
      source: "shared", version: "git:aa", files: {}, skipped: "renders-empty",
    });
  } finally {
    tmp.cleanup();
  }
});

test("skipping an installed item removes its files and reports it removed", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })], { targetDir: tmp.dir });
    const res = apply([skipped("skill", "moo")], { targetDir: tmp.dir });
    assert.deepEqual(res.removed, ["skills/moo"]);
    assert.deepEqual(res.skipped, ["skills/moo"]);
    assert.equal(existsSync(join(tmp.dir, "skills/moo")), false);
    // A second skip is quiet and leaves the lock untouched.
    const again = apply([skipped("skill", "moo")], { targetDir: tmp.dir });
    assert.deepEqual([again.removed, again.skipped], [[], ["skills/moo"]]);
  } finally {
    tmp.cleanup();
  }
});

test("a skipped item leaves a foreign file at its path alone, no conflict", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "rules"), { recursive: true });
    writeFileSync(join(tmp.dir, "rules/r.md"), "MINE");
    const res = apply([skipped("rule", "r")], { targetDir: tmp.dir, force: true });
    assert.deepEqual(res.conflicts, []);
    assert.equal(read(tmp.dir, "rules/r.md"), "MINE");
  } finally {
    tmp.cleanup();
  }
});

test("an item that was skipped and applies again counts as added", () => {
  const tmp = makeTmpDir();
  try {
    apply([skipped("rule", "r")], { targetDir: tmp.dir });
    const res = apply([item("rule", "r", { "rules/r.md": "R" })], { targetDir: tmp.dir });
    assert.deepEqual(res.added, ["rules/r"]);
    assert.equal(readLock(join(tmp.dir, "skilletor.lock.json"))["rules/r"]?.skipped, undefined);
  } finally {
    tmp.cleanup();
  }
});

test("an undeclared skipped entry is dropped from the lock without a removal", () => {
  const tmp = makeTmpDir();
  try {
    apply([skipped("rule", "r")], { targetDir: tmp.dir });
    const res = apply([], { targetDir: tmp.dir });
    assert.deepEqual(res.removed, []);
    assert.deepEqual(readLock(join(tmp.dir, "skilletor.lock.json")), {});
  } finally {
    tmp.cleanup();
  }
});

// k62: a claimed path (an agent's plain name next to its `.local.` file, spec §6.3).
test("claims: a foreign file there blocks the item; one its lock entry owns goes with the diff; force deletes it", () => {
  const tmp = makeTmpDir();
  try {
    const plan = () => [{ ...item("agent", "a", { "agents/.local.a.md": "NEW" }), claims: ["agents/a.md"] }];
    // Lock-owned (an earlier layout): moved, no conflict.
    apply([item("agent", "a", { "agents/a.md": "OLD" })], { targetDir: tmp.dir });
    const moved = apply(plan(), { targetDir: tmp.dir });
    assert.deepEqual(moved.conflicts, []);
    assert.deepEqual(moved.updated, ["agents/a"]);
    assert.equal(existsSync(join(tmp.dir, "agents/a.md")), false);
    assert.equal(read(tmp.dir, "agents/.local.a.md"), "NEW");
    // Foreign: conflict, nothing written, the lock entry left as it was.
    writeFileSync(join(tmp.dir, "agents/a.md"), "MINE");
    writeFileSync(join(tmp.dir, "agents/.local.a.md"), "NEW-EDITED");
    const lockBefore = read(tmp.dir, "skilletor.lock.json");
    const blocked = apply([{ ...plan()[0]!, output: new Map([["agents/.local.a.md", Buffer.from("NEWER")]]) }], { targetDir: tmp.dir });
    assert.deepEqual(blocked.conflicts, [{ key: "agents/a", path: "agents/a.md", replace: true }]);
    assert.deepEqual(blocked.unchanged, ["agents/a"]);
    assert.equal(read(tmp.dir, "agents/.local.a.md"), "NEW-EDITED");
    assert.equal(read(tmp.dir, "skilletor.lock.json"), lockBefore);
    // Force: the foreign file goes, the item is written.
    const forced = apply(plan(), { targetDir: tmp.dir, force: true });
    assert.deepEqual(forced.conflicts, []);
    assert.equal(existsSync(join(tmp.dir, "agents/a.md")), false);
    assert.equal(read(tmp.dir, "agents/.local.a.md"), "NEW");
    assert.deepEqual(Object.keys(readLock(join(tmp.dir, "skilletor.lock.json"))["agents/a"]!.files), ["agents/.local.a.md"]);
  } finally {
    tmp.cleanup();
  }
});

test("claims of a skipped item are not checked: it owns no path", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "agents"), { recursive: true });
    writeFileSync(join(tmp.dir, "agents/a.md"), "MINE");
    const res = apply([{ ...item("agent", "a", {}), claims: ["agents/a.md"], skipped: "renders-empty" }], { targetDir: tmp.dir });
    assert.deepEqual(res.conflicts, []);
    assert.equal(read(tmp.dir, "agents/a.md"), "MINE");
  } finally {
    tmp.cleanup();
  }
});

test("a skill's .gitignore stays out of a directory that is not the item's; once owned it is kept", () => {
  const tmp = makeTmpDir();
  try {
    const skill = (files: Record<string, string>) => item("skill", "moo", files);
    mkdirSync(join(tmp.dir, "skills/moo"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/moo/SKILL.md"), "MINE");
    const blocked = apply([skill({ "skills/moo/.gitignore": "*", "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir });
    assert.deepEqual(blocked.conflicts, [{ key: "skills/moo", path: "skills/moo/SKILL.md" }]);
    assert.deepEqual(blocked.unchanged, ["skills/moo"]);
    assert.equal(existsSync(join(tmp.dir, "skills/moo/.gitignore")), false);
    // Adopted: written. A later conflict on a new file keeps the owned attached path.
    apply([skill({ "skills/moo/.gitignore": "*", "skills/moo/SKILL.md": "S" })], { targetDir: tmp.dir, force: true });
    writeFileSync(join(tmp.dir, "skills/moo/ref.md"), "MINE");
    const later = apply([skill({ "skills/moo/.gitignore": "*", "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })],
      { targetDir: tmp.dir });
    assert.deepEqual(later.conflicts, [{ key: "skills/moo", path: "skills/moo/ref.md" }]);
    assert.equal(read(tmp.dir, "skills/moo/.gitignore"), "*");
    assert.deepEqual(Object.keys(readLock(join(tmp.dir, "skilletor.lock.json"))["skills/moo"]!.files),
      ["skills/moo/.gitignore", "skills/moo/SKILL.md"]);
  } finally {
    tmp.cleanup();
  }
});

// k63: the paths a run wrote or adopted, for the tracked check (spec §6.4).
test("written lists the paths written or adopted with force, never unchanged ones", () => {
  const tmp = makeTmpDir();
  try {
    const moo = (files: Record<string, string>) => item("skill", "moo", files);
    const first = apply([moo({ "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })], { targetDir: tmp.dir });
    assert.deepEqual(first.written, [
      { key: "skills/moo", path: "skills/moo/SKILL.md" }, { key: "skills/moo", path: "skills/moo/ref.md" },
    ]);
    const same = apply([moo({ "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })], { targetDir: tmp.dir });
    assert.deepEqual(same.written, []);
    const upd = apply([moo({ "skills/moo/SKILL.md": "S2", "skills/moo/ref.md": "R" })], { targetDir: tmp.dir });
    assert.deepEqual(upd.written, [{ key: "skills/moo", path: "skills/moo/SKILL.md" }]);

    // A foreign file: a conflict writes nothing; --force adopts the identical one and writes the other.
    mkdirSync(join(tmp.dir, "agents"), { recursive: true });
    writeFileSync(join(tmp.dir, "agents/a.md"), "A");
    writeFileSync(join(tmp.dir, "agents/b.md"), "MINE");
    const plan = () => [item("agent", "a", { "agents/a.md": "A" }), item("agent", "b", { "agents/b.md": "B" })];
    assert.deepEqual(apply(plan(), { targetDir: tmp.dir }).written, []);
    assert.deepEqual(apply(plan(), { targetDir: tmp.dir, force: true }).written, [
      { key: "agents/a", path: "agents/a.md" }, { key: "agents/b", path: "agents/b.md" },
    ]);
  } finally {
    tmp.cleanup();
  }
});

// ---- k67: whole-item conflicts, links at or below the item path (spec §6.3) -------

/** Every file under `dir`, relative, sorted, with its content: the "untouched" witness. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[join(e.parentPath, e.name).slice(dir.length + 1)] = readFileSync(join(e.parentPath, e.name), "utf8");
  }
  return out;
}

const isLink = (p: string) => lstatSync(p).isSymbolicLink();

test("k67: a linked skill dir is a conflict; nothing is written through it, new files neither", () => {
  const tmp = makeTmpDir();
  try {
    const target = join(tmp.dir, ".claude");
    const outside = join(tmp.dir, "foreign");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "FOREIGN");
    mkdirSync(join(target, "skills"), { recursive: true });
    symlinkSync(outside, join(target, "skills/moo"));
    const plan = () => [item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R", "skills/moo/.gitignore": "*" })];

    const res = apply(plan(), { targetDir: target });
    assert.deepEqual(res.conflicts, [{ key: "skills/moo", path: "skills/moo", replace: true }]);
    assert.deepEqual([res.added, res.unchanged, res.written], [[], ["skills/moo"], []]);
    assert.deepEqual(snapshot(outside), { "SKILL.md": "FOREIGN" }, "nothing written through the link");
    assert.equal(existsSync(join(target, "skilletor.lock.json")), false);

    // --force removes the link itself (its target untouched) and installs a real directory.
    const forced = apply(plan(), { targetDir: target, force: true });
    assert.deepEqual(forced.conflicts, []);
    assert.deepEqual(forced.added, ["skills/moo"]);
    assert.equal(isLink(join(target, "skills/moo")), false);
    assert.equal(lstatSync(join(target, "skills/moo")).isDirectory(), true);
    assert.deepEqual(snapshot(join(target, "skills/moo")), { ".gitignore": "*", "SKILL.md": "S", "ref.md": "R" });
    assert.deepEqual(snapshot(outside), { "SKILL.md": "FOREIGN" }, "the link's target is untouched");
    assert.deepEqual(Object.keys(readLock(join(target, "skilletor.lock.json"))["skills/moo"]!.files).sort(),
      ["skills/moo/.gitignore", "skills/moo/SKILL.md", "skills/moo/ref.md"]);
  } finally {
    tmp.cleanup();
  }
});

test("k67: a skill dir that became a link is a conflict although the lock owns files in it; the entry stays", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/old.md": "O" })], { targetDir: tmp.dir });
    const outside = join(tmp.dir, "foreign");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "S");
    writeFileSync(join(outside, "old.md"), "O");
    rmSync(join(tmp.dir, "skills/moo"), { recursive: true });
    symlinkSync(outside, join(tmp.dir, "skills/moo"));
    const lockBefore = read(tmp.dir, "skilletor.lock.json");

    // An update that writes a changed file, adds one and drops one: none of it happens.
    const res = apply([item("skill", "moo", { "skills/moo/SKILL.md": "S2", "skills/moo/new.md": "N" })], { targetDir: tmp.dir });
    assert.deepEqual(res.conflicts, [{ key: "skills/moo", path: "skills/moo", replace: true }]);
    assert.deepEqual([res.updated, res.removed, res.unchanged], [[], [], ["skills/moo"]]);
    assert.deepEqual(snapshot(outside), { "SKILL.md": "S", "old.md": "O" });
    assert.equal(read(tmp.dir, "skilletor.lock.json"), lockBefore);
  } finally {
    tmp.cleanup();
  }
});

test("k67: a directory inside the skill that is a link is a conflict, for a write and for a removal", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/sub/x.md": "X" })], { targetDir: tmp.dir });
    const outside = join(tmp.dir, "foreign");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), "X");
    rmSync(join(tmp.dir, "skills/moo/sub"), { recursive: true });
    symlinkSync(outside, join(tmp.dir, "skills/moo/sub"));
    const lockBefore = read(tmp.dir, "skilletor.lock.json");
    const conflict = [{ key: "skills/moo", path: "skills/moo/sub", replace: true }];

    const write = apply([item("skill", "moo", { "skills/moo/SKILL.md": "S2", "skills/moo/sub/x.md": "X2" })], { targetDir: tmp.dir });
    assert.deepEqual(write.conflicts, conflict);
    // x.md is dropped from the item: the lock owns it, but it sits behind the link.
    const drop = apply([item("skill", "moo", { "skills/moo/SKILL.md": "S2" })], { targetDir: tmp.dir });
    assert.deepEqual(drop.conflicts, conflict);
    assert.deepEqual(snapshot(outside), { "x.md": "X" });
    assert.equal(read(tmp.dir, "skills/moo/SKILL.md"), "S", "the whole item is blocked");
    assert.equal(read(tmp.dir, "skilletor.lock.json"), lockBefore);

    // --force: the inner link goes, its target stays, the item is a real tree again.
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S2", "skills/moo/sub/x.md": "X2" })], { targetDir: tmp.dir, force: true });
    assert.equal(isLink(join(tmp.dir, "skills/moo/sub")), false);
    assert.equal(read(tmp.dir, "skills/moo/sub/x.md"), "X2");
    assert.deepEqual(snapshot(outside), { "x.md": "X" });
  } finally {
    tmp.cleanup();
  }
});

test("k67: a partial conflict in a plain directory blocks the whole item; the installed copy stays", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/old.md": "O" })], { targetDir: tmp.dir });
    writeFileSync(join(tmp.dir, "skills/moo/ref.md"), "MINE"); // foreign
    const lockBefore = read(tmp.dir, "skilletor.lock.json");
    const next = () => [item("skill", "moo", { "skills/moo/SKILL.md": "S2", "skills/moo/ref.md": "R", "skills/moo/new.md": "N" })];

    const res = apply(next(), { targetDir: tmp.dir });
    assert.deepEqual(res.conflicts, [{ key: "skills/moo", path: "skills/moo/ref.md" }]);
    assert.deepEqual([res.updated, res.unchanged, res.written], [[], ["skills/moo"], []]);
    assert.deepEqual(snapshot(join(tmp.dir, "skills/moo")), { "SKILL.md": "S", "old.md": "O", "ref.md": "MINE" },
      "no file written, none removed");
    assert.equal(read(tmp.dir, "skilletor.lock.json"), lockBefore);

    // Not yet installed: a foreign SKILL.md keeps every other file of the item out.
    mkdirSync(join(tmp.dir, "skills/own"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/own/SKILL.md"), "MINE");
    const fresh = apply([...next(), item("skill", "own", { "skills/own/SKILL.md": "S", "skills/own/ref.md": "R" })],
      { targetDir: tmp.dir });
    assert.deepEqual(fresh.conflicts.map((c) => c.path), ["skills/moo/ref.md", "skills/own/SKILL.md"]);
    assert.deepEqual(snapshot(join(tmp.dir, "skills/own")), { "SKILL.md": "MINE" });
    assert.equal("skills/own" in readLock(join(tmp.dir, "skilletor.lock.json")), false);

    // --force adopts the foreign file, writes the rest and removes what the item dropped.
    apply(next(), { targetDir: tmp.dir, force: true });
    assert.deepEqual(snapshot(join(tmp.dir, "skills/moo")), { "SKILL.md": "S2", "new.md": "N", "ref.md": "R" });
  } finally {
    tmp.cleanup();
  }
});

test("k67: a linked file the lock owns is replaced as a file; its target is unchanged", () => {
  const tmp = makeTmpDir();
  try {
    const plan = () => [item("agent", "a", { "agents/a.md": "A" }), item("agent", "b", { "agents/b.md": "B" }),
      item("agent", "c", { "agents/c.md": "C" })];
    apply(plan(), { targetDir: tmp.dir });
    const theirs = join(tmp.dir, "theirs");
    mkdirSync(theirs);
    writeFileSync(join(theirs, "a.md"), "THEIRS");
    writeFileSync(join(theirs, "b.md"), "B"); // same bytes as the item: still a link, still replaced
    for (const n of ["a", "b"]) {
      rmSync(join(tmp.dir, `agents/${n}.md`));
      symlinkSync(join(theirs, `${n}.md`), join(tmp.dir, `agents/${n}.md`));
    }
    rmSync(join(tmp.dir, "agents/c.md"));
    symlinkSync(join(theirs, "missing.md"), join(tmp.dir, "agents/c.md")); // dangling

    const res = apply(plan(), { targetDir: tmp.dir });
    assert.deepEqual(res.conflicts, []);
    for (const [n, text] of [["a", "A"], ["b", "B"], ["c", "C"]] as const) {
      assert.equal(isLink(join(tmp.dir, `agents/${n}.md`)), false, `${n} is a file again`);
      assert.equal(read(tmp.dir, `agents/${n}.md`), text);
    }
    assert.deepEqual(snapshot(theirs), { "a.md": "THEIRS", "b.md": "B" }, "link targets unchanged");
    assert.deepEqual(res.overwritten.map((o) => o.path), ["agents/a.md", "agents/b.md", "agents/c.md"]);
  } finally {
    tmp.cleanup();
  }
});

test("k67: a linked file the lock does not own is a conflict, a dangling one too; --force replaces the link only", () => {
  const tmp = makeTmpDir();
  try {
    const theirs = join(tmp.dir, "theirs");
    mkdirSync(theirs);
    writeFileSync(join(theirs, "b.md"), "THEIRS");
    mkdirSync(join(tmp.dir, "agents"));
    symlinkSync(join(theirs, "b.md"), join(tmp.dir, "agents/b.md"));
    symlinkSync(join(theirs, "missing.md"), join(tmp.dir, "agents/c.md"));
    const plan = () => [item("agent", "b", { "agents/b.md": "B" }), item("agent", "c", { "agents/c.md": "C" })];

    const res = apply(plan(), { targetDir: tmp.dir });
    assert.deepEqual(res.conflicts, [{ key: "agents/b", path: "agents/b.md" }, { key: "agents/c", path: "agents/c.md" }]);
    assert.equal(isLink(join(tmp.dir, "agents/b.md")) && isLink(join(tmp.dir, "agents/c.md")), true, "links left alone");
    assert.equal(existsSync(join(tmp.dir, "skilletor.lock.json")), false);

    apply(plan(), { targetDir: tmp.dir, force: true });
    assert.equal(isLink(join(tmp.dir, "agents/b.md")), false);
    assert.equal(read(tmp.dir, "agents/b.md"), "B");
    assert.equal(read(tmp.dir, "agents/c.md"), "C");
    assert.deepEqual(snapshot(theirs), { "b.md": "THEIRS" });
  } finally {
    tmp.cleanup();
  }
});

test("k67: a claimed plain path that is a (dangling) link is a conflict; --force removes the link only", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "agents"));
    symlinkSync(join(tmp.dir, "nowhere.md"), join(tmp.dir, "agents/a.md"));
    const plan = () => [{ ...item("agent", "a", { "agents/.local.a.md": "A" }), claims: ["agents/a.md"] }];
    const res = apply(plan(), { targetDir: tmp.dir });
    assert.deepEqual(res.conflicts, [{ key: "agents/a", path: "agents/a.md", replace: true }]);
    assert.equal(existsSync(join(tmp.dir, "agents/.local.a.md")), false);
    apply(plan(), { targetDir: tmp.dir, force: true });
    assert.equal(lstatSync(join(tmp.dir, "agents/a.md"), { throwIfNoEntry: false }), undefined);
    assert.equal(read(tmp.dir, "agents/.local.a.md"), "A");
  } finally {
    tmp.cleanup();
  }
});

test("k67: links above the item path (a type dir, the root itself) are the user's setup: written through", () => {
  const tmp = makeTmpDir();
  try {
    const dotfiles = join(tmp.dir, "dotfiles");
    mkdirSync(join(dotfiles, "skills"), { recursive: true });
    mkdirSync(join(dotfiles, "agents"), { recursive: true });
    const target = join(tmp.dir, ".claude");
    mkdirSync(target);
    symlinkSync(join(dotfiles, "skills"), join(target, "skills"));
    symlinkSync(join(dotfiles, "agents"), join(target, "agents"));
    const plan = [item("skill", "moo", { "skills/moo/SKILL.md": "S" }), item("agent", "a", { "agents/a.md": "A" })];

    const res = apply(plan, { targetDir: target });
    assert.deepEqual(res.conflicts, []);
    assert.deepEqual(snapshot(dotfiles), { "agents/a.md": "A", "skills/moo/SKILL.md": "S" });

    // Removal cleans up inside the linked type dirs and leaves the links themselves.
    const gone = apply([], { targetDir: target });
    assert.deepEqual(gone.removed.sort(), ["agents/a", "skills/moo"]);
    assert.deepEqual(snapshot(dotfiles), {});
    assert.equal(existsSync(join(dotfiles, "skills/moo")), false);
    assert.equal(isLink(join(target, "skills")) && isLink(join(target, "agents")), true, "type-dir links kept");

    // The scope root itself a link.
    const realRoot = join(tmp.dir, "real-root");
    mkdirSync(realRoot);
    symlinkSync(realRoot, join(tmp.dir, "root-link"));
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S" })], { targetDir: join(tmp.dir, "root-link") });
    assert.equal(read(realRoot, "skills/moo/SKILL.md"), "S");
  } finally {
    tmp.cleanup();
  }
});

test("k67: removal never deletes through a link at or below the item path; it is reported and the files stay", () => {
  const tmp = makeTmpDir();
  try {
    const plan = [item("skill", "moo", { "skills/moo/SKILL.md": "S" }), item("skill", "cow", { "skills/cow/SKILL.md": "C" })];
    apply(plan, { targetDir: tmp.dir });
    const outside = join(tmp.dir, "foreign");
    for (const n of ["moo", "cow"]) {
      mkdirSync(join(outside, n), { recursive: true });
      writeFileSync(join(outside, n, "SKILL.md"), "THEIRS");
      rmSync(join(tmp.dir, "skills", n), { recursive: true });
      symlinkSync(join(outside, n), join(tmp.dir, "skills", n));
    }
    // moo is no longer declared; cow is declared but skipped (renders empty).
    const res = apply([skipped("skill", "cow")], { targetDir: tmp.dir });
    assert.deepEqual(res.leftInPlace, [{ key: "skills/cow", path: "skills/cow" }, { key: "skills/moo", path: "skills/moo" }]);
    assert.deepEqual(snapshot(outside), { "cow/SKILL.md": "THEIRS", "moo/SKILL.md": "THEIRS" });
    assert.equal(isLink(join(tmp.dir, "skills/moo")) && isLink(join(tmp.dir, "skills/cow")), true);
    // The lock lets go of both: the files behind the links are not skilletor's any more.
    assert.deepEqual(readLock(join(tmp.dir, "skilletor.lock.json")), {
      "skills/cow": { source: "shared", version: "git:aa", files: {}, skipped: "renders-empty" },
    });
  } finally {
    tmp.cleanup();
  }
});

test("k67: a directory where the item has a file is a conflict, with --force too (never removed)", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills/moo/SKILL.md"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/moo/SKILL.md/keep"), "MINE");
    const plan = () => [item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" })];
    for (const force of [false, true]) {
      const res = apply(plan(), { targetDir: tmp.dir, force });
      assert.deepEqual(res.conflicts, [{ key: "skills/moo", path: "skills/moo/SKILL.md" }], `force=${force}`);
      assert.deepEqual(snapshot(join(tmp.dir, "skills/moo")), { "SKILL.md/keep": "MINE" });
    }
  } finally {
    tmp.cleanup();
  }
});

test("k67: Codex roots follow the same rules (.agents/skills/<name>, .codex/agents/.local.<name>.toml)", () => {
  const tmp = makeTmpDir();
  try {
    const claude = join(tmp.dir, ".claude");
    const agents = join(tmp.dir, ".agents");
    const codex = join(tmp.dir, ".codex");
    const rootOf = (key: string) => (key.startsWith("codex:skills/") ? agents : key.startsWith("codex:") ? codex : claude);
    const skill = { ...item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/ref.md": "R" }), key: "codex:skills/moo" };
    const agent = { ...item("agent", "a", { "agents/.local.a.toml": "T" }), key: "codex:agents/a", claims: ["agents/a.toml"] };
    apply([agent], { targetDir: claude, rootOf });

    const outside = join(tmp.dir, "foreign");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "FOREIGN");
    writeFileSync(join(outside, "a.toml"), "THEIRS");
    mkdirSync(join(agents, "skills"), { recursive: true });
    symlinkSync(outside, join(agents, "skills/moo"));
    rmSync(join(codex, "agents/.local.a.toml"));
    symlinkSync(join(outside, "a.toml"), join(codex, "agents/.local.a.toml"));

    const res = apply([skill, agent], { targetDir: claude, rootOf });
    assert.deepEqual(res.conflicts, [{ key: "codex:skills/moo", path: "skills/moo", replace: true }]);
    assert.deepEqual(res.overwritten, [{ key: "codex:agents/a", path: "agents/.local.a.toml" }]);
    assert.equal(isLink(join(codex, "agents/.local.a.toml")), false);
    assert.equal(read(codex, "agents/.local.a.toml"), "T");
    assert.deepEqual(snapshot(outside), { "SKILL.md": "FOREIGN", "a.toml": "THEIRS" });

    apply([skill, agent], { targetDir: claude, rootOf, force: true });
    assert.equal(isLink(join(agents, "skills/moo")), false);
    assert.deepEqual(snapshot(join(agents, "skills/moo")), { "SKILL.md": "S", "ref.md": "R" });
    assert.deepEqual(snapshot(outside), { "SKILL.md": "FOREIGN", "a.toml": "THEIRS" });
  } finally {
    tmp.cleanup();
  }
});

test("k67: an item's own file where it now has a directory is removed first, no conflict", () => {
  const tmp = makeTmpDir();
  try {
    apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/sub": "FILE" })], { targetDir: tmp.dir });
    const res = apply([item("skill", "moo", { "skills/moo/SKILL.md": "S", "skills/moo/sub/x.md": "X" })], { targetDir: tmp.dir });
    assert.deepEqual([res.conflicts, res.updated], [[], ["skills/moo"]]);
    assert.equal(read(tmp.dir, "skills/moo/sub/x.md"), "X");
    assert.deepEqual(Object.keys(readLock(join(tmp.dir, "skilletor.lock.json"))["skills/moo"]!.files).sort(),
      ["skills/moo/SKILL.md", "skills/moo/sub/x.md"]);
  } finally {
    tmp.cleanup();
  }
});
