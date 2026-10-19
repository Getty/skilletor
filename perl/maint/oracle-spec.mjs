// Regenerates t/data/spec-oracle.json: every string literal of the reference's test/spec.test.ts
// plus maint/spec-extra.json run through resolveSpec with a fixed probe (git when the URL holds
// "git", a tarball when it holds tar, tgz or pkg). Run from perl/:
//   node maint/oracle-spec.mjs > t/data/spec-oracle.json
import { readFileSync } from "node:fs";
import { resolveSpec } from "../../src/spec.ts";

const src = readFileSync(new URL("../../test/spec.test.ts", import.meta.url), "utf8");
const lits = new Set();
for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
  try { lits.add(JSON.parse(`"${m[1]}"`)); } catch {}
}
const extra = JSON.parse(readFileSync(new URL("./spec-extra.json", import.meta.url), "utf8"));
for (const e of extra) lits.add(e);
const out = [];
for (const spec of lits) {
  if (spec.length > 160) continue;
  const probed = [];
  const probe = (url) => { probed.push(url); return { git: /git/.test(url), tarball: /tar|tgz|pkg/.test(url) }; };
  try {
    const r = resolveSpec(spec, probe);
    out.push({ spec, result: r, probed });
  } catch (e) {
    out.push({ spec, error: e.message, probed });
  }
}
console.log(JSON.stringify(out, null, 1));
