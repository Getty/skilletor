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

`checkInterval` (user file only, seconds, default 1800) throttles the in-session check;
`≤ 0` = sync only at session start. In a project file it is a config error (nothing syncs).

## Git — `gitignore`

`gitignore` (default true) writes fixed ignore rules that never change with the items.
Every installed skill dir gets its own `.gitignore` (`*`); a marked block in
`.claude/.gitignore` lists the lock, `skilletor.local.json`, `agents/**/.local.*`,
`rules/**/.local.*`, one in `.codex/.gitignore` the Codex agents and rules file. Commit
`skilletor.json` and the `.gitignore` files — the report says `.claude/.gitignore updated —
commit it` when a block is created or changed.

- Ignoring never untracks: when sync writes or adopts a file git already tracks (committed
  by hand or while `false`), a warning per item gives the `git rm --cached` that untracks it.
- User scope: blocks in `~/.claude` (lock, state dir, never `skilletor.json`) and
  `$CODEX_HOME` only inside a git work tree.
- `false` drops the blocks, the skill `.gitignore`s and the tracked-file warning; file names
  stay. The user value switches only the user scope.
