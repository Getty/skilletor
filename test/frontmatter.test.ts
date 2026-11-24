// Agent frontmatter reader (spec §14.7): the YAML subset agent files use,
// and a clear error for anything outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrontmatterError, parseYamlDocument, splitFrontmatter, YamlFloat } from "../src/frontmatter.ts";

const fm = (yaml: string, body = "BODY\n") => splitFrontmatter(`---\n${yaml}\n---\n${body}`);

test("no frontmatter: empty data, the whole text is the body", () => {
  assert.deepEqual(splitFrontmatter("just text\n"), { data: {}, body: "just text\n" });
  assert.deepEqual(splitFrontmatter("---\n---\nB\n"), { data: {}, body: "B\n" });
});

test("the body starts after the closing fence; leading blank lines are dropped, the rest is verbatim", () => {
  assert.equal(fm("name: a", "\n\n  indented\n\ntrailing  \n\n").body, "  indented\n\ntrailing  \n\n");
  assert.equal(splitFrontmatter("---\r\nname: a\r\n---\r\nB\r\n").body, "B\r\n");
});

test("scalars: plain, quoted, typed, with comments", () => {
  const { data } = fm([
    "name: my-agent",
    'description: "Audit — says \\"hi\\"\\n and \\u00e9"',
    "single: 'it''s # not a comment'",
    "plain: value # a comment",
    "colon: a: b",
    "url: https://example.com/x",
    "int: 42",
    "neg: -3",
    "float: 1.0",
    "yes: true",
    "no: False",
    "nothing: ~",
    "empty:",
    "# full-line comment",
  ].join("\n"));
  assert.equal(data.name, "my-agent");
  assert.equal(data.description, 'Audit — says "hi"\n and é');
  assert.equal(data.single, "it's # not a comment");
  assert.equal(data.plain, "value");
  assert.equal(data.colon, "a: b");
  assert.equal(data.url, "https://example.com/x");
  assert.equal(data.int, 42);
  assert.equal(data.neg, -3);
  assert.deepEqual(data.float, new YamlFloat(1));
  assert.equal(data.yes, true);
  assert.equal(data.no, false);
  assert.equal(data.nothing, null);
  assert.equal(data.empty, null);
});

test("block scalars: literal and folded, with chomping", () => {
  const { data } = fm([
    "lit: |",
    "  line one",
    "    indented",
    "",
    "  line three",
    "fold: >-",
    "  folded",
    "  together",
    "keep: |+",
    "  k",
    "",
    "after: x",
  ].join("\n"));
  assert.equal(data.lit, "line one\n  indented\n\nline three\n");
  assert.equal(data.fold, "folded together");
  assert.equal(data.keep, "k\n\n");
  assert.equal(data.after, "x");
});

test("multi-line plain and quoted scalars fold with spaces", () => {
  const { data } = fm(['description: a long', "  description here", 'q: "two', '  lines"'].join("\n"));
  assert.equal(data.description, "a long description here");
  assert.equal(data.q, "two lines");
});

test("sequences and nested mappings (the skills and codex shapes)", () => {
  const { data } = fm([
    "tools: Read, Bash",
    "skills:",
    "  - skilletor-core",
    "  - 'kanban: karr'",
    "codex:",
    "  model: gpt-5",
    "  model_reasoning_effort: high",
    "  nickname_candidates: [Ada, \"B, C\"]",
    "  features:",
    "    web: true",
    "list_same_indent:",
    "- a",
    "- b",
    "flow_map: {a: 1, b: two}",
  ].join("\n"));
  assert.equal(data.tools, "Read, Bash");
  assert.deepEqual(data.skills, ["skilletor-core", "kanban: karr"]);
  assert.deepEqual(data.codex, {
    model: "gpt-5", model_reasoning_effort: "high", nickname_candidates: ["Ada", "B, C"], features: { web: true },
  });
  assert.deepEqual(data.list_same_indent, ["a", "b"]);
  assert.deepEqual(data.flow_map, { a: 1, b: "two" });
});

test("block mappings keep __proto__ as own data without changing their prototype", () => {
  const { data } = fm("__proto__:\n  description: nested\ndescription: top");
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.equal(Object.hasOwn(data, "__proto__"), true);
  assert.deepEqual(data.__proto__, { description: "nested" });
  assert.equal(Object.hasOwn(data, "description"), true);
  assert.equal(data.description, "top");
});

test("flow mappings keep prototype-named scalar keys as own data", () => {
  const { data } = fm("flow: {__proto__: kept, constructor: ctor, toString: text}");
  const flow = data.flow as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(flow), Object.prototype);
  for (const [key, value] of [["__proto__", "kept"], ["constructor", "ctor"], ["toString", "text"]]) {
    assert.equal(Object.hasOwn(flow, key), true, key);
    assert.equal(flow[key], value, key);
  }
});

test("outside the subset: a FrontmatterError naming the line", () => {
  for (const bad of [
    "a: &anchor x",
    "a: *alias",
    "a: !tag x",
    "list:\n  - key: value",
    "a: [x, [nested]]",
    "a: \"unterminated",
    "a: b\na: c",
    "  indented: first",
    "not a mapping line",
  ]) {
    assert.throws(() => fm(bad), (err: Error) => err instanceof FrontmatterError && /line \d+/.test(err.message), bad);
  }
});

// k48: bundle files (spec §15.1) are whole YAML documents read with the same subset.
test("parseYamlDocument reads a whole file and numbers lines from 1", () => {
  assert.deepEqual(parseYamlDocument("description: D\nskills: [perl-*, testing]\nvars:\n  k: \"5.40\"\n"), {
    description: "D", skills: ["perl-*", "testing"], vars: { k: "5.40" },
  });
  assert.throws(() => parseYamlDocument("a: 1\nb: &x 2\n"), /^FrontmatterError: line 2: anchors/);
});
