# skilletor conformance cases

Shared cases that every skilletor engine runs, so the TypeScript engine (`src/`, the
reference) and the Perl port (`perl/`, namespace `Skilletor`) resolve and install the same
way. Each case is a config, a few source trees and what an engine must make of them: the
items each scope resolves to and, for sync cases, the files a sync for the Claude target
writes, the lock bytes and what `check` and `status` say afterwards.

Runners:

- TypeScript: `test/conformance.test.ts` (part of `npm test`).
- Perl: `perl/t/60-conformance.t` (every step; the Perl engine syncs for Claude Code only).

The format is plain JSON and plain file trees, nothing language-specific: a runner needs a
JSON parser, a directory copy, `git` and its engine.

## Layout

```
conformance/cases/<NN-slug>/
  case.json            what to build and run (below)
  home/                copied to ${HOME}: home/.claude/skilletor.json, home/.claude/skilletor/trust.json, …
  project/             copied to ${PROJECT}: project/.claude/skilletor.json, skilletor.local.json, …
  sources/<tree>/      plain source trees, built into git repositories (below)
  expected/<step>.json the expected JSON of step <step>
  expected/<step>/     the expected files after step <step>, when the step has "tree": true
    home/…             relative to ${HOME}
    project/…          relative to ${PROJECT}
```

A case has a project scope exactly when it has a `project/` directory; without one the engine
runs with no project dir at all (user scope only). `home/` may be missing (an empty home).
Cases run in name order, each in a fresh temp dir; none depends on another.

## `case.json`

```json
{
  "description": "One sentence: what the case pins.",
  "git": {
    "shared": {
      "url": "https://conformance.invalid/shared.git",
      "commits": [
        { "tree": "sources/shared-v1", "tag": "v1" },
        { "tree": "sources/shared-v2", "branch": "next", "executable": ["skills/tool/run.sh"] }
      ]
    }
  },
  "steps": [
    { "id": "resolve", "op": "resolve" },
    { "id": "sync", "op": "sync", "scope": "all", "tree": true },
    { "id": "check", "op": "check" },
    { "id": "status", "op": "status" }
  ],
  "engines": {
    "perl": {
      "skip": "why the whole case does not apply (optional)",
      "steps": {
        "sync": { "skip": "why this step does not apply" },
        "status": { "expected": "expected.perl/status" }
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `description` | Required. What the case pins. |
| `git` | Optional. Git sources, by repository name (below). |
| `steps` | Required, run in order on the same temp dirs: a step sees what the steps before it wrote. |
| `steps[].id` | Names the expectation: `expected/<id>.json`, `expected/<id>/`. Unique in the case. |
| `steps[].op` | `resolve`, `sync`, `check` or `status` (below). |
| `steps[].scope` | `user`, `project` or `all` (default `all`), as `--scope`. |
| `steps[].force` | `sync` only: `--force`. Default `false`. |
| `steps[].tree` | After the step, compare the file trees with `expected/<id>/` (below). Default `false`. |
| `engines` | Optional. Where an engine other than the reference does not, or not yet, do what TS does. |

### Engine variants

TypeScript is the reference: its runner ignores `engines` and runs every step against
`expected/`. Every other engine reads `engines.<its name>` (`perl`), and nothing else is
implied – a step without an entry there must match `expected/` exactly.

- `skip` on the engine: the whole case is skipped by that engine, with the reason as the
  skip message.
- `steps.<id>.skip`: that step is skipped. Its effects are then missing for the later steps,
  so a step that reads what a skipped one wrote (a `status` after a skipped `sync`) is
  marked as well.
- `steps.<id>.expected`: that engine compares against `<value>.json` and, for a tree step,
  `<value>/` and `<value>.executables.json` (paths relative to the case dir) instead of
  `expected/<id>`. Those files are that engine's and written by hand; the TS runner never
  reads or regenerates them. Why the engine differs is said below.

The one known difference today: the Perl engine renders no Nunjucks. A resolve does not
render, so `resolve` steps hold for every engine – an item with a `.njk` file carries
`"templated": true` there. A `sync` of such an item differs, and case `09-templates` pins
the Perl engine's own behaviour in `expected.perl/`: an engine that renders nothing never
installs a templated item unrendered. It warns
(`skill greet@shared is a Nunjucks template (skills/greet/SKILL.md.njk) the Perl port of
skilletor does not render; an installed copy stays`) and leaves the item as it is installed,
files and lock entry, as a sync does for an item whose source is unreachable. Its source then
counts as not reached for the scope's records, so `check` keeps asking for a sync, and the
reference's next sync renders the item.

## Environment

A runner builds, per case, under a fresh temp dir `${TMP}` (its real path, symlinks
resolved – macOS `/var` is `/private/var`):

| Path | What |
|---|---|
| `${TMP}/home` = `${HOME}` | The home dir. The runner creates `${HOME}/.claude/` and writes `${HOME}/.claude.json` as `{}` + newline – the marker that Claude Code is in use (spec §14.1) – then copies `home/`. |
| `${TMP}/project` = `${PROJECT}` | The project dir, when the case has `project/`: created, then `project/` copied. |
| `${TMP}/git/<name>` | The git sources (below). |
| `${TMP}/gitconfig` | The git config every git run of the case uses (below). |

The engine runs with:

- home `${HOME}`, project dir `${PROJECT}` (or none);
- state root `${HOME}/.claude/skilletor`, cache root `${HOME}/.claude/skilletor/cache`
  (the defaults the CLI uses);
- `CODEX_HOME` = `${HOME}/.codex`, which does not exist, so Codex is not detected;
  `HERMES_HOME` = `${HOME}/.hermes`; `CLAUDE_PLUGIN_ROOT` unset. The active target is Claude
  Code alone, detected from the marker – no case sets `targets` unless it is about them;
- `GIT_CONFIG_GLOBAL` = `${TMP}/gitconfig` and `GIT_CONFIG_NOSYSTEM=1`, for the engine's git
  runs and the runner's alike, so no user or system git config is read;
- neither `${HOME}` nor `${PROJECT}` inside a git work tree, and git tracking none of their
  files (the TS runner injects both answers; a temp dir outside any repository gives them);
- for templates, host name `conformance`, OS `linux`, user name `conformance`, user home
  `${HOME}` (only the TS engine renders; no case's output depends on them yet).

Nothing reaches the network: every source is a `local` directory, a git repository reached
through `insteadOf`, or a source the case never fetches (an untrusted `url`).

### Git sources

Each entry of `git` is a repository `${TMP}/git/<name>`, built with exactly these commands
(run in the repository, environment as above plus the commit identity below):

```sh
git init -q -b main                     # once
# per commit, in order (i counts from 1):
#   delete everything in the repository but .git, then copy <case>/<tree>/ into it,
#   then chmod 0755 each path the commit lists in "executable" (relative to the tree)
git add -A
git commit -q --allow-empty -m "conformance <i>"
git tag <tag>                           # when the commit has "tag" (lightweight)
git branch <branch>                     # when the commit has "branch"
```

Commit identity, so every engine builds the same commits and the same SHAs:

```
GIT_AUTHOR_NAME=skilletor-conformance     GIT_COMMITTER_NAME=skilletor-conformance
GIT_AUTHOR_EMAIL=conformance@skilletor.invalid
GIT_COMMITTER_EMAIL=conformance@skilletor.invalid
GIT_AUTHOR_DATE=2026-01-01T00:00:00+0000  GIT_COMMITTER_DATE=2026-01-01T00:00:00+0000
```

`main` ends at the last commit. The expectations name commits literally (`"version":
"git:f280510"`), so a runner that builds a source differently fails every case using it –
look there first.

`${TMP}/gitconfig` maps each source's `url` to its repository:

```
[url "file://${TMP}/git/shared"]
	insteadOf = https://conformance.invalid/shared.git
```

The configs name the `url` (`"git": "https://conformance.invalid/shared.git"`), so that
address is what the engine stores, trusts, hashes into the cache dir name and reports – the
cache dir name is pinned literally (`"cache": "79eb247685294166"`) – while every fetch and
`ls-remote` goes to the local repository. An address no `git` entry maps is never fetched by
any case.

## Placeholders

`${HOME}`, `${PROJECT}` and `${TMP}` stand for the temp paths above.

- **Inputs:** every file copied from `home/` and `project/` has each placeholder replaced by
  its path (configs naming a local path, a plugin state's `installPath`). Source trees and
  git trees are copied byte for byte.
- **Outputs:** before comparing, every occurrence of a temp path in the step's JSON (in
  every string) and in every compared file is replaced by its placeholder – first
  `${HOME}`, then `${PROJECT}`, then `${TMP}`, so the longer, nested paths win.

## Operations

| `op` | TS call | The JSON compared with `expected/<id>.json` |
|---|---|---|
| `resolve` | `resolveItems` (`src/engine.ts`) | the resolve view (below) |
| `sync` | `sync` | the `SyncReport` – what `skilletor sync --json` prints |
| `check` | `check` | the `CheckReport` – what `skilletor check --json` prints |
| `status` | `status` | the `StatusReport` – what `skilletor status --json` prints |

`sync`, `check` and `status` take `scope`; `sync` takes `force`. An engine's own spelling of
a call does not matter; the JSON does. A config error is no failure of the step: it is the
report's `error`, and a sync with one touches nothing.

### `resolve`

What each scope resolves to – a sync's steps 1–3 (spec §6.1): config load and merge, trust,
every needed source resolved into its cache (git sources are fetched), catalogs scanned,
wildcards and bundles expanded with the overlap rules (§3, §15) – stopped before anything is
built: nothing is rendered, nothing written to a target, the lock or the state's records.
The items are the same for every target: which harness gets a copy where is the sync's
business.

```json
{
  "error": "only on a config error (then scopes is [])",
  "scopes": [
    {
      "scope": "user",
      "sources": [
        {
          "name": "shared",
          "state": "resolved",
          "kind": "git",
          "address": "https://conformance.invalid/shared.git",
          "origin": "user",
          "ref": "v1",
          "path": ["skills"],
          "cache": "b966aec947fa313b",
          "dir": "${HOME}/.claude/skilletor/cache/b966aec947fa313b",
          "version": "git:30993b3"
        }
      ],
      "items": [
        {
          "type": "skill",
          "name": "perl-moo",
          "source": "shared",
          "declaredBy": ["perl-moo@shared"],
          "via": ["bundle:perl@shared"],
          "path": "skills/perl-moo",
          "files": ["skills/perl-moo/SKILL.md", "skills/perl-moo/reference.md"],
          "description": "Write Moo classes",
          "templated": false,
          "vars": { "level": 1, "team": "core" }
        }
      ],
      "warnings": ["item not found in source shared: skill nope"],
      "trustRequests": [{ "name": "team", "kind": "git", "url": "https://conformance.invalid/team.git" }]
    }
  ]
}
```

- `scopes`: `user`, then `project` when there is a project scope (and `scope` asks for it).
- `sources`: every source the scope needed – named by an entry, or serving a bundle's entry
  of another source (§15.6) – the user scope from the user config alone, the project scope
  from the merged map (§3).
  - `state`: `resolved`; `untrusted` (a project-origin backend without trust, §4.3 – never
    fetched); `failed` (its resolve or scan failed: `warnings` says why); `unknown` (no
    source of that name).
  - `kind`, `address`, `origin`: the one resolved backend of §3 – author mode's choice
    (`local` when that directory exists, else `git`, else `url`), a `local` address as the
    absolute real path, `origin` of that field (`user` for the user config and
    `skilletor.local.json`, `project` for the project's `skilletor.json`). Absent only when
    there is none (`unknown`).
  - `ref`: git only, when set. `path`: the source's `path` as a list, when set.
  - `cache`: git and url: the cache dir name under the cache root, whether or not the
    source was fetched – the first 16 hex digits of the SHA-256 of its identity: for git the
    URL alone when unpinned, else the compact JSON array `["<url>","<ref>"]`; for url the
    URL.
  - `dir`, `version`: `resolved` only. `dir` is the tree the items lie in: the cache dir, or
    the `local` directory. `version`: `git:<abbreviated sha>` (`git rev-parse --short`),
    `local`, or the url cache's version.
- `items`: what a sync would build, once each, after the overlap rules – an explicit entry's
  item, and each name the wildcards and bundles of one source yield that nothing overrides.
  An item the source lacks, or that carries a catalog error, is no item but a warning.
  - `declaredBy`: the entries declaring it as written – the explicit entry alone
    (`perl-moo@shared`, `agent:reviewer@shared`), else each wildcard (`*@shared`,
    `rule:*-style@shared`) and bundle (`bundle:perl@shared`, however the config spelled it)
    that yields it.
  - `via`: the bundles its lock entry records (spec §15.5): for an explicit item, the
    same-source bundles that also yield it. Absent when none.
  - `path`: where it lies, relative to the source tree: a skill's directory, an agent's or
    rule's file. `files`: every file of the item, relative to the source tree.
  - `description`: the main file's frontmatter `description`, read raw – a `.njk` file is
    not rendered for it. Absent when there is none.
  - `templated`: whether any of `files` ends in `.njk`.
  - `vars`: the item's merged `vars`: source defaults < bundle vars (bundle items only, outer
    bundle winning, a key two chains set differently dropped) < user < project < local
    (spec §5, §15.3); the user scope's items get the user config's vars alone.
- `warnings`: the scope's warnings up to that point, exactly as a sync would word them.
- `trustRequests`: as in a sync report.

### Trees

With `"tree": true` the runner compares, after the step:

- every file under `${HOME}`, except `${HOME}/.claude/skilletor/` (state and cache, whose
  files hold timestamps) and the marker `${HOME}/.claude.json`, with `expected/<id>/home/`;
- every file under `${PROJECT}` with `expected/<id>/project/`.

The sets of relative paths must be equal – a file the engine should not have written fails
as surely as one it missed – and each file's bytes must be equal after the output
placeholders are applied. That includes the inputs the step left alone, the lock
(`.claude/skilletor.lock.json`, byte for byte: key order, two-space indent, final newline),
`.gitignore` blocks, `.worktreeinclude`, `.claude/settings.json` and every installed file.

Of the file modes, only the owner's executable bit is compared: the tree's files that carry
it, as a sorted JSON array of their paths (`home/…`, `project/…`), must equal
`expected/<id>.executables.json` – no such file means none may carry it. A source file gets
the bit through its commit's `executable` list, not through the mode the case's own
checkout gives it, so a checkout without file modes still builds the same commits.
Directories, empty or not, and every other mode bit are not compared.

## Comparing JSON

Both sides are compared as data in a canonical form: every object's keys sorted, every
array sorted by the canonical JSON text of its elements, recursively. So neither key order
nor the order of items, warnings or sources matters – an engine resolving sources in
parallel orders its warnings by completion – and the order the expected files show carries
no meaning. Strings, numbers, booleans and `null` compare exactly; an absent key is not a
key with `null`. Order that does matter lives in files and is compared there, byte for byte.

## Regenerating and adding cases

The TS engine is the reference, so its runner rewrites every expectation:

```bash
SKILLETOR_CONFORMANCE_UPDATE=1 node --test --import ./test/setup.ts test/conformance.test.ts
```

It writes `expected/<id>.json` and, for tree steps, replaces `expected/<id>/` and writes
`expected/<id>.executables.json` (or removes it when no file carries the bit). Review the diff
against the spec before keeping it: an expectation that mirrors whatever the code does
proves nothing. A new case is a directory with `case.json`, its inputs and – after a
reviewed regeneration – its `expected/`. Keep it small: one behaviour, the fewest items that
show it, its `description` saying which.

## The cases

| Case | Pins |
|---|---|
| `01-user-explicit` | user config only; `name@source`, `type:name@source`; source default vars under the user's; a resolve writes nothing (also `09`) |
| `02-merge-precedence` | vars source < user < project < local; project + local install lists add up; a user source in the project scope |
| `03-git-ref` | user scope tracks HEAD, the project pins tag `v1` through a backend-less local entry; one cache dir per URL and ref |
| `04-author-mode` | a user `local` beside a project `git` wins while the directory exists (user origin, no fetch); a missing `local` falls back to `git` |
| `05-trust` | project-only sources: trusted for its exact address, lapsed (other address), an untrusted `url` – never fetched, its cache name pinned |
| `06-wildcards` | `perl-*`, `*`, `*-style` overlapping in one source; a bare `*` matching nothing is silent, a pattern matching nothing warns |
| `07-bundles` | `name@source` and `bundle:` entries, nested bundle vars, an entry of another source served under another name, a missing source and name |
| `08-overlap` | explicit over a same-source bundle (no bundle vars, `via`) and over another source's wildcard; two sources' wildcards skip a name; a bundle var conflict |
| `09-templates` | `.njk` items marked `templated`; a sync renders them, a rule gated off by project vars is skipped (sync TS-only) |
| `10-error-unknown-source` | an entry naming no source is a config error; a sync touches nothing |
| `11-error-bad-entry` | an entry without `@source` in `skilletor.local.json` is a config error naming that file |
| `12-missing-items` | an unknown item, an unknown bundle, an agent with `.md` and `.md.njk`: warnings, the rest resolves |
| `20-sync-user` | user-scope sync of a skill, an agent and a rule: files, lock; `check`, `status`; a second sync changes nothing |
| `21-sync-project` | project-scope sync: a user source's bundle and a trusted project source; `.gitignore` block, `.worktreeinclude`, `settings.json`, lock `via`; `check`, `status` |

Not covered yet: a `url` source actually fetched (the engine takes `https://` only, so it
needs a local TLS server), a source whose fetch fails (the warning quotes git's own message),
removal of an undeclared item by a later sync, conflicts and `--force`, Codex and Hermes
targets, and the state files (`trust.json` aside) two engines on one machine share.
