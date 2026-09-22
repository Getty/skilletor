---
name: skilletor-core
description: "Use when changing skilletor's own code, tests, build or plugin wiring — src/, test/, dist/, hooks.json, plugin.json, the bundled skilletor skill — or when a change must be verified against a real Claude Code session. Also when a test passes under tsc but fails under node, or dist/ drifts from src/."
---

# skilletor — architecture and invariants

skilletor is a Claude Code plugin plus a standalone CLI that installs **skills,
agents and rules** from remote sources into `~/.claude/` (user scope) and
`<project>/.claude/` (project scope), re-rendering every sync. Design spec:
`docs/superpowers/specs/2026-09-22-skilletor-design.md`. User-facing CLI and
config reference: `skills/skilletor/SKILL.md` (the skill the plugin ships) —
read it instead of re-deriving the config format.

## Module boundaries (spec §10) — keep them

```
cli.ts        arguments, dispatch                     commands.ts  add/install/… edit config, then sync
config.ts     load/merge/validate + edit operations   spec.ts      shorthand → {git|url|local}, injectable probe
sources/*     resolve(), check() per backend          catalog.ts   scan a source dir → items
render.ts     build one item in memory (Nunjucks)     apply.ts     diff → atomic write → clean → gitignore block
lock.ts       lock read/write                         state.ts     trust, last-check, pending-report, mutex
engine.ts     sync / check / status pipeline          hooks.ts     SessionStart + UserPromptSubmit, black box
report.ts     text / json / hook output
```

- `sources/*` knows nothing about templating; `render` nothing about the
  target filesystem; `apply` nothing about sources. A change that makes one of
  them import the other is a design change — file a ticket, don't sneak it in.
- Everything a backend needs (probe, timeout, cache root, `home`) is injected
  through `EngineContext`; tests rely on that to run against temp directories.

## Invariants that must survive any change

- **Render-and-compare, no invalidation.** Every sync builds every declared item
  in memory and diffs against disk + lock. There is no cache of rendered output.
- **The lock is the ownership boundary.** Only paths in
  `<scope>/.claude/skilletor.lock.json` are ever overwritten or deleted. A path
  on disk that is not in the lock is a conflict (reported, untouched; `--force`
  adopts it). A managed file that diverged from its lock hash is overwritten and
  named in the report.
- **Installable types are exactly** `skill`, `agent`, `rule` (`ITEM_TYPES` in
  `config.ts`), each with a fixed target directory. Hooks, `settings.json` and
  MCP configs are never synced.
- **Templating:** only `*.njk` is rendered (installed with `.njk` stripped);
  everything else is copied byte for byte. Context has no `env.*`. An undefined
  variable is an error, and a template error leaves that item at its old state.
- **Trust:** a source declared only in a project config is not fetched until
  `skilletor trust <name>`; a changed URL lapses trust.
- **Security:** item names, tar entries and includes cannot escape source or
  target root; symlinks in sources are rejected; `url` sources are HTTPS-only.
- **A hook never disturbs the session:** every path in `hooks.ts` catches, exits
  0, and surfaces problems as one warning line. Offline → cache + warning.
- **Config default vs. fallback:** `checkInterval` defaults to 1800 s in
  `config.ts`; the `DEFAULT_INTERVAL` in `hooks.ts` is only the fallback when the
  config cannot be loaded. `<= 0` disables the in-session check.

## Activation facts (measured in the spike, spec §12)

Skills written mid-session are usable at once. Agents and rules are read at
session start or `/reload-plugins` and take effect from the **next** prompt.
`report.ts` `ACTIVATION` states this per item type — keep the wording honest
when adding item types or changing the report.

## Code conventions

- **Erasable TypeScript only.** Tests run `.ts` through Node's type-stripping,
  so constructor parameter properties, `enum`, runtime `namespace` and other
  emit-generating syntax fail at runtime with
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — and `tsc --noEmit` does **not** catch
  it. Declare fields and assign in the constructor body. `npm test` is the
  check that counts.
- Imports between modules use the `.ts` extension (`from "./report.ts"`).
- Runtime dependency is Nunjucks alone. Adding another is a design decision.
- Public artifacts (code, comments, docs, README, this skill) are English.

## Verify — every code change

```bash
npm run typecheck && npm test        # 153 tests, node:test, temp dirs
npm run build && npm run check-dist  # dist/skilletor.js is committed; CI diffs it
```

- **`dist/` ships.** Any `src/` change without `npm run build` fails CI's
  `check-dist`. Commit `dist/skilletor.js` with the source change.
- Test git fixtures use `git init -b main` (the default branch name is not
  portable). Path comparisons go through `realpathSync` (macOS `/var` →
  `/private/var`). Several tests create symlinks — Windows is not in CI.
- The CLI resolves `home` from `os.homedir()`. A manual `skilletor sync` from the
  checkout touches the real `~/.claude/`; for hand tests set `HOME` to a temp
  directory, or use `--project-dir <tmp>` with a project-scope config.
- Hook tests are black-box: stdin JSON → stdout JSON via `runHook`. Drive the
  real binary the same way:
  `printf '{"cwd":"%s","hook_event_name":"SessionStart"}' "$PWD" | bin/skilletor hook session-start`.
- Live check against Claude Code: `claude --plugin-dir .` in a throwaway
  `HOME`, with a sentinel item in a local source; confirm the SessionStart
  report and that the sentinel skill resolves in the same session.

## Release surface (audit, never perform)

`package.json` and `.claude-plugin/plugin.json` carry the same version; a tag
`vX.Y.Z` matches both; `README.md` and `skills/skilletor/SKILL.md` restate the
CLI reference and must match `src/cli.ts` usage text. Steps and the marketplace
entry: `docs/release.md`. Tagging, pushing and marketplace edits are the
maintainer's, on explicit go-ahead only.
