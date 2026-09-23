# skilletor

![skilletor](assets/github.png)

> **MYAAH! Your skills are mine… to sync.**

Remote skills, agents and rules for Claude Code — declared once, synced on every
session, templated per project.

skilletor is a Claude Code plugin plus a standalone CLI. It installs **skills, agents and
rules** from configured sources and keeps them up to date: it reconciles at session
start, re-checks (throttled) during the session, pulls anything new, and tells the model
what changed. It is the preferred successor to
[manage-skills](https://github.com/Getty/manage-skills) (which stays around).

## 30-second start

```bash
/plugin marketplace add Getty/marketplace
/plugin install skilletor@getty
skilletor add shared Getty && skilletor install perl-moo@shared
```

`add` registers (and trusts) a source; `install` declares an item and syncs it onto disk.

## How it works

```
source (git | https tarball | local dir)
        │  resolve + scan
        ▼
   render (.njk → Nunjucks, everything else copied)
        │  diff against disk + lock
        ▼
   ~/.claude/{skills,agents,rules}   ·   <project>/.claude/{skills,agents,rules}
```

- **SessionStart** — check every source (5s timeout each); on a change, sync and report.
- **UserPromptSubmit** — when the throttle is due, kick off a detached background sync and
  deliver its result on a later prompt; otherwise return instantly and silent.

Skills become usable immediately; agents and rules activate after `/reload-plugins` or a
restart — the report says so per item.

## Sources

A source is a git repo, an HTTPS `.tar.gz`, or a local directory. `skilletor add`
resolves a shorthand once and stores the explicit form:

| `<spec>` | resolves to |
|---|---|
| `Getty` | `git: https://github.com/Getty/skills` |
| `Getty/repo` | `git: https://github.com/Getty/repo` |
| `hf.co/user` | `git: https://hf.co/user/skills` |
| `gitlab.com/u/r` | `git: https://gitlab.com/u/r` |
| `host.tld/` | `https://host.tld/skills` (probed: git, then `.tar.gz`) |
| `https://…/x.tar.gz` | `url` (HTTPS tarball) |
| `~/dev/skills`, `./path`, `/abs` | `local` |

A source's layout (convention, no manifest):

```
skills/<name>/SKILL.md[.njk] + companion files
agents/<name>.md[.njk]
rules/<name>.md[.njk]
snippets/…                 # includes only, not installable
skilletor.json             # optional: { "description": "…", "vars": { defaults } }
```

## Declaring what you want

`skilletor.json` at three levels; the scope follows from which file declares an item:

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
  "checkInterval": 1800
}
```

Only `skill`, `agent` and `rule` are installable — skilletor never syncs hooks,
`settings.json` or MCP configs.

`skilletor uninstall` removes explicit entries from one config — the user config, or the
project config with `--project`. `rule:k8s@shared` removes only from `rules`;
`k8s@shared` removes from every list. Every item is checked before anything is edited:
an item with no explicit entry in that config fails the command (exit 1, config
untouched), and the error names where it comes from instead — a wildcard, another
type's list, or the other scope's config.

### Wildcards: everything of one type from a source

`"*@source"` in an install list declares every item of that type the source offers:

```json
{ "install": { "rules": ["*@shared"] } }
```

`"rule:*@shared"` is the same with an explicit type; `*` is only valid as the whole name.
On the command line the type prefix is required, and the argument must be quoted so the
shell does not glob it:

```bash
skilletor install 'rule:*@shared' [--project]
skilletor uninstall 'rule:*@shared' [--project]
```

A wildcard is expanded against the source on every sync, so items added upstream arrive
on the next sync and items removed upstream are deleted. When names overlap (per type and
scope) nothing fails:

- an explicit entry and a wildcard over the **same** source name the same item → the
  explicit entry is used, silently;
- an explicit entry and **another** source's wildcard → the explicit entry wins, the
  report warns;
- two wildcards offer the same name → that one name is skipped with a warning (an
  installed copy stays as it is); every other item proceeds.

An item installed through a wildcard cannot be uninstalled by name — the wildcard would
bring it back. Uninstall the wildcard (`skilletor uninstall 'rule:*@shared'`), or keep it
and switch the item off via vars ([empty render = skipped](#switching-items-on-and-off-with-vars)).
Uninstalling an explicit entry that a wildcard also covers works, with a warning that the
item returns on the next sync.

Declaring the same wildcard twice in one scope is a config error. If a source cannot be
resolved (offline without cache, untrusted, broken layout), everything it installed —
explicitly or through a wildcard — stays in place; deletion only follows a successful
resolve. `skilletor status` marks such items `via *@shared` and adds one line per
wildcard, e.g. `* rules/* @shared (3 installed)`.

### The in-session check (and how to quiet it)

skilletor always reconciles at **session start**. During a session it also
re-checks your sources in the background, throttled by `checkInterval` (user
config only — in a project or local file it is a config error that stops skilletor
loading its config; seconds, **default 1800 = 30 min**). If that's too chatty for you:

```json
{ "checkInterval": 0 }   // turn the in-session check off entirely
```

With `0` (or any value ≤ 0) skilletor only syncs at session start — no
background fetching while you work. Raise the number instead to check less often
(e.g. `3600` for hourly).

## Templates

A source file ending in `.njk` is rendered with Nunjucks and installed with `.njk`
stripped; everything else is copied byte for byte, so skills that use `{{ }}`/`{% %}`
themselves stay intact.

```njk
{% if vars.kubernetes %}
Use the {{ project.name }} cluster in namespace {{ vars.k8s_namespace }}.
{% endif %}
```

Context: `vars.*` (source defaults < user < project < local), `project.*` (project
scope), `scope`, `target.dir`, `host.*`, `user.*`, `item.*`. There is deliberately no
`env.*`, and printing an undefined variable (`{{ vars.x }}`) is an error (so a typo can't
ship an empty skill). Testing one (`{% if vars.x %}`) is not: it is simply false.

### Switching items on and off with vars

If an item's main file is a template — `SKILL.md.njk` for a skill, `<name>.md.njk` for
an agent or rule — and it renders to nothing but whitespace (a leading frontmatter block
does not count), the item does not apply in that scope. It is skipped as a whole: nothing
is written (for a skill, none of its other files either), an already installed copy is
removed, and it is neither an error nor a warning. A main file that is not a template is
never skipped, even if empty. The sync report says `· rules/k8s skipped (renders empty)`,
or `- rules/k8s (removed: renders empty)` when a copy was deleted; `status` shows
`(skipped: renders empty)`.

That makes a source of small, gated rules — one per concern — switchable per config:

```njk
---
paths: ["**/*.yaml"]
---
{% if vars.kubernetes %}
Use kubectl --context {{ vars.k8s_context }}.
{% endif %}
```

Install the whole set once with `"rules": ["*@shared"]` and turn individual rules on with
`"vars": { "kubernetes": true }` in the user, project or local config. `k8s_context`
is printed inside the gate, so it needs a default in the source's `skilletor.json`.
Vars follow the item's scope: a user-scope item sees only user vars (plus source
defaults); project and local vars switch items installed in project scope.

## Authoring mode

Maintaining a source? Override the same-named source with a `local` checkout in your
**user** config:

```json
{ "sources": { "shared": { "local": "~/dev/skills" } } }
```

skilletor then reads that directory directly and re-renders on every sync — edits land
immediately. Push with git and every machine pulls them on the next check. Installed
files are build artifacts; there are no hardlinks.

## Git & your own skills

With `"gitignore": true` (default; project config only — in the user config it is a
config error that stops skilletor loading its config) skilletor keeps a marked block in
`<project>/.claude/.gitignore` listing the exact managed paths, the lock and
`skilletor.local.json`. Only `skilletor.json` is committed; your own hand-written skills
beside the managed ones stay version-controlled and are never touched. Set
`"gitignore": false` to commit everything instead (useful only for items without
machine-specific variables).

A file is skilletor-managed exactly when it appears in
`<scope>/.claude/skilletor.lock.json`. Managed files are overwritten on the next sync —
change them in the source, not in place.

## Security & trust

**Trust means code execution** — Nunjucks is not a sandbox, so a source can run code when
rendered. This is the same trust level as installing a plugin.

- Adding a source with `skilletor add` (or your own user config) trusts it.
- A source that appears **only** in a project config (a cloned repo) is never fetched
  until you run `skilletor trust <name>`; if the project later changes the URL, trust
  lapses.
- Fixed target directories; item names, tar entries and includes may not escape the
  source or target root; symlinks in sources are rejected; `url` is HTTPS-only.

## Coming from manage-skills

manage-skills hardlinks a single source-of-truth file into each project. skilletor
installs **build artifacts** (rendered per instance) from remote sources and keeps them
current automatically. Use skilletor when you want templated, auto-updating items from a
shared remote; manage-skills remains for hardlinked local sharing.

## CLI reference

```
skilletor add [name] <spec> [--project]   # add a source (resolves shorthand, trusts it), then sync
skilletor source list [--json] | source remove <name> [--project] [--force]   # --force: even with installed items
skilletor available [source] [--json]     # catalog of trusted sources
skilletor install <item>... [--project]   # name@source (type:name@source if ambiguous), then sync
skilletor install 'rule:*@shared' [--project]   # wildcard: every rule of the source (type prefix required)
skilletor uninstall <item>... [--project] # [type:]name@source (no type: every list); 'rule:*@shared' the wildcard
skilletor sync | check | status           # --scope user|project|all, --json, --project-dir <dir>
skilletor sync --force                    # overwrite and adopt unmanaged files reported as conflicts
skilletor trust <source>
```

`check` writes nothing and exits non-zero when a source has changed.

## Requirements

- Node.js ≥ 18 and `git`. The only bundled runtime dependency is Nunjucks.

## License

MIT.
