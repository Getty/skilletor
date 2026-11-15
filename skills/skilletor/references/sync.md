# Sync, check, conflicts and git

## Conflicts and `--force`

A path an item needs that the lock does not own is a conflict. It blocks the whole item:
nothing of it is written or removed, an installed copy stays as it was; other items sync.
The report line names the path and what resolves it:

| Report line | What `skilletor sync --force` does |
|---|---|
| `already exists (use --force to adopt)` | adopts the file (a file not in the lock) |
| `already exists (use --force to replace it)` | a linked skill directory or item file: replaces the link itself, never its target — nothing is written or deleted through it. The user's own `agents/<name>.md` / `rules/<name>.md` (Codex: `agents/<name>.toml`): **deletes** it, as an agent or rule still claims its plain name |
| `is not a file (move or remove it yourself; --force leaves it)` | nothing: a directory where the item has a file stays a conflict even with `--force` — move or remove it yourself |

Fixed by hand? `skilletor sync` installs the item now.

## Overlapping entries

An explicit entry beats a wildcard or bundle (warning if from another source). Wildcards
and bundles of one source that overlap install the item once; of different sources, that
name is skipped with a warning and an installed copy stays. The same wildcard twice in a
scope is a config error.

## Partial syncs

A sync that stopped midway (a write error) keeps what it wrote; `status` marks the item
`(partial: the last sync stopped midway)` and the next session resumes it.

## When a sync is due — `check`

`check` writes nothing and exits non-zero when a sync is due: a source moved, the config no
longer matches the lock, vars changed, the last sync stopped midway. What the last sync
could not install although its source was there counts once.

## What syncs on its own — the hooks

- **Claude Code:** `SessionStart` (startup, resume). `UserPromptSubmit`, the throttled check: a
  due one starts a background sync, which covers only the project the session started in, and
  its report comes with a later prompt. A move into another checkout (below): `PostToolUse`
  after a Bash `cd`, awaited; `CwdChanged` after any other move (`EnterWorktree` into an
  existing worktree, `pushd`), not awaited.
- **Codex:** `SessionStart` (startup, resume, clear), also after `/cd`, which starts a new
  session. `UserPromptSubmit`: first a move (an app-server turn with a new `cwd`), awaited,
  then the throttled check.
- **Hermes plugin:** `on_session_start`. `pre_llm_call`: first a move (`/worktree new`, the TUI
  gateway moving the session into a worktree), awaited, then the throttled check.
- A shell `cd` moves no Codex or Hermes session and syncs nothing.
- Hooks trigger a sync but never select targets: project selection is config/evidence based, so
  alternating invoking harnesses does not change it.

`checkInterval` (user file only, seconds, default 1800) throttles the check; `≤ 0` turns it
off, while session start and moves still sync. In a project file it is a config error
(nothing syncs).

### A move into another checkout

That checkout's project scope syncs when its lock does not match its config, so a worktree
made with plain `git worktree add` (committed config, none of the gitignored items) completes
itself. A move within one checkout does nothing; a worktree Claude Code created starts with the
items and the lock of the checkout it came from (`.worktreeinclude`, below). One line reports
the sync, `skilletor: N item(s) updated in <dir>`, naming the `skilletor trust <name>` /
`skilletor sync` to run there when something is left; the model's context, first line
`skilletor: in <dir>:`, lists the items, when each is active, and what is left.

- Claude Code, after a Bash `cd`: from the model's next message on, every tool call, an agent
  spawn too, finds the items there; a spawn sent in the same message as the `cd` starts in the
  old cwd. After `CwdChanged` an agent spawned right away can start before the items are
  there, and the model gets no context.
- Codex, Hermes: the turn waits for the sync. Under Hermes, when it adds or updates a skill,
  the context also names `hermes skills trust <dir>` for the user to run, even for a trusted
  checkout: skilletor does not read Hermes' trust list.

**Items missing in a checkout you moved into?** Look for skilletor's move context first. It
says what landed and when each item is active — a hand `sync` changes nothing then — or names
the command to run there. No such context (a `CwdChanged` move, a move that could not sync, no
hook ran: the CLI outside a session, Codex hooks not trusted in `/hooks`): run
`skilletor sync` in that checkout. It waits up to 5 s for a sync still running (a `CwdChanged`
one, say); on `timed out acquiring sync lock`, run it again.

## Sharing a project — `.claude/settings.json`

The installed items are gitignored build artifacts; a fresh checkout gets them only from a
skilletor that runs there. So a project sync (committed `skilletor.json`, Claude a target)
adds to the committed `.claude/settings.json`: `enabledPlugins."skilletor@<m>"` (`<m>` the
marketplace Claude Code installed skilletor from) and an `extraKnownMarketplaces` entry for
every marketplace an enabled plugin there needs. The report says
`.claude/settings.json updated (…) — commit it`; commit it with `skilletor.json`.

- Add-only: nothing is changed or removed; `"skilletor@getty": false` stays (a deleted key
  comes back — use `false`). Nothing to add: no write.
- A marketplace on a local path, or unknown to Claude Code, is not written (a warning); a
  `settings.json` that does not parse is left alone (a warning).
- `"claudeSettings": false` (project, local, or user file for every project) turns it off.
- If its proposed plugin addition would change implicit project targets, it skips only settings
  (unlike an unresolved project scope): items sync normally, and it writes neither targets nor
  provenance. Set explicit project `targets`, then sync; this intentional skip is not `check` drift.
- Standalone CLI without the plugin: no marketplace is known — merge by hand:
  `{ "extraKnownMarketplaces": { "getty": { "source": { "source": "github", "repo": "Getty/marketplace" } } }, "enabledPlugins": { "skilletor@getty": true } }`.
- Codex has no such file: Codex users install the plugin themselves.

## Git — `gitignore`

`gitignore` (default true) writes fixed ignore rules that never change with the items.
Every installed skill dir gets its own `.gitignore` (`*`); a marked block in
`.claude/.gitignore` lists the lock, `skilletor.local.json`, `agents/**/.local.*`,
`rules/**/.local.*`, one in `.codex/.gitignore` the Codex agents and rules file. Commit
`skilletor.json` and the `.gitignore` files — the report says `.claude/.gitignore updated —
commit it` when a block is created or changed.

A project's `.worktreeinclude` gets a fixed block naming every harness's installed paths, the
lock and `skilletor.local.json`: Claude Code copies the gitignored files it matches into each
worktree it creates, so agent worktrees have the installed items. A plain `git worktree add`
copies none of them; the move into it syncs it (above). Commit it as well; lines outside the
block are the user's.

- Ignoring never untracks: when sync writes or adopts a file git already tracks (committed
  by hand or while `false`), a warning per item gives the `git rm --cached` that untracks it.
- User scope: blocks in `~/.claude` (lock, state dir, never `skilletor.json`) and
  `$CODEX_HOME` only inside a git work tree.
- `false` drops the blocks, the skill `.gitignore`s and the tracked-file warning; file names
  stay. The user value switches only the user scope.
