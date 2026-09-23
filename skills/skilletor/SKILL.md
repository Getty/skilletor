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

Files skilletor owns are **build artifacts**. Every `sync` re-renders from the source and
overwrites local edits (the report names each overwritten file). To change a managed item,
edit it **in its source** and re-`sync`. Author mode: your **user** config's
`{ "sources": { "shared": { "local": "~/dev/skills" } } }` overrides the same-named `git`
source; while that checkout exists it is read directly on every sync (no fetch, no cache).

Where items land, under `~` (user scope) or the project root (project scope):

| Type | Claude Code | Codex |
|---|---|---|
| skill | `.claude/skills/<name>/` | `.agents/skills/<name>/` |
| agent | `.claude/agents/<name>.md` | `.codex/agents/<name>.toml` (user: `$CODEX_HOME/agents/`) |
| rule | `.claude/rules/<name>.md` | a section of `.codex/skilletor-rules.md` (user: `$CODEX_HOME/skilletor-rules.md`) |

`$CODEX_HOME` defaults to `~/.codex`. A file is managed when its path is in
`<scope>/.claude/skilletor.lock.json` (Codex keys `codex:skills/<name>` etc.) — check the
lock before editing; files not in it are yours. In `AGENTS.md` only the pointer block
between `<!-- skilletor:begin -->` and `<!-- skilletor:end -->` is managed.

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
skilletor trust <source>                  # confirm a project-declared source (shows the resolved URL)
```

`add`, `install`, `uninstall` only edit `skilletor.json` (the single source of truth), then
sync; `check` writes nothing, exits non-zero when a source changed. `uninstall` edits one
config; no explicit entry there → exit 1, config untouched, the error names what covers it.

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
  "install": {
    "skills": ["perl-moo@shared"], "agents": ["karr@shared"],
    "rules": ["commit-style@team"], "bundles": ["perl@shared"]
  },
  "vars": { "kubernetes": true }, "gitignore": true, "checkInterval": 1800
}
```

- Only `skill`, `agent`, `rule` are installable — never hooks, settings or MCP configs.
- `ref` (git) pins a branch, tag or commit; omit for the remote's HEAD.
- `gitignore` (project only, default true): a managed `.gitignore` block lists installed
  paths, the lock and `skilletor.local.json`. `checkInterval` (user only, seconds, default
  1800): in-session check throttle, `≤ 0` = sync only at session start. Either key in the
  wrong file is a config error: the config fails to load, nothing syncs.
- `targets` (`["claude"]`, `["codex"]` or both), unset = auto-detected. The user file sets
  the machine's set; a project or local file can only narrow it (`["claude"]` keeps a
  project's `AGENTS.md` and `.codex/` untouched). Details: [references/codex.md](references/codex.md).

### Wildcards and name patterns — `*@source`, `perl-*@source`

`"rules": ["*@shared"]` (or `"rule:*@shared"`) declares every rule the source offers; `*`
matches anywhere in the name (`"skills": ["perl-*@shared"]`, `"rule:*-style@shared"`).
Re-expanded on every sync. A pattern matching nothing warns; a bare `*` stays silent.

- Explicit entry beats a wildcard (warning if from another source). Wildcards/bundles of
  one source overlapping → installed once; of different sources → that name is skipped
  with a warning. Same wildcard twice in a scope → config error. Source unresolvable
  (offline, untrusted, broken) → everything it installed stays.
- An item installed by a wildcard or bundle can't be uninstalled by name: uninstall
  `type:*@source` / `bundle:name@source`, or gate the item via vars (empty render → skipped).

## Bundles — `install.bundles`

A source's `bundles/<name>.yaml` (or `.yml`) names a set of items; a config declares it
once. `description` is required; lists take names, patterns and `name@<address>` items of
other sources. Quote a leading `*` (unquoted in a block list it is a YAML parse error).
Full reference: [references/bundles.md](references/bundles.md).

```yaml
description: Everything for Perl projects
skills: [perl-*, testing, karr@gitlab.com/peter]
rules: ["*-style"]
bundles: [base]                    # another bundle of this source, bare name
vars: { perl_version: "5.40" }
```

- Vars: `source defaults < bundle < user < project < local`; outer bundle wins over an
  included one; explicit entries get no bundle vars.
- Another source is matched by resolved URL, not config name. `install bundle:` offers to
  add a missing one (no TTY: exit 1, prints `skilletor add …`); **`sync` and hooks never
  add sources** — they warn and skip those items.

## Templates

A source file ending in `.njk` is rendered with Nunjucks and installed with the `.njk`
stripped; every other file is copied byte for byte. Context: `vars.*` (source defaults <
bundle < user < project < local), `project.*` (project scope), `scope`, `harness`
(`claude`/`codex`, rendered once per target), `target.dir`, `host.*`, `user.*`, `item.*`;
deliberately no `env.*`. Printing an undefined variable (`{{ vars.x }}`) is an error;
testing one (`{% if vars.x %}`) is just false.

**Empty render = item off.** If the main file (`SKILL.md.njk`, `<name>.md.njk`) renders
to whitespace once a leading frontmatter block is stripped, the item is skipped in that
scope and target: nothing written, an installed copy removed, no error. A main file
without `.njk` is never skipped. Report `· rules/k8s skipped (renders empty)`. Pattern:

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
User-scope items see only user vars. `{% if harness == "claude" %}` gates to one harness.

## Trust

`skilletor add` (or your own user config) trusts a source. One declared **only** in a
project config (a cloned repo) is not fetched until `skilletor trust <name>`; a changed URL
lapses trust. Trust means code execution — the same level as installing a plugin.
