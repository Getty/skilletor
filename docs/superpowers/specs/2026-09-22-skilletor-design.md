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
| **Wildcard** | `*@source` or a pattern such as `perl-*@source` in one type's install list: every item of that type in the source whose name matches (§3) |
| **Bundle** | `bundles/<name>.yaml` in a source: a named set of that source's items plus var defaults, declared as `name@source` under `install.bundles` (§15) |
| **Type** | `skill`, `agent`, `rule` – a fixed table in code, not config-extensible |
| **Scope** | `user` (`~/.claude/`) or `project` (`<project>/.claude/`) |
| **Lock** | Per scope: what skilletor installed, with output hashes |
| **Target** | A harness installed for: `claude` or `codex` (§14) |

## 3. Config

JSON, three levels:

| File | Purpose | Installs into |
|---|---|---|
| `~/.claude/skilletor.json` | User level | `~/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.json` | Project level, committed | `<project>/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.local.json` | Machine-local overrides, not committed | Same as project |

The scope follows from which file declares an item.

**No project scope in `~`.** When the project root is the home directory itself (same real
path – a session started in `~`, or `~` a git checkout), there is no project scope:
`~/.claude/skilletor.json` is read once, as the user config. `sync`, `check` and the hooks
work on the user scope alone, `status` adds the line `project scope: none (the project
directory is the home directory)` (`projectIsHome: true` in `--json`), and the project-scope
edits (`add`/`install`/`uninstall`/`source remove` with `--project`) fail with an error.

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
- `targets` (optional, user, project or local): which agent harnesses to install for,
  `["claude"]`, `["codex"]` or both. Default: auto-detected. Merge rule in §14.
- Duplicate target names within one type and scope (`foo@shared` + `foo@team`) are a
  config error. So is the same wildcard (`*@shared` under one type) declared twice in
  one scope.
- **Wildcards:** `"*@source"` (or `"rule:*@source"`) in `install.skills|agents|rules`
  declares every item of that type in the source. It is stored as written and expanded
  at sync time against the resolved source's catalog (see 6.1), so items added upstream
  are installed on the next sync and items removed upstream are deleted via the lock
  like any undeclared item. `*` matches any run of characters (including none) anywhere
  in the name: `*@shared`, `perl-*@shared`, `*-style@shared`. A name without `*` is an
  explicit entry. A pattern that matches nothing yields a warning, not an error.
- **Bundles:** `install.bundles` lists `name@source` entries naming a bundle in that
  source (§15). A bundle is expanded at sync time like a wildcard; the items it yields
  follow the overlap rules below exactly as wildcard-yielded items do. Patterns over
  bundle names are not supported.
- **Overlap with wildcards** (per type and scope; never a config error, because an
  upstream addition must not break the whole sync):
  - an explicit entry and a wildcard yielding the same name from the same source: the
    explicit entry is used, silently;
  - an explicit entry and a wildcard yielding the same name from a different source:
    the explicit entry wins, the report carries a warning;
  - two wildcards or bundles of the same source yielding the same name (`perl-*` and
    `*-style` both matching `perl-style`): installed once, silently;
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
bundles/<name>.yaml|.yml   # optional: named item sets with var defaults (§15)
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
| `vars.*` | merged: source defaults < bundle vars (§15, bundle items only) < user < project < local |
| `project.dir`, `project.name`, `project.git_remote` | project scope only |
| `scope`, `target.dir` | `user`/`project`, target root |
| `host.name`, `host.os`, `user.name`, `user.home` | instance |
| `item.name`, `item.type`, `item.source` | the item itself |
| `harness` | `claude` or `codex`: the harness this copy is rendered for (§14) |

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
                                          # type:*@source or type:perl-*@source installs a
                                          # wildcard (type required); bundle:name@source a bundle
skilletor uninstall <item>… [--project]   # a wildcard or bundle entry is removed as written
skilletor sync | check | status           # --scope user|project|all, --json, --force
skilletor trust <source>
skilletor hook <event>                    # for hooks.json only
```

`add`/`install`/`uninstall` edit only the config (default: the user config) and then run
`sync`. The declarative config stays the single source of truth.

The project root is `--project-dir`, else the git top level of the current directory, else
the current directory – the resolution the hooks use without `CLAUDE_PROJECT_DIR` (§14.5),
so the CLI run from a subdirectory sees the same project as the session. A root that is
`~` itself has no project scope (§3).

`uninstall` removes explicit entries from that one config only: `type:name@source` from
that type's list, `name@source` from every list. All items are checked before anything
is edited; an item with no explicit entry there fails the command (exit 1, config
untouched). If a wildcard in the same config installs it, the error names the wildcard
and the ways out: uninstall `type:*@source`, or gate the item through `vars` when its
template can render empty (§5 skip). Otherwise the error says where else it is declared
(another type's list, or the other scope's config → `--project`). An item that is
removed but still covered by a wildcard in the same config is removed (exit 0) with a
warning that the wildcard brings it back on the next sync. Bundles behave the same way:
an item that only a bundle declares cannot be uninstalled by name; the error names the
bundle (§15).

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
manage-skills configuration. (The Codex target moved into scope: §14.)

## 14. Harness targets / Codex

skilletor installs for one or both of two **harnesses**: Claude Code (`claude`) and the
OpenAI Codex CLI (`codex`). Phase 1 covers detection, the per-target layout, skills for
Codex, and the Codex plugin wiring; phase 2 converts agents to Codex agent-role TOML
(§14.7); phase 3 writes rules into a managed block in `AGENTS.md` (§14.8).

### 14.1 Which harnesses: detection and `targets`

By default skilletor **auto-detects** the harnesses in use on the machine, by markers the
harness itself creates and skilletor never does (so `~/.claude/` alone does not count –
skilletor's own config lives there):

| Harness | In use when any of these exists |
|---|---|
| `claude` | `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/projects/` |
| `codex` | in `$CODEX_HOME` (default `~/.codex`): `config.toml`, `auth.json`, `sessions/`, `installation_id` |

Codex writes `installation_id` on its first run of any kind; Claude Code writes
`~/.claude.json` on its first run. The marker lists are injectable (`EngineContext.markers`)
so tests never look at the real machine.

The optional config key `targets` overrides detection. Merge rule – the simplest honest
one:

1. **Machine targets** = `targets` from the user config if set, else the detected set.
   If that is empty, `sync`, `check` and `status` fail with a config-style error that names
   the markers and tells the user to set `targets` in `~/.claude/skilletor.json`
   (nothing is touched).
2. **User scope** installs for the machine targets.
3. **Project scope** installs for the machine targets, restricted to the project's
   `targets` if one is set: `skilletor.local.json` `targets` if present, else
   `skilletor.json` `targets`, intersected with the machine targets. A project can only
   narrow, never add a harness the machine does not use. An empty intersection installs
   nothing for the project and warns once.

`targets` must be a non-empty array of known harness names without duplicates.

### 14.2 Layout per target

| Type | `claude` | `codex` |
|---|---|---|
| skill | `<base>/.claude/skills/<name>/` | `<base>/.agents/skills/<name>/` |
| agent | `<base>/.claude/agents/<name>.md` | user: `$CODEX_HOME/agents/<name>.toml` (default `~/.codex`); project: `<repo>/.codex/agents/<name>.toml` (§14.7) |
| rule | `<base>/.claude/rules/<name>.md` | a section of the managed block in `$CODEX_HOME/AGENTS.md` (user) or `<repo>/AGENTS.md` (project) (§14.8) |

`<base>` is `~` (user scope) or the project root (project scope). The user-scope Codex agent
root is the one root that need not lie under `<base>`: it follows `$CODEX_HOME`
(`EngineContext.codexHome`, injectable for tests). Codex reads user skills
from `~/.agents/skills` and project skills from `<repo>/.agents/skills`; SKILL.md files are
compatible as they are (Claude-only frontmatter keys are accepted). In code the table is
`LAYOUTS` in `targets.ts`: per harness a lock-key prefix, per supported type a function
from the scope (base, scope, Codex home) to the root directory, and the types that are
sections of a managed block rather than files (`blockTypes`, Codex rules). `apply` receives a key →
root function and knows nothing else about harnesses. The per-type output mapping (agent
Markdown → TOML, `convert.ts`) runs in the engine between render and apply.

Every item type has a Codex form, so there is no "not installed for Codex" note any more.

### 14.3 Rendering, lock, ownership

- Every item is rendered **once per target**, with `harness` in the context and
  `target.dir` set to that target's root. The empty-render skip (§5) applies per target: a
  skill gated by `{% if harness == "claude" %}` is installed for Claude and skipped for
  Codex.
- **One lock per scope**, still at `<base>/.claude/skilletor.lock.json`. Claude entries keep
  their key (`skills/foo`) so existing locks stay valid; Codex entries are keyed
  `codex:skills/foo` / `codex:agents/foo`, with file paths relative to that Codex root
  (`.agents` for skills, the Codex home or `<repo>/.codex` for agents). Ownership,
  conflicts, `--force` and drift rules (§6.3) apply per path, unchanged.
- A target that is no longer active (switched off in `targets`, or no longer detected) has
  its entries deleted like undeclared items on the next sync. Entries with a harness prefix
  this version does not know are kept untouched.
- `check` reports a change not only when a source moved but also when the lock does not
  match the active targets (an item locked for one active target but not another, or an
  entry for an inactive target), so SessionStart syncs a newly enabled harness without
  waiting for a source change.
- **Git hygiene:** besides the block in `<project>/.claude/.gitignore`, skilletor maintains
  the same kind of block in `<project>/.agents/.gitignore` and `<project>/.codex/.gitignore`
  listing the managed Codex paths under each. Such a block is created only when there are
  such paths and removed when they are gone.

### 14.4 Report and status

Claude-only output is unchanged. Codex items appear under their lock key (`codex:skills/foo`)
in the text report, and the hook context marks them `(codex)` with the activation hint
"active from the next Codex session" (not yet measured whether Codex picks up a skill
written by its own SessionStart hook in the same session). `status` lists each declared item
once per target and names the targets in the scope header when they are not just `claude`;
`status --json` carries `targets` per scope.

### 14.5 Plugin wiring for Codex

- `.codex-plugin/plugin.json` (name `skilletor`, same version as `package.json` and
  `.claude-plugin/plugin.json`, enforced by a test) points at `./skills/` and the shared
  `./hooks/hooks.json`. Codex has the same `SessionStart`/`UserPromptSubmit` events and
  hook JSON shape, and sets `CLAUDE_PLUGIN_ROOT` for plugin hook commands, so one hooks
  file serves both.
- Codex does not set `CLAUDE_PROJECT_DIR`. The hook then takes the git top level of the
  hook input's `cwd` (else `cwd` itself) as the project root, so a session started in a
  subdirectory still finds `<repo>/.claude/skilletor.json`.
- Plugin hooks run in Codex only after the user trusts them (`/hooks`). Codex cannot put a
  plugin's `bin/` on `PATH`, so the CLI is not on the model's `PATH` there.

### 14.6 Known warts (phase 1)

- Config, lock and state stay under `.claude/` (`~/.claude/skilletor.json`,
  `<repo>/.claude/skilletor.json`) for both harnesses, even on a Codex-only machine.
- `CLAUDE_CONFIG_DIR` is not honoured, neither for markers nor for the target directory.
- Detection is re-evaluated on every run: a harness that disappears (e.g. `~/.codex`
  deleted) has its installed items removed on the next sync. Pin `targets` to avoid that.
- The user-scope Codex agent root follows `$CODEX_HOME` at sync time. Changing
  `$CODEX_HOME` between syncs strands the files under the old root (the lock stores paths
  relative to the root, not the root itself).

### 14.7 Codex agents (phase 2)

A Codex agent role is a TOML file; Codex 0.153 reads `$CODEX_HOME/agents/*.toml` and, in a
**trusted** project only, `<repo>/.codex/agents/*.toml` (an untrusted project's `.codex/` is
ignored with a warning – document, don't work around). skilletor renders the Claude agent
Markdown (`agents/<name>.md[.njk]`) **for the `codex` harness** – so a template can branch on
`harness` – and converts the result:

| TOML key | From |
|---|---|
| `name` | frontmatter `name`, else the item name |
| `description` | frontmatter `description`; missing or empty → not written for Codex, one warning (Codex rejects a role without one) |
| `developer_instructions` | the body after the frontmatter, verbatim |
| any key | the optional frontmatter object `codex:`, passed through as top-level TOML keys; it overrides the keys above |

- `codex:` values may be strings, numbers, booleans, string arrays, or one level of tables
  whose values are of those kinds. Anything else (null, nested tables, mixed arrays) is
  dropped with one warning naming the key; the rest of the item is written. Values are
  not validated against Codex's schema: Codex does that at load time and ignores the whole
  role on a bad value (measured: a `nickname_candidates` entry with quotes → "may only
  contain ASCII letters, digits, spaces, hyphens, and underscores").
- Claude-only keys (`model`, `tools`, `allowed-tools`, `color`, …) are **not** carried over
  and nothing is reported for them: there is no faithful mapping, and a silent guess
  (`model: sonnet` → some Codex model) would be worse than none. Put Codex values under
  `codex:` instead, e.g. `codex: { model_reasoning_effort: high, sandbox_mode: read-only }`.
- **`briefing.skills` is not carried over either** (deviation from the phase-2 ticket, which
  asked for a `[briefing]` table). Measured on Codex 0.153.4: agent-role files are
  deserialized strictly, and any unknown key – `[briefing]` included – makes Codex ignore the
  whole role ("unknown field `briefing`"), in user and trusted-project roots alike. The
  report carries one note per run counting the Codex agents whose `briefing.skills` was
  dropped. Writing it is a one-line switch in `convert.ts` should Codex start tolerating it.
- **Empty body = skipped for Codex** (§5 per target): Codex rejects a blank
  `developer_instructions`, so an agent whose body is whitespace-only after the frontmatter
  is skipped for Codex – template or not – and a copy installed earlier is removed.
- A frontmatter that cannot be read (YAML outside the supported subset: block/flow
  sequences of scalars, nested mappings, plain/quoted/block scalars) is treated like a
  template error: warning, the Codex copy stays at its old state.
- Conversion errors never affect the Claude copy of the same item.

**TOML writing** is skilletor's own ~100-line serializer (`toml.ts`), not a dependency: the
only runtime dependency stays Nunjucks (§10), and only strings, numbers, booleans, string
arrays and one level of tables are needed. `developer_instructions` is written as a
multi-line literal string (`'''`) when it can be (no `'''`, no control characters, no CR,
no trailing `'`), else as a multi-line basic string with every `\` and `"` escaped, so no
content can close the string early. Round-trip tests parse the output with `smol-toml`
(devDependency only); Codex's own loader accepts the files (manual check via the app-server's
`configWarning`s, which name every malformed role file).

### 14.8 Codex rules (phase 3)

Codex has no rules directory; it reads `AGENTS.md`. skilletor keeps all of a scope's Codex
rules in **one managed block** of that scope's file – `$CODEX_HOME/AGENTS.md` (user, default
`~/.codex`) or `<repo>/AGENTS.md` (project):

```
<!-- skilletor:begin -->
<!-- managed by skilletor — edits inside are overwritten -->

<!-- skilletor:rule k8s source=shared -->
Applies when working with files matching: `k8s/**`, `*.yaml`.

…rule body…

<!-- skilletor:end -->
```

- **Sections:** one per rule, sorted by rule name, each opened by its marker comment
  (name and source). The body is the rule rendered **for `codex`**, frontmatter removed. A
  `paths:` frontmatter (Codex cannot load conditionally) becomes the leading "Applies when
  working with files matching: …" line; other frontmatter keys are dropped. A rule whose
  body is blank for Codex (empty render, or an empty file) is skipped for Codex. A rule
  whose body contains a skilletor marker line is not written (warning) – it would corrupt
  the block.
- **Placement:** content outside the markers is never modified. A missing file is created
  with just the block; a file without a block gets it appended after a blank line. When
  the block ends up empty it is removed, and if nothing but whitespace is left the file is
  deleted (a file skilletor created is thus removed again). Switching Codex off (§14.1)
  removes the block the same way.
- **Refusals** – warning, nothing written for Codex rules in that scope, existing lock
  entries kept, `--force` does not override:
  - malformed markers: `begin` without `end`, `end` before `begin`, either one twice;
  - `AGENTS.md` is a symlink (commonly `CLAUDE.md` ↔ `AGENTS.md`: writing through it would
    show Claude the rules twice), a directory, or unreadable;
  - `claude` is also a target of the scope and a Claude memory file is the same file as the
    `AGENTS.md` (the other direction: `CLAUDE.md` → `AGENTS.md`, or a hard link). Checked:
    `<repo>/CLAUDE.md` and `<repo>/.claude/CLAUDE.md` (project), `~/.claude/CLAUDE.md` against
    `$CODEX_HOME/AGENTS.md` (user); compared by real path (a dangling link counts by its
    target) or device + inode. With Claude not a target, the block is written.
- **Lock and ownership:** each rule keeps an entry `codex:rules/<name>` with
  `"block": true` and `files: { "AGENTS.md": <hash of its section> }`. `apply` records such
  entries (added / updated / unchanged / removed by hash) but never touches disk for them;
  the engine then rebuilds the block from the new lock. A rule kept because its source is
  unreachable keeps its section text from the file. A section edited or deleted by hand is
  restored and reported as an overwritten local change (`<file>#rules/<name>`, e.g.
  `.codex/AGENTS.md#rules/k8s`).
  `status` and `check` treat these entries like any other.
- **No gitignore:** `AGENTS.md` is typically committed and cannot be partly ignored, so the
  block is not covered by any managed `.gitignore` – a project's rules for Codex show up in
  its diff (known wart; use user-scope rules for machine-specific content).
- **Codex's reading rules (measured on 0.153.4 with `codex debug prompt-input`):** the
  global file comes first, then `--- project-doc ---`, then project files from the repo
  root down to the cwd, all inside one `# AGENTS.md instructions for <cwd>` message. An
  `AGENTS.override.md` next to an `AGENTS.md` replaces it (global and per directory) –
  skilletor still writes the block but warns that Codex will not see it. Project docs
  together are cut at `project_doc_max_bytes` (default 32768; read from the top level of
  `$CODEX_HOME/config.toml` when set there), truncating from the end – where a new block
  sits – so skilletor warns when the project `AGENTS.md` exceeds it. The global file was not
  truncated at 40 000 bytes, so the user scope has no size warning.

## 15. Bundles

A source can name a set of its own items so that a project declares one entry instead of
repeating the same list everywhere.

### 15.1 Format

One file per bundle, `bundles/<name>.yaml` (or `.yml`; both for the same name is an error
for that bundle). Parsed with skilletor's YAML-subset reader (`src/frontmatter.ts`:
mappings, block and flow sequences, plain and quoted scalars; no anchors or aliases).

```yaml
description: Everything for Perl projects
skills: [perl-*, testing]
agents: [perl-reviewer]
rules: [something, perl-*]
bundles: [base]
vars:
  perl_version: "5.40"
  kubernetes: false
```

| Key | Meaning |
|---|---|
| `description` | Shown by `skilletor available` (required) |
| `skills`, `agents`, `rules` | Item names or patterns (`*` as in §3) of that type, **from this source only** |
| `bundles` | Other bundles of this source, included recursively |
| `vars` | Var defaults for the items this bundle yields |

Every key but `description` is optional. An entry containing `@` is an error: bundles
never reach into another source, so they add no trust question.

### 15.2 Expansion

At sync time, per scope and after the source resolves (§6.1 step 3), each declared bundle
is expanded against the source's catalog: explicit names and patterns per type, then the
included bundles, depth first. The result is a set of `(type, name)` items, each carrying
the bundle chain it came through. Expansion runs on every sync, so a bundle edited
upstream takes effect on the next sync like any wildcard.

- An item reached through several bundles of the same source is installed once.
- The items a bundle yields join the overlap rules of §3 exactly like wildcard-yielded
  items: an explicit entry wins (silently for the same source, with a warning for a
  different one); the same name from two different sources is skipped with a warning and
  an installed copy stays.
- A pattern that matches nothing and a name that the catalog lacks each give one warning.
- Empty-render skip (§5), targets and per-harness output (§14) apply unchanged.

### 15.3 Vars

Merge order for an item a bundle yields:

`source defaults < bundle vars < user < project < local`

- Bundle vars apply only to the items that bundle yields; they never change another item.
- Nested bundles: along one chain the outer bundle wins over the included one (`perl`
  including `base` → `perl`'s value).
- Conflict: if one item is reached through two chains whose bundle vars set the same key to
  different values, neither applies for that key – the item gets the next level down
  (source default, if any) – and the report warns once, naming both bundles.
- Explicitly declared items do not receive bundle vars, even when a bundle also yields them.

### 15.4 Errors

These affect only the bundle concerned; other entries sync normally, and items the bundle
installed before stay installed (kept like an unresolvable source's items, §6.1):

- the bundle does not exist in the source's catalog;
- the file does not parse, carries an unknown key, lacks `description`, or has both
  `.yaml` and `.yml`;
- an entry contains `@`;
- a cycle in `bundles` (`a` → `b` → `a`); the warning names the cycle.

An unresolvable or untrusted source keeps what its bundles installed, as for wildcards.

### 15.5 CLI and status

- `skilletor install bundle:perl@shared [--project]` adds `perl@shared` to
  `install.bundles`. Without a prefix, `perl@shared` resolves to the bundle when no item
  of another type has that name; otherwise it is ambiguous and the error suggests
  `bundle:`. `uninstall bundle:perl@shared` removes the entry.
- `uninstall` of an item that only a bundle declares fails like the wildcard case (§7),
  naming the bundle and the ways out (uninstall the bundle, or gate the item through
  `vars`).
- `available` lists bundles (type `bundle`) with description and their expanded members;
  `--json` includes the members and the bundle's vars.
- `status` marks items `via bundle:perl@shared` (`via` in `--json`) and prints one line per
  bundle with the number of items it currently has installed, like wildcards.
- The lock records items only; a bundle itself has no lock entry. `check` treats a changed
  source as today, so an edited bundle file triggers a sync like any other upstream change.
