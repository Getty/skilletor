import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { realOrResolved, samePath } from "../src/fsutil.ts";
import { makeTmpDir } from "./helpers/tmp.ts";
import { NO_SYMLINKS } from "./helpers/symlink.ts";

test("realOrResolved keeps missing-path resolution and existing symlink identity", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const target = join(tmp.dir, "target");
    const link = join(tmp.dir, "link");
    mkdirSync(target);
    symlinkSync(target, link, "dir");
    assert.equal(samePath(target, link), true);
    assert.equal(realOrResolved(join(tmp.dir, "missing", "..", "file")), resolve(tmp.dir, "file"));
    assert.equal(samePath(join(tmp.dir, "missing-a"), join(tmp.dir, "missing-b")), false);
  } finally {
    tmp.cleanup();
  }
});
