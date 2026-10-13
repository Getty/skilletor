// k126: a source's `path` (spec §3, §4.1) – where its skills lie, for a repo that keeps them
// outside `skills/<name>/`. NousResearch/hermes-agent has `skills/<category>/<name>/SKILL.md`
// and `optional-skills/<category>/[<sub>/]<name>/SKILL.md`, no plugin.json: the default scan
// reads `skills/` one level deep and offered nothing, without an error.
// No network: sources are local directories, the git one a file:// bare repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { NO_SYMLINKS } from "./helpers/symlink.ts";
import { scan, CatalogError } from "../src/catalog.ts";
import { check, sync } from "../src/engine.ts";
import { cmdAvailable, cmdInstall, cmdSourceList, CommandError, type CommandContext } from "../src/commands.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { readLock } from "../src/lock.ts";

const SKILL = (n: string, body = "BODY") => `---\nname: ${n}\ndescription: ${n} skill\n---\n${body}\n`;

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A source dir with the given files (relative path -> content). */
function makeSource(files: Record<string, string>) {
  const tmp = makeTmpDir();
  const dir = join(tmp.dir, "src");
  mkdirSync(dir);
  writeFiles(dir, files);
  return { tmp, dir: resolvePath(dir), cleanup: () => tmp.cleanup() };
}

/** hermes-agent's shape: skills by category, optional ones a level deeper, and what lies
 *  between them – a category's DESCRIPTION.md, an index cache. */
const HERMES = {
  "skills/research/DESCRIPTION.md": "category\n",
  "skills/research/arxiv/SKILL.md": SKILL("arxiv"),
  "skills/research/arxiv/scripts/search.py": "print(1)\n",
  "skills/research/blogwatcher/SKILL.md": SKILL("blogwatcher"),
  "skills/github/github-pr-workflow/SKILL.md": SKILL("github-pr-workflow"),
  "skills/index-cache/skills_index.json": "{}\n",
  "optional-skills/security/1password/SKILL.md": SKILL("1password"),
  "optional-skills/mlops/training/axolotl/SKILL.md": SKILL("axolotl"),
  "optional-skills/mlops/DESCRIPTION.md": "category\n",
};

/** What the default scan offers of a source, and must not be offered beside a `path`. */
const LAYOUT = {
  "skills/flat/SKILL.md": SKILL("flat"),
  "agents/helper.md": "---\ndescription: helper agent\n---\nprompt\n",
  "rules/style.md": "---\ndescription: style rule\n---\nrule\n",
  "bundles/all.yaml": "description: everything\nskills: [flat]\n",
  ".claude/skills/own/SKILL.md": SKILL("own"),
  ".claude-plugin/plugin.json": JSON.stringify({ skills: ["./plugin/listed"] }),
  "plugin/listed/SKILL.md": SKILL("listed"),
  "skilletor.json": JSON.stringify({ description: "a source", vars: { greeting: "hi" } }),
};

const brief = (dir: string, paths: string[]) => scan(dir, paths).items.map((i) => [i.type, i.name, i.dir]);

// Asserts: every directory holding a SKILL.md beneath a path is one skill named by its
// basename, at any depth; its files and description are a skill's as ever; what holds no
// SKILL.md (a category's DESCRIPTION.md, an index cache) is no item. Item paths use "/".
test("k126: a path is walked down to each SKILL.md: nested categories, a deeper level, noise between", () => {
  const s = makeSource(HERMES);
  try {
    const cat = scan(s.dir, ["skills", "optional-skills"]);
    assert.deepEqual(cat.items.map((i) => [i.type, i.name, i.dir, i.description, i.error]), [
      ["skill", "1password", "optional-skills/security/1password", "1password skill", undefined],
      ["skill", "arxiv", "skills/research/arxiv", "arxiv skill", undefined],
      ["skill", "axolotl", "optional-skills/mlops/training/axolotl", "axolotl skill", undefined],
      ["skill", "blogwatcher", "skills/research/blogwatcher", "blogwatcher skill", undefined],
      ["skill", "github-pr-workflow", "skills/github/github-pr-workflow", "github-pr-workflow skill", undefined],
    ]);
    assert.deepEqual(cat.items.find((i) => i.name === "arxiv")!.files, [
      "skills/research/arxiv/SKILL.md", "skills/research/arxiv/scripts/search.py",
    ]);
    // The same source without a path offers nothing (the layout the card measured).
    assert.deepEqual(scan(s.dir).items, []);
  } finally {
    s.cleanup();
  }
});

// Asserts: a path may be a category, a single skill, or several of them; the same directory
// reached through two overlapping paths counts once, without an error.
test("k126: a category path, a single-skill path, several paths; overlapping paths count a skill once", () => {
  const s = makeSource(HERMES);
  try {
    assert.deepEqual(brief(s.dir, ["skills/research"]), [
      ["skill", "arxiv", "skills/research/arxiv"], ["skill", "blogwatcher", "skills/research/blogwatcher"],
    ]);
    assert.deepEqual(brief(s.dir, ["skills/research/arxiv"]), [["skill", "arxiv", "skills/research/arxiv"]]);
    assert.deepEqual(brief(s.dir, ["./skills/github/", "optional-skills/mlops"]), [
      ["skill", "axolotl", "optional-skills/mlops/training/axolotl"],
      ["skill", "github-pr-workflow", "skills/github/github-pr-workflow"],
    ]);
    const twice = scan(s.dir, ["skills", "skills/research", "skills/research/arxiv", "skills"]);
    assert.deepEqual(twice.items.map((i) => [i.name, i.error]), [
      ["arxiv", undefined], ["blogwatcher", undefined], ["github-pr-workflow", undefined],
    ]);
    assert.deepEqual(scan(s.dir, ["skills/index-cache"]).items, []); // a path without skills: none, no error
  } finally {
    s.cleanup();
  }
});

// Asserts: a directory holding SKILL.md[.njk] is one skill and is not searched further – a
// SKILL.md beneath it is a companion file of that skill, never a second item.
test("k126: a skill directory is not searched further; SKILL.md.njk makes a skill too", () => {
  const s = makeSource({
    "pack/outer/SKILL.md": SKILL("outer"),
    "pack/outer/examples/inner/SKILL.md": SKILL("inner"),
    "pack/tmpl/SKILL.md.njk": SKILL("tmpl", "{{ harness }}"),
  });
  try {
    const cat = scan(s.dir, ["pack"]);
    assert.deepEqual(cat.items.map((i) => [i.name, i.files]), [
      ["outer", ["pack/outer/SKILL.md", "pack/outer/examples/inner/SKILL.md"]],
      ["tmpl", ["pack/tmpl/SKILL.md.njk"]],
    ]);
    assert.equal(cat.items.find((i) => i.name === "tmpl")!.description, "tmpl skill");
  } finally {
    s.cleanup();
  }
});

// Asserts: `path` replaces the item scan – no skills/, agents/, rules/, plugin.json or
// .claude/ items and no bundles – while the source's skilletor.json meta is still read. The
// same tree without a path offers all of them (the control: the files are really there).
test("k126: a path replaces the item scan: no layout items, no bundles; the source meta stays", () => {
  const s = makeSource({ ...HERMES, ...LAYOUT });
  try {
    const all = scan(s.dir);
    assert.deepEqual(all.items.map((i) => `${i.type}:${i.name}`).sort(), [
      "agent:helper", "rule:style", "skill:flat", "skill:listed", "skill:own",
    ]);
    assert.deepEqual(all.bundles.map((b) => b.name), ["all"]);

    const cat = scan(s.dir, ["optional-skills"]);
    assert.deepEqual(cat.items.map((i) => `${i.type}:${i.name}`), ["skill:1password", "skill:axolotl"]);
    assert.deepEqual(cat.bundles, []);
    assert.deepEqual(cat.meta, { description: "a source", vars: { greeting: "hi" } });
    // `skills` as a path is walked like any other: the flat skill and the nested ones.
    assert.deepEqual(scan(s.dir, ["skills"]).items.map((i) => i.name), ["arxiv", "blogwatcher", "flat", "github-pr-workflow"]);
  } finally {
    s.cleanup();
  }
});

// Asserts: two different directories yielding one name are an error of that item, never of
// the scan: the catalog holds the name once, with an error naming every directory in sorted
// order and the files of all of them; every other skill is offered. (plugin.json makes the
// source unresolvable there; an addition in a foreign repo must not take the source down.)
test("k126: two directories with one name are an error of that item, the rest is offered", () => {
  const s = makeSource({
    ...HERMES,
    "optional-skills/research/arxiv/SKILL.md": SKILL("arxiv", "OTHER"),
    "optional-skills/archive/old/arxiv/SKILL.md": SKILL("arxiv", "OLD"),
  });
  try {
    const cat = scan(s.dir, ["skills", "optional-skills"]);
    assert.deepEqual(cat.items.map((i) => i.name), ["1password", "arxiv", "axolotl", "blogwatcher", "github-pr-workflow"]);
    const arxiv = cat.items.find((i) => i.name === "arxiv")!;
    assert.equal(arxiv.error,
      "found in 3 directories: optional-skills/archive/old/arxiv, optional-skills/research/arxiv and skills/research/arxiv");
    assert.equal(arxiv.description, undefined);
    assert.equal(arxiv.dir, undefined);
    assert.deepEqual(arxiv.files, [
      "optional-skills/archive/old/arxiv/SKILL.md", "optional-skills/research/arxiv/SKILL.md",
      "skills/research/arxiv/SKILL.md", "skills/research/arxiv/scripts/search.py",
    ]);
    assert.equal(cat.items.filter((i) => i.name !== "arxiv").every((i) => i.error === undefined), true);

    const two = scan(s.dir, ["optional-skills/research", "skills/research"]).items.find((i) => i.name === "arxiv")!;
    assert.equal(two.error, "found in 2 directories: optional-skills/research/arxiv and skills/research/arxiv");
    // One of the two directories alone is the skill, without an error.
    assert.equal(scan(s.dir, ["skills"]).items.find((i) => i.name === "arxiv")!.error, undefined);
  } finally {
    s.cleanup();
  }
});

// Asserts: a path gets the refusals of a plugin.json `skills` path (spec §4.1) – absolute,
// "..", the source root, missing, not a directory – each a CatalogError naming "path" and the
// value, so the source is unresolvable; a good path beside a bad one does not save the scan.
test("k126: a path that is absolute, has .., is the source root, is missing or is no directory fails the scan", () => {
  const s = makeSource({ ...HERMES, "notes.txt": "x\n" });
  try {
    const cases: [string, string][] = [
      ["/etc", `"path" must not be absolute: /etc`],
      [s.dir, `"path" must not be absolute: ${s.dir}`],
      ["\\skills", `"path" must not be absolute: \\skills`],
      ["../outside", `"path" must not contain "..": ../outside`],
      ["skills/../skills", `"path" must not contain "..": skills/../skills`],
      ["skills\\..\\skills", `"path" must not contain "..": skills\\..\\skills`],
      ["", `"path" must not be the source root: ""`],
      [".", `"path" must not be the source root: "."`],
      ["./", `"path" must not be the source root: "./"`],
      ["nope", `"path" does not exist: nope`],
      ["skills/nope/deeper", `"path" does not exist: skills/nope/deeper`],
      ["notes.txt", `"path" is not a directory: notes.txt`],
      ["skills/research/arxiv/SKILL.md", `"path" is not a directory: skills/research/arxiv/SKILL.md`],
    ];
    for (const [path, message] of cases) {
      for (const paths of [[path], ["skills", path]]) {
        assert.throws(() => scan(s.dir, paths), (e: unknown) => {
          assert.ok(e instanceof CatalogError, `${path}: ${String(e)}`);
          assert.equal((e as Error).message, message);
          return true;
        }, path);
      }
    }
    assert.deepEqual(scan(s.dir, []).items, []); // no path at all: nothing to walk (config load refuses [])
  } finally {
    s.cleanup();
  }
});

// Asserts: a path that is a symlink, lies behind one, or dangles is refused as a symlink –
// nothing is followed, inside the source or out of it.
test("k126: a path that is a symlink, lies behind one or dangles fails the scan", { skip: NO_SYMLINKS }, () => {
  const s = makeSource(HERMES);
  try {
    const outside = join(s.tmp.dir, "outside");
    writeFiles(outside, { "evil/SKILL.md": SKILL("evil") });
    symlinkSync(outside, join(s.dir, "out"));
    symlinkSync(join(s.dir, "skills"), join(s.dir, "alias"));
    symlinkSync(join(s.dir, "gone"), join(s.dir, "dangling"));
    for (const [path, link] of [["out", "out"], ["out/evil", "out"], ["alias/research", "alias"], ["dangling", "dangling"]] as const) {
      assert.throws(() => scan(s.dir, [path]), (e: unknown) => {
        assert.ok(e instanceof CatalogError, `${path}: ${String(e)}`);
        assert.equal((e as Error).message, `symlink not allowed in source: ${join(s.dir, link)}`);
        return true;
      }, path);
    }
  } finally {
    s.cleanup();
  }
});

// Asserts: on the way down a dot-directory that is not itself a skill is not entered (.git,
// .github), one that holds SKILL.md is a skill, and a path naming a dot-directory is walked.
test("k126: the walk skips dot-directories that are no skill", () => {
  const s = makeSource({
    "skills/a/x/SKILL.md": SKILL("x"),
    "skills/.git/hooks/sample/SKILL.md": SKILL("sample"),
    "skills/a/.github/workflows/ci/SKILL.md": SKILL("ci"),
    "skills/a/.hidden/SKILL.md": SKILL(".hidden"),
    ".curated/b/y/SKILL.md": SKILL("y"),
  });
  try {
    assert.deepEqual(brief(s.dir, ["skills"]), [["skill", ".hidden", "skills/a/.hidden"], ["skill", "x", "skills/a/x"]]);
    assert.deepEqual(brief(s.dir, [".curated"]), [["skill", "y", ".curated/b/y"]]);
    assert.deepEqual(brief(s.dir, ["skills/.git"]), [["skill", "sample", "skills/.git/hooks/sample"]]);
  } finally {
    s.cleanup();
  }
});

// Asserts: on the way down a symlinked entry – a directory, a file, a dangling one – is
// skipped silently and never followed; inside a skill directory the rules of every skill hold
// unchanged, so a symlink there (a companion, SKILL.md itself) still fails the scan.
test("k126: the walk skips symlinked entries; a symlink inside a skill still fails the scan", { skip: NO_SYMLINKS }, () => {
  const s = makeSource({ "skills/a/x/SKILL.md": SKILL("x"), "elsewhere/z/SKILL.md": SKILL("z") });
  try {
    const outside = join(s.tmp.dir, "outside");
    writeFiles(outside, { "evil/SKILL.md": SKILL("evil") });
    symlinkSync(outside, join(s.dir, "skills/out"));
    symlinkSync(join(s.dir, "elsewhere"), join(s.dir, "skills/a/inside"));
    symlinkSync(join(s.dir, "elsewhere/z"), join(s.dir, "skills/z"));
    symlinkSync(join(s.dir, "gone"), join(s.dir, "skills/a/dangling"));
    symlinkSync(join(s.dir, "elsewhere/z/SKILL.md"), join(s.dir, "skills/a/README.md"));
    assert.deepEqual(brief(s.dir, ["skills"]), [["skill", "x", "skills/a/x"]]);

    symlinkSync(join(outside, "evil/SKILL.md"), join(s.dir, "skills/a/x/notes.md"));
    assert.throws(() => scan(s.dir, ["skills"]), (e: unknown) => {
      assert.ok(e instanceof CatalogError, String(e));
      assert.equal((e as Error).message, `symlink not allowed in source: ${join(s.dir, "skills/a/x/notes.md")}`);
      return true;
    });
    mkdirSync(join(s.dir, "linked/w"), { recursive: true });
    symlinkSync(join(outside, "evil/SKILL.md"), join(s.dir, "linked/w/SKILL.md"));
    assert.throws(() => scan(s.dir, ["linked"]), (e: unknown) => {
      assert.ok(e instanceof CatalogError, String(e));
      assert.equal((e as Error).message, `symlink not allowed in source: ${join(s.dir, "linked/w/SKILL.md")}`);
      return true;
    });
  } finally {
    s.cleanup();
  }
});

// Asserts: a skill found through a path is built like any other – `f` beside `f.njk` is the
// item's own error naming the pair (k113), and the scan goes on.
test("k126: a path skill with f beside f.njk carries the k113 error", () => {
  const s = makeSource({
    "pack/cat/pair/SKILL.md": SKILL("pair"), "pack/cat/pair/SKILL.md.njk": SKILL("pair"), "pack/cat/ok/SKILL.md": SKILL("ok"),
  });
  try {
    assert.deepEqual(scan(s.dir, ["pack"]).items.map((i) => [i.name, i.description, i.error]), [
      ["ok", "ok skill", undefined],
      ["pair", undefined, "both pack/cat/pair/SKILL.md and pack/cat/pair/SKILL.md.njk exist"],
    ]);
  } finally {
    s.cleanup();
  }
});

// ---- through the engine and the commands ---------------------------------------------

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: CommandContext & HookContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    cacheRoot: join(tmp.dir, "cache"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false, // never the real location of the temp dir
    gitTracked: () => [],
    background: () => {},
    probe: () => {
      throw new Error("probe must not run");
    },
  };
  const cfgPath = (which: "user" | "project" | "local") =>
    join(which === "user" ? home : projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => writeFileSync(cfgPath(which), JSON.stringify(obj, null, 2));
  const userFile = (p: string) => join(home, ".claude", p);
  const lockKeys = () => Object.keys(readLock(userFile("skilletor.lock.json"))).sort();
  return { tmp, ctx, home, projectDir, cfgPath, writeCfg, userFile, lockKeys, cleanup: () => tmp.cleanup() };
}

// Asserts: a wildcard over a source with `path` (a string or an array) installs each skill as
// skills/<name>/ – no category directory, "/" in lock keys and lock file paths – and nothing
// else of the source: its agents, rules and flat-layout skills are not offered, an explicit
// agent is "not found", a declared bundle is unknown.
test("k126: sync installs path skills as skills/<name>/ and offers nothing else of the source", async () => {
  const e = env();
  const s = makeSource({ ...HERMES, ...LAYOUT });
  try {
    e.writeCfg("user", {
      sources: { hermes: { local: s.dir, path: ["skills/research", "optional-skills"] } },
      install: { skills: ["*@hermes"], agents: ["*@hermes", "helper@hermes"], rules: ["*@hermes"], bundles: ["all@hermes"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.warnings, [
      "bundle:all@hermes: bundle all not found; its installed items are kept",
      "item not found in source hermes: agent helper",
    ]);
    assert.deepEqual(e.lockKeys(), ["skills/1password", "skills/arxiv", "skills/axolotl", "skills/blogwatcher"]);
    const lock = readLock(e.userFile("skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock["skills/arxiv"]!.files).sort(), [
      "skills/arxiv/.gitignore", "skills/arxiv/SKILL.md", "skills/arxiv/scripts/search.py",
    ]);
    assert.equal(readFileSync(e.userFile("skills/arxiv/SKILL.md"), "utf8"), SKILL("arxiv"));
    assert.equal(readFileSync(e.userFile("skills/axolotl/SKILL.md"), "utf8"), SKILL("axolotl"));
    for (const gone of ["skills/research", "skills/mlops", "skills/flat", "skills/own", "skills/listed", "agents", "rules"]) {
      assert.equal(existsSync(e.userFile(gone)), false, gone);
    }

    // The string form, and a single skill as the path.
    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: "skills/research/arxiv" } }, install: { skills: ["*@hermes"] } });
    const one = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(one.scopes[0]!.warnings, []);
    assert.deepEqual(e.lockKeys(), ["skills/arxiv"]);
    assert.equal(existsSync(e.userFile("skills/1password")), false);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

// Asserts: a name two directories yield is that item's error in `sync` – by a wildcard or an
// explicit entry: a warning with the error, nothing built, an installed copy stays – and every
// other skill syncs.
test("k126: sync warns for a name found twice, keeps its installed copy and installs the rest", async () => {
  const e = env();
  const s = makeSource(HERMES);
  try {
    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: ["skills", "optional-skills"] } }, install: { skills: ["*@hermes"] } });
    assert.deepEqual((await sync(e.ctx, { scope: "user" })).scopes[0]!.warnings, []);
    const all = ["skills/1password", "skills/arxiv", "skills/axolotl", "skills/blogwatcher", "skills/github-pr-workflow"];
    assert.deepEqual(e.lockKeys(), all);

    writeFiles(s.dir, { "optional-skills/research/arxiv/SKILL.md": SKILL("arxiv", "OTHER"), "optional-skills/new/fresh/SKILL.md": SKILL("fresh") });
    const r = await sync(e.ctx, { scope: "user" });
    const dup = "skill arxiv@hermes: found in 2 directories: optional-skills/research/arxiv and skills/research/arxiv; an installed copy stays";
    assert.deepEqual(r.scopes[0]!.warnings, [dup]);
    assert.deepEqual(e.lockKeys(), [...all, "skills/fresh"].sort());
    assert.equal(readFileSync(e.userFile("skills/arxiv/SKILL.md"), "utf8"), SKILL("arxiv")); // the copy installed before
    assert.equal(readFileSync(e.userFile("skills/fresh/SKILL.md"), "utf8"), SKILL("fresh"));

    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: ["skills", "optional-skills"] } }, install: { skills: ["arxiv@hermes"] } });
    assert.deepEqual((await sync(e.ctx, { scope: "user" })).scopes[0]!.warnings, [dup]);
    assert.deepEqual(e.lockKeys(), ["skills/arxiv"]);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

// Asserts: a path the scan refuses makes the source unresolvable for that sync – one warning
// naming source, "path" and the value – and what it installed before stays.
test("k126: sync with a path the source lacks warns and keeps the source's installed items", async () => {
  const e = env();
  const s = makeSource(HERMES);
  try {
    const install = { skills: ["*@hermes"] };
    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: "skills" } }, install });
    await sync(e.ctx, { scope: "user" });
    const before = e.lockKeys();
    assert.deepEqual(before, ["skills/arxiv", "skills/blogwatcher", "skills/github-pr-workflow"]);

    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: ["skills", "moved-skills"] } }, install });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.warnings, [`source hermes: "path" does not exist: moved-skills`]);
    assert.deepEqual(e.lockKeys(), before);
    assert.equal(existsSync(e.userFile("skills/arxiv/SKILL.md")), true);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

// Asserts: `path` merges like `ref` – the whole value replaced, project < user < local, never
// concatenated – and the user scope reads the user config's alone: a project's `path` for a
// user source changes what the project scope installs, never the user scope.
test("k126: path merges project < user < local as a whole; the user scope uses the user config's alone", async () => {
  const e = env();
  const s = makeSource(HERMES);
  try {
    const projFile = (p: string) => join(e.projectDir, ".claude", p);
    const projKeys = () => Object.keys(readLock(projFile("skilletor.lock.json"))).sort();
    const install = { skills: ["*@hermes"] };
    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: "skills/github" } }, install });
    e.writeCfg("project", { sources: { hermes: { local: s.dir, path: ["skills/research", "optional-skills"] } }, install });
    let r = await sync(e.ctx);
    assert.deepEqual(r.scopes.map((x) => x.warnings), [[], []]);
    assert.deepEqual(e.lockKeys(), ["skills/github-pr-workflow"]);
    assert.deepEqual(projKeys(), ["skills/github-pr-workflow"]); // the user's path over the project's, not both

    e.writeCfg("local", { sources: { hermes: { local: s.dir, path: ["optional-skills/security"] } } });
    r = await sync(e.ctx);
    assert.deepEqual(r.scopes.map((x) => x.warnings), [[], []]);
    assert.deepEqual(e.lockKeys(), ["skills/github-pr-workflow"]); // the local file is the project scope's
    assert.deepEqual(projKeys(), ["skills/1password"]);

    // A user source without a path: the project's path applies in the project scope only.
    e.writeCfg("local", {});
    e.writeCfg("user", { sources: { hermes: { local: s.dir } }, install: { skills: ["*@hermes"] } });
    r = await sync(e.ctx);
    assert.deepEqual(e.lockKeys(), []); // the default scan of this tree offers nothing
    assert.deepEqual(projKeys(), ["skills/1password", "skills/arxiv", "skills/axolotl", "skills/blogwatcher"]);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

// Asserts: `available` lists the path's skills (a name found twice with its error, on its
// own line in the catalog), `install` of that name fails before the config is edited, `install`
// of a good one works, `install bundle:` finds no bundle, and `source list` carries `path` as
// written beside the backend.
test("k126: available, install and source list on a source with a path", async () => {
  const e = env();
  const s = makeSource({ ...HERMES, ...LAYOUT, "optional-skills/research/arxiv/SKILL.md": SKILL("arxiv", "OTHER") });
  try {
    const sources = { hermes: { local: s.dir, path: ["skills/research", "optional-skills"] }, one: { local: s.dir, path: "skills/github" } };
    e.writeCfg("user", { sources });
    const items = await cmdAvailable(e.ctx, { source: "hermes" });
    assert.deepEqual(items.map((i) => [i.type, i.name, i.description, i.error]), [
      ["skill", "1password", "1password skill", undefined],
      ["skill", "arxiv", undefined, "found in 2 directories: optional-skills/research/arxiv and skills/research/arxiv"],
      ["skill", "axolotl", "axolotl skill", undefined],
      ["skill", "blogwatcher", "blogwatcher skill", undefined],
    ]);
    assert.deepEqual((await cmdAvailable(e.ctx, { source: "one" })).map((i) => `${i.type}:${i.name}`), ["skill:github-pr-workflow"]);

    const raw = readFileSync(e.cfgPath("user"), "utf8");
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["arxiv@hermes"] }), (err: unknown) => {
      assert.ok(err instanceof CommandError, String(err));
      assert.equal((err as Error).message,
        "hermes: skill arxiv: found in 2 directories: optional-skills/research/arxiv and skills/research/arxiv");
      return true;
    });
    for (const [item, message] of [
      ["bundle:all@hermes", `unknown bundle "all" in hermes`],
      ["helper@hermes", `unknown item "helper" in hermes (available: skill:1password, skill:arxiv, skill:axolotl, skill:blogwatcher)`],
    ] as const) {
      await assert.rejects(() => cmdInstall(e.ctx, { items: [item] }), (err: unknown) => {
        assert.ok(err instanceof CommandError, String(err));
        assert.equal((err as Error).message, message);
        return true;
      });
    }
    assert.equal(readFileSync(e.cfgPath("user"), "utf8"), raw, "config byte-identical");

    const r = await cmdInstall(e.ctx, { items: ["axolotl@hermes"] });
    assert.equal(r.error, undefined);
    assert.equal(readFileSync(e.userFile("skills/axolotl/SKILL.md"), "utf8"), SKILL("axolotl"));
    assert.deepEqual(JSON.parse(readFileSync(e.cfgPath("user"), "utf8")).sources, sources, "install leaves the sources as written");

    assert.deepEqual(cmdSourceList(e.ctx), [
      { name: "hermes", def: { local: s.dir, path: ["skills/research", "optional-skills"] }, origin: "user" },
      { name: "one", def: { local: s.dir, path: "skills/github" }, origin: "user" },
    ]);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});

const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
};

/** A bare repo reachable as file://, seeded with `files`. */
function gitSource(root: string, name: string, files: Record<string, string>): string {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: GIT_ENV, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare], { env: GIT_ENV });
  mkdirSync(work, { recursive: true });
  git("init", "-q", "-b", "main");
  const url = pathToFileURL(realpathSync(bare)).href;
  writeFiles(work, files);
  git("add", ".");
  git("commit", "-qm", "c");
  git("push", "-q", url, "main");
  return url;
}

// Asserts: `path` is no part of the source's identity – two names with one address and
// different paths share one git cache – yet a changed `path` is a reason to sync although the
// source did not move: `check` reports the source changed, the SessionStart hook syncs once
// (items of the old path go, the new ones come) and the next session is quiet again.
test("k126: a changed path makes check ask for one sync; names with one address share the cache", async () => {
  const e = env();
  try {
    const url = gitSource(e.tmp.dir, "hermes", HERMES);
    const session = () => runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx);
    const install = { skills: ["*@hermes"] };
    e.writeCfg("user", { sources: { hermes: { git: url, path: "skills/research" } }, install, checkInterval: 0 });
    assert.equal((await session()).systemMessage, "skilletor: 2 item(s) updated");
    assert.deepEqual(e.lockKeys(), ["skills/arxiv", "skills/blogwatcher"]);
    assert.deepEqual(await session(), {}); // nothing moved: no sync
    assert.equal((await check(e.ctx)).changed, false);

    e.writeCfg("user", { sources: { hermes: { git: url, path: ["optional-skills"] } }, install, checkInterval: 0 });
    const chk = await check(e.ctx);
    assert.deepEqual([chk.changed, chk.sources], [true, [{ name: "hermes", scope: "user", changed: true }]]);
    assert.equal((await session()).systemMessage, "skilletor: 2 item(s) updated, 2 removed");
    assert.deepEqual(e.lockKeys(), ["skills/1password", "skills/axolotl"]);
    assert.deepEqual(await session(), {});
    assert.equal((await check(e.ctx)).changed, false);

    // The same value written the other way is no change: a string is a list of one.
    e.writeCfg("user", { sources: { hermes: { git: url, path: "optional-skills" } }, install, checkInterval: 0 });
    assert.equal((await check(e.ctx)).changed, false);

    // A second name for the address, with another path: one cache directory for both.
    e.writeCfg("user", {
      sources: { hermes: { git: url, path: "optional-skills" }, core: { git: url, path: "skills/github" } },
      install: { skills: ["*@hermes", "*@core"] }, checkInterval: 0,
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.warnings, []);
    assert.deepEqual(e.lockKeys(), ["skills/1password", "skills/axolotl", "skills/github-pr-workflow"]);
    assert.equal(readdirSync(e.ctx.cacheRoot!).length, 1, "one cache for the one address");
  } finally {
    e.cleanup();
  }
});

// Asserts: a bundle entry naming another source by address (spec §15.6) is served by the
// configured source with that address as that source offers it – with its `path`: a skill
// beneath it is installed, one outside it and an agent are not found there.
test("k126: a bundle entry of another source is served through that source's path", async () => {
  const e = env();
  try {
    const url = gitSource(e.tmp.dir, "hermes", { ...HERMES, "agents/helper.md": "---\ndescription: helper agent\n---\nprompt\n" });
    const a = join(e.tmp.dir, "a");
    writeFiles(a, {
      "bundles/pack.yaml": `description: pack\nskills: ["arxiv@${url}", "1password@${url}"]\nagents: ["helper@${url}"]\n`,
    });
    e.writeCfg("user", {
      sources: { a: { local: a }, hermes: { git: url, path: "skills" } }, install: { bundles: ["pack@a"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.warnings, [
      "bundle pack@a: skill 1password not found in hermes",
      "bundle pack@a: agent helper not found in hermes",
    ]);
    assert.deepEqual(e.lockKeys(), ["skills/arxiv"]);
    assert.equal(readLock(e.userFile("skilletor.lock.json"))["skills/arxiv"]!.source, "hermes");
  } finally {
    e.cleanup();
  }
});

// Asserts: the hook path stays silent on a refused path – exit by return, one warning counted,
// the reason in the context – and never throws.
test("k126: session-start with a path the source lacks reports one warning and installs nothing", async () => {
  const e = env();
  const s = makeSource(HERMES);
  try {
    e.writeCfg("user", { sources: { hermes: { local: s.dir, path: "nope" } }, install: { skills: ["*@hermes"] } });
    const out = await runHook("session-start", { source: "startup", cwd: e.projectDir }, e.ctx);
    assert.equal(out.systemMessage, "skilletor: 1 warning(s)");
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /source hermes: "path" does not exist: nope/);
    assert.deepEqual(e.lockKeys(), []);
  } finally {
    s.cleanup();
    e.cleanup();
  }
});
