// The CI contract (k282): every OS leg runs the Bun gates on the pinned Bun; ubuntu-latest is
// required, macOS and native Windows are advisory (expected red until agent-bun-runtime ships a
// darwin target, F5, and the .cmd polyglot for Claude Code, F2), and Linux checks the starters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
const pin = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).gettyBun.bunVersion;

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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("k282: push and pull-request CI requires Linux; macOS and native Windows run advisory", () => {
  const triggers = yamlBlock(workflow, "on", 0);
  assert.match(triggers, /^  push:$/m);
  assert.match(triggers, /^    branches: \[main\]$/m);
  assert.match(triggers, /^  pull_request:$/m);

  const job = yamlBlock(workflow, "test", 2);
  assert.match(job, /^    runs-on: \$\{\{ matrix\.os \}\}$/m);
  const legs = [...job.matchAll(/^          - os: (\S+)\n            advisory: (true|false)$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(legs, [["ubuntu-latest", "false"], ["macos-latest", "true"], ["windows-latest", "true"]]);
  assert.doesNotMatch(job, /^        os: \[/m, "no plain os list beside the include legs");
  // Only an advisory leg may fail without failing the run, and its name says so.
  assert.match(job, /^    continue-on-error: \$\{\{ matrix\.advisory \}\}$/m);
  assert.match(job, /^    name: test \(\$\{\{ matrix\.os \}\}\)\$\{\{ matrix\.advisory && ' advisory, expected red' \|\| '' \}\}$/m);
  assert.match(job, /^      fail-fast: false$/m);
});

test("k282: every leg runs the Bun gates on package.json's pinned Bun; Linux checks the starters", () => {
  const job = yamlBlock(workflow, "test", 2);
  assert.match(job, /^      - uses: oven-sh\/setup-bun@v\d+$/m);
  assert.match(job, new RegExp(`^          bun-version: "${escape(pin)}"$`, "m"), "setup-bun installs gettyBun.bunVersion");
  assert.match(job, /^      - run: bun -e .*gettyBun\.bunVersion.*process\.exit\(1\)/m, "a step fails when setup-bun and the pin disagree");
  assert.doesNotMatch(job, /setup-node|npm /);

  const runs = [...job.matchAll(/^      - run: (.+)$/gm)].map((m) => m[1]!).filter((cmd) => !cmd.startsWith("bun -e "));
  assert.deepEqual(runs, ["bun install --frozen-lockfile", "bun run typecheck", "bun run test", "bun run check-dist"]);
  assert.match(job, /^      - if: matrix\.os == 'ubuntu-latest'\n        run: bun run check-starters$/m);
});
