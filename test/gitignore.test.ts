// Tests for the managed .gitignore block (spec §6.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { isGitWorkTree, updateGitignore } from "../src/gitignore.ts";

const BEGIN = "# >>> skilletor >>>";
const END = "# <<< skilletor <<<";

test("creates the block with managed paths plus lock and local", () => {
  const tmp = makeTmpDir();
  try {
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/moo/SKILL.md"], enabled: true });
    const text = readFileSync(join(tmp.dir, ".gitignore"), "utf8");
    assert.match(text, new RegExp(BEGIN));
    assert.match(text, /skills\/moo\/SKILL\.md/);
    assert.match(text, /skilletor\.lock\.json/);
    assert.match(text, /skilletor\.local\.json/);
    assert.match(text, new RegExp(END));
  } finally {
    tmp.cleanup();
  }
});

test("updates an existing block to new paths", () => {
  const tmp = makeTmpDir();
  try {
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/old/SKILL.md"], enabled: true });
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/new/SKILL.md"], enabled: true });
    const text = readFileSync(join(tmp.dir, ".gitignore"), "utf8");
    assert.equal(text.includes("skills/old/SKILL.md"), false);
    assert.match(text, /skills\/new\/SKILL\.md/);
  } finally {
    tmp.cleanup();
  }
});

test("is idempotent: no write when nothing changed", () => {
  const tmp = makeTmpDir();
  try {
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/moo/SKILL.md"], enabled: true });
    const p = join(tmp.dir, ".gitignore");
    const mtime = statSync(p).mtimeMs;
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/moo/SKILL.md"], enabled: true });
    assert.equal(statSync(p).mtimeMs, mtime);
  } finally {
    tmp.cleanup();
  }
});

test("foreign content before and after the block is preserved", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    writeFileSync(p, `node_modules/\n${BEGIN}\nskills/old/SKILL.md\n${END}\n*.log\n`);
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/new/SKILL.md"], enabled: true });
    const text = readFileSync(p, "utf8");
    assert.match(text, /node_modules\//);
    assert.match(text, /\*\.log/);
    assert.match(text, /skills\/new\/SKILL\.md/);
    assert.equal(text.includes("skills/old"), false);
  } finally {
    tmp.cleanup();
  }
});

test("disabling removes the block but keeps foreign content", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    writeFileSync(p, `node_modules/\n${BEGIN}\nskills/moo/SKILL.md\n${END}\n`);
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/moo/SKILL.md"], enabled: false });
    const text = readFileSync(p, "utf8");
    assert.match(text, /node_modules\//);
    assert.equal(text.includes(BEGIN), false);
  } finally {
    tmp.cleanup();
  }
});

test("disabling deletes the file when only the block remained", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".gitignore");
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/moo/SKILL.md"], enabled: true });
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/moo/SKILL.md"], enabled: false });
    assert.equal(existsSync(p), false);
  } finally {
    tmp.cleanup();
  }
});

test("with no fixed entries, an empty block is removed and no file is created (spec §14.3)", () => {
  const tmp = makeTmpDir();
  try {
    updateGitignore({ dir: tmp.dir, managedPaths: [], fixed: [], enabled: true });
    assert.equal(existsSync(join(tmp.dir, ".gitignore")), false);
    updateGitignore({ dir: tmp.dir, managedPaths: ["skills/x/SKILL.md"], fixed: [], enabled: true });
    assert.equal(readFileSync(join(tmp.dir, ".gitignore"), "utf8"), "# >>> skilletor >>>\nskills/x/SKILL.md\n# <<< skilletor <<<\n");
    updateGitignore({ dir: tmp.dir, managedPaths: [], fixed: [], enabled: true });
    assert.equal(existsSync(join(tmp.dir, ".gitignore")), false);
  } finally {
    tmp.cleanup();
  }
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
