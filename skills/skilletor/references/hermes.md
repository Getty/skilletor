# skilletor for Hermes Agent — setup, where skills go, the Hermes home

## Setup

Hermes is never machine-detected; all three steps are needed:

1. `hermes` in the **user** `targets` (`~/.claude/skilletor.json`), together with every other
   harness wanted — user targets are the machine allowlist and replace detection:
   `["claude", "codex", "hermes"]` (`["hermes"]` alone drops the others). Project targets can
   select only from that list: local config, then committed config, then local evidence.
2. The plugin: `hermes plugins install Getty/skilletor/hermes/skilletor --enable` (installed
   without `--enable`: `hermes plugins enable skilletor`). It updates only with
   `hermes plugins update skilletor`, apart from the CLI and the Claude Code or Codex plugin
   (`hermes plugins check-updates` cannot tell whether this install is behind).
3. The CLI. The plugin takes `$SKILLETOR_BIN` if set (then that or nothing; set it in
   `$HERMES_HOME/.env`), else the getty-bun starter of the clone its directory is a symlink
   into, else `skilletor` on `PATH`. A copy `hermes plugins install` made is no clone: set
   `SKILLETOR_BIN` to `install.sh`'s command (`~/.local/bin/skilletor`) or a clone's
   `bin/skilletor`, or put that bin dir on Hermes' `PATH`. Without a CLI the plugin does nothing.

Check: `hermes skilletor status` (any CLI command after `hermes skilletor`) runs the CLI
with that Hermes' home as `HERMES_HOME`.

**First start.** Through a clone's starter the plugin runs the starter's `ensure` once, in
the background (up to 600 s), before its first hook; hooks (20 s session start, 25 s per
turn) are skipped while it runs or after it failed, so skills sync from the turn after Bun is
installed. A failed `ensure` is logged as `skilletor: … ensure failed: getty-bun: …` and
retried at the next session start. Through `SKILLETOR_BIN` or `PATH` there is no `ensure`:
a hook cannot finish a Bun download within 20 s, so run `skilletor --version` once by hand
(`install.sh` does).

**Skills never sync — check in order.** Hooks fail silently: no CLI, a Bun not ready, a
non-zero exit all just skip the hook (its stderr is discarded), nothing in the session.

1. `hermes skilletor status`. `skilletor: CLI not found (set SKILLETOR_BIN, …)`, exit 1,
   means the plugin has no CLI — the usual case for a `hermes plugins install` copy, which
   has no `bootstrap/` of its own. A `SKILLETOR_BIN` naming a missing or non-executable file
   counts as not found (no fallback to `PATH`).
2. No CLI yet: `curl -fsSL https://raw.githubusercontent.com/Getty/skilletor/main/install.sh | sh`.
   It needs `sh`, `awk` and `git` — no Node.js, no Bun. Either way the command lands in
   `~/.local/bin/skilletor` (`--bin-dir` changes it): with `claude` on `PATH` a script running
   the Claude Code plugin, without it (or `sh -s -- --no-plugin`) a link into a clone in
   `${XDG_DATA_HOME:-~/.local/share}/skilletor`. Its closing `skilletor --version` installs
   the pinned Bun once — it needs `curl` or `wget`, `unzip`, `sha256sum` or `shasum`, `flock`
   and `mktemp`; a `getty-bun: ` line there: runtime.md beside this file. Then set
   `SKILLETOR_BIN=/home/<you>/.local/bin/skilletor` (absolute) in `<Hermes home>/.env`
   (default `~/.hermes/.env`), start Hermes anew (it reads `.env` at start), rerun step 1.
3. `status` works but no `hermes` target: step 1 of Setup. `hermes skilletor sync` shows
   what a hook would have done; `hermes skills trust` for project skills.

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
