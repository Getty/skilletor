---
name: skilletor
description: "skilletor CLI — installs and updates skills, agents and rules from remote sources for Claude Code and Codex. Use when adding a source, installing/uninstalling a skill/agent/rule or all of a type (`*@source` wildcard) from a source, switching an item on/off per project via vars, editing a skilletor.json or its `targets`, running sync/check/status, asking 'where does this skill come from' or 'why did this file change', or before editing a file skilletor manages (including the skilletor block in AGENTS.md)."
---

# skilletor — remote skills, agents and rules

skilletor installs **skills, agents and rules** from configured sources for Claude Code
and/or Codex: sources are added like marketplaces, items declared in `skilletor.json`.

## Running the CLI

- **Claude Code:** `skilletor` is on the Bash tool's `PATH`.
- **Codex:** the plugin's `bin/` is **not** on `PATH` — a bare `skilletor` fails. Run
  `<plugin root>/bin/skilletor`; the plugin root is two directories above this SKILL.md,
  whose path Codex listed with the skill (`…/skilletor/<version>/skills/skilletor/SKILL.md`
  → `…/skilletor/<version>/bin/skilletor`). Take `<version>` from that listed path, never
  from memory — it changes on every plugin update. Codex runs skilletor's session hooks
  only after the user trusts them in `/hooks`; until then run `sync` by hand.

## Do not hand-edit a managed file — change it in the source

Files skilletor owns are **build artifacts**. Every `sync` re-renders from the source and
overwrites local edits (the report names each overwritten file). To change a managed item,
edit it **in its source**: if you maintain the source, point a `local` field at your
checkout (author mode, below) and re-`sync`; otherwise edit upstream and re-`sync`.

Where items land, under `~` (user scope) or the project root (project scope):

| Type | Claude Code | Codex |
|---|---|---|
| skill | `.claude/skills/<name>/` | `.agents/skills/<name>/` |
| agent | `.claude/agents/<name>.md` | `.codex/agents/<name>.toml` (user: `$CODEX_HOME/agents/`) |
| rule | `.claude/rules/<name>.md` | a section of the skilletor block in `AGENTS.md` (user: `$CODEX_HOME/AGENTS.md`) |

`$CODEX_HOME` defaults to `~/.codex`. A file is managed when its path appears in
`<scope>/.claude/skilletor.lock.json` (Codex entries keyed `codex:skills/<name>` etc.) —
check the lock before editing. Files not in the lock are yours and never touched. In
`AGENTS.md` only the text between `<!-- skilletor:begin -->` and `<!-- skilletor:end -->`
is managed; everything outside is yours.

## Commands

```bash
skilletor add [name] <spec> [--project]   # add a source (resolves shorthand, trusts it), then sync
skilletor source list [--json] | source remove <name> [--project] [--force]   # --force: even with installed items
skilletor available [source] [--json]     # catalog of trusted sources: type, name, description, installed?
skilletor install <item>... [--project]   # name@source (type:name@source if ambiguous), then sync
skilletor install 'rule:*@shared' [--project]   # wildcard: type prefix required, quote against shell globbing
skilletor uninstall <item>... [--project] # [type:]name@source (no type: every list); 'rule:*@shared' the wildcard
skilletor sync | check | status           # --scope user|project|all, --json, --project-dir <dir>
skilletor sync --force                    # overwrite and adopt unmanaged files reported as conflicts
skilletor trust <source>                  # confirm a project-declared source (shows the resolved URL)
```

`add`, `install` and `uninstall` only edit `skilletor.json` (the single source of truth),
then sync. `check` writes nothing, exits non-zero when a source changed. `uninstall` edits
one config: `type:name@src` removes from that list, `name@src` from all; no explicit entry
there → exit 1, config untouched, the error names the covering wildcard, type or scope.

## Config

`skilletor.json` lives at three levels; the scope is set by which file declares an item:

| File | Scope | Installs under |
|---|---|---|
| `~/.claude/skilletor.json` | user | `~` |
| `<project>/.claude/skilletor.json` | project (committed) | project root |
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
  "checkInterval": 1800
}
```

- Only `skill`, `agent`, `rule` are installable — never hooks, settings or MCP configs.
- `ref` (git) pins a branch, tag or commit; omit for the remote's HEAD.
- `gitignore` (project only, default true): keep a managed block listing the installed
  paths, the lock and `skilletor.local.json`, so only `skilletor.json` is committed.
  In the user file it is a config error — the config fails to load and nothing syncs.
- `checkInterval` (user only, seconds, default 1800 = 30 min): throttle for the
  in-session background check. `0` (or ≤ 0) turns it off — skilletor then only syncs at
  session start. In a project or local file it is a config error, not ignored — the
  config fails to load and nothing syncs.
- `targets` (`["claude"]`, `["codex"]` or both): which harnesses to install for. Unset =
  auto-detected. In the user file it sets the machine's set; a project or local file can
  only narrow it — `"targets": ["claude"]` keeps a project's `AGENTS.md` untouched.
  Detection, agent conversion and the `AGENTS.md` block: [references/codex.md](references/codex.md).

### Wildcards — `*@source`

`"rules": ["*@shared"]` (or `"rule:*@shared"`) declares every rule the source offers (same
under `skills`/`agents`; `*` only as the whole name), re-expanded on every sync.

- Explicit entry beats a wildcard (warning if from another source); two wildcards offering
  one name → that name is skipped with a warning. Same wildcard twice in a scope → config error.
- Source unresolvable (offline, untrusted, broken) → everything it installed stays.
- A wildcard-installed item can't be uninstalled by name: uninstall `type:*@source`, or
  gate the item via vars (empty render → skipped).

## Author mode (local override)

The author's **user** config overrides a same-named `git` source with `local` —
`{ "sources": { "shared": { "local": "~/dev/skills" } } }`. When that directory exists it is
read directly (no fetch, no cache) on every sync — checkout edits land immediately.

## Templates

A source file ending in `.njk` is rendered with Nunjucks and installed with the `.njk`
stripped; every other file is copied byte for byte. Context: `vars.*` (source defaults <
user < project < local), `project.*` (project scope), `scope`, `harness` (`claude` or
`codex` — each item is rendered once per target), `target.dir`, `host.*`, `user.*`,
`item.*`. There is deliberately no `env.*`. Printing an undefined variable
(`{{ vars.x }}`) is an error; testing one (`{% if vars.x %}`) is just false.

**Empty render = item off.** If the main file (`SKILL.md.njk`, `<name>.md.njk`) renders
to whitespace once a leading frontmatter block is stripped, the item is skipped in that
scope (and target): nothing written, an installed copy removed, no error. A main file
without `.njk` is never skipped. Report: `· rules/k8s skipped (renders empty)`; status:
`(skipped: renders empty)`. Pattern — one rule per concern, body gated:

```njk
---
paths: ["**/*.yaml"]
---
{% if vars.kubernetes %}
Use kubectl --context {{ vars.k8s_context }}.
{% endif %}
```

Install the set with `"rules": ["*@shared"]`, switch each with `"vars": { "kubernetes": true }`;
a var printed inside the gate (`k8s_context`) needs a default in the source's `skilletor.json`.
A user-scope item sees only user vars (+ source defaults); project and local `vars` switch
project-scope items. `{% if harness == "claude" %}` gates an item to one harness.

## Trust

`skilletor add` (or your own user config) trusts a source. One declared **only** in a
project config (a cloned repo) is not fetched until `skilletor trust <name>`; a changed URL
lapses trust. Trust means code execution — the same level as installing a plugin.
