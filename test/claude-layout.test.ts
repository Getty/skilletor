// A source's Claude project layout as items (spec §4.1, k96): `.claude/skills/<name>/`,
// `.claude/agents/<name>.md[.njk]` and `.claude/rules/<name>.md[.njk]` are offered after
// the published layout and plugin.json skills, best effort, and install where a
// published item of their type does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { scan, type Catalog } from "../src/catalog.ts";
import { check, sync, type EngineContext } from "../src/engine.ts";
import { cmdAvailable, cmdInstall, type CommandContext } from "../src/commands.ts";
import { readLock } from "../src/lock.ts";
import { SKILL_GITIGNORE } from "../src/gitignore.ts";
import type { Harness } from "../src/config.ts";
import { parse as parseToml } from "smol-toml";
import { NO_SYMLINKS } from "./helpers/symlink.ts";

const SKILL = (n: string, body = "BODY") => `---\nname: ${n}\ndescription: ${n} skill\n---\n${body}\n`;
const AGENT = (n: string, body = "prompt") => `---\nname: ${n}\ndescription: ${n} agent\n---\n${body}\n`;
const RULE = (n: string, body = "rule body") => `---\ndescription: ${n} rule\n---\n${body}\n`;

/** App::karr's shape: nothing under skills/, everything in the Claude project layout. */
const KARR: Record<string, string> = {
  ".claude/skills/karr-single-binary/SKILL.md": SKILL("karr-single-binary"),
  ".claude/skills/karr-single-binary/references/pp-recipe.md": "recipe\n",
  ".claude/skills/karr-single-binary/scripts/benchmark.sh": "#!/bin/sh\necho bench\n",
  ".claude/skills/getty-perl-core/SKILL.md": SKILL("getty-perl-core"),
  ".claude/agents/karr-worker.md": AGENT("karr-worker"),
  ".claude/rules/karr-rules.md": RULE("karr-rules", "# karr House Rules\n\nBe careful."),
  ".claude/settings.json": "{}\n",
  "lib/App/karr.pm": "package App::karr;\n1;\n",
};

/** A source dir with the given files (relative path -> content). */
function makeSource(files: Record<string, string>) {
  const tmp = makeTmpDir();
  const dir = join(tmp.dir, "src");
  mkdirSync(dir);
  put(dir, files);
  return { tmp, dir: resolvePath(dir), cleanup: () => tmp.cleanup() };
}

function put(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/** Items as comparable rows: type:name, the dir they live in, their files, description. */
const rows = (cat: Catalog) => cat.items
  .map((i) => ({ key: `${i.type}:${i.name}`, dir: i.dir ?? null, files: i.files, description: i.description ?? null }))
  .sort((a, b) => a.key.localeCompare(b.key));

// ---- catalog ----------------------------------------------------------------------

test("a source with only a .claude tree offers its skills, agents and rules", () => {
  const s = makeSource(KARR);
  try {
    assert.deepEqual(rows(scan(s.dir)), [
      {
        key: "agent:karr-worker", dir: ".claude/agents", files: [".claude/agents/karr-worker.md"],
        description: "karr-worker agent",
      },
      {
        key: "rule:karr-rules", dir: ".claude/rules", files: [".claude/rules/karr-rules.md"],
        description: "karr-rules rule",
      },
      {
        key: "skill:getty-perl-core", dir: ".claude/skills/getty-perl-core",
        files: [".claude/skills/getty-perl-core/SKILL.md"], description: "getty-perl-core skill",
      },
      {
        key: "skill:karr-single-binary", dir: ".claude/skills/karr-single-binary",
        files: [
          ".claude/skills/karr-single-binary/SKILL.md",
          ".claude/skills/karr-single-binary/references/pp-recipe.md",
          ".claude/skills/karr-single-binary/scripts/benchmark.sh",
        ],
        description: "karr-single-binary skill",
      },
    ]);
  } finally {
    s.cleanup();
  }
});

test(".njk items count in .claude as they do in the published layout", () => {
  const s = makeSource({
    ".claude/skills/tmpl/SKILL.md.njk": SKILL("tmpl", "{{ oops }}"),
    ".claude/agents/gen.md.njk": AGENT("gen", "{{ oops }}"),
    ".claude/rules/cond.md.njk": RULE("cond", "{{ oops }}"),
    ".claude/rules/notes.txt": "not an item\n",
  });
  try {
    assert.deepEqual(rows(scan(s.dir)).map((r) => [r.key, r.files, r.description]), [
      ["agent:gen", [".claude/agents/gen.md.njk"], "gen agent"],
      ["rule:cond", [".claude/rules/cond.md.njk"], "cond rule"],
      ["skill:tmpl", [".claude/skills/tmpl/SKILL.md.njk"], "tmpl skill"],
    ]);
  } finally {
    s.cleanup();
  }
});

test("the published layout and plugin.json skills win; a .claude item of a found name is skipped silently", () => {
  const s = makeSource({
    "skills/tdd/SKILL.md": SKILL("tdd"),
    ".claude/skills/tdd/SKILL.md": SKILL("tdd", "installed copy"),
    ".claude/skills/tdd/extra.md": "copy only\n",
    "extra/deep/SKILL.md": SKILL("deep"),
    ".claude/skills/deep/SKILL.md": SKILL("deep", "installed copy"),
    ".claude-plugin/plugin.json": JSON.stringify({ skills: ["extra/deep"] }),
    "agents/a.md": AGENT("a"),
    ".claude/agents/a.md": AGENT("a", "copy"),
    "rules/r.md": RULE("r"),
    ".claude/rules/r.md.njk": RULE("r", "copy"),
    // Another type's name is no clash: names are per type.
    ".claude/agents/tdd.md": AGENT("tdd"),
  });
  try {
    assert.deepEqual(rows(scan(s.dir)).map((r) => [r.key, r.files]), [
      ["agent:a", ["agents/a.md"]],
      ["agent:tdd", [".claude/agents/tdd.md"]],
      ["rule:r", ["rules/r.md"]],
      ["skill:deep", ["extra/deep/SKILL.md"]],
      ["skill:tdd", ["skills/tdd/SKILL.md"]],
    ]);
  } finally {
    s.cleanup();
  }
});

test("plugin.json listing .claude/skills itself: each skill once, from its plugin path", () => {
  const s = makeSource({
    ".claude/skills/one/SKILL.md": SKILL("one"),
    ".claude/skills/two/SKILL.md": SKILL("two"),
    ".claude-plugin/plugin.json": JSON.stringify({ skills: "./.claude/skills" }),
  });
  try {
    assert.deepEqual(rows(scan(s.dir)).map((r) => [r.key, r.dir]), [
      ["skill:one", ".claude/skills/one"],
      ["skill:two", ".claude/skills/two"],
    ]);
  } finally {
    s.cleanup();
  }
});

/** A source that scans today: every published kind, plugin.json, a bundle, skilletor.json. */
const PUBLISHED: Record<string, string> = {
  "skills/perl-moo/SKILL.md": SKILL("perl-moo"),
  "skills/perl-moo/reference.md": "companion\n",
  "skills/tmpl/SKILL.md.njk": SKILL("tmpl", "{{ oops }}"),
  "extra/deep/SKILL.md": SKILL("deep"),
  ".claude-plugin/plugin.json": JSON.stringify({ skills: ["extra/deep"] }),
  "agents/karr.md": AGENT("karr"),
  "rules/commit-style.md": RULE("commit-style"),
  "snippets/shared.md": "include me\n",
  "bundles/perl.yaml": "description: Perl\nskills:\n  - perl-moo\n",
  "skilletor.json": JSON.stringify({ description: "Getty skills", vars: { k: true } }),
};

test("a source scans the same with a .claude tree added whose every item is skipped", { skip: NO_SYMLINKS }, () => {
  const baseline = makeSource(PUBLISHED);
  const outside = makeTmpDir();
  try {
    const expected = scan(baseline.dir);
    put(outside.dir, {
      "evil/SKILL.md": SKILL("evil"),
      "evil.md": AGENT("evil"),
      "rules/evil.md": RULE("evil"),
      "claude/skills/evil/SKILL.md": SKILL("evil"),
    });
    const ext = (rel: string) => join(outside.dir, rel);
    /** Each variant adds a .claude tree to a fresh copy of the source. */
    const variants: Record<string, (dir: string) => void> = {
      "copies of published items": (d) => put(d, {
        ".claude/skills/perl-moo/SKILL.md": SKILL("perl-moo", "copy"),
        ".claude/skills/deep/SKILL.md": SKILL("deep", "copy"),
        ".claude/agents/karr.md": AGENT("karr", "copy"),
        ".claude/rules/commit-style.md": RULE("commit-style", "copy"),
        ".claude/settings.json": "{}\n",
      }),
      "a symlinked skill dir": (d) => {
        mkdirSync(join(d, ".claude/skills"), { recursive: true });
        symlinkSync(ext("evil"), join(d, ".claude/skills/x"));
      },
      "a dangling symlink as a skill": (d) => {
        mkdirSync(join(d, ".claude/skills"), { recursive: true });
        symlinkSync(ext("nowhere"), join(d, ".claude/skills/gone"));
      },
      "a symlinked SKILL.md": (d) => {
        mkdirSync(join(d, ".claude/skills/y"), { recursive: true });
        symlinkSync(ext("evil/SKILL.md"), join(d, ".claude/skills/y/SKILL.md"));
      },
      "a symlink deep inside a skill": (d) => {
        put(d, { ".claude/skills/z/SKILL.md": SKILL("z"), ".claude/skills/z/references/ok.md": "ok\n" });
        symlinkSync(ext("evil.md"), join(d, ".claude/skills/z/references/link.md"));
      },
      "a symlinked agent and rule file": (d) => {
        mkdirSync(join(d, ".claude/agents"), { recursive: true });
        mkdirSync(join(d, ".claude/rules"), { recursive: true });
        symlinkSync(ext("evil.md"), join(d, ".claude/agents/evil.md"));
        symlinkSync(ext("rules/evil.md"), join(d, ".claude/rules/evil.md"));
      },
      "symlinked type dirs": (d) => {
        mkdirSync(join(d, ".claude"), { recursive: true });
        symlinkSync(ext("claude/skills"), join(d, ".claude/skills"));
        symlinkSync(ext("rules"), join(d, ".claude/rules"));
      },
      "a symlinked .claude": (d) => symlinkSync(ext("claude"), join(d, ".claude")),
      "a .claude that is a file": (d) => writeFileSync(join(d, ".claude"), "not a dir\n"),
      "type entries of the wrong kind": (d) => {
        put(d, {
          ".claude/skills/README.md": "a file, no skill\n",
          ".claude/skills/no-skill-md/notes.md": "no SKILL.md\n",
          ".claude/agents/sub/nested.md": AGENT("nested"),
          ".claude/rules/notes.txt": "no .md\n",
        });
        writeFileSync(join(d, ".claude/agents.md"), "a file next to the type dirs\n");
      },
      "type paths that are files": (d) => put(d, { ".claude/skills": "file\n", ".claude/agents": "file\n" }),
    };
    for (const [why, setup] of Object.entries(variants)) {
      const s = makeSource(PUBLISHED);
      try {
        setup(s.dir);
        assert.deepEqual(scan(s.dir), expected, why);
      } finally {
        s.cleanup();
      }
    }
  } finally {
    baseline.cleanup();
    outside.cleanup();
  }
});

test("a .claude item that is skipped leaves its siblings offered", { skip: NO_SYMLINKS }, () => {
  const outside = makeTmpDir();
  const s = makeSource({
    ".claude/skills/ok/SKILL.md": SKILL("ok"),
    ".claude/skills/bad/SKILL.md": SKILL("bad"),
    ".claude/agents/fine.md": AGENT("fine"),
    ".claude/rules/fine.md": RULE("fine"),
  });
  try {
    writeFileSync(join(outside.dir, "secret"), "secret\n");
    symlinkSync(join(outside.dir, "secret"), join(s.dir, ".claude/skills/bad/secret.md"));
    symlinkSync(join(outside.dir, "secret"), join(s.dir, ".claude/agents/linked.md"));
    assert.deepEqual(rows(scan(s.dir)).map((r) => r.key), ["agent:fine", "rule:fine", "skill:ok"]);
  } finally {
    s.cleanup();
    outside.cleanup();
  }
});

test("skilletor's own installed copies in a .claude tree are not offered; a skill's own .gitignore is", () => {
  const s = makeSource({
    // A skill skilletor installed there: its .gitignore is skilletor's (spec §6.4), so a
    // clone never holds it.
    ".claude/skills/installed/SKILL.md": SKILL("installed"),
    ".claude/skills/installed/.gitignore": SKILL_GITIGNORE,
    // An agent and a rule skilletor installed there (`.local.` names, spec §6.4).
    ".claude/agents/.local.installed.md": AGENT("installed"),
    ".claude/rules/.local.installed.md": RULE("installed"),
    // The project's own items; a .gitignore of the skill's own is a file of it.
    ".claude/skills/own/SKILL.md": SKILL("own"),
    ".claude/skills/own/.gitignore": "node_modules/\n",
    ".claude/agents/own.md": AGENT("own"),
    ".claude/rules/own.md": RULE("own"),
  });
  try {
    assert.deepEqual(rows(scan(s.dir)).map((r) => [r.key, r.files]), [
      ["agent:own", [".claude/agents/own.md"]],
      ["rule:own", [".claude/rules/own.md"]],
      ["skill:own", [".claude/skills/own/.gitignore", ".claude/skills/own/SKILL.md"]],
    ]);
  } finally {
    s.cleanup();
  }
});

// ---- through the engine -------------------------------------------------------------

function env(harnesses: Harness[]) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const markerOf = (h: Harness) => join(tmp.dir, `marker-${h}`);
  for (const h of harnesses) writeFileSync(markerOf(h), "");
  const ctx: EngineContext = {
    home,
    projectDir: join(tmp.dir, "proj"),
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: { claude: [markerOf("claude")], codex: [markerOf("codex")] },
    codexHome: join(home, ".codex"),
    isGitWorkTree: () => false,
  };
  const writeCfg = (obj: unknown) => writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify(obj, null, 2));
  return { tmp, ctx, home, writeCfg, cleanup: () => tmp.cleanup() };
}

test("sync installs .claude skills, agents and rules for claude and codex where published ones go", async () => {
  const e = env(["claude", "codex"]);
  const s = makeSource({
    ...KARR,
    ".claude/agents/gen.md.njk": AGENT("gen", 'for {{ harness }}: {% include "snippets/part.md" %}'),
    "snippets/part.md": "shared part",
    ".claude/rules/only-codex.md.njk": "---\ndescription: x\n---\n{% if harness == 'codex' %}codex only rule{% endif %}\n",
  });
  try {
    e.writeCfg({
      sources: { karr: { local: s.dir } },
      install: {
        skills: ["karr-single-binary@karr"],
        agents: ["karr-worker@karr", "gen@karr"],
        rules: ["karr-rules@karr", "only-codex@karr"],
      },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.deepEqual(r.scopes[0]!.conflicts, []);
    const claude = (rel: string) => readFileSync(join(e.home, ".claude", rel), "utf8");
    // Claude: the install paths of the published layout, never the source's .claude/ path.
    assert.equal(claude("skills/karr-single-binary/SKILL.md"), KARR[".claude/skills/karr-single-binary/SKILL.md"]);
    assert.equal(claude("skills/karr-single-binary/references/pp-recipe.md"), "recipe\n");
    assert.equal(claude("skills/karr-single-binary/scripts/benchmark.sh"), "#!/bin/sh\necho bench\n");
    assert.equal(claude("agents/.local.karr-worker.md"), KARR[".claude/agents/karr-worker.md"]);
    assert.equal(claude("agents/.local.gen.md"), AGENT("gen", "for claude: shared part"));
    assert.equal(claude("rules/.local.karr-rules.md"), KARR[".claude/rules/karr-rules.md"]);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.only-codex.md")), false);
    assert.equal(existsSync(join(e.home, ".claude/.claude")), false);
    // Codex: the skill in .agents, the agents as TOML, the rules in the rules file.
    assert.equal(
      readFileSync(join(e.home, ".agents/skills/karr-single-binary/references/pp-recipe.md"), "utf8"), "recipe\n",
    );
    const toml = (n: string) => ({ ...parseToml(readFileSync(join(e.home, ".codex/agents", `.local.${n}.toml`), "utf8")) });
    assert.deepEqual(toml("karr-worker"), {
      name: "karr-worker", description: "karr-worker agent", developer_instructions: "prompt\n",
    });
    assert.equal(toml("gen").developer_instructions, "for codex: shared part\n");
    const rulesFile = readFileSync(join(e.home, ".codex/skilletor-rules.md"), "utf8");
    assert.match(rulesFile, /Be careful\./);
    assert.match(rulesFile, /codex only rule/);
    assert.equal(existsSync(join(e.home, ".codex/.claude")), false);

    const lockFile = join(e.home, ".claude/skilletor.lock.json");
    const lock = readLock(lockFile);
    assert.deepEqual(Object.keys(lock).sort(), [
      "agents/gen", "agents/karr-worker",
      "codex:agents/gen", "codex:agents/karr-worker", "codex:rules/karr-rules", "codex:rules/only-codex",
      "codex:skills/karr-single-binary",
      "rules/karr-rules", "rules/only-codex", "skills/karr-single-binary",
    ]);
    assert.equal(lock["rules/only-codex"]!.skipped, "renders-empty");
    assert.deepEqual(Object.keys(lock["agents/karr-worker"]!.files), ["agents/.local.karr-worker.md"]);
    assert.deepEqual(Object.keys(lock["rules/karr-rules"]!.files), ["rules/.local.karr-rules.md"]);

    // check: the lock matches what the config declares and the layout.
    const c = await check(e.ctx, { scope: "user" });
    assert.deepEqual([c.error, c.targetsChanged, c.layoutChanged, c.declaredChanged, c.varsChanged],
      [undefined, undefined, undefined, undefined, undefined]);
    // A second sync changes nothing.
    const again = await sync(e.ctx, { scope: "user" });
    assert.deepEqual([again.scopes[0]!.added, again.scopes[0]!.updated, again.scopes[0]!.removed], [[], [], []]);
    assert.equal(again.scopes[0]!.unchanged.length, 9);
    assert.deepEqual(again.scopes[0]!.skipped.map((c) => c.key), ["rules/only-codex"]);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

test("wildcards pick up .claude agents and rules; an item leaving .claude for agents/ keeps its install path", async () => {
  const e = env(["claude"]);
  const s = makeSource(KARR);
  try {
    e.writeCfg({ sources: { karr: { local: s.dir } }, install: { agents: ["*@karr"], rules: ["*@karr"], skills: ["*@karr"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.warnings, []);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock).sort(), [
      "agents/karr-worker", "rules/karr-rules", "skills/getty-perl-core", "skills/karr-single-binary",
    ]);
    assert.deepEqual(Object.keys(lock["agents/karr-worker"]!.files), ["agents/.local.karr-worker.md"]);
    assert.equal(readFileSync(join(e.home, ".claude/agents/.local.karr-worker.md"), "utf8"), AGENT("karr-worker"));
    // The source publishes the agent after all: the published copy wins, same install path.
    put(s.dir, { "agents/karr-worker.md": AGENT("karr-worker", "published") });
    const moved = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(moved.scopes[0]!.updated.map((c) => c.key), ["agents/karr-worker"]);
    assert.deepEqual(moved.scopes[0]!.added, []);
    assert.equal(readFileSync(join(e.home, ".claude/agents/.local.karr-worker.md"), "utf8"), AGENT("karr-worker", "published"));
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

test("available lists .claude items and install finds them by name", async () => {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const ctx: CommandContext = {
    home,
    projectDir: join(tmp.dir, "proj"),
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false,
    probe: () => {
      throw new Error("probe must not run");
    },
  };
  const src = join(tmp.dir, "karr");
  mkdirSync(src);
  put(src, KARR);
  const cfgPath = join(home, ".claude/skilletor.json");
  try {
    writeFileSync(cfgPath, JSON.stringify({ sources: { karr: { local: src } } }));
    const listed = async () => (await cmdAvailable(ctx, { source: "karr" }))
      .map((i) => [`${i.type}:${i.name}`, i.description ?? null, i.installed]).sort();
    assert.deepEqual(await listed(), [
      ["agent:karr-worker", "karr-worker agent", false],
      ["rule:karr-rules", "karr-rules rule", false],
      ["skill:getty-perl-core", "getty-perl-core skill", false],
      ["skill:karr-single-binary", "karr-single-binary skill", false],
    ]);
    const r = await cmdInstall(ctx, { items: ["karr-worker@karr", "karr-rules@karr", "karr-single-binary@karr"] });
    assert.equal(r.error, undefined);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).install, {
      agents: ["karr-worker@karr"], rules: ["karr-rules@karr"], skills: ["karr-single-binary@karr"],
    });
    assert.ok(existsSync(join(home, ".claude/agents/.local.karr-worker.md")));
    assert.ok(existsSync(join(home, ".claude/rules/.local.karr-rules.md")));
    assert.ok(existsSync(join(home, ".claude/skills/karr-single-binary/scripts/benchmark.sh")));
    assert.deepEqual((await listed()).map((x) => x[2]), [true, true, false, true]);
  } finally {
    tmp.cleanup();
  }
});

test("a .claude skill's own .gitignore is replaced by skilletor's, or installs as shipped with gitignore off", async () => {
  const e = env(["claude"]);
  const s = makeSource({ ".claude/skills/own/SKILL.md": SKILL("own"), ".claude/skills/own/.gitignore": "node_modules/\n" });
  try {
    e.writeCfg({ sources: { p: { local: s.dir } }, install: { skills: ["own@p"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".claude/skills/own/.gitignore"), "utf8"), SKILL_GITIGNORE);
    e.writeCfg({ gitignore: false, sources: { p: { local: s.dir } }, install: { skills: ["own@p"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".claude/skills/own/.gitignore"), "utf8"), "node_modules/\n");
  } finally {
    s.cleanup();
    e.cleanup();
  }
});
