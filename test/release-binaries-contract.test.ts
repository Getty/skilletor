// A release-binaries dispatch may select an old tag, so its non-CPAN template
// dependency must be resolved from that checkout rather than the workflow revision.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repo, ".github/workflows/release-binaries.yml"), "utf8");

const bash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const noBash = bash ? false : "bash is not available on PATH";

function resolverScript(): string {
  const match = workflow.match(
    /^          # BEGIN text-nunjucks-pin resolver\n([\s\S]*?)^          # END text-nunjucks-pin resolver$/m,
  );
  assert.ok(match, "workflow marks the source-pin resolver for its contract test");
  return match[1].split("\n").map((line) => line.replace(/^          /, "")).join("\n");
}

function resolveSelectedPin(selectedWorkflow: string) {
  const tmp = makeTmpDir("skilletor-release-binaries-");
  try {
    const workflowPath = join(tmp.dir, ".github", "workflows", "release-binaries.yml");
    const output = join(tmp.dir, "output");
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, selectedWorkflow);
    const result = spawnSync("bash", ["-c", resolverScript()], {
      cwd: tmp.dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally {
    tmp.cleanup();
  }
}

function selectedWorkflow(repoName: string, ref: string): string {
  return `env:
  TEXT_NUNJUCKS_REPO: ${repoName}
  TEXT_NUNJUCKS_REF: ${ref}
`;
}

test("release-binaries wires the selected source pin to the dependency checkout", () => {
  const resolver = workflow.indexOf("id: text-nunjucks-pin");
  const dependencyCheckout = workflow.indexOf("Check out Text::Nunjucks (not on CPAN) at the selected source's pinned commit");
  assert.ok(workflow.indexOf("ref: ${{ env.TAG") < resolver);
  assert.ok(resolver < dependencyCheckout);
  assert.match(workflow, /# BEGIN text-nunjucks-pin resolver/);
  assert.match(workflow, /# END text-nunjucks-pin resolver/);
  assert.match(workflow, /repository: \$\{\{ steps\.text-nunjucks-pin\.outputs\.repository \}\}/);
  assert.match(workflow, /ref: \$\{\{ steps\.text-nunjucks-pin\.outputs\.ref \}\}/);
  assert.doesNotMatch(workflow, /repository: \$\{\{ env\.TEXT_NUNJUCKS_REPO \}\}/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ env\.TEXT_NUNJUCKS_REF \}\}/);
});

test("release-binaries resolver reads the template pin from the selected source checkout", { skip: noBash }, () => {
  const result = resolveSelectedPin(selectedWorkflow("example/old-template", "b".repeat(40)));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `repository=example/old-template\nref=${"b".repeat(40)}\n`);
});

test("release-binaries resolver rejects missing, duplicate, and invalid template pins", { skip: noBash }, () => {
  const missing = resolveSelectedPin("env:\n  TEXT_NUNJUCKS_REPO: example/template\n");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /must declare exactly one TEXT_NUNJUCKS_REF/);

  const duplicate = resolveSelectedPin(`${selectedWorkflow("example/template", "c".repeat(40))}  TEXT_NUNJUCKS_REF: ${"d".repeat(40)}\n`);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /must declare exactly one TEXT_NUNJUCKS_REF/);

  const invalid = resolveSelectedPin(selectedWorkflow("example/template", "main"));
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /immutable 40-character lowercase Git commit SHA/);

  const invalidRepository = resolveSelectedPin(selectedWorkflow("example/template/extra", "e".repeat(40)));
  assert.notEqual(invalidRepository.status, 0);
  assert.match(invalidRepository.stderr, /invalid Text::Nunjucks repository/);
});
