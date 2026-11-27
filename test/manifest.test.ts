// Plugin manifests (spec §10, §14.5): one name across the manifests, one version across
// package.json and the Codex manifest, none in the Claude manifest (Claude Code takes it from the commit); referenced paths exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;

const pkg = json("package.json");
const claude = json(".claude-plugin/plugin.json");
const codex = json(".codex-plugin/plugin.json");

test("package.json and the Codex manifest carry one version, the Claude manifest none; names agree", () => {
  assert.equal(claude.name, "skilletor");
  assert.equal(codex.name, "skilletor"); // must equal the marketplace entry name
  assert.equal("version" in claude, false);
  assert.equal(codex.version, pkg.version);
});

test("every path a manifest references exists", () => {
  for (const [label, m] of [["claude", claude], ["codex", codex]] as const) {
    for (const key of ["skills", "hooks"]) {
      const rel = m[key];
      assert.equal(typeof rel, "string", `${label} manifest: ${key}`);
      assert.ok(existsSync(join(root, rel as string)), `${label} manifest: ${key} -> ${rel} missing`);
    }
  }
});

const STARTER = "bootstrap/getty-bun.sh";
const POWERSHELL = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File";

// k281: every hook starts the getty-bun starter with the bundle, the event and the host as
// positional arguments (entry arguments never begin with `-`), and allows 600 s: the first hook
// after an install or a Bun bump installs Bun, behind the starter's lock wait.
test("hook commands run the getty-bun starter from the plugin root the harness sets", () => {
  const hooks = json("hooks/hooks.json").hooks as Record<string, { hooks: { command: string; args?: string[]; timeout: number }[] }[]>;
  assert.deepEqual(Object.keys(hooks).sort(), ["CwdChanged", "PostToolUse", "SessionStart", "UserPromptSubmit"]);
  for (const groups of Object.values(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        // Exec form: no shell, so no quoting; `sh` from PATH.
        assert.equal(h.command, "sh");
        assert.deepEqual(h.args?.slice(0, 4), [`\${CLAUDE_PLUGIN_ROOT}/${STARTER}`, "run", "dist/skilletor.js", "hook"]);
        assert.equal(h.args?.[5], "claude-code");
        assert.equal(h.args?.length, 6);
        assert.equal(h.timeout, 600);
      }
    }
  }
  assert.ok(existsSync(join(root, STARTER)));
  assert.ok(existsSync(join(root, "bootstrap", "getty-bun.ps1")));
  assert.equal(JSON.stringify(hooks).includes("--harness"), false);
});

// The starters are committed copies of the getty-bun-install render (k286), never edited here.
test("bootstrap/ holds the rendered starters unchanged, and their pin is package.json's", () => {
  for (const file of ["getty-bun.sh", "getty-bun.ps1"]) {
    assert.ok(readFileSync(join(root, "bootstrap", file)).equals(
      readFileSync(join(root, "skills", "getty-bun-install", "bootstrap", file))), file);
  }
  const bun = (pkg.gettyBun as { bunVersion: string }).bunVersion;
  assert.match(readFileSync(join(root, STARTER), "utf8"), new RegExp(`^# version ${bun.replace(/\./g, "\\.")}$`, "m"));
});

// k50 (spec §14.5, §14.8): the Codex plugin has its own hooks file, the Claude one is untouched.
// k147 (spec §8): CwdChanged and PostToolUse are Claude Code's alone – Codex has no CwdChanged,
// and its Bash cwd never moves (k149). PostToolUse, the awaited move hook, runs on a Bash call
// with a `cd` only. k281: Codex runs a string in its session shell, so the plugin root is quoted
// (k244), and Windows gets the PowerShell starter in commandWindows.
test("codex-hooks.json = hooks.json without CwdChanged and PostToolUse, host codex, matcher startup|resume|clear, no context limit", () => {
  assert.equal(codex.hooks, "./hooks/codex-hooks.json");
  assert.equal(claude.hooks ?? "./hooks/hooks.json", "./hooks/hooks.json");
  type Groups = Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
  const forClaude = json("hooks/hooks.json").hooks as Groups;
  const forCodex = json("hooks/codex-hooks.json").hooks as Groups;
  assert.equal(forClaude.SessionStart![0]!.matcher, "startup|resume");
  assert.equal(JSON.stringify(forClaude).includes("additionalContextLimit"), false);
  assert.deepEqual(forClaude.PostToolUse, [{
    matcher: "Bash",
    hooks: [{
      type: "command", if: "Bash(cd *)", command: "sh",
      args: [`\${CLAUDE_PLUGIN_ROOT}/${STARTER}`, "run", "dist/skilletor.js", "hook", "post-tool-use", "claude-code"],
      timeout: 600,
    }],
  }]);
  // Derive the expected Codex file from the Claude one: Codex reads no args, so they go into
  // the command text, the root quoted, the host codex.
  const expected = JSON.parse(JSON.stringify(forClaude)) as Groups;
  delete expected.CwdChanged;
  delete expected.PostToolUse;
  for (const groups of Object.values(expected)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const event = (h.args as string[])[4];
        h.command = `sh "\${PLUGIN_ROOT}/${STARTER}" run dist/skilletor.js hook ${event} codex`;
        h.commandWindows = `${POWERSHELL} "\${PLUGIN_ROOT}\\bootstrap\\getty-bun.ps1" run dist/skilletor.js hook ${event} codex`;
        delete h.args;
      }
    }
  }
  expected.SessionStart![0]!.matcher = "startup|resume|clear";
  expected.SessionStart![0]!.hooks[0]!.additionalContextLimit = 0;
  assert.deepEqual(forCodex, expected);
});
