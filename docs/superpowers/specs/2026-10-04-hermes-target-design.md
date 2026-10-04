# skilletor – Hermes Agent as a third harness target

Status: phase 1 built on branch `hermes-target` (2026-10-04). Extends §14 of
`2026-09-22-skilletor-design.md`; section numbers below continue it as §16.

Hermes facts are quoted from the Hermes Agent checkout at commit `ea81748579ee`
(`~/dev/hermes-citiai/.dev/hermes-agent`), as `file:line`. "Measured" means: run against
that Hermes in a throwaway `HERMES_HOME`, no model called.

## 16. Harness target `hermes`

skilletor installs for a third harness, NousResearch **Hermes Agent** (`hermes`), next to
`claude` and `codex`. Linux only. Phase 1 covers detection, the layout, **skills** in both
scopes, and a native Hermes plugin that runs skilletor's existing hooks. Agents and rules
are not installed for Hermes; the report says so (§16.3). The Codex target was built in the
same three steps (§14, phases 1–3).

### 16.1 What Hermes has

| Concept | Hermes | Source |
|---|---|---|
| User skills | `$HERMES_HOME/skills/<name>/SKILL.md` (default home `~/.hermes`; a profile is its own home). Walked recursively, so a category directory is optional | `hermes_constants.py:111`, `:1195`; `agent/skill_utils.py:880` |
| Project skills | `<root>/.hermes/skills/` and `<root>/.agents/skills/`, `<root>` = nearest ancestor of the session's working directory holding `.git` (never the home directory). Loaded **only** when `<root>` is listed in `skills.trusted_project_dirs` (`hermes skills trust`) | `agent/skill_utils.py:534`, `:539`, `:584`, `:614`; `website/docs/user-guide/features/skills.md:457-509` |
| Precedence | project > local (`$HERMES_HOME/skills`) > `skills.create_dir` > `skills.external_dirs`. The same name twice **inside one tier but under two roots is ambiguous and refused**, identical bytes or not | `agent/skill_utils.py:420-441`, `:469-480` |
| Other skill roots | `skills.external_dirs` in `config.yaml` (off by default; `~/.agents/skills` is the documented example) | `agent/skill_utils.py:358`; `hermes_cli/config_defaults.py:1452` |
| Curator | Maintains only skills marked `created_by: agent` in `skills/.usage.json`, never by location | `tools/skill_usage.py:1-6` |
| Project instructions | Exactly **one** type loads, first match wins: `.hermes.md`/`HERMES.md` (walk to the git root) → `AGENTS.md` chain (git root → cwd, `AGENTS.override.md` wins per directory) → `CLAUDE.md` (cwd) → `.cursorrules`. Plus `$HERMES_HOME/SOUL.md`, the persona | `agent/prompt_builder.py:1710`, `:1754`, `:1831`, `:1627` |
| Rules directory | None | – |
| Subagent definitions | None. `delegate_task` takes a goal, toolsets and a `role` of `leaf` or `orchestrator`; there are no agent files | `tools/delegate_tool.py:97`, `:419-427`; `website/docs/user-guide/features/delegation.md:541-548` |
| Plugins | A directory with `plugin.yaml` and `__init__.py` (`register(ctx)`) under `$HERMES_HOME/plugins/`; opt-in through `plugins.enabled` in `config.yaml` | `hermes_cli/plugins_discovery.py:122`, `:209`, `:257-300` |

Measured (2026-10-04): a skill at `$HERMES_HOME/skills/demo/SKILL.md` with skilletor's
`.gitignore` beside it is listed by `hermes skills list` and by the `skills_list` tool and
loads with `skill_view`. In an untrusted project neither project directory is read. In a
trusted one both are; `proj-skill` present in `.hermes/skills` **and** `.agents/skills` is
dropped from the list and `skill_view` answers "Ambiguous skill name … refusing to guess".

### 16.2 Detection, layout, lock

**Detection.** `hermes` is in use when the Hermes home holds any of `config.yaml`, `.env`,
`SOUL.md`, `sessions/` – files Hermes creates (`SOUL.md` and `sessions/` on its first run of
any kind, `hermes_cli/config.py:568`) and skilletor never does. `skills/` is no marker:
skilletor creates it. `targets` takes `"hermes"` like the other two (§14.1). A marker set
without a `hermes` entry (an `EngineContext.markers` written before this target) means not
in use.

**Layout** (`LAYOUTS.hermes` in `targets.ts`, lock-key prefix `hermes:`):

| Type | `hermes` |
|---|---|
| skill, user scope | `<Hermes home>/skills/<name>/` (+ its own `.gitignore`, §6.4) |
| skill, project scope | `<repo>/.hermes/skills/<name>/` (+ its own `.gitignore`) – unless `codex` is an active target of that scope, see below |
| agent | not installed (no counterpart) |
| rule | not installed in phase 1 (§16.5) |

`SKILL.md` files install as they are; Hermes reads `name` and `description` and ignores
keys it does not know. Rendering, ownership, conflicts, `--force`, removal and the
per-skill `.gitignore` are those of §6 and §14.3, unchanged: `apply` gets a root per lock
key and knows nothing about Hermes. A Hermes root never gets a skilletor `.gitignore`
block, and skilletor never reads or rewrites a `.gitignore` there.

**Project skills and Codex.** Hermes reads `<repo>/.agents/skills` too, which is where the
Codex copy of a project skill lives, and refuses a name it finds in both project
directories (§16.1). So while `codex` is an active target of a project scope, Hermes gets
**no copy of its own** there: the Codex copy serves both. `receivers()` in `targets.ts` is
the one place that says which active harnesses get a copy of a type in a scope; `sync`,
`check` and `status` all ask it. A `hermes:skills/…` project entry left from before Codex
became active is removed like an undeclared item, and `check` counts it as target drift.
Wart: that copy was rendered with `harness == "codex"`, so a template that branches on
`harness == "hermes"` does not reach Hermes in such a project.

**The Hermes home.** The user-scope root follows the Hermes home, and one user-scope lock
serves **one** Hermes home. Which one:

1. `$HERMES_HOME` of the run, when set – the plugin passes the session's (§16.4);
2. else the home the last user-scope sync ran under, recorded in the state dir as
   `hermes-home.json` (§6.5) when it is not the default;
3. else `~/.hermes`.

Rule 2 exists because Hermes is commonly started with a `HERMES_HOME` no other process
has (a service unit, a development home, `hermes -p <profile>`): without the record, a
Claude Code session would not detect Hermes, delete the lock's `hermes:` entries as those
of an inactive target, and the next Hermes session would meet its own files as foreign
ones. With it every session, whatever started it, agrees on the targets and the root, and
a Claude Code or Codex SessionStart keeps the Hermes home current too.

When a run's home differs from the recorded one, `check` reports a change, and the
user-scope sync first **moves**: it deletes what the lock owns under the old home, drops
those entries, records the new home, and then installs under the new home by the ordinary
rules – so nothing skilletor did not install is ever taken for its own, and nothing is left
behind. One warning names the move.

**Report.** Hermes items show under their lock key (`hermes:skills/foo`); the hook context
marks them `(hermes)` with "active from the next Hermes session". Hermes builds its skill
index into the system prompt before `on_session_start` fires
(`agent/conversation_loop.py:849`, `:862-869`), so a skill synced at session start is on
disk and reachable by `skill_view`, but not in that session's index.

### 16.3 What is skipped for Hermes

A declared item an active harness gets no copy of is counted, and the run's report carries
one **note** per harness and reason – `SyncReport.notes`, shown by `reportText` and
`--json`, never by the hooks (a note, not a warning: it would repeat in every session):

    skilletor: note: 2 agent(s) and 1 rule(s) not installed for Hermes (Hermes has no agent files and no rules directory)
    skilletor: note: 3 skill(s) not installed for Hermes in the project scope (Hermes reads the Codex copy in .agents/skills)

`status` lists a declared item once per harness that gets a copy, so it shows no `hermes:`
row for an agent or a rule.

### 16.4 The Hermes plugin

`hermes/skilletor/` (`plugin.yaml`, `__init__.py`) is a native Hermes plugin and a thin
adapter: it runs the same `skilletor hook …` commands the Claude Code and Codex hook files
run, and hands their answer to Hermes. It decides nothing.

| Hermes hook | Fires | skilletor call | Return |
|---|---|---|---|
| `on_session_start` | first turn of a new session, after the system prompt is built; return ignored (`agent/conversation_loop.py:862-869`; `website/docs/user-guide/features/hooks.md:902-924`) | `skilletor hook session-start --harness hermes`, input `{"hook_event_name":"SessionStart","source":"startup","cwd":…,"session_id":…}` | none; the answer is kept for the session |
| `pre_llm_call` | once per user turn, after `on_session_start` on a first turn (`agent/turn_context.py:1159`, `:781-835`) | the kept session-start answer, if any; else, in a session this process has not started (a resumed one fires no `on_session_start`), `session-start` with `"source":"resume"`; else `skilletor hook user-prompt-submit --harness hermes` | `{"context": <text>}` or `None` |

`pre_llm_call` is Hermes' one channel from a plugin into the conversation: a returned
`{"context": …}` is appended to the turn's user message and stays in the history
(`agent/turn_context.py:108-127`, `:1268-1282`; `hooks.md:673-700`). The text is the hook
answer's `additionalContext`; an answer with a `systemMessage` alone (a config error, a
warning line – in Claude Code the line the user sees) is passed as that line, since a
Hermes plugin hook has no user-only channel, and logged.

`--harness hermes` marks the calling harness in the hook context. It changes nothing in
phase 1; it is there so rules (§16.5) need no new plugin.

**Where the session is.** The project directory is the git top level of the hook input's
`cwd` (§14.5). The plugin sends Hermes' own answer to "where does this session work"
(`agent.runtime_cwd.resolve_agent_cwd`, the resolver `find_project_root` uses for project
skills, `agent/skill_utils.py:539-556`), else the process directory. `HERMES_HOME` in the
child's environment is `hermes_constants.get_hermes_home()` – the active profile, also on
a gateway that serves several.

**Which CLI.** In order: `$SKILLETOR_BIN`; `bin/skilletor` of the checkout the plugin
directory is a symlink into; `skilletor` on `PATH`. None found: the plugin does nothing.

**Fast and fail-open.** Importing the module and `register(ctx)` start nothing and read
nothing (Hermes gives a plugin 10 s to load, `hermes_cli/plugins_loader.py:40`). Hermes
abandons a bounded hook callback after `plugins.hook_callback_timeout` (default 30 s) and
then skips it for 60 s; for `on_session_start` and `pre_llm_call` that is fail-open, only
`pre_tool_call` fails closed (`hermes_cli/plugins_dispatch.py:26-53`, `:209-243`;
`:153`). The plugin stays below that with limits of its own – 20 s
for `session-start`, 5 s for `user-prompt-submit` – kills the child at the limit, and
swallows every error: no CLI, a non-zero exit, no JSON, a timeout all mean the turn runs
without a message. A killed sync is what a Claude Code hook timeout already leaves (§6.2,
§6.5).

**`hermes skilletor …`.** The plugin registers a CLI subcommand
(`ctx.register_cli_command`, `hermes_cli/plugins.py:664`; `hermes_cli/main.py:3402-3440`)
that passes its arguments to the skilletor CLI with the active `HERMES_HOME`, so
`hermes -p work skilletor status` answers for that profile. No slash command: `/skilletor`
would collide with the `skilletor` skill's own command once that skill is installed.

**Install by hand.** Symlink (or copy) `hermes/skilletor` to
`$HERMES_HOME/plugins/skilletor` and add `skilletor` to `plugins.enabled` in
`$HERMES_HOME/config.yaml`. `hermes plugins doctor <path> --ci` passes.

The plugin is not required for Hermes to get its skills: every sync installs for every
active target, so a Claude Code session start updates the Hermes home as well. The plugin
is what syncs on a machine, or in a session, where only Hermes runs.

### 16.5 Not built, and why

- **Rules.** Hermes has no rules directory. Its counterparts are the project instruction
  file and a plugin's own channels, and none is a drop-in:
  `AGENTS.md` is read, but only when no `.hermes.md` shadows it, and it is committed text –
  the reason §14.8 keeps rule text out of it for Codex. A plugin system-prompt section
  (`ctx.register_system_prompt_section`, `hermes_cli/plugins.py:998`) is frozen into each
  new session's prompt but capped at 4,000 characters, 8,000 over all plugins
  (`hermes_cli/plugins_dispatch.py:68-72`). The faithful route is §14.8's: a gitignored
  rules file per scope, a pointer in `AGENTS.md`, and the text injected once per session –
  here through `pre_llm_call` on the first turn. That is a cut through `syncCodexRules`
  and the one pointer block two harnesses would share, so it is left for a second phase
  rather than done half. Until then: in a project where `codex` is active, Hermes reads the
  `AGENTS.md` pointer skilletor writes for Codex and finds `.codex/skilletor-rules.md` by
  it; the user scope has no such path (Hermes reads no user-level `AGENTS.md`).
- **Agents.** No counterpart (§16.1).
- **Project trust.** skilletor does not read or edit `skills.trusted_project_dirs`. Hermes
  itself tells the user in its banner when a project holds skills it did not load.
- **Several Hermes homes at once.** One lock serves one home (§16.2). Two profiles that
  both enable the plugin move the user-scope skills back and forth at each session start.
  Serving them side by side needs ownership per home – a lock per Hermes home, or lock keys
  that name the home.
- **The `skilletor` skill for Hermes.** The plugin does not bundle `skills/skilletor`
  (`ctx.register_skill`); install it like any other skill.
- **Distribution.** No catalog entry, no `hermes plugins install` path, no marketplace
  change. The plugin's version is the package's, enforced by a test.

### 16.6 Tests

- Engine, in process, injected markers and Hermes home: detection, `targets`, layout in
  both scopes, the lock, removal, the Codex-serves-Hermes rule, notes, the home record and
  the move, `check` drift, status, report; Claude-only and Codex output unchanged.
- The plugin against a stand-in CLI (a shell script), driven by the system `python3`:
  payloads, returns, limits, every failure silent, nothing started by `register`.
- **Real Hermes** (`$HERMES_PYTHON`, else `~/dev/hermes-citiai/.dev/venv/bin/python`;
  skipped without it), a fresh Hermes process per case and a throwaway `HERMES_HOME` on
  disk: the built CLI installs a skill from a local source for the target `hermes`, and
  Hermes' own `hermes skills list` and `skills_list` tool see it; the project rules above;
  the plugin loads through `plugins.enabled`, its hooks are registered, Hermes'
  `invoke_hook("on_session_start")` triggers the sync and `invoke_hook("pre_llm_call")`
  returns the report as context; `hermes skilletor status` reaches the CLI;
  `hermes plugins doctor hermes/skilletor --ci` passes. No model is called.
