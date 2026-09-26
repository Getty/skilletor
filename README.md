# skilletor

![skilletor](assets/github.png)

> **MYAAH! Your skills are mine… to sync.**

Remote skills, agents and rules for Claude Code and Codex — declared once, synced on
every session, templated per project.

skilletor is a Claude Code and Codex plugin plus a standalone CLI. It installs **skills,
agents and rules** from configured sources and keeps them up to date: it reconciles at session
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
Using Codex? See [Codex](#codex) — the plugin works there too, with a few differences.

## How it works

```
source (git | https tarball | local dir)
        │  resolve + scan
        ▼
   render (.njk → Nunjucks, everything else copied)
        │  diff against disk + lock
        ▼
   ~/.claude/{skills,agents,rules}   ·   <project>/.claude/{skills,agents,rules}
   ~/.agents/skills, $CODEX_HOME/{agents,skilletor-rules.md}   ·   <project>/{.agents/skills,.codex/{agents,skilletor-rules.md}}
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
bundles/<name>.yaml        # optional: named sets of items (see Bundles)
snippets/…                 # includes only, not installable
skilletor.json             # optional: { "description": "…", "vars": { defaults } }
```

Claude plugin repos work too: paths listed in `.claude-plugin/plugin.json` `skills` (a
skill directory, or a directory of them) are added to those under `skills/<name>/` and install as
`skills/<name>/` wherever they sit. For example:

```bash
skilletor add anthropics          # → anthropics/skills
skilletor add obra/superpowers
skilletor add mattpocock          # → mattpocock/skills, skills listed in its plugin.json
```

## Declaring what you want

`skilletor.json` at three levels; the scope follows from which file declares an item:

| File | Scope | Installs into (Claude Code; Codex: see [Codex](#codex)) |
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
    "rules":  ["commit-style@team"],
    "bundles": ["perl@shared"]
  },
  "vars": { "kubernetes": true },
  "gitignore": true,
  "checkInterval": 1800
}
```

Only `skill`, `agent` and `rule` are installable — skilletor never syncs hooks,
`settings.json` or MCP configs. An optional `"targets"` key picks the harnesses to install
for (`claude`, `codex`) — see [Codex](#codex).

`skilletor uninstall` removes explicit entries from one config — the user config, or the
project config with `--project`. `rule:k8s@shared` removes only from `rules`;
`k8s@shared` removes from every list. Every item is checked before anything is edited:
an item with no explicit entry in that config fails the command (exit 1, config
untouched), and the error names where it comes from instead — a wildcard, a bundle,
another type's list, or the other scope's config.

### Wildcards and name patterns

`"*@source"` in an install list declares every item of that type the source offers; `*`
may stand anywhere in the name, so a pattern picks the matching ones:

```json
{ "install": { "rules": ["*@shared"], "skills": ["perl-*@shared"] } }
```

`"rule:*@shared"` is the same with an explicit type (`"rule:*-style@shared"` for a
pattern). On the command line the type prefix is required, and the argument must be
quoted so the shell does not glob it:

```bash
skilletor install 'rule:*@shared' 'skill:perl-*@shared' [--project]
skilletor uninstall 'rule:*@shared' [--project]
```

A wildcard is expanded against the source on every sync, so items added upstream arrive
on the next sync and items removed upstream are deleted. A pattern that matches nothing
warns (`skill wildcard zzz-*@shared matches nothing in source shared`); a bare `*` stays
silent, since a source without rules is normal. When names overlap (per type and scope)
nothing fails:

- an explicit entry and a wildcard over the **same** source name the same item → the
  explicit entry is used, silently;
- an explicit entry and **another** source's wildcard → the explicit entry wins, the
  report warns;
- two wildcards or bundles of the **same** source yield the same name (`perl-*` and
  `*-style` both match `perl-style`) → installed once, silently;
- wildcards or bundles of **different** sources offer the same name → that one name is
  skipped with a warning (an installed copy stays as it is); every other item proceeds.

An item installed through a wildcard cannot be uninstalled by name — the wildcard would
bring it back. Uninstall the wildcard (`skilletor uninstall 'rule:*@shared'`), or keep it
and switch the item off via vars ([empty render = skipped](#switching-items-on-and-off-with-vars)).
Uninstalling an explicit entry that a wildcard also covers works, with a warning that the
item returns on the next sync.

Declaring the same wildcard twice in one scope is a config error. If a source cannot be
resolved (offline without cache, untrusted, broken layout), everything it installed —
explicitly or through a wildcard — stays in place; deletion only follows a successful
resolve. `skilletor status` marks such items `via *@shared` (or `via perl-*@shared`) and
adds one line per wildcard, e.g. `* rules/* @shared (3 installed)`.

### Bundles: a named set from a source

A source can name a set of items in `bundles/<name>.yaml` (or `.yml` — not both), so a
project declares one entry instead of repeating a list:

```yaml
# bundles/perl.yaml in github.com/Getty/skills
description: Everything for Perl projects
skills:
  - "perl-*"                   # quote a leading * in a block list
  - testing
  - karr@gitlab.com/peter      # an item of another source, by address
agents: [perl-reviewer]
rules: ["*-style"]
bundles: [base]                # another bundle of this source, included
vars:
  perl_version: "5.40"
```

`description` is required; `skills`, `agents`, `rules` take names and patterns (bare =
this source); `bundles` takes bare names of this source's bundles, nested recursively
(a cycle is an error); `vars` sets defaults for the items this bundle yields. Any other
key is an error. The YAML is skilletor's own subset: no anchors, aliases or tags — which
is why an unquoted `- *-style` fails to parse and must be written `- "*-style"`.

```bash
skilletor install bundle:perl@shared [--project]     # adds "perl@shared" to install.bundles
skilletor uninstall bundle:perl@shared [--project]
```

`perl@shared` without the prefix works too when no skill, agent or rule of `shared` is
called `perl`; otherwise the command fails as ambiguous and names both forms
(`skill:perl@shared, bundle:perl@shared`). Bundles are expanded on every sync, like
wildcards, and their items follow the same overlap rules. A name the source lacks or a
pattern that matches nothing warns; a broken bundle (missing, unparseable, cycle, bad
address) affects only itself, and what it installed before stays.

**Vars.** For an item a bundle yields: `source defaults < bundle vars < user < project <
local`. Bundle vars reach only that bundle's items. Along a chain the outer bundle wins
(`perl` over the `base` it includes). If one item is reached through two chains that set
a key differently, neither value applies — the item falls back to the source default and
the report warns, naming both bundles. An item you declare explicitly gets no bundle vars,
even when a bundle yields it too.

**Items of other sources.** `name@<spec>` (patterns too: `perl-*@gitlab.com/peter`) names
an item of another source by its address, so a bundle means the same on every machine.
`<spec>` is the `skilletor add` shorthand, limited to forms that need no network probe:
`Getty`, `Getty/repo`, `gitlab.com/peter`, `hf.co/user`, full `https://…` URLs. A generic
host must be written as a full `https://` URL, and local paths are not allowed. The entry
is served by whichever configured source has the same resolved `git`/`url` — its config
name does not matter, and a `local` override of it (authoring mode) still applies.

If that source is missing:

- `skilletor install bundle:perl@shared` on a terminal asks per missing source —
  `bundle perl needs a source you don't have yet: gitlab.com/peter →
  https://gitlab.com/peter/skills — add it as [peter]? (name, or n to skip)` — and adds it
  like `skilletor add` (which trusts it) to the config the bundle goes into.
- Without a terminal the command changes nothing, exits 1 and prints the commands to run:
  `skilletor add peter gitlab.com/peter --project`.
- `sync` and the hooks **never** add a source — a trusted source must not pull in an
  untrusted one, since rendering runs code. They warn once per missing source and bundle
  (`bundle perl@shared needs gitlab.com/peter (https://gitlab.com/peter/skills): run
  skilletor install bundle:perl@shared`), skip those items and keep installed copies.

**Seeing and removing.** `skilletor available` lists each bundle (type `bundle`) with its
description and expanded members; `--json` adds `members` and `vars`. `skilletor status`
marks items `via bundle:perl@shared` and adds `* bundle:perl@shared (7 installed)`. An item
only a bundle declares cannot be uninstalled by name: the error names the bundle — uninstall
the bundle, or switch the item off via vars.

**Agents and their briefing skills.** An agent that declares skills for the briefing plugin
(`briefing: { skills: [...] }`) fails at spawn time when they are missing. After every sync
skilletor checks each installed agent, per target, against the skill roots that agent's
harness searches (Claude: `~/.claude/skills`, plus the project's `.claude/skills` for a
project agent, plus Claude plugin caches; Codex: `$CODEX_HOME/skills`, `~/.agents/skills`,
plus the project's `.agents/skills` and `.codex/skills`) and warns:
`agent reviewer (codex): briefing skills not installed: perl-core`. `plugin:skill` names
are not checked. `status` shows the same per agent (`briefingMissing` in `--json`); the
`SessionStart` hook mentions it only when it changed something. Ship an agent and its
skills together in one bundle so they are always installed as a set.

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

Context: `vars.*` (source defaults < [bundle vars](#bundles-a-named-set-from-a-source) < user < project < local), `project.*` (project
scope), `scope`, `harness` (`claude` or `codex`), `target.dir`, `host.*`, `user.*`,
`item.*`. There is deliberately no `env.*`, and printing an undefined variable (`{{ vars.x }}`) is an error (so a typo can't
ship an empty skill). Testing one (`{% if vars.x %}`) is not: it is simply false.

Tags are not whitespace-trimmed, so a `{% if %}` on its own line leaves a blank line. In
frontmatter that matters: briefing stops reading a `briefing:` list at the first blank
line. Use `{%- if … %}` / `{%- endif %}` there (left side only – `-%}` would also eat the
next line break and glue the list items together).

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

Installed items sit next to your own skills, agents and rules, and a fixed set of ignore
rules keeps them out of commits:

- **Skills** keep their name (`.claude/skills/perl-moo/`); each installed skill directory
  gets its own `.gitignore` containing `*`.
- **Agents and rules** are installed as `.claude/agents/.local.<name>.md` and
  `.claude/rules/.local.<name>.md` (Codex agents: `.codex/agents/.local.<name>.toml`). The
  agent keeps the name from its frontmatter; the prefix follows Claude Code's convention
  for files that are not committed (`CLAUDE.local.md`, `settings.local.json`).
- **`<project>/.claude/.gitignore`** holds a marked block that never changes:

  ```gitignore
  # >>> skilletor >>>
  agents/**/.local.*
  rules/**/.local.*
  skilletor.local.json
  skilletor.lock.json
  # <<< skilletor <<<
  ```

  `<project>/.codex/.gitignore` gets the same kind of block for Codex agents and the rules
  file.

Commit `skilletor.json` and the `.gitignore` files; the report asks you to once, when sync
creates or changes a block. Your own hand-written skills, agents and rules stay
version-controlled and are never touched — only don't name your own files `.local.*` in
`agents/` or `rules/`, that prefix is skilletor's. A hand-written `agents/foo.md` next to an
installed agent `foo` is reported as a conflict (two agents would share the name);
`--force` replaces it with the installed one. Set `"gitignore": false` in the project
config to commit everything instead (useful only for items without machine-specific
variables); the file names stay the same.

Keep `~` or `~/.claude` in a dotfiles repository? `~/.claude` and `$CODEX_HOME` get the
same fixed block when they lie inside a git work tree; the `~/.claude` block also lists
the state directory `skilletor/`, never `skilletor.json`. A root outside a work tree gets
no block. `"gitignore": false` in `~/.claude/skilletor.json` removes the user blocks; it
does not affect projects.

A file is skilletor-managed exactly when it appears in
`<scope>/.claude/skilletor.lock.json`. Managed files are overwritten on the next sync —
change them in the source, not in place.

## Codex

skilletor installs for Claude Code, the OpenAI Codex CLI, or both — from the same sources
and the same `skilletor.json`. Config, lock and state stay under `.claude/` for both
harnesses, even on a Codex-only machine.

### Which harnesses: detection and `targets`

Without a `targets` key skilletor installs for every harness it finds, by files the
harness itself creates (never `~/.claude/` alone — skilletor's own config lives there):

| Harness | In use when any of these exists |
|---|---|
| `claude` | `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/projects/` |
| `codex` | in `$CODEX_HOME` (default `~/.codex`): `config.toml`, `auth.json`, `sessions/`, `installation_id` |

`"targets": ["claude"]`, `["codex"]` or `["claude", "codex"]` overrides detection:

1. **Machine targets** = the user config's `targets` if set, else the detected set. If that
   is empty, `sync`, `check` and `status` stop with a config error naming the markers,
   and nothing is touched — set `targets` in `~/.claude/skilletor.json`.
2. **User scope** installs for the machine targets.
3. **Project scope** installs for the machine targets, narrowed by the project's `targets`
   (`skilletor.local.json` if it has one, else `skilletor.json`). A project can only
   narrow, never add a harness the machine does not use; an empty intersection installs
   nothing for the project and warns.

Detection runs on every sync, so a harness that disappears (say `~/.codex` is deleted) has
its items removed on the next sync — pin `targets` if that is not what you want. Items of
a harness that is switched off are removed the same way.

### Where items go

`<base>` is `~` for user scope and the project root for project scope.

| Type | Claude Code | Codex |
|---|---|---|
| skill | `<base>/.claude/skills/<name>/` | `<base>/.agents/skills/<name>/` |
| agent | `<base>/.claude/agents/.local.<name>.md` | user: `$CODEX_HOME/agents/.local.<name>.toml`; project: `<project>/.codex/agents/.local.<name>.toml` |
| rule | `<base>/.claude/rules/.local.<name>.md` | a section of `$CODEX_HOME/skilletor-rules.md` (user) or `<project>/.codex/skilletor-rules.md` (project), delivered by the `SessionStart` hook |

Every item is rendered once per target, with `harness` (`claude` or `codex`) in the
template context, so a source can branch on it. Gating a whole item works like any other
[empty render](#switching-items-on-and-off-with-vars): a skill whose `SKILL.md.njk` is
wrapped in `{% if harness == "claude" %}` is installed for Claude Code and skipped for
Codex. Skills are copied as they are — Codex accepts Claude's SKILL.md format.

The lock stays one file per scope (`<base>/.claude/skilletor.lock.json`); Codex entries
are keyed `codex:skills/<name>`, `codex:agents/<name>`, `codex:rules/<name>`, and the sync
report and `status` list them under those keys. Codex items are active from the next Codex
session.

Codex reads project agents from `<project>/.codex/agents/` only in a project it
**trusts**; in an untrusted project it ignores `.codex/` with a warning.

### Agents: the `codex:` block

A Codex agent role is a TOML file. skilletor renders the agent's Markdown for `codex` and
converts it: `name` and `description` come from the frontmatter, the body becomes
`developer_instructions`. Codex-specific settings go under an optional `codex:` mapping,
passed through as top-level TOML keys (they override the three above):

```markdown
---
name: reviewer
description: Reviews diffs for correctness and style.
model: sonnet
tools: Read, Grep
codex:
  model_reasoning_effort: high
  sandbox_mode: read-only
---
You review code. …
```

becomes

```toml
name = "reviewer"
description = "Reviews diffs for correctness and style."
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = '''
You review code. …
'''
```

- **Claude-only keys are not carried over** — `model`, `tools`, `allowed-tools`, `color`
  and any other key outside `codex:` — and nothing is reported for them. There is no
  faithful mapping (`model: sonnet` means nothing to Codex); put Codex values under `codex:`.
- `codex:` values may be strings, numbers, booleans, string arrays, or one level of tables
  of those. Anything else is dropped with a warning naming the key. skilletor does not
  check the values against Codex's schema — Codex ignores the whole role on a bad value.
- **`briefing.skills` becomes a comment line**, `# briefing: skills = ["a", "b"]`, directly
  before `developer_instructions` — the form the briefing plugin (0.3.1+) reads for Codex.
  Codex reads agent-role files strictly and ignores the whole role over any unknown key, so
  a `[briefing]` table is not an option: a `briefing` key under `codex:` is an error, and so
  is a skill name that is empty or contains `"`, `\`, `]` or a line break (the Codex copy
  stays as it was; the Claude copy is written).
- An agent without a `description` is not written for Codex (warning) — Codex rejects
  such a role. An agent whose body is empty is skipped for Codex.

### Rules: the rules file, the hook and a pointer in `AGENTS.md`

Codex has no rules directory, and `AGENTS.md` is usually committed, cannot be partly
ignored and is cut at `project_doc_max_bytes` — so no rule text goes there. skilletor
writes all of a scope's Codex rules into one **rules file**, and its `SessionStart` hook
hands that file to Codex:

| Scope | Rules file | Pointer block in |
|---|---|---|
| user | `$CODEX_HOME/skilletor-rules.md` | `$CODEX_HOME/AGENTS.md` |
| project | `<project>/.codex/skilletor-rules.md` | `<project>/AGENTS.md` |

```markdown
<!-- skilletor:rules scope=project -->
<!-- managed by skilletor — edits are overwritten; change the rule in its source -->

<!-- skilletor:rule k8s source=shared -->
Applies when working with files matching: `k8s/**`, `*.yaml`.

Use kubectl carefully.
```

- One section per rule, sorted by name. The body is the rule rendered for `codex` without
  its frontmatter; a `paths:` list (Codex cannot load a rule conditionally) becomes the
  leading "Applies when working with files matching" line.
- **The file is wholly skilletor's.** It exists exactly while the scope has a Codex rule and
  is deleted with the last one. A section edited or deleted by hand is restored on the next
  sync and reported as an overwritten local change (`.codex/skilletor-rules.md#rules/k8s`).
  Change the rule in its source.
- **Delivery.** On `startup` and `clear` the hook puts the user rules file, then the project
  one, at the start of the session's context — read from disk, so a failed or timed-out
  sync still delivers the last good rules. On `resume` it adds nothing: the resumed history
  already holds the first copy, and a second would duplicate it. `UserPromptSubmit` never
  adds rules.
- **The pointer.** `AGENTS.md` gets only a fixed block telling Codex to read the rules file
  when the hook's message is gone (after compaction, say). Its text never changes, so it
  appears in a diff only when a scope gains its first Codex rule or loses its last one:

  ```markdown
  <!-- skilletor:begin -->
  <!-- managed by skilletor — edits inside are overwritten -->
  Additional rules for this project are managed by skilletor. They are normally provided at
  session start as a developer message beginning with `<!-- skilletor:rules`. If that message
  is not in your context (for example after context compaction), read
  `.codex/skilletor-rules.md` before you start a task, and follow it.
  <!-- skilletor:end -->
  ```

  The user block says "for all projects" and names the user rules file by absolute path.
  Everything outside the markers is yours and never modified. A missing `AGENTS.md` is
  created with just the block; an existing one gets it appended. When the rules file goes,
  the block goes; a file left empty is deleted.
- **Refusals** skip only the pointer — the rules file and the hook delivery are unaffected.
  skilletor warns and leaves `AGENTS.md` alone; `--force` does not override:
  - the markers are malformed: `begin` without `end`, `end` before `begin`, either twice;
  - `AGENTS.md` is a symlink (commonly `AGENTS.md` → `CLAUDE.md`: writing through it would
    send Claude Code to the Codex rules), a directory, or unreadable;
  - Claude Code is a target too and a `CLAUDE.md` it reads is the same file as that
    `AGENTS.md` (`CLAUDE.md` or `.claude/CLAUDE.md` in a project, `~/.claude/CLAUDE.md` for
    `$CODEX_HOME/AGENTS.md`; linked or hard-linked).
- **Warnings:** an `AGENTS.override.md` next to the file (Codex reads the override
  instead, so the pointer is not seen); a project `AGENTS.md` larger than Codex's
  `project_doc_max_bytes` (default 32768, read from `$CODEX_HOME/config.toml`) — Codex cuts
  project instructions from the end, where the pointer sits.
- **Git:** with `"gitignore": true` (the default) the project rules file is listed in the
  managed `.codex/.gitignore` block, so rule text stays out of commits; only the small
  pointer block shows up in the diff of `AGENTS.md`.
- **Coming from an older skilletor:** rules that used to sit as sections of the block in
  `AGENTS.md` move to the rules file on the next sync, and the block is replaced by the
  pointer. The report lists the rules as updated, not as overwritten local changes.

### The plugin under Codex

The repository ships a Codex plugin manifest (`.codex-plugin/plugin.json`) next to the
Claude one; both ship the bundled skill. The Codex manifest points at its own
`hooks/codex-hooks.json` — the same hooks as `hooks/hooks.json`, run with `--harness codex`,
plus the rules delivery.

- **Trust the hooks.** Codex runs a plugin's hooks only after you trust them — open
  `/hooks` in Codex and trust skilletor's `SessionStart` and `UserPromptSubmit` hooks.
  Until then Codex skips them without a word: no syncs, no rules. While Codex is a target
  and `$CODEX_HOME/config.toml` holds no trust entry for skilletor's `SessionStart` hook,
  `sync` and `status` warn once per run — in `--json` output as a top-level `warnings`
  array (`{ "scopes": […], "warnings": ["Codex has not trusted …"] }`, absent when empty;
  the per-scope `warnings` of `sync` are unchanged). An update that changes the hook file
  makes Codex mark the hook as modified; trust it again in `/hooks`. skilletor does not
  detect that case — the entry is still there.
- **The CLI is not on `PATH`** inside Codex (Codex cannot add a plugin's `bin/` to it). The
  bundled skill tells the model to run it by absolute path, from the plugin's cache
  directory: `$CODEX_HOME/plugins/cache/<marketplace>/skilletor/<version>/bin/skilletor`.
  In your own shell, point an alias at that file or at a clone of this repository
  (`alias skilletor=~/src/skilletor/bin/skilletor` — `dist/` is committed, no `npm install`
  needed). Use an alias, not a symlink: the launcher finds `dist/` relative to its own path.
- Codex sets no `CLAUDE_PROJECT_DIR`; the hook takes the git top level of the session's
  working directory as the project root, so a session started in a subdirectory still
  finds `<repo>/.claude/skilletor.json`.

## Security & trust

**Trust means code execution** — Nunjucks is not a sandbox, so a source can run code when
rendered. This is the same trust level as installing a plugin.

- Adding a source with `skilletor add` (or your own user config) trusts it.
- A source that appears **only** in a project config (a cloned repo) is never fetched
  until you run `skilletor trust <name>`; if the project later changes the URL, trust
  lapses.
- Fixed target directories per harness; item names, tar entries and includes may not escape the
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
skilletor install 'skill:perl-*@shared'   # name pattern: every skill whose name matches
skilletor install bundle:perl@shared      # a bundle; offers to add sources it needs (terminal only)
skilletor uninstall <item>... [--project] # [type:]name@source (no type: every list); wildcards, bundle: as written
skilletor sync | check | status           # --scope user|project|all, --json, --project-dir <dir>
skilletor sync --force                    # overwrite and adopt unmanaged files reported as conflicts
skilletor trust <source>
```

`check` writes nothing and exits non-zero when a source has changed. `--project-dir` goes
with every command; any other option a command does not list is an error (exit 2, nothing
runs). `-h`/`--help` anywhere prints the usage and runs nothing (`sync --help` does not
sync); `-v`/`--version` only as the first argument.

## Requirements

- Node.js ≥ 18 and `git`. The only bundled runtime dependency is Nunjucks.

## License

MIT.
