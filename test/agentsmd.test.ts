// The managed skilletor block in AGENTS.md (spec §14.8): parse, place, remove,
// refuse malformed markers and files it must not write through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import {
  BlockError, inspectAgentsMd, parseBlock, projectDocLimit, withBlock, type Section,
} from "../src/agentsmd.ts";

const A: Section = { name: "a", source: "s", text: "Rule A.\n" };
const B: Section = { name: "b", source: "t", text: "Applies when working with files matching: `x`.\n\nRule B.\n" };
const BLOCK_AB = [
  "<!-- skilletor:begin -->",
  "<!-- managed by skilletor — edits inside are overwritten -->",
  "",
  "<!-- skilletor:rule a source=s -->",
  "Rule A.",
  "",
  "<!-- skilletor:rule b source=t -->",
  "Applies when working with files matching: `x`.",
  "",
  "Rule B.",
  "",
  "<!-- skilletor:end -->",
].join("\n");

test("a missing file becomes just the block; an empty block means no file", () => {
  assert.equal(withBlock(null, [A, B]), BLOCK_AB + "\n");
  assert.equal(withBlock(null, []), null);
});

test("sections are written in the given order and parsed back exactly", () => {
  const parsed = parseBlock(withBlock(null, [A, B])!)!;
  assert.deepEqual([...parsed.sections.entries()], [["a", { source: "s", text: A.text }], ["b", { source: "t", text: B.text }]]);
  assert.equal(parseBlock("no block here\n"), null);
});

test("content outside the markers is never modified", () => {
  const user = "# My project\n\nOwn words.\n";
  const withIt = withBlock(user, [A])!;
  assert.ok(withIt.startsWith(user + "\n<!-- skilletor:begin -->"));
  const around = "top\n\n" + BLOCK_AB + "\n\nbottom\n";
  assert.equal(withBlock(around, [A]), "top\n\n" + withBlock(null, [A])!.trimEnd() + "\n\nbottom\n");
  // Removing the block restores the user's file.
  assert.equal(withBlock(withIt, []), user);
  assert.equal(withBlock(around, []), "top\n\n\nbottom\n"); // the block lines go, nothing else
});

test("a file left with only whitespace is deleted (null)", () => {
  assert.equal(withBlock("\n\n" + BLOCK_AB + "\n  \n", []), null);
});

test("unchanged input gives byte-identical output (no rewrite)", () => {
  const once = withBlock("# Mine\n", [A, B])!;
  assert.equal(withBlock(once, [A, B]), once);
});

test("malformed markers are a BlockError", () => {
  const begin = "<!-- skilletor:begin -->";
  const end = "<!-- skilletor:end -->";
  for (const bad of [
    `${begin}\nx\n`,
    `x\n${end}\n`,
    `${end}\n${begin}\n`,
    `${begin}\n${end}\n${begin}\n${end}\n`,
    `${begin}\n${begin}\n${end}\n`,
  ]) {
    assert.throws(() => parseBlock(bad), BlockError, bad);
    assert.throws(() => withBlock(bad, [A]), BlockError, bad);
  }
});

test("inspect refuses symlinks, directories and malformed markers; a missing file is fine", () => {
  const tmp = makeTmpDir();
  try {
    const f = join(tmp.dir, "AGENTS.md");
    assert.deepEqual(inspectAgentsMd(f), { ok: true, text: null, parsed: null });
    writeFileSync(join(tmp.dir, "CLAUDE.md"), "shared\n");
    symlinkSync("CLAUDE.md", f);
    const link = inspectAgentsMd(f);
    assert.equal(link.ok, false);
    assert.match(link.ok ? "" : link.reason, /symlink/);
    const d = join(tmp.dir, "dir", "AGENTS.md");
    mkdirSync(d, { recursive: true });
    assert.match((inspectAgentsMd(d) as { reason: string }).reason, /directory/);
    const m = join(tmp.dir, "m", "AGENTS.md");
    mkdirSync(join(tmp.dir, "m"));
    writeFileSync(m, "<!-- skilletor:begin -->\n");
    assert.match((inspectAgentsMd(m) as { reason: string }).reason, /malformed skilletor markers/);
    const okf = join(tmp.dir, "ok", "AGENTS.md");
    mkdirSync(join(tmp.dir, "ok"));
    writeFileSync(okf, withBlock("# x\n", [A])!);
    const ok = inspectAgentsMd(okf);
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.parsed?.sections.get("a")?.text, A.text);
  } finally {
    tmp.cleanup();
  }
});

test("project_doc_max_bytes: default 32768, top-level config.toml value wins, table keys do not", () => {
  const tmp = makeTmpDir();
  try {
    assert.equal(projectDocLimit(tmp.dir), 32768);
    writeFileSync(join(tmp.dir, "config.toml"), "model = \"x\"\nproject_doc_max_bytes = 1000\n[tui]\nproject_doc_max_bytes = 5\n");
    assert.equal(projectDocLimit(tmp.dir), 1000);
    writeFileSync(join(tmp.dir, "config.toml"), "[profiles.a]\nproject_doc_max_bytes = 5\n");
    assert.equal(projectDocLimit(tmp.dir), 32768);
  } finally {
    tmp.cleanup();
  }
});

test("a source name with spaces survives the marker", () => {
  const s: Section = { name: "r", source: "my team", text: "X.\n" };
  assert.equal(parseBlock(withBlock(null, [s])!)!.sections.get("r")?.source, "my team");
});
