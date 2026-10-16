// The sh launcher bin/skilletor (spec §10): reached through a symlink – one on PATH, npm link,
// npm install -g – it still finds dist/ next to the checkout's bin/, not next to the link
// (k139). Windows starts bin/skilletor.exe instead; these cases are POSIX only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homeEnv } from "./helpers/harness.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const skip = process.platform === "win32" ? "the sh launcher does not run on Windows" : false;

let tmp: TmpDir;
// A copy of the launcher in a checkout whose path has a space, with a stub bundle that
// names itself and echoes its arguments.
let checkout: string;
let launcher: string;

before(() => {
  tmp = makeTmpDir();
  checkout = join(tmp.dir, "my clone");
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, "dist"));
  launcher = join(checkout, "bin", "skilletor");
  copyFileSync(join(repo, "bin", "skilletor"), launcher);
  writeFileSync(join(checkout, "dist", "skilletor.js"), 'console.log(JSON.stringify(["stub", ...process.argv.slice(2)]));\n');
  chmodSync(launcher, 0o755);
});

after(() => tmp?.cleanup());

function run(path: string, args: string[]) {
  return spawnSync(path, args, { encoding: "utf8", cwd: tmp.dir, env: { ...process.env, ...homeEnv(tmp.dir) } });
}

function assertStub(path: string) {
  const r = run(path, ["--version", "a b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ["stub", "--version", "a b"]);
}

test("the launcher runs dist/ next to its own bin/", { skip }, () => {
  assertStub(launcher);
});

test("an absolute symlink to the launcher runs the checkout's dist/", { skip }, () => {
  const dir = join(tmp.dir, "abs");
  mkdirSync(dir);
  symlinkSync(launcher, join(dir, "skilletor"));
  assertStub(join(dir, "skilletor"));
});

test("a relative symlink resolves against the link's directory, not the cwd", { skip }, () => {
  // npm install -g: <prefix>/bin/skilletor -> ../lib/node_modules/skilletor/bin/skilletor
  const prefix = join(tmp.dir, "prefix");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
  symlinkSync(join("..", "..", "..", "my clone"), join(prefix, "lib", "node_modules", "skilletor"));
  symlinkSync(join("..", "lib", "node_modules", "skilletor", "bin", "skilletor"), join(prefix, "bin", "skilletor"));
  assertStub(join(prefix, "bin", "skilletor"));
});

test("a chain of symlinks, each relative to its own directory, is followed to the end", { skip }, () => {
  const a = join(tmp.dir, "chain", "a");
  const b = join(tmp.dir, "chain", "b", "deeper");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  symlinkSync(join("..", "..", "..", "my clone", "bin", "skilletor"), join(b, "hop"));
  symlinkSync(join(b, "hop"), join(a, "hop"));
  symlinkSync(join("..", "b", "deeper", "hop"), join(a, "skilletor"));
  assertStub(join(a, "skilletor"));
});

test("a symlink to the bin/ directory finds the checkout's dist/, not one beside the link", { skip }, () => {
  const dir = join(tmp.dir, "dirlink");
  mkdirSync(dir);
  symlinkSync(join(checkout, "bin"), join(dir, "skilletor-bin"));
  assertStub(join(dir, "skilletor-bin", "skilletor"));
});

test("this checkout's launcher, linked, prints the package version", { skip }, () => {
  const dir = join(tmp.dir, "real");
  mkdirSync(dir);
  symlinkSync(join(repo, "bin", "skilletor"), join(dir, "skilletor"));
  const r = run(join(dir, "skilletor"), ["--version"]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  assert.equal(r.stdout.trim(), pkg.version);
});
