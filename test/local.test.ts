// Tests for the local source backend (spec §4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { LocalSource, expandHome } from "../src/sources/local.ts";

test("expandHome expands ~ and ~/path against the given home", () => {
  assert.equal(expandHome("~", "/home/x"), "/home/x");
  assert.equal(expandHome("~/dev/skills", "/home/x"), "/home/x/dev/skills");
  assert.equal(expandHome("/abs", "/home/x"), "/abs");
  assert.equal(expandHome("./rel", "/home/x"), "./rel");
});

test("resolve returns the directory and version=local", async () => {
  const tmp = makeTmpDir();
  try {
    const dir = join(tmp.dir, "skills");
    mkdirSync(dir);
    const src = new LocalSource("~/skills", tmp.dir);
    assert.equal(src.exists(), true);
    const loc = await src.resolve();
    assert.equal(loc.dir, dir);
    assert.equal(loc.version, "local");
  } finally {
    tmp.cleanup();
  }
});

test("check always reports changed (local is always re-rendered)", async () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "s"));
    const src = new LocalSource(join(tmp.dir, "s"), tmp.dir);
    assert.equal(await src.check("local"), true);
    assert.equal(await src.check(undefined), true);
  } finally {
    tmp.cleanup();
  }
});

test("exists() is false for a missing directory", () => {
  const tmp = makeTmpDir();
  try {
    const src = new LocalSource(join(tmp.dir, "nope"), tmp.dir);
    assert.equal(src.exists(), false);
  } finally {
    tmp.cleanup();
  }
});
