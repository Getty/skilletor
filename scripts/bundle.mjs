// The one build of dist/skilletor.js, run with Bun (`bun build --target=bun`), used by:
//   - scripts/build.mjs      (writes dist/skilletor.js, or the file it is given)
//   - scripts/check-dist.mjs (rebuilds into a temp file, compares byte for byte)
//   - the test suite          (buildTo(): a throwaway bundle to run as a black box)
//
// A single ESM file for the Bun runtime, nothing external: Nunjucks is bundled in and its
// require() calls become Bun's import.meta.require. The package version is injected through
// `define`, so it stays in one place (package.json).
//
// Bun names every bundled module in a comment by its path relative to the working directory,
// so bundle() builds from the checkout root: the bundle never carries the checkout's absolute
// path, and two checkouts at different paths build the same bytes.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const distPath = fileURLToPath(new URL("../dist/skilletor.js", import.meta.url));
const buildScript = fileURLToPath(new URL("./build.mjs", import.meta.url));

export const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function isWithin(path, parent) {
  const pathFromParent = relative(parent, path);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

/**
 * Build the bundle and return its bytes. Changes the process's working directory to the
 * checkout root and leaves it there: call it only from a process of its own (the scripts).
 */
export async function bundle() {
  process.chdir(projectRoot);
  const result = await Bun.build({
    entrypoints: ["src/cli.ts"],
    target: "bun",
    format: "esm",
    metafile: true,
    define: { __SKILLETOR_VERSION__: JSON.stringify(pkg.version) },
  });
  if (!result.success) throw new AggregateError(result.logs, "build: bun build failed");
  // Every input comes from this checkout: a package that falls back to an ancestor's
  // node_modules would make the bundle depend on where the checkout lives.
  for (const input of Object.keys(result.metafile.inputs)) {
    const inputPath = resolve(projectRoot, input);
    if (!isWithin(inputPath, projectRoot)) {
      throw new Error(
        `build: bundled input ${input} resolves outside this checkout (${inputPath}). ` +
          "Run `bun install --frozen-lockfile` so dependencies resolve from this checkout's local node_modules.",
      );
    }
  }
  return new Uint8Array(await result.outputs[0].arrayBuffer());
}

/** Write the bundle to `outfile`. */
export async function build(outfile) {
  const bytes = await bundle();
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, bytes);
}

/**
 * Build the bundle to `outfile` in a child Bun process, leaving this process's working
 * directory alone (for tests).
 */
export function buildTo(outfile) {
  const r = spawnSync(process.execPath, [buildScript, outfile], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed (${r.status ?? r.signal}): ${r.stderr}${r.error ?? ""}`);
}
