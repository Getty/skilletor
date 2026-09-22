// Black-box test of the built CLI bundle: build it, run it, assert on its output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildToString } from "../scripts/esbuild.config.mjs";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

let tmp: TmpDir;
// Written as .mjs so Node runs the ESM bundle as ESM even outside a package.json.
let bundle: string;

before(async () => {
  tmp = makeTmpDir();
  bundle = join(tmp.dir, "skilletor.mjs");
  writeFileSync(bundle, await buildToString());
});

after(() => tmp.cleanup());

function runCli(args: string[]) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8" });
}

test("--version prints the package version", () => {
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("--help prints usage including the program name", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skilletor/);
  assert.match(r.stdout, /usage/i);
});

test("no arguments prints usage", () => {
  const r = runCli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage/i);
});

test("an unknown command exits non-zero with a message", () => {
  const r = runCli(["frobnicate"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command/i);
});
