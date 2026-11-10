# skilletor for Hermes Agent — setup, where skills go, the Hermes home

## Setup

Hermes is never detected; all three steps are needed:

1. `hermes` in the **user** `targets` (`~/.claude/skilletor.json`), together with every other
   harness wanted — `targets` replaces detection: `["claude", "codex", "hermes"]`
   (`["hermes"]` alone drops the others). A project's `targets` can leave Hermes out, never
   add it.
2. The plugin: `hermes plugins install Getty/skilletor/hermes/skilletor --enable` (installed
   without `--enable`: `hermes plugins enable skilletor`).
3. The CLI, which the plugin does not bring (Node.js >= 18) — `SKILLETOR_BIN=<clone>/bin/skilletor`
   in `$HERMES_HOME/.env`, else `skilletor` on `PATH`. Without one the plugin does nothing.

Check: `hermes skilletor status` (any CLI command after `hermes skilletor`) runs the CLI
with that Hermes' home as `HERMES_HOME`.

## What Hermes gets

**Skills only** — no agents, no rules (a sync notes how many it skipped).

| Scope | Path |
|---|---|
| user | `<Hermes home>/skills/<name>/` |
| project | `.hermes/skills/<name>/` — none while `codex` is a target of that project: Hermes reads the Codex copy in `.agents/skills/` |

- Lock keys: `hermes:skills/<name>`; templates render with `harness` = `hermes`.
- Project skills load only after `hermes skills trust` in the project.
- A session moved into another checkout (`/worktree new`, the TUI gateway moving it into a
  worktree; not a terminal `cd`) has that checkout synced on its next turn, before the model
  is called. `skills_list` finds the new skills at once, the system prompt's skill index
  only from the next session — and an untrusted worktree hides every project skill, the
  first checkout's too, until `hermes skills trust <dir>` (takes effect at once). When the
  sync adds or updates a skill, that turn's context names this command for the user to run,
  even when the checkout is trusted already: skilletor does not read Hermes' trust list.

## The Hermes home

User-scope skills go to `$HERMES_HOME`, else the last sync's home, else `~/.hermes`. A sync
under another home moves them (deletes what skilletor installed in the old home, warns
once) — enable the plugin in one Hermes profile only.

A skill Hermes already has under that name (bundled or hub, `skills/<category>/<name>/`)
makes the name ambiguous: the copy skilletor installed does not load. Rename or remove one.
