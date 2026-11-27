# Hand tests, hook drives, live checks

- The CLI takes `home` from `os.homedir()`, the Codex home from `$CODEX_HOME` and
  the project from `--project-dir`, else the cwd's git top level (a hook: stdin
  `cwd`, unless `$CLAUDE_PROJECT_DIR` is set). So a sync, status or hook run from
  the checkout touches the real `~/.claude/`, `~/.agents/`, Codex home **and this
  repo** (its `.claude/skilletor.json` is real). Hand tests: a temp cwd (or
  `--project-dir`), `HOME`, `CODEX_HOME` and `GETTY_HOME` all temp (an
  exported one survives a changed `HOME`), `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, and a marker (`$HOME/.claude.json`,
  `$CODEX_HOME/installation_id`) or `targets` — else no harness is detected. A
  `targets` naming `hermes` also needs a temp `HERMES_HOME`.
- Hook tests are black-box: stdin JSON → stdout JSON via `runHook`. Drive the
  real CLI the same way, with a temp project as `cwd`:
  `T=$(mktemp -d); mkdir -p "$T/home" "$T/proj"; touch "$T/home/.claude.json"`,
  `E="HOME=$T/home CODEX_HOME=$T/codex GETTY_HOME=$T/getty BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"`, then
  `printf '{"cwd":"%s","hook_event_name":"SessionStart"}' "$T/proj" | env $E bun dist/skilletor.js hook session-start`.
  `bun dist/skilletor.js` skips the starter; `bin/skilletor` goes through it and downloads the
  pinned Bun into the empty `$T/getty` (offline: exit 1, one `getty-bun:` line) — use it only to
  test the starter path. Below, `…` stands for `env $E bun dist/skilletor.js`.
  A move: `printf '{"old_cwd":"%s","new_cwd":"%s","hook_event_name":"CwdChanged"}' "$T/proj" "$T/wt" | … hook cwd-changed`.
  Its project is the checkout (git top level) of `new_cwd`, even with `$CLAUDE_PROJECT_DIR`
  set; it prints nothing unless that is another checkout than `old_cwd`'s, with its own
  `.claude/skilletor.json` and a lock that does not match it (no lock counts).
  The awaited move: `hook session-start` with `"session_id":"s1"` in `$T/proj`, then
  `printf '{"cwd":"%s","session_id":"s1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cd %s"}}' "$T/wt" "$T/wt" | … hook post-tool-use`.
  Same rule (the checkout of `cwd`, `$CLAUDE_PROJECT_DIR` or not), the session's record as
  `old_cwd`; it prints a `systemMessage` plus `hookSpecificOutput.additionalContext` (first
  line `skilletor: in <dir>:`). The binary reads only `cwd` and `session_id` — the `"if": "Bash(cd *)"` filter is Claude Code's, so any
  `tool_input` drives it. No record for the session (no SessionStart first): any checkout with
  an unmatched lock syncs, the start checkout too.
  A Codex/Hermes move: `touch "$T/codex/installation_id"` (Codex marker), the same SessionStart
  with host `codex` (`hook session-start codex`), then
  `printf '{"cwd":"%s","session_id":"s1","hook_event_name":"UserPromptSubmit"}' "$T/wt" | … hook user-prompt-submit codex`.
  Without host `codex` or `hermes` (positional, after the event) the prompt hook notices no move.
  Every `hook session-start` writes the session's cwd to `$HOME/.claude/skilletor/session-cwd.json`;
  `post-tool-use` and the Codex/Hermes prompt hook compare with it — the same cwd again prints
  nothing — and record another one. `cwd-changed` neither reads nor writes it.
- Live check against Claude Code: `claude --plugin-dir <checkout>` from a temp
  project dir in a throwaway `HOME` and `GETTY_HOME` (the hooks' starter installs Bun there), with a sentinel skill in a local source;
  confirm the SessionStart report and that the sentinel resolves in the same session.
  `-p --output-format stream-json --include-hook-events` shows a Bash `cd`'s `PostToolUse` run
  and its context; `CwdChanged` (not awaited) shows neither its run nor its line — judge a move
  without a Bash `cd` (`EnterWorktree`, `pushd`) by the checkout's lock and items on disk.
- Real Hermes: `test/hermes-real.test.ts` (needs a Hermes Python, `$HERMES_PYTHON`); its
  `hermes plugins install`/enable/sync/update case runs only with
  `SKILLETOR_HERMES_INSTALL=1` (network, ~100 s). By hand, `hermes plugins install`
  gets a throwaway `HERMES_HOME` **and** `HOME`: the first install downloads Hermes'
  plugin runtime (~450 MB) into the home.
