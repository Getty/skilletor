// Perl CI and the binary build take Text::Nunjucks from CPAN through the cpanfile, like every
// other dependency: no checkout of its own, no PERL5LIB injection, no install in
// scripts/binary-prepare.sh (the bundle's binary_prepare, which prepares TLS only).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const readRepoFile = (path: string) => readFileSync(join(repo, path), "utf8");
const cpanfile = readRepoFile("cpanfile");
const perlWorkflow = readRepoFile(".github/workflows/perl.yml");
const binaryPrepare = readRepoFile("scripts/binary-prepare.sh");

test("cpanfile requires Text::Nunjucks 0.001 and its Perl 5.40 minimum", () => {
  assert.match(cpanfile, /^requires 'perl', '5\.040';$/m);
  assert.match(cpanfile, /^requires 'Text::Nunjucks', '0\.001';$/m);
});

test("Perl CI installs Text::Nunjucks from CPAN through the cpanfile", () => {
  assert.match(perlWorkflow, /^        perl-version: \["5\.40"\]$/m);
  assert.match(perlWorkflow, /^        run: cpanm -nq --installdeps \.$/m);
  assert.equal(perlWorkflow.match(/--installdeps/g)?.length, 1, "one installdeps, the dist's");
  assert.equal(perlWorkflow.match(/uses: actions\/checkout@/g)?.length, 1, "one checkout, the dist's");
  assert.doesNotMatch(perlWorkflow, /PERL5LIB/);
  assert.match(perlWorkflow, /^        run: prove -lr -j4 t$/m);
  assert.doesNotMatch(perlWorkflow, /working-directory:/);
});

test("the binary prepare installs no Text::Nunjucks of its own", () => {
  const code = binaryPrepare.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /nunjucks/i);
});
