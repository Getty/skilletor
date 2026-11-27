// `bun run check-dist` — fail if the committed dist/skilletor.js is stale.
//
// Rebuilds the bundle with the running Bun into a temp file and compares it byte for byte
// with the committed one (cmp), so CI can guarantee dist/ always matches the source it was
// built from. Only the pinned Bun (package.json gettyBun.bunVersion) builds the committed bytes.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, distPath, pkg } from "./bundle.mjs";

const pinned = pkg.gettyBun?.bunVersion;
if (Bun.version !== pinned) {
  console.error(
    `check-dist: running Bun ${Bun.version}, but package.json gettyBun.bunVersion pins ${pinned}. ` +
      "Run it with the pinned Bun: another version builds other bytes.",
  );
  process.exit(1);
}

let committed;
try {
  committed = readFileSync(distPath);
} catch {
  console.error("check-dist: dist/skilletor.js is missing. Run `bun run build`.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "skilletor-check-dist-"));
let fresh;
try {
  const outfile = join(dir, "skilletor.js");
  await build(outfile);
  fresh = readFileSync(outfile);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (!fresh.equals(committed)) {
  console.error(
    "check-dist: dist/skilletor.js is out of date. Run `bun run build` and commit the result.",
  );
  process.exit(1);
}

console.log("check-dist: dist/skilletor.js is up to date.");
