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
// CwdChanged and PostToolUse (Claude Code only): a session that moves into another checkout gets
// that checkout's project scope brought up to date (`syncMovedCheckout`, spec §8). CwdChanged
// sees every move but is not awaited; PostToolUse, run on a Bash call with a `cd` only, is – the
// next tool call finds the items there. Codex and Hermes have no such events; there
// UserPromptSubmit (`--harness codex|hermes`) does the same first, awaited, when the session's
// cwd is not the one its hook last looked at (k149).
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
import { displaySafe, emptyScopeReport, reportHook, type ScopeReport, type SyncReport } from "./report.ts";
import { parseLockKey } from "./targets.ts";

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

/** Valid hook input is a JSON object, never null, a scalar or an array. */
export function hookInputOf(value: unknown): HookInput {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as HookInput : {};
}

/** A hook input's string field, when it is a non-empty one. */
const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

const SESSION_START_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL = 600;
/** A move's sync writes nothing once this has passed (spec §8): `hooks/hooks.json` and
 *  `hooks/codex-hooks.json` kill the hook at 30 s, which leaves the local rest of a sync 10 s;
 *  the Hermes plugin at 25 s (`PROMPT_S`), below Hermes' own 30 s. Claude Code's two move hooks
 *  wait for the sync lock up to it as well. */
export const MOVE_DEADLINE_MS = 20_000;

function projectKeyOf(ctx: HookContext, input: HookInput): string {
  return ctx.projectDir ?? text(input.cwd) ?? "";
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
export async function runHook(event: string, givenInput: unknown, hookCtx: HookContext): Promise<HookOutput> {
  const input = hookInputOf(givenInput);
  try {
    // The checkout the session moved into is the project, never the session's own (spec §8).
    if (event === "cwd-changed") return await cwdChanged(input, hookCtx);
    if (event === "post-tool-use") return await postToolUse(input, hookCtx);
    const ctx: HookContext = hookCtx.projectDir
      ? hookCtx
      : { ...hookCtx, projectDir: projectRootOf(text(input.cwd) ?? process.cwd()) };
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
  recordSessionCwd(input, ctx);
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
  /** Wait for the sync lock until the deadline, not the usual 5 s: Claude Code fires two move
   *  hooks for one `cd`, and the one that comes second waits out the other's sync. */
  lockUntilDeadline?: boolean;
}

/**
 * A session moved into `move.cwd` (spec §8): the one core every harness's move hook calls –
 * Claude Code's CwdChanged and PostToolUse; Codex's and Hermes' prompt hook (k149). The checkout
 * is the git top level of the new cwd, never `ctx.projectDir`, the session's own project. Nothing
 * to do – no source asked, nothing written – when it is the old cwd's checkout, the home dir, has
 * no `.claude/skilletor.json`, or its lock already matches its config (a local check: no fetch,
 * no network). Otherwise its project scope syncs as at SessionStart – 5 s per source, the same
 * trust rules, nothing written once `MOVE_DEADLINE_MS` has passed – unless, once the sync lock is
 * held, its lock matches after all: another run synced it meanwhile. One line names the
 * checkout and, when something is left to do, the command to run there – under Hermes, once
 * skills landed, also `hermes skills trust` as one that may be needed (k152). Never throws.
 */
export async function syncMovedCheckout(move: CheckoutMove, ctx: HookContext): Promise<HookOutput> {
  return (await moveCheckout(move, ctx)).out;
}

/** What a move did: its answer, and – when it answered for the checkout, with a sync or with
 *  what is left to do there – that checkout, which a background sync would only say again. */
interface MoveResult {
  out: HookOutput;
  answered?: string;
}

async function moveCheckout(move: CheckoutMove, ctx: HookContext): Promise<MoveResult> {
  const root = projectRootOf(move.cwd);
  const answered = (out: HookOutput): MoveResult => ({ out, answered: root });
  try {
    if (samePath(root, ctx.home) || !existsSync(join(root, ".claude", "skilletor.json"))) return { out: {} };
    if (move.oldCwd !== undefined && samePath(projectRootOf(move.oldCwd), root)) return { out: {} };
    const deadline = ctx.deadline ?? Date.now() + MOVE_DEADLINE_MS;
    const moved: HookContext = {
      ...ctx,
      projectDir: root,
      timeoutMs: ctx.timeoutMs ?? SESSION_START_TIMEOUT_MS,
      deadline,
      // Past the deadline the sync writes nothing: a longer wait would be for nothing.
      lockTimeoutMs: ctx.lockTimeoutMs ?? (move.lockUntilDeadline ? Math.max(0, deadline - Date.now()) : undefined),
    };
    const chk = await check(moved, { scope: "project", local: true });
    if (chk.error) return answered(cannotSync(root, chk.error));
    if (!chk.changed) {
      if (chk.trustRequests?.length) return answered(movedOutput(trustReport(chk), root, move.eventName));
      return chk.warnings.length ? answered(cannotSync(root, chk.warnings.join("; "))) : { out: {} };
    }
    // No scopes: a run this one waited for on the sync lock – the other Claude Code hook of the
    // same `cd`, say – synced the checkout meanwhile, and its answer was that run's to give.
    const report = await sync(moved, { scope: "project", ifChanged: true });
    if (!report.error && report.scopes.length === 0) return { out: {} };
    if (report.error) return answered(cannotSync(root, report.error));
    const out = movedOutput(report, root, move.eventName);
    return answered(ctx.harness === "hermes" && report.scopes.some(addsHermesSkill) ? withHermesTrust(out, root) : out);
  } catch (err) {
    // Timed out on the sync lock: another run holds it – a background sync of this very
    // checkout, maybe – and synced nothing here, so the interval check is left to retry (k89).
    const out = cannotSync(root, (err as Error).message);
    return err instanceof SyncLockTimeoutError ? { out } : answered(out);
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

/** Did a scope's sync add or update a skill Hermes loads from the project – its own copy, or the
 *  Codex copy in `.agents/skills` it reads instead (spec §16.2)? */
function addsHermesSkill(s: ScopeReport): boolean {
  return [...s.added, ...s.updated].some((it) => {
    const { harness, type } = parseLockKey(it.key);
    return type === "skill" && (harness === "hermes" || harness === "codex");
  });
}

/** A Hermes move that put skills into a checkout (k152): Hermes loads a project's skills only once
 *  `hermes skills trust` named its root, and skilletor does not read that list (spec §16.5) – so
 *  the line and the context name the command as one that may be needed, the context as the
 *  user's to run. */
function withHermesTrust(out: HookOutput, dir: string): HookOutput {
  const command = `hermes skills trust ${dir}`;
  const result: HookOutput = {
    ...out,
    systemMessage: displaySafe(`${out.systemMessage} — if Hermes does not trust this project yet: ${command}`),
  };
  const context = out.hookSpecificOutput?.additionalContext;
  if (context) {
    const line = `- Hermes loads project skills only from a project it trusts; if this one is not yet, the user can run: ${command}`;
    result.hookSpecificOutput = { ...out.hookSpecificOutput!, additionalContext: `${context}\n${displaySafe(line)}` };
  }
  return result;
}

/** Claude Code's CwdChanged (spec §8): it is not awaited, and its output takes no context
 *  (only `watchPaths`), so the line is all it gives – it reaches the user, not the model. It
 *  never writes the session's cwd record: PostToolUse, fired for the same `cd`, would take it for
 *  a move already done and answer before this hook's sync is. */
async function cwdChanged(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const cwd = text(input.new_cwd) ?? text(input.cwd);
  if (cwd === undefined) return {};
  const move = { cwd, oldCwd: text(input.old_cwd), eventName: "CwdChanged", lockUntilDeadline: true };
  const out = await syncMovedCheckout(move, ctx);
  return out.systemMessage ? { systemMessage: out.systemMessage } : {};
}

/** Claude Code's PostToolUse, which `hooks/hooks.json` runs on a Bash call with a `cd` only
 *  (spec §8): awaited – the next tool call waits for it – with the cwd after the command as
 *  `cwd`, and no old one: the session's record stands in. Its context reaches the model. */
async function postToolUse(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  return sessionMove(input, ctx, new State(ctx.stateRoot), { eventName: "PostToolUse", lockUntilDeadline: true });
}

/** Codex's and Hermes' hooks, which notice a move at the next prompt (k149). */
const followsMoves = (ctx: HookContext) => ctx.harness === "codex" || ctx.harness === "hermes";

/** The session a hook input belongs to; "" when it names none. */
const sessionOf = (input: HookInput) => (typeof input.session_id === "string" ? input.session_id : "");

/** Where a session's SessionStart looked, for its next prompt (Codex, Hermes, k149) or Bash `cd`
 *  (Claude Code) to compare. Best effort: without the record the first move looks once more. */
function recordSessionCwd(input: HookInput, ctx: HookContext): void {
  const cwd = text(input.cwd);
  if (cwd === undefined) return;
  try {
    new State(ctx.stateRoot).putSessionCwd(sessionOf(input), cwd);
  } catch {
    // the state dir cannot be written
  }
}

/**
 * A move a hook sees only as the session's cwd (spec §8): Codex's and Hermes' prompt hook – a
 * session there moves only between turns, and that hook is the first to see the new cwd,
 * awaited, before the model's request (k149) – and Claude Code's PostToolUse on a Bash `cd`. The
 * cwd the session's hook last looked at is kept per session id (written at SessionStart): the
 * same cwd again asks nothing; another goes to the move core, which tells a move within one
 * checkout from one into another. A move that answered for its checkout marks it checked, so the
 * interval check starts no second sync of it beside this one.
 */
async function sessionMove(
  input: HookInput, ctx: HookContext, state: State, event: Pick<CheckoutMove, "eventName" | "lockUntilDeadline">,
): Promise<HookOutput> {
  const cwd = text(input.cwd);
  if (cwd === undefined) return {};
  const session = sessionOf(input);
  const last = state.sessionCwd(session);
  if (last !== undefined && samePath(last, cwd)) return {};
  const { out, answered } = await moveCheckout({ cwd, oldCwd: last, ...event }, ctx);
  try {
    if (answered !== undefined) state.markChecked(answered);
    state.putSessionCwd(session, cwd);
  } catch {
    // the state dir cannot be written: the next prompt looks again
  }
  return out;
}

/** A pending report and a move's answer as one (k149): both lines, and – when either has a
 *  context – both in it, a line standing in for an answer without one, since the Hermes plugin
 *  hands the model the context alone (spec §16.4). Without a move's answer, the report as is. */
function joined(pending: HookOutput | undefined, moved: HookOutput): HookOutput {
  const says = (o: HookOutput | undefined) => Boolean(o?.systemMessage || o?.hookSpecificOutput?.additionalContext);
  if (!says(moved)) return pending ?? {};
  if (!says(pending)) return moved;
  const parts = [pending!, moved];
  const out: HookOutput = {};
  const lines = parts.map((p) => p.systemMessage).filter(Boolean);
  if (lines.length) out.systemMessage = lines.join("; ");
  if (parts.some((p) => p.hookSpecificOutput?.additionalContext)) {
    const context = parts.map((p) => p.hookSpecificOutput?.additionalContext || p.systemMessage).filter(Boolean);
    out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context.join("\n") };
  }
  return out;
}

async function userPromptSubmit(input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const state = new State(ctx.stateRoot);
  const key = projectKeyOf(ctx, input);
  const moved = followsMoves(ctx) ? await sessionMove(input, ctx, state, { eventName: "UserPromptSubmit" }) : {};
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

  return joined(pending, moved);
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
