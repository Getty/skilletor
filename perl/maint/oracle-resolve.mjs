// Regenerates t/data/resolve-oracle.json: the reference's YAML subset (splitFrontmatter,
// parseYamlDocument), bundle files (parseBundle, matchesPattern, sameIdentity) and catalog scans
// with bundle expansion over the trees of t/data/catalog-trees.json. Inputs: the curated lists
// below plus every string literal of test/frontmatter.test.ts and test/bundles.test.ts. Run
// from perl/:
//   node maint/oracle-resolve.mjs > t/data/resolve-oracle.json
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseYamlDocument, splitFrontmatter, YamlFloat } from "../../src/frontmatter.ts";
import { expandBundle, matchesPattern, parseBundle, sameIdentity } from "../../src/bundles.ts";
import { scan } from "../../src/catalog.ts";

/** YAML values as JSON: a float as { "$float": value }. */
const plain = (v) => {
  if (v instanceof YamlFloat) return { $float: v.value };
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};
const attempt = (fn) => {
  try {
    return { result: fn() };
  } catch (e) {
    return { error: e.message, class: e.name };
  }
};

const literals = (file) => {
  const src = readFileSync(new URL(`../../test/${file}`, import.meta.url), "utf8");
  const out = new Set();
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    try { out.add(JSON.parse(`"${m[1]}"`)); } catch {}
  }
  return [...out];
};

const yaml = [
  "",
  "a: 1",
  "name: my-agent\ndescription: \"Audit — says \\\"hi\\\"\\n and \\u00e9\"\nsingle: 'it''s # not a comment'\nplain: value # a comment\ncolon: a: b\nurl: https://example.com/x\nint: 42\nneg: -3\nfloat: 1.0\nyes: true\nno: False\nnothing: ~\nempty:\n# full-line comment",
  "lit: |\n  line one\n    indented\n\n  line three\nfold: >-\n  folded\n  together\nkeep: |+\n  k\n\nafter: x",
  "description: a long\n  description here\nq: \"two\n  lines\"",
  "tools: Read, Bash\nbriefing:\n  skills:\n    - skilletor-core\n    - 'kanban: karr'\ncodex:\n  model: gpt-5\n  nickname_candidates: [Ada, \"B, C\"]\n  features:\n    web: true\nlist_same_indent:\n- a\n- b\nflow_map: {a: 1, b: two}",
  "a: &anchor x", "a: *alias", "a: !tag x", "list:\n  - key: value", "a: [x, [nested]]", "a: \"unterminated", "a: b\na: c",
  "  indented: first", "not a mapping line", "a: 1\nb: &x 2\n", "a:\n\t- x", "a: [1, 2", "a: {x: 1, y}", "a: {: 1}", "a: [] # c", "a: {} trailing",
  "a: \"\\x41\\u00e9\\U0001F600\\N\\_\\L\\P\\0\\e\"", "a: \"\\q\"", "a: \"\\xZZ\"", "a: \"\\U00110000\"", "a: \"tail\\\"", "a: 'x' y",
  "n: 9007199254740991\nm: 9007199254740992\no: -9007199254740993\nz: 007\np: +5\nf: .5\ng: 5.\nh: 1e3\ni: -1.5E-2\nj: 1_000\nk: 0x10\nl: 1e400",
  "b1: True\nb2: TRUE\nb3: yes\nn1: Null\nn2: NULL\nn3: null",
  "fold: >\n  one\n  two\n\n  three\n    more\n  four\n",
  "strip: |-\n  a\n\n\nkeep: |+\n  a\n\n\nclip: |\n  a\n\n\nnext: 1",
  "ind: |2\n    two extra\n  base\n",
  "bad: |x\n  a", "bad: |1\n a\nlow: |\n    deep\n  shallow",
  "empty_block: |\nnext: 1",
  "seq:\n  - a\n  -\n  - b", "seq:\n  - a\n    - b", "seq:\n  - [a]", "seq:\n  - a # c\n  - 'b' # d\n  - \"c\"",
  "\"quoted key\": 1\n'single key': 2\n'it''s': 3\n\"esc\\tkey\": 4",
  "a:\n  b:\n    c: 1\n  d: 2\ne: 3",
  "a:\n  b: 1\n   c: 2", "- top", "a: 1\n  - b",
  "key with spaces: v\nkey-dash: v\n_under: v\n123: v\n",
  "a: x\n  continued # not a comment\n  more # comment",
  "a: [x,\n  y]", "a: {x: 1,\n  y: 2}",
  "a: # comment\n  b: 1",
  "description:\nskills: [a]",
  "a: 'one\n  two'", "a: @x", "a: `x`", "?complex: 1", "a: 1\r\nb: 2\r\n", "a: x\u2028y", "a:\u00a0b",
];

const texts = [
  "just text\n", "---\n---\nB\n", "---\nname: a\n---\n\n\n  indented\n\ntrailing  \n\n", "---\r\nname: a\r\n---\r\nB\r\n",
  "---\nname: a\n", "--- \nname: a\n---  \nB", "---\nname: a\n---", "---\na: 1\n----\nb: 2\n---\nbody", "---\na: |\n  x\n---\nb\n",
  "x---\na: 1\n---\n", "\ufeff---\na: 1\n---\n", "---\na: 1\n...\n---\nz", "---\na: &x 1\n---\n", "---\n\n\n---\n\n",
  "---\na: 1\r---\nb", "---\na: 1\n---\rafter",
];

const bundles = [
  "description: D\n",
  "description: D\nskills: [perl-*, testing]\nagents:\n  - reviewer\nrules: [\"*-style\"]\nbundles: [base, extra]\nvars:\n  k: \"5.40\"\n  n: 1.5\n  i: 2\n  b: true\n  nested: {a: 1}\n  list: [x, 2]\n",
  "description: D\nskills: [foo@Getty, \"perl-*@gitlab.com/peter\", x@https://h.example/s.tar.gz]\n",
  "description: D\nskills: [foo@host.example/x]\n", "description: D\nskills: [foo@~/dev/skills]\n", "description: D\nskills: [\"@Getty\"]\n",
  "description: D\nskills: [\"x@\"]\n", "description: D\nrules: [\"a@http://host/repo\", \"b@ssh://host/repo\", \"c@git@host:o/repo\"]\n",
  "description: D\nskills: [a@github.com/Getty/karr, \"b@https://github.com/Getty/karr\"]\n",
  "description: D\nskills: [\"a@https://github.com/Getty/karr/tree/main/skills\"]\n",
  "description: D\nskills: [\"a@https://github.com/Getty/karr/tree/v1\"]\n",
  "description: D\nskills: [\"a@http://h.example/s.tar.gz\"]\n",
  "description: D\nskills: [\"a@-x\"]\n",
  "description: D\nskills: [\"a@ext::sh -c x\"]\n",
  "description: D\nbundles: [x@y]\n", "description: D\nbundles: [x-*]\n", "description: D\nbundles: [\"\"]\n",
  "description: \"x\\U00110000\"\n", "description: \"x\\U0010FFFF\"\n",
  "skills: [a]\n", "description: \"\"\n", "description: 5\n", "description: [a]\n", "description:   \n",
  "description: D\nextra: 1\n", "description: D\nskills: a\n", "description: D\nskills: [1, 2]\n", "description: D\nskills: [\"  \"]\n",
  "description: D\nskills: [\" padded \"]\n", "description: D\nskills: [null]\n", "description: D\nskills: [1.5]\n", "description: D\nskills: [true]\n",
  "description: D\nvars: [a]\n", "description: D\nvars: x\n", "description: D\nvars: 1.5\n", "description: D\nvars:\n", "description: D\nskills:\n",
  "description: D\nvars: {}\n", "a: &x 1\n", "description: D\nskills: [a, [b]]\n",
  "description: |\n  multi\n  line\n",
];

const patterns = [
  ["perl-*", "perl-moo"], ["perl-*", "perl-"], ["perl-*", "xperl-moo"], ["*", ""], ["*", "anything"], ["*-style", "perl-style"],
  ["a*b*c", "aXXbYYc"], ["a*b*c", "abc"], ["a*b*c", "acb"], ["a.b", "axb"], ["a.b", "a.b"], ["(x)", "(x)"], ["x+", "xx"], ["[a]", "[a]"],
  ["a$", "a$"], ["^a", "^a"], ["a\\b", "a\\b"], ["*", "a\nb"], ["a*", "a\nb"], ["", ""], ["", "a"], ["**", "x"], ["é*", "élan"], ["A*", "abc"],
];

const identities = [
  ["https://github.com/Getty/karr", "https://github.com/Getty/karr.git"], ["https://github.com/Getty/karr/", "https://GitHub.com/Getty/karr"],
  ["HTTPS://github.com/x", "https://github.com/x"], ["https://github.com/Getty/Karr", "https://github.com/Getty/karr"],
  ["  https://h/x.git/  ", "https://h/x"], ["git@host:o/r.git", "git@host:o/r"], ["git@Host:o/r", "git@host:o/r"],
  ["https://h/x.git.git", "https://h/x.git"], ["https://h/x//", "https://h/x"], ["file:///tmp/x", "FILE:///tmp/x"],
];

/** Build a tree of t/data/catalog-trees.json under `root`. */
function build(root, tree) {
  for (const [rel, data] of Object.entries(tree.files ?? {})) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  for (const [rel, mode] of Object.entries(tree.modes ?? {})) chmodSync(join(root, rel), mode);
  for (const [rel, target] of Object.entries(tree.symlinks ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    symlinkSync(target, join(root, rel));
  }
}

const trees = JSON.parse(readFileSync(new URL("../t/data/catalog-trees.json", import.meta.url), "utf8"));
const base = realpathSync(mkdtempSync(join(tmpdir(), "skilletor-oracle-")));
const catalogs = [];
try {
  for (const tree of trees) {
    const dir = join(base, tree.name);
    mkdirSync(dir, { recursive: true });
    build(dir, tree);
    const abstract = (v) => JSON.parse(JSON.stringify(v).split(dir).join("${DIR}"));
    const out = { name: tree.name, scans: [] };
    for (const paths of [undefined, ...(tree.paths ?? [])]) {
      const r = attempt(() => scan(dir, paths));
      const entry = { paths: paths ?? null, ...abstract(r) };
      if (paths === undefined && r.result && tree.expand) {
        entry.expand = Object.fromEntries(tree.expand.map((b) => [b, abstract(attempt(() => expandBundle(r.result, b)))]));
      }
      out.scans.push(entry);
    }
    catalogs.push(out);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

const docs = [...new Set([...yaml, ...literals("frontmatter.test.ts")])];
const bundleTexts = [...new Set([...bundles, ...literals("bundles.test.ts")])];
console.log(JSON.stringify({
  yaml: docs.map((text) => ({ text, ...((r) => (r.result ? { result: plain(r.result) } : r))(attempt(() => parseYamlDocument(text))) })),
  frontmatter: [...new Set([...texts, ...docs.map((d) => `---\n${d}\n---\nBODY\n`)])].map((text) => {
    const r = attempt(() => splitFrontmatter(text));
    return r.result ? { text, data: plain(r.result.data), body: r.result.body } : { text, ...r };
  }),
  bundles: bundleTexts.map((text) => ({ text, ...attempt(() => parseBundle(text)) })),
  patterns: patterns.map(([p, n]) => ({ pattern: p, name: n, match: matchesPattern(p, n) })),
  identities: identities.map(([a, b]) => ({ a, b, same: sameIdentity(a, b) })),
  catalogs,
}, null, 1));
