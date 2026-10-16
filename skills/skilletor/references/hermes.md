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

## The Hermes home

User-scope skills go to `$HERMES_HOME`, else the last sync's home, else `~/.hermes`. A sync
under another home moves them (deletes what skilletor installed in the old home, warns
once) — enable the plugin in one Hermes profile only.

A skill Hermes already has under that name (bundled or hub, `skills/<category>/<name>/`)
makes the name ambiguous: the copy skilletor installed does not load. Rename or remove one.
