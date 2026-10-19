// k140 (spec §6.8): a project that uses skilletor gets the plugin requirement in its committed
// `.claude/settings.json` – skilletor enabled from the marketplace it is installed from, and
// every marketplace an `enabledPlugins` entry there needs declared. Add-only; Claude Code's
// plugin state lives in the temp home, never the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { check, sync, type EngineContext } from "../src/engine.ts";
import { reportHook, reportText } from "../src/report.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { loadConfig } from "../src/config.ts";
import { notDeclarable } from "../src/claudesettings.ts";
import type { Harness } from "../src/targets.ts";

const GETTY = { source: "github", repo: "Getty/marketplace" };

function env(harnesses: Harness[] = ["claude"]) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const markerOf = (h: Harness) => join(tmp.dir, `marker-${h}`);
  for (const h of harnesses) writeFileSync(markerOf(h), "");
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: { claude: [markerOf("claude")], codex: [markerOf("codex")] },
    codexHome: join(home, ".codex"),
    hermesHome: join(tmp.dir, "hermes-home"),
    isGitWorkTree: () => false,
    background: () => {},
  };
  const writeCfg = (which: "user" | "project" | "local", obj: unknown) => {
    const file = which === "user"
      ? join(home, ".claude", "skilletor.json")
      : join(projectDir, ".claude", which === "local" ? "skilletor.local.json" : "skilletor.json");
    writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  /** Claude Code's plugin state: marketplaces by name, skilletor installs as [marketplace, scope, projectPath?]. */
  const plugins = (known: Record<string, unknown>, installs: [string, string, string?][]) => {
    const dir = join(home, ".claude", "plugins");
    writeFileSync(join(dir, "known_marketplaces.json"), JSON.stringify(Object.fromEntries(
      Object.entries(known).map(([name, source]) => [name, { source, installLocation: join(dir, "marketplaces", name) }]),
    ), null, 2));
    const byKey: Record<string, unknown[]> = {};
    for (const [m, scope, projectPath] of installs) {
      (byKey[`skilletor@${m}`] ??= []).push({
        scope, ...(projectPath ? { projectPath } : {}), installPath: installPathOf(m), version: "0.7.0",
      });
    }
    writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: byKey }, null, 2));
  };
  const installPathOf = (m: string) => join(home, ".claude", "plugins", "cache", m, "skilletor", "0.7.0");
  const settings = join(projectDir, ".claude", "settings.json");
  return { tmp, ctx, home, projectDir, settings, writeCfg, plugins, installPathOf, cleanup: () => tmp.cleanup() };
}

const projectOf = (r: Awaited<ReturnType<typeof sync>>) => r.scopes.find((s) => s.scope === "project")!;
const layoutOf = async (ctx: EngineContext) => (await check(ctx, { scope: "project" })).layoutChanged;
const json = (obj: unknown) => JSON.stringify(obj, null, 2) + "\n";

// Asserts: a fresh skilletor project gets a settings.json enabling skilletor from the
// marketplace it is installed from, with that marketplace's source copied; the report asks for
// one commit; check counts the missing file as drift before and none after; a second sync
// neither reports nor rewrites it.
test("k140: a fresh project gets the plugin requirement once, and check sees it missing", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY, "claude-plugins-official": { source: "github", repo: "anthropics/claude-plugins-official" } },
      [["getty", "user"]]);
    e.writeCfg("project", {});
    assert.deepEqual(await layoutOf(e.ctx), ["project"]);
    const r = await sync(e.ctx);
    assert.equal(readFileSync(e.settings, "utf8"), json({
      enabledPlugins: { "skilletor@getty": true },
      extraKnownMarketplaces: { getty: { source: GETTY } },
    }));
    assert.deepEqual(projectOf(r).settingsUpdated, { path: ".claude/settings.json", enabled: ["skilletor@getty"], declared: ["getty"] });
    assert.match(reportText(r), /\.claude\/settings\.json updated \(enables skilletor@getty; declares marketplace getty\) — commit it/);
    assert.equal(await layoutOf(e.ctx), undefined);
    const before = statSync(e.settings).mtimeMs;
    const again = await sync(e.ctx);
    assert.equal(projectOf(again).settingsUpdated, undefined);
    assert.equal(statSync(e.settings).mtimeMs, before);
    assert.equal(reportText(again), "");
  } finally {
    e.cleanup();
  }
});

// Asserts: an existing file keeps every key, its order and its indent; the plugin goes last in
// enabledPlugins, the marketplaces its entries need are declared in entry order – the official
// one never, one already declared never twice.
test("k140: an existing settings.json keeps its keys, order and indent; only missing entries are added", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY, caveman: { source: "github", repo: "JuliusBrussee/caveman" }, other: { source: "git", url: "https://x.example/m.git" } },
      [["getty", "user"]]);
    e.writeCfg("project", {});
    const start = {
      permissions: { allow: ["Bash(npm test)"] },
      enabledPlugins: { "briefing@getty": true, "superpowers@claude-plugins-official": true, "caveman@caveman": true, "x@other": true },
      extraKnownMarketplaces: { other: { source: { source: "github", repo: "mine/other" } } },
      model: "opus",
    };
    writeFileSync(e.settings, JSON.stringify(start, null, 4) + "\n");
    await sync(e.ctx);
    assert.equal(readFileSync(e.settings, "utf8"), JSON.stringify({
      permissions: start.permissions,
      enabledPlugins: { ...start.enabledPlugins, "skilletor@getty": true },
      extraKnownMarketplaces: { ...start.extraKnownMarketplaces, getty: { source: GETTY }, caveman: { source: { source: "github", repo: "JuliusBrussee/caveman" } } },
      model: "opus",
    }, null, 4) + "\n");
  } finally {
    e.cleanup();
  }
});

// Asserts: skilletor named in the file in any form – switched off, or from another
// marketplace – is the user's choice: no second entry; a switched-off entry needs no
// marketplace, an enabled one from elsewhere gets its own declared.
test("k140: an explicit false, or skilletor from another marketplace, is left as it is", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY, fork: { source: "github", repo: "me/fork" } }, [["getty", "user"]]);
    e.writeCfg("project", {});
    const off = json({ enabledPlugins: { "skilletor@getty": false } });
    writeFileSync(e.settings, off);
    const r = await sync(e.ctx);
    assert.equal(readFileSync(e.settings, "utf8"), off);
    assert.equal(projectOf(r).settingsUpdated, undefined);
    assert.equal(await layoutOf(e.ctx), undefined);

    writeFileSync(e.settings, json({ enabledPlugins: { "skilletor@fork": true } }));
    await sync(e.ctx);
    assert.deepEqual(JSON.parse(readFileSync(e.settings, "utf8")), {
      enabledPlugins: { "skilletor@fork": true }, extraKnownMarketplaces: { fork: { source: { source: "github", repo: "me/fork" } } },
    });
  } finally {
    e.cleanup();
  }
});

// Asserts: a marketplace whose source is this machine's (a directory, a git checkout on disk)
// never goes into the committed file – skilletor from it is not enabled either – and a
// marketplace Claude Code does not know is not invented; each says so in a warning, while
// what can be declared still is.
test("k140: a directory-sourced or unknown marketplace is not written, and the report says so", async () => {
  const e = env();
  try {
    e.plugins({ "getty-dev": { source: "directory", path: "/home/me/dev-marketplace" }, getty: GETTY,
      local: { source: "git", url: "/srv/git/market" } }, [["getty-dev", "user"]]);
    e.writeCfg("project", {});
    writeFileSync(e.settings, json({ enabledPlugins: { "briefing@getty": true, "irc@getty-dev": true, "a@local": true, "b@nowhere": true } }));
    const r = await sync(e.ctx);
    const got = JSON.parse(readFileSync(e.settings, "utf8"));
    assert.deepEqual(Object.keys(got.enabledPlugins), ["briefing@getty", "irc@getty-dev", "a@local", "b@nowhere"]);
    assert.deepEqual(got.extraKnownMarketplaces, { getty: { source: GETTY } });
    const w = projectOf(r).warnings;
    assert.ok(w.some((l) => l.startsWith(`skilletor's marketplace "getty-dev" has a directory source on this machine; .claude/settings.json does not get skilletor@getty-dev`)), w.join("\n"));
    assert.ok(w.some((l) => l.startsWith(`marketplace "getty-dev" (irc@getty-dev) has a directory source on this machine; not declared`)), w.join("\n"));
    assert.ok(w.some((l) => l.startsWith(`marketplace "local" (a@local) has a git source on a local path on this machine`)), w.join("\n"));
    assert.ok(w.some((l) => l.startsWith(`marketplace "nowhere" (b@nowhere) is not known to Claude Code on this machine`)), w.join("\n"));
    assert.equal(projectOf(r).settingsSkipped?.length, 4);
    assert.equal(await layoutOf(e.ctx), undefined); // what cannot be added asks for no sync
    // The hooks repeat them only in a run that changed something.
    const quiet = await sync(e.ctx);
    assert.deepEqual(reportHook(quiet), {});
  } finally {
    e.cleanup();
  }
});

test("k140: notDeclarable takes github, remote git and http(s) url sources only", () => {
  assert.equal(notDeclarable(GETTY), undefined);
  assert.equal(notDeclarable({ source: "git", url: "git@github.com:o/r.git" }), undefined);
  assert.equal(notDeclarable({ source: "git", url: "ssh://host/r.git" }), undefined);
  assert.equal(notDeclarable({ source: "url", url: "https://x.example/marketplace.json" }), undefined);
  assert.equal(notDeclarable({ source: "git", url: "file:///srv/r.git" }), "a git source on a local path");
  assert.equal(notDeclarable({ source: "git", url: "C:\\repos\\m" }), "a git source on a local path");
  assert.equal(notDeclarable({ source: "url", url: "/tmp/marketplace.json" }), "a url source");
  assert.equal(notDeclarable({ source: "directory", path: "/x" }), "a directory source");
  assert.equal(notDeclarable({ source: "file", path: "/x/m.json" }), "a file source");
  assert.equal(notDeclarable({ source: "github" }), "a github source");
  assert.equal(notDeclarable(undefined), "no readable source");
});

// Asserts: a settings.json that is not JSON (or not an object, or a symlink) is left byte for
// byte, named in a warning, and is no drift – the next session does not sync for it.
test("k140: an unparseable settings.json is left alone and reported", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY }, [["getty", "user"]]);
    e.writeCfg("project", {});
    for (const text of ['{ "enabledPlugins": { // a comment\n } }\n', "[1, 2]\n", '{ "enabledPlugins": [] }\n']) {
      writeFileSync(e.settings, text);
      const r = await sync(e.ctx);
      assert.equal(readFileSync(e.settings, "utf8"), text);
      assert.equal(projectOf(r).settingsUpdated, undefined);
      assert.match(projectOf(r).warnings.join("\n"), /^\.claude\/settings\.json (is not valid JSON|is not a JSON object|has an "enabledPlugins" that is not an object).*; plugin requirement not written$/m);
      assert.equal(await layoutOf(e.ctx), undefined);
    }
  } finally {
    e.cleanup();
  }
});

// Asserts: only a committed skilletor.json makes a project skilletor's: none, or only the
// gitignored local file, leaves .claude/settings.json uncreated; so do Codex-only targets and
// the opt-out from the project or the user file.
test("k140: no committed skilletor.json, no Claude target or claudeSettings false: settings.json untouched", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY }, [["getty", "user"]]);
    await sync(e.ctx);
    assert.equal(existsSync(e.settings), false);
    e.writeCfg("local", {});
    await sync(e.ctx);
    assert.equal(existsSync(e.settings), false);
    assert.equal(await layoutOf(e.ctx), undefined);

    e.writeCfg("project", { claudeSettings: false });
    await sync(e.ctx);
    assert.equal(existsSync(e.settings), false);
    e.writeCfg("project", {});
    e.writeCfg("user", { claudeSettings: false });
    await sync(e.ctx);
    assert.equal(existsSync(e.settings), false);
    assert.equal(await layoutOf(e.ctx), undefined);
    e.writeCfg("project", { claudeSettings: true }); // the project's word beats the user's
    await sync(e.ctx);
    assert.equal(existsSync(e.settings), true);
  } finally {
    e.cleanup();
  }
  const codex = env(["codex"]);
  try {
    codex.plugins({ getty: GETTY }, [["getty", "user"]]);
    codex.writeCfg("project", {});
    await sync(codex.ctx);
    assert.equal(existsSync(codex.settings), false);
  } finally {
    codex.cleanup();
  }
});

// Asserts: the user scope has no such file – ~/.claude/settings.json is never created or
// changed, however incomplete, and a project dir that is the home dir is no project.
test("k140: the user scope's settings.json is never touched", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY }, [["getty", "user"]]);
    e.writeCfg("user", {});
    const userSettings = join(e.home, ".claude", "settings.json");
    await sync({ ...e.ctx, projectDir: undefined });
    assert.equal(existsSync(userSettings), false);
    const text = json({ enabledPlugins: { "briefing@getty": true } });
    writeFileSync(userSettings, text);
    await sync({ ...e.ctx, projectDir: e.home });
    assert.equal(readFileSync(userSettings, "utf8"), text);
  } finally {
    e.cleanup();
  }
});

// Asserts: the running plugin's install path (CLAUDE_PLUGIN_ROOT) names the marketplace;
// without it, installs of skilletor from two marketplaces that apply here are ambiguous – a
// warning and no skilletor entry – while another project's install does not count.
test("k140: CLAUDE_PLUGIN_ROOT picks the marketplace; two installs without it are ambiguous", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY, fork: { source: "github", repo: "me/fork" } },
      [["getty", "user"], ["fork", "project", e.projectDir]]);
    e.writeCfg("project", {});
    const r = await sync(e.ctx);
    assert.equal(existsSync(e.settings), false);
    assert.match(projectOf(r).warnings.join("\n"), /skilletor is installed from several marketplaces \(fork, getty\)/);
    await sync({ ...e.ctx, pluginRoot: e.installPathOf("fork") });
    assert.deepEqual(JSON.parse(readFileSync(e.settings, "utf8")).enabledPlugins, { "skilletor@fork": true });
  } finally {
    e.cleanup();
  }
  const other = env();
  try {
    other.plugins({ getty: GETTY, fork: { source: "github", repo: "me/fork" } },
      [["getty", "user"], ["fork", "project", join(other.tmp.dir, "elsewhere")]]);
    other.writeCfg("project", {});
    await sync(other.ctx);
    assert.deepEqual(JSON.parse(readFileSync(other.settings, "utf8")).enabledPlugins, { "skilletor@getty": true });
  } finally {
    other.cleanup();
  }
});

// Asserts: a CRLF file without a final newline keeps both when something is added.
test("k140: line endings and a missing final newline are kept", async () => {
  const e = env();
  try {
    e.plugins({ getty: GETTY }, [["getty", "user"]]);
    e.writeCfg("project", {});
    writeFileSync(e.settings, '{\r\n\t"model": "opus"\r\n}');
    await sync(e.ctx);
    const text = readFileSync(e.settings, "utf8");
    assert.equal(text, JSON.stringify({ model: "opus", enabledPlugins: { "skilletor@getty": true }, extraKnownMarketplaces: { getty: { source: GETTY } } }, null, "\t").split("\n").join("\r\n"));
  } finally {
    e.cleanup();
  }
});

test("k140: claudeSettings must be a boolean", () => {
  const e = env();
  try {
    e.writeCfg("project", { claudeSettings: "no" });
    assert.throws(() => loadConfig({ home: e.home, projectDir: e.projectDir }), /skilletor\.json: "claudeSettings" must be a boolean/);
    e.writeCfg("project", {});
    e.writeCfg("local", { claudeSettings: 0 });
    assert.throws(() => loadConfig({ home: e.home, projectDir: e.projectDir }), /skilletor\.local\.json: "claudeSettings" must be a boolean/);
  } finally {
    e.cleanup();
  }
});

// Asserts (black box, spec §8): the session-start hook writes the requirement into a project
// synced before k140 and asks for the commit in its one line; a broken settings.json or plugin
// state never makes it throw.
test("k140: session-start adds the requirement and asks for the commit; broken files never throw", async () => {
  const e = env();
  try {
    e.writeCfg("project", {});
    await sync(e.ctx); // synced before k140: the blocks are there, the plugin state is not yet
    assert.equal(existsSync(e.settings), false);
    e.plugins({ getty: GETTY }, [["getty", "user"]]);
    const out = await runHook("session-start", { source: "startup" }, e.ctx);
    assert.equal(out.systemMessage, "skilletor: .claude/settings.json updated — commit it");
    assert.match(out.hookSpecificOutput?.additionalContext ?? "", /- \.claude\/settings\.json updated \(enables skilletor@getty; declares marketplace getty\) — commit it/);
    assert.equal(JSON.parse(readFileSync(e.settings, "utf8")).enabledPlugins["skilletor@getty"], true);
    assert.deepEqual(await runHook("session-start", { source: "startup" }, e.ctx), {}); // nothing left: silent

    writeFileSync(e.settings, "{ not json");
    writeFileSync(join(e.home, ".claude", "plugins", "installed_plugins.json"), "{ nor this");
    writeFileSync(join(e.home, ".claude", "plugins", "known_marketplaces.json"), "[]");
    assert.deepEqual(await runHook("session-start", { source: "startup" }, e.ctx), {});
    assert.equal(readFileSync(e.settings, "utf8"), "{ not json");
  } finally {
    e.cleanup();
  }
});

// Asserts (k142): Claude Code's plugin state lives in CLAUDE_CONFIG_DIR when that is set – the
// injected `claudeConfigDir` or, without one, the environment; an empty value is unset. The
// state under `<home>/.claude` is then ignored, so a stale copy there cannot decide.
test("k142: the plugin state is read from CLAUDE_CONFIG_DIR, injected or from the environment", async () => {
  const e = env();
  try {
    const alt = join(e.tmp.dir, "alt-config");
    mkdirSync(join(alt, "plugins"), { recursive: true });
    writeFileSync(join(alt, "plugins", "known_marketplaces.json"), JSON.stringify({ getty: { source: GETTY } }));
    writeFileSync(join(alt, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "skilletor@getty": [{ scope: "user", installPath: join(alt, "plugins", "cache", "getty", "skilletor", "0.7.0") }] },
    }));
    e.writeCfg("project", {});
    // Nothing under <home>/.claude/plugins, no variable: nothing to add.
    await sync(e.ctx);
    assert.equal(existsSync(e.settings), false);
    await sync({ ...e.ctx, claudeConfigDir: alt });
    assert.deepEqual(JSON.parse(readFileSync(e.settings, "utf8")).enabledPlugins, { "skilletor@getty": true });
    rmSync(e.settings);
    process.env.CLAUDE_CONFIG_DIR = alt;
    try {
      await sync(e.ctx);
      assert.deepEqual(JSON.parse(readFileSync(e.settings, "utf8")).enabledPlugins, { "skilletor@getty": true });
      rmSync(e.settings);
      process.env.CLAUDE_CONFIG_DIR = "";
      await sync(e.ctx);
      assert.equal(existsSync(e.settings), false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  } finally {
    e.cleanup();
  }
});
