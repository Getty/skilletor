// Trust follows the backend that is used (spec §3 "Merging sources", §4.3; k66).
//
// A project config must never change what a user-scope item is built from, and a
// backend of project origin needs a trust entry for exactly its kind and address.
// Negative cases prove the untrusted backend was neither fetched (no cache dir, no
// fetch call) nor rendered (no output files). No network: git fixtures are file://.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { check, status, sync } from "../src/engine.ts";
import { cmdAdd, cmdAvailable, cmdInstall, cmdSourceList, cmdTrust } from "../src/commands.ts";
import { runHook, type HookContext } from "../src/hooks.ts";

/** A git URL that fails loudly if it is ever contacted. */
const NEVER = "file:///nonexistent/skilletor-k66/never-contacted.git";

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  const stateRoot = join(tmp.dir, "state");
  const cacheRoot = join(tmp.dir, "cache");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot,
    cacheRoot,
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    isGitWorkTree: () => false, // never the real location of the temp dir
    gitTracked: () => [],
    background: () => {},
  };
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => {
    const file = which === "user"
      ? join(home, ".claude", "skilletor.json")
      : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  /** Write trust.json as is (e.g. the pre-k66 format: name -> URL string). */
  const writeTrust = (obj: unknown) => {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "trust.json"), JSON.stringify(obj, null, 2));
  };
  const readTrust = () => JSON.parse(readFileSync(join(stateRoot, "trust.json"), "utf8")) as Record<string, unknown>;
  /** Nothing was fetched: no git clone and no tarball landed in the cache. */
  const cacheEmpty = () => !existsSync(cacheRoot) || readdirSync(cacheRoot).length === 0;
  const userFile = (p: string) => join(home, ".claude", p);
  const projectFile = (p: string) => join(projectDir, ".claude", p);
  return { tmp, ctx, home, projectDir, stateRoot, cacheRoot, writeCfg, writeTrust, readTrust, cacheEmpty, userFile, projectFile };
}

const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A local source directory; returns its real path. */
function dirSource(dir: string, files: Record<string, string>): string {
  writeFiles(dir, files);
  return realpathSync(dir);
}

const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
};

/** A bare repo reachable as file://, seeded with `files`; `push` adds a commit and returns its sha. */
function gitSource(root: string, name: string, files: Record<string, string>) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: GIT_ENV, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare], { env: GIT_ENV });
  mkdirSync(work, { recursive: true });
  git("init", "-q", "-b", "main");
  const url = "file://" + realpathSync(bare);
  const push = (next: Record<string, string>): string => {
    writeFiles(work, next);
    git("add", ".");
    git("commit", "-qm", "c");
    git("push", "-q", url, "main");
    return git("rev-parse", "HEAD");
  };
  const first = push(files);
  return { url, first, push };
}

/** The installed copy of skill `foo` under a scope, or undefined. */
function fooOf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

// ---- the audit probes (k66) --------------------------------------------------------

test("probe 01: a project `local` on a user git source never reaches the user scope; the project scope asks for trust", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "shared", { "skills/foo/SKILL.md": SKILL("foo", "FROM-USER-GIT") });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/foo/SKILL.md.njk": "PROJECT-PAYLOAD {{ scope }}\n" });
    e.writeCfg("user", { sources: { shared: { git: repo.url } }, install: { skills: ["foo@shared"] } });
    e.writeCfg("project", { sources: { shared: { local: payload } }, install: { skills: ["foo@shared"] } });

    const r = await sync(e.ctx);
    // The global install is still built from the user's git source.
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /FROM-USER-GIT/);
    assert.deepEqual(r.scopes[0]!.trustRequests, []);
    // The project scope sees the merged source, whose `local` came from the project: trust it first.
    assert.deepEqual(r.scopes[1]!.trustRequests, [{ name: "shared", kind: "local", url: payload }]);
    assert.equal(existsSync(e.projectFile("skills/foo")), false);
  } finally {
    e.tmp.cleanup();
  }
});

test("probe 02: a project source trusted by its git URL that gains `local` asks again; the local dir is not read", async () => {
  const e = env();
  try {
    const url = "https://example.invalid/trusted.git";
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/foo/SKILL.md": SKILL("foo", "SWAPPED") });
    e.writeTrust({ team: url }); // pre-k66 entry: name -> URL
    e.writeCfg("project", { sources: { team: { git: url, local: payload } }, install: { skills: ["foo@team"] } });

    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "team", kind: "local", url: payload }]);
    assert.equal(existsSync(e.projectFile("skills/foo")), false);
    assert.equal(e.cacheEmpty(), true);
  } finally {
    e.tmp.cleanup();
  }
});

// ---- the chosen backend switches -----------------------------------------------------

test("a trusted project git source whose project `local` dir appears asks again; the installed copy stays", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "team", { "skills/foo/SKILL.md": SKILL("foo", "FROM-GIT") });
    const payloadDir = join(e.tmp.dir, "payload"); // not there yet
    e.writeCfg("project", { sources: { team: { git: repo.url, local: payloadDir } }, install: { skills: ["foo@team"] } });

    // `trust` stores the backend that would be used: git, the local dir is missing.
    assert.deepEqual(cmdTrust(e.ctx, { name: "team" }), { name: "team", kind: "git", url: repo.url });
    let r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, []);
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /FROM-GIT/);

    const payload = dirSource(payloadDir, { "skills/foo/SKILL.md": SKILL("foo", "LOCAL-PAYLOAD") });
    r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "team", kind: "local", url: payload }]);
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /FROM-GIT/); // kept, not re-rendered
    assert.deepEqual(status(e.ctx, { scope: "project" }).scopes[0]!.trustRequests, [{ name: "team", kind: "local", url: payload }]);
    assert.deepEqual((await check(e.ctx, { scope: "project" })).sources, []); // untrusted: not checked

    // Trusting the local dir replaces the git entry; when the dir goes, git needs trust again.
    assert.deepEqual(cmdTrust(e.ctx, { name: "team" }), { name: "team", kind: "local", url: payload });
    r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, []);
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /LOCAL-PAYLOAD/);
    rmSync(payload, { recursive: true });
    r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "team", kind: "git", url: repo.url }]);
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /LOCAL-PAYLOAD/); // kept
  } finally {
    e.tmp.cleanup();
  }
});

for (const where of ["user", "local"] as const) {
  test(`author mode: a \`local\` checkout in the ${where} config over a project git source is read, trusted, no request`, async () => {
    const e = env();
    try {
      dirSource(join(e.home, "dev", "skills"), { "skills/foo/SKILL.md": SKILL("foo", "CHECKOUT") });
      e.writeCfg("project", { sources: { shared: { git: NEVER } }, install: { skills: ["foo@shared"] } });
      e.writeCfg(where, { sources: { shared: { local: "~/dev/skills" } } });

      const r = await sync(e.ctx, { scope: "project" });
      assert.deepEqual(r.scopes[0]!.trustRequests, []);
      assert.deepEqual(r.scopes[0]!.warnings, []);
      assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /CHECKOUT/);
      assert.equal(e.cacheEmpty(), true);
      assert.deepEqual(status(e.ctx, { scope: "project" }).scopes[0]!.trustRequests, []);
      // A local backend is always re-rendered: check reports it changed, without a fetch.
      assert.deepEqual((await check(e.ctx, { scope: "project" })).sources, [{ name: "shared", scope: "project", changed: true }]);
      assert.equal(e.cacheEmpty(), true);
    } finally {
      e.tmp.cleanup();
    }
  });
}

test("a missing user `local` dir: the project git fallback needs its own trust and is neither fetched nor rendered", async () => {
  const e = env();
  try {
    e.writeCfg("user", { sources: { shared: { local: join(e.tmp.dir, "missing") } } });
    e.writeCfg("project", { sources: { shared: { git: NEVER } }, install: { skills: ["foo@shared"] } });

    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "shared", kind: "git", url: NEVER }]);
    assert.deepEqual(r.scopes[0]!.warnings, []); // no fetch attempted
    assert.equal(e.cacheEmpty(), true);
    assert.equal(existsSync(e.projectFile("skills/foo")), false);
    const chk = await check(e.ctx, { scope: "project" });
    assert.deepEqual([chk.sources, chk.warnings], [[], []]);
    assert.equal(e.cacheEmpty(), true);
  } finally {
    e.tmp.cleanup();
  }
});

test("a missing user `local` dir: a project url fallback is untrusted and never fetched", async (t) => {
  const e = env();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  try {
    const url = "https://example.invalid/skills.tar.gz";
    e.writeCfg("user", { sources: { shared: { local: join(e.tmp.dir, "missing") } } });
    e.writeCfg("project", { sources: { shared: { url } }, install: { skills: ["foo@shared"] } });

    const r = await sync(e.ctx, { scope: "project" });
    await check(e.ctx, { scope: "project" });
    assert.equal(calls, 0);
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "shared", kind: "url", url }]);
    assert.equal(e.cacheEmpty(), true);
    assert.equal(existsSync(e.projectFile("skills/foo")), false);
  } finally {
    e.tmp.cleanup();
  }
});

// ---- trust.json -------------------------------------------------------------------

test("a pre-k66 trust entry (name + URL) still trusts that git URL, never a local path", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "team", { "skills/foo/SKILL.md": SKILL("foo", "LEGACY-GIT") });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/bar/SKILL.md": SKILL("bar", "LOCAL") });
    e.writeTrust({ team: repo.url, other: payload });
    e.writeCfg("project", {
      sources: { team: { git: repo.url }, other: { local: payload } },
      install: { skills: ["foo@team", "bar@other"] },
    });

    const r = await sync(e.ctx, { scope: "project" });
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /LEGACY-GIT/);
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "other", kind: "local", url: payload }]);
    assert.equal(existsSync(e.projectFile("skills/bar")), false);
  } finally {
    e.tmp.cleanup();
  }
});

test("trust stores kind and address; the entry lapses when the address changes", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "team", { "skills/foo/SKILL.md": SKILL("foo", "GIT") });
    e.writeCfg("project", { sources: { team: { git: repo.url } }, install: { skills: ["foo@team"] } });
    cmdTrust(e.ctx, { name: "team" });
    assert.deepEqual(e.readTrust(), { team: { kind: "git", address: repo.url } });
    e.writeCfg("project", { sources: { team: { url: "https://example.invalid/x.tar.gz" } }, install: { skills: ["foo@team"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests, [{ name: "team", kind: "url", url: "https://example.invalid/x.tar.gz" }]);
    assert.equal(e.cacheEmpty(), true);
  } finally {
    e.tmp.cleanup();
  }
});

// ---- the user scope resolves from the user config alone ------------------------------

test("a user bundle's entries of another source resolve from the user config alone", async () => {
  const e = env();
  try {
    const peter = gitSource(e.tmp.dir, "peter", { "skills/foo/SKILL.md": SKILL("foo", "FROM-USER-GIT") });
    const mine = dirSource(join(e.tmp.dir, "mine"), {
      "bundles/perl.yaml": `description: P\nskills: ["foo@${peter.url}"]\n`,
    });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/foo/SKILL.md": SKILL("foo", "PROJECT-PAYLOAD") });
    e.writeCfg("user", {
      sources: { mine: { local: mine }, peter: { git: peter.url } },
      install: { bundles: ["perl@mine"] },
    });
    e.writeCfg("project", { sources: { peter: { local: payload } } });

    const r = await sync(e.ctx);
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /FROM-USER-GIT/);
    assert.deepEqual(r.scopes[0]!.trustRequests, []);
  } finally {
    e.tmp.cleanup();
  }
});

test("neither skilletor.json nor skilletor.local.json can change a user-scope item's ref", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "shared", { "skills/foo/SKILL.md": SKILL("foo", "OLD") });
    repo.push({ "skills/foo/SKILL.md": SKILL("foo", "NEW") });
    e.writeCfg("user", { sources: { shared: { git: repo.url } }, install: { skills: ["foo@shared"] } });
    e.writeCfg("project", { sources: { shared: { git: repo.url, ref: repo.first } } });
    await sync(e.ctx, { scope: "user" });
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /NEW/);

    e.writeCfg("project", {});
    e.writeCfg("local", { sources: { shared: { git: repo.url, ref: repo.first } } });
    await sync(e.ctx, { scope: "user" });
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /NEW/);
  } finally {
    e.tmp.cleanup();
  }
});

// ---- check, status and trust agree with sync ---------------------------------------

test("check, status and trust agree with sync on the backend each scope uses", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "shared", { "skills/foo/SKILL.md": SKILL("foo", "USER-GIT") });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/foo/SKILL.md": SKILL("foo", "PROJECT-PAYLOAD") });
    e.writeCfg("user", { sources: { shared: { git: repo.url } }, install: { skills: ["foo@shared"] } });
    e.writeCfg("project", { sources: { shared: { local: payload } }, install: { skills: ["foo@shared"] } });

    await sync(e.ctx);
    // The user scope checks its git source (unchanged since the sync) – a local one would report changed.
    assert.deepEqual((await check(e.ctx, { scope: "user" })).sources, [{ name: "shared", scope: "user", changed: false }]);
    assert.deepEqual((await check(e.ctx, { scope: "project" })).sources, []);
    const st = status(e.ctx);
    assert.deepEqual(st.scopes.map((s) => s.trustRequests), [[], [{ name: "shared", kind: "local", url: payload }]]);

    // `trust` records the backend the project scope would use: the project's local dir.
    assert.deepEqual(cmdTrust(e.ctx, { name: "shared" }), { name: "shared", kind: "local", url: payload });
    assert.deepEqual(e.readTrust(), { shared: { kind: "local", address: payload } });
    const r = await sync(e.ctx);
    assert.deepEqual(r.scopes.map((s) => s.trustRequests), [[], []]);
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /PROJECT-PAYLOAD/);
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /USER-GIT/);
    assert.deepEqual((await check(e.ctx, { scope: "project" })).sources, [{ name: "shared", scope: "project", changed: true }]);
    assert.deepEqual((await check(e.ctx, { scope: "user" })).sources, [{ name: "shared", scope: "user", changed: false }]);
  } finally {
    e.tmp.cleanup();
  }
});

// ---- the hook reports the backend (black box) ----------------------------------------

test("session-start names the untrusted local backend and still installs the user item from git", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "shared", { "skills/foo/SKILL.md": SKILL("foo", "FROM-USER-GIT") });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/foo/SKILL.md": SKILL("foo", "PROJECT-PAYLOAD") });
    e.writeCfg("user", { sources: { shared: { git: repo.url } }, install: { skills: ["foo@shared"] } });
    e.writeCfg("project", { sources: { shared: { local: payload } }, install: { skills: ["foo@shared"] } });

    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.ok(out.hookSpecificOutput?.additionalContext?.includes(`untrusted source shared (local ${payload})`));
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /FROM-USER-GIT/);
    assert.equal(existsSync(e.projectFile("skills/foo")), false);
  } finally {
    e.tmp.cleanup();
  }
});

// ---- commands use the scope's sources and the one resolver -------------------------

test("install into the user scope reads the user config's source; a project-only source needs --project", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "shared", { "skills/foo/SKILL.md": SKILL("foo", "FROM-USER-GIT") });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/bar/SKILL.md": SKILL("bar", "PROJECT-PAYLOAD") });
    e.writeCfg("user", { sources: { shared: { git: repo.url } } });
    e.writeCfg("project", { sources: { shared: { local: payload }, team: { git: NEVER } } });

    // `bar` exists only in the project's local dir, which the user scope never reads.
    await assert.rejects(cmdInstall(e.ctx, { items: ["bar@shared"] }), /unknown item "bar" in shared/);
    assert.equal(existsSync(e.userFile("skills/bar")), false);
    await assert.rejects(cmdInstall(e.ctx, { items: ["x@team"] }), /unknown source: team in the user config \(a project declares it: use --project\)/);
    await cmdInstall(e.ctx, { items: ["foo@shared"] });
    assert.match(fooOf(e.userFile("skills/foo/SKILL.md")) ?? "", /FROM-USER-GIT/);
    // --project resolves the merged source: the project's local dir, untrusted.
    await assert.rejects(cmdInstall(e.ctx, { items: ["bar@shared"], project: true }), /source "shared" is not trusted/);
    assert.equal(e.cacheEmpty(), false); // only the user's git source was fetched
  } finally {
    e.tmp.cleanup();
  }
});

test("available lists what install would read; source list names the origin of the backend in use", async () => {
  const e = env();
  try {
    const repo = gitSource(e.tmp.dir, "shared", { "skills/foo/SKILL.md": SKILL("foo", "FROM-USER-GIT") });
    const payload = dirSource(join(e.tmp.dir, "payload"), { "skills/bar/SKILL.md": SKILL("bar", "PROJECT-PAYLOAD") });
    const team = dirSource(join(e.tmp.dir, "team"), { "skills/baz/SKILL.md": SKILL("baz", "TEAM") });
    e.writeCfg("user", { sources: { shared: { git: repo.url } } });
    e.writeCfg("project", { sources: { shared: { local: payload }, team: { local: team } } });

    assert.deepEqual((await cmdAvailable(e.ctx)).map((i) => `${i.name}@${i.source}`), ["foo@shared"]);
    assert.deepEqual(cmdSourceList(e.ctx).map((s) => [s.name, s.origin]), [["shared", "project"], ["team", "project"]]);
    cmdTrust(e.ctx, { name: "team" });
    assert.deepEqual((await cmdAvailable(e.ctx)).map((i) => `${i.name}@${i.source}`), ["foo@shared", "baz@team"]);
  } finally {
    e.tmp.cleanup();
  }
});

test("add --project of a ~/ local path trusts its real path; install and sync need no further trust", async () => {
  const e = env();
  try {
    const src = dirSource(join(e.home, "srcs", "team"), { "skills/foo/SKILL.md": SKILL("foo", "TEAM") });
    await cmdAdd(e.ctx, { name: "team", spec: "~/srcs/team", project: true });
    assert.deepEqual(e.readTrust(), { team: { kind: "local", address: src } });
    const r = await cmdInstall(e.ctx, { items: ["foo@team"], project: true });
    assert.deepEqual(r.scopes.map((s) => s.trustRequests), [[], []]);
    assert.match(fooOf(e.projectFile("skills/foo/SKILL.md")) ?? "", /TEAM/);
  } finally {
    e.tmp.cleanup();
  }
});
