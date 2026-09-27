// Tests for scanning a source layout into a catalog (spec §4.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { scan, CatalogError } from "../src/catalog.ts";

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

test("a symlink in the source is rejected", () => {
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
