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

### The in-session check (and how to quiet it)

skilletor always reconciles at **session start**. During a session it also
re-checks your sources in the background, throttled by `checkInterval` (user
config, seconds, **default 1800 = 30 min**). If that's too chatty for you:

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
`env.*`, and an undefined variable is an error (so a typo can't ship an empty skill).

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

With `"gitignore": true` (default) skilletor keeps a marked block in
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
skilletor source list | source remove <name> [--project] [--force]
skilletor available [source]              # catalog of trusted sources; --json
skilletor install <item>... [--project]   # name@source (type:name@source if ambiguous), then sync
skilletor uninstall <item>... [--project]
skilletor sync | check | status           # --scope user|project|all, --json, --force, --project-dir <dir>
skilletor trust <source>
```

`check` writes nothing and exits non-zero when a source has changed.

## Requirements

- Node.js ≥ 18 and `git`. The only bundled runtime dependency is Nunjucks.

## License

MIT.
