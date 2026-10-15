// k124 (spec §6.4): the project's `.worktreeinclude` block – Claude Code copies the gitignored
// files it matches into every worktree it creates with git, so agent worktrees get the items
// skilletor installed at project scope (and the lock that owns them) without a sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { sync, check, type EngineContext } from "../src/engine.ts";
import { reportHook, reportText } from "../src/report.ts";
import { runHook } from "../src/hooks.ts";
import { updateWorktreeInclude } from "../src/gitignore.ts";
import type { Harness } from "../src/targets.ts";

function env(harnesses: Harness[] = ["claude"]) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  // A marker per harness "in use"; the helper never touches the real machine.
  const markerOf = (h: Harness) => join(tmp.dir, `marker-${h}`);
  for (const h of harnesses) writeFileSync(markerOf(h), "");
  const ctx: EngineContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: { claude: [markerOf("claude")], codex: [markerOf("codex")] },
    codexHome: join(home, ".codex"), // never the real $CODEX_HOME
    hermesHome: join(tmp.dir, "hermes-home"), // never the real $HERMES_HOME
    isGitWorkTree: () => false, // never the real location of the temp dir
  };
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => {
    const file = which === "user"
      ? join(home, ".claude", "skilletor.json")
      : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  const wti = join(projectDir, ".worktreeinclude");
  return { tmp, ctx, home, projectDir, wti, writeCfg, cleanup: () => tmp.cleanup() };
}

function source(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return resolvePath(dir);
}

const BLOCK = (...entries: string[]) => ["# >>> skilletor >>>", ...entries, "# <<< skilletor <<<"].join("\n") + "\n";
const SKILL_MD = "---\nname: foo\ndescription: foo\n---\nFOO\n";
const AGENT_MD = "---\nname: a\ndescription: A\n---\nAGENT\n";
const RULE_MD = "RULE\n";
const FILES = { "skills/foo/SKILL.md": SKILL_MD, "skills/foo/ref/deep.md": "DEEP\n", "agents/a.md": AGENT_MD, "rules/r.md": RULE_MD };
const INSTALL = { skills: ["foo@mine"], agents: ["a@mine"], rules: ["r@mine"] };
/** The fixed block (spec §6.4): every project root of every harness, the lock and the local config. */
const WTI_BLOCK = BLOCK(
  "/.agents/skills/", "/.claude/agents/**/.local.*", "/.claude/rules/**/.local.*",
  "/.claude/skilletor.local.json", "/.claude/skilletor.lock.json", "/.claude/skills/",
  "/.codex/agents/**/.local.*", "/.codex/skilletor-rules.md", "/.hermes/skills/",
);

const projectOf = (r: Awaited<ReturnType<typeof sync>>) => r.scopes.find((s) => s.scope === "project")!;
const layoutOf = async (ctx: EngineContext) => (await check(ctx, { scope: "project" })).layoutChanged;

// Asserts: the block helper writes `.worktreeinclude` like a `.gitignore` – sorted entries
// after the user's lines, the user's lines kept on removal, a file of only the block deleted.
test("k124: updateWorktreeInclude keeps the user's lines and deletes a file that held only the block", () => {
  const tmp = makeTmpDir();
  try {
    const p = join(tmp.dir, ".worktreeinclude");
    assert.equal(updateWorktreeInclude({ dir: tmp.dir, entries: ["/b", "/a"], enabled: true }), "created");
    assert.equal(readFileSync(p, "utf8"), BLOCK("/a", "/b"));
    assert.equal(updateWorktreeInclude({ dir: tmp.dir, entries: [], enabled: true }), "removed");
    assert.equal(existsSync(p), false);
    writeFileSync(p, ".env\n");
    assert.equal(updateWorktreeInclude({ dir: tmp.dir, entries: ["/a"], enabled: true }), "created");
    assert.equal(readFileSync(p, "utf8"), ".env\n\n" + BLOCK("/a"));
    assert.equal(updateWorktreeInclude({ dir: tmp.dir, entries: ["/a"], enabled: false }), "removed");
    assert.equal(readFileSync(p, "utf8"), ".env\n");
    assert.equal(existsSync(join(tmp.dir, ".gitignore")), false); // the other file is never touched
  } finally {
    tmp.cleanup();
  }
});

// Asserts: a project in use (gitignore on) gets the fixed block; the report asks once to
// commit `.worktreeinclude`; items and targets changing later change neither the file nor ask
// again (k62's rule: a committed file does not follow machine state). Never in the user scope.
test("k124: a project in use gets a fixed .worktreeinclude block, with one commit hint", async () => {
  const e = env();
  try {
    const src = source(e.tmp.dir, "s", FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    const r = await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), WTI_BLOCK);
    assert.deepEqual(projectOf(r).gitignoreUpdated, [".claude/.gitignore", ".worktreeinclude"]);
    assert.match(reportText(r), /^ {2}\.worktreeinclude updated — commit it$/m);
    assert.match(reportHook(r).systemMessage ?? "", /\.claude\/\.gitignore, \.worktreeinclude updated — commit them$/);
    const mtime = statSync(e.wti).mtimeMs;
    e.writeCfg("project", { install: INSTALL });
    const more = await sync(e.ctx);
    assert.equal(projectOf(more).added.length, 2);
    e.writeCfg("user", { targets: ["claude", "codex", "hermes"], sources: { mine: { local: src } } });
    const targets = await sync(e.ctx);
    assert.equal(projectOf(targets).added.length, 3);
    assert.equal(statSync(e.wti).mtimeMs, mtime);
    assert.equal(projectOf(more).gitignoreUpdated, undefined);
    assert.deepEqual(projectOf(targets).gitignoreUpdated, [".codex/.gitignore"]); // Codex's own root, not this file
    assert.equal(existsSync(join(e.home, ".worktreeinclude")), false);
  } finally {
    e.cleanup();
  }
});

// Asserts, with git's own matcher: every file git ignores after a sync – the skill files
// (a nested one too), agents and rules of Claude and Codex, the Codex rules file, Hermes' own
// project copy, the lock – matches the block; a file the user keeps unignored does not
// (Claude Code copies what is ignored and matches).
test("k124: the block covers every file a sync leaves gitignored, for each harness", async () => {
  const e = env(["claude", "codex"]);
  try {
    const src = source(e.tmp.dir, "s", FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: INSTALL });
    const p = e.projectDir;
    const git = (...args: string[]) => execFileSync("git", ["-C", p, ...args], { encoding: "utf8" });
    const lines = (s: string) => s.split("\n").filter(Boolean).sort();
    const uncovered = (): string[] => {
      const ignored = lines(git("ls-files", "--others", "--ignored", "--exclude-standard"));
      const matched = lines(git("ls-files", "--others", "--ignored", `--exclude-from=${e.wti}`));
      assert.equal(matched.includes(".claude/agents.md"), false);
      return ignored.filter((f) => !matched.includes(f));
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(p, ".claude/agents.md"), "untracked, not ignored\n");
    await sync(e.ctx);
    assert.deepEqual(lines(git("ls-files", "--others", "--ignored", "--exclude-standard")), [
      ".agents/skills/foo/.gitignore", ".agents/skills/foo/SKILL.md", ".agents/skills/foo/ref/deep.md",
      ".claude/agents/.local.a.md", ".claude/rules/.local.r.md", ".claude/skilletor.lock.json",
      ".claude/skills/foo/.gitignore", ".claude/skills/foo/SKILL.md", ".claude/skills/foo/ref/deep.md",
      ".codex/agents/.local.a.toml", ".codex/skilletor-rules.md",
    ]);
    assert.deepEqual(uncovered(), []);

    e.writeCfg("user", { targets: ["claude", "hermes"], sources: { mine: { local: src } } });
    await sync(e.ctx);
    assert.equal(existsSync(join(p, ".hermes/skills/foo/SKILL.md")), true);
    assert.deepEqual(uncovered(), []);
  } finally {
    e.cleanup();
  }
});

// Asserts: the user's lines stay through every sync; the block stays while the project is in
// use, also with nothing installed, and goes – no commit hint – when it no longer is, and with
// "gitignore": false; a file that held only the block is deleted.
test("k124: own lines stay; the block goes when the project stops using skilletor or with \"gitignore\": false", async () => {
  const e = env();
  try {
    const src = source(e.tmp.dir, "s", FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    writeFileSync(e.wti, ".env\nconfig/secrets.json\n");
    await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), ".env\nconfig/secrets.json\n\n" + WTI_BLOCK);
    e.writeCfg("project", {});
    await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), ".env\nconfig/secrets.json\n\n" + WTI_BLOCK); // still in use
    rmSync(join(e.projectDir, ".claude/skilletor.json"));
    const gone = await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), ".env\nconfig/secrets.json\n");
    assert.equal(projectOf(gone).gitignoreUpdated, undefined);

    rmSync(e.wti);
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), WTI_BLOCK);
    e.writeCfg("project", { install: { skills: ["foo@mine"] }, gitignore: false });
    const off = await sync(e.ctx);
    assert.equal(existsSync(e.wti), false); // only the block was there: the file goes
    assert.equal(projectOf(off).gitignoreUpdated, undefined);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

// Asserts: a project scope not in use (no config, no lock) gets no `.worktreeinclude`, and a
// sync that only installs user items writes none.
test("k124: user items alone and an unused project write no .worktreeinclude", async () => {
  const e = env();
  try {
    const src = source(e.tmp.dir, "s", FILES);
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    assert.equal(existsSync(e.wti), false);
    assert.equal(existsSync(join(e.home, ".worktreeinclude")), false);
  } finally {
    e.cleanup();
  }
});

// Asserts: `check` counts a block that is not the one a sync writes as layout drift – missing
// (a project synced before k124), edited, left in a project no longer in use – and a sync
// settles each, after which check is quiet.
test("k124: check sees a missing, edited or leftover .worktreeinclude block; the sync settles it", async () => {
  const e = env();
  try {
    const src = source(e.tmp.dir, "s", FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: INSTALL });
    await sync(e.ctx);
    assert.equal(await layoutOf(e.ctx), undefined);
    rmSync(e.wti); // what a sync before k124 left
    assert.deepEqual(await layoutOf(e.ctx), ["project"]);
    await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), WTI_BLOCK);
    assert.equal(await layoutOf(e.ctx), undefined);
    writeFileSync(e.wti, BLOCK("/.claude/skills/"));
    assert.deepEqual(await layoutOf(e.ctx), ["project"]);
    await sync(e.ctx);
    assert.equal(await layoutOf(e.ctx), undefined);

    // An unused project with a block left behind: drift, and the sync removes it.
    rmSync(join(e.projectDir, ".claude"), { recursive: true });
    mkdirSync(join(e.projectDir, ".claude"));
    writeFileSync(e.wti, ".env\n\n" + WTI_BLOCK);
    assert.deepEqual(await layoutOf(e.ctx), ["project"]);
    await sync(e.ctx);
    assert.equal(readFileSync(e.wti, "utf8"), ".env\n");
    assert.equal(await layoutOf(e.ctx), undefined);
  } finally {
    e.cleanup();
  }
});

// Asserts (black box, spec §8): a `.worktreeinclude` skilletor cannot write – here a directory
// – never disturbs the session: the hook installs the item and says one warning, and `check`
// does not count that block as drift again (the sync recorded it as unreached).
test("k124: session-start with an unwritable .worktreeinclude warns once and installs the item", async () => {
  const e = env();
  try {
    const src = source(e.tmp.dir, "s", FILES);
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["foo@mine"] } });
    mkdirSync(e.wti);
    const hookCtx = { ...e.ctx, background: () => {} };
    const out = await runHook("session-start", { source: "startup", cwd: e.projectDir }, hookCtx);
    assert.match(out.systemMessage ?? "", /^skilletor: 1 item\(s\) updated, 1 warning\(s\)/);
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /^- warning: \.worktreeinclude not updated: /m);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/foo/SKILL.md")), true);
    assert.equal(await layoutOf(e.ctx), undefined);
  } finally {
    e.cleanup();
  }
});
