// Cross-cutting security suite (spec §9). Collects the attack cases in one place,
// on top of the per-module tests. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import { scan, CatalogError } from "../src/catalog.ts";
import { build, RenderError, type RenderContext } from "../src/render.ts";
import { apply, ApplyError, type PlanItem } from "../src/apply.ts";
import { GitSource } from "../src/sources/git.ts";
import { UrlSource } from "../src/sources/url.ts";
import { State } from "../src/state.ts";
import { sync, check, type EngineContext } from "../src/engine.ts";

function ctx(vars: Record<string, unknown> = {}): RenderContext {
  return {
    vars,
    scope: "user",
    harness: "claude",
    target: { dir: "/t" },
    host: { name: "h", os: "linux" },
    user: { name: "u", home: "/home/u" },
    item: { name: "x", type: "skill", source: "s" },
  };
}

// ---- config type table ------------------------------------------------------

test("config cannot address non-item types like hooks or settings", () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp.dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/skilletor.json"), JSON.stringify({ install: { hooks: ["evil@x"] } }));
    assert.throws(() => loadConfig({ home }), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match((e as Error).message, /not a valid type/i);
      return true;
    });
  } finally {
    tmp.cleanup();
  }
});

// ---- templating hardening ---------------------------------------------------

test("the template context has no env.* (undefined -> error)", () => {
  const tmp = makeTmpDir();
  try {
    const d = join(tmp.dir, "skills", "x");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md.njk"), "{{ env.SECRET }}");
    const item = { type: "skill" as const, name: "x", files: ["skills/x/SKILL.md.njk"] };
    assert.throws(() => build(item, tmp.dir, ctx()), (e: unknown) => e instanceof RenderError);
  } finally {
    tmp.cleanup();
  }
});

test("an include cannot escape the source root", () => {
  const tmp = makeTmpDir();
  try {
    const d = join(tmp.dir, "skills", "x");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md.njk"), '{% include "../../../../etc/hostname" %}');
    const item = { type: "skill" as const, name: "x", files: ["skills/x/SKILL.md.njk"] };
    assert.throws(() => build(item, tmp.dir, ctx()), (e: unknown) => e instanceof RenderError);
  } finally {
    tmp.cleanup();
  }
});

// ---- apply hardening --------------------------------------------------------

test("apply rejects an item name with path traversal", () => {
  const tmp = makeTmpDir();
  try {
    const item: PlanItem = { key: "skills/x", type: "skill", name: "../evil", source: "s", version: "v", output: new Map() };
    assert.throws(() => apply([item], { targetDir: tmp.dir }), (e: unknown) => e instanceof ApplyError);
  } finally {
    tmp.cleanup();
  }
});

test("apply rejects an output path that escapes the target", () => {
  const tmp = makeTmpDir();
  try {
    const item: PlanItem = {
      key: "skills/x", type: "skill", name: "x", source: "s", version: "v",
      output: new Map([["../escape.txt", Buffer.from("pwn")]]),
    };
    assert.throws(() => apply([item], { targetDir: tmp.dir }), (e: unknown) => e instanceof ApplyError);
    assert.equal(existsSync(join(tmp.dir, "..", "escape.txt")), false);
  } finally {
    tmp.cleanup();
  }
});

// ---- symlink rejection across source kinds ----------------------------------

test("a symlink in a local source is rejected", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills", "x"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/x/SKILL.md"), "---\ndescription: x\n---\n");
    symlinkSync("/etc/passwd", join(tmp.dir, "skills/x/leak"));
    assert.throws(() => scan(tmp.dir), (e: unknown) => e instanceof CatalogError);
  } finally {
    tmp.cleanup();
  }
});

test("a symlink committed in a git source is rejected after resolve", async () => {
  const tmp = makeTmpDir();
  try {
    const G = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    const bare = join(tmp.dir, "r.git");
    const work = join(tmp.dir, "w");
    execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
    mkdirSync(join(work, "skills", "x"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
    writeFileSync(join(work, "skills/x/SKILL.md"), "---\ndescription: x\n---\n");
    symlinkSync("/etc/passwd", join(work, "skills/x/leak"));
    execFileSync("git", ["add", "."], { cwd: work, env: { ...process.env, ...G } });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: work, env: { ...process.env, ...G } });
    execFileSync("git", ["push", "-q", "file://" + resolvePath(bare), "main"], { cwd: work, env: { ...process.env, ...G } });

    const src = new GitSource({ url: "file://" + resolvePath(bare), cacheRoot: join(tmp.dir, "cache") });
    const loc = await src.resolve();
    assert.throws(() => scan(loc.dir), (e: unknown) => e instanceof CatalogError);
  } finally {
    tmp.cleanup();
  }
});

// ---- url transport hardening ------------------------------------------------

test("a url source rejects non-https in production", async () => {
  const tmp = makeTmpDir();
  try {
    const src = new UrlSource({ url: "http://example.com/s.tar.gz", cacheRoot: tmp.dir });
    await assert.rejects(() => src.resolve(), /https/i);
  } finally {
    tmp.cleanup();
  }
});

// ---- trust: untrusted sources are never fetched -----------------------------

function engineEnv() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ectx: EngineContext = { home, projectDir, stateRoot: join(tmp.dir, "state"), host: { name: "h", os: "linux" }, user: { name: "u", home }, markers: claudeOnly(home) };
  return { tmp, ectx, home, projectDir, cleanup: () => tmp.cleanup() };
}

test("an untrusted project source is never fetched — not by sync, not by check", async () => {
  const e = engineEnv();
  try {
    // A git URL that would fail loudly if ever contacted.
    writeFileSync(
      join(e.projectDir, ".claude/skilletor.json"),
      JSON.stringify({ sources: { team: { git: "file:///definitely/not/here.git" } }, install: { skills: ["x@team"] } }),
    );
    const chk = await check(e.ectx, { scope: "project" });
    assert.equal(chk.sources.some((s) => s.name === "team"), false); // skipped, not checked
    assert.equal(chk.warnings.some((w) => /team/.test(w)), false); // no fetch attempted

    const report = await sync(e.ectx, { scope: "project" });
    assert.deepEqual(report.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/x")), false);
  } finally {
    e.cleanup();
  }
});

test("trust lapses when a project source's URL changes", async () => {
  const e = engineEnv();
  try {
    new State(e.ectx.stateRoot).trust("team", "https://github.com/Getty/skills");
    writeFileSync(
      join(e.projectDir, ".claude/skilletor.json"),
      JSON.stringify({ sources: { team: { git: "https://evil.example/skills" } }, install: { skills: ["x@team"] } }),
    );
    const report = await sync(e.ectx, { scope: "project" });
    assert.deepEqual(report.scopes[0]!.trustRequests.map((t) => t.name), ["team"]); // no longer trusted
  } finally {
    e.cleanup();
  }
});

// ---- ownership: foreign files are safe --------------------------------------

test("a foreign target file is never overwritten or deleted without --force", () => {
  const tmp = makeTmpDir();
  try {
    mkdirSync(join(tmp.dir, "skills", "x"), { recursive: true });
    writeFileSync(join(tmp.dir, "skills/x/SKILL.md"), "MINE");
    const item: PlanItem = {
      key: "skills/x", type: "skill", name: "x", source: "s", version: "v",
      output: new Map([["skills/x/SKILL.md", Buffer.from("SOURCE")]]),
    };
    const res = apply([item], { targetDir: tmp.dir });
    assert.equal(res.conflicts.length, 1);
    // Untouched, and a second empty sync must not delete it either.
    apply([], { targetDir: tmp.dir });
    assert.equal(existsSync(join(tmp.dir, "skills/x/SKILL.md")), true);
  } finally {
    tmp.cleanup();
  }
});
