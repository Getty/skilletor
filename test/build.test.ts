// k220: an intentional node_modules symlink must not change the generated bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildOptions } from "../scripts/esbuild.config.mjs";
import { NO_SYMLINKS } from "./helpers/symlink.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

function makePackage(checkout: string) {
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "node_modules", "fixture-package"), { recursive: true });
  writeFileSync(join(checkout, "src", "entry.ts"), 'import value from "fixture-package";\nconsole.log(value);\n');
  writeFileSync(join(checkout, "node_modules", "fixture-package", "package.json"), '{"main":"index.js"}\n');
  writeFileSync(join(checkout, "node_modules", "fixture-package", "index.js"), 'module.exports = "fixture";\n');
}

async function bundle(checkout: string): Promise<string> {
  const result = await esbuild.build({
    ...buildOptions,
    entryPoints: [join(checkout, "src", "entry.ts")],
    absWorkingDir: checkout,
    write: false,
  });
  return result.outputFiles[0]!.text;
}

function copyCheckout(checkout: string) {
  mkdirSync(checkout, { recursive: true });
  for (const path of ["package.json", "src", "scripts", "dist"]) {
    cpSync(join(repo, path), join(checkout, path), { recursive: true });
  }
}

function runCheckDist(checkout: string) {
  return spawnSync(process.execPath, ["scripts/check-dist.mjs"], {
    cwd: checkout,
    encoding: "utf8",
  });
}

function runBuild(checkout: string) {
  return spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: checkout,
    encoding: "utf8",
  });
}

function copyEsbuild(checkout: string) {
  for (const path of ["esbuild", "@esbuild"]) {
    cpSync(join(repo, "node_modules", path), join(checkout, "node_modules", path), {
      recursive: true,
    });
  }
}

function writePackage(path: string, source: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), '{"main":"index.js"}\n');
  writeFileSync(join(path, "index.js"), source);
}

test("k148: build refuses tooling resolved from an ancestor", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const ancestor = join(tmp.dir, "ancestor");
    const checkout = join(ancestor, "checkout");
    copyCheckout(checkout);
    rmSync(join(checkout, "dist"), { recursive: true, force: true });
    symlinkSync(join(repo, "node_modules"), join(ancestor, "node_modules"));

    const result = runBuild(checkout);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /local node_modules/);
    assert.match(result.stderr, /npm ci/);
    assert.equal(existsSync(join(checkout, "dist", "skilletor.js")), false);
  } finally {
    tmp.cleanup();
  }
});

test("k148: build accepts an explicit local esbuild package symlink", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const checkout = join(tmp.dir, "checkout");
    copyCheckout(checkout);
    rmSync(join(checkout, "dist"), { recursive: true, force: true });
    mkdirSync(join(checkout, "node_modules"), { recursive: true });
    symlinkSync(join(repo, "node_modules", "esbuild"), join(checkout, "node_modules", "esbuild"));
    writeFileSync(join(checkout, "src", "cli.ts"), 'console.log("fixture");\n');

    const result = runBuild(checkout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(checkout, "dist", "skilletor.js")), true);
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
    copyEsbuild(checkout);
    writeFileSync(
      join(checkout, "src", "cli.ts"),
      'import value from "fixture-direct";\nconsole.log(value);\n',
    );
    writePackage(
      join(checkout, "node_modules", "fixture-direct"),
      'module.exports = require("fixture-transitive");\n',
    );
    writePackage(
      join(ancestor, "node_modules", "fixture-transitive"),
      'module.exports = "transitive";\n',
    );

    const result = runBuild(checkout);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixture-transitive/);
    assert.match(result.stderr, /npm ci/);
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
    copyEsbuild(checkout);
    writeFileSync(
      join(checkout, "src", "cli.ts"),
      'import value from "fixture-direct";\nconsole.log(value);\n',
    );
    writePackage(
      join(checkout, "node_modules", "fixture-direct"),
      'module.exports = require("fixture-transitive");\n',
    );
    const linkedTransitive = join(tmp.dir, "linked-transitive");
    writePackage(linkedTransitive, 'module.exports = "transitive";\n');
    mkdirSync(join(ancestor, "node_modules"), { recursive: true });
    symlinkSync(linkedTransitive, join(ancestor, "node_modules", "fixture-transitive"));

    const result = runBuild(checkout);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixture-transitive/);
    assert.match(result.stderr, /npm ci/);
    assert.equal(existsSync(join(checkout, "dist", "skilletor.js")), false);
  } finally {
    tmp.cleanup();
  }
});
test("k220: regular and intentionally linked node_modules produce identical bundles", { skip: NO_SYMLINKS }, async () => {
  const tmp = makeTmpDir();
  try {
    const regular = join(tmp.dir, "regular");
    const linked = join(tmp.dir, "linked");
    makePackage(regular);
    mkdirSync(join(linked, "src"), { recursive: true });
    cpSync(join(regular, "src", "entry.ts"), join(linked, "src", "entry.ts"));
    symlinkSync(join(regular, "node_modules"), join(linked, "node_modules"));

    assert.equal(await bundle(linked), await bundle(regular));
  } finally {
    tmp.cleanup();
  }
});

test("k220: check-dist accepts linked dependencies and still detects stale source", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    const checkout = join(tmp.dir, "linked-checkout");
    copyCheckout(checkout);
    symlinkSync(join(repo, "node_modules"), join(checkout, "node_modules"));

    const current = runCheckDist(checkout);
    assert.equal(current.status, 0, current.stderr);

    const entry = join(checkout, "src", "cli.ts");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}\nconsole.log("k220 stale source");\n`);
    const stale = runCheckDist(checkout);
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /dist\/skilletor\.js is out of date/);
  } finally {
    tmp.cleanup();
  }
});
