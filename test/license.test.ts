// One license across the plugin and the Perl dist: every manifest names Artistic-2.0 (SPDX),
// dist.ini the same license by its Software::License name, and LICENSE holds its text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;

test("every manifest names the Artistic License 2.0", () => {
  for (const rel of ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    assert.equal(json(rel).license, "Artistic-2.0", rel);
  }
  assert.equal(/^license: (.+)$/m.exec(read("hermes/skilletor/plugin.yaml"))?.[1], "Artistic-2.0", "hermes/skilletor/plugin.yaml");
});

test("the Perl dist and LICENSE carry the same license", () => {
  assert.match(read("dist.ini"), /^license = Artistic_2_0$/m);
  assert.equal(read("LICENSE").trimStart().split("\n")[0], "The Artistic License 2.0");
});
