// The CI contract (k282): every OS leg runs the Bun gates on the pinned Bun; ubuntu-latest and
// native Windows are required, macOS is advisory (expected red until agent-bun-runtime ships a
// darwin target, F5), and Linux checks the starters. The workflow is read with Bun.YAML.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** The one Bun API used here; the project's types are Node's only (tsconfig.json). */
declare const Bun: { YAML: { parse(text: string): unknown } };

const repo = fileURLToPath(new URL("..", import.meta.url));
type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = {
  name: string;
  "runs-on": string;
  "continue-on-error": unknown;
  strategy: { "fail-fast": unknown; matrix: Record<string, unknown> & { include: { os: string; advisory: unknown }[] } };
  steps: Step[];
};
const workflow = Bun.YAML.parse(readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8")) as {
  on: Record<string, unknown>;
  jobs: { test: Job };
};
const pin = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).gettyBun.bunVersion;
const job = workflow.jobs.test;

test("k282: push and pull-request CI requires Linux and native Windows; macOS runs advisory", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });

  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.deepEqual(Object.keys(job.strategy.matrix), ["include"], "no plain os list beside the include legs");
  assert.deepEqual(job.strategy.matrix.include, [
    { os: "ubuntu-latest", advisory: false },
    { os: "macos-latest", advisory: true },
    { os: "windows-latest", advisory: false },
  ]);
  // Only an advisory leg may fail without failing the run, and its name says so.
  assert.equal(job["continue-on-error"], "${{ matrix.advisory }}");
  assert.equal(job.name, "test (${{ matrix.os }})${{ matrix.advisory && ' advisory, expected red' || '' }}");
  assert.equal(job.strategy["fail-fast"], false);
});

test("k282: every leg runs the Bun gates on package.json's pinned Bun; Linux checks the starters", () => {
  const setup = job.steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
  assert.equal(setup.length, 1);
  assert.match(setup[0]!.uses!, /^oven-sh\/setup-bun@v\d+$/);
  assert.equal(setup[0]!.with?.["bun-version"], pin, "setup-bun installs gettyBun.bunVersion");
  assert.ok(job.steps.some((s) => !s.if && /^bun -e .*gettyBun\.bunVersion.*process\.exit\(1\)/.test(s.run ?? "")),
    "a step fails when setup-bun and the pin disagree");
  assert.doesNotMatch(JSON.stringify(job), /setup-node|npm /);

  const runs = job.steps.filter((s) => s.run && !s.if && !s.run.startsWith("bun -e ")).map((s) => s.run);
  assert.deepEqual(runs, ["bun install --frozen-lockfile", "bun run typecheck", "bun run test", "bun run check-dist"]);
  const conditional = job.steps.filter((s) => s.if !== undefined);
  assert.deepEqual(conditional, [{ if: "matrix.os == 'ubuntu-latest'", run: "bun run check-starters" }]);
});
