// The reference implementation, driven from the Perl test suite (t/26-state-hooks.t, t/50-parity.t,
// t/51-parity-resolve.t, t/52-parity-sync.t, t/53-parity-render.t, t/65-report-json.t,
// t/66-report-hook.t, t/67-engine-hook-options.t): reads one JSON request on stdin, runs it against
// src/, prints the answer as JSON. Never part of the CPAN dist; the tests skip without it, without
// node or without the TypeScript tree (src/) beside lib/.
//
//   { "op": "backend", "src": {...}, "home": "/h" }                 -> resolveBackend
//   { "op": "git", "action": "resolve" | "check", "opts": {...}, "cached": "git:abc" }
//   { "op": "url", "action": "resolve" | "check", "opts": {...}, "cached": "etag:..." }
//   { "op": "trust", "root": "/s", "name": "x", "backend": {...} }  -> State.isTrusted
//   { "op": "sweep", "root": "/c" }                                 -> sweepGitCache + sweepUrlCache
//   { "op": "resolve", "home": "/h", "projectDir": "/p", "scope": "all" } -> resolveItems
//   { "op": "sync" | "check" | "status", "home": "/h", "projectDir": "/p", "scope": "all", "force": false }
//     "json": true -> the report as `skilletor <op> --json` prints it (no final newline), not the object
//     "host", "user": the render context's, as the conformance cases fix them (optional)
//     "local": true (check), "ifChanged": true (sync): those options (optional)
//     "deadline": epoch ms, "lockTimeoutMs": ms -> the context's (optional, the hooks' options)
//   { "op": "steps", "home": "/h", "projectDir": "/p", "steps": [ { "op": "sync", "scope": "all", "force": false } ] }
//     -> each resolve, sync, check or status step in turn on one context, as `--json` would print it
//   { "op": "lock", "root": "/s", "timeoutMs": 200, "holdMs": 0 }  -> State.withLock: "ran"
//   { "op": "state", "root": "/s", "calls": [ { "method": "putSessionCwd", "args": ["id", "/cwd"], "now": 5 } ] }
//     -> each State method's answer in turn (undefined as null); "now" fixes Date.now for that call
//   { "op": "reportHook", "reports": [ {...} ] }                 -> reportHook of each
//   { "op": "render", "cases": [ { "item": {...}, "sourceDir": "/s", "context": {...} } ] }
//     -> per case build, executables, rendersEmpty: { output: [[path, hex]], executables, rendersEmpty }
//        or { error: message, name } (a render error is an answer, not a failure)
// Answer: { "result": ... } or { "error": message }.
import { readFileSync } from "node:fs";
import { check, resolveBackend, resolveItems, status, sync } from "../src/engine.ts";
import { build, executables, rendersEmpty } from "../src/render.ts";
import { displaySafe, reportHook, reportJson } from "../src/report.ts";
import { GitSource, sweepGitCache } from "../src/sources/git.ts";
import { UrlSource, sweepUrlCache } from "../src/sources/url.ts";
import { State } from "../src/state.ts";

const req = JSON.parse(readFileSync(0, "utf8"));
/** The engine context of a run on a temp home: no work tree, nothing tracked. */
const ctxOf = (r) => ({
  home: r.home, projectDir: r.projectDir ?? undefined, stateRoot: `${r.home}/.claude/skilletor`,
  codexHome: `${r.home}/.codex`, hermesHome: `${r.home}/.hermes`, isGitWorkTree: () => false, gitTracked: () => [],
  ...(r.host ? { host: r.host } : {}), ...(r.user ? { user: r.user } : {}),
  ...(r.deadline !== undefined ? { deadline: r.deadline } : {}),
  ...(r.lockTimeoutMs !== undefined ? { lockTimeoutMs: r.lockTimeoutMs } : {}),
});
/** The State methods the `state` op calls. */
const STATE_METHODS = new Set([
  "putPendingReport", "takePendingReport", "sessionCwd", "putSessionCwd", "markChecked", "clearChecked", "isDue",
]);
/** A report as the CLI's `--json` prints it (cli.ts: reportJson or JSON.stringify, then printText),
 *  without the final newline. */
const printed = (op, report) =>
  (op === "sync" ? reportJson(report) : JSON.stringify(report, null, 2)).split("\n").map(displaySafe).join("\n");
const engineOp = async (ctx, step) => {
  const opts = { scope: step.scope ?? "all" };
  switch (step.op) {
    case "resolve":
      return resolveItems(ctx, opts);
    case "sync":
      return sync(ctx, { ...opts, force: step.force ?? false, ifChanged: step.ifChanged ?? false });
    case "check":
      return check(ctx, { ...opts, local: step.local ?? false });
    case "status":
      return status(ctx, opts);
    default:
      throw new Error(`unknown step op ${step.op}`);
  }
};
const run = async () => {
  switch (req.op) {
    case "backend":
      return resolveBackend(req.src, req.home);
    case "git": {
      const src = new GitSource(req.opts);
      return req.action === "resolve" ? await src.resolve() : await src.check(req.cached ?? undefined);
    }
    case "url": {
      const src = new UrlSource({ ...req.opts, allowHttp: true });
      return req.action === "resolve" ? await src.resolve() : await src.check(req.cached ?? undefined);
    }
    case "trust":
      return new State(req.root).isTrusted(req.name, req.backend);
    case "resolve":
      return resolveItems(ctxOf(req), { scope: req.scope ?? "all" });
    case "sync":
    case "check":
    case "status": {
      const report = await engineOp(ctxOf(req), req);
      return req.json ? printed(req.op, report) : report;
    }
    case "steps": {
      const ctx = ctxOf(req);
      const out = [];
      for (const step of req.steps) out.push(printed(step.op, await engineOp(ctx, step)));
      return out;
    }
    case "lock":
      return new State(req.root).withLock(() => new Promise((done) => setTimeout(() => done("ran"), req.holdMs ?? 0)), { timeoutMs: req.timeoutMs });
    case "state": {
      const state = new State(req.root);
      const now = Date.now;
      return req.calls.map((c) => {
        if (!STATE_METHODS.has(c.method)) throw new Error(`unknown State method ${c.method}`);
        Date.now = c.now === undefined ? now : () => c.now;
        try {
          return state[c.method](...c.args) ?? null;
        } finally {
          Date.now = now;
        }
      });
    }
    case "reportHook":
      return req.reports.map((r) => reportHook(r));
    case "render":
      return req.cases.map((c) => {
        let output;
        try {
          output = build(c.item, c.sourceDir, c.context);
        } catch (err) {
          return { error: err.message, name: err.name };
        }
        return {
          output: [...output].map(([path, bytes]) => [path, bytes.toString("hex")]),
          executables: [...executables(c.item, c.sourceDir)].sort(),
          rendersEmpty: rendersEmpty(c.item, output),
        };
      });
    case "sweep":
      sweepUrlCache(req.root);
      sweepGitCache(req.root);
      return null;
    default:
      throw new Error(`unknown op ${req.op}`);
  }
};
run().then(
  (result) => process.stdout.write(JSON.stringify({ result: result ?? null })),
  (err) => process.stdout.write(JSON.stringify({ error: err.message })),
);
