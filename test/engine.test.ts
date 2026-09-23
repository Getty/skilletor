// Integration tests for the engine (spec §6.1, §6.6, §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { sync, check, status, type EngineContext } from "../src/engine.ts";
import { reportHook, reportText } from "../src/report.ts";
import { readLock } from "../src/lock.ts";

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  const stateRoot = join(tmp.dir, "state");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: EngineContext = {
    home,
    projectDir,
    stateRoot,
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
  };
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => {
    const file =
      which === "user"
        ? join(home, ".claude", "skilletor.json")
        : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  return { tmp, ctx, home, projectDir, stateRoot, writeCfg, cleanup: () => tmp.cleanup() };
}

/** Create a local source dir with one skill. Returns its absolute path. */
function localSource(root: string, name: string, skill: string, body: string): string {
  const dir = join(root, name);
  const skillDir = join(dir, "skills", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} skill\n---\n${body}\n`);
  return resolvePath(dir);
}

test("sync installs a user-scope skill from a local source", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcA", "foo", "FOO-BODY");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const report = await sync(e.ctx, { scope: "user" });
    assert.equal(readFileSync(join(e.home, ".claude/skills/foo/SKILL.md"), "utf8").includes("FOO-BODY"), true);
    assert.equal("skills/foo" in readLock(join(e.home, ".claude/skilletor.lock.json")), true);
    assert.deepEqual(report.scopes[0]!.added.map((i) => i.key), ["skills/foo"]);
  } finally {
    e.cleanup();
  }
});

test("sync installs a project-scope skill and writes a gitignore block", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcB", "bar", "BAR");
    // user source (trusted), declared in user config; installed at project scope.
    e.writeCfg("user", { sources: { mine: { local: src } } });
    e.writeCfg("project", { install: { skills: ["bar@mine"] } });
    await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/bar/SKILL.md")), true);
    const gi = readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8");
    assert.match(gi, /skills\/bar\/SKILL\.md/);
    assert.match(gi, /skilletor\.lock\.json/);
  } finally {
    e.cleanup();
  }
});

test("author mode: a user local override wins over a project git definition", async () => {
  const e = env();
  try {
    const local = localSource(e.tmp.dir, "authorLocal", "moo", "LOCAL-CONTENT");
    // Project declares shared via a bogus git URL; user overrides with a real local.
    e.writeCfg("project", { sources: { shared: { git: "file:///nonexistent.git" } }, install: { skills: ["moo@shared"] } });
    e.writeCfg("user", { sources: { shared: { local } } });
    const report = await sync(e.ctx, { scope: "project" });
    assert.equal(readFileSync(join(e.projectDir, ".claude/skills/moo/SKILL.md"), "utf8").includes("LOCAL-CONTENT"), true);
    assert.equal(report.scopes[0]!.warnings.length, 0); // no git fetch attempted
  } finally {
    e.cleanup();
  }
});

test("an untrusted project-only source is skipped with a trust request", async () => {
  const e = env();
  try {
    e.writeCfg("project", { sources: { team: { git: "file:///whatever.git" } }, install: { skills: ["x@team"] } });
    const report = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(report.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
    assert.equal(existsSync(join(e.projectDir, ".claude/skills/x")), false);
  } finally {
    e.cleanup();
  }
});

test("a config error touches nothing and reports the error", async () => {
  const e = env();
  try {
    writeFileSync(join(e.home, ".claude/skilletor.json"), "{ broken json");
    const report = await sync(e.ctx, { scope: "user" });
    assert.match(report.error ?? "", /json/i);
    assert.equal(report.scopes.length, 0);
  } finally {
    e.cleanup();
  }
});

test("offline git source falls back to the cache and keeps the item", async () => {
  const e = env();
  try {
    // Build a bare repo with a skill.
    const bare = join(e.tmp.dir, "repo.git");
    const work = join(e.tmp.dir, "work");
    const G = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
    mkdirSync(join(work, "skills", "foo"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
    writeFileSync(join(work, "skills/foo/SKILL.md"), "---\ndescription: foo\n---\nGIT-BODY\n");
    execFileSync("git", ["add", "."], { cwd: work, env: { ...process.env, ...G } });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: work, env: { ...process.env, ...G } });
    const url = "file://" + resolvePath(bare);
    execFileSync("git", ["push", "-q", url, "main"], { cwd: work, env: { ...process.env, ...G } });

    e.writeCfg("user", { sources: { g: { git: url } }, install: { skills: ["foo@g"] } });
    await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);

    rmSync(bare, { recursive: true, force: true }); // go offline
    const report = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true); // kept
    assert.equal(report.scopes[0]!.warnings.some((w) => /cache/i.test(w)), true);
  } finally {
    e.cleanup();
  }
});

test("reportText renders a fresh install with the activation hint", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcR", "foo", "X");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const report = await sync(e.ctx, { scope: "user" });
    assert.match(reportText(report), /\+ skills\/foo \(active now\)/);
  } finally {
    e.cleanup();
  }
});

test("check reports change for a local source and status lists declared items", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcC", "foo", "X");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const chk = await check(e.ctx, { scope: "user" });
    assert.equal(chk.changed, true); // local is always "changed"
    const st = status(e.ctx, { scope: "user" });
    assert.deepEqual(st.scopes[0]!.declared.map((d) => d.key), ["skills/foo"]);
    assert.equal(st.scopes[0]!.declared[0]!.installed, false); // not synced yet
  } finally {
    e.cleanup();
  }
});

test("an item removed from config is deleted on the next sync", async () => {
  const e = env();
  try {
    const src = localSource(e.tmp.dir, "srcD", "foo", "X");
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { mine: { local: src } }, install: { skills: [] } });
    const report = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false);
    assert.deepEqual(report.scopes[0]!.removed.map((i) => i.key), ["skills/foo"]);
  } finally {
    e.cleanup();
  }
});
// ---- wildcards (k34) --------------------------------------------------------

/** Write a rule / agent / skill into a source dir (created on demand). */
function putItem(dir: string, type: "skill" | "agent" | "rule", name: string, body = name.toUpperCase()): void {
  if (type === "skill") {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\ndescription: ${name}\n---\n${body}\n`);
  } else {
    mkdirSync(join(dir, `${type}s`), { recursive: true });
    writeFileSync(join(dir, `${type}s`, `${name}.md`), `---\ndescription: ${name}\n---\n${body}\n`);
  }
}

test("wildcard installs every rule of a source, picks up additions and drops removals", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "wsrc");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    putItem(src, "skill", "notarule");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });

    const r1 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r1.scopes[0]!.added.map((i) => i.key).sort(), ["rules/alpha", "rules/beta"]);
    assert.deepEqual(r1.scopes[0]!.added.map((i) => i.source), ["shared", "shared"]);
    assert.equal(existsSync(join(e.home, ".claude/skills/notarule")), false); // other types untouched

    putItem(src, "rule", "gamma"); // upstream addition
    rmSync(join(src, "rules", "alpha.md")); // upstream removal
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r2.scopes[0]!.added.map((i) => i.key), ["rules/gamma"]);
    assert.deepEqual(r2.scopes[0]!.removed.map((i) => i.key), ["rules/alpha"]);
    assert.equal(existsSync(join(e.home, ".claude/rules/alpha.md")), false);
    assert.equal(existsSync(join(e.home, ".claude/rules/gamma.md")), true);
    assert.deepEqual(r2.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("wildcards work for skills and agents too", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "wall");
    putItem(src, "skill", "s1");
    putItem(src, "skill", "s2");
    putItem(src, "agent", "a1");
    e.writeCfg("user", {
      sources: { shared: { local: src } },
      install: { skills: ["*@shared"], agents: ["agent:*@shared"] },
    });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["agents/a1", "skills/s1", "skills/s2"]);
  } finally {
    e.cleanup();
  }
});

test("an unresolvable wildcard source keeps everything it installed", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "gone");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });
    await sync(e.ctx, { scope: "user" });

    rmSync(src, { recursive: true, force: true }); // source can no longer be resolved
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.equal(existsSync(join(e.home, ".claude/rules/alpha.md")), true);
    assert.equal(existsSync(join(e.home, ".claude/rules/beta.md")), true);
    assert.deepEqual(Object.keys(readLock(join(e.home, ".claude/skilletor.lock.json"))).sort(), ["rules/alpha", "rules/beta"]);
    assert.equal(r.scopes[0]!.warnings.some((w) => /shared/.test(w)), true);
  } finally {
    e.cleanup();
  }
});

test("an unresolvable wildcard source only keeps items of the wildcard's type and source", async () => {
  const e = env();
  try {
    const gone = join(e.tmp.dir, "gone2");
    const other = join(e.tmp.dir, "other2");
    putItem(gone, "rule", "alpha");
    putItem(other, "rule", "solo");
    e.writeCfg("user", {
      sources: { shared: { local: gone }, other: { local: other } },
      install: { rules: ["*@shared", "solo@other"] },
    });
    await sync(e.ctx, { scope: "user" });
    rmSync(gone, { recursive: true, force: true });
    e.writeCfg("user", { sources: { shared: { local: gone }, other: { local: other } }, install: { rules: ["*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed.map((i) => i.key), ["rules/solo"]); // undeclared, other source: removed
    assert.equal(existsSync(join(e.home, ".claude/rules/alpha.md")), true); // kept
  } finally {
    e.cleanup();
  }
});

test("explicit entry and wildcard of the same source dedupe silently", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "dd");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["alpha@shared", "*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/alpha", "rules/beta"]);
    assert.deepEqual(r.scopes[0]!.warnings, []);
  } finally {
    e.cleanup();
  }
});

test("explicit entry beats a wildcard of another source, with a warning", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "ea");
    const b = join(e.tmp.dir, "eb");
    putItem(a, "rule", "alpha", "FROM-A");
    putItem(b, "rule", "alpha", "FROM-B");
    putItem(b, "rule", "beta");
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { rules: ["alpha@a", "*@b"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`).sort(), ["rules/alpha@a", "rules/beta@b"]);
    assert.match(readFileSync(join(e.home, ".claude/rules/alpha.md"), "utf8"), /FROM-A/);
    assert.equal(r.scopes[0]!.warnings.length, 1);
    assert.match(r.scopes[0]!.warnings[0]!, /alpha/);
    assert.match(r.scopes[0]!.warnings[0]!, /\*@b/);
  } finally {
    e.cleanup();
  }
});

test("two wildcards yielding the same name skip only that name, with a warning", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "wa");
    const b = join(e.tmp.dir, "wb");
    putItem(a, "rule", "only-a");
    putItem(b, "rule", "only-b");
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { rules: ["*@a", "*@b"] } });
    const r1 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r1.scopes[0]!.warnings, []);

    putItem(a, "rule", "clash", "FROM-A"); // upstream addition in a …
    putItem(b, "rule", "clash", "FROM-B"); // … and in b
    putItem(b, "rule", "fresh");
    const r2 = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r2.scopes[0]!.added.map((i) => i.key), ["rules/fresh"]); // the rest proceeds
    assert.equal(existsSync(join(e.home, ".claude/rules/clash.md")), false);
    assert.equal(r2.scopes[0]!.warnings.length, 1);
    assert.match(r2.scopes[0]!.warnings[0]!, /clash/);
    assert.match(r2.scopes[0]!.warnings[0]!, /\*@a/);
    assert.match(r2.scopes[0]!.warnings[0]!, /\*@b/);
  } finally {
    e.cleanup();
  }
});

test("a wildcard collision keeps an already installed copy", async () => {
  const e = env();
  try {
    const a = join(e.tmp.dir, "ka");
    const b = join(e.tmp.dir, "kb");
    putItem(a, "rule", "clash", "FROM-A");
    mkdirSync(b, { recursive: true });
    e.writeCfg("user", { sources: { a: { local: a }, b: { local: b } }, install: { rules: ["*@a", "*@b"] } });
    await sync(e.ctx, { scope: "user" });
    putItem(b, "rule", "clash", "FROM-B");
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.removed, []);
    assert.match(readFileSync(join(e.home, ".claude/rules/clash.md"), "utf8"), /FROM-A/);
  } finally {
    e.cleanup();
  }
});

test("a wildcard skips an upstream item with an invalid name instead of failing the sync", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "bad");
    putItem(src, "rule", "good");
    putItem(src, "rule", "bad name");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/good"]);
    assert.equal(r.scopes[0]!.warnings.some((w) => /bad name/.test(w)), true);
  } finally {
    e.cleanup();
  }
});

test("a wildcard over an untrusted project-only source reports a trust request", async () => {
  const e = env();
  try {
    e.writeCfg("project", { sources: { team: { git: "file:///whatever.git" } }, install: { rules: ["*@team"] } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.deepEqual(r.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
    assert.deepEqual(r.scopes[0]!.added, []);
    const st = status(e.ctx, { scope: "project" });
    assert.deepEqual(st.scopes[0]!.trustRequests.map((t) => t.name), ["team"]);
  } finally {
    e.cleanup();
  }
});

test("status marks items that came from a wildcard and lists the wildcard", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "st");
    putItem(src, "rule", "alpha");
    putItem(src, "rule", "beta");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["alpha@shared", "*@shared"] } });
    await sync(e.ctx, { scope: "user" });
    const s = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(
      s.declared.map((d) => ({ key: d.key, via: d.via, installed: d.installed })),
      [
        { key: "rules/alpha", via: undefined, installed: true },
        { key: "rules/beta", via: "*@shared", installed: true },
      ],
    );
    assert.deepEqual(s.orphans, []);
    assert.deepEqual(s.wildcards, [{ type: "rule", source: "shared", entry: "*@shared", installed: 1 }]);
  } finally {
    e.cleanup();
  }
});

test("check covers sources referenced only by a wildcard", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "ck");
    putItem(src, "rule", "alpha");
    e.writeCfg("user", { sources: { shared: { local: src } }, install: { rules: ["*@shared"] } });
    const chk = await check(e.ctx, { scope: "user" });
    assert.deepEqual(chk.sources.map((s) => s.name), ["shared"]);
  } finally {
    e.cleanup();
  }
});

// ---- empty renders (k35) ----------------------------------------------------

/** Write a raw file into a source dir. */
function putRaw(dir: string, rel: string, content: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

const GATED = "---\npaths: [\"**/*.yaml\"]\n---\n{% if vars.k8s %}\nUse kubectl.\n{% endif %}\n";

test("a rule gated off by a var is not written and is reported as skipped", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g1");
    putRaw(src, "rules/k8s.md.njk", GATED);
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/rules/k8s.md")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);
    assert.deepEqual([r.scopes[0]!.added, r.scopes[0]!.warnings], [[], []]);
    assert.match(reportText(r), /rules\/k8s skipped \(renders empty\)/);
    assert.deepEqual(reportHook(r), {}); // nothing changed: the hook stays silent
  } finally {
    e.cleanup();
  }
});

test("toggling the var off removes the installed rule; toggling it on reinstalls it", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g2");
    putRaw(src, "rules/k8s.md.njk", GATED);
    const cfg = (on: boolean) => ({ sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: on } });
    const target = join(e.home, ".claude/rules/k8s.md");

    e.writeCfg("user", cfg(true));
    await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(target, "utf8"), /kubectl/);

    e.writeCfg("user", cfg(false));
    const off = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(target), false);
    assert.deepEqual(off.scopes[0]!.removed.map((i) => i.key), ["rules/k8s"]);
    assert.deepEqual(off.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);

    e.writeCfg("user", cfg(true));
    const on = await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(target, "utf8"), /kubectl/);
    assert.deepEqual(on.scopes[0]!.added.map((i) => i.key), ["rules/k8s"]);
    assert.deepEqual(on.scopes[0]!.skipped, []);
  } finally {
    e.cleanup();
  }
});

test("a project var can switch off a rule the user scope would install", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g3");
    putRaw(src, "rules/k8s.md.njk", GATED);
    e.writeCfg("user", { sources: { s: { local: src } }, vars: { k8s: true } });
    e.writeCfg("project", { install: { rules: ["k8s@s"] } });
    e.writeCfg("local", { vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "project" });
    assert.equal(existsSync(join(e.projectDir, ".claude/rules/k8s.md")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);
    assert.doesNotMatch(readFileSync(join(e.projectDir, ".claude/.gitignore"), "utf8"), /k8s/);
  } finally {
    e.cleanup();
  }
});

test("a non-template empty rule is still installed", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g4");
    putRaw(src, "rules/blank.md", "");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["blank@s"] } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/rules/blank.md")), true);
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/blank"]);
    assert.deepEqual(r.scopes[0]!.skipped, []);
  } finally {
    e.cleanup();
  }
});

test("a skill whose SKILL.md renders empty skips all its files", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g5");
    putRaw(src, "skills/kube/SKILL.md.njk", "{% if vars.k8s %}---\ndescription: k\n---\nK{% endif %}");
    putRaw(src, "skills/kube/reference.md", "REFERENCE");
    putRaw(src, "skills/kube/extra.md.njk", "EXTRA");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { skills: ["kube@s"] }, vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.equal(existsSync(join(e.home, ".claude/skills/kube")), false);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["skills/kube"]);
  } finally {
    e.cleanup();
  }
});

test("a wildcard item that renders empty is skipped without affecting its siblings", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g6");
    putRaw(src, "rules/k8s.md.njk", GATED);
    putRaw(src, "rules/plain.md", "PLAIN\n");
    putRaw(src, "rules/templ.md.njk", "T={{ vars.k8s }}\n");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["*@s"] }, vars: { k8s: false } });
    const r = await sync(e.ctx, { scope: "user" });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/plain", "rules/templ"]);
    assert.deepEqual(r.scopes[0]!.skipped.map((i) => i.key), ["rules/k8s"]);
    assert.equal(existsSync(join(e.home, ".claude/rules/k8s.md")), false);
    const st = status(e.ctx, { scope: "user" }).scopes[0]!;
    assert.deepEqual(st.wildcards[0]!.installed, 2);
  } finally {
    e.cleanup();
  }
});

test("a render error is still an error: the installed copy stays, with a warning", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g7");
    putRaw(src, "rules/k8s.md.njk", GATED);
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: true } });
    await sync(e.ctx, { scope: "user" });
    putRaw(src, "rules/k8s.md.njk", "{{ vars.typo }}");
    const r = await sync(e.ctx, { scope: "user" });
    assert.match(readFileSync(join(e.home, ".claude/rules/k8s.md"), "utf8"), /kubectl/);
    assert.equal(r.scopes[0]!.warnings.some((w) => /template error/.test(w)), true);
    assert.deepEqual(r.scopes[0]!.skipped, []);
  } finally {
    e.cleanup();
  }
});

test("status tells a skipped item from one that is not installed, also when offline", async () => {
  const e = env();
  try {
    const src = join(e.tmp.dir, "g8");
    putRaw(src, "rules/k8s.md.njk", GATED);
    putRaw(src, "rules/later.md", "L\n");
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: false } });
    await sync(e.ctx, { scope: "user" });
    e.writeCfg("user", { sources: { s: { local: src } }, install: { rules: ["k8s@s", "later@s"] }, vars: { k8s: false } });
    const pick = () =>
      status(e.ctx, { scope: "user" }).scopes[0]!.declared.map((d) => ({ key: d.key, installed: d.installed, skipped: d.skipped }));
    const expected = [
      { key: "rules/k8s", installed: false, skipped: "renders-empty" },
      { key: "rules/later", installed: false, skipped: undefined },
    ];
    assert.deepEqual(pick(), expected);

    rmSync(src, { recursive: true, force: true }); // unresolvable: the skip marker is kept
    await sync(e.ctx, { scope: "user" });
    assert.deepEqual(pick(), expected);
  } finally {
    e.cleanup();
  }
});
