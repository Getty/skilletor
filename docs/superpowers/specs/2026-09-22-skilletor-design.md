# skilletor – Design

Date: 2026-09-22 · Status: draft for review

## 1. Goal

skilletor is a Claude Code plugin plus a standalone CLI that installs and keeps
**skills, agents and rules** up to date from configured remote sources:

- it reconciles at session start, re-checks at a throttled rate during the session,
  pulls anything new immediately, and reports it to the model;
- what gets installed is declared by the user or project config;
- items can be templates rendered with instance/project variables;
- sources are added like plugin marketplaces (`skilletor add shared Getty`), and items
  are installed from them (`skilletor install perl-moo@shared`).

skilletor lives in its own repo, is distributed via `Getty/marketplace`, and is the
preferred successor to manage-skills (which stays around).

The name plays on Skeletor; "skills" is the hook, agents and rules are further item
types under the same roof.

## 2. Terms

| Term | Meaning |
|---|---|
| **Source** | A named source: git repo, HTTPS tarball, or local directory |
| **Item** | An installable thing from a source, addressed as `name@source` |
| **Wildcard** | `*@source` in one type's install list: every item of that type in the source |
| **Type** | `skill`, `agent`, `rule` – a fixed table in code, not config-extensible |
| **Scope** | `user` (`~/.claude/`) or `project` (`<project>/.claude/`) |
| **Lock** | Per scope: what skilletor installed, with output hashes |

## 3. Config

JSON, three levels:

| File | Purpose | Installs into |
|---|---|---|
| `~/.claude/skilletor.json` | User level | `~/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.json` | Project level, committed | `<project>/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.local.json` | Machine-local overrides, not committed | Same as project |

The scope follows from which file declares an item.

```json
{
  "sources": {
    "shared": { "git": "https://github.com/Getty/skills", "ref": "main" },
    "team":   { "url": "https://skills.example.com/skills.tar.gz" },
    "mine":   { "local": "~/dev/my-skills" }
  },
  "install": {
    "skills": ["perl-moo@shared", "container-kubernetes@shared"],
    "agents": ["karr@shared"],
    "rules":  ["commit-style@team", "*@shared"]
  },
  "vars": { "kubernetes": true, "k8s_namespace": "prod" },
  "gitignore": true,
  "checkInterval": 600
}
```

- `ref` is optional (default: the remote's HEAD); a tag or commit pins it.
- `gitignore` (project only, default `true`): see 6.4.
- `checkInterval` (user only, seconds, default 1800 = 30 min): throttle for the
  in-session check. `0` or a negative value disables it (SessionStart still syncs).
- Duplicate target names within one type and scope (`foo@shared` + `foo@team`) are a
  config error. So is the same wildcard (`*@shared` under one type) declared twice in
  one scope.
- **Wildcards:** `"*@source"` (or `"rule:*@source"`) in `install.skills|agents|rules`
  declares every item of that type in the source. It is stored as written and expanded
  at sync time against the resolved source's catalog (see 6.1), so items added upstream
  are installed on the next sync and items removed upstream are deleted via the lock
  like any undeclared item. `*` is only valid as the whole name.
- **Overlap with wildcards** (per type and scope; never a config error, because an
  upstream addition must not break the whole sync):
  - an explicit entry and a wildcard yielding the same name from the same source: the
    explicit entry is used, silently;
  - an explicit entry and a wildcard yielding the same name from a different source:
    the explicit entry wins, the report carries a warning;
  - two wildcards (different sources) yielding the same name: that name is skipped with
    a warning (an already installed copy stays as it is); all other items proceed.

**Merging sources:** user sources are usable in project configs. Same name: fields from
the user or local config merge *over* the project definition.

**Author mode:** if a source has a `local` field and the directory exists, it is read
directly from there (no fetch, no cache); otherwise `git`/`url` applies. Typical setup:
the project config defines `shared` via `git`, and the author's user config adds
`"shared": { "local": "~/dev/skills" }`. You edit in the checkout and push via git; all
projects on the machine pull it in on the next check. There are no hardlinks – installed
files are build artifacts.

## 4. Sources

### 4.1 Source layout (convention, no manifest required)

```
skills/<name>/SKILL.md[.njk] + any accompanying files
agents/<name>.md[.njk]
rules/<name>.md[.njk]
snippets/…                 # for includes only, not installable
skilletor.json             # optional: { "description": "…", "vars": { defaults } }
```

The catalog (`skilletor available`) is built by scanning this layout; name and
description come from the items' frontmatter. The same scan expands a wildcard
(`*@source`, §3) at sync time: every catalog item of the wildcard's type is declared.

### 4.2 Shorthand resolution for `skilletor add [name] <spec>`

Resolution happens **once, at add time**; the config always stores the explicit form.
Hooks never guess or probe.

| `<spec>` | resolves to |
|---|---|
| `/path`, `./path`, `~/path` | `local` |
| `https://…`, `git@…`, `ssh://…` | unchanged; `.tar.gz`/`.tgz` → `url`, otherwise `git` |
| `Getty` (single word) | `git: https://github.com/Getty/skills` |
| `Getty/repo` (first segment has no dot) | `git: https://github.com/Getty/repo` |
| `github:Getty/repo` | as above (manage-skills compatibility) |
| `github.com/u`, `gitlab.com/u`, `codeberg.org/u`, `hf.co/u`, `huggingface.co/u` | `git: https://<host>/u/skills` |
| the same hosts with `u/repo` | `git: https://<host>/u/repo` |
| `host.tld` or `host.tld/` | `https://host.tld/skills` – probe below |
| `host.tld/path` | `https://host.tld/path` – probe below |

**Probe for generic hosts:** first `git ls-remote <url>`; if that does not respond,
`HEAD <url>.tar.gz`. The first hit decides `git` vs. `url`; no hit → error listing both
attempted addresses.

If `[name]` is omitted, it is derived (owner or hostname, lowercased). The default repo
name is `skills` everywhere.

### 4.3 Trust

- Sources the user adds themselves (`skilletor add`, their own user config) are trusted
  – `add` is the act of trust.
- Sources that only appear in a project config (a cloned repo) are **not** pulled
  automatically. The hook reports "project wants source X (<url>) – `skilletor trust X`".
  The confirmation (name + resolved URL) lives in `~/.claude/skilletor/trust.json`; if
  the project changes the URL, it lapses.
- Trust means code execution: Nunjucks is not a sandbox. This is the same trust level as
  installing a plugin, and the README says so.

### 4.4 Fetch and check

| Kind | `resolve` | `check` (cheap) |
|---|---|---|
| `git` | Shallow clone/fetch into the cache; auth = the user's git setup | `git ls-remote <url> <ref>` vs. cached commit |
| `url` | HTTPS-only, `.tar.gz`, conditional GET with ETag | `HEAD` + ETag comparison |
| `local` | read directly | not applicable – always re-rendered |

## 5. Templating

- **Opt-in by extension:** `X.njk` is rendered by Nunjucks and installed as `X`.
  Everything else is copied byte for byte (skills with their own `{{ }}`/`{% %}` stay
  intact).
- Autoescape off (Markdown). Undefined variables are an error (`throwOnUndefined`), so
  typos do not silently produce empty skills.
- Includes/imports/macros resolve relative to the root of their source and may not
  leave it.

**Context:**

| Variable | Contents |
|---|---|
| `vars.*` | merged: source defaults < user < project < local |
| `project.dir`, `project.name`, `project.git_remote` | project scope only |
| `scope`, `target.dir` | `user`/`project`, target root |
| `host.name`, `host.os`, `user.name`, `user.home` | instance |
| `item.name`, `item.type`, `item.source` | the item itself |

Deliberately excluded: `env.*` (otherwise secrets end up in files) and the git branch
(would re-render on every switch).

**Empty render = not applicable:** if an item's main file is a template – `SKILL.md.njk`
for a skill, `<name>.md.njk` for an agent or rule – and its rendered output is
whitespace-only once a leading YAML frontmatter block (`---` … `---`, optionally after
leading whitespace) is removed, the item does not apply to this scope. So a rule whose
`paths:` frontmatter survives but whose body is fully gated by `{% if vars.x %}` counts
as empty. Such an item is skipped as a whole: nothing is written (for a skill, none of
its other files either), an installed copy is removed via the lock, and the report lists
it as skipped – neither an error nor a warning. A main file that is not a template is
never treated this way, even if it is empty. A render error stays an error (§6.6). Vars
can therefore switch individual items on and off per user, project or local config.

## 6. Engine

### 6.1 `sync` pipeline (per scope, user before project)

1. Load, merge, validate config.
2. Resolve sources (in parallel) → local directory + version per source.
3. Expand wildcards against each resolved source's catalog (overlap rules in §3), then
   **build each declared item in memory** (render or copy). An item whose main template
   renders empty (§5) is marked skipped instead; its installed files are removed in step 4.
4. Compare output against disk and lock; write only differences (atomically:
   temp file + rename); remove files the item no longer contains.
5. Delete items no longer declared, per the lock.
6. Write the lock and (in a project) the gitignore block, emit the report.

**Unresolvable sources keep their items:** when a source cannot be resolved or scanned
(offline without cache, untrusted, broken layout), every locked item it provided stays
untouched – for explicit entries and for everything previously installed through a
wildcard over that source alike. Deletion only follows from a successful resolve.

**Render-and-compare:** there is no invalidation logic. Every run renders everything and
diffs the output; changed variables, snippets, and local checkout edits take effect
automatically as a result.

### 6.2 Lock

`~/.claude/skilletor.lock.json` or `<project>/.claude/skilletor.lock.json`:

```json
{ "skills/perl-moo": {
    "source": "shared", "version": "git:ab12cd3",
    "files": { "SKILL.md": "sha256:…", "reference.md": "sha256:…" } },
  "rules/k8s": {
    "source": "shared", "version": "git:ab12cd3", "files": {}, "skipped": "renders-empty" } }
```

An item that rendered empty (§5) keeps a lock entry with no files and
`"skipped": "renders-empty"`. It owns no path, so a file someone else put at its target
is left alone (no conflict, `--force` irrelevant). The entry lets `status` report the
skip without rendering (status stays offline and read-only), and it is kept like any
other entry while its source cannot be resolved.

### 6.3 Ownership and coexistence with your own files

- If a target path exists that is **not** in the lock (a hand-written skill, a
  manage-skills link), it is never overwritten → conflict in the report; `--force`
  adopts it.
- The user's own skills/agents/rules sit untouched next to the managed ones.
- If a managed file diverges from the lock hash (edited locally), the source wins; the
  report names the overwritten file.
- Only what is in the lock is ever deleted.

### 6.4 Git hygiene in a project

With `"gitignore": true` (default) skilletor maintains a marked block in
`<project>/.claude/.gitignore` with the **exact** managed paths, the lock, and
`skilletor.local.json`. Only `skilletor.json` is committed; your own skills alongside it
stay version-controlled as usual. With `"gitignore": false` the block is removed and
everything is committable (teammates without the plugin get the files via clone) –
sensible only for items without machine-specific variables.

### 6.5 State

`~/.claude/skilletor/`: `cache/` (deletable), `trust.json`, `last-check.json`,
`pending-report.json`, `sync.lock/` (mkdir mutex with a stale timeout against parallel
sessions). `CLAUDE_PLUGIN_DATA` is not used, so the CLI runs identically without Claude
Code.

### 6.6 Error behavior

A sync error never aborts a session. Fetch error/offline → continue with the cache, one
warning line. Template error → that item stays at its old state, error with file and
line. Config error → nothing is touched, clear message.

## 7. CLI

```
skilletor add [name] <spec> [--project]   # add a source (= source add), resolves shorthand
skilletor source list | remove <name>
skilletor available [source]              # catalog: type, name, description, installed?
skilletor install <item>… [--project]     # name@source, or type:name@source when ambiguous;
                                          # type:*@source installs a wildcard (type required)
skilletor uninstall <item>… [--project]   # type:*@source removes the wildcard entry
skilletor sync | check | status           # --scope user|project|all, --json, --force
skilletor trust <source>
skilletor hook <event>                    # for hooks.json only
```

`add`/`install`/`uninstall` edit only the config (default: the user config) and then run
`sync`. The declarative config stays the single source of truth.

`status` shows a declared item that rendered empty at the last sync as skipped
(`skipped: "renders-empty"` in `--json`, `installed: false`), distinct from an item that
is not installed yet. It marks items that were declared through a wildcard (`via *@shared`, and a `via`
field in `--json`) and lists each wildcard with the number of items it currently has
installed.

## 8. Hooks and messages

| Event | Behavior |
|---|---|
| `SessionStart` (`startup`, `resume`) | synchronous: `check` all sources in parallel (5 s network timeout per source), `sync` on change |
| `UserPromptSubmit` | not due → return immediately. Due → start a detached background `sync`, return at once. If a `pending-report.json` exists → emit it as `additionalContext` and delete it |

- With no change, the plugin is silent.
- With a change: one `systemMessage` line for the user, a terse `additionalContext` for
  the model, per item with an activation hint per the spike (section 12): `skill` →
  "active now"; `agent` and `rule` → "active after `/reload-plugins` or restart". The
  `SessionStart` hook thus makes freshly pulled skills usable immediately, while freshly
  pulled agents/rules become active only in the next session or after `/reload-plugins`
  – the report states this per item.
- Warnings (untrusted source, overwritten change, conflict, template error, offline) run
  as a single line over the same channel.
- The plugin also puts the CLI on the Bash tool's `PATH` and ships a `skilletor` skill
  that explains the config format and CLI to the model.

## 9. Security

- A fixed type table with fixed target directories; hooks, `settings.json`, and MCP
  configs are never synchronized.
- Path hardening: item names, tar entries, and includes may not leave the source or
  target root; symlinks in sources are rejected; `url` is HTTPS-only.
- Trust model per 4.3; no `env.*` in the context; pinning via `ref`.

## 10. Repo, build, distribution

```
.claude-plugin/plugin.json      hooks/hooks.json
bin/skilletor                   # shim → node dist/skilletor.js, checks Node ≥ 18 with a clear message
dist/skilletor.js               # esbuild bundle incl. Nunjucks, committed
skills/skilletor/SKILL.md
src/cli.ts                      # arguments, dispatch
src/config.ts                   # load/merge/validate + edit operations
src/spec.ts                     # shorthand resolution (4.2), injectable probe
src/sources/{git,url,local}.ts  # resolve(), check()
src/catalog.ts                  # scan source → items
src/render.ts                   # build item in memory
src/apply.ts                    # diff, write atomically, clean up, gitignore block
src/lock.ts  src/state.ts       # lock; trust, last-check, pending-report, mutex
src/hooks.ts  src/report.ts
test/
```

Boundaries: `sources/*` knows nothing about templating, `render` nothing about the
target filesystem, `apply` nothing about sources. TypeScript, the only runtime
dependency is Nunjucks (bundled); user requirements: `node ≥ 18`, `git`. Its own repo
`Getty/skilletor`, an entry in `Getty/marketplace`; develop locally with
`claude --plugin-dir .`.

## 11. Tests

TDD with `node:test`. Unit tests per module against temp directories; `spec.ts` as a
table test over all shorthand rows; git sources against local bare repos (`file://`),
URL sources against a local HTTP server with ETag; hooks as a black box (stdin JSON →
stdout JSON). End-to-end: fixture source → `sync` → verify the tree + lock, then a second
round with a changed source or changed variables. Security cases: traversal, symlink,
untrusted source, foreign target path. CI checks that `dist/` matches the source.

## 12. Spike – result

Run on 2026-09-22 against real Claude Code (CLI, Opus 4.8), together with the user in a
live session. Test artifacts (skill/agent/rule) were written with unique sentinels and
removed again afterward.

**Methodology note:** "was the rule loaded?" was measured by whether the harness actually
**injected the rule content into the model context as a `system-reminder`** – not by
whether the model "knows" the marker string (which was in the self-authored file).
Otherwise the spike would be measuring itself.

| # | Test | No reload (mid-session) | After `/reload-plugins` |
|---|---|---|---|
| 1 | New skill (`~/.claude/skills/` **and** project `.claude/skills/`) | **usable immediately** – the Skill tool resolves the fresh SKILL.md (sentinel confirmed), and the skill listing in the `system-reminder` updates within the same turn | n/a |
| 2 | New agent file (`~/.claude/agents/`) | **not spawnable** – `Agent type … not found` | **spawnable** – registration takes effect from the **next prompt after** the reload (still `not found` in the reload turn itself) |
| 3a | New rule without `paths` (user scope) | **not injected** | **injected** – from the next prompt after the reload; unconditionally active |
| 3b | New rule with `paths` (project scope) | not injected | **loaded, but conditional** – injected only when a file matching the glob is in the active context |
| 4 | Skill the `SessionStart` hook writes itself | **visible in the same session** – follows necessarily from Test 1: a skill written *mid-session* is usable immediately, so one written at session start is all the more so (not separately verified, a fortiori) | n/a |

**Core finding:** skills are fully dynamic (no reload, usable at once). Agents and rules
are cached at session start / at the last `/reload-plugins`; an agent/rule file written
mid-session does **not** take effect on its own, only after `/reload-plugins` (or
restart), and then from the **next** prompt.

**Activation hints derived for §8:**

| Item type | Hint |
|---|---|
| `skill` | "active now" |
| `agent` | "active after `/reload-plugins` or restart" |
| `rule`  | "active after `/reload-plugins` or restart" (paths rules additionally only when a matching file is in context) |

Practical consequence for the plugin: the `SessionStart` hook that pulls new items makes
**skills usable immediately**; newly pulled **agents/rules** are not loaded in the *same*
session (the hook writes them only after the start scan already ran) and become active in
the **next** session or after `/reload-plugins`. The report must state this honestly per
item.

## 13. Non-goals (for now)

Monitor-based timer instead of a prompt hook · checksum pins for tarballs · aliases
(`as`) for items · further types (`commands`, `output-styles`) · automatic import of a
manage-skills configuration · Codex target.
