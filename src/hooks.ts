// Claude Code hooks (spec §8). Black box: stdin JSON in, stdout JSON out.
//
// SessionStart: check all sources (short timeout) and the config against the lock, sync
// on change, report; untrusted sources are named without a sync.
// UserPromptSubmit: if not due, return at once; if due, kick off a detached
// background sync that writes a pending report for a later prompt; deliver any
// pending report for this project. A hook must never disturb the session — every
// path catches, exits 0, and surfaces errors as a single warning line.
//
// The same hooks serve Codex (spec §14.5). Codex sets no CLAUDE_PROJECT_DIR, so
// without a project dir the git top level of the input's cwd (else cwd) is used.
// With `--harness codex` (the Codex plugin's hooks file) SessionStart also injects
// the Codex rules files, ahead of its report (spec §14.8). The Hermes plugin runs the
// same two events with `--harness hermes` and hands the output on (spec §16.4); while
// `hermes` is no target, its SessionStart answer says how to opt in (spec §16.2).
//
// CwdChanged (Claude Code only): a session that moves into another checkout gets that
// checkout's project scope brought up to date (`syncMovedCheckout`, spec §8).
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { loadConfig, type Harness } from "./config.ts";
import { State, SyncLockTimeoutError } from "./state.ts";
import { gitEnv } from "./gitenv.ts";
import { samePath } from "./fsutil.ts";
import {
  check, codexRulesFiles, hermesOptInHint, projectDirOf, sync, type CheckReport, type EngineContext,
} from "./engine.ts";
import { displaySafe, emptyScopeReport, reportHook, type SyncReport } from "./report.ts";

export interface HookInput {
  cwd?: string;
  source?: string;
  hook_event_name?: string;
  /** CwdChanged: the directory the session left, and the one it moved into. */
  old_cwd?: string;
  new_cwd?: string;
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
/** A move's sync writes nothing once this has passed (spec §8): `hooks/hooks.json` kills the
 *  hook at 30 s, which leaves the local rest of a sync 10 s. */
const MOVE_DEADLINE_MS = 20_000;

function projectKeyOf(ctx: HookContext, input: HookInput): string {
  return ctx.projectDir ?? input.cwd ?? "";
}

/** One warning line; the message – an error, git's stderr, a name from a config – display-safe. */
function warn(message: string): HookOutput {
  return { systemMessage: displaySafe(`skilletor: ${message}`) };
}

function toOutput(report: SyncReport, eventName: string): HookOutput {
  const h = reportHook(report);
  if (!h.systemMessage && !h.additionalContext) return {};
  return {
    systemMessage: h.systemMessage,
    hookSpecificOutput: { hookEventName: eventName, additionalContext: h.additionalContext },
  };
}

/**
 * The project root for a cwd: its git top level – of the repository found from the cwd, never
 * one an exported GIT_DIR names (k91) – else the cwd itself. Never throws.
 */
export function projectRootOf(cwd: string): string {
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      env: gitEnv(),
    }).trim();
    // resolve: git writes C:/x on Windows, where every other path here reads C:\x; the
    // project's key would differ between the two. A no-op for git's absolute POSIX path.
    return top ? resolvePath(top) : cwd;
  } catch {
    return cwd;
  }
}

/** Dispatch a hook event; never throws. */
export async function runHook(event: string, input: HookInput, hookCtx: HookContext): Promise<HookOutput> {
  try {
    // The checkout the session moved into is the project, never the session's own (spec §8).
    if (event === "cwd-changed") return await cwdChanged(input, hookCtx);
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
  if (ctx.harness === "hermes") out = withHermesOptIn(out, ctx);
  return out;
}

/** Under Hermes while `hermes` is no target (spec §16.2): the opt-in line, once per answer –
 *  after its warning line, and after its context when it has one, since the plugin hands the
 *  model the context and the warning line only without one (spec §16.4). */
function withHermesOptIn(out: HookOutput, ctx: HookContext): HookOutput {
  const hint = hermesOptInHint(ctx);
  if (!hint) return out;
  const line = warn(hint).systemMessage!;
  const result: HookOutput = { ...out, systemMessage: [out.systemMessage, line].filter(Boolean).join("; ") };
  const context = out.hookSpecificOutput?.additionalContext;
  if (context) result.hookSpecificOutput = { ...out.hookSpecificOutput!, additionalContext: `${context}\n${line}` };
  return result;
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
  if (problems.length) result.systemMessage = [out.systemMessage, warn(problems.join("; ")).systemMessage].filter(Boolean).join("; ");
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

  if (!chk.changed) return unchangedOutput(chk);
  let report: SyncReport;
  try {
    report = await sync(engineCtx);
  } catch (err) {
    if (err instanceof SyncLockTimeoutError) dueAgain(state, key);
    throw err;
  }
  return toOutput(report, "SessionStart");
}

/**
 * A sync that timed out on the lock synced nothing: drop the project's check mark, so the next
 * prompt is due and its background sync retries (k89). Each path marks before it syncs – the
 * prompt's mark is what keeps a second one from spawning while its background sync runs – so
 * the mark goes only once the sync has ended. Best effort: without it the interval decides.
 */
function dueAgain(state: State, key: string): void {
  try {
    state.clearChecked(key);
  } catch {
    // the state dir cannot be written
  }
}

/** A check with nothing to sync: its warnings in one line – or, when a source awaits trust,
 *  the report a sync would give, trust requests and warnings alike (spec §4.3, §8). */
function unchangedOutput(chk: CheckReport): HookOutput {
  if (!chk.trustRequests?.length) return chk.warnings.length ? warn(chk.warnings.join("; ")) : {};
  return toOutput(trustReport(chk), "SessionStart");
}

/** The report a sync would give of a check whose sources await trust (at least one). */
function trustReport(chk: CheckReport): SyncReport {
  const report: SyncReport = { scopes: [] };
  for (const { scope, ...request } of chk.trustRequests ?? []) {
    let rep = report.scopes.find((s) => s.scope === scope);
    if (!rep) report.scopes.push((rep = emptyScopeReport(scope)));
    rep.trustRequests.push(request);
  }
  report.scopes[0]!.warnings.push(...chk.warnings);
  return report;
}

/** A move into another checkout (spec §8), as a harness's hook noticed it. */
export interface CheckoutMove {
  /** The directory the session works in now. */
  cwd: string;
  /** The one it worked in before, when the event names it. */
  oldCwd?: string;
  /** The event the output answers (`hookSpecificOutput.hookEventName`). */
  eventName: string;
}

/**
 * A session moved into `move.cwd` (spec §8): the one core every harness's move hook calls –
 * Claude Code's CwdChanged; Codex's and Hermes' (k149). The checkout is the git top level of
 * the new cwd, never `ctx.projectDir`, the session's own project. Nothing to do – no source
 * asked, nothing written – when it is the old cwd's checkout, the home dir, has no
 * `.claude/skilletor.json`, or its lock already matches its config (a local check: no fetch,
 * no network). Otherwise its project scope syncs as at SessionStart – 5 s per source, the same
 * trust rules, nothing written once `MOVE_DEADLINE_MS` has passed – and one line names the
 * checkout and, when something is left to do, the command to run there. Never throws.
 */
export async function syncMovedCheckout(move: CheckoutMove, ctx: HookContext): Promise<HookOutput> {
  const root = projectRootOf(move.cwd);
  try {
    if (samePath(root, ctx.home) || !existsSync(join(root, ".claude", "skilletor.json"))) return {};
    if (move.oldCwd !== undefined && samePath(projectRootOf(move.oldCwd), root)) return {};
    const moved: HookContext = {
      ...ctx,
      projectDir: root,
      timeoutMs: ctx.timeoutMs ?? SESSION_START_TIMEOUT_MS,
      deadline: ctx.deadline ?? Date.now() + MOVE_DEADLINE_MS,
    };
    const chk = await check(moved, { scope: "project", local: true });
    if (chk.error) return cannotSync(root, chk.error);
    if (!chk.changed) {
      if (chk.trustRequests?.length) return movedOutput(trustReport(chk), root, move.eventName);
      return chk.warnings.length ? cannotSync(root, chk.warnings.join("; ")) : {};
    }
    const report = await sync(moved, { scope: "project" });
    return report.error ? cannotSync(root, report.error) : movedOutput(report, root, move.eventName);
  } catch (err) {
    return cannotSync(root, (err as Error).message);
  }
}

/** The one line of a move that could not sync: the checkout, why, and what to run there. */
function cannotSync(dir: string, message: string): HookOutput {
  return warn(`cannot sync ${dir}: ${message} — run there: skilletor sync`);
}

/** A move's report: the line says where, and what to run there for what is left – trusting a
 *  source, or a sync that shows each warning and conflict; the context says where first. */
function movedOutput(report: SyncReport, dir: string, eventName: string): HookOutput {
  const out = toOutput(report, eventName);
  if (!out.systemMessage) return out;
  const fixes = [
    ...new Set(report.scopes.flatMap((s) => s.trustRequests.map((t) => `skilletor trust ${t.name}`))),
    ...(report.scopes.some((s) => s.warnings.length > 0 || s.conflicts.length > 0) ? ["skilletor sync"] : []),
  ];
  const result: HookOutput = {
    systemMessage: displaySafe(`${out.systemMessage} in ${dir}${fixes.length ? ` — run there: ${fixes.join("; ")}` : ""}`),
  };
  const context = out.hookSpecificOutput?.additionalContext;
  if (context) result.hookSpecificOutput = { hookEventName: eventName, additionalContext: `${displaySafe(`skilletor: in ${dir}:`)}\n${context}` };
  return result;
}

/** Claude Code's CwdChanged (spec §8): it is not awaited, and its output takes no context
 *  (only `watchPaths`), so the line is all it gives – it reaches the user, not the model. */
async function cwdChanged(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const cwd = text(input.new_cwd) ?? text(input.cwd);
  if (cwd === undefined) return {};
  const out = await syncMovedCheckout({ cwd, oldCwd: text(input.old_cwd), eventName: "CwdChanged" }, ctx);
  return out.systemMessage ? { systemMessage: out.systemMessage } : {};
}

async function userPromptSubmit(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const state = new State(ctx.stateRoot);
  const key = projectKeyOf(ctx, input);
  const pending = state.takePendingReport(key) as HookOutput | undefined;

  let interval = DEFAULT_INTERVAL;
  try {
    interval = loadConfig({ home: ctx.home, claudeConfigDir: ctx.claudeConfigDir, projectDir: projectDirOf(ctx) }).checkInterval;
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

/** Runs in a detached child: sync, then store the result as a pending report – its stdout
 *  reaches no one. A sync that throws leaves its error, the line SessionStart would give;
 *  one that timed out on the sync lock leaves no report – the run that holds the lock reports
 *  its own sync (spec §6.5) – and the project due, so the next prompt retries. */
async function syncBackground(input: HookInput, ctx: HookContext): Promise<void> {
  const key = projectKeyOf(ctx, input);
  const state = new State(ctx.stateRoot);
  let output: HookOutput;
  try {
    output = toOutput(await sync(ctx), "UserPromptSubmit");
  } catch (err) {
    if (err instanceof SyncLockTimeoutError) return dueAgain(state, key);
    output = warn((err as Error).message);
  }
  if (output.systemMessage || output.hookSpecificOutput) {
    state.putPendingReport(key, output);
  }
}

/** The spawn `defaultBackground` uses; a parameter so a test can pin the call. */
export type BackgroundSpawn = (command: string, args: string[], options: SpawnOptions) => { unref(): void };

/** Start `hook __sync-background` as a detached node process (the default `background`). */
export function defaultBackground(ctx: HookContext, spawnChild: BackgroundSpawn = spawn): void {
  if (!ctx.binPath) return;
  const child = spawnChild(process.execPath, [ctx.binPath, "hook", "__sync-background"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true, // detached on Windows means a console of its own: keep it hidden (k133)
    env: {
      ...process.env,
      SKILLETOR_PROJECT_DIR: ctx.projectDir ?? "",
    },
  });
  child.unref();
}
