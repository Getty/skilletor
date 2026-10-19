// k145: CLAUDE_CONFIG_DIR is the user scope's `.claude` – config, lock, roots, detection,
// briefing lookup – as Claude Code itself reads it; an empty value is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { sync, targetDirOf, type EngineContext } from "../src/engine.ts";
import { loadConfig } from "../src/config.ts";
import { defaultMarkers } from "../src/targets.ts";
import { skillRoots } from "../src/briefing.ts";

function put(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const alt = join(tmp.dir, "alt-config");
  const src = join(tmp.dir, "src");
  put(join(src, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nbody\n");
  put(join(home, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["decoy@nowhere"] } }));
  put(join(alt, "skilletor.json"), JSON.stringify({ sources: { s: { local: src } }, install: { skills: ["demo@s"] } }));
  put(join(alt, ".claude.json"), "{}\n"); // Claude Code's marker inside a custom config dir
  const ctx: EngineContext = {
    home, stateRoot: join(alt, "skilletor"), codexHome: join(home, ".no-codex"), isGitWorkTree: () => false,
  };
  return { tmp, home, alt, ctx };
}

test("k145: the user scope lives under CLAUDE_CONFIG_DIR: config, lock, skills, detection", async () => {
  const f = fixture();
  try {
    process.env.CLAUDE_CONFIG_DIR = f.alt;
    // No injected markers: the default detection must look inside the config dir.
    const rep = await sync(f.ctx);
    assert.deepEqual(rep.scopes[0]!.added.map((a) => a.key), ["skills/demo"]);
    assert.equal(readFileSync(join(f.alt, "skills", "demo", "SKILL.md"), "utf8").includes("Demo"), true);
    assert.equal(existsSync(join(f.alt, "skilletor.lock.json")), true);
    assert.equal(existsSync(join(f.home, ".claude", "skilletor.lock.json")), false);
    assert.equal(existsSync(join(f.home, ".claude", "skills")), false);
    assert.equal(targetDirOf(f.ctx, "user"), f.alt);
    // The injected value wins over the environment.
    process.env.CLAUDE_CONFIG_DIR = join(f.tmp.dir, "elsewhere");
    assert.equal(targetDirOf({ ...f.ctx, claudeConfigDir: f.alt }, "user"), f.alt);
    // An empty value is unset.
    process.env.CLAUDE_CONFIG_DIR = "";
    assert.equal(targetDirOf(f.ctx, "user"), join(f.home, ".claude"));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    f.tmp.cleanup();
  }
});

test("k145: without CLAUDE_CONFIG_DIR a marker inside it is not looked for, and ~/.claude is used", () => {
  const f = fixture();
  try {
    assert.throws(() => loadConfig({ home: f.home }), /decoy@nowhere/);
    assert.deepEqual(loadConfig({ home: f.home, claudeConfigDir: f.alt }).user.install.map((i) => i.name), ["demo"]);
    assert.ok(defaultMarkers(f.home, undefined).claude.includes(join(f.home, ".claude.json")));
    assert.deepEqual(defaultMarkers(f.home, undefined, f.alt).claude, [
      join(f.alt, ".claude.json"), join(f.alt, "settings.json"), join(f.alt, "projects"),
    ]);
  } finally {
    f.tmp.cleanup();
  }
});

test("k145: the briefing lookup searches the config dir's skills and plugin cache", () => {
  const f = fixture();
  try {
    put(join(f.alt, "plugins", "cache", "m", "p", "skills", "x", "SKILL.md"), "x");
    const roots = skillRoots("claude", "user", { home: f.home, claudeConfigDir: f.alt });
    assert.equal(roots[0], join(f.alt, "skills"));
    assert.ok(roots.includes(join(f.alt, "plugins", "cache", "m", "skills")));
    assert.ok(roots.includes(join(f.alt, "plugins", "cache", "m", "p", "skills")));
    assert.ok(roots.every((r) => !r.startsWith(join(f.home, ".claude"))));
  } finally {
    f.tmp.cleanup();
  }
});
