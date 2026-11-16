// Native Windows coverage is part of the ordinary CI contract: every OS leg uses the
// Node 24 TypeScript test runtime and must keep all three repository gates required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");

function yamlBlock(text: string, name: string, indentation: number): string {
  const lines = text.split("\n");
  const prefix = " ".repeat(indentation);
  const start = lines.findIndex((line) => line === `${prefix}${name}:`);
  assert.notEqual(start, -1, `CI workflow has ${name}: at indentation ${indentation}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const leading = line.length - line.trimStart().length;
    if (leading <= indentation) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("ordinary push and pull-request CI requires Linux, macOS, and native Windows gates", () => {
  const triggers = yamlBlock(workflow, "on", 0);
  assert.match(triggers, /^  push:$/m);
  // TEMP (k242): also accepts the probe's extra ack-paket push branch, only under its TEMP marker;
  // drop before merging, together with the trigger, back to /^    branches: \[main\]$/m alone.
  assert.match(triggers, /^(?:    # TEMP \(k242\): probe runs from ack-paket; drop before merging\n    branches: \[main, ack-paket\]|    branches: \[main\])$/m); // TEMP (k242)
  assert.match(triggers, /^  pull_request:$/m);

  const job = yamlBlock(workflow, "test", 2);
  assert.match(job, /^    runs-on: \$\{\{ matrix\.os \}\}$/m);
  const os = /^        os: \[([^\]]+)\]$/m.exec(job)?.[1]
    ?.split(",")
    .map((name) => name.trim());
  assert.deepEqual(os, ["ubuntu-latest", "macos-latest", "windows-latest"]);

  assert.match(job, /^      - uses: actions\/setup-node@v\d+$/m);
  assert.match(job, /^          node-version: "24"$/m);
  for (const command of ["npm run typecheck", "npm test", "npm run check-dist"]) {
    assert.match(job, new RegExp(`^      - run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.doesNotMatch(job, /continue-on-error:\s*true/);
});
