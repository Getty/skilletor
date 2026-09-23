// Plugin manifests (spec §10, §14.5): one name and one version across
// package.json, the Claude manifest and the Codex manifest; referenced paths exist.
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

test("package.json and both plugin manifests carry the same name and version", () => {
  assert.equal(claude.name, "skilletor");
  assert.equal(codex.name, "skilletor"); // must equal the marketplace entry name
  assert.equal(claude.version, pkg.version);
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
  const hooks = json("hooks/hooks.json").hooks as Record<string, { hooks: { command: string }[] }[]>;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const groups of Object.values(hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.match(h.command, /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/skilletor hook /);
  }
});
