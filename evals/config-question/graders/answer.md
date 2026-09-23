---
type: llm
focus: last_message
weight: 2
---

PASS only if the answer (1) puts the install entry in the project file
`.claude/skilletor.json` (or the machine-local `.claude/skilletor.local.json`, or says to
run `skilletor install go-lint@platform --project`), (2) writes the entry as
`go-lint@platform` under `install.skills`, and (3) sets `checkInterval` to `0` in the
**user** config `~/.claude/skilletor.json`, explaining that the session-start sync still
happens.

FAIL if it names a command, flag, file or config key that is not in the list below, puts
`checkInterval` in a project file (skilletor rejects it there as user-only), or suggests
editing installed files under `.claude/skills` directly. Anything on the list is real —
never fail an answer for using it.

- Commands: `sync`, `check`, `status`, `add [name] <spec>`, `source list`,
  `source remove <name>`, `available [source]`, `install <item>...`,
  `uninstall <item>...`, `trust <source>`, `--help`/`-h`, `--version`/`-v`.
- Flags: `--project` (add, install, uninstall, source remove);
  `--scope user|project|all` (sync, check, status); `--json`; `--force`;
  `--project-dir <dir>`.
- Files: `~/.claude/skilletor.json` (user), `.claude/skilletor.json` (project),
  `.claude/skilletor.local.json` (machine-local project), `skilletor.lock.json` per scope.
- Top-level config keys: `sources` (each with `git`, `ref`, `url` or `local`), `install`
  (`skills`, `agents`, `rules`), `vars`, `gitignore`, `checkInterval`.
