// Bundles (spec §15) and name patterns (spec §3): parsing a bundle file,
// matching patterns, and expanding a bundle against a source's catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { BundleError, expandBundle, matchesPattern, parseBundle } from "../src/bundles.ts";
import { scan, type Catalog } from "../src/catalog.ts";

test("matchesPattern: * matches any run of characters anywhere, everything else literally", () => {
  assert.equal(matchesPattern("*", "anything"), true);
  assert.equal(matchesPattern("perl-*", "perl-moo"), true);
  assert.equal(matchesPattern("perl-*", "perl-"), true);
  assert.equal(matchesPattern("perl-*", "xperl-moo"), false);
  assert.equal(matchesPattern("*-style", "perl-style"), true);
  assert.equal(matchesPattern("a*b*c", "a-x-b-y-c"), true);
  assert.equal(matchesPattern("a.b", "axb"), false); // regex metacharacters are literal
  assert.equal(matchesPattern("exact", "exact"), true);
  assert.equal(matchesPattern("exact", "exactly"), false);
});

test("parseBundle: every key, flow and block lists, vars as plain values", () => {
  const def = parseBundle([
    "description: Everything for Perl projects",
    "skills: [perl-*, testing]",
    "agents:",
    "  - perl-reviewer",
    "rules: [something, \"*-style\"]",
    "bundles: [base]",
    "vars:",
    "  perl_version: \"5.40\"",
    "  kubernetes: false",
    "  ratio: 1.5",
  ].join("\n"));
  assert.equal(def.description, "Everything for Perl projects");
  assert.deepEqual(def.items, [
    { type: "skill", entry: "perl-*" }, { type: "skill", entry: "testing" },
    { type: "agent", entry: "perl-reviewer" },
    { type: "rule", entry: "something" }, { type: "rule", entry: "*-style" },
  ]);
  assert.deepEqual(def.bundles, ["base"]);
  assert.deepEqual(def.vars, { perl_version: "5.40", kubernetes: false, ratio: 1.5 });
});

test("parseBundle: only description is required", () => {
  assert.deepEqual(parseBundle("description: D\n"), { description: "D", items: [], foreign: [], bundles: [], vars: {} });
});

test("parseBundle errors: parse error, unknown key, no description, bad shapes", () => {
  const bad: [string, RegExp][] = [
    ["description: D\nskills: &a [x]\n", /anchors/],
    ["description: D\nhooks: [x]\n", /unknown key "hooks"/],
    ["skills: [x]\n", /description/],
    ["description: [x]\n", /description/],
    ["description: D\nskills: x\n", /skills must be a list/],
    ["description: D\nskills: [1]\n", /skills/],
    ["description: D\nvars: [1]\n", /vars must be a mapping/],
    ["description: D\nbundles: [base@Getty]\n", /bare/],
    ["description: D\nbundles: [\"b*\"]\n", /pattern/],
    ["description: D\nskills: [\"\"]\n", /empty/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseBundle(text), (e: unknown) => e instanceof BundleError && re.test((e as Error).message), text);
});

test("parseBundle: name@<spec> entries are kept apart; a spec that needs a probe or is local is an error", () => {
  const def = parseBundle("description: D\nskills: [foo@Getty, \"perl-*@gitlab.com/peter\", x@https://h.example/s.tar.gz]\n");
  assert.deepEqual(def.items, []);
  assert.deepEqual(def.foreign.map((f) => [f.type, f.name, f.spec, f.url]), [
    ["skill", "foo", "Getty", "https://github.com/Getty/skills"],
    ["skill", "perl-*", "gitlab.com/peter", "https://gitlab.com/peter/skills"],
    ["skill", "x", "https://h.example/s.tar.gz", "https://h.example/s.tar.gz"],
  ]);
  assert.throws(() => parseBundle("description: D\nskills: [foo@host.example/x]\n"), /https:\/\//);
  assert.throws(() => parseBundle("description: D\nskills: [foo@~/dev/skills]\n"), /local/);
  assert.throws(() => parseBundle("description: D\nskills: [\"@Getty\"]\n"), /empty/);
});

// ---- catalog scan -------------------------------------------------------------

function source(layout: Record<string, string>): { dir: string; cleanup: () => void } {
  const tmp = makeTmpDir();
  for (const [rel, content] of Object.entries(layout)) {
    mkdirSync(join(tmp.dir, rel, ".."), { recursive: true });
    writeFileSync(join(tmp.dir, rel), content);
  }
  return tmp;
}

const item = (d: string) => `---\ndescription: ${d}\n---\nbody\n`;

test("scan reads bundles/*.yaml and *.yml; a broken bundle carries its error, the scan does not fail", () => {
  const src = source({
    "rules/r1.md": item("r1"),
    "bundles/perl.yaml": "description: Perl\nrules: [r1]\n",
    "bundles/go.yml": "description: Go\n",
    "bundles/broken.yaml": "rules: [r1]\n",
    "bundles/twice.yaml": "description: A\n",
    "bundles/twice.yml": "description: B\n",
    "bundles/README.md": "not a bundle",
  });
  try {
    const cat = scan(src.dir);
    assert.deepEqual(cat.items.map((i) => i.name), ["r1"]);
    const byName = Object.fromEntries(cat.bundles.map((b) => [b.name, b]));
    assert.deepEqual(Object.keys(byName).sort(), ["broken", "go", "perl", "twice"]);
    assert.equal(byName.perl!.def?.description, "Perl");
    assert.equal(byName.perl!.files[0], "bundles/perl.yaml");
    assert.equal(byName.go!.def?.description, "Go");
    assert.match(byName.broken!.error!, /description/);
    assert.match(byName.twice!.error!, /both .*\.yaml and .*\.yml/);
  } finally {
    src.cleanup();
  }
});

// ---- expansion ----------------------------------------------------------------

function catalogOf(layout: Record<string, string>): { cat: Catalog; cleanup: () => void } {
  const src = source(layout);
  return { cat: scan(src.dir), cleanup: src.cleanup };
}

const members = (e: ReturnType<typeof expandBundle>) => e.items.map((i) => `${i.type}:${i.name}`).sort();

test("expandBundle: names and patterns per type, then nested bundles depth first; one item once", () => {
  const { cat, cleanup } = catalogOf({
    "skills/perl-moo/SKILL.md": item("m"),
    "skills/perl-dbi/SKILL.md": item("d"),
    "skills/testing/SKILL.md": item("t"),
    "rules/perl-style.md": item("ps"),
    "rules/go-style.md": item("gs"),
    "agents/perl-reviewer.md": item("r"),
    "bundles/perl.yaml": "description: P\nskills: [perl-*, testing]\nrules: [perl-*, \"*-style\"]\nbundles: [base]\n",
    "bundles/base.yaml": "description: B\nagents: [perl-reviewer]\nskills: [testing]\n",
  });
  try {
    const e = expandBundle(cat, "perl");
    assert.deepEqual(members(e), [
      "agent:perl-reviewer", "rule:go-style", "rule:perl-style", "skill:perl-dbi", "skill:perl-moo", "skill:testing",
    ]);
    assert.deepEqual(e.warnings, []);
    const testing = e.items.find((i) => i.name === "testing")!;
    assert.deepEqual(testing.chains.map((c) => c.path), [["perl"], ["perl", "base"]]);
  } finally {
    cleanup();
  }
});

test("expandBundle: a missing name and a pattern that matches nothing each warn once", () => {
  const { cat, cleanup } = catalogOf({
    "rules/r1.md": item("r1"),
    "bundles/b.yaml": "description: B\nrules: [r1, ghost, \"zz-*\"]\n",
  });
  try {
    const e = expandBundle(cat, "b");
    assert.deepEqual(members(e), ["rule:r1"]);
    assert.equal(e.warnings.length, 2);
    assert.deepEqual(e.warnings.map((w) => w.bundle), ["b", "b"]);
    assert.match(e.warnings[0]!.message, /ghost/);
    assert.match(e.warnings[1]!.message, /zz-\*/);
  } finally {
    cleanup();
  }
});

test("expandBundle errors: missing bundle, broken nested bundle, cycle named in full", () => {
  const { cat, cleanup } = catalogOf({
    "rules/r1.md": item("r1"),
    "bundles/a.yaml": "description: A\nbundles: [b]\n",
    "bundles/b.yaml": "description: B\nbundles: [c]\n",
    "bundles/c.yaml": "description: C\nbundles: [a]\n",
    "bundles/outer.yaml": "description: O\nrules: [r1]\nbundles: [broken]\n",
    "bundles/broken.yaml": "nope: 1\n",
    "bundles/dangling.yaml": "description: D\nbundles: [ghost]\n",
  });
  try {
    assert.throws(() => expandBundle(cat, "nope"), (e: unknown) => e instanceof BundleError && /not found/.test((e as Error).message));
    assert.throws(() => expandBundle(cat, "a"), /cycle a → b → c → a/);
    assert.throws(() => expandBundle(cat, "outer"), /broken/);
    assert.throws(() => expandBundle(cat, "dangling"), /ghost/);
  } finally {
    cleanup();
  }
});

test("expandBundle: a diamond is not a cycle", () => {
  const { cat, cleanup } = catalogOf({
    "rules/r1.md": item("r1"),
    "bundles/top.yaml": "description: T\nbundles: [l, r]\n",
    "bundles/l.yaml": "description: L\nbundles: [d]\n",
    "bundles/r.yaml": "description: R\nbundles: [d]\n",
    "bundles/d.yaml": "description: D\nrules: [r1]\n",
  });
  try {
    const e = expandBundle(cat, "top");
    assert.deepEqual(members(e), ["rule:r1"]);
    assert.deepEqual(e.items[0]!.chains.map((c) => c.path), [["top", "l", "d"], ["top", "r", "d"]]);
  } finally {
    cleanup();
  }
});

test("expandBundle: chain vars, the outer bundle wins over the included one; setters are recorded", () => {
  const { cat, cleanup } = catalogOf({
    "rules/r1.md": item("r1"),
    "bundles/perl.yaml": "description: P\nbundles: [base]\nvars:\n  v: outer\n",
    "bundles/base.yaml": "description: B\nrules: [r1]\nvars:\n  v: inner\n  w: base-only\n",
  });
  try {
    const chain = expandBundle(cat, "perl").items[0]!.chains[0]!;
    assert.deepEqual(chain.vars, { v: "outer", w: "base-only" });
    assert.deepEqual(chain.setters, { v: "perl", w: "base" });
  } finally {
    cleanup();
  }
});

test("expandBundle: an entry of another source is skipped with a not-supported-yet warning (phase A)", () => {
  const { cat, cleanup } = catalogOf({
    "rules/r1.md": item("r1"),
    "bundles/b.yaml": "description: B\nrules: [r1, x@Getty]\n",
  });
  try {
    const e = expandBundle(cat, "b");
    assert.deepEqual(members(e), ["rule:r1"]);
    assert.equal(e.warnings.length, 1);
    assert.match(e.warnings[0]!.message, /rule:x@Getty/);
    assert.match(e.warnings[0]!.message, /not supported yet/);
  } finally {
    cleanup();
  }
});
