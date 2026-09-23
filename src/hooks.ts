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
// With `--harness codex` (the Codex plugin's hooks file) SessionStart also injects
// the Codex rules files, ahead of its report (spec §14.8).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, type Harness } from "./config.ts";
import { State } from "./state.ts";
import { check, codexRulesFiles, projectDirOf, sync, type EngineContext } from "./engine.ts";
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
  /** The harness whose hooks file ran the hook (`--harness`); unset = Claude Code. */
  harness?: Harness;
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
  let out: HookOutput;
  try {
    out = await checkAndSync(input, ctx);
  } catch (err) {
    out = warn((err as Error).message);
  }
  // A resumed session still has the first copy in its history (spec §14.8).
  const source = input.source;
  if (ctx.harness === "codex" && (source === undefined || source === null || source === "startup" || source === "clear")) {
    out = withCodexRules(out, ctx);
  }
  return out;
}

/** Put the Codex rules files, read from disk, at the start of the output's
 *  additionalContext, so the message begins with the rules marker the pointer names. */
function withCodexRules(out: HookOutput, ctx: HookContext): HookOutput {
  const texts: string[] = [];
  const problems: string[] = [];
  for (const file of codexRulesFiles(ctx)) {
    try {
      texts.push(readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`cannot read ${file} (${(err as Error).message})`);
    }
  }
  const result: HookOutput = { ...out };
  if (problems.length) result.systemMessage = [out.systemMessage, `skilletor: ${problems.join("; ")}`].filter(Boolean).join("; ");
  if (texts.length) {
    const rules = texts.join("\n");
    const report = out.hookSpecificOutput?.additionalContext;
    result.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: report ? `${rules}\n${report}` : rules };
  }
  return result;
}

async function checkAndSync(input: HookInput, ctx: HookContext): Promise<HookOutput> {
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
