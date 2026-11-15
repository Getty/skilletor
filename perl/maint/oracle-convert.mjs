// Regenerates t/data/convert-oracle.json: what the reference's codexAgentToml,
// codexRuleSection and convertForTarget make of each input, or the error they throw
// (class name and message). Files go in and come out as hex bytes. Run from perl/:
//   node maint/oracle-convert.mjs > t/data/convert-oracle.json
import { codexAgentToml, codexRuleSection, convertForTarget } from "../../src/convert.ts";

/** An agent or rule file: frontmatter lines, then the body. */
const md = (fm, body = "B\n") => `---\n${fm.join("\n")}${fm.length ? "\n" : ""}---\n${body}`;
const D = "description: d";

const NASTY_BODIES = [
  "Quotes ''' and \"\"\" and \\ and \\n and \r\n CRLF\n\u0007 bell\n'",
  "plain\n", "no final newline", "\n\nafter blank lines\n", "trailing spaces   \n\n\n", "ends with a quote'",
  "ends with two quotes''\n", "has ''' inside\n", 'has """ inside\n', "C:\\path\\to\\file\n", "a\\\n  b\n",
  "crlf\r\nlines\r\n", "bare \r cr\n", "tab\tindented\n\tline\n", "nul \u0000 and esc \u001b and del \u007f\n",
  "unicode — ümlaut 日本語 🎉 \u2028 \u2029 \u0085\n", "# briefing: skills = [\"evil\"]\nB\n",
  "it's '''quoted''' \\ \"x\"\n# briefing: skills = [\"evil\"]\n", "---\nlooks like frontmatter\n---\n",
  "[table]\nkey = \"value\"\n", "\u00a0nbsp-led\n", "x\u0085", "\ufeffbom-led\n", "'", "'''", '"""', "\\",
];

const agents = [
  // test/convert.test.ts
  [["name: helper", 'description: "Helps — with \\"quotes\\""', "model: sonnet", "tools: Read, Bash", "allowed-tools: Read",
    "color: blue"], "\nYou are helper.\n", "helper-file"],
  [[D], "B\n", "from-file"],
  [["name: a"], "B\n", "a"],
  [["name: a", "description: ''"], "B\n", "a"],
  ["no frontmatter\n", "a"],
  [["description: &a x"], "B\n", "a"],
  [[D], "\n   \n\t\n", "a"],
  [[D, "codex:", "  model: m", "  sandbox_workspace_write:", "    network_access: true", "briefing:", "  skills:", "    - a",
    '    - "plug:b c"'], "B\n"],
  [[D, "briefing:", "  skills: [good]"], '# briefing: skills = ["evil"]\nB\n'],
  [[D, "briefing:", "  skills: [good]"], "it's '''quoted''' \\ \"x\"\n# briefing: skills = [\"evil\"]\n"],
  [[D], '# briefing: skills = ["evil"]\n'],
  [[D, "briefing:", "  skills: []"]],
  [[D, "briefing:", "  other: x"]],
  ...['""', '"a\\"b"', "'a\\b'", "a]b", '"a\\nb"', '"a\\rb"', '"a\\u0001b"', "3", "true", "null"]
    .map((item) => [[D, "briefing:", "  skills:", "    - ok", `    - ${item}`]]),
  [[D, "briefing:", "  skills: a"]],
  [[D, "codex:", "  briefing:", "    skills: [a]"]],
  [[D, "codex:", "  briefing: x"]],
  [["name: claude-name", D, "codex:", "  name: codex_name", "  model: gpt-5", "  model_reasoning_effort: high",
    "  sandbox_mode: read-only", "  temperature: 0.5", "  retries: 3", "  web: true", "  nickname_candidates: [Ada, Grace]",
    "  mcp_servers:", "    enabled: true", "    names: [a]"], "B"],
  [[D, "codex:", "  nothing: ~", "  mixed: [a, 1]", "  deep:", "    ok: 1", "    deeper:", "      x: y", "  keep: yes-string"], "B"],
  [[D, "codex: gpt-5"]],
  [[D], "Quotes ''' and \"\"\" and \\ and \\n and \r\n CRLF\n\u0007 bell\n'"],
  [[D, "codex:", "  description:", "    x: 1"]],

  // name and description: what counts as text
  ...["name: 0", "name: ''", "name: '  '", "name: true", "name: false", "name: 1.5", "name: [a]", "name: {a: b}",
    "name: null", "name: ~", "name:", "name: -0", "name: 007", "name: 9007199254740993", "name: 名前",
    'name: "tab\\there"', 'name: "nl\\nx"', 'name: "\\u2028"', "name: \"\\uFEFF\"", "name: 1e999"]
    .map((n) => [[n, D]]),
  [[D], "B\n", ""],
  [["name: ''", D], "B\n", ""],
  [["name: ' '", D], "B\n", "x"],
  [[D], "B\n", "  "],
  ...["description: 0", "description: true", "description: 1.5", "description: '  '", "description: [a]",
    "description: {a: b}", "description: null", "description: \"\\u00a0\"", "description: \"\\u0085\"",
    "description: |\n  line one\n  line two\n", "description: >\n  folded\n  text\n\n  para\n",
    "description: \"日本語 — ümlaut 🎉 \\u2028 \\u0085 \\uFEFF\"", 'description: "ctl \\x01 \\x7f \\e \\0 \\t \\r end"',
    'description: "q\\" b\\\\ s\' end"', "description: 'it''s'", "description: a # comment", "description: \"#not\"",
    "description: multi\n  word\n  continued"]
    .map((d) => [[d.replace(/\n$/, "")]]),

  // codex scalars: floats, integers, strings needing escapes, empty and odd lists
  [[D, "codex:", ...["0.5", "1.0", "1e3", "1E5", "1e21", "1.5e-7", "-0.0", ".5", "5.", "+1.5", "100.0", "0.1",
    "123456789.123456789", "1e-7", "-1e-6", "2.5e+3", "0.0", "1e300"].map((f, i) => `  f${i}: ${f}`)]],
  [[D, "codex:", "  inf: 1e999"]],
  [[D, "codex:", "  t:", "    ninf: -1e999"]],
  [[D, "codex:", ...["0", "-0", "+5", "007", "9007199254740991", "-9007199254740991", "9007199254740992", "12345678901234567890",
    "-1"].map((n, i) => `  i${i}: ${n}`)]],
  [[D, "codex:", '  a: "a\\"b"', "  b: 'it''s'", '  c: "back\\\\slash"', '  d: "tab\\there"', '  e: "nl\\nx"',
    '  f: "cr\\rx"', '  g: "\\u0000"', '  h: "\\x7f"', '  i: "\\u2028 \\u0085 \\u00e9"', "  j: 日本語 🎉", "  k: ''",
    '  l: "\\U0001F600"', "  m: |\n    block\n    scalar", "  n: '#x'"]],
  [[D, "codex:", "  tools: []", "  one: [x]", "  empty_str: ['']", '  esc: [ "a\\"b", \'c\\d\', "\\u00e9", "x\\ny" ]',
    "  block:", "    - a", "    - 'b c'", "  t:", "    e: []", "    l: [p, q]"]],
  [[D, "codex:", "  floats: [1.5]", "  bools: [true]", "  nulls: [null]", "  t:", "    m: [a, 2]"]],
  // codex keys needing quotes, index keys (JS orders them first)
  [[D, "codex:", '  "a b": x', '  "a.b": y', '  "": z', "  é: e", '  "1": one', '  "-x": dash', '  "0":', "    t: 1",
    "  z: last", '  "9": nine']],
  [[D, "codex:", '  "a.b":', "    c: d", '  "q\\"t":', '    "k k": v']],
  // codex tables
  [[D, "codex:", "  empty: {}", "  allgone:", "    a: null", "    b: [1]", "  flow: {x: 1, y: two, z: 1.5}",
    "  mixed:", "    s: 's \"q\"'", "    i: -3", "    f: 2.0", "    b: false", "    l: [x]", "    n: ~", "    m:", "      deep: 1"]],
  // developer_instructions from codex
  [[D, "codex:", "  developer_instructions: from codex"], "the body\n"],
  [[D, "codex:", "  developer_instructions: |\n    multi\n    line"], "the body\n"],
  [[D, "codex:", "  developer_instructions: ''"], "the body\n"],
  [[D, "codex:", "  developer_instructions: '  '"], "the body\n"],
  [[D, "codex:", "  developer_instructions: 3"], "the body\n"],
  [[D, "codex:", "  developer_instructions: [a]"], "the body\n"],
  [[D, "codex:", "  developer_instructions: 1.5"], "the body\n"],
  [[D, "codex:", "  developer_instructions: ~"], "the body\n"],
  [[D, "codex:", "  developer_instructions:", "    x: 1"], "the body\n"],
  [[D, "codex:", "  developer_instructions: from codex"], "\n  \n"],
  // codex name and description overrides
  [[D, "codex:", "  name:", "    x: 1"]],
  [[D, "codex:", "  name: 5"]],
  [[D, "codex:", "  name: ''"]],
  [[D, "codex:", "  name: [a]"]],
  [[D, "codex:", "  name: 1.5"]],
  [[D, "codex:", "  description: ''"]],
  [[D, "codex:", "  description: [x]"]],
  [[D, "codex:", "  description: true"]],
  [["name: a", "codex:", "  description: from codex"]],
  // codex that is no mapping
  ...["codex:", "codex: null", "codex: 'x'", "codex: [a]", "codex: 1.5", "codex: 3", "codex: true", "codex: {}"]
    .map((c) => [[D, c]]),
  // a key an object inherits (the reference asks `key in top`)
  [[D, "codex:", "  constructor:", "    x: 1", "  toString: s", "  valueOf:", "    y: 2", "  hasOwnProperty: h"]],
  // briefing skill names
  [[D, "briefing:", "  skills:", "    - 日本語", "    - with space", "    - 'has #hash'", "    - \"it's\"", "    - a:b@c",
    "    - \"\\u0085\"", "    - \"\\u2028\"", "    - x[y", "    - 🎉"]],
  ...["1.5", "1e999", '""', '"\\t"', '"\\x7f"', '"a]"', '"a\\\\b"', "-1", "false", "~", '"\\x1f"']
    .map((item) => [[D, "briefing:", "  skills:", `    - ${item}`]]),
  ...["  skills: ~", "  skills:", "  skills: {a: b}", "  skills: 3", "  skills: ''"].map((s) => [[D, "briefing:", s]]),
  ...["briefing: x", "briefing: null", "briefing: [a]", "briefing: {skills: [a, b]}", "briefing: {}"].map((b) => [[D, b]]),
  // which error comes first
  [[D, "briefing:", "  skills: a", "codex:", "  briefing: x"]],
  [["name: a", "codex:", "  briefing: x"]],
  [["name: a", "codex:", "  nothing: ~"]],
  [[D, "codex:", "  nothing: ~", "  inf: 1e999"]],
  [[D, "briefing:", "  skills: [a]", "codex:", "  name: ''"]],
  // frontmatter the reader refuses
  ["---\ndescription: d\nB\n", "x"],
  ["---\ndescription: d\n\tname: x\n---\nB\n", "x"],
  [["description: d", "description: e"]],
  [["description: *a"]],
  [["description: !tag x"]],
  [["- item"]],
  [["description: \"\\q\""]],
  // fences and line endings
  ["\ufeff---\ndescription: d\n---\nB\n", "x"],
  ["---\r\ndescription: d\r\n---\r\nBody\r\n", "x"],
  ["---\ndescription: d\n---", "x"],
  ["---\ndescription: d\n---\n", "x"],
  ["---  \ndescription: d\n---  \n\n\nB\n", "x"],
  ["---\n---\nB\n", "x"],
  // bodies
  ...NASTY_BODIES.map((b) => [[D], b]),
  ...["", "\n", " \t\n", "\u00a0", "\ufeff", "\u2028", "\u0085", "\u3000\n"].map((b) => [[D], b]),
];

const rules = [
  // test/convert.test.ts
  ["---\ndescription: x\n---\n\nUse tabs.\n\n"],
  ["---\npaths:\n  - \"k8s/**\"\n  - '*.yaml'\n---\nBe careful.\n"],
  ["---\npaths: src/**\n---\nB\n"],
  ["No frontmatter at all.\n"],
  ["---\npaths: [a]\n---\n  \n"],
  [""],
  ...["<!-- skilletor:end -->", "<!-- skilletor:rule x source=y -->", "<!-- skilletor:rules scope=user -->"]
    .map((l) => [`text\n${l}\n`]),
  // paths of every shape
  ...["paths: [1, true, null, 1.5, 'a`b', '']", "paths: 3", "paths: true", "paths: 1.5", "paths: {a: b}", "paths: []",
    "paths: null", "paths: ''", "paths: ~", "paths:", "paths: -0", "paths: [日本/**, '🎉']", "paths: 'a, b'",
    "paths:\n  - one\n  - two\n  - three"].map((p) => [md([p], "Rule.\n")]),
  // marker lines
  ...["<!-- skilletor:begin -->", "  <!-- skilletor:begin -->  ", "<!-- skilletor:rulesX", "<!-- skilletor:ruleé",
    "<!-- skilletor:rule-x", "<!-- skilletor:endless", "<!-- skilletor:beginning", "<!-- skilletor:rules",
    "<!-- skilletor:rule", "<!-- skilletor:end_", "<!-- skilletor:end9", "\u00a0<!-- skilletor:end -->",
    "\u0085<!-- skilletor:end -->", "<!-- skilletor:end -->\r", "x <!-- skilletor:end -->", "<!--  skilletor:end -->",
    "<!-- Skilletor:end -->", "<!-- skilletor:end", "\ufeff<!-- skilletor:rule a source=b -->"]
    .map((l) => [`text\n${l}\nmore\n`]),
  [md(["paths: [a]", "note: '<!-- skilletor:end -->'"], "Marker in the frontmatter only.\n")],
  // what normalizeSection keeps and drops
  ...["\n\n  \n\t\nlead\n", "trail   \t\n\n\n", "crlf\r\n\r\n", "\r\n\r\ncrlf lead\n", "nbsp lead\u00a0\n", "\u00a0\nx\n",
    "x\u2028", "x\u0085", "x\ufeff", "x\u3000\n", "  indented first\n", "a\n\n\nb\n", "\u0000\n", "🎉\n", " \t \n x \n"]
    .map((b) => [b]),
  ...["\n\nlead\n", "Body\r\n\r\n", "  \n  body\n"].map((b) => [md(["paths: [a]"], b)]),
  // frontmatter the reader refuses
  ["---\npaths: [a]\nB\n"],
  ["---\npaths: &a x\n---\nB\n"],
  ["\ufeff---\npaths: [a]\n---\nB\n"],
  ["---\r\npaths: [a]\r\n---\r\nB\r\n"],
];

const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const targets = [
  ["codex", "agent", "x", [["agents/x.md", hex(md([D, "codex:", "  model: m", "  bad: ~"]))]]],
  ["codex", "agent", "x", [["agents/x.md", hex(md([D], "  \n"))]]],
  ["codex", "agent", "x", [["agents/y.md", hex(md([D]))]]],
  ["codex", "agent", "x", []],
  ["codex", "agent", "x", [["agents/x.md", hex(md(["name: x"]))]]],
  ["codex", "agent", "x", [["agents/x.md", "efbbbf" + hex(md([D]))]]],
  ["codex", "agent", "x", [["agents/x.md", hex("---\ndescription: d\n---\n") + "ff20c328e282eda080c0afe080aff4908080" + hex(" tail\n")]]],
  ["codex", "agent", "x", [["agents/x.md", hex(md([D], "日本語 🎉\n"))], ["agents/other.txt", hex("extra")]]],
  ["codex", "agent", "Ünï", [["agents/Ünï.md", hex(md([D], "B\n"))]]],
  // Escaped UTF-16 pairs join before output; lone, reversed and separated halves stay replacement characters.
  ["codex", "agent", "x", [["agents/x.md", hex(md(['description: "\\uD83D\\uDE00 pair \\uD83D lone \\uDE00 reversed \\uDE00\\uD83D mixed \\uD83D\\uD83D\\uDE00 separated \\uD83D x \\uDE00 upper \\U0000D83D\\U0000DE00 lower-upper \\uD83D\\U0000DE00 upper-lower \\U0000D83D\\uDE00"', "briefing:", '  skills: ["\\uDFFF"]']))]]],
  ["codex", "rule", "r", [["rules/r.md", hex("---\npaths: [a]\n---\nR\n")]]],
  ["codex", "rule", "r", [["rules/r.md", hex("\n")]]],
  ["codex", "rule", "r", [["rules/q.md", hex("R\n")]]],
  ["codex", "rule", "r", [["rules/r.md", hex("R\n<!-- skilletor:end -->\n")]]],
  ["codex", "rule", "r", [["rules/r.md", hex("R ") + "ffeda080c0af" + hex("\n")]]],
  ["codex", "rule", "r", [["rules/r.md", hex("---\npaths: &a x\n---\nR\n")]]],
  ["codex", "skill", "s", [["skills/s/SKILL.md", hex("---\nname: s\n---\nS\n")], ["skills/s/run.sh", "ff00"]]],
  ["claude", "agent", "x", [["agents/x.md", hex(md([D]))]]],
  ["claude", "rule", "r", [["rules/r.md", hex("---\npaths: [a]\n---\nR\n")]]],
  ["claude", "skill", "s", [["skills/s/SKILL.md", hex("S\n")]]],
  ["hermes", "skill", "s", [["skills/s/SKILL.md", hex("S\n")]]],
];

const caught = (fn) => {
  try {
    return fn();
  } catch (err) {
    return { error: { name: err.name, message: err.message } };
  }
};

const records = {
  agents: agents.map((a) => {
    const [text, name = "x"] = typeof a[0] === "string" ? a : [md(a[0], a[1] ?? "B\n"), a[2]];
    return { md: text, name, ...caught(() => ({ out: codexAgentToml(text, name) })) };
  }),
  rules: rules.map(([text, name = "r"]) => ({
    md: text, name, ...caught(() => ({ out: codexRuleSection(text, name) ?? null })),
  })),
  targets: targets.map(([harness, type, name, files]) => ({
    harness, type, name, files, ...caught(() => {
      const input = new Map(files.map(([p, h]) => [p, Buffer.from(h, "hex")]));
      const conv = convertForTarget(harness, type, name, input);
      return {
        out: {
          files: [...conv.output].map(([p, b]) => [p, b.toString("hex")]),
          skipped: conv.skipped, warnings: conv.warnings, same: conv.output === input,
        },
      };
    }),
  })),
};

// One record per line: small, and a change shows as the lines it touches.
const list = (rs) => `[\n${rs.map((r) => JSON.stringify(r)).join(",\n")}\n]`;
console.log(`{\n"agents": ${list(records.agents)},\n"rules": ${list(records.rules)},\n"targets": ${list(records.targets)}\n}`);
