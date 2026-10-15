// Tests for scanning a source layout into a catalog (spec §4.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { scan, CatalogError } from "../src/catalog.ts";
import { NO_SYMLINKS } from "./helpers/symlink.ts";

/** Build a representative source tree; returns its dir. */
function makeSource(): { dir: string; cleanup: () => void } {
  const tmp = makeTmpDir();
  const dir = tmp.dir;
  const put = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  put("skills/perl-moo/SKILL.md", "---\nname: perl-moo\ndescription: Perl Moo helper\n---\nbody\n");
  put("skills/perl-moo/reference.md", "companion file\n");
  put("skills/tmpl/SKILL.md.njk", "---\nname: tmpl\ndescription: A template skill\n---\n{{ oops }} {% raw %}\n");
  put("agents/karr.md", "---\nname: karr\ndescription: Kanban agent\n---\nprompt\n");
  put("agents/gen.md.njk", "---\ndescription: Generated agent\n---\n{{ x }}\n");
  put("rules/commit-style.md", "---\ndescription: Commit style rule\n---\nrule\n");
  put("snippets/shared.md", "not installable\n");
  put("skilletor.json", JSON.stringify({ description: "Getty skills", vars: { kubernetes: true } }));
  return { dir, cleanup: () => tmp.cleanup() };
}

test("scans all three types with names and descriptions", () => {
  const src = makeSource();
  try {
    const cat = scan(src.dir);
    const byKey = new Map(cat.items.map((i) => [`${i.type}:${i.name}`, i]));
    assert.equal(byKey.get("skill:perl-moo")?.description, "Perl Moo helper");
    assert.equal(byKey.get("skill:tmpl")?.description, "A template skill");
    assert.equal(byKey.get("agent:karr")?.description, "Kanban agent");
    assert.equal(byKey.get("agent:gen")?.description, "Generated agent");
    assert.equal(byKey.get("rule:commit-style")?.description, "Commit style rule");
  } finally {
    src.cleanup();
  }
});

test("a skill item includes its companion files", () => {
  const src = makeSource();
  try {
    const cat = scan(src.dir);
    const skill = cat.items.find((i) => i.name === "perl-moo");
    assert.deepEqual(
      skill?.files.slice().sort(),
      ["skills/perl-moo/SKILL.md", "skills/perl-moo/reference.md"].sort(),
    );
  } finally {
    src.cleanup();
  }
});

test("agent/rule items carry just their single file, njk extension preserved", () => {
  const src = makeSource();
  try {
    const cat = scan(src.dir);
    assert.deepEqual(cat.items.find((i) => i.name === "gen")?.files, ["agents/gen.md.njk"]);
    assert.deepEqual(cat.items.find((i) => i.name === "karr")?.files, ["agents/karr.md"]);
  } finally {
    src.cleanup();
  }
});

test("frontmatter of a .njk item is read raw, not rendered", () => {
  const src = makeSource();
  try {
    // If rendering were attempted, {{ oops }} with throwOnUndefined would blow up.
    const cat = scan(src.dir);
    assert.equal(cat.items.find((i) => i.name === "tmpl")?.description, "A template skill");
  } finally {
    src.cleanup();
  }
});

test("snippets/ is not installable", () => {
  const src = makeSource();
  try {
    const cat = scan(src.dir);
    assert.equal(cat.items.some((i) => i.name === "shared"), false);
  } finally {
    src.cleanup();
  }
});

test("source skilletor.json is read for description and var defaults", () => {
  const src = makeSource();
  try {
    const cat = scan(src.dir);
    assert.equal(cat.meta.description, "Getty skills");
    assert.deepEqual(cat.meta.vars, { kubernetes: true });
  } finally {
    src.cleanup();
  }
});

test("missing or empty type directories are fine", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills"), { recursive: true }); // empty
    // no agents/ or rules/ at all
    const cat = scan(tmp.dir);
    assert.equal(cat.items.length, 0);
    assert.deepEqual(cat.meta, {});
  } finally {
    tmp.cleanup();
  }
});

test("a symlink in the source is rejected", { skip: NO_SYMLINKS }, () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills", "real"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills", "real", "SKILL.md"), "---\ndescription: x\n---\n");
    symlinkSync(join(tmp.dir, "skills", "real"), join(tmp.dir, "skills", "link"));
    assert.throws(() => scan(tmp.dir), (e: unknown) => {
      assert.ok(e instanceof CatalogError);
      assert.match((e as Error).message, /symlink/i);
      return true;
    });
  } finally {
    tmp.cleanup();
  }
});

// k100: `agents/x.md` and `agents/x.md.njk` (or the same under `rules/`) are one name twice.
// Asserts: the scan does not fail; that name is one item of its type carrying an error that
// names both files (the bundle `.yaml`/`.yml` shape, spec §15.4); every other item – another
// type's `x` included – is intact; a `.claude/` item of that name does not step in; and the
// `.claude/` scan still dedupes its own pair silently (the first file wins).
test("k100: x.md beside x.md.njk is one item carrying an error naming both, the scan goes on", () => {
  const tmp = makeTmpDir();
  const put = (rel: string, content: string) => {
    mkdirSync(join(tmp.dir, rel, ".."), { recursive: true });
    writeFileSync(join(tmp.dir, rel), content);
  };
  try {
    put("agents/x.md", "---\ndescription: plain\n---\nA\n");
    put("agents/x.md.njk", "---\ndescription: template\n---\n{{ oops }}\n");
    put("agents/ok.md", "---\ndescription: fine\n---\nOK\n");
    put("rules/y.md.njk", "---\ndescription: t\n---\nY\n");
    put("rules/y.md", "---\ndescription: p\n---\nY\n");
    put("skills/x/SKILL.md", "---\ndescription: a skill named x\n---\nS\n");
    put(".claude/agents/x.md", "---\ndescription: project copy\n---\nC\n");
    put(".claude/rules/z.md", "---\ndescription: z plain\n---\nZ\n");
    put(".claude/rules/z.md.njk", "---\ndescription: z template\n---\nZ\n");
    const cat = scan(tmp.dir);
    const rows = cat.items
      .map((i) => [`${i.type}:${i.name}`, i.files, i.error, i.description] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(rows, [
      ["agent:ok", ["agents/ok.md"], undefined, "fine"],
      ["agent:x", ["agents/x.md", "agents/x.md.njk"], "both agents/x.md and agents/x.md.njk exist", undefined],
      ["rule:y", ["rules/y.md", "rules/y.md.njk"], "both rules/y.md and rules/y.md.njk exist", undefined],
      ["rule:z", [".claude/rules/z.md"], undefined, "z plain"],
      ["skill:x", ["skills/x/SKILL.md"], undefined, "a skill named x"],
    ]);
  } finally {
    tmp.cleanup();
  }
});

// k113: inside one skill, `f` beside `f.njk` both install as `f` – one file, twice. Asserts: the
// scan does not fail; such a skill is one item carrying an error naming both source files, in
// the published `skills/` layout, a plugin.json skill and a `.claude/skills/` skill alike (in
// `.claude/` too: one skill directory has no "which item wins" question); several pairs are all
// named, in sorted order; a skill whose SKILL.md is in a pair has no description, one whose
// clash is a companion keeps SKILL.md's; its files are all still listed; `f.njk` beside
// `f.njk.njk` is no clash (they install as `f` and `f.njk`); a broken skill still counts as
// found, so a `.claude/` skill of that name does not step in; every other item is intact.
test("k113: a skill with f beside f.njk carries an error naming both, the scan goes on", () => {
  const tmp = makeTmpDir();
  const put = (rel: string, content: string) => {
    mkdirSync(join(tmp.dir, rel, ".."), { recursive: true });
    writeFileSync(join(tmp.dir, rel), content);
  };
  try {
    put("skills/both/SKILL.md", "---\ndescription: plain\n---\nA\n");
    put("skills/both/SKILL.md.njk", "---\ndescription: template\n---\n{{ oops }}\n");
    put("skills/script/SKILL.md", "---\ndescription: runs x\n---\nRun scripts/x.sh\n");
    put("skills/script/scripts/x.sh", "#!/bin/sh\necho plain\n");
    put("skills/script/scripts/x.sh.njk", "#!/bin/sh\necho {{ vars.y }}\n");
    put("skills/multi/a.sh.njk", "A\n");
    put("skills/multi/a.sh", "A\n");
    put("skills/multi/SKILL.md.njk", "---\ndescription: t\n---\nM\n");
    put("skills/multi/SKILL.md", "---\ndescription: p\n---\nM\n");
    put("skills/ok/SKILL.md.njk", "---\ndescription: ok\n---\nOK\n");
    put("skills/ok/data.njk", "{{ 1 }}\n");
    put("skills/ok/data.njk.njk", "{{ 2 }}\n");
    put(".claude-plugin/plugin.json", JSON.stringify({ skills: ["extra/p"] }));
    put("extra/p/SKILL.md", "---\ndescription: p plain\n---\nP\n");
    put("extra/p/SKILL.md.njk", "---\ndescription: p template\n---\nP\n");
    put(".claude/skills/both/SKILL.md", "---\ndescription: project copy\n---\nC\n");
    put(".claude/skills/c/SKILL.md", "---\ndescription: c skill\n---\nC\n");
    put(".claude/skills/c/scripts/x.sh", "plain\n");
    put(".claude/skills/c/scripts/x.sh.njk", "template\n");
    const cat = scan(tmp.dir);
    const rows = cat.items
      .map((i) => [`${i.type}:${i.name}`, i.files, i.error, i.description] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(rows, [
      ["skill:both", ["skills/both/SKILL.md", "skills/both/SKILL.md.njk"],
        "both skills/both/SKILL.md and skills/both/SKILL.md.njk exist", undefined],
      ["skill:c", [".claude/skills/c/SKILL.md", ".claude/skills/c/scripts/x.sh", ".claude/skills/c/scripts/x.sh.njk"],
        "both .claude/skills/c/scripts/x.sh and .claude/skills/c/scripts/x.sh.njk exist", "c skill"],
      ["skill:multi", ["skills/multi/SKILL.md", "skills/multi/SKILL.md.njk", "skills/multi/a.sh", "skills/multi/a.sh.njk"],
        "both skills/multi/SKILL.md and skills/multi/SKILL.md.njk exist; both skills/multi/a.sh and skills/multi/a.sh.njk exist",
        undefined],
      ["skill:ok", ["skills/ok/SKILL.md.njk", "skills/ok/data.njk", "skills/ok/data.njk.njk"], undefined, "ok"],
      ["skill:p", ["extra/p/SKILL.md", "extra/p/SKILL.md.njk"], "both extra/p/SKILL.md and extra/p/SKILL.md.njk exist", undefined],
      ["skill:script", ["skills/script/SKILL.md", "skills/script/scripts/x.sh", "skills/script/scripts/x.sh.njk"],
        "both skills/script/scripts/x.sh and skills/script/scripts/x.sh.njk exist", "runs x"],
    ]);
  } finally {
    tmp.cleanup();
  }
});

// k135: k127 made names equal ignoring case one name for a source's `path` alone. The default
// layout on Linux could still offer skills/Foo beside skills/foo, agents/Bar.md beside
// agents/bar.md.njk, and plugin.json and .claude/ dropped exact-name duplicates only, so two
// items installed into one directory on macOS and Windows and a lock differed per platform.
// Asserts (maintainer, 2026-10-15): within one catalog such a group is the duplicate-name error
// of its context – in skills/, agents/ and rules/ each spelling is an item carrying an error
// naming every directory or file in sorted order (k100's and k127's wording, "names equal
// ignoring case" added), its files the group's; plugin.json, whose own list it is, fails the
// scan; a .claude/ item whose name ignoring case is already found is skipped silently, and two
// .claude/ spellings are the item error; other types and other names are offered as before.
function caseSource(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const tmp = makeTmpDir();
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(tmp.dir, rel, ".."), { recursive: true });
    writeFileSync(join(tmp.dir, rel), content);
  }
  return { dir: tmp.dir, cleanup: () => tmp.cleanup() };
}
const ITEM = (n: string) => `---\ndescription: ${n}\n---\nbody\n`;
const caseRows = (dir: string) => scan(dir).items
  .map((i) => [`${i.type}:${i.name}`, i.error ?? null, i.dir ?? null, i.files] as const)
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

test("k135: names equal ignoring case in skills/, agents/ and rules/ are an error of each spelling", () => {
  const s = caseSource({
    "skills/Foo/SKILL.md": ITEM("Foo"), "skills/foo/SKILL.md": ITEM("foo"), "skills/ok/SKILL.md": ITEM("ok"),
    "agents/Bar.md": ITEM("Bar"), "agents/bar.md.njk": ITEM("bar"), "agents/x.md": ITEM("x"), "agents/r.md": ITEM("r"),
    "agents/Q.md": ITEM("Q"), "agents/q.md": ITEM("q"), "agents/q.md.njk": ITEM("q"),
    "rules/R.md": ITEM("R"), "rules/r.md": ITEM("r"),
  });
  try {
    const skills = "found in 2 directories, names equal ignoring case: skills/Foo and skills/foo";
    const bar = "both agents/Bar.md and agents/bar.md.njk exist, names equal ignoring case";
    const q = "agents/Q.md, agents/q.md and agents/q.md.njk exist, names equal ignoring case";
    const rules = "both rules/R.md and rules/r.md exist, names equal ignoring case";
    const skillFiles = ["skills/Foo/SKILL.md", "skills/foo/SKILL.md"];
    assert.deepEqual(caseRows(s.dir), [
      ["agent:Bar", bar, null, ["agents/Bar.md", "agents/bar.md.njk"]],
      ["agent:Q", q, null, ["agents/Q.md", "agents/q.md", "agents/q.md.njk"]],
      ["agent:bar", bar, null, ["agents/Bar.md", "agents/bar.md.njk"]],
      ["agent:q", q, null, ["agents/Q.md", "agents/q.md", "agents/q.md.njk"]],
      ["agent:r", null, null, ["agents/r.md"]],
      ["agent:x", null, null, ["agents/x.md"]],
      ["rule:R", rules, null, ["rules/R.md", "rules/r.md"]],
      ["rule:r", rules, null, ["rules/R.md", "rules/r.md"]],
      ["skill:Foo", skills, null, skillFiles],
      ["skill:foo", skills, null, skillFiles],
      ["skill:ok", null, "skills/ok", ["skills/ok/SKILL.md"]],
    ]);
  } finally {
    s.cleanup();
  }
});

test("k135: plugin.json fails the scan on a name found ignoring case; .claude/ skips it or makes it an item error", () => {
  const plugin = caseSource({
    "skills/foo/SKILL.md": ITEM("foo"), "extra/Foo/SKILL.md": ITEM("Foo"),
    ".claude-plugin/plugin.json": JSON.stringify({ skills: ["extra/Foo"] }),
  });
  try {
    assert.throws(() => scan(plugin.dir), (e: unknown) => {
      assert.ok(e instanceof CatalogError, String(e));
      assert.equal((e as Error).message, `${join(plugin.dir, ".claude-plugin", "plugin.json")}: skill "Foo" found twice, ` +
        `names equal ignoring case: skills/foo and extra/Foo`);
      return true;
    });
  } finally {
    plugin.cleanup();
  }
  const claude = caseSource({
    "skills/foo/SKILL.md": ITEM("foo"), "agents/k.md": ITEM("k"),
    ".claude/skills/Foo/SKILL.md": ITEM("Foo"), ".claude/agents/K.md": ITEM("K"),
    ".claude/skills/Baz/SKILL.md": ITEM("Baz"), ".claude/skills/baz/SKILL.md": ITEM("baz"),
    ".claude/agents/A.md": ITEM("A"), ".claude/agents/a.md": ITEM("a"),
    ".claude/rules/m.md": ITEM("m"), ".claude/rules/m.md.njk": ITEM("m"),
  });
  try {
    const baz = "found in 2 directories, names equal ignoring case: .claude/skills/Baz and .claude/skills/baz";
    const a = "both .claude/agents/A.md and .claude/agents/a.md exist, names equal ignoring case";
    assert.deepEqual(caseRows(claude.dir), [
      ["agent:A", a, null, [".claude/agents/A.md", ".claude/agents/a.md"]],
      ["agent:a", a, null, [".claude/agents/A.md", ".claude/agents/a.md"]],
      ["agent:k", null, null, ["agents/k.md"]],
      ["rule:m", null, ".claude/rules", [".claude/rules/m.md"]],
      ["skill:Baz", baz, null, [".claude/skills/Baz/SKILL.md", ".claude/skills/baz/SKILL.md"]],
      ["skill:baz", baz, null, [".claude/skills/Baz/SKILL.md", ".claude/skills/baz/SKILL.md"]],
      ["skill:foo", null, "skills/foo", ["skills/foo/SKILL.md"]],
    ]);
  } finally {
    claude.cleanup();
  }
});
