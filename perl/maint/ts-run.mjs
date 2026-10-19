// The reference implementation, driven from the Perl test suite (t/50-parity.t,
// t/51-parity-resolve.t): reads one JSON request on stdin, runs it against ../src, prints the
// answer as JSON. Never part of the CPAN dist; the tests skip without it, without node or without
// the TypeScript tree beside perl/.
//
//   { "op": "backend", "src": {...}, "home": "/h" }                 -> resolveBackend
//   { "op": "git", "action": "resolve" | "check", "opts": {...}, "cached": "git:abc" }
//   { "op": "url", "action": "resolve" | "check", "opts": {...}, "cached": "etag:..." }
//   { "op": "trust", "root": "/s", "name": "x", "backend": {...} }  -> State.isTrusted
//   { "op": "sweep", "root": "/c" }                                 -> sweepGitCache + sweepUrlCache
//   { "op": "resolve", "home": "/h", "projectDir": "/p", "scope": "all" } -> resolveItems
//   { "op": "lock", "root": "/s", "timeoutMs": 200, "holdMs": 0 }  -> State.withLock: "ran"
// Answer: { "result": ... } or { "error": message }.
import { readFileSync } from "node:fs";
import { resolveBackend, resolveItems } from "../../src/engine.ts";
import { GitSource, sweepGitCache } from "../../src/sources/git.ts";
import { UrlSource, sweepUrlCache } from "../../src/sources/url.ts";
import { State } from "../../src/state.ts";

const req = JSON.parse(readFileSync(0, "utf8"));
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
      return resolveItems({
        home: req.home, projectDir: req.projectDir ?? undefined, stateRoot: `${req.home}/.claude/skilletor`,
        codexHome: `${req.home}/.codex`, hermesHome: `${req.home}/.hermes`, isGitWorkTree: () => false, gitTracked: () => [],
      }, { scope: req.scope ?? "all" });
    case "lock":
      return new State(req.root).withLock(() => new Promise((done) => setTimeout(() => done("ran"), req.holdMs ?? 0)), { timeoutMs: req.timeoutMs });
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
