// k286: an install `"into": "plugin"` – a skill rendered into the project's own plugin skills
// directory (the one `.claude-plugin/plugin.json` names), owned by the lock under a `plugin:`
// key, once whatever the targets, without a skill `.gitignore`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import { check, resolveItems, status, sync, type EngineContext } from "../src/engine.ts";
import { cmdUninstall } from "../src/commands.ts";
import { addInstallEntry, ConfigError, findInstallEntries, loadConfig, pluginItemsRoot } from "../src/config.ts";
import { readLock } from "../src/lock.ts";
import { reportHook, reportText } from "../src/report.ts";

/** `manifest` null: the project has no plugin manifest. */
function env(manifest: unknown = {}) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  if (manifest !== null) {
    mkdirSync(join(projectDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(projectDir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  }
  const ctx: EngineContext = {
    home, projectDir, stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" }, user: { name: "getty", home },
    markers: claudeOnly(home), isGitWorkTree: () => false,
  };
  // A user-config source: trusted, usable by the project scope (spec §3).
  const src = resolvePath(join(tmp.dir, "src"));
  const skill = (name: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(src, "skills", name, rel, ".."), { recursive: true });
      writeFileSync(join(src, "skills", name, rel), text);
    }
  };
  const cfg = (which: "user" | "project" | "local", obj: unknown) => writeFileSync(
    which === "user" ? join(home, ".claude", "skilletor.json")
      : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json"),
    JSON.stringify(obj, null, 2),
  );
  cfg("user", { sources: { s: { local: src } } });
  return { tmp, home, projectDir, src, ctx, skill, cfg, cleanup: () => tmp.cleanup() };
}

const INTO = (spec: string) => ({ skill: spec, into: "plugin" });

test("k286: an object entry parses as an explicit skill into the plugin; strings keep working", () => {
  const e = env();
  try {
    e.cfg("project", { install: { skills: ["plain@s", INTO("boot@s")] } });
    const p = loadConfig({ home: e.home, projectDir: e.projectDir }).project!;
    assert.deepEqual(p.install.map((i) => [i.name, i.target, i.into, i.raw]), [
      ["plain", "skills/plain", undefined, "plain@s"],
      ["boot", "skills/boot", "plugin", "boot@s"],
    ]);
    // One name, wherever it lands: plain and into-plugin of one name is the duplicate error.
    e.cfg("project", { install: { skills: ["boot@s", INTO("boot@s")] } });
    assert.throws(() => loadConfig({ home: e.home, projectDir: e.projectDir }), /duplicate skill target "boot"/);
  } finally {
    e.cleanup();
  }
});

test("k286: what an object entry may not be is a config error naming file and entry", () => {
  const e = env();
  try {
    const refused = (which: "user" | "project", install: unknown, re: RegExp) => {
      e.cfg("project", {});
      e.cfg("user", { sources: { s: { local: e.src } } });
      e.cfg(which, which === "user" ? { sources: { s: { local: e.src } }, install } : { install });
      assert.throws(() => loadConfig({ home: e.home, projectDir: e.projectDir }), (err: Error) => err instanceof ConfigError && re.test(err.message));
    };
    refused("project", { agents: [{ agent: "a@s", into: "plugin" }] }, /install\.agents\[0\]: an object entry installs a skill into the plugin; agents install into their harness roots only/);
    refused("project", { rules: [{ rule: "r@s", into: "plugin" }] }, /rules install into their harness roots only/);
    refused("user", { skills: [INTO("boot@s")] }, /skilletor\.json: install\.skills\[0\]: "into": "plugin" is project scope only/);
    refused("project", { skills: [{ skill: "boot@s", into: "plugin", x: 1 }] }, /install\.skills\[0\] has unknown key "x" \(allowed: skill, into\)/);
    refused("project", { skills: [{ skill: "boot@s" }] }, /install\.skills\[0\]\.into undefined must be "plugin"/);
    refused("project", { skills: [{ skill: "boot@s", into: "claude" }] }, /install\.skills\[0\]\.into "claude" must be "plugin"/);
    refused("project", { skills: [{ skill: 7, into: "plugin" }] }, /install\.skills\[0\]\.skill must be a string name@source/);
    refused("project", { skills: [INTO("boot-*@s")] }, /"into": "plugin" takes one name, no pattern/);
    refused("project", { skills: [INTO("boot@nope")] }, /project install "boot@nope" references unknown source "nope"/);
    refused("project", { skills: [7] }, /install\.skills\[0\] must be a string or an object/);
  } finally {
    e.cleanup();
  }
});

test("k286: the destination comes from the plugin manifest; without one the config is refused and nothing is written", async () => {
  const e = env(null);
  try {
    e.skill("boot", { "SKILL.md": "---\ndescription: boot\n---\nB\n" });
    e.cfg("project", { install: { skills: [INTO("boot@s")] } });
    const r = await sync(e.ctx);
    // The manifest's full path, as every config error names its file (separator of the OS).
    assert.equal(r.error, `${join(e.projectDir, ".claude-plugin", "plugin.json")}: not found; an install with "into": "plugin" needs the project's plugin manifest`);
    assert.equal(existsSync(join(e.projectDir, "skills")), false);
    assert.equal(existsSync(join(e.projectDir, ".claude", "skilletor.lock.json")), false);
    assert.match((await check(e.ctx)).error ?? "", /plugin\.json: not found/);

    const manifest = (m: unknown) => {
      mkdirSync(join(e.projectDir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(e.projectDir, ".claude-plugin", "plugin.json"), JSON.stringify(m));
    };
    manifest({ skills: "./plugin/skills/" });
    assert.equal(pluginItemsRoot(e.projectDir), join(e.projectDir, "plugin"));
    manifest({});
    assert.equal(pluginItemsRoot(e.projectDir), e.projectDir);
    for (const [skills, re] of [
      [["./skills"], /"skills" \["\.\/skills"\] must be one path/],
      ["../skills", /must be a directory inside the project/],
      ["/abs/skills", /must be a directory inside the project/],
      ["./", /must be a directory inside the project/],
      ["./my-skills", /needs a skills directory named "skills"/],
    ] as const) {
      manifest({ skills });
      assert.throws(() => pluginItemsRoot(e.projectDir), re);
    }
  } finally {
    e.cleanup();
  }
});

test("k286: sync renders the skill into the plugin skills dir once, whatever the targets; check, status and uninstall follow the lock", async () => {
  const e = env({ name: "p", skills: "./skills" });
  try {
    e.skill("boot", {
      "SKILL.md": "---\ndescription: boot\n---\nB\n",
      "bin/run.sh.njk": "#!/bin/sh\necho {{ vars.pin }} {{ harness }}\n",
    });
    chmodSync(join(e.src, "skills", "boot", "bin", "run.sh.njk"), 0o755);
    // Project targets not in use on this Claude-only machine: no harness copy, the plugin one all the same.
    e.cfg("project", { vars: { pin: "1.4.5" }, targets: ["codex"], install: { skills: [INTO("boot@s")] } });
    assert.equal((await check(e.ctx)).declaredChanged?.includes("project"), true, "declared, not installed: drift");

    const r = await sync(e.ctx);
    const proj = r.scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(proj.added.map((i) => i.key), ["plugin:skills/boot"]);
    assert.deepEqual(proj.warnings, ["project targets (codex) are not in use on this machine (claude); nothing is installed for the project"]);
    const dir = join(e.projectDir, "skills", "boot");
    assert.equal(readFileSync(join(dir, "bin", "run.sh"), "utf8"), "#!/bin/sh\necho 1.4.5 claude\n");
    if (process.platform !== "win32") {
      assert.equal((statSync(join(dir, "bin", "run.sh")).mode & 0o100) !== 0, true, "the template's executable bit");
    }
    assert.equal(existsSync(join(dir, ".gitignore")), false, "a repository file: no skill .gitignore");
    assert.equal(existsSync(join(e.projectDir, ".claude", "skills")), false, "no harness copy");
    const lock = readLock(join(e.projectDir, ".claude", "skilletor.lock.json"));
    assert.deepEqual(Object.keys(lock), ["plugin:skills/boot"]);
    assert.deepEqual(Object.keys(lock["plugin:skills/boot"]!.files).sort(), ["skills/boot/SKILL.md", "skills/boot/bin/run.sh"]);
    assert.match(reportText(r), /\+ plugin:skills\/boot \(a file of the plugin: commit it\)/);
    assert.match(reportHook(r).additionalContext ?? "", /- skill boot@s \(plugin\): a file of the plugin: commit it/);

    const st = status(e.ctx).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(st.declared, [{ key: "plugin:skills/boot", source: "s", installed: true }]);
    assert.deepEqual(st.orphans, []);
    const resolved = (await resolveItems(e.ctx)).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(resolved.items.map((i) => [i.name, i.declaredBy]), [["boot", ["boot@s"]]]);
    // A local source is always "changed" (spec §4.4): the drift alone is asked.
    const clean = await check(e.ctx, { local: true });
    assert.equal(clean.changed, false, JSON.stringify(clean));

    // A fresh sync changes nothing; a hand edit is a managed file's drift: overwritten and named.
    assert.deepEqual((await sync(e.ctx)).scopes.find((s) => s.scope === "project")!.unchanged.map((i) => i.key), ["plugin:skills/boot"]);
    writeFileSync(join(dir, "SKILL.md"), "hand edit\n");
    const again = (await sync(e.ctx)).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(again.overwritten, [{ path: "skills/boot/SKILL.md" }]);
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "---\ndescription: boot\n---\nB\n");

    // The CLI's uninstall takes the object entry out; the sync removes the files.
    const u = await cmdUninstall(e.ctx, { items: ["boot@s"], project: true });
    assert.deepEqual(u.report.scopes.find((s) => s.scope === "project")!.removed.map((i) => i.key), ["plugin:skills/boot"]);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(JSON.parse(readFileSync(join(e.projectDir, ".claude", "skilletor.json"), "utf8")).install, undefined);
    assert.equal((await check(e.ctx, { local: true })).changed, false);
  } finally {
    e.cleanup();
  }
});

test("k286: a foreign file in the way is a conflict; a harness copy of the same name leaves when the entry moves into the plugin", async () => {
  const e = env();
  try {
    e.skill("boot", { "SKILL.md": "---\ndescription: boot\n---\nB\n" });
    e.cfg("project", { install: { skills: ["boot@s"] } });
    await sync(e.ctx);
    assert.equal(existsSync(join(e.projectDir, ".claude", "skills", "boot", "SKILL.md")), true);

    mkdirSync(join(e.projectDir, "skills", "boot"), { recursive: true });
    writeFileSync(join(e.projectDir, "skills", "boot", "SKILL.md"), "mine\n");
    e.cfg("project", { install: { skills: [INTO("boot@s")] } });
    const r = (await sync(e.ctx)).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(r.conflicts.map((c) => c.path), ["skills/boot/SKILL.md"]);
    assert.deepEqual(r.removed.map((i) => i.key), ["skills/boot"]);
    assert.equal(readFileSync(join(e.projectDir, "skills", "boot", "SKILL.md"), "utf8"), "mine\n");
    assert.equal(existsSync(join(e.projectDir, ".claude", "skills", "boot")), false);

    const forced = (await sync(e.ctx, { force: true })).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(forced.updated.concat(forced.added).map((i) => i.key), ["plugin:skills/boot"]);
    assert.equal(readFileSync(join(e.projectDir, "skills", "boot", "SKILL.md"), "utf8"), "---\ndescription: boot\n---\nB\n");
  } finally {
    e.cleanup();
  }
});

test("k286: without a manifest, an installed plugin copy is kept untouched, and the lock entry stays", async () => {
  const e = env();
  try {
    e.skill("boot", { "SKILL.md": "---\ndescription: boot\n---\nB\n" });
    e.cfg("project", { install: { skills: [INTO("boot@s")] } });
    await sync(e.ctx);
    // The entry is gone and so is the manifest: no root for the key, nothing deleted.
    e.cfg("project", { install: { skills: [] } });
    writeFileSync(join(e.projectDir, ".claude-plugin", "plugin.json"), "[]");
    const r = (await sync(e.ctx)).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(r.removed, []);
    assert.equal(existsSync(join(e.projectDir, "skills", "boot", "SKILL.md")), true);
    assert.equal("plugin:skills/boot" in readLock(join(e.projectDir, ".claude", "skilletor.lock.json")), true);
  } finally {
    e.cleanup();
  }
});

test("k286: install and uninstall edits see an object entry by its name", () => {
  const e = env();
  try {
    const path = join(e.projectDir, ".claude", "skilletor.json");
    e.cfg("project", { install: { skills: [INTO("boot@s")] } });
    addInstallEntry(path, "skill", "boot@s");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).install.skills, [INTO("boot@s")], "no plain duplicate");
    assert.deepEqual(findInstallEntries(path, "BOOT", "s"), [{ type: "skill", entry: "boot@s" }]);
  } finally {
    e.cleanup();
  }
});

test("k286: check names a plugin copy no entry declares any more, and one from another source", async () => {
  const e = env();
  try {
    e.skill("boot", { "SKILL.md": "---\ndescription: boot\n---\nB\n" });
    e.cfg("user", { sources: { s: { local: e.src }, t: { local: e.src } } });
    e.cfg("project", { install: { skills: [INTO("boot@s")] } });
    await sync(e.ctx);
    assert.equal((await check(e.ctx, { local: true })).changed, false);
    e.cfg("project", { install: { skills: [INTO("boot@t")] } });
    assert.deepEqual((await check(e.ctx, { local: true })).declaredChanged, ["project"], "moved to another source");
    e.cfg("project", {});
    assert.deepEqual((await check(e.ctx, { local: true })).declaredChanged, ["project"], "no longer declared");
    assert.deepEqual(status(e.ctx).scopes.find((s) => s.scope === "project")!.orphans, ["plugin:skills/boot"]);
    await sync(e.ctx);
    assert.equal(existsSync(join(e.projectDir, "skills", "boot")), false);
    assert.equal((await check(e.ctx, { local: true })).changed, false);
  } finally {
    e.cleanup();
  }
});

test("k286: a fresh checkout holds the committed copy without a lock: files exactly the render are adopted silently, others conflict", async () => {
  const e = env();
  try {
    e.skill("boot", { "SKILL.md": "---\ndescription: boot\n---\nB\n", "notes.md": "N\n" });
    e.cfg("project", { install: { skills: [INTO("boot@s")] } });
    await sync(e.ctx);
    // The clone: the committed files, no lock (it is git-ignored), one file differing.
    const lockPath = join(e.projectDir, ".claude", "skilletor.lock.json");
    writeFileSync(lockPath, "{}\n");
    const r = (await sync(e.ctx)).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual([r.conflicts, r.added, r.overwritten], [[], [], []]);
    assert.deepEqual(r.unchanged.map((i) => i.key), ["plugin:skills/boot"]);
    assert.deepEqual(Object.keys(readLock(lockPath)["plugin:skills/boot"]!.files).sort(), ["skills/boot/SKILL.md", "skills/boot/notes.md"]);

    writeFileSync(lockPath, "{}\n");
    writeFileSync(join(e.projectDir, "skills", "boot", "notes.md"), "changed\n");
    const c = (await sync(e.ctx)).scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(c.conflicts.map((x) => x.path), ["skills/boot/notes.md"]);
    assert.equal("plugin:skills/boot" in readLock(lockPath), false, "a conflict blocks the whole item");
    // The executable bit counts too: a committed copy without it is no copy of the render. On
    // Windows no file carries the bit, so equal bytes are adopted there.
    chmodSync(join(e.src, "skills", "boot", "notes.md"), 0o755);
    writeFileSync(join(e.projectDir, "skills", "boot", "notes.md"), "N\n");
    const x = (await sync(e.ctx)).scopes.find((s) => s.scope === "project")!;
    if (process.platform === "win32") {
      assert.deepEqual([x.conflicts, x.unchanged.map((i) => i.key)], [[], ["plugin:skills/boot"]]);
    } else {
      assert.deepEqual(x.conflicts.map((y) => y.path), ["skills/boot/notes.md"]);
    }
  } finally {
    e.cleanup();
  }
});
