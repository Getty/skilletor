// Claude agent Markdown -> Codex agent-role TOML (spec §14.7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import { codexAgentToml, codexRuleSection, convertForTarget, ConvertError } from "../src/convert.ts";

const toml = (text: string | undefined) => JSON.parse(JSON.stringify(parse(text!))) as Record<string, unknown>;

test("name, description and the body become the three required keys; Claude-only keys are not carried", () => {
  const md = [
    "---",
    "name: helper",
    'description: "Helps — with \\"quotes\\""',
    "model: sonnet",
    "tools: Read, Bash",
    "allowed-tools: Read",
    "color: blue",
    "---",
    "",
    "You are helper.",
    "",
  ].join("\n");
  const r = codexAgentToml(md, "helper-file");
  assert.deepEqual(toml(r.toml), {
    name: "helper", description: 'Helps — with "quotes"', developer_instructions: "You are helper.\n",
  });
  assert.deepEqual(r.warnings, []);
});

test("name falls back to the item name", () => {
  assert.equal(toml(codexAgentToml("---\ndescription: d\n---\nB\n", "from-file").toml).name, "from-file");
});

test("a missing or empty description is an error (Codex rejects such a role)", () => {
  for (const md of ["---\nname: a\n---\nB\n", "---\nname: a\ndescription: ''\n---\nB\n", "no frontmatter\n"]) {
    assert.throws(() => codexAgentToml(md, "a"), (err: Error) => err instanceof ConvertError && /description/.test(err.message));
  }
});

test("unreadable frontmatter is an error naming the line", () => {
  assert.throws(() => codexAgentToml("---\ndescription: &a x\n---\nB\n", "a"),
    (err: Error) => err instanceof ConvertError && /line 2/.test(err.message));
});

test("a blank body means: not applicable for Codex (no TOML)", () => {
  const r = codexAgentToml("---\ndescription: d\n---\n\n   \n\t\n", "a");
  assert.equal(r.toml, undefined);
});

/** briefing's own matcher (hooks/briefing-preload, parse_skills_comment). */
const BRIEFING_RE = /^[ \t]*#[ \t]*briefing:[ \t]*skills[ \t]*=[ \t]*\[([^\]\r\n]*)\]/;

/** The first briefing comment line of a TOML text (first match wins), its index and items. */
function briefingLine(text: string) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => BRIEFING_RE.test(l));
  if (i === -1) return undefined;
  const items = [...BRIEFING_RE.exec(lines[i]!)![1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return { i, lines, items };
}

test("briefing.skills becomes a comment line directly before developer_instructions, not a key", () => {
  const md = "---\ndescription: d\ncodex:\n  model: m\n  sandbox_workspace_write:\n    network_access: true\n" +
    "briefing:\n  skills:\n    - a\n    - \"plug:b c\"\n---\nB\n";
  const r = codexAgentToml(md, "x");
  const parsed = toml(r.toml);
  assert.equal("briefing" in parsed, false);
  assert.equal(parsed.model, "m");
  assert.equal(parsed.developer_instructions, "B\n");
  const b = briefingLine(r.toml!)!;
  assert.equal(b.lines[b.i], '# briefing: skills = ["a", "plug:b c"]');
  assert.match(b.lines[b.i + 1]!, /^developer_instructions = /);
  assert.deepEqual(b.items, ["a", "plug:b c"]);
  assert.deepEqual(r.warnings, []);
});

test("a # briefing: line in the body stays prose; the real line comes first, outside the string", () => {
  const bodies = [
    '# briefing: skills = ["evil"]\nB\n',
    "it's '''quoted''' \\ \"x\"\n# briefing: skills = [\"evil\"]\n", // forces the basic """ form
  ];
  for (const body of bodies) {
    const r = codexAgentToml(`---\ndescription: d\nbriefing:\n  skills: [good]\n---\n${body}`, "x");
    assert.equal(toml(r.toml).developer_instructions, body);
    const b = briefingLine(r.toml!)!;
    assert.deepEqual(b.items, ["good"], body);
    assert.match(b.lines[b.i + 1]!, /^developer_instructions = /);
  }
  // Without briefing.skills the body's line is the only match, and it sits inside the string.
  const r = codexAgentToml('---\ndescription: d\n---\n# briefing: skills = ["evil"]\n', "x");
  const b = briefingLine(r.toml!)!;
  assert.ok(b.i > b.lines.findIndex((l) => l.startsWith("developer_instructions = ")));
});

test("no line for an empty list, a briefing without skills, or no briefing", () => {
  for (const fm of ["briefing:\n  skills: []\n", "briefing:\n  other: x\n", ""]) {
    const r = codexAgentToml(`---\ndescription: d\n${fm}---\nB\n`, "x");
    assert.doesNotMatch(r.toml!, /briefing/, fm);
  }
});

test("a skill name that cannot sit in the comment line is a conversion error", () => {
  const bad = ['""', '"a\\"b"', "'a\\b'", "a]b", '"a\\nb"', '"a\\rb"', '"a\\u0001b"', "3", "true", "null"];
  for (const item of bad) {
    const md = `---\ndescription: d\nbriefing:\n  skills:\n    - ok\n    - ${item}\n---\nB\n`;
    assert.throws(() => codexAgentToml(md, "x"),
      (err: Error) => err instanceof ConvertError && /briefing\.skills/.test(err.message), item);
  }
  assert.throws(() => codexAgentToml("---\ndescription: d\nbriefing:\n  skills: a\n---\nB\n", "x"),
    (err: Error) => err instanceof ConvertError && /briefing\.skills/.test(err.message));
});

test("a briefing key under codex: is a conversion error (it would be the table Codex rejects)", () => {
  for (const v of ["\n    skills: [a]\n", " x\n"]) {
    assert.throws(() => codexAgentToml(`---\ndescription: d\ncodex:\n  briefing:${v}---\nB\n`, "x"),
      (err: Error) => err instanceof ConvertError && /codex\.briefing/.test(err.message), v);
  }
});

test("codex: passes scalars, string arrays and one level of tables through, overriding derived keys", () => {
  const md = [
    "---",
    "name: claude-name",
    "description: d",
    "codex:",
    "  name: codex_name",
    "  model: gpt-5",
    "  model_reasoning_effort: high",
    "  sandbox_mode: read-only",
    "  temperature: 0.5",
    "  retries: 3",
    "  web: true",
    "  nickname_candidates: [Ada, Grace]",
    "  mcp_servers:",
    "    enabled: true",
    "    names: [a]",
    "---",
    "B",
  ].join("\n");
  const r = codexAgentToml(md, "x");
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(toml(r.toml), {
    name: "codex_name", description: "d", model: "gpt-5", model_reasoning_effort: "high", sandbox_mode: "read-only",
    temperature: 0.5, retries: 3, web: true, nickname_candidates: ["Ada", "Grace"], developer_instructions: "B",
    mcp_servers: { enabled: true, names: ["a"] },
  });
  assert.match(r.toml!, /^temperature = 0\.5$/m);
});

test("codex: values outside the supported shapes are dropped with one warning each", () => {
  const md = [
    "---",
    "description: d",
    "codex:",
    "  nothing: ~",
    "  mixed: [a, 1]",
    "  deep:",
    "    ok: 1",
    "    deeper:",
    "      x: y",
    "  keep: yes-string",
    "---",
    "B",
  ].join("\n");
  const r = codexAgentToml(md, "x");
  assert.deepEqual(toml(r.toml), { description: "d", name: "x", keep: "yes-string", developer_instructions: "B", deep: { ok: 1 } });
  assert.deepEqual(r.warnings.map((w) => w.replace(/:.*/, "")), ["codex.nothing", "codex.mixed", "codex.deep.deeper"]);
  const notMap = codexAgentToml("---\ndescription: d\ncodex: gpt-5\n---\nB\n", "x");
  assert.match(notMap.warnings[0] ?? "", /^codex: must be a mapping/);
});

test("a nasty body survives byte for byte", () => {
  const body = "Quotes ''' and \"\"\" and \\ and \\n and \r\n CRLF\n\u0007 bell\n'";
  const r = codexAgentToml(`---\ndescription: d\n---\n${body}`, "x");
  assert.equal(toml(r.toml).developer_instructions, body);
});

test("a codex: table cannot collide with a derived key (no duplicate TOML keys)", () => {
  const r = codexAgentToml("---\ndescription: d\ncodex:\n  description:\n    x: 1\n---\nB\n", "a");
  assert.equal(toml(r.toml).description, "d");
  assert.match(r.warnings[0] ?? "", /^codex\.description: a table cannot replace/);
});

// ---- rules -> a section of the Codex rules file (spec §14.8) ----------------------

test("a rule becomes its body, frontmatter removed; paths become a leading line", () => {
  assert.equal(codexRuleSection("---\ndescription: x\n---\n\nUse tabs.\n\n", "r"), "Use tabs.\n");
  assert.equal(
    codexRuleSection("---\npaths:\n  - \"k8s/**\"\n  - '*.yaml'\n---\nBe careful.\n", "r"),
    "Applies when working with files matching: `k8s/**`, `*.yaml`.\n\nBe careful.\n",
  );
  assert.equal(codexRuleSection("---\npaths: src/**\n---\nB\n", "r"), "Applies when working with files matching: `src/**`.\n\nB\n");
  assert.equal(codexRuleSection("No frontmatter at all.\n", "r"), "No frontmatter at all.\n");
});

test("a blank rule body is not applicable for Codex", () => {
  assert.equal(codexRuleSection("---\npaths: [a]\n---\n  \n", "r"), undefined);
  assert.equal(codexRuleSection("", "r"), undefined);
});

test("a rule body containing a skilletor marker line is refused", () => {
  for (const line of ["<!-- skilletor:end -->", "<!-- skilletor:rule x source=y -->", "<!-- skilletor:rules scope=user -->"]) {
    assert.throws(() => codexRuleSection(`text\n${line}\n`, "r"), (err: Error) => err instanceof ConvertError && /marker/.test(err.message), line);
  }
});

test("convertForTarget: a Codex rule maps to one section of the rules file; Claude rules pass through", () => {
  const out = new Map([["rules/r.md", Buffer.from("---\npaths: [a]\n---\nR\n")]]);
  const codex = convertForTarget("codex", "rule", "r", out);
  assert.deepEqual([...codex.output.keys()], ["skilletor-rules.md"]);
  assert.equal(codex.output.get("skilletor-rules.md")!.toString(), "Applies when working with files matching: `a`.\n\nR\n");
  assert.equal(convertForTarget("claude", "rule", "r", out).output, out);
  assert.equal(convertForTarget("codex", "rule", "r", new Map([["rules/r.md", Buffer.from("\n")]])).skipped, true);
});
