import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { executableMatches, parseJson, realOrResolved, samePath } from "../src/fsutil.ts";
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

// k278: V8 and JavaScriptCore word a JSON syntax error differently, and the wording reaches the
// user. Asserts: valid JSON parses as JSON.parse does; each kind of error is our one wording with
// the place of the first character JSON does not allow (1-based line and column), or the end.
test("k278: parseJson words every syntax error the same on every engine", () => {
  const valid = '{ "a": [1, -2.5e+3, true, false, null, "x\\u00e9\\n"], "b": {} }';
  assert.deepEqual(parseJson(valid), JSON.parse(valid));
  const cases: [string, string][] = [
    ["{ not json", "unexpected 'n' at line 1 column 3"],
    ["", "unexpected end of input"],
    ["{\n  \"a\": 1,\n}", "unexpected '}' at line 3 column 1"],
    ["[1, 2", "unexpected end of input"],
    ["[01]", "unexpected '1' at line 1 column 3"],
    ["{\"a\" 1}", "unexpected '1' at line 1 column 6"],
    ['"tab\there"', "unexpected '\t' at line 1 column 5"],
    ['"\\x"', "unexpected 'x' at line 1 column 3"],
    ["tru", "unexpected end of input"],
    ["nul!", "unexpected '!' at line 1 column 4"],
    ["{} {}", "unexpected '{' at line 1 column 4"],
    ["[1.]", "unexpected ']' at line 1 column 4"],
    ["\ufeff{}", "unexpected '\ufeff' at line 1 column 1"],
    ["[\"\u{1F600}\", x]", "unexpected 'x' at line 1 column 8"],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => JSON.parse(text), SyntaxError, `JSON.parse accepts ${JSON.stringify(text)}`);
    assert.throws(() => parseJson(text), (err: unknown) => {
      assert.ok(err instanceof SyntaxError);
      assert.equal(err.message, message, JSON.stringify(text));
      return true;
    });
  }
});

// Asserts: on POSIX the owner's executable bit of a disk mode must equal the wanted one; on
// Windows, whose files carry no such bit, every mode matches, so bytes alone decide.
test("executableMatches compares the owner's bit on POSIX only", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(executableMatches(0o100755, true, platform), true);
    assert.equal(executableMatches(0o100644, false, platform), true);
    assert.equal(executableMatches(0o100644, true, platform), false);
    assert.equal(executableMatches(0o100755, false, platform), false);
  }
  for (const [mode, executable] of [[0o100666, true], [0o100666, false], [0o100444, true], [0o100755, false]] as const) {
    assert.equal(executableMatches(mode, executable, "win32"), true);
  }
});
