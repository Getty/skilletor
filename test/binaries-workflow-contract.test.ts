// The binary build calls the bundle's reusable dzil-binary workflow, which checks out its own
// scripts from the bundle at its bundle_ref input (default: the moving binary-v1 tag). Pinning
// uses: alone would still run whatever scripts the tag points at, so both name one full commit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "binaries.yml"), "utf8");

// The lines after `<indent>name:` that are indented deeper, i.e. the block's body.
function body(text: string, name: string, indentation: number): string {
  const re = new RegExp(`^ {${indentation}}${name}:\\n((?: {${indentation + 1},}.*(?:\\n|$))*)`, "m");
  const found = re.exec(text);
  assert.ok(found, `binaries.yml has ${name}: at indentation ${indentation}`);
  return found[1]!;
}

test("the dzil-binary workflow and its scripts are pinned to the same full bundle commit", () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*(.*)$/gm)].map((match) => match[1]);
  assert.equal(uses.length, 1, "one reusable-workflow call");
  const call = /^Getty\/p5-dist-zilla-pluginbundle-author-getty\/\.github\/workflows\/dzil-binary\.yml@([0-9a-f]{40})$/;
  const workflowSha = call.exec(uses[0]!)?.[1];
  assert.ok(workflowSha, `uses: names dzil-binary.yml at a full commit, not a tag or branch: ${uses[0]}`);

  const bundleRef = /^      bundle_ref: ([0-9a-f]{40})$/m.exec(body(workflow, "with", 4))?.[1];
  assert.ok(bundleRef, "with: passes bundle_ref as a full commit");
  assert.equal(bundleRef, workflowSha, "uses: and bundle_ref name the same commit");
});

test("a published release or a manual dispatch with a tag builds and attaches the binaries", () => {
  assert.match(body(workflow, "release", 2), /^    types: \[published\]$/m);
  assert.match(body(body(workflow, "workflow_dispatch", 2), "inputs", 4), /^      tag:$/m);
  assert.match(body(workflow, "with", 4), /^      tag: \$\{\{ github\.event\.release\.tag_name \|\| inputs\.tag \}\}$/m);
});
