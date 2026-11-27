// k282: scripts/check-starters.mjs, the CI drift check of the getty-bun starters, against a fixture
// checkout whose agent-bun-runtime is a local source (offline). The real run (git source at the
// pinned ref) happens in CI only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/check-starters.mjs", import.meta.url));
const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "bunVersion"],
  properties: {
    contractVersion: { const: 1 },
    bunVersion: { type: "string", pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" },
  },
};
const SH = "#!/bin/sh\n# version 1.4.5\necho starter\n";
const PS1 = "# version 1.4.5\nWrite-Output starter\n";

function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A committed checkout that matches its source; `change` edits it before the commit. */
function fixture(change: (co: string, src: string) => void = () => {}) {
  const tmp = makeTmpDir();
  const src = join(tmp.dir, "src");
  const co = join(tmp.dir, "co");
  put(join(src, "skills/getty-bun-install/SKILL.md"), "---\ndescription: starters\n---\nbody\n");
  put(join(src, "skills/getty-bun-install/bootstrap/getty-bun.sh.njk"), "#!/bin/sh\n# version {{ vars.bun_version }}\necho starter\n");
  put(join(src, "skills/getty-bun-install/bootstrap/getty-bun.ps1.njk"), "# version {{ vars.bun_version }}\nWrite-Output starter\n");
  put(join(src, "skills/getty-bun-integration/SKILL.md"), "---\ndescription: contract\n---\nbody\n");
  put(join(src, "skills/getty-bun-integration/assets/requirement.schema.json"), JSON.stringify(SCHEMA));
  put(join(co, "package.json"), JSON.stringify({ gettyBun: { contractVersion: 1, bunVersion: "1.4.5" } }));
  put(join(co, ".claude-plugin/plugin.json"), "{}\n");
  put(join(co, ".claude/skilletor.json"), JSON.stringify({
    sources: { "agent-bun-runtime": { local: src } },
    vars: { bun_version: "1.4.5" },
    install: { skills: [{ skill: "getty-bun-install@agent-bun-runtime", into: "plugin" }, "getty-bun-integration@agent-bun-runtime"] },
    targets: ["claude"],
  }));
  put(join(co, ".claude/.gitignore"), "skilletor.lock.json\nskills/getty-bun-integration/\n");
  put(join(co, "skills/getty-bun-install/SKILL.md"), "---\ndescription: starters\n---\nbody\n");
  put(join(co, "skills/getty-bun-install/bootstrap/getty-bun.sh"), SH);
  put(join(co, "skills/getty-bun-install/bootstrap/getty-bun.ps1"), PS1);
  put(join(co, "bootstrap/getty-bun.sh"), SH);
  put(join(co, "bootstrap/getty-bun.ps1"), PS1);
  change(co, src);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: co, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "fixture");
  const run = () => spawnSync(process.execPath, [SCRIPT, co], { encoding: "utf8", env: { ...process.env, HOME: join(tmp.dir, "machine-home") } });
  return { co, run, cleanup: () => tmp.cleanup() };
}

function expectFail(f: ReturnType<typeof fixture>, needle: string) {
  try {
    const r = f.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(needle), `expected "${needle}" in:\n${r.stderr}`);
  } finally {
    f.cleanup();
  }
}

test("k282: committed starters equal to a fresh render pass", () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /the starters match a fresh render for Bun 1\.4\.5/);
  } finally {
    f.cleanup();
  }
});

test("k282: a committed skill file that differs from the render fails (no lock entry)", () => {
  expectFail(fixture((co) => put(join(co, "skills/getty-bun-install/bootstrap/getty-bun.sh"), SH + "# edited\n")),
    "skills/getty-bun-install is not in the new lock");
});

test("k282: a committed file the render does not produce fails", () => {
  expectFail(fixture((co) => put(join(co, "skills/getty-bun-install/extra.txt"), "x\n")),
    "skills/getty-bun-install/extra.txt is committed but not part of the fresh render");
});

test("k282: a failed render fails even though the committed files stay", () => {
  expectFail(fixture((_co, src) => put(join(src, "skills/getty-bun-install/bootstrap/getty-bun.sh.njk"), "{{ vars.no_such_var }}\n")),
    "skills/getty-bun-install is not in the new lock");
});

test("k282: bootstrap/ copies that drifted from the rendered starters fail", () => {
  expectFail(fixture((co) => put(join(co, "bootstrap/getty-bun.ps1"), PS1 + "# edited\n")),
    "bootstrap/getty-bun.ps1 differs from skills/getty-bun-install/bootstrap/getty-bun.ps1");
});

test("k282: gettyBun.bunVersion other than the starters' and vars' pin fails", () => {
  expectFail(fixture((co) => put(join(co, "package.json"), JSON.stringify({ gettyBun: { contractVersion: 1, bunVersion: "1.4.6" } }))),
    'bootstrap/getty-bun.sh has no line "# version 1.4.6"');
});

test("k282: gettyBun outside the contract's schema fails", () => {
  expectFail(fixture((co) => put(join(co, "package.json"), JSON.stringify({ gettyBun: { contractVersion: 2, bunVersion: "1.4.5", extra: 1 } }))),
    "package.json gettyBun.contractVersion must be 1");
});

test("k282: a checkout with a project lock is refused", () => {
  const f = fixture();
  put(join(f.co, ".claude/skilletor.lock.json"), "{}\n");
  try {
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has a project lock; run on a fresh checkout/);
  } finally {
    rmSync(join(f.co, ".claude/skilletor.lock.json"));
    f.cleanup();
  }
});
