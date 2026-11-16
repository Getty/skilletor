// Regenerates t/data/agentsmd-oracle.json: what the reference's agentsmd.ts makes of each
// input – the rules file (normalizeSection, rulesFileText, parseRulesFile), the pointer block
// (pointerLines, parseBlock, withBlock), MARKER_LINE, inspectAgentsMd on a file of given bytes
// or kind, and the config.toml checks (projectDocLimit, codexHookTrusted) on a config.toml of
// given bytes – or the error it throws (class name and message). A Map comes out as its entries.
// Files go in as hex bytes. Run from the repository root:
//   node maint/oracle-agentsmd.mjs > t/data/agentsmd-oracle.json
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexHookTrusted, inspectAgentsMd, MARKER_LINE, normalizeSection, parseBlock, parseRulesFile, pointerLines,
  projectDocLimit, rulesFileText, withBlock,
} from "../src/agentsmd.ts";

const caught = (f) => {
  try {
    return f();
  } catch (err) {
    return { error: { name: err.name, message: err.message } };
  }
};
const entries = (sections) => [...sections].map(([name, s]) => [name, s.source, s.text]);
const hex = (s) => Buffer.from(s, "utf8").toString("hex");

const B = "<!-- skilletor:begin -->";
const E = "<!-- skilletor:end -->";
const R = (name, source = "s") => `<!-- skilletor:rule ${name} source=${source} -->`;
const HEAD = "<!-- skilletor:rules scope=user -->\n<!-- managed by skilletor — edits are overwritten; change the rule in its source -->\n";

// Whitespace the reference's `\s` and `trim()` take, and characters they do not.
const WS = ["", " ", "\t", "\n", "\r\n", "\r", "\u000b", "\u000c", " ", " ", " ", " ", " ", " ",
  " ", " ", "　", "﻿", "\u0085", "​", "᠎"];

const sectionTexts = [
  "", "\n", "\n\n", "a", "a\n", "\n\na\n\n", " \t\na  \n", "\r\n\r\na\r\n", "  \n  x", "\t\n \nx\n", "\r\nx", " \r\nx",
  "x\ny\n\n\nz \n", "line one\n\n  indented\n", ...WS.map((w) => `${w}x${w}`), ...WS.map((w) => `${w}\nx\n${w}`),
];

const markers = [
  B, E, "<!-- skilletor:rules scope=user -->", R("a"), "<!-- skilletor:rule", "<!-- skilletor:rules", "<!-- skilletor:rulex",
  "<!-- skilletor:ruleé", "<!-- skilletor:rule-x", "<!-- skilletor:rule_x", "<!-- skilletor:endless", "<!-- skilletor:end_",
  "<!-- skilletor:begin2", "<!-- skilletor:begin", " <!-- skilletor:end -->", "<!-- skilletor:other", "<!--skilletor:begin -->",
  "<!-- skilletor:ruleé", "<!-- skilletor:rule٠", "<!-- skilletor:ruleK", "<!-- skilletor:endİ",
];

const sectionSets = [
  [],
  [{ name: "a", source: "s", text: "A\n" }],
  [{ name: "a", source: "s", text: "A" }],
  [{ name: "a", source: "s", text: "" }],
  [{ name: "a", source: "s", text: "\n" }],
  [{ name: "a", source: "s", text: "A\n\n" }],
  [{ name: "a", source: "s", text: "A\r\n" }],
  [{ name: "b", source: "two", text: "B one\n\nB two\n" }, { name: "a", source: "one", text: "A\n" }],
  [{ name: "日本", source: "ü", text: "— ümlaut 🎉\n" }, { name: "z", source: "s --> x", text: "Z\n" }],
];

const rulesTexts = [
  "", "\n", HEAD, `${HEAD}\n${R("a")}\nA\n`, `${HEAD}\n${R("a")}\nA\n\n${R("b", "t")}\nB\n\nmore\n`,
  `${R("a")}\nA\n${R("a", "again")}\nA2\n`, `before\n${R("a")}\n\n\nA\n  \n`, `  ${R("a")}  \nA\n`, `\t${R("a")} \nA\n`,
  "<!-- skilletor:rule a b source=s -->\nA\n", "<!-- skilletor:rule a source=x --> y -->\nA\n", "<!-- skilletor:rule a source= -->\nA\n",
  "<!-- skilletor:rule a b source=s -->\nA\n", "<!-- skilletor:rule a​b source=s -->\nA\n",
  "<!-- skilletor:rule a source=s x -->\nA\n", "<!-- skilletor:rule a source=s\u0085x -->\nA\n",
  `${R("a")}\r\nA\r\n`, `${R("a")}\nA\r\n\r\n`, `${R("a")}`, `${R("a")}\n`, `${R("é")}\nunicode 日本\n${R("🎉")}\nparty\n`,
  ...sectionSets.slice(1).map((s) => rulesFileText("project", s)),
];

const blockTexts = [
  "", "\n", "plain\n", B, E, `${B}\n${E}`, `${B}\n${E}\n`, `${E}\n${B}\n`, `${B}\n${B}\n${E}\n`, `${B}\n${E}\n${E}\n`,
  `${B}\n`, `${E}\n`, `  ${B}  \n\t${E} \n`, `x${B}\n${E}\n`, `head\n\n${B}\ninside\n${E}\n\ntail\n`,
  `${B}\n${R("a")}\nA\n${R("b")}\nB\n${E}\n`, `${R("out")}\nO\n${B}\n${R("in")}\nI\n${E}\n${R("after")}\n`,
  `${B}\r\n${E}\r\n`, `a\r\n${B}\r\nx\r\n${E}\r\nb\r\n`, `${B}\n${E}\n${B}\n${E}\n`,
];

const bodies = [null, [], ["x"], pointerLines("user", "/home/u/.codex/skilletor-rules.md"), pointerLines("project", ".codex/skilletor-rules.md")];
const withTexts = [
  null, "", "\n", "  \n\t\n", "plain", "plain\n", "plain\n\n\n", "plain  \t\n", " ", "a ",
  `${B}\nold\n${E}\n`, `${B}\nold\n${E}`, `head\n${B}\nold\n${E}\n`, `head\n\n${B}\nold\n${E}\n\n  \n`, `${B}\nold\n${E}\ntail\n`,
  `head\n${B}\nold\n${E}\ntail`, `  ${B}\nold\n  ${E}  \n`, `${B}\r\nold\r\n${E}\r\n`, `head\r\n\r\n${B}\r\nold\r\n${E}\r\n`,
  `${B}\n`, `${E}\n${B}\n`, `${B}\n${B}\n${E}\n`, `head\n${B}\n${E}\n \n`,
];

// AGENTS.md files: bytes (hex) or a kind the oracle sets up.
const agentsFiles = [
  ...["", "plain\n", `head\n${B}\nx\n${E}\n`, `${B}\n${B}\n`, `${E}\n`, `${E}\n${B}\n`, `${B}\n${R("a")}\nA\n${E}\n`]
    .map((t) => ({ hex: hex(t) })),
  { hex: "c3" }, { hex: "ff0a" + hex(`${B}\n${E}\n`) }, { hex: "efbbbf" + hex(`${B}\n${E}\n`) }, { hex: "e282" },
  { kind: "missing" }, { kind: "dir" }, { kind: "symlink" }, { kind: "dangling" },
];

const KEY = "skilletor@getty:hooks/codex-hooks.json:session_start:0:0";
const configs = [
  // test/agentsmd.test.ts
  "model = \"x\"\nproject_doc_max_bytes = 1000\n[tui]\nproject_doc_max_bytes = 5\n",
  "[profiles.a]\nproject_doc_max_bytes = 5\n",
  `model = "x"\n\n[hooks.state."${KEY}"]\ntrusted_hash = "sha256:ab"\n`,
  `[hooks.state."skilletor@other:hooks/codex-hooks.json:session_start:0:0"]\nenabled = true\ntrusted_hash = 'sha256:ab'\n`,
  `[hooks.state."skilletor@getty:hooks/codex-hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:ab"\n`,
  `[hooks.state."other@getty:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:ab"\n`,
  `[hooks.state."${KEY}"]\nenabled = true\n[tui]\ntrusted_hash = "sha256:ab"\n`,
  `[hooks.state]\n"${KEY}".trusted_hash = "sha256:ab"\n`,
  `[hooks.state]\n"${KEY}" = { trusted_hash = "sha256:ab" }\n`,
  // the line forms around them
  "", "project_doc_max_bytes = 0\n", "project_doc_max_bytes=12 # a comment\n", "  project_doc_max_bytes =\t7  \n",
  "project_doc_max_bytes = 1_000\n", "project_doc_max_bytes = -5\n", "project_doc_max_bytes = 5.0\n", "project_doc_max_bytes = \"5\"\n",
  "project_doc_max_bytes = 0012\n", "project_doc_max_bytes = 5 # x\r\n", "project_doc_max_bytes = 5\r\n", " project_doc_max_bytes = 9\n",
  "project_doc_max_bytes = ٩\n", "a = 1\n  [x]\nproject_doc_max_bytes = 3\n", "project_doc_max_bytes = 3\nproject_doc_max_bytes = 4\n",
  "# [comment]\nproject_doc_max_bytes = 6\n", "x = [1,\n2]\nproject_doc_max_bytes = 8\n",
  `[ hooks . state . "${KEY}" ] # c\n  trusted_hash = "x"\n`, `[hooks.state.'${KEY}']\ntrusted_hash='x'\n`,
  `[hooks.state."${KEY}"]\ntrusted_hash = x\n`, `[hooks.state."${KEY}"]\ntrusted_hash\n`, `[hooks.state."${KEY}"]\n# trusted_hash = "x"\n`,
  `[[hooks.state."${KEY}"]]\ntrusted_hash = "x"\n`, `[hooks.state."${KEY}"] trailing\ntrusted_hash = "x"\n`,
  `[hooks.state."skilletor@a\\"b:session_start:"]\ntrusted_hash = "x"\n`, `[hooks.state."${KEY}" ]\r\ntrusted_hash = "x"\r\n`,
  `[hooks.state."${KEY}"]\n[hooks.state]\ntrusted_hash = "x"\n`, `[hooks]\n[hooks.state]\n'${KEY}'.trusted_hash = 'x'\n`,
  `[hooks.state]\n"${KEY}".enabled = true\n`, `[hooks.state]\n"${KEY}" = { enabled = true, trusted_hash = "x" }\n`,
  `[hooks.state]\n"${KEY}" = { xtrusted_hash = "x" }\n`, `[hooks.state]\n"${KEY}" = { trusted_hashx = "x" }\n`,
  `[hooks.state]\n"${KEY}"é trusted_hash = "x"\n`, `[hooks.state]\n"${KEY}"_trusted_hash = "x"\n`,
  `[hooks.state]\n  "skilletor@x:session_start:\\\\" . trusted_hash = "y"\n`, `[hooks.state]\n${KEY}.trusted_hash = "x"\n`,
  `[hooks.state]\n"${KEY}".trusted_hash = "x"\n[other]\n`, `[hooks.state] # comment\n"${KEY}".trusted_hash = "x"\n`,
  `[hooks.statex]\n"${KEY}".trusted_hash = "x"\n`, `[ hooks.state ]\n"${KEY}".trusted_hash = "x"\n`,
  `[hooks.state. "${KEY}"]\ntrusted_hash = "x"\n`, ` [hooks.state."${KEY}"]\ntrusted_hash = "x"\n`,
  `[hooks.state."${KEY}"]\n trusted_hash = "x"\n`, `[hooks.state."skilletor@x:session_start:"\u0085]\ntrusted_hash = "x"\n`,
].map((t) => ({ hex: hex(t) }));
configs.push({ hex: "ff" + hex(`\n[hooks.state."${KEY}"]\ntrusted_hash = "x"\n`) }, { hex: hex("project_doc_max_bytes = 77\n") + "c3" }, { kind: "missing" },
  { kind: "dir" });

const tmp = mkdtempSync(join(tmpdir(), "oracle-agentsmd-"));
let n = 0;
/** A fresh path holding the given file (or kind of entry). */
const place = (f, name) => {
  const dir = join(tmp, String(n++));
  mkdirSync(dir);
  const p = join(dir, name);
  if (f.hex !== undefined) writeFileSync(p, Buffer.from(f.hex, "hex"));
  else if (f.kind === "dir") mkdirSync(p);
  else if (f.kind === "symlink") {
    writeFileSync(join(dir, "target.md"), "x\n");
    symlinkSync("target.md", p);
  } else if (f.kind === "dangling") symlinkSync("nowhere.md", p);
  return { dir, p };
};

const records = {
  normalize: sectionTexts.map((text) => ({ text, out: normalizeSection(text) })),
  markers: markers.map((line) => ({ line, out: MARKER_LINE.test(line) })),
  rulesFile: [
    ...sectionSets.map((sections) => ({ scope: "project", sections, out: rulesFileText("project", sections) })),
    { scope: "user", sections: sectionSets[1], out: rulesFileText("user", sectionSets[1]) },
  ],
  parseRules: rulesTexts.map((text) => ({ text, out: entries(parseRulesFile(text)) })),
  pointer: [["user", "/home/u/.codex/skilletor-rules.md"], ["project", ".codex/skilletor-rules.md"]]
    .map(([scope, file]) => ({ scope, file, out: pointerLines(scope, file) })),
  parseBlock: blockTexts.map((text) => ({
    text, ...caught(() => {
      const p = parseBlock(text);
      return { out: p && { begin: p.begin, end: p.end, sections: entries(p.sections) } };
    }),
  })),
  withBlock: withTexts.flatMap((text) => bodies.map((body) => ({ text, body, ...caught(() => ({ out: withBlock(text, body) })) }))),
  inspect: agentsFiles.map((f) => {
    const { p } = place(f, "AGENTS.md");
    const r = inspectAgentsMd(p);
    const out = r.ok
      ? { ok: true, text: r.text, parsed: r.parsed && { begin: r.parsed.begin, end: r.parsed.end, sections: entries(r.parsed.sections) } }
      : { ok: false, reason: r.reason };
    return { file: f, out };
  }),
  config: configs.map((f) => {
    const { dir } = place(f, "config.toml");
    return { file: f, limit: projectDocLimit(dir), trusted: codexHookTrusted(dir) };
  }),
};
rmSync(tmp, { recursive: true, force: true });

// One record per line: small, and a change shows as the lines it touches.
const list = (rs) => `[\n${rs.map((r) => JSON.stringify(r)).join(",\n")}\n]`;
console.log(`{\n${Object.entries(records).map(([k, rs]) => `${JSON.stringify(k)}: ${list(rs)}`).join(",\n")}\n}`);
