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

test("hook commands go through the plugin root the harness sets (Codex sets CLAUDE_PLUGIN_ROOT too)", () => {
  // Claude Code's in exec form: on Windows it starts bin/skilletor.exe (winlaunch) for
  // bin/skilletor, without Git Bash; Linux and macOS start the sh launcher as before.
  const hooks = json("hooks/hooks.json").hooks as Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
  assert.deepEqual(Object.keys(hooks).sort(), ["CwdChanged", "SessionStart", "UserPromptSubmit"]);
  for (const groups of Object.values(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(h.command, "${CLAUDE_PLUGIN_ROOT}/bin/skilletor");
        assert.equal(h.args?.[0], "hook");
      }
    }
  }
  const codexHooks = json("hooks/codex-hooks.json").hooks as Record<string, { hooks: { command: string }[] }[]>;
  for (const groups of Object.values(codexHooks)) {
    for (const g of groups) for (const h of g.hooks) assert.match(h.command, /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/skilletor hook /);
  }
});

test("on Windows bin/skilletor.exe runs the bundle the sh launcher runs", () => {
  assert.ok(existsSync(join(root, "bin", "skilletor.exe")));
  assert.match(readFileSync(join(root, "bin", "skilletor"), "utf8"), /^# winlaunch: run node \{root\}\/dist\/skilletor\.js$/m);
});

// k50 (spec §14.5, §14.8): the Codex plugin has its own hooks file, the Claude one is untouched.
// k147 (spec §8): CwdChanged is Claude Code's alone – Codex has no such event.
// k149 (spec §8, §14.5): under Codex the prompt hook syncs a checkout the session moved into,
// awaited, so it gets the 30 s SessionStart and CwdChanged have; Claude Code's stays at 10 s.
test("codex-hooks.json = hooks.json without CwdChanged, with --harness codex, matcher startup|resume|clear, no context limit, a prompt hook of 30 s", () => {
  assert.equal(codex.hooks, "./hooks/codex-hooks.json");
  assert.equal(claude.hooks ?? "./hooks/hooks.json", "./hooks/hooks.json");
  type Groups = Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
  const forClaude = json("hooks/hooks.json").hooks as Groups;
  const forCodex = json("hooks/codex-hooks.json").hooks as Groups;
  assert.equal(forClaude.SessionStart![0]!.matcher, "startup|resume");
  assert.equal(JSON.stringify(forClaude).includes("additionalContextLimit"), false);
  assert.equal(JSON.stringify(forClaude).includes("--harness"), false);
  // Derive the expected Codex file from the Claude one: Codex reads no args, so they go
  // back into the command text.
  const expected = JSON.parse(JSON.stringify(forClaude)) as Groups;
  assert.equal(forClaude.CwdChanged?.[0]?.hooks[0]?.timeout, forClaude.SessionStart![0]!.hooks[0]!.timeout);
  delete expected.CwdChanged;
  for (const groups of Object.values(expected)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        h.command = [h.command as string, ...((h.args as string[] | undefined) ?? []), "--harness", "codex"].join(" ");
        delete h.args;
      }
    }
  }
  expected.SessionStart![0]!.matcher = "startup|resume|clear";
  expected.SessionStart![0]!.hooks[0]!.additionalContextLimit = 0;
  assert.equal(forClaude.UserPromptSubmit![0]!.hooks[0]!.timeout, 10);
  expected.UserPromptSubmit![0]!.hooks[0]!.timeout = forClaude.SessionStart![0]!.hooks[0]!.timeout;
  assert.deepEqual(forCodex, expected);
});
