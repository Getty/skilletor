# skilletor – Hermes Agent as a third harness target

Status: phase 1 built on branch `hermes-target` (2026-10-04). Extends §14 of
`2026-09-22-skilletor-design.md`; section numbers below continue it as §16.

Hermes facts are quoted from the Hermes Agent checkout at commit `ea81748579ee`
(`~/dev/hermes-citiai/.dev/hermes-agent`), as `file:line`. "Measured" means: run against
that Hermes in a throwaway `HERMES_HOME`, no real model called.

## 16. Harness target `hermes`

skilletor installs for a third harness, NousResearch **Hermes Agent** (`hermes`), next to
`claude` and `codex`. Linux only (on native Windows the default Hermes home follows Hermes',
§16.2; not run there). Phase 1 covers the target – opt-in by `targets`, never detected –, the
layout, **skills** in both scopes, and a native Hermes plugin that runs skilletor's existing hooks. Agents and rules
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

### 16.2 Opt-in, layout, lock

**Opt-in, no detection** (maintainer, 2026-10-15; §16.7). Hermes is never detected: `hermes`
is a machine target only when the user config's `targets` names it. A project's `targets`
then narrows it away like the other two (§14.1) and can never add it. As `targets` replaces
detection whole, a user who opts in lists every harness they want, e.g.
`"targets": ["claude", "codex", "hermes"]`. `HarnessMarkers` and `defaultMarkers` know
`claude` and `codex` only, so the config error for an empty machine set names their markers
alone (and still names `"hermes"` as a value of `targets`).

While `hermes` is no target, a run Hermes started – the plugin's `session-start` with
`--harness hermes` – answers one line saying how to opt in, naming the machine targets plus
`hermes` (§16.4). `skilletor sync`, `hermes skilletor sync` included, says nothing of it.

An install of the auto-detecting build (branch `hermes-target`, never released) can hold
`hermes:` entries in the user lock and a home record with no `targets` naming `hermes`. The
next user-scope sync removes them as those of an inactive target (§14.3), from the recorded
home, and drops the record – whatever `HERMES_HOME` that run has: while Hermes is no target
nothing moves (below).

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
3. else Hermes' own default home (`_get_platform_default_hermes_home`,
   `hermes_constants.py:51-58`; `defaultHermesHome` in `targets.ts`): `~/.hermes`, on
   native Windows `%LOCALAPPDATA%\hermes` – `<home>\AppData\Local\hermes` when
   `LOCALAPPDATA` is unset or blank. Hermes' `HERMES_DATA_DIR_SUFFIX` (desktop and channel
   builds) is not followed.

Rule 2 exists because Hermes is commonly started with a `HERMES_HOME` no other process
has (a service unit, a development home, `hermes -p <profile>`): without the record, a
Claude Code session would take the lock's `hermes:` entries for paths under the default
home, install them anew there and leave the copies Hermes reads behind. With it every
session, whatever started it, agrees on the root, and a Claude Code or Codex SessionStart
keeps the Hermes home current too.

When a run's home differs from the recorded one, `check` reports a change (target drift
of the user scope), and the user-scope sync first **moves**: it deletes what the lock owns
under the old home, drops those entries, records the new home, and then installs under the
new home by the ordinary rules – so nothing skilletor did not install is ever taken for its
own, and nothing is left behind. The record is written before anything is installed under
the new home, so a sync that stops midway leaves a lock and a record that agree. One
warning names the move. A project-scope sync alone leaves the record to the user scope.
While Hermes is no target, a run under another home moves nothing: its entries go as an
inactive target's, from the recorded home. The record goes when Hermes is no target any
more (its entries went with it).

**Report.** Hermes items show under their lock key (`hermes:skills/foo`); the hook context
marks them `(hermes)` with "active from the next Hermes session". Hermes builds its skill
index into the system prompt before `on_session_start` fires
(`agent/conversation_loop.py:849`, `:862-869`), so a skill synced at session start is on
disk and reachable by `skill_view` (measured: `skills_list` and `skill_view` in the process
that ran the hook see it), but not in that session's index.

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
| `pre_llm_call` | once per user turn, after `on_session_start` on a first turn (`agent/turn_context.py:1159`, `:781-835`) | on the first turn the plugin sees of a session: nothing more if `on_session_start` ran, else (a resumed session fires none) `session-start` with `"source":"resume"`; on every later turn `skilletor hook user-prompt-submit --harness hermes` | `{"context": <text>}` or `None` |

A delegated child is no session of the user's: `delegate_task` builds it with
`platform="subagent"` and a parent session (`tools/delegate_tool.py:270-280`), it fires both
hooks, and the plugin does nothing for it – else every subagent would start with a check of
all sources.

`pre_llm_call` is how a plugin speaks into the conversation: a returned
`{"context": …}` is appended to the turn's user message and stays in the history
(`agent/turn_context.py:108-127`, `:1268-1282`; `hooks.md:673-700`). The text is the hook
answer's `additionalContext`; an answer with a `systemMessage` alone (a config error, a
warning line – in Claude Code the line the user sees) is passed as that line, since a
Hermes plugin hook has no user-only channel, and logged.

`--harness hermes` marks the calling harness in the hook context. In phase 1 it adds one
thing: while `hermes` is no machine target (§16.2), the `session-start` answer gets the
opt-in line – after its `systemMessage`, and after its `additionalContext` when it has one,
since the plugin hands the model the context when there is one. Once per session start (a
resumed one's too), never on a turn; with a config error, that error is the answer alone.
The flag is also there so rules (§16.5) need no new plugin.

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
that passes its arguments to the skilletor CLI with the active Hermes home as
`HERMES_HOME`, and exits with the CLI's code. No slash command: `/skilletor` would collide
with the `skilletor` skill's own command once that skill is installed.

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
- **Name collisions inside the Hermes home.** skilletor owns `skills/<name>/` and looks at
  nothing else there. A bundled or hub skill of the same `name` in a category directory
  (`skills/<category>/<name>/`) is a second skill of that name in the same tier and root.
  Measured: Hermes then refuses the bare name ("Ambiguous skill name … use one of
  `<category>/<name>`"), lists the other skill under that path, and skilletor's copy cannot
  be loaded at all. Finding that would mean reading every `SKILL.md` of the home at each sync.
  The skills of `NousResearch/hermes-agent` – the README's `path` example source (§3) – are
  this case by construction: Hermes already ships them under `skills/<category>/<name>/`,
  so with `hermes` among the targets each one skilletor installs collides with Hermes' own.
  That source is for Claude Code and Codex; there is no per-target selection of items
  (§16.7, decision 2).
- **Several Hermes homes at once.** One lock serves one home (§16.2). Two profiles that
  both enable the plugin move the user-scope skills back and forth at each session start.
  Serving them side by side needs ownership per home – a lock per Hermes home, or lock keys
  that name the home.
- **One checkout, two homes.** Targets are per machine and per `HOME` (§14.6). A Hermes
  that runs under another `HOME` than the user's Claude Code – a service account whose
  `~/.claude/skilletor.json` names `hermes` alone – and works in the same checkout has only
  itself as a target, and its project-scope sync removes the checkout's Claude Code items as
  those of an inactive target; the next Claude Code session puts them back. Not new with Hermes, but a Hermes service is the likelier case.
- **The `skilletor` skill for Hermes.** The plugin does not bundle `skills/skilletor`
  (`ctx.register_skill`); install it like any other skill.
- **Distribution.** No catalog entry, no `hermes plugins install` path, no marketplace
  change. The plugin's version is the package's, enforced by a test.

### 16.6 Tests

- Engine, in process, injected markers and Hermes home: no detection, opt-in by `targets`
  (a project cannot add it), the upgrade from the auto-detecting build, the default home per
  platform, the hook's opt-in line through `runHook` and the built CLI, layout in both scopes, the lock, removal, the Codex-serves-Hermes rule, notes, the home record and
  the move, `check` drift, status, report; Claude-only and Codex output unchanged.
- The plugin against a stand-in CLI (a shell script), driven by the system `python3`:
  payloads, returns, limits, every failure silent, nothing started by `register`.
- **Real Hermes** (`$HERMES_PYTHON`, else `~/dev/hermes-citiai/.dev/venv/bin/python`;
  skipped without it), a fresh Hermes process per case and a throwaway `HERMES_HOME` on
  disk: the built CLI installs a skill from a local source for the target `hermes` (named in
  `targets`), and
  Hermes' own `hermes skills list` and `skills_list` tool see it; the project rules above;
  the plugin loads through `plugins.enabled`, its hooks are registered, Hermes'
  `invoke_hook("on_session_start")` triggers the sync and `invoke_hook("pre_llm_call")`
  returns the report as context; `hermes skilletor status` reaches the CLI;
  `hermes plugins doctor hermes/skilletor --ci` passes. One case runs a whole turn,
  `hermes chat -q` with a local stub as the model endpoint: the user message the stub
  receives is the user's text followed by skilletor's report, and after `--resume` in a new
  process the first message is replayed with it while the new one carries nothing. No real
  model is called.

### 16.7 Decisions

Taken alone while building phase 1, put to the maintainer, and decided on 2026-10-15: item 1
changed then, items 2–9 confirmed as written.

1. **Hermes is opt-in only** (maintainer, 2026-10-15): never detected; it is a machine
   target only when the user config's `"targets"` names it (§16.2). The build first detected
   it by the files of its home, so a machine with a Hermes home in use got its user-scope
   skills there with the first sync after the upgrade.
2. **Every user-scope item goes to every machine target.** There is no way to say "this
   skill for Claude Code, not for Hermes" except a template gate on `harness` in the source,
   or a Hermes that runs under a `HOME` (and so a `~/.claude/skilletor.json`) of its own.
   For a Hermes that is a different persona than the coding agents, that may be the wrong
   default.
3. **One Hermes home per lock, moved on change** (§16.2), rather than several homes side by
   side.
4. **A project skill reaches Hermes through the Codex copy** where both are active (§16.2),
   rather than a `.hermes/skills` copy and none for Codex, or a warning and a broken name.
5. **Rules wait for a second phase** (§16.5) instead of a plugin system-prompt section that
   cuts at 4,000 characters.
6. **The per-turn hook is a process per turn** (about 0.1 s here), as under Claude Code. A
   busy gateway might want the plugin to space these calls itself.
7. **Limits of 20 s and 5 s** (Claude Code's hook file: 30 s and 10 s).
8. **A `systemMessage` without context goes to the model** (§16.4), for want of a channel to
   the user.
9. **Notes, not warnings**, for what Hermes gets no copy of (§16.3): `skilletor sync` says
   it every time, the hooks never.
