// k144: oddities the Perl port found in the reference (docs/perl.md, conformance/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { scan } from "../src/catalog.ts";
import { loadConfig, ConfigError, removeInstallEntries, findInstallEntries } from "../src/config.ts";
import { BundleError, parseBundle } from "../src/bundles.ts";
import { resolveSpec, SpecError } from "../src/spec.ts";

test("k144: a CRLF or BOM-prefixed item file keeps its description", () => {
  const tmp = makeTmpDir();
  try {
    const put = (rel: string, content: string) => {
      const p = join(tmp.dir, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    };
    put("skills/crlf/SKILL.md", "---\r\nname: crlf\r\ndescription: With CRLF\r\n---\r\nbody\r\n");
    put("skills/bom/SKILL.md", "﻿---\nname: bom\ndescription: With BOM\n---\nbody\n");
    put("agents/both.md", "﻿---\r\ndescription: Both\r\n---\r\nbody\r\n");
    const byName = new Map(scan(tmp.dir).items.map((i) => [i.name, i.description]));
    assert.equal(byName.get("crlf"), "With CRLF");
    assert.equal(byName.get("bom"), "With BOM");
    assert.equal(byName.get("both"), "Both");
  } finally {
    tmp.cleanup();
  }
});

test("k144: a bundle escape above U+10FFFF is that bundle's error, not a crash", () => {
  assert.throws(() => parseBundle('description: "x\\U00110000"\n'), BundleError);
  assert.throws(() => parseBundle('description: "x\\UFFFFFFFF"\n'), BundleError);
  assert.equal(parseBundle('description: "x\\U0010FFFF"\n').description, "x\u{10FFFF}");
});

function configFiles(user: string) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "skilletor.json"), user);
  return { home, path: join(home, ".claude", "skilletor.json"), cleanup: () => tmp.cleanup() };
}

test("k144: install keys inherited from Object.prototype are not types", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const c = configFiles(`{"sources":{"s":{"git":"https://x"}},"install":{"${key}":["a@s"]}}`);
    try {
      assert.throws(() => loadConfig({ home: c.home }), (err: Error) =>
        err instanceof ConfigError && err.message.includes(`install.${key} is not a valid type`));
    } finally {
      c.cleanup();
    }
  }
});

test("k144: an inherited property is no forge", () => {
  const probe = () => ({ git: false, tarball: false });
  assert.throws(() => resolveSpec("__proto__/x", probe), SpecError);
  assert.notEqual(resolveSpec("constructor/foo", probe).value, "https://constructor/foo/skills");
  assert.doesNotThrow(() => resolveSpec("https://constructor/foo/bar.git", probe));
});

test("k144: editing a config with a non-string install entry does not throw", () => {
  const c = configFiles('{"sources":{"s":{"git":"https://x"}},"install":{"skills":[5,"a@s",null]}}');
  try {
    assert.equal(removeInstallEntries(c.path, "a", "s"), 1);
    assert.deepEqual(findInstallEntries(c.path, "a", "s"), []);
  } finally {
    c.cleanup();
  }
});
