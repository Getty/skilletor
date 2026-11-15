// Tests for the per-scope lock file (spec §6.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { apply } from "../src/apply.ts";
import { LockError, readLock, serializeLock, writeLock, type Lock } from "../src/lock.ts";

test("a missing lock reads as empty", () => {
  const tmp = makeTmpDir();
  try {
    assert.deepEqual(readLock(join(tmp.dir, "skilletor.lock.json")), {});
  } finally {
    tmp.cleanup();
  }
});

test("write then read round-trips", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "skilletor.lock.json");
    const lock: Lock = {
      "skills/perl-moo": { source: "shared", version: "git:ab12cd3", files: { "skills/perl-moo/SKILL.md": "sha256:aa" } },
    };
    writeLock(p, lock);
    assert.deepEqual(readLock(p), lock);
  } finally {
    tmp.cleanup();
  }
});

// k65 (spec §6.4): a lock without entries is deleted, never written as `{}`.
test("a lock without entries is never created and an existing one is deleted", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "skilletor.lock.json");
    writeLock(p, {});
    assert.equal(existsSync(p), false);
    writeLock(p, { a: { source: "s", version: "v", files: {} } });
    assert.equal(existsSync(p), true);
    writeLock(p, {});
    assert.equal(existsSync(p), false);
  } finally {
    tmp.cleanup();
  }
});

test("serialization is deterministic (sorted keys)", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "l.json");
    writeLock(p, { b: { source: "s", version: "v", files: { "z": "1", "a": "2" } }, a: { source: "s", version: "v", files: {} } });
    const first = readFileSync(p, "utf8");
    writeLock(p, { a: { source: "s", version: "v", files: {} }, b: { source: "s", version: "v", files: { "a": "2", "z": "1" } } });
    assert.equal(readFileSync(p, "utf8"), first);
  } finally {
    tmp.cleanup();
  }
});

test("invalid JSON is rejected", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "l.json");
    writeFileSync(p, "{ broken");
    assert.throws(() => readLock(p));
  } finally {
    tmp.cleanup();
  }
});

test("a lock entry must be an object", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "l.json");
    for (const bad of ["null", "\"x\"", "3", "[]"] as const) {
      writeFileSync(p, `{ "rules/r": ${bad} }`);
      assert.throws(() => readLock(p), (err: Error) =>
        err instanceof LockError && err.message.includes('rules/r: expected an object'), bad);
    }
  } finally {
    tmp.cleanup();
  }
});

test("a lock entry's files must be a string-valued object", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "l.json");
    const entry = (files: unknown, present = true, via?: unknown) => ({
      source: "s", version: "v", ...(present ? { files } : {}), ...(via === undefined ? {} : { via }),
    });
    for (const [what, value, present] of [
      ["missing", undefined, false], ["null", null, true], ["an array", [], true], ["a string", "sha256:x", true],
      ["a number", 1, true], ["a boolean", true, true],
    ] as const) {
      writeFileSync(p, JSON.stringify({ "skills/x": entry(value, present) }));
      assert.throws(() => serializeLock(readLock(p)), (err: Error) =>
        err instanceof LockError && err.message.endsWith('invalid lock JSON (skills/x: "files" must be an object)'), what);
    }
    for (const value of [null, [], {}, 1, true]) {
      writeFileSync(p, JSON.stringify({ "skills/x": entry({ "skills/x/SKILL.md": value }) }));
      assert.throws(() => readLock(p), (err: Error) =>
        err instanceof LockError && err.message.endsWith('invalid lock JSON (skills/x: "files" values must be strings)'), JSON.stringify(value));
    }
    writeFileSync(p, JSON.stringify({ "skills/x": entry({ "skills/x/SKILL.md": "legacy:any-string" }) }));
    assert.deepEqual(readLock(p)["skills/x"]!.files, { "skills/x/SKILL.md": "legacy:any-string" });
    writeFileSync(p, JSON.stringify({ "skills/x": entry(null, true, "bundle:bad@shared") }));
    assert.throws(() => readLock(p), (err: Error) =>
      err instanceof LockError && err.message.endsWith('invalid lock JSON (skills/x: "via" must be an array of strings)'));
  } finally {
    tmp.cleanup();
  }
});

test("a corrupt hash aborts apply before changing ownership", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "skilletor.lock.json");
    const rel = "skills/x/SKILL.md";
    mkdirSync(join(tmp.dir, "skills", "x"), { recursive: true });
    writeFileSync(join(tmp.dir, rel), "old");
    const broken = JSON.stringify({ "skills/x": { source: "s", version: "v", files: { [rel]: 1 } } });
    writeFileSync(p, broken);
    assert.throws(() => apply([{
      key: "skills/x", type: "skill", name: "x", source: "s", version: "v", output: new Map([[rel, Buffer.from("new")]]),
    }], { targetDir: tmp.dir }), (err: Error) =>
      err instanceof LockError && err.message.endsWith('invalid lock JSON (skills/x: "files" values must be strings)'));
    assert.equal(readFileSync(join(tmp.dir, rel), "utf8"), "old");
    assert.equal(readFileSync(p, "utf8"), broken);
  } finally {
    tmp.cleanup();
  }
});

test("a skipped entry round-trips its marker (k35)", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, "skilletor.lock.json");
    const lock: Lock = { "rules/r": { source: "s", version: "v", files: {}, skipped: "renders-empty" } };
    writeLock(p, lock);
    assert.deepEqual(readLock(p), lock);
  } finally {
    tmp.cleanup();
  }
});
