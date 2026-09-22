// `npm run check-dist` — fail if the committed dist/skilletor.js is stale.
//
// Rebuilds the bundle in memory and diffs it against the committed file, so CI
// can guarantee dist/ always matches the source it was built from.
import { readFileSync } from "node:fs";
import { buildToString, distPath } from "./esbuild.config.mjs";

const fresh = await buildToString();

let committed;
try {
  committed = readFileSync(distPath, "utf8");
} catch {
  console.error("check-dist: dist/skilletor.js is missing. Run `npm run build`.");
  process.exit(1);
}

if (fresh !== committed) {
  console.error(
    "check-dist: dist/skilletor.js is out of date. Run `npm run build` and commit the result.",
  );
  process.exit(1);
}

console.log("check-dist: dist/skilletor.js is up to date.");
