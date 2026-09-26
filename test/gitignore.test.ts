// Tests for the managed .gitignore block and the per-skill .gitignore (spec §6.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import {
  CODEX_ENTRIES, gitTracked, isGitWorkTree, PROJECT_CLAUDE_ENTRIES, SKILL_GITIGNORE, updateGitignore, withSkillGitignore,
} from "../src/gitignore.ts";

const BEGIN = "# >>> skilletor >>>";
const END = "# <<< skilletor <<<";
const BLOCK = (...entries: string[]) => [BEGIN, ...entries, END].join("\n") + "\n";

test("creates the block with the given entries, sorted", () => {
  const tmp = makeTmpDir();
  try {
    const change = updateGitignore({ dir: tmp.dir, entries: PROJECT_CLAUDE_ENTRIES, enabled: true });
    assert.equal(change, "created");
    assert.equal(readFileSync(join(tmp.dir, ".gitignore"), "utf8"),
      BLOCK("agents/**/.local.*", "rules/**/.local.*", "skilletor.local.json", "skilletor.lock.json"));
  } finally {
    tmp.cleanup();
  }
});

test("reports a changed block, and an unchanged one without writing", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    updateGitignore({ dir: tmp.dir, entries: ["a"], enabled: true });
    assert.equal(updateGitignore({ dir: tmp.dir, entries: ["a", "b"], enabled: true }), "changed");
    assert.equal(readFileSync(p, "utf8"), BLOCK("a", "b"));
    const mtime = statSync(p).mtimeMs;
    assert.equal(updateGitignore({ dir: tmp.dir, entries: ["b", "a"], enabled: true }), "unchanged");
    assert.equal(statSync(p).mtimeMs, mtime);
  } finally {
    tmp.cleanup();
  }
});

// k62: a per-path block of an earlier version is replaced by the fixed entries.
test("an earlier per-path block is replaced; foreign content before and after it stays", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    writeFileSync(p, `node_modules/\n${BEGIN}\nskills/old/SKILL.md\nskilletor.lock.json\n${END}\n*.log\n`);
    assert.equal(updateGitignore({ dir: tmp.dir, entries: CODEX_ENTRIES, enabled: true }), "changed");
    assert.equal(readFileSync(p, "utf8"), `node_modules/\n${BLOCK("agents/**/.local.*", "skilletor-rules.md")}*.log\n`);
  } finally {
    tmp.cleanup();
  }
});

test("disabling removes the block but keeps foreign content", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    writeFileSync(p, `node_modules/\n${BEGIN}\nskills/moo/SKILL.md\n${END}\n`);
    assert.equal(updateGitignore({ dir: tmp.dir, entries: PROJECT_CLAUDE_ENTRIES, enabled: false }), "removed");
    assert.equal(readFileSync(p, "utf8"), "node_modules/\n");
  } finally {
    tmp.cleanup();
  }
});

test("disabling deletes the file when only the block remained", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    updateGitignore({ dir: tmp.dir, entries: PROJECT_CLAUDE_ENTRIES, enabled: true });
    updateGitignore({ dir: tmp.dir, entries: PROJECT_CLAUDE_ENTRIES, enabled: false });
    assert.equal(existsSync(p), false);
  } finally {
    tmp.cleanup();
  }
});

test("no entries: the block is removed and no file is created (spec §6.4)", () => {
  const tmp = makeTmpDir();
  try {
    assert.equal(updateGitignore({ dir: tmp.dir, entries: [], enabled: true }), "unchanged");
    assert.equal(existsSync(join(tmp.dir, ".gitignore")), false);
    updateGitignore({ dir: tmp.dir, entries: CODEX_ENTRIES, enabled: true });
    assert.equal(updateGitignore({ dir: tmp.dir, entries: [], enabled: true }), "removed");
    assert.equal(existsSync(join(tmp.dir, ".gitignore")), false);
  } finally {
    tmp.cleanup();
  }
});

test("withSkillGitignore adds the skill's own .gitignore, replacing one the source ships", () => {
  const out = withSkillGitignore(new Map([
    ["skills/foo/SKILL.md", Buffer.from("S")],
    ["skills/foo/.gitignore", Buffer.from("shipped\n")],
    ["skills/foo/sub/.gitignore", Buffer.from("nested\n")],
  ]), "foo");
  assert.deepEqual([...out.keys()].sort(), ["skills/foo/.gitignore", "skills/foo/SKILL.md", "skills/foo/sub/.gitignore"]);
  assert.equal(out.get("skills/foo/.gitignore")!.toString(), SKILL_GITIGNORE);
  assert.equal(out.get("skills/foo/sub/.gitignore")!.toString(), "nested\n"); // only the root one is skilletor's
  assert.match(SKILL_GITIGNORE, /^#[^\n]*\n\*\n$/); // one comment line, then `*`
});

// k51: the default work-tree test behind the user-scope blocks (spec §6.4).
test("isGitWorkTree: true inside a work tree, false when git fails", () => {
  const tmp = makeTmpDir();
  try {
    const repo = join(tmp.dir, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    assert.equal(isGitWorkTree(repo), true);
    assert.equal(isGitWorkTree(join(repo, "sub")), true);
    assert.equal(isGitWorkTree(join(repo, ".git")), false); // inside the git dir, not the work tree
    assert.equal(isGitWorkTree(join(tmp.dir, "missing")), false);
  } finally {
    tmp.cleanup();
  }
});

// k63: the default tracked test behind the "tracked managed files" warning (spec §6.4).
test("gitTracked: the tracked ones of the given paths, literal, relative to dir; none outside a work tree", () => {
  const tmp = makeTmpDir();
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const repo = join(tmp.dir, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    for (const f of ["a.txt", "sub/b.txt", "starX.md", "sp ace.md"]) writeFileSync(join(repo, f), f);
    execFileSync("git", ["add", "."], { cwd: repo });
    for (const f of ["c.txt", "star*.md"]) writeFileSync(join(repo, f), f); // untracked
    const asked = ["a.txt", "c.txt", "sub/b.txt", "star*.md", "sp ace.md", "missing.txt"];
    assert.deepEqual(gitTracked(repo, asked).sort(), ["a.txt", "sp ace.md", "sub/b.txt"]); // `star*.md` is no glob
    assert.deepEqual(gitTracked(join(repo, "sub"), ["b.txt"]), ["b.txt"]); // relative to dir, not the top level
    assert.deepEqual(gitTracked(join(repo, ".git"), ["HEAD"]), []); // the git dir is no work tree
    assert.deepEqual(gitTracked(repo, []), []);
    // A directory outside any work tree (the ceiling keeps a repo around the temp dir out).
    const plain = join(tmp.dir, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "a.txt"), "a");
    process.env.GIT_CEILING_DIRECTORIES = tmp.dir;
    assert.deepEqual(gitTracked(plain, ["a.txt"]), []);
    assert.deepEqual(gitTracked(join(tmp.dir, "missing"), ["a.txt"]), []);
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    tmp.cleanup();
  }
});
