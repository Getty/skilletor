// Tests for building an item in memory (spec §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { build, RenderError, type RenderContext } from "../src/render.ts";
import type { CatalogItem } from "../src/catalog.ts";

function ctx(vars: Record<string, unknown>): RenderContext {
  return {
    vars,
    scope: "project",
    target: { dir: "/tmp/target" },
    host: { name: "box", os: "linux" },
    user: { name: "getty", home: "/home/getty" },
    item: { name: "demo", type: "skill", source: "shared" },
  };
}

function put(dir: string, rel: string, content: string | Buffer): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

test("renders variables, if/for and includes/macros from the source root", () => {
  const tmp = makeTmpDir();
  try {
    put(tmp.dir, "snippets/shared.md", "SHARED-SNIPPET");
    put(tmp.dir, "snippets/macros.njk", "{% macro hi(n) %}hi {{ n }}{% endmacro %}");
    put(
      tmp.dir,
      "skills/demo/SKILL.md.njk",
      [
        "{% import \"snippets/macros.njk\" as m %}",
        "foo={{ vars.foo }}",
        "{% if vars.k %}K-ON{% endif %}",
        "{% for x in vars.list %}[{{ x }}]{% endfor %}",
        "{% include \"snippets/shared.md\" %}",
        "{{ m.hi(\"there\") }}",
      ].join("\n"),
    );
    const item: CatalogItem = {
      type: "skill",
      name: "demo",
      files: ["skills/demo/SKILL.md.njk"],
    };
    const out = build(item, tmp.dir, ctx({ foo: "bar", k: true, list: [1, 2] }));
    const md = out.get("skills/demo/SKILL.md")!.toString("utf8");
    assert.match(md, /foo=bar/);
    assert.match(md, /K-ON/);
    assert.match(md, /\[1\]\[2\]/);
    assert.match(md, /SHARED-SNIPPET/);
    assert.match(md, /hi there/);
    assert.equal(out.has("skills/demo/SKILL.md.njk"), false); // .njk stripped
  } finally {
    tmp.cleanup();
  }
});

test("a non-.njk file with {{ }} is copied unchanged", () => {
  const tmp = makeTmpDir();
  try {
    put(tmp.dir, "skills/demo/notes.md", "literal {{ vars.foo }} stays");
    const item: CatalogItem = { type: "skill", name: "demo", files: ["skills/demo/notes.md"] };
    const out = build(item, tmp.dir, ctx({ foo: "bar" }));
    assert.equal(out.get("skills/demo/notes.md")!.toString("utf8"), "literal {{ vars.foo }} stays");
  } finally {
    tmp.cleanup();
  }
});

test("a binary companion file stays byte-identical", () => {
  const tmp = makeTmpDir();
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x42]);
    put(tmp.dir, "skills/demo/logo.png", bytes);
    const item: CatalogItem = { type: "skill", name: "demo", files: ["skills/demo/logo.png"] };
    const out = build(item, tmp.dir, ctx({}));
    assert.deepEqual(out.get("skills/demo/logo.png"), bytes);
  } finally {
    tmp.cleanup();
  }
});

test("an undefined variable is an error", () => {
  const tmp = makeTmpDir();
  try {
    put(tmp.dir, "skills/demo/SKILL.md.njk", "{{ vars.missing }}");
    const item: CatalogItem = { type: "skill", name: "demo", files: ["skills/demo/SKILL.md.njk"] };
    assert.throws(() => build(item, tmp.dir, ctx({})), (e: unknown) => {
      assert.ok(e instanceof RenderError);
      assert.match((e as Error).message, /SKILL\.md\.njk/);
      return true;
    });
  } finally {
    tmp.cleanup();
  }
});

test("an include escaping the source root is rejected", () => {
  const tmp = makeTmpDir();
  try {
    put(tmp.dir, "skills/demo/SKILL.md.njk", '{% include "../../../etc/passwd" %}');
    const item: CatalogItem = { type: "skill", name: "demo", files: ["skills/demo/SKILL.md.njk"] };
    assert.throws(() => build(item, tmp.dir, ctx({})), (e: unknown) => {
      assert.ok(e instanceof RenderError);
      return true;
    });
  } finally {
    tmp.cleanup();
  }
});

test("project.* is available in project scope", () => {
  const tmp = makeTmpDir();
  try {
    put(tmp.dir, "agents/a.md.njk", "in {{ project.name }}");
    const item: CatalogItem = { type: "agent", name: "a", files: ["agents/a.md.njk"] };
    const context = ctx({});
    context.project = { dir: "/p", name: "myproj" };
    const out = build(item, tmp.dir, context);
    assert.equal(out.get("agents/a.md")!.toString("utf8"), "in myproj");
  } finally {
    tmp.cleanup();
  }
});
