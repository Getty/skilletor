// Native Windows regression for k238: the runner's temporary path uses an 8.3 alias while
// Git reports the same checkout by its long path. This deliberately bypasses makeTmpDir so
// fixture canonicalization cannot make the product boundary pass by construction.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { projectDirOf, type EngineContext } from "../src/engine.ts";
import { realOrResolved, samePath } from "../src/fsutil.ts";
import { runHook, type HookContext } from "../src/hooks.ts";
import { State } from "../src/state.ts";

const nativeWindowsOnly = process.platform === "win32" ? false : "requires native Windows 8.3 and long-path aliases";

test("native Windows treats a raw 8.3 checkout path and Git's long path as one project", { skip: nativeWindowsOnly }, async (t) => {
  const raw = mkdtempSync(join(tmpdir(), "skilletor-path-identity-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", raw]);
    const long = resolve(execFileSync("git", ["-C", raw, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    const rawHasShortComponent = /(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/i.test(raw);
    if (!rawHasShortComponent || raw.toLowerCase() === long.toLowerCase()) {
      t.skip(`distinct raw 8.3 and Git-long aliases unavailable: raw=${raw}, git=${long}`);
      return;
    }

    assert.equal(realOrResolved(raw), realOrResolved(long));
    assert.equal(samePath(raw, long), true);
    const scopeCtx = { home: raw, projectDir: long, stateRoot: join(raw, "state") } as EngineContext;
    assert.equal(projectDirOf(scopeCtx), undefined, "the home is not a second project scope");

    const home = join(raw, "isolated home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ targets: ["claude"], checkInterval: 0 }));
    const stateRoot = join(home, ".claude", "skilletor");
    const state = new State(stateRoot);
    const pending = { systemMessage: "skilletor: native alias report" };
    state.putPendingReport(raw, pending);
    state.markChecked(raw);
    assert.equal(state.isDue(long, 600), false, "last-check keys agree across aliases");

    const ctx: HookContext = {
      home,
      projectDir: undefined,
      stateRoot,
      markers: { claude: [join(home, ".claude.json")], codex: [] },
    };
    assert.deepEqual(await runHook("user-prompt-submit", { cwd: raw }, ctx), pending,
      "pending-report keys agree with Git's project root");
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
});
