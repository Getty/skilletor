// The reference implementation, driven from the Perl test suite (t/50-parity.t): reads one JSON
// request on stdin, runs it against ../src, prints the answer as JSON. Never part of the CPAN
// dist; the test skips without it, without node or without the TypeScript tree beside perl/.
//
//   { "op": "backend", "src": {...}, "home": "/h" }                 -> resolveBackend
//   { "op": "git", "action": "resolve" | "check", "opts": {...}, "cached": "git:abc" }
//   { "op": "url", "action": "resolve" | "check", "opts": {...}, "cached": "etag:..." }
//   { "op": "trust", "root": "/s", "name": "x", "backend": {...} }  -> State.isTrusted
//   { "op": "sweep", "root": "/c" }                                 -> sweepGitCache + sweepUrlCache
// Answer: { "result": ... } or { "error": message }.
import { readFileSync } from "node:fs";
import { resolveBackend } from "../../src/engine.ts";
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
