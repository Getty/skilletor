// `npm run build` — bundle src/cli.ts into the committed dist/skilletor.js.
import { build, distPath } from "./esbuild.config.mjs";

await build(distPath);
console.log(`built ${distPath}`);
