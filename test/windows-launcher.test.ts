// Native-only black-box probes for the shipped winlaunch binary. The fixture copies the
// real launcher and bundle into a checkout whose path stresses Windows wide-character and
// argument quoting; no replacement launcher or real user/harness directory is involved.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { homeEnv } from "./helpers/harness.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const nativeWindowsOnly = process.platform === "win32" ? false : "requires native Windows to execute bin/skilletor.exe";

interface NativeFixture {
  launcher: string;
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

function inheritedWindowsValue(name: string): string | undefined {
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1];
}

function withNativeFixture(run: (fixture: NativeFixture) => void): void {
  const tmp = makeTmpDir("skilletor-windows-native-");
  try {
    const checkout = join(tmp.dir, "checkout with spaces and ünicode");
    const home = join(tmp.dir, "user profile with spaces and ünicode");
    const project = join(tmp.dir, "project with spaces and ünicode");
    const claudeConfig = join(tmp.dir, "Claude config with spaces and ünicode");
    const codexHome = join(tmp.dir, "Codex home with spaces and ünicode");
    const hermesHome = join(tmp.dir, "Hermes home with spaces and ünicode");
    const pluginData = join(tmp.dir, "plugin data with spaces and ünicode");
    const scratch = join(tmp.dir, "process temp with spaces and ünicode");

    for (const dir of [checkout, home, project, claudeConfig, codexHome, hermesHome, pluginData, scratch]) {
      mkdirSync(dir, { recursive: true });
      assert.match(dir, / /);
      assert.match(dir, /[^\x00-\x7f]/);
    }
    for (const relative of ["bin/skilletor.exe", "bin/skilletor", "dist/skilletor.js", "package.json"]) {
      const destination = join(checkout, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(repo, relative), destination);
    }
    // With an explicit CLAUDE_CONFIG_DIR, Claude Code's own marker belongs in that directory.
    writeFileSync(join(claudeConfig, ".claude.json"), "{}\n");

    // Whitelist only operating-system process essentials. In particular, do not pass runner
    // credentials or any real harness/config path. Canonical keys avoid duplicate Path/PATH
    // variants, which Windows child_process treats case-insensitively.
    const path = inheritedWindowsValue("PATH");
    assert.ok(path, "native Windows test process has PATH for setup-node's node.exe");
    const env: NodeJS.ProcessEnv = {
      PATH: path,
      ...homeEnv(home),
      APPDATA: join(home, "AppData", "Roaming"),
      CLAUDE_CONFIG_DIR: claudeConfig,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_PLUGIN_ROOT: checkout,
      CLAUDE_PROJECT_DIR: project,
      CODEX_HOME: codexHome,
      HERMES_HOME: hermesHome,
      TEMP: scratch,
      TMP: scratch,
      TMPDIR: scratch,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    };
    for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
      const value = inheritedWindowsValue(name);
      if (value) env[name] = value;
    }

    run({ launcher: join(checkout, "bin", "skilletor.exe"), project, home, env });
  } finally {
    tmp.cleanup();
  }
}

function launch(fixture: NativeFixture, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(fixture.launcher, args, {
    cwd: fixture.project,
    encoding: "utf8",
    env: fixture.env,
    input,
    windowsHide: true,
  });
}

test("native Windows launcher prints the shipped CLI version from an isolated Unicode checkout", { skip: nativeWindowsOnly }, () => {
  withNativeFixture((fixture) => {
    const result = launch(fixture, ["--version"]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${pkg.version}\n`);
  });
});

test("native Windows launcher runs a real hook inside isolated Unicode harness roots", { skip: nativeWindowsOnly }, () => {
  withNativeFixture((fixture) => {
    const config = join(fixture.project, ".claude", "skilletor.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "{\n");
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: fixture.project,
    });

    const result = launch(fixture, ["hook", "session-start"], input);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    assert.deepEqual(Object.keys(output), ["systemMessage"]);
    assert.match(output.systemMessage ?? "", /^skilletor: /);
    assert.match(output.systemMessage ?? "", /invalid JSON/);
    assert.ok(output.systemMessage?.includes(config), output.systemMessage ?? "hook emitted no systemMessage");
  });
});
