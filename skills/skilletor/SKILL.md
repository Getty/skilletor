---
name: skilletor
description: "skilletor CLI — installs and updates skills, agents and rules from remote sources for Claude Code. Use when adding a source, installing/uninstalling a skill/agent/rule from a source, editing a skilletor.json, running sync/check/status, asking 'where does this skill come from' or 'why did this file change', or before editing a file skilletor manages."
---

# skilletor — remote skills, agents and rules

skilletor installs **skills, agents and rules** from configured sources and keeps them
up to date. Sources are added like marketplaces; items are declared in `skilletor.json`
and synced onto disk. The command is on the Bash tool's `PATH` when the plugin is
installed.

## Do not hand-edit a managed file — change it in the source

Installed files under `~/.claude/{skills,agents,rules}/` and
`<project>/.claude/{skills,agents,rules}/` that skilletor owns are **build artifacts**.
Every `sync` re-renders from the source and overwrites local edits (the report names each
overwritten file). To change a managed item, edit it **in its source**:

- **Author mode** — if you maintain the source, point a `local` field at your checkout
  (see below), edit there, and the next `sync` picks it up. Push with git so other
  machines pull it.
- Otherwise edit the upstream source and re-`sync`.

A file is skilletor-managed when its path appears in `<scope>/.claude/skilletor.lock.json`
(and, in a project, in the managed block of `.claude/.gitignore`). Files **not** in the
lock are yours and are never touched. So: check the lock before editing a `.claude` file
under skills/agents/rules.

## Commands

```bash
skilletor add [name] <spec> [--project]   # add a source (resolves shorthand, trusts it), then sync
skilletor source list | source remove <name> [--force]
skilletor available [source]              # catalog of trusted sources: type, name, description, installed?
skilletor install <item>... [--project]   # name@source (type:name@source if ambiguous), then sync
skilletor uninstall <item>...
skilletor sync | check | status           # --scope user|project|all, --json, --force, --project-dir <dir>
skilletor trust <source>                  # confirm a project-declared source (shows the resolved URL)
```

`add`, `install` and `uninstall` only edit the config and then sync — the declarative
`skilletor.json` is the single source of truth. `check` writes nothing and exits non-zero
when a source has changed.

## Config

`skilletor.json` lives at three levels; the scope is set by which file declares an item:

| File | Scope | Installs into |
|---|---|---|
| `~/.claude/skilletor.json` | user | `~/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.json` | project (committed) | `<project>/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.local.json` | machine-local (not committed) | as project |

```json
{
  "sources": {
    "shared": { "git": "https://github.com/Getty/skills", "ref": "main" },
    "team":   { "url": "https://skills.example.com/skills.tar.gz" },
    "mine":   { "local": "~/dev/my-skills" }
  },
  "install": {
    "skills": ["perl-moo@shared"],
    "agents": ["karr@shared"],
    "rules":  ["commit-style@team"]
  },
  "vars": { "kubernetes": true },
  "gitignore": true,
  "checkInterval": 600
}
```

- Only `skill`, `agent`, `rule` are installable — skilletor never syncs hooks,
  `settings.json` or MCP configs.
- `ref` (git) pins a branch, tag or commit; omit for the remote's HEAD.
- `gitignore` (project only, default true): keep a managed block listing the installed
  paths, the lock and `skilletor.local.json`, so only `skilletor.json` is committed.
- `checkInterval` (user only, seconds): throttle for the in-session check.

## Author mode (local override)

The project config declares a source with `git`; the author's **user** config overrides
the same-named source with `local`:

```json
{ "sources": { "shared": { "local": "~/dev/skills" } } }
```

When that directory exists, skilletor reads it directly (no fetch, no cache) and renders
on every sync — edits in the checkout land immediately.

## Templates

A source file ending in `.njk` is rendered with Nunjucks and installed with the `.njk`
stripped; every other file is copied byte for byte. Context: `vars.*` (source defaults <
user < project < local), `project.*` (project scope), `scope`, `target.dir`, `host.*`,
`user.*`, `item.*`. There is deliberately no `env.*`. An undefined variable is an error.

## Trust

Adding a source with `skilletor add` (or your own user config) trusts it. A source that
appears **only** in a project config (a cloned repo) is not fetched until you run
`skilletor trust <name>`; if the project later changes the URL, trust lapses. Trust means
code execution — the same level as installing a plugin.
