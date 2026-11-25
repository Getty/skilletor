// The farewell dist Skilletor: stubs that need core Perl alone (cpanfile), tested by Perl CI on
// its own checkout, with nothing of the plugin's Node side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const readRepoFile = (path: string) => readFileSync(join(repo, path), "utf8");
const cpanfile = readRepoFile("cpanfile");
const perlWorkflow = readRepoFile(".github/workflows/perl.yml");

test("cpanfile requires nothing at runtime beyond Perl 5.20", () => {
  // Runtime requirements stand at the start of a line; the test phase's are indented in its block.
  assert.deepEqual(cpanfile.match(/^requires .*$/gm), ["requires 'perl', '5.020';"]);
});

test("Perl CI installs the dist's test dependencies through the cpanfile and runs t/", () => {
  assert.match(perlWorkflow, /^        perl-version: \["5\.40"\]$/m);
  // Two jobs, Linux and the Windows leg (k262): each installs the dist's deps, from its own checkout.
  assert.deepEqual(
    perlWorkflow.match(/^ +run: .*--installdeps.*$/gm)?.map((line) => line.trim()),
    ["run: cpanm -nq --installdeps .", "run: perl -S cpanm -nq --installdeps ."],
    "one installdeps per job, the dist's",
  );
  assert.equal(perlWorkflow.match(/--installdeps/g)?.length, 2, "no other installdeps");
  assert.equal(perlWorkflow.match(/uses: actions\/checkout@/g)?.length, 2, "one checkout per job, the dist's");
  assert.doesNotMatch(perlWorkflow, /^\s+repository:/m, "no checkout of another repository");
  assert.doesNotMatch(perlWorkflow, /PERL5LIB/);
  assert.doesNotMatch(perlWorkflow, /setup-node|npm /, "the stubs need no Node");
  assert.deepEqual(
    perlWorkflow.match(/^ +run: .*prove.*$/gm)?.map((line) => line.trim()),
    ["run: prove -lr t", "run: perl -S prove -lr t"],
    "each job runs the whole of t/",
  );
  assert.doesNotMatch(perlWorkflow, /working-directory:/);
});
