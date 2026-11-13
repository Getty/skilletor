// Regenerates t/data/toml-oracle.json: what the reference's stringifyToml writes for each
// table (or the TomlWriteError it throws) and what tomlKey makes of each key. Run from perl/:
//   node maint/oracle-toml.mjs > t/data/toml-oracle.json
//
// JSON cannot tell a TomlFloat from a number, nor hold a non-finite one, so a value
// {"$float": x} is a TomlFloat (x a number or "Infinity", "-Infinity", "NaN") and
// {"$number": "NaN"} (or "Infinity", "-Infinity") a non-finite number. A table is
// {"$table": [[key, value], ...]}, its keys in the order JavaScript gives them, so the
// test can decode the file with a parser that does not keep key order.
import { stringifyToml, tomlKey, TomlFloat } from "../../src/toml.ts";

function enc(v) {
  if (v instanceof TomlFloat) return { $float: Number.isFinite(v.value) ? v.value : String(v.value) };
  if (typeof v === "number" && !Number.isFinite(v)) return { $number: String(v) };
  if (Array.isArray(v)) return v.map(enc);
  if (v !== null && typeof v === "object") return { $table: Object.entries(v).map(([k, x]) => [k, enc(x)]) };
  return v;
}

const F = (n) => new TomlFloat(n);

// test/toml.test.ts's NASTY strings.
const NASTY = [
  "", "plain", 'with "double" quotes', "with 'single' quotes", "ends with a quote'", "ends with two quotes''",
  "ends with a double quote\"", "three singles ''' inside", 'three doubles """ inside',
  'four doubles """" and five """""', "backslash \\ and \\n literal and \\u0041 and trailing \\",
  "C:\\path\\to\\file", "line1\nline2\n", "\nleading newline", "\n\nleading two newlines", "trailing newlines\n\n\n",
  "windows\r\nline endings\r\n", "bare \r carriage return", "tab\tseparated",
  "control \u0000 \u0001 \u0008 \u000b \u000c \u001f \u007f chars", "unicode — ümlaut 日本語 🎉 \u2028 \u2029",
  "---\nfrontmatter-like\n---\n", "# looks like a comment\n[table] = looks like a table", "'''", '"""', "'", '"', "\\",
  "\\\n", "a\\\n  b",
];

// Every string of up to three characters over test/toml.test.ts's alphabet.
const alphabet = ["'", '"', "\\", "\n", "\r", "a", "\t", "\u0000", "\u007f", "é"];
const short = [""];
for (let len = 1; len <= 3; len++) {
  for (const p of short.filter((s) => [...s].length === len - 1)) for (const c of alphabet) short.push(p + c);
}

// Every ASCII code point, and the non-ASCII ones an escaper could get wrong.
const chars = [];
for (let cp = 0; cp <= 0x7f; cp++) chars.push(String.fromCodePoint(cp));
for (const cp of [0x80, 0x85, 0x9f, 0xa0, 0xad, 0x2028, 0x2029, 0x202e, 0xfeff, 0xfffd, 0xffff, 0x1f600, 0x10ffff]) {
  chars.push(String.fromCodePoint(cp), `x${String.fromCodePoint(cp)}\n`);
}

const extras = [
  "日本語のテキスト", "emoji 🎉🧑‍💻 and flags 🇩🇪", "combining a\u0300e\u0301", "rtl \u202eevil\u202c", "x".repeat(300),
  "''", "'a'", "a''", "a'''b", "''''", "'''a", "a'''", "'\n", "\n'", "\"\n", "\\\\", "\\'", "\\\"", "\"\"", "\"\"\"\"",
  "\r\n", "\n", "\n\n", "\r", "\t", " ", "  trailing  ", "\u0000", "\u001b[31mred\u001b[0m", "nul\u0000 inside\n",
  "\ttabbed\n\tlines\n", "ends with backslash\\", "ends with backslash newline\\\n", "\u00a0nbsp\u00a0",
];

const strings = [...new Set([...NASTY, ...short, ...chars, ...extras])];

const keys = [
  "a", "A-z_0-9", "with-dash", "under_score", "", " ", "a b", "a.b", "é", "日本", "a\n", "\n", "1", "0", "-", "_",
  '"', "'", "\\", "\u0000", "key\u007f", "tab\tkey", "[t]", "a=b", "#", "🎉",
];

const tables = [
  // test/toml.test.ts: scalars, string arrays and one level of tables
  {
    table: {
      name: "a", n: 3, neg: -7, f: F(1), g: F(0.25), yes: true, no: false, list: ["x", 'y"', "z\n"], empty: [],
      "needs quotes": "q", tbl: { inner: "v", nums: 2, arr: ["p"] }, "odd.table": { "a b": true },
    },
  },
  { table: { developer_instructions: 'You are "helper".\nUse C:\\tmp freely.\n' }, multiline: ["developer_instructions"] },
  // nothing, tables only, empty tables
  { table: {} },
  { table: { t: {} } },
  { table: { a: "x", t: {}, u: { k: "v" }, v: {} } },
  // tables come after every top-level key, whatever the order given; index keys first, as JS orders them
  { table: { t1: { a: 1 }, top: "x", t2: { b: 2 }, last: true } },
  { table: { b: 1, 2: "two", a: { x: 1 }, 1: { y: 2 }, 10: "ten" } },
  // the multiline option: only for top-level strings
  { table: { k: 3, l: true, m: ["a\nb"], n: F(1.5), s: "a\nb" }, multiline: ["k", "l", "m", "n", "s"] },
  { table: { t: { s: "a\nb" } }, multiline: ["s", "t"] },
  { table: { a: "x\n", b: "y\n" }, multiline: ["b", "missing"] },
  { table: { "a b": "x\ny" }, multiline: ["a b"] },
  // integers
  { table: { zero: 0, negzero: -0, one: 1, minus: -1, max: 2 ** 53 - 1, min: -(2 ** 53 - 1), big: 1234567890123 } },
  // floats
  {
    table: {
      a: F(0), b: F(-0), c: F(1), d: F(-1), e: F(0.25), f: F(1.5), g: F(1e21), h: F(1e-7), i: F(123456789.123),
      j: F(0.1 + 0.2), k: F(5e-324), l: F(1.7976931348623157e308), m: F(100), n: F(1e300), o: F(2 ** 53), p: F(1e20),
      q: F(-1e-6), r: F(1e-6), s: F(123e-20), t: F(0.000001234),
    },
  },
  { table: { t: { f: F(2.5), g: F(3) } } },
  // string arrays
  { table: { a: [], b: [""], c: NASTY, d: ["日本", "🎉"] } },
  { table: { t: { a: [], b: ["x\ny"] } } },
  // what TOML cannot hold
  { table: { k: 2 ** 53 } },
  { table: { k: -(2 ** 53) } },
  { table: { k: 1.5 } },
  { table: { k: 1e21 } },
  { table: { k: 2 ** 63 } },
  { table: { k: NaN } },
  { table: { k: Infinity } },
  { table: { k: -Infinity } },
  { table: { k: F(Infinity) } },
  { table: { k: F(-Infinity) } },
  { table: { k: F(NaN) } },
  { table: { k: null } },
  { table: { k: { deep: { deeper: "x" } } } },
  { table: { k: [1, 2] } },
  { table: { k: [null] } },
  { table: { k: ["a", true] } },
  { table: { k: [["x"]] } },
  { table: { k: [{}] } },
  { table: { k: [F(1)] } },
  { table: { t: { x: null } } },
  { table: { t: { x: 1.5 } } },
  { table: { t: { x: [1] } } },
  { table: { t: { x: F(NaN) } } },
  { table: { "a b": { "c d": 1.5 } } },
  // the first problem wins: top-level keys before tables
  { table: { t: { x: null }, k: 1.5 } },
  { table: { a: null, b: 1.5 } },
];

const cases = [];
for (const s of strings) {
  cases.push({ table: { k: s } });
  cases.push({ table: { k: s }, multiline: ["k"] });
}
for (const k of keys) cases.push({ table: { [k]: "v", t: { [k]: k } } });
cases.push(...tables);

const records = {
  keys: keys.map((key) => ({ key, out: tomlKey(key) })),
  cases: cases.map((c) => {
    const rec = { table: enc(c.table) };
    if (c.multiline) rec.multiline = c.multiline;
    try {
      rec.out = stringifyToml(c.table, c.multiline ? { multiline: c.multiline } : {});
    } catch (err) {
      rec.error = { name: err.name, message: err.message };
    }
    return rec;
  }),
};
// One record per line: small, and a change shows as the lines it touches.
const list = (rs) => `[\n${rs.map((r) => JSON.stringify(r)).join(",\n")}\n]`;
console.log(`{\n"keys": ${list(records.keys)},\n"cases": ${list(records.cases)}\n}`);
