// Shared esbuild configuration for skilletor.
//
// One source of truth for the bundle options, used by:
//   - scripts/build.mjs      (writes dist/skilletor.js)
//   - scripts/check-dist.mjs (builds in memory, diffs against the committed dist)
//   - the test suite          (builds a throwaway bundle to run as a black box)
//
// The bundle is a single ESM file targeting Node 18. The package version is
// injected at build time via `define`, so it stays in one place (package.json).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const entryPoint = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
export const distPath = fileURLToPath(new URL("../dist/skilletor.js", import.meta.url));

function failForNonlocalDependency(detail) {
  throw new Error(
    `build: ${detail}. Run \`npm ci\` so dependencies resolve from this checkout's local node_modules.`,
  );
}

function isWithin(path, parent) {
  const pathFromParent = relative(parent, path);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

function localPackageEntry(packageName) {
  const packagePath = join(projectRoot, "node_modules", packageName, "package.json");
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    return join(dirname(packagePath), packageJson.main ?? "index.js");
  } catch {
    failForNonlocalDependency(`local node_modules/${packageName} is missing`);
  }
}

function assertLocalBundleInputs(metafile) {
  for (const input of Object.keys(metafile.inputs)) {
    const inputPath = resolve(projectRoot, input);
    if (!isWithin(inputPath, projectRoot)) {
      failForNonlocalDependency(
        `bundled input ${input} resolves outside this checkout (${inputPath})`,
      );
    }
  }
}

// Load esbuild through the lexical local package path. This permits an explicit
// node_modules/esbuild symlink while rejecting ancestor package resolution.
const esbuildPath = localPackageEntry("esbuild");
const esbuild = await import(pathToFileURL(esbuildPath).href);

/** esbuild options shared by every build path. */
export const buildOptions = {
  entryPoints: [entryPoint],
  absWorkingDir: projectRoot,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  metafile: true,
  // An explicit local node_modules symlink remains rooted at this checkout.
  preserveSymlinks: true,
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

async function bundled(options) {
  const result = await esbuild.build({ ...buildOptions, ...options, write: false });
  assertLocalBundleInputs(result.metafile);
  return result;
}

/** Build the bundle to `outfile` on disk. */
export async function build(outfile) {
  const result = await bundled({ outfile });
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, result.outputFiles[0].contents);
}

/** Build the bundle and return its bytes as a string, without touching disk. */
export async function buildToString() {
  const result = await bundled({});
  return result.outputFiles[0].text;
}
