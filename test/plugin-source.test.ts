// Claude plugin repos as sources (spec §4.1): skill paths listed in
// `.claude-plugin/plugin.json` `skills`, unioned with `skills/<name>/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { scan, CatalogError } from "../src/catalog.ts";
import { sync, type EngineContext } from "../src/engine.ts";
import { readLock } from "../src/lock.ts";
import type { Harness } from "../src/config.ts";

const SKILL = (n: string, body = "BODY") => `---\nname: ${n}\ndescription: ${n} skill\n---\n${body}\n`;

/** A source dir with the given files (relative path -> content); `plugin` becomes plugin.json. */
function makeSource(files: Record<string, string>, plugin?: unknown) {
  const tmp = makeTmpDir();
  const dir = join(tmp.dir, "src");
  mkdirSync(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  if (plugin !== undefined) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin/plugin.json"), typeof plugin === "string" ? plugin : JSON.stringify(plugin));
  }
  return { tmp, dir: resolvePath(dir), cleanup: () => tmp.cleanup() };
}

const skillsOf = (dir: string) =>
  scan(dir).items.filter((i) => i.type === "skill").map((i) => ({ name: i.name, files: i.files }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** mattpocock/skills shape: skills nested by category, listed one by one. */
const MATT = {
  "skills/engineering/tdd/SKILL.md": SKILL("tdd"),
  "skills/engineering/tdd/tests.md": "companion\n",
  "skills/engineering/triage/SKILL.md": SKILL("triage"),
  "skills/engineering/README.md": "category readme\n",
  "skills/productivity/grill-me/SKILL.md": SKILL("grill-me"),
  "skills/productivity/teach/SKILL.md": SKILL("teach"),
  "skills/productivity/README.md": "category readme\n",
  "skills/in-progress/draft/SKILL.md": SKILL("draft"),
};

test("mattpocock shape: listed skill dirs and a category dir, one level deep", () => {
  const s = makeSource(MATT, {
    name: "m",
    skills: ["./skills/engineering/tdd", "skills/engineering/triage", "./skills/productivity"],
    agents: ["./agents/x.md"],
    commands: "./commands",
    hooks: { SessionStart: [] },
    mcpServers: {},
  });
  try {
    assert.deepEqual(skillsOf(s.dir), [
      { name: "grill-me", files: ["skills/productivity/grill-me/SKILL.md"] },
      { name: "tdd", files: ["skills/engineering/tdd/SKILL.md", "skills/engineering/tdd/tests.md"] },
      { name: "teach", files: ["skills/productivity/teach/SKILL.md"] },
      { name: "triage", files: ["skills/engineering/triage/SKILL.md"] },
    ]);
    const tdd = scan(s.dir).items.find((i) => i.name === "tdd")!;
    assert.equal(tdd.description, "tdd skill");
  } finally {
    s.cleanup();
  }
});

test("string form: one path", () => {
  const s = makeSource(MATT, { skills: "./skills/engineering/tdd" });
  try {
    assert.deepEqual(skillsOf(s.dir).map((i) => i.name), ["tdd"]);
  } finally {
    s.cleanup();
  }
});

test("a listed skill with SKILL.md.njk counts as a skill", () => {
  const s = makeSource({ "extra/tmpl/SKILL.md.njk": SKILL("tmpl", "{{ harness }}") }, { skills: ["extra/tmpl"] });
  try {
    assert.deepEqual(skillsOf(s.dir), [{ name: "tmpl", files: ["extra/tmpl/SKILL.md.njk"] }]);
  } finally {
    s.cleanup();
  }
});

test("union with flat skills/; the same dir reached both ways counts once", () => {
  const s = makeSource(
    { "skills/flat/SKILL.md": SKILL("flat"), "skills/both/SKILL.md": SKILL("both"), "more/deep/SKILL.md": SKILL("deep") },
    { skills: ["./skills/both", "skills", "more/deep", "./more/deep/"] },
  );
  try {
    assert.deepEqual(skillsOf(s.dir).map((i) => i.name), ["both", "deep", "flat"]);
  } finally {
    s.cleanup();
  }
});

test("plugin.json without skills, or with an empty list, adds nothing", () => {
  for (const plugin of [{ name: "x", agents: ["./agents"] }, { skills: [] }]) {
    const s = makeSource({ "skills/flat/SKILL.md": SKILL("flat"), "other/x/SKILL.md": SKILL("x") }, plugin);
    try {
      assert.deepEqual(skillsOf(s.dir).map((i) => i.name), ["flat"]);
    } finally {
      s.cleanup();
    }
  }
});

test("every invalid plugin.json makes the source unresolvable", () => {
  const cases: { why: string; files?: Record<string, string>; plugin: unknown; re: RegExp }[] = [
    { why: "invalid JSON", plugin: "{ nope", re: /invalid JSON/ },
    { why: "skills is a number", plugin: { skills: 3 }, re: /skills/ },
    { why: "skills array holds a non-string", plugin: { skills: ["a", 1] }, re: /skills/ },
    { why: "skills is an object", plugin: { skills: { a: "b" } }, re: /skills/ },
    { why: "absolute path", plugin: { skills: ["/etc"] }, re: /absolute/ },
    { why: ".. segment", plugin: { skills: ["skills/../../x"] }, re: /\.\./ },
    { why: "bare ..", plugin: { skills: [".."] }, re: /\.\./ },
    { why: "missing path", plugin: { skills: ["./nowhere"] }, re: /does not exist/ },
    {
      why: "two dirs, same name",
      files: { "a/tdd/SKILL.md": SKILL("tdd"), "b/tdd/SKILL.md": SKILL("tdd") },
      plugin: { skills: ["a/tdd", "b/tdd"] },
      re: /tdd/,
    },
    {
      why: "same name as a flat skill",
      files: { "skills/tdd/SKILL.md": SKILL("tdd"), "cat/tdd/SKILL.md": SKILL("tdd") },
      plugin: { skills: ["cat"] },
      re: /tdd/,
    },
  ];
  for (const c of cases) {
    const s = makeSource(c.files ?? { "skills/flat/SKILL.md": SKILL("flat") }, c.plugin);
    try {
      assert.throws(() => scan(s.dir), (e: unknown) => e instanceof CatalogError && c.re.test(e.message), c.why);
    } finally {
      s.cleanup();
    }
  }
});

test("symlinks on a listed path are rejected: the path itself, a parent, plugin.json", () => {
  const outside = makeTmpDir();
  try {
    mkdirSync(join(outside.dir, "evil"), { recursive: true });
    writeFileSync(join(outside.dir, "evil/SKILL.md"), SKILL("evil"));
    // The listed dir is a symlink.
    let s = makeSource({}, { skills: ["link"] });
    symlinkSync(join(outside.dir, "evil"), join(s.dir, "link"));
    assert.throws(() => scan(s.dir), (e: unknown) => e instanceof CatalogError && /symlink/.test(e.message));
    s.cleanup();
    // A parent of the listed dir is a symlink.
    s = makeSource({}, { skills: ["up/evil"] });
    symlinkSync(outside.dir, join(s.dir, "up"));
    assert.throws(() => scan(s.dir), (e: unknown) => e instanceof CatalogError && /symlink/.test(e.message));
    s.cleanup();
    // plugin.json itself is a symlink.
    s = makeSource({ "real.json": JSON.stringify({ skills: [] }) });
    mkdirSync(join(s.dir, ".claude-plugin"));
    symlinkSync(join(s.dir, "real.json"), join(s.dir, ".claude-plugin/plugin.json"));
    assert.throws(() => scan(s.dir), (e: unknown) => e instanceof CatalogError && /symlink/.test(e.message));
    s.cleanup();
  } finally {
    outside.cleanup();
  }
});

// ---- through the engine ---------------------------------------------------------

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

test("sync installs a nested plugin skill to skills/<name>/ for claude and codex", async () => {
  const e = env(["claude", "codex"]);
  const s = makeSource(
    { "skills/engineering/tdd/SKILL.md.njk": SKILL("tdd", "for {{ harness }}"), "skills/engineering/tdd/tests.md": "companion\n" },
    { skills: ["./skills/engineering/tdd"] },
  );
  try {
    e.writeCfg({ sources: { matt: { local: s.dir } }, install: { skills: ["tdd@matt"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.equal(readFileSync(join(e.home, ".claude/skills/tdd/SKILL.md"), "utf8"), SKILL("tdd", "for claude"));
    assert.equal(readFileSync(join(e.home, ".claude/skills/tdd/tests.md"), "utf8"), "companion\n");
    assert.equal(readFileSync(join(e.home, ".agents/skills/tdd/SKILL.md"), "utf8"), SKILL("tdd", "for codex"));
    assert.equal(existsSync(join(e.home, ".claude/skills/engineering")), false);
    assert.equal(existsSync(join(e.home, ".agents/skills/engineering")), false);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock).sort(), ["codex:skills/tdd", "skills/tdd"]);
    assert.deepEqual(Object.keys(lock["skills/tdd"]!.files).sort(), ["skills/tdd/SKILL.md", "skills/tdd/tests.md"]);
    assert.deepEqual(Object.keys(lock["codex:skills/tdd"]!.files).sort(), ["skills/tdd/SKILL.md", "skills/tdd/tests.md"]);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

test("a nested template skill that renders empty is skipped, like a flat one", async () => {
  const e = env(["claude"]);
  const s = makeSource(
    { "cat/only-codex/SKILL.md.njk": "---\nname: only-codex\ndescription: x\n---\n{% if harness == 'codex' %}body{% endif %}\n" },
    { skills: "cat" },
  );
  try {
    e.writeCfg({ sources: { p: { local: s.dir } }, install: { skills: ["only-codex@p"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.equal(existsSync(join(e.home, ".claude/skills/only-codex")), false);
    assert.equal(readLock(join(e.home, ".claude/skilletor.lock.json"))["skills/only-codex"]?.skipped, "renders-empty");
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

test("wildcard *@src picks up nested plugin skills next to flat ones", async () => {
  const e = env(["claude"]);
  const s = makeSource(
    { ...MATT, "skills/flat/SKILL.md": SKILL("flat") },
    { skills: ["./skills/engineering/tdd", "./skills/productivity"] },
  );
  try {
    e.writeCfg({ sources: { matt: { local: s.dir } }, install: { skills: ["*@matt"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    for (const n of ["flat", "tdd", "grill-me", "teach"]) {
      assert.ok(existsSync(join(e.home, `.claude/skills/${n}/SKILL.md`)), n);
    }
    assert.equal(existsSync(join(e.home, ".claude/skills/triage")), false);
    assert.equal(existsSync(join(e.home, ".claude/skills/draft")), false);
    const lock = readLock(join(e.home, ".claude/skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock).sort(), ["skills/flat", "skills/grill-me", "skills/tdd", "skills/teach"]);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});
