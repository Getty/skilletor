// Codex rules (spec §14.8): the rules file skilletor owns, the pointer block in
// AGENTS.md (parse, place, remove, refuse malformed markers and files it must not
// write through), and the read-only config.toml checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import {
  BlockError, codexHookTrusted, inspectAgentsMd, parseBlock, parseRulesFile, pointerLines, projectDocLimit, rulesFileText,
  withBlock, type Section,
} from "../src/agentsmd.ts";

const A: Section = { name: "a", source: "s", text: "Rule A.\n" };
const B: Section = { name: "b", source: "t", text: "Applies when working with files matching: `x`.\n\nRule B.\n" };

const POINTER = pointerLines("project", ".codex/skilletor-rules.md");
const BLOCK = [
  "<!-- skilletor:begin -->",
  "<!-- managed by skilletor — edits inside are overwritten -->",
  "Additional rules for this project are managed by skilletor. They are normally provided at",
  "session start as a developer message beginning with `<!-- skilletor:rules`. If that message",
  "is not in your context (for example after context compaction), read",
  "`.codex/skilletor-rules.md` before you start a task, and follow it.",
  "<!-- skilletor:end -->",
].join("\n");

// ---- rules file -------------------------------------------------------------------

test("rules file: header, managed line, one section per rule in the given order", () => {
  assert.equal(rulesFileText("project", [A, B]), [
    "<!-- skilletor:rules scope=project -->",
    "<!-- managed by skilletor — edits are overwritten; change the rule in its source -->",
    "",
    "<!-- skilletor:rule a source=s -->",
    "Rule A.",
    "",
    "<!-- skilletor:rule b source=t -->",
    "Applies when working with files matching: `x`.",
    "",
    "Rule B.",
  ].join("\n") + "\n");
  assert.match(rulesFileText("user", [A])!, /^<!-- skilletor:rules scope=user -->\n/);
  assert.equal(rulesFileText("user", []), null);
});

test("rules file: sections parse back exactly, a source with spaces survives", () => {
  const s: Section = { name: "r", source: "my team", text: "X.\n" };
  const parsed = parseRulesFile(rulesFileText("project", [A, B, s])!);
  assert.deepEqual([...parsed.entries()], [
    ["a", { source: "s", text: A.text }], ["b", { source: "t", text: B.text }], ["r", { source: "my team", text: "X.\n" }],
  ]);
  assert.equal(parseRulesFile("nothing of ours\n").size, 0);
});

// ---- pointer block in AGENTS.md -----------------------------------------------------

test("pointer text: project names the relative file, user says all projects and the absolute path", () => {
  assert.deepEqual([...POINTER], BLOCK.split("\n").slice(1, -1));
  const user = pointerLines("user", "/h/.codex/skilletor-rules.md").join("\n");
  assert.match(user, /^.*\nAdditional rules for all projects are managed by skilletor\./);
  assert.match(user, /`\/h\/\.codex\/skilletor-rules\.md` before you start a task, and follow it\.$/);
});

test("a missing file becomes just the block; no block means no file", () => {
  assert.equal(withBlock(null, POINTER), BLOCK + "\n");
  assert.equal(withBlock(null, null), null);
});

test("content outside the markers is never modified", () => {
  const user = "# My project\n\nOwn words.\n";
  const withIt = withBlock(user, POINTER)!;
  assert.equal(withIt, user + "\n" + BLOCK + "\n");
  const around = "top\n\n" + BLOCK + "\n\nbottom\n";
  assert.equal(withBlock(around, POINTER), around);
  // Removing the block restores the user's file.
  assert.equal(withBlock(withIt, null), user);
  assert.equal(withBlock(around, null), "top\n\n\nbottom\n"); // the block lines go, nothing else
});

test("a file left with only whitespace is deleted (null)", () => {
  assert.equal(withBlock("\n\n" + BLOCK + "\n  \n", null), null);
});

test("the old rules block (sections) is parsed for migration and replaced by the pointer", () => {
  const old = [
    "# Mine", "", "<!-- skilletor:begin -->", "<!-- managed by skilletor — edits inside are overwritten -->", "",
    "<!-- skilletor:rule a source=s -->", "Rule A.", "", "<!-- skilletor:end -->", "",
  ].join("\n");
  assert.deepEqual([...parseBlock(old)!.sections.entries()], [["a", { source: "s", text: "Rule A.\n" }]]);
  assert.equal(withBlock(old, POINTER), "# Mine\n\n" + BLOCK + "\n");
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
    assert.throws(() => withBlock(bad, POINTER), BlockError, bad);
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
    writeFileSync(okf, withBlock("# x\n", POINTER)!);
    const ok = inspectAgentsMd(okf);
    assert.equal(ok.ok, true);
    assert.ok(ok.ok && ok.parsed !== null);
  } finally {
    tmp.cleanup();
  }
});

// ---- config.toml -------------------------------------------------------------------

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

test("hook trust: a trusted_hash for skilletor's session_start handler, in any marketplace", () => {
  const tmp = makeTmpDir();
  try {
    const cfg = (text: string) => writeFileSync(join(tmp.dir, "config.toml"), text);
    assert.equal(codexHookTrusted(tmp.dir), false); // no config.toml
    const key = "skilletor@getty:hooks/codex-hooks.json:session_start:0:0";
    cfg(`model = "x"\n\n[hooks.state."${key}"]\ntrusted_hash = "sha256:ab"\n`);
    assert.equal(codexHookTrusted(tmp.dir), true);
    cfg(`[hooks.state."skilletor@other:hooks/codex-hooks.json:session_start:0:0"]\nenabled = true\ntrusted_hash = 'sha256:ab'\n`);
    assert.equal(codexHookTrusted(tmp.dir), true);
    // Wrong event, wrong plugin, no hash, or the hash in the next table: not trusted.
    cfg(`[hooks.state."skilletor@getty:hooks/codex-hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:ab"\n`);
    assert.equal(codexHookTrusted(tmp.dir), false);
    cfg(`[hooks.state."other@getty:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:ab"\n`);
    assert.equal(codexHookTrusted(tmp.dir), false);
    cfg(`[hooks.state."${key}"]\nenabled = true\n[tui]\ntrusted_hash = "sha256:ab"\n`);
    assert.equal(codexHookTrusted(tmp.dir), false);
    // Dotted and inline forms under [hooks.state] count too.
    cfg(`[hooks.state]\n"${key}".trusted_hash = "sha256:ab"\n`);
    assert.equal(codexHookTrusted(tmp.dir), true);
    cfg(`[hooks.state]\n"${key}" = { trusted_hash = "sha256:ab" }\n`);
    assert.equal(codexHookTrusted(tmp.dir), true);
  } finally {
    tmp.cleanup();
  }
});
