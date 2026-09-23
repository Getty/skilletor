// TOML writer (spec §14.7): every value must round-trip through an independent
// parser (smol-toml, devDependency only) byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import { stringifyToml, TomlFloat, TomlWriteError, type TomlTable } from "../src/toml.ts";

const NASTY: string[] = [
  "",
  "plain",
  'with "double" quotes',
  "with 'single' quotes",
  "ends with a quote'",
  "ends with two quotes''",
  "ends with a double quote\"",
  "three singles ''' inside",
  'three doubles """ inside',
  'four doubles """" and five """""',
  "backslash \\ and \\n literal and \\u0041 and trailing \\",
  "C:\\path\\to\\file",
  "line1\nline2\n",
  "\nleading newline",
  "\n\nleading two newlines",
  "trailing newlines\n\n\n",
  "windows\r\nline endings\r\n",
  "bare \r carriage return",
  "tab\tseparated",
  "control \u0000 \u0001 \u0008 \u000b \u000c \u001f \u007f chars",
  "unicode — ümlaut 日本語 🎉 \u2028 \u2029",
  "---\nfrontmatter-like\n---\n",
  "# looks like a comment\n[table] = looks like a table",
  "'''",
  '"""',
  "'",
  '"',
  "\\",
  "\\\n",
  "a\\\n  b", // backslash-newline would be a line-ending backslash in a basic string
];

function roundTrip(table: TomlTable): Record<string, unknown> {
  const text = stringifyToml(table);
  try {
    // smol-toml builds null-prototype objects; normalize for deepEqual.
    return JSON.parse(JSON.stringify(parse(text))) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`unparseable TOML:\n${text}\n${(err as Error).message}`);
  }
}

test("single-line strings round-trip exactly, nasty or not", () => {
  for (const s of NASTY) assert.equal(roundTrip({ k: s }).k, s, JSON.stringify(s));
});

test("multi-line strings round-trip exactly, nasty or not", () => {
  for (const s of NASTY) {
    const text = stringifyToml({ k: s }, { multiline: ["k"] });
    assert.equal((parse(text) as { k: string }).k, s, `${JSON.stringify(s)}\n${text}`);
  }
});

test("every string built from the nasty alphabet round-trips (exhaustive over short strings)", () => {
  const alphabet = ["'", '"', "\\", "\n", "\r", "a", "\t", "\u0000", "\u007f", "é"];
  const all: string[] = [""];
  for (let len = 1; len <= 4; len++) {
    const prev = all.filter((s) => [...s].length === len - 1);
    for (const p of prev) for (const c of alphabet) all.push(p + c);
  }
  for (const s of all) {
    assert.equal(roundTrip({ k: s }).k, s, JSON.stringify(s));
    const text = stringifyToml({ k: s }, { multiline: ["k"] });
    assert.equal((parse(text) as { k: string }).k, s, JSON.stringify(s));
  }
});

test("a readable multi-line literal string when the content allows it", () => {
  const body = 'You are "helper".\nUse C:\\tmp freely.\n';
  assert.equal(stringifyToml({ developer_instructions: body }, { multiline: ["developer_instructions"] }),
    `developer_instructions = '''\n${body}'''\n`);
});

test("scalars, string arrays and one level of tables", () => {
  const t: TomlTable = {
    name: "a",
    n: 3,
    neg: -7,
    f: new TomlFloat(1),
    g: new TomlFloat(0.25),
    yes: true,
    no: false,
    list: ["x", 'y"', "z\n"],
    empty: [],
    "needs quotes": "q",
    tbl: { inner: "v", nums: 2, arr: ["p"] },
    "odd.table": { "a b": true },
  };
  const out = roundTrip(t);
  assert.deepEqual(out, {
    name: "a", n: 3, neg: -7, f: 1, g: 0.25, yes: true, no: false, list: ["x", 'y"', "z\n"], empty: [],
    "needs quotes": "q", tbl: { inner: "v", nums: 2, arr: ["p"] }, "odd.table": { "a b": true },
  });
  const text = stringifyToml(t);
  assert.match(text, /^f = 1\.0$/m); // a float stays a float
  // Top-level keys before any table header.
  assert.ok(text.indexOf("[tbl]") > text.indexOf("needs quotes"));
});

test("values TOML cannot hold are rejected, not mangled", () => {
  assert.throws(() => stringifyToml({ k: Number.NaN }), TomlWriteError);
  assert.throws(() => stringifyToml({ k: 1.5 }), TomlWriteError); // a non-integer number must be a TomlFloat
  assert.throws(() => stringifyToml({ k: new TomlFloat(Infinity) }), TomlWriteError);
  assert.throws(() => stringifyToml({ k: { deep: { deeper: "x" } } } as unknown as TomlTable), TomlWriteError);
  assert.throws(() => stringifyToml({ k: [1, 2] } as unknown as TomlTable), TomlWriteError);
  assert.throws(() => stringifyToml({ k: null } as unknown as TomlTable), TomlWriteError);
});
