---
name: skilletor
description: "skilletor CLI — installs and updates skills, agents and rules from remote sources for Claude Code and Codex. Use when adding a source, installing/uninstalling a skill/agent/rule, all of a type or a name pattern (`*@source`, `perl-*@source`) from a source, writing or installing a bundle (`bundles/<name>.yaml`, `bundle:name@source`, `install.bundles`), switching an item on/off per project via vars, editing a skilletor.json or its `targets`, running sync/check/status, asking 'where does this skill come from' or 'why did this file change', or before editing a file skilletor manages (including skilletor-rules.md and the skilletor pointer block in AGENTS.md)."
---

# skilletor — remote skills, agents and rules for Claude Code and Codex

## Running the CLI

- **Claude Code:** `skilletor` is on the Bash tool's `PATH`.
- **Codex:** the plugin's `bin/` is **not** on `PATH` — a bare `skilletor` fails. Run
  `<plugin root>/bin/skilletor`; the plugin root is two directories above this SKILL.md,
  whose path Codex listed with the skill (`…/skilletor/<version>/skills/skilletor/SKILL.md`
  → `…/skilletor/<version>/bin/skilletor`). Take `<version>` from that listed path, never
  from memory — it changes on every plugin update. Codex runs skilletor's hooks only once
  trusted in `/hooks` (again after an update changes them); until then `sync` by hand.

## Do not hand-edit a managed file — change it in the source

Files skilletor owns are **build artifacts**: every `sync` re-renders them from the source
and overwrites local edits (the report names each). Edit the item **in its source** and
re-`sync`. Author mode: `"shared": { "local": "~/dev/skills" }` in your **user** config
overrides the same-named `git` source, read directly on every sync while that checkout exists.

| Type (under `~` or the project root) | Claude Code | Codex (`$CODEX_HOME` defaults to `~/.codex`) |
|---|---|---|
| skill | `.claude/skills/<name>/` | `.agents/skills/<name>/` |
| agent | `.claude/agents/.local.<name>.md` | `.codex/agents/.local.<name>.toml` (user: `$CODEX_HOME/agents/`) |
| rule | `.claude/rules/.local.<name>.md` | a section of `.codex/skilletor-rules.md` (user: `$CODEX_HOME/skilletor-rules.md`) |

A file is managed when its path is in `<scope>/.claude/skilletor.lock.json` (Codex keys
`codex:skills/<name>` etc.) — check the lock before editing; files not in it are yours. In
`AGENTS.md` only the block between `<!-- skilletor:begin -->` and `<!-- skilletor:end -->`
is managed. A conflict blocks the whole item, and `sync --force` can **delete** the user's
own files: read [references/sync.md](references/sync.md) before forcing, and when a report
shows a conflict, a partial item, an overlap or `git rm --cached` warning, or a due `check`.

## Commands

```bash
skilletor add [name] <spec> [--project]   # add a source (resolves shorthand, trusts it), then sync
skilletor source list [--json] | source remove <name> [--project] [--force]   # --force: even with installed items
skilletor available [source] [--json]     # catalog of trusted sources: type, name, description, installed?
skilletor install <item>... [--project]   # name@source (type:name@source if ambiguous), bundle:name@source
skilletor install 'rule:*@shared' 'skill:perl-*@shared'   # wildcard/pattern: type prefix required, quote it
skilletor uninstall <item>... [--project] # [type:]name@source (no type: every list); wildcards, bundle: as written
skilletor sync | check | status           # --scope user|project|all, --json, --project-dir <dir>
skilletor sync --force                    # overwrite and adopt unmanaged files reported as conflicts
skilletor trust <source>                  # confirm a project-declared source (shows the backend it trusts)
```

`add`, `install`, `uninstall`, `source remove` edit one `skilletor.json`, then sync; a
config error there → exit 2, the edit stays saved. `uninstall` or `source remove` of an
entry or source that config does not declare → exit 1, config untouched even with `--force`;
the error names what covers it or where else the source is declared. `check` writes nothing;
non-zero = a sync is due. An option the command does not take → exit 2, nothing runs
(`--project-dir` goes with all); `-h` anywhere only prints usage, `-v` only as first argument.

`add` without a name takes the repo's for a git repo other than `skills` (`Getty/karr`,
`https://github.com/Getty/karr.git` → `karr`), else the owner's (`Getty` → `getty`), the
host's or the directory's. A GitHub tree link (`github.com/o/r/tree/<ref>`) adds the repo
pinned to `<ref>`; a file or subdirectory link is refused. `add` never replaces a source:
the same address again keeps the entry as written (`ref`, `local` stay) and syncs. Exit 1,
nothing changed or trusted, when config load refuses that entry (a hand-written `"ref": ""`:
fix it by hand), when a tree link pins a ref the entry lacks (no `ref` or another: set it by
hand, use another name, or remove the source), or when the name has another address (pass
a name, or `source remove <name>` first).

Sources use `skills/<name>/`, `agents/<name>.md`, `rules/<name>.md`. Claude plugin repos
work too, the skills their `.claude-plugin/plugin.json` lists installed as `skills/<name>/`:
`skilletor add obra/superpowers`, `skilletor add anthropics` (→ anthropics/skills). A repo's
own `.claude/skills/<name>/`, `.claude/agents/<name>.md[.njk]` and `.claude/rules/<name>.md[.njk]`
install like published ones (`skilletor add Getty/karr`), read last, best effort: a name
found above wins; a symlink and skilletor's installed copies (`.local.` files, a skill
carrying skilletor's `.gitignore`) are skipped.

## Config

The declaring file sets the scope: `~/.claude/skilletor.json` (user, installs under `~`),
`<project>/.claude/skilletor.json` (project, committed), `<project>/.claude/skilletor.local.json`
(machine-local, not committed; installs like project).

```json
{
  "sources": {
    "shared": { "git": "https://github.com/Getty/skills", "ref": "main" },
    "team":   { "url": "https://skills.example.com/skills.tar.gz" },
    "mine":   { "local": "~/dev/my-skills" }
  },
  "install": { "skills": ["perl-moo@shared"], "agents": ["karr@shared"],
               "rules": ["commit-style@team"], "bundles": ["perl@shared"] },
  "vars": { "kubernetes": true }, "gitignore": true, "checkInterval": 1800
}
```

- Only `skill`, `agent`, `rule` are installable — never hooks, settings or MCP configs.
- A source name (its key) is ASCII letters, digits, `.`, `_`, `-`, starting with a letter or
  digit; `git`/`local` are non-empty strings; `url` is `https://`; `ref` (git) is a plain
  branch, tag or commit name (no leading `-`, whitespace, `~ ^ : ? * [ \`, `..`, `@{`) —
  omit it, never `""`, for the remote's HEAD. Anything else is a config error; `add` refuses
  such a name or address (an `http://…`/`file://…` tarball too) before writing: exit 1.
- `gitignore` (default true: commit `skilletor.json` and each `.gitignore` the report names)
  and `checkInterval` (user file only): [references/sync.md](references/sync.md).
- `targets` (`["claude"]`, `["codex"]` or both; unset = auto-detected): the user file sets
  the machine's set, a project or local file only narrows it (`["claude"]` keeps a project's
  `AGENTS.md` and `.codex/` untouched). Details: [references/codex.md](references/codex.md).

### Wildcards and name patterns — `*@source`, `perl-*@source`

`"rules": ["*@shared"]` (or `"rule:*@shared"`) declares every rule the source offers; `*`
matches anywhere in the name (`"skills": ["perl-*@shared"]`, `"rule:*-style@shared"`),
re-expanded on every sync. A pattern matching nothing warns; a bare `*` stays silent. An
explicit entry beats a wildcard (warning if from another source). A source that can't be
resolved (offline, untrusted, broken) keeps everything it installed.

An item installed by a wildcard or bundle can't be uninstalled by name: uninstall
`type:*@source` / `bundle:name@source`, or gate the item via vars (empty render → skipped).

## Bundles — `install.bundles`

A source's `bundles/<name>.yaml` (or `.yml`) names a set of items; a config declares it
once. Read [references/bundles.md](references/bundles.md) before writing one, and on a
bundle error or a `briefing skills not installed` warning.

- Vars: `source defaults < bundle < user < project < local`; outer bundle wins over an
  included one; explicit entries get no bundle vars.
- A bundle can name items of other sources (`name@<address>`), matched by resolved URL, not
  config name. `install bundle:` offers to add a missing one (no TTY: exit 1, prints
  `skilletor add …`); **`sync` and hooks never add sources** — they warn and skip those items.
- Put an agent and the skills its `briefing.skills` names in one bundle: they must be
  installed where its harness looks (a user agent never sees project skills).

## Templates

A source file ending in `.njk` is rendered with Nunjucks (installed with `.njk` stripped);
every other file is copied byte for byte, a skill's executable bit included (a `.njk` passes
its own on). `f` beside `f.njk` in one item (`SKILL.md[.njk]`, `scripts/x.sh[.njk]`,
`agents/x.md[.njk]`) is an error of that item: `available` shows it, `install` refuses it,
`sync` warns and keeps an installed copy. A `.njk` main file that renders empty (after its
frontmatter) switches the item off in that scope and target, installed copy removed. A
`{% if %}` in frontmatter opens with `{%-`, or its blank line silently truncates a
`briefing:` block. Read [references/templates.md](references/templates.md) before writing or
debugging a template (context variables, undefined `vars.*`, the on/off pattern).

## Trust

`skilletor add` (or your own user config or `skilletor.local.json`) trusts a source. A
backend from a cloned repo's committed `skilletor.json` — a source only it declares, or a
`local`/`git`/`url` it adds to one of yours that ends up used — is neither fetched nor
rendered until `skilletor trust <name>`, which trusts exactly the backend in use; a changed
address or a switch of that backend (a `local` dir appearing or vanishing) lapses it. A
project never changes what your user-scope items are built from. Trust means code
execution, the same level as installing a plugin.
