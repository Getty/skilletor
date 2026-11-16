// The Perl CI cannot obtain Text::Nunjucks from CPAN yet. Keep its minimum Perl
// declaration and its checked-out dependency contract aligned with the binary build
// (scripts/binary-prepare.sh, the bundle's binary_prepare; TEMP until k243).
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

function envValue(workflow: string, name: string): string | undefined {
  return new RegExp(`^\\s+${name}: (.+)$`, "m").exec(workflow)?.[1];
}

function shellValue(script: string, name: string): string | undefined {
  return new RegExp(`^${name}=(.+)$`, "m").exec(script)?.[1];
}

test("Perl distribution declares Text::Nunjucks' Perl 5.40 minimum", () => {
  assert.match(cpanfile, /^requires 'perl', '5\.040';$/m);
});

test("Perl CI checks out and provisions the pinned Text::Nunjucks dependency", () => {
  assert.match(perlWorkflow, /^        perl-version: \["5\.40"\]$/m);
  assert.equal(`https://github.com/${envValue(perlWorkflow, "TEXT_NUNJUCKS_REPO")}`, shellValue(binaryPrepare, "TEXT_NUNJUCKS_REPO"));
  assert.match(envValue(perlWorkflow, "TEXT_NUNJUCKS_REF") ?? "", /^[0-9a-f]{40}$/);
  assert.equal(envValue(perlWorkflow, "TEXT_NUNJUCKS_REF"), shellValue(binaryPrepare, "TEXT_NUNJUCKS_REF"));
  assert.match(perlWorkflow, /- name: Check out Text::Nunjucks \(not on CPAN\) at the pinned commit\n        uses: actions\/checkout@v6\n        with:\n          repository: \$\{\{ env\.TEXT_NUNJUCKS_REPO \}\}\n          ref: \$\{\{ env\.TEXT_NUNJUCKS_REF \}\}\n          path: _deps\/p5-text-nunjucks/m);
  assert.match(perlWorkflow, /echo "PERL5LIB=\$GITHUB_WORKSPACE\/_deps\/p5-text-nunjucks\/lib" >> "\$GITHUB_ENV"/);
  assert.match(perlWorkflow, /cpanm -nq --installdeps \.\/_deps\/p5-text-nunjucks\n          cpanm -nq --installdeps \.\n/);
  assert.match(perlWorkflow, /^        run: prove -lr -j4 t$/m);
  assert.doesNotMatch(perlWorkflow, /working-directory:/);
});
