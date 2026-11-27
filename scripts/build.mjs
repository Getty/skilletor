// `bun run build` — bundle src/cli.ts into the committed dist/skilletor.js
// (`bun scripts/build.mjs <file>` writes another file instead).
import { resolve } from "node:path";
import { build, distPath } from "./bundle.mjs";

const outfile = process.argv[2] ? resolve(process.argv[2]) : distPath;
await build(outfile);
console.log(`built ${outfile}`);
