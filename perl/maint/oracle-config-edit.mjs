// Regenerates t/data/config-edit-oracle.json: the reference's config edit operations applied
// one after another to a file – after each, its return value and the file's bytes. Run from
// perl/:  node maint/oracle-config-edit.mjs > t/data/config-edit-oracle.json
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../../src/config.ts";

const runs = [
  { name: "from nothing", start: null, ops: [
    ["addSource", "shared", { git: "https://github.com/Getty/skills", ref: "main" }],
    ["addInstallEntry", "skill", "perl-moo@shared"],
    ["addInstallEntry", "skill", "perl-moo@shared"],
    ["addInstallEntry", "rule", "*@shared"],
    ["addBundleEntry", "perl@shared"],
    ["addBundleEntry", "bundle:perl@shared"],
    ["addSource", "2", { url: "https://x/y.tgz" }],
    ["findInstallEntries", "PERL-MOO"],
    ["findInstallEntries", "perl-moo", "other"],
    ["findWildcardEntries", "shared"],
    ["bundleEntries"],
    ["sourceEntry", "shared"],
    ["sourceEntry", "nope"],
    ["removeInstallEntries", "Perl-Moo"],
    ["removeInstallEntries", "*", "shared", "rule"],
    ["removeBundleEntries", "perl", "shared"],
    ["removeSource", "shared"],
    ["removeSource", "2"],
  ] },
  { name: "keeps order and unknown content", start: '{\n    "vars": {"z": 1, "a": [1,2,{"q":null}]},\n  "sources": {"b": {"local": "~/b"}, "a": {"git": "https://a"}},\n  "install": {"agents": ["x@a"], "skills": ["y@b"]}\n}', ops: [
    ["addSource", "c", { local: "~/c", path: ["skills"] }],
    ["addSource", "a", { git: "https://a2" }],
    ["addInstallEntry", "agent", "z@c"],
    ["removeInstallEntries", "y"],
    ["removeInstallEntries", "x", "a", "agent"],
    ["removeInstallEntries", "z"],
    ["removeSource", "b"],
  ] },
  { name: "unicode and escapes", start: '{"vars":{"s":"\\u00e9\\/\\ud83d\\ude00\\u2028","n":1.50,"e":1e3}}', ops: [
    ["addSource", "u", { git: "https://example.com/ü" }],
  ] },
  { name: "non-string install entry", start: '{"install":{"skills":["y@b",5]}}', ops: [["removeInstallEntries", "y"]] },
  { name: "broken file", start: '{"sources": [', ops: [["addSource", "a", { git: "https://a" }]] },
  { name: "top level array", start: "[]", ops: [["sourceEntry", "a"]] },
];

const root = mkdtempSync(join(tmpdir(), "skilletor-edit-"));
const out = [];
for (const run of runs) {
  const file = join(root, `${out.length}.json`);
  if (run.start !== null) writeFileSync(file, run.start);
  const steps = [];
  for (const [fn, ...args] of run.ops) {
    const step = { op: [fn, ...args] };
    try {
      const r = config[fn](file, ...args);
      step.result = r === undefined ? null : r;
    } catch (e) {
      step.error = e.message.split(file).join("<FILE>");
    }
    step.file = existsSync(file) ? readFileSync(file, "utf8") : null;
    steps.push(step);
  }
  out.push({ name: run.name, start: run.start, steps });
}
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
