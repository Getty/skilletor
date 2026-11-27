// The dist build (scripts/bundle.mjs): bun build output that depends only on this checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_SYMLINKS } from "./helpers/symlink.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

function copyCheckout(checkout: string) {
  mkdirSync(checkout, { recursive: true });
  for (const path of ["package.json", "src", "scripts", "dist"]) {
    cpSync(join(repo, path), join(checkout, path), { recursive: true });
  }
}

/** Copy the runtime dependencies (nunjucks and what it requires) into the checkout's node_modules. */
function copyRuntimeDeps(checkout: string) {
  const seen = new Set<string>();
  const copy = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const from = join(repo, "node_modules", name);
    cpSync(from, join(checkout, "node_modules", name), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) copy(dep);
  };
  const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  for (const dep of Object.keys(root.dependencies)) copy(dep);
}

function runScript(checkout: string, script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join("scripts", script), ...args], { cwd: checkout, encoding: "utf8" });
}

function writePackage(path: string, source: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), '{"main":"index.js"}\n');
  writeFileSync(join(path, "index.js"), source);
}

test("k148: build refuses dependencies resolved from an ancestor's node_modules", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const ancestor = join(tmp.dir, "ancestor");
    const checkout = join(ancestor, "checkout");
    copyCheckout(checkout);
    rmSync(join(checkout, "dist"), { recursive: true, force: true });
    symlinkSync(join(repo, "node_modules"), join(ancestor, "node_modules"));

    const result = runScript(checkout, "build.mjs");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /resolves outside this checkout/);
    assert.match(result.stderr, /bun install --frozen-lockfile/);
    assert.equal(existsSync(join(checkout, "dist", "skilletor.js")), false);
  } finally {
    tmp.cleanup();
  }
});

test("k148: build refuses a local package whose transitive dependency falls back to an ancestor", () => {
  const tmp = makeTmpDir();
  try {
    const ancestor = join(tmp.dir, "ancestor");
    const checkout = join(ancestor, "checkout");
    copyCheckout(checkout);
    rmSync(join(checkout, "dist"), { recursive: true, force: true });
    writeFileSync(join(checkout, "src", "cli.ts"), 'import value from "fixture-direct";\nconsole.log(value);\n');
    writePackage(join(checkout, "node_modules", "fixture-direct"), 'module.exports = require("fixture-transitive");\n');
    writePackage(join(ancestor, "node_modules", "fixture-transitive"), 'module.exports = "transitive";\n');

    const result = runScript(checkout, "build.mjs");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixture-transitive/);
    assert.match(result.stderr, /bun install --frozen-lockfile/);
    assert.equal(existsSync(join(checkout, "dist", "skilletor.js")), false);
  } finally {
    tmp.cleanup();
  }
});

test("k148: build refuses an ancestor package link whose target is outside node_modules", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const ancestor = join(tmp.dir, "ancestor");
    const checkout = join(ancestor, "checkout");
    copyCheckout(checkout);
    rmSync(join(checkout, "dist"), { recursive: true, force: true });
    writeFileSync(join(checkout, "src", "cli.ts"), 'import value from "fixture-direct";\nconsole.log(value);\n');
    writePackage(join(checkout, "node_modules", "fixture-direct"), 'module.exports = require("fixture-transitive");\n');
    const linkedTransitive = join(tmp.dir, "linked-transitive");
    writePackage(linkedTransitive, 'module.exports = "transitive";\n');
    mkdirSync(join(ancestor, "node_modules"), { recursive: true });
    symlinkSync(linkedTransitive, join(ancestor, "node_modules", "fixture-transitive"));

    const result = runScript(checkout, "build.mjs");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /linked-transitive/);
    assert.match(result.stderr, /bun install --frozen-lockfile/);
    assert.equal(existsSync(join(checkout, "dist", "skilletor.js")), false);
  } finally {
    tmp.cleanup();
  }
});

// k220 under esbuild accepted a linked node_modules (preserveSymlinks). Bun's bundler resolves
// symlinks and names every module by its path relative to the checkout, so a linked
// dependency would put the link target's location into the bundle: it is refused instead.
test("k220: build refuses a node_modules linked from outside the checkout", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const checkout = join(tmp.dir, "linked-checkout");
    copyCheckout(checkout);
    symlinkSync(join(repo, "node_modules"), join(checkout, "node_modules"));

    const result = runScript(checkout, "build.mjs", join(tmp.dir, "out.js"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /nunjucks.*resolves outside this checkout/);
    assert.equal(existsSync(join(tmp.dir, "out.js")), false);
  } finally {
    tmp.cleanup();
  }
});

test("k279: checkouts at different paths build the same bytes, without the checkout path", () => {
  const tmp = makeTmpDir();
  try {
    const bundles = ["one", join("two", "deeper", "checkout-two")].map((name, i) => {
      const checkout = join(tmp.dir, name);
      copyCheckout(checkout);
      copyRuntimeDeps(checkout);
      const out = join(tmp.dir, `out-${i}.js`);
      const result = runScript(checkout, "build.mjs", out);
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(out);
    });
    assert.ok(bundles[0]!.equals(bundles[1]!), "bundles differ between checkout paths");
    const text = bundles[0]!.toString("utf8");
    assert.ok(text.startsWith("// @bun\n"), "a bun build --target=bun bundle starts with the @bun pragma");
    assert.ok(!text.includes(tmp.dir), "the bundle names the checkout's absolute path");
  } finally {
    tmp.cleanup();
  }
});

test("k279: check-dist passes the committed dist and detects stale source", () => {
  const tmp = makeTmpDir();
  try {
    const checkout = join(tmp.dir, "checkout");
    copyCheckout(checkout);
    copyRuntimeDeps(checkout);

    const current = runScript(checkout, "check-dist.mjs");
    assert.equal(current.status, 0, current.stderr);

    const entry = join(checkout, "src", "cli.ts");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}\nconsole.log("stale source");\n`);
    const stale = runScript(checkout, "check-dist.mjs");
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /dist\/skilletor\.js is out of date/);
  } finally {
    tmp.cleanup();
  }
});

test("k279: check-dist refuses a Bun other than package.json gettyBun.bunVersion", () => {
  const tmp = makeTmpDir();
  try {
    const checkout = join(tmp.dir, "checkout");
    copyCheckout(checkout);
    copyRuntimeDeps(checkout);
    const pkgPath = join(checkout, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.gettyBun.bunVersion = "0.0.1";
    writeFileSync(pkgPath, JSON.stringify(pkg));

    const result = runScript(checkout, "check-dist.mjs");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /gettyBun\.bunVersion pins 0\.0\.1/);
  } finally {
    tmp.cleanup();
  }
});
