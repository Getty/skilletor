// Tests for the per-scope lock file (spec §6.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { readLock, writeLock, type Lock } from "../src/lock.ts";

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
