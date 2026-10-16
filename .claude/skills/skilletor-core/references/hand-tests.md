# Hand tests, hook drives, live checks

- The CLI takes `home` from `os.homedir()`, the Codex home from `$CODEX_HOME` and
  the project from `--project-dir`, else the cwd's git top level (a hook: stdin
  `cwd`, unless `$CLAUDE_PROJECT_DIR` is set). So a sync, status or hook run from
  the checkout touches the real `~/.claude/`, `~/.agents/`, Codex home **and this
  repo** (its `.claude/skilletor.json` is real). Hand tests: a temp cwd (or
  `--project-dir`), **both** `HOME` and `CODEX_HOME` temp (an exported `CODEX_HOME`
  survives a changed `HOME`), and a marker (`$HOME/.claude.json`,
  `$CODEX_HOME/installation_id`) or `targets` — else no harness is detected. A
  `targets` naming `hermes` also needs a temp `HERMES_HOME`.
- Hook tests are black-box: stdin JSON → stdout JSON via `runHook`. Drive the
  real binary the same way, with a temp project as `cwd`:
  `T=$(mktemp -d); mkdir -p "$T/home" "$T/proj"; touch "$T/home/.claude.json"`, then
  `printf '{"cwd":"%s","hook_event_name":"SessionStart"}' "$T/proj" | HOME="$T/home" CODEX_HOME="$T/codex" bin/skilletor hook session-start`.
- Live check against Claude Code: `claude --plugin-dir <checkout>` from a temp
  project dir in a throwaway `HOME`, with a sentinel skill in a local source;
  confirm the SessionStart report and that the sentinel resolves in the same session.
- Real Hermes: `test/hermes-real.test.ts` (needs a Hermes Python, `$HERMES_PYTHON`); its
  `hermes plugins install`/enable/sync/update case runs only with
  `SKILLETOR_HERMES_INSTALL=1` (network, ~100 s). By hand, `hermes plugins install`
  gets a throwaway `HERMES_HOME` **and** `HOME`: the first install downloads Hermes'
  plugin runtime (~450 MB) into the home.
