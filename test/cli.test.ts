// Black-box test of the built CLI bundle: build it, run it, assert on its output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: env ?? process.env });
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

// The usage text must track the dispatcher: every command in run()'s switch and
// every flag parseFlags accepts is listed. `hook` is internal (plugin hooks only).
test("--help lists every dispatched command and parsed flag, nothing 'coming soon'", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const commands = [...src.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!).filter((c) => c !== "hook");
  const flags = [...src.matchAll(/a === "(--[a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(commands.length >= 9, `expected to find the dispatcher cases, got ${commands.join(",")}`);
  assert.ok(flags.length >= 5, `expected to find parseFlags literals, got ${flags.join(",")}`);

  const out = runCli(["--help"]).stdout;
  for (const c of commands) assert.match(out, new RegExp(`^  ${c}\\b`, "m"), `usage misses command ${c}`);
  for (const f of flags) assert.match(out, new RegExp(`${f}(?![a-z-])`), `usage misses flag ${f}`);
  for (const sub of ["source list", "source remove <name>"]) assert.ok(out.includes(sub), `usage misses ${sub}`);
  assert.doesNotMatch(out, /coming soon/i);
  assert.doesNotMatch(out, /^  hook\b/m);
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

// k34: wildcard install through the real binary, with HOME in a temp dir.
test("install 'rule:*@src' and status text marks wildcard items", () => {
  const home = join(tmp.dir, "wild-home");
  const proj = join(tmp.dir, "wild-proj");
  const src = join(tmp.dir, "wild-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "r1.md"), "---\ndescription: r1\n---\nR1\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { shared: { local: src } } }));
  const env = { ...process.env, HOME: home };
  const common = ["--project-dir", proj];

  const bare = runCli(["install", "*@shared", ...common], env);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /type prefix/);

  const ok = runCli(["install", "rule:*@shared", ...common], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\+ rules\/r1/);

  const st = runCli(["status", "--scope", "user", ...common], env);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /rules\/r1 @shared via \*@shared/);
  assert.match(st.stdout, /\* rules\/\* @shared \(1 installed\)/);
});

// k35: a gated-off rule through the real binary: exit 0, skip line, status marker.
test("sync reports a rule that renders empty as skipped and exits 0", () => {
  const home = join(tmp.dir, "empty-home");
  const proj = join(tmp.dir, "empty-proj");
  const src = join(tmp.dir, "empty-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "k8s.md.njk"), "{% if vars.k8s %}K{% endif %}\n");
  writeFileSync(
    join(home, ".claude", "skilletor.json"),
    JSON.stringify({ sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: false } }),
  );
  const env = { ...process.env, HOME: home };
  const common = ["--scope", "user", "--project-dir", proj];

  const r = runCli(["sync", ...common], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rules\/k8s skipped \(renders empty\)/);
  const st = runCli(["status", ...common], env);
  assert.match(st.stdout, /rules\/k8s @s \(skipped: renders empty\)/);
});
