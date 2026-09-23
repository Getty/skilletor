---
name: skilletor-core
description: "Use when changing skilletor's own code, tests, build or plugin wiring — src/, test/, dist/, hooks.json, plugin.json, the bundled skilletor skill — or when a change must be verified against a real Claude Code or Codex session. Also when a test passes under tsc but fails under node, or dist/ drifts from src/."
---

# skilletor — architecture and invariants

skilletor is a Claude Code and Codex plugin plus a standalone CLI that installs
**skills, agents and rules** from remote sources for one or both harnesses, in
user scope (`~`) and project scope (the project root), re-rendering every sync. Design spec:
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
report.ts     text / json / hook output               targets.ts   harness detection, LAYOUTS, lock keys
convert.ts    agent Markdown → Codex TOML             agentsmd.ts  the managed AGENTS.md block
frontmatter.ts  YAML subset reader                    toml.ts      TOML writer (no dependency)
```

- `sources/*` knows nothing about templating; `render` nothing about the
  target filesystem; `apply` nothing about sources. A change that makes one of
  them import the other is a design change — file a ticket, don't sneak it in.
- Everything a backend needs (probe, timeout, cache root, `home`, `codexHome`,
  harness `markers`) is injected through `EngineContext`; tests rely on that to run
  against temp directories and never look at the real machine.
- `apply` knows nothing about harnesses: it gets a lock key → root function.
  Per-harness knowledge lives in `LAYOUTS` (`targets.ts`); output conversion
  (`convert.ts`) runs in the engine between render and apply.

## Invariants that must survive any change

- **Render-and-compare, no invalidation.** Every sync builds every declared item
  in memory and diffs against disk + lock. There is no cache of rendered output.
- **The lock is the ownership boundary.** One lock per scope, always
  `<scope>/.claude/skilletor.lock.json`, for every harness. Claude keys stay
  unprefixed (`skills/foo`); Codex keys are `codex:skills/foo`, paths relative to
  that key's root. Only paths in the lock are ever overwritten or deleted; entries
  with an unknown prefix are kept untouched. A path on disk that is not in the lock
  is a conflict (reported, untouched; `--force` adopts it). A managed file that
  diverged from its lock hash is overwritten and named in the report.
- **`AGENTS.md` is shared, not owned.** Codex rules are `block: true` lock entries
  whose sections live between `<!-- skilletor:begin -->`/`end` markers; text outside
  the markers is never modified. Malformed markers or a symlinked/unreadable
  `AGENTS.md` refuse the whole block for that scope, even with `--force`.
- **Installable types are exactly** `skill`, `agent`, `rule` (`ITEM_TYPES` in
  `config.ts`); where each lands is `LAYOUTS[harness].roots[type]` per scope.
  Hooks, `settings.json` and MCP configs are never synced.
- **Targets:** machine set = user `targets` ?? detected markers (empty → config
  error, nothing touched); a project can only narrow it. Every item renders once
  per active target with `harness` in the context; empty render skips per target.
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

Claude Code: skills written mid-session are usable at once; agents and rules are
read at session start or `/reload-plugins` and take effect from the **next**
prompt. Codex: unmeasured, so every Codex item reports "active from the next Codex
session". `report.ts` `ACTIVATION` / `CODEX_ACTIVATION` state this — keep the
wording honest when adding item types or changing the report.

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
npm run typecheck && npm test        # node:test, temp dirs
npm run build && npm run check-dist  # dist/skilletor.js is committed; CI diffs it
```

- **`dist/` ships.** Any `src/` change without `npm run build` fails CI's
  `check-dist`. Commit `dist/skilletor.js` with the source change.
- Test git fixtures use `git init -b main` (the default branch name is not
  portable). Path comparisons go through `realpathSync` (macOS `/var` →
  `/private/var`). Several tests create symlinks — Windows is not in CI.
- The CLI resolves `home` from `os.homedir()` and the Codex home from
  `$CODEX_HOME`. A manual `skilletor sync` from the checkout touches the real
  `~/.claude/`, `~/.agents/` and Codex home; for hand tests set **both** `HOME` and
  `CODEX_HOME` to temp directories (an exported `CODEX_HOME` survives a changed
  `HOME`), and create a marker (`$HOME/.claude.json`, `$CODEX_HOME/installation_id`)
  or set `targets` — an empty temp home detects no harness and fails.
- Hook tests are black-box: stdin JSON → stdout JSON via `runHook`. Drive the
  real binary the same way:
  `printf '{"cwd":"%s","hook_event_name":"SessionStart"}' "$PWD" | bin/skilletor hook session-start`.
- Live check against Claude Code: `claude --plugin-dir .` in a throwaway
  `HOME`, with a sentinel item in a local source; confirm the SessionStart
  report and that the sentinel skill resolves in the same session.

## Release surface (audit, never perform)

`package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`
carry the same version (a test enforces it); a tag
`vX.Y.Z` matches both; `README.md` and `skills/skilletor/SKILL.md` restate the
CLI reference and must match `src/cli.ts` usage text. Steps and the marketplace
entry: `docs/release.md`. Tagging, pushing and marketplace edits are the
maintainer's, on explicit go-ahead only.
