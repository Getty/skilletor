// k91: git's repository-local variables (`git rev-parse --local-env-vars`: GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, …), exported where skilletor runs – a git hook, `git rebase -x`, tooling – never
// steer the git skilletor runs: not in a source's cache, not `ls-remote`, not a question about
// the project. Real git, local repos, temp dirs. process.env is set only around the call under
// test and restored in `finally`; fixtures run git with the environment this file started with.
// k93: `npm test` itself drops those variables before any test file runs (test/setup.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { gitEnv } from "../src/gitenv.ts";
import { GitSource } from "../src/sources/git.ts";
import { makeProbe } from "../src/probe.ts";
import { gitTracked, isGitWorkTree } from "../src/gitignore.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { sync, type EngineContext } from "../src/engine.ts";

const G = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: G, encoding: "utf8" }).trim();

/** Run `fn` with `vars` exported; process.env is restored whatever `fn` does. */
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A bare repo named `name`; `commit(text)` pushes `file.txt` (and `theirs.txt`) and returns the SHA. */
function makeRepo(tmp: TmpDir, name = "repo") {
  const bare = join(tmp.dir, `${name}.git`);
  const work = join(tmp.dir, `${name}-work`);
  git(tmp.dir, "init", "-q", "-b", "main", "--bare", bare);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const url = "file://" + resolvePath(bare);
  const commit = (text: string) => {
    writeFileSync(join(work, "file.txt"), `${text}\n`);
    writeFileSync(join(work, "theirs.txt"), `${text}\n`);
    git(work, "add", ".");
    git(work, "commit", "-qm", text);
    git(work, "push", "-q", url, "main");
    return git(work, "rev-parse", "HEAD");
  };
  return { url, commit };
}

/** A repository with one commit (`file.txt`, `mine`) and no remote: what an exported GIT_DIR names. */
function makeVictim(tmp: TmpDir) {
  const dir = join(tmp.dir, "victim");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "file.txt"), "mine\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "mine");
  /** Remotes, HEAD, index and work tree against HEAD, the files, the config. */
  const snapshot = () => ({
    remotes: git(dir, "remote", "-v"),
    head: git(dir, "rev-parse", "HEAD"),
    status: git(dir, "status", "--porcelain", "--untracked-files=all"),
    files: readdirSync(dir).sort(),
    file: readFileSync(join(dir, "file.txt"), "utf8"),
    config: readFileSync(join(dir, ".git", "config"), "utf8"),
  });
  return { dir, gitDir: join(dir, ".git"), snapshot };
}

// The list gitEnv drops is hard-coded from git 2.47.3. Asserts, against the installed git: every
// variable `git rev-parse --local-env-vars` lists is gone from gitEnv() – but the command-line
// config GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT (with KEY_n/VALUE_n), kept as git keeps them
// for a submodule; auth, ssh, proxy, HOME and user-level config pass through; GIT_TERMINAL_PROMPT
// is 0; `extra` is added last. A git that lists a new variable fails here: add it to the list.
// Red on purpose after a git upgrade (a CI runner's too) that grows the list – not a flake.
test("k91: gitEnv drops what git lists as repository-local, but the command-line config", async () => {
  const listed = git(tmpdir(), "rev-parse", "--local-env-vars").split("\n").filter(Boolean);
  assert.ok(listed.includes("GIT_DIR") && listed.includes("GIT_WORK_TREE"), listed.join(" "));
  const commandLine = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const passThrough = [
    "HOME", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_AUTH_SOCK", "HTTPS_PROXY", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES",
  ];
  const vars = Object.fromEntries([...listed, ...commandLine, ...passThrough].map((k) => [k, `set-${k}`]));
  const env = await withEnv({ ...vars, GIT_TERMINAL_PROMPT: "1" }, () => gitEnv({ GIT_CEILING_DIRECTORIES: "/extra" }));

  const dropped = listed.filter((k) => !commandLine.includes(k));
  assert.deepEqual(dropped.filter((k) => k in env), [], "repository-local variables left in the git env");
  for (const k of [...commandLine, ...passThrough.filter((k) => k !== "GIT_CEILING_DIRECTORIES")]) {
    assert.equal(env[k], `set-${k}`, k);
  }
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CEILING_DIRECTORIES, "/extra");
});

// A git hook exports GIT_DIR (and a work tree) naming the repository it runs for. Asserts, for
// GIT_DIR + GIT_WORK_TREE and for GIT_WORK_TREE + GIT_INDEX_FILE alone, both for the resolve that
// creates the cache and for one that updates a cache an earlier run made after the source moved:
// the victim's remotes, HEAD, index, files and config stay as they were, and the resolve serves
// the source's commit from the cache's own repository, clean, with no warning.
for (const which of ["GIT_DIR + GIT_WORK_TREE", "GIT_WORK_TREE + GIT_INDEX_FILE"]) {
  for (const step of ["first resolve", "update"]) {
    test(`k91: ${step} with ${which} exported works in its cache; the repository they name is untouched`, async (t) => {
      const tmp = makeTmpDir();
      t.after(tmp.cleanup);
      const repo = makeRepo(tmp);
      let want = repo.commit("FIRST");
      const victim = makeVictim(tmp);
      const before = victim.snapshot();
      const vars: Record<string, string> = which === "GIT_DIR + GIT_WORK_TREE"
        ? { GIT_DIR: victim.gitDir, GIT_WORK_TREE: victim.dir }
        : { GIT_WORK_TREE: victim.dir, GIT_INDEX_FILE: join(victim.gitDir, "index") };
      const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
      if (step === "update") {
        await src.resolve();
        want = repo.commit("SECOND");
      }

      const loc = await withEnv(vars, () => src.resolve());
      assert.deepEqual(victim.snapshot(), before, `the repository ${which} names changed`);
      assert.equal(loc.warning, undefined);
      assert.equal(git(loc.dir, "rev-parse", "HEAD"), want, "the cache holds another commit");
      assert.equal(loc.version, `git:${git(loc.dir, "rev-parse", "--short", "HEAD")}`);
      assert.equal(readFileSync(join(loc.dir, "file.txt"), "utf8"), step === "update" ? "SECOND\n" : "FIRST\n");
      assert.equal(git(loc.dir, "rev-parse", "--absolute-git-dir"), join(realpathSync(loc.dir), ".git"));
      assert.equal(git(loc.dir, "status", "--porcelain", "--untracked-files=all"), "", "the cache is not clean");
    });
  }
}

// check's `ls-remote` needs no repository, but with GIT_DIR exported git reads that repository's
// config – a `url.<base>.insteadOf` there sends it to another remote. Asserts: with GIT_DIR naming a
// repository that rewrites the source's address to another repo's, check answers for the source:
// unchanged right after a resolve, changed once the source moved.
test("k91: check with GIT_DIR exported asks the source's remote, not one the named repository's config picks", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("FIRST");
  const other = makeRepo(tmp, "other");
  other.commit("OTHER");
  const victim = makeVictim(tmp);
  git(victim.dir, "config", `url.${other.url}.insteadOf`, repo.url);
  const src = new GitSource({ url: repo.url, cacheRoot: join(tmp.dir, "cache") });
  const loc = await src.resolve();

  await withEnv({ GIT_DIR: victim.gitDir }, async () => {
    assert.equal(await src.check(loc.version), false, "an unchanged source counted as changed");
    repo.commit("SECOND");
    assert.equal(await src.check(loc.version), true, "a moved source counted as unchanged");
  });
});

// `add`'s probe runs `git ls-remote` too. Asserts: with GIT_DIR naming a repository whose config
// rewrites a missing address to a real repo, the probe finds no git repo there; a real one it finds.
test("k91: the add probe with GIT_DIR exported asks the address it was given", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const repo = makeRepo(tmp);
  repo.commit("FIRST");
  const missing = "file://" + join(tmp.dir, "missing.git");
  const victim = makeVictim(tmp);
  git(victim.dir, "config", `url.${repo.url}.insteadOf`, missing);
  const probe = makeProbe(5_000);

  await withEnv({ GIT_DIR: victim.gitDir }, () => {
    assert.deepEqual(probe(missing), {}, "a missing address probed as a git repo");
    assert.deepEqual(probe(repo.url), { git: true });
  });
});

/** A project repository tracking `tracked.txt`, with a subdirectory `sub`; the victim tracks `file.txt`. */
function makeProject(tmp: TmpDir) {
  const dir = join(tmp.dir, "proj");
  mkdirSync(join(dir, "sub"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "tracked.txt"), "t\n");
  writeFileSync(join(dir, "sub", "keep"), "");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "proj");
  return dir;
}

// What skilletor asks git about a project is about the repository found from that directory: with
// GIT_DIR exported, `git -C <dir>` would answer for the repository GIT_DIR names, with <dir> as its
// work tree. Asserts, with GIT_DIR naming the victim: gitTracked names what the project tracks, not
// what the victim's index holds; a directory in no repository is no work tree, one in the project is.
test("k91: with GIT_DIR exported, gitTracked and isGitWorkTree answer for the repository at the directory", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const project = makeProject(tmp);
  const victim = makeVictim(tmp);
  const plain = join(tmp.dir, "plain");
  mkdirSync(plain);

  await withEnv({ GIT_DIR: victim.gitDir }, () => {
    assert.deepEqual(gitTracked(project, ["tracked.txt", "file.txt"]), ["tracked.txt"]);
    assert.equal(isGitWorkTree(plain), false, "a directory in no repository counted as a work tree");
    assert.equal(isGitWorkTree(join(project, "sub")), true);
  });
});

// The hook takes the project root from its cwd (`git rev-parse --show-toplevel`); with GIT_DIR
// exported, git names the cwd itself as the top level. Asserts, black box through runHook: from a
// subdirectory of the project, with GIT_DIR naming the victim, SessionStart reads the project's
// config at the project root – it names the untrusted source declared there.
test("k91: session-start from a project subdirectory with GIT_DIR exported finds the project root", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const project = makeProject(tmp);
  const victim = makeVictim(tmp);
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(home, ".claude", "skilletor.json"), "{}\n");
  const team = "file://" + join(tmp.dir, "team.git");
  writeFileSync(join(project, ".claude", "skilletor.json"),
    JSON.stringify({ sources: { team: { git: team } }, install: { skills: ["foo@team"] } }));
  const ctx: HookContext = {
    home,
    stateRoot: join(tmp.dir, "state"),
    cacheRoot: join(tmp.dir, "cache"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false,
    gitTracked: () => [],
    background: () => {},
  };

  const out = await withEnv({ GIT_DIR: victim.gitDir }, () =>
    runHook("session-start", { source: "startup", cwd: join(project, "sub") }, ctx));
  assert.equal(out.hookSpecificOutput?.additionalContext, `- untrusted source team (git ${team}); run: skilletor trust team`);
});

// `project.git_remote` is the project's origin. Asserts: a project-scope sync with GIT_DIR naming
// a repository with another origin renders the project's.
test("k91: with GIT_DIR exported, project.git_remote is the project's origin", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const project = makeProject(tmp);
  git(project, "remote", "add", "origin", "https://example.com/proj.git");
  const victim = makeVictim(tmp);
  git(victim.dir, "remote", "add", "origin", "https://example.com/victim.git");
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"));
  const src = join(tmp.dir, "src");
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills/foo/SKILL.md.njk"), "---\nname: foo\ndescription: foo\n---\nremote={{ project.git_remote }}\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { mine: { local: src } } }));
  writeFileSync(join(project, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["foo@mine"] } }));
  const ctx: EngineContext = {
    home,
    projectDir: project,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false,
    gitTracked: () => [],
  };

  await withEnv({ GIT_DIR: victim.gitDir }, () => sync(ctx, { scope: "project" }));
  const skill = join(project, ".claude/skills/foo/SKILL.md");
  assert.equal(existsSync(skill), true);
  assert.match(readFileSync(skill, "utf8"), /^remote=https:\/\/example\.com\/proj\.git$/m);
});

// k93: `npm test` run from a git hook inherits the hook's GIT_DIR, and a fixture's `git init`,
// `add` and `commit` in its temp dir acted on the repository GIT_DIR names – the developer's
// checkout. Asserts, running a one-test file that builds such a fixture with the flags of
// package.json's test script and GIT_DIR naming the victim: the victim's remotes, HEAD, index,
// files and config stay as they were, the file passes, and the commit is in the fixture's own repo.
test("k93: npm test with GIT_DIR exported builds a fixture in its temp dir, not in the repository GIT_DIR names", async (t) => {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const victim = makeVictim(tmp);
  const before = victim.snapshot();
  const root = fileURLToPath(new URL("..", import.meta.url));
  const script: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test;
  const [node, ...flags] = script.split(/\s+/);
  const glob = flags.pop();
  assert.deepEqual([node, glob], ["node", '"test/**/*.test.ts"'], `unexpected test script: ${script}`);
  const work = join(tmp.dir, "work");
  const fixture = join(tmp.dir, "fixture.test.mjs");
  writeFileSync(fixture, [
    'import { test } from "node:test";',
    'import { execFileSync } from "node:child_process";',
    'import { mkdirSync, writeFileSync } from "node:fs";',
    `const work = ${JSON.stringify(work)};`,
    'const git = (...args) => execFileSync("git", args, { cwd: work, stdio: "pipe" });',
    'test("a repository fixture", () => {',
    '  mkdirSync(work);',
    '  git("init", "-q", "-b", "main");',
    '  writeFileSync(`${work}/fixture.txt`, "fixture\\n");',
    '  git("add", ".");',
    '  git("commit", "-qm", "fixture");',
    '});',
    '',
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...G, GIT_DIR: victim.gitDir };
  delete env.NODE_TEST_CONTEXT; // set for this file's own run; the nested runner must not see it

  const r = spawnSync(process.execPath, [...flags, fixture], { cwd: root, env, encoding: "utf8" });
  assert.deepEqual(victim.snapshot(), before, "the repository GIT_DIR names changed");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(git(work, "log", "--format=%s"), "fixture", "the fixture's commit is not in its own repository");
});
