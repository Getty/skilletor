// Shared esbuild configuration for skilletor.
//
// One source of truth for the bundle options, used by:
//   - scripts/build.mjs      (writes dist/skilletor.js)
//   - scripts/check-dist.mjs (builds in memory, diffs against the committed dist)
//   - the test suite          (builds a throwaway bundle to run as a black box)
//
// The bundle is a single ESM file targeting Node 18. The package version is
// injected at build time via `define`, so it stays in one place (package.json).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const entryPoint = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
export const distPath = fileURLToPath(new URL("../dist/skilletor.js", import.meta.url));

/** esbuild options shared by every build path. */
export const buildOptions = {
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  legalComments: "none",
  define: {
    __SKILLETOR_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    // A real `require` for bundled CJS deps (e.g. nunjucks) that require() node
    // built-ins — esbuild's require shim uses the global `require` when present.
    js: [
      "// skilletor — generated bundle, do not edit. Rebuild with `npm run build`.",
      'import { createRequire as __sk_createRequire } from "node:module";',
      "const require = __sk_createRequire(import.meta.url);",
    ].join("\n"),
  },
};

/** Build the bundle to `outfile` on disk. */
export async function build(outfile) {
  await esbuild.build({ ...buildOptions, outfile, write: true });
}

/** Build the bundle and return its bytes as a string, without touching disk. */
export async function buildToString() {
  const result = await esbuild.build({ ...buildOptions, write: false });
  return result.outputFiles[0].text;
}
