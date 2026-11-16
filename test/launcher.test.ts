// The sh launcher bin/skilletor (spec §10): reached through a symlink – one on PATH, npm link,
// npm install -g – it still finds dist/ next to the checkout's bin/, not next to the link
// (k139). Since k191 it does so through the starter beside it, bin/skilletor-start (its own
// cases: test/starter.test.ts). Every case runs a copy without this checkout's pinned
// checksums: with them the starter would fetch and run the release binary, not dist/.
// Windows starts bin/skilletor.exe instead; these cases are POSIX only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homeEnv } from "./helpers/harness.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const skip = process.platform === "win32" ? "the sh launcher does not run on Windows" : false;

let tmp: TmpDir;
// A copy of the launcher and its starter in a checkout whose path has a space, with a stub
// bundle that names itself and echoes its arguments.
let checkout: string;
let launcher: string;

/** This checkout's bin/skilletor and bin/skilletor-start in `dir`/bin – never its pinned
 *  checksums (bin/skilletor-binaries.sha256), whether or not a release has written them. */
function copyLaunchers(dir: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const file of ["skilletor", "skilletor-start"]) {
    copyFileSync(join(repo, "bin", file), join(dir, "bin", file));
    chmodSync(join(dir, "bin", file), 0o755);
  }
}

before(() => {
  tmp = makeTmpDir();
  checkout = join(tmp.dir, "my clone");
  copyLaunchers(checkout);
  mkdirSync(join(checkout, "dist"));
  launcher = join(checkout, "bin", "skilletor");
  writeFileSync(join(checkout, "dist", "skilletor.js"), 'console.log(JSON.stringify(["stub", ...process.argv.slice(2)]));\n');
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

test("this checkout's launcher and bundle, linked, print the package version", { skip }, () => {
  // A copy: the real dist/ and package.json, the launchers without the pinned checksums.
  const real = join(tmp.dir, "real checkout");
  copyLaunchers(real);
  mkdirSync(join(real, "dist"));
  copyFileSync(join(repo, "dist", "skilletor.js"), join(real, "dist", "skilletor.js"));
  copyFileSync(join(repo, "package.json"), join(real, "package.json"));
  assert.ok(!existsSync(join(real, "bin", "skilletor-binaries.sha256")));
  const dir = join(tmp.dir, "real");
  mkdirSync(dir);
  symlinkSync(join(real, "bin", "skilletor"), join(dir, "skilletor"));
  const r = run(join(dir, "skilletor"), ["--version"]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  assert.equal(r.stdout.trim(), pkg.version);
});
