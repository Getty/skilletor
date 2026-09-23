// Claude Code hooks (spec §8). Black box: stdin JSON in, stdout JSON out.
//
// SessionStart: check all sources (short timeout), sync on change, report.
// UserPromptSubmit: if not due, return at once; if due, kick off a detached
// background sync that writes a pending report for a later prompt; deliver any
// pending report for this project. A hook must never disturb the session — every
// path catches, exits 0, and surfaces errors as a single warning line.
//
// The same hooks serve Codex (spec §14.5). Codex sets no CLAUDE_PROJECT_DIR, so
// without a project dir the git top level of the input's cwd (else cwd) is used.
import { execFileSync, spawn } from "node:child_process";
import { loadConfig } from "./config.ts";
import { State } from "./state.ts";
import { check, projectDirOf, sync, type EngineContext } from "./engine.ts";
import { reportHook, type SyncReport } from "./report.ts";

export interface HookInput {
  cwd?: string;
  source?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string };
}

export interface HookContext extends EngineContext {
  /** Injectable background trigger (default: a detached spawn). */
  background?: (ctx: HookContext) => void;
  /** Absolute path to the bundled CLI, for the default background spawn. */
  binPath?: string;
}

const SESSION_START_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL = 600;

function projectKeyOf(ctx: HookContext, input: HookInput): string {
  return ctx.projectDir ?? input.cwd ?? "";
}

function warn(message: string): HookOutput {
  return { systemMessage: `skilletor: ${message}` };
}

function toOutput(report: SyncReport, eventName: string): HookOutput {
  const h = reportHook(report);
  if (!h.systemMessage && !h.additionalContext) return {};
  return {
    systemMessage: h.systemMessage,
    hookSpecificOutput: { hookEventName: eventName, additionalContext: h.additionalContext },
  };
}

/** The project root for a cwd: its git top level, else the cwd itself. Never throws. */
export function projectRootOf(cwd: string): string {
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return top || cwd;
  } catch {
    return cwd;
  }
}

/** Dispatch a hook event; never throws. */
export async function runHook(event: string, input: HookInput, hookCtx: HookContext): Promise<HookOutput> {
  try {
    const ctx: HookContext = hookCtx.projectDir
      ? hookCtx
      : { ...hookCtx, projectDir: projectRootOf(input.cwd || process.cwd()) };
    switch (event) {
      case "session-start":
        return await sessionStart(input, ctx);
      case "user-prompt-submit":
        return await userPromptSubmit(input, ctx);
      case "__sync-background":
        await syncBackground(input, ctx);
        return {};
      default:
        return warn(`unknown hook event: ${event}`);
    }
  } catch (err) {
    return warn((err as Error).message);
  }
}

async function sessionStart(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const engineCtx: HookContext = { ...ctx, timeoutMs: ctx.timeoutMs ?? SESSION_START_TIMEOUT_MS };
  const state = new State(ctx.stateRoot);
  const key = projectKeyOf(ctx, input);

  const chk = await check(engineCtx);
  if (chk.error) return warn(chk.error);
  state.markChecked(key);

  if (!chk.changed) {
    return chk.warnings.length ? warn(chk.warnings.join("; ")) : {};
  }
  const report = await sync(engineCtx);
  return toOutput(report, "SessionStart");
}

async function userPromptSubmit(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const state = new State(ctx.stateRoot);
  const key = projectKeyOf(ctx, input);
  const pending = state.takePendingReport(key) as HookOutput | undefined;

  let interval = DEFAULT_INTERVAL;
  try {
    interval = loadConfig({ home: ctx.home, projectDir: projectDirOf(ctx) }).checkInterval;
  } catch {
    // config error: fall back to the default throttle; the background sync reports it
  }

  // checkInterval <= 0 turns the in-session check off entirely (SessionStart still syncs).
  if (interval > 0 && state.isDue(key, interval)) {
    state.markChecked(key);
    (ctx.background ?? defaultBackground)(ctx);
  }

  return pending ?? {};
}

/** Runs in a detached child: sync, then store the result as a pending report. */
async function syncBackground(input: HookInput, ctx: HookContext): Promise<void> {
  const key = projectKeyOf(ctx, input);
  const report = await sync(ctx);
  const output = toOutput(report, "UserPromptSubmit");
  if (output.systemMessage || output.hookSpecificOutput) {
    new State(ctx.stateRoot).putPendingReport(key, output);
  }
}

function defaultBackground(ctx: HookContext): void {
  if (!ctx.binPath) return;
  const child = spawn(process.execPath, [ctx.binPath, "hook", "__sync-background"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SKILLETOR_PROJECT_DIR: ctx.projectDir ?? "",
    },
  });
  child.unref();
}
