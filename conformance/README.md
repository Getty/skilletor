# skilletor conformance cases

Cases that pin how a skilletor engine resolves and installs, run against the TypeScript
engine (`src/`, the reference) and its CLI. Each case is a config, a few source trees and what an engine must make of them: the
items each scope resolves to and, for sync cases, the files written for the selected targets,
the lock bytes and what `check` and `status` say afterwards; for `cli` steps, what a
command line prints and exits with, byte for byte.

Runner: `test/conformance.test.ts` (part of `npm test`). It runs the `cli` steps against this
checkout's CLI by default and against any other on request (below), so one set of expectations
holds the TS bundle and a packed binary to the same bytes.

The format is plain JSON and plain file trees, nothing language-specific: a runner needs a
JSON parser, a directory copy, `git`, a way to run a program, and its engine.

## Layout

```
conformance/cases/<NN-slug>/
  case.json            what to build and run (below)
  home/                copied to ${HOME}: home/.claude/skilletor.json, home/.claude/skilletor/trust.json, …
  project/             copied to ${PROJECT}: project/.claude/skilletor.json, skilletor.local.json, …
  sources/<tree>/      plain source trees, built into git repositories (below)
  expected/<step>.json the expected JSON of step <step>
  expected/<step>.stdout, .stderr  what a `cli` step writes there, as bytes (missing: nothing)
  expected/<step>/     the expected files after step <step>, when the step has "tree": true
    home/…             relative to ${HOME}
    project/…          relative to ${PROJECT}
    cwd/…              relative to ${TMP}/cwd
  expected/<step>.executables.json  the files of that tree that carry the executable bit, when any do
  expected.<engine>/…  an engine's own expectations, where it differs (below)
```

### Escaped names

No file or directory in a case is named `.git…`: a `.gitignore` there – the managed block an
expected `.claude/.gitignore` holds, the `*` of a skill's own – would be live in this
repository and hide the fixture files beside it from git, so a fresh checkout would lack
them. Every path segment starting with `.git` is stored with the prefix `dot`
(`.gitignore` → `dot.gitignore`, `.gitattributes` → `dot.gitattributes`), in every tree of a
case: `home/`, `project/`, `sources/<tree>/` and the expected trees. A runner unescapes
(`dot.git…` → `.git…`) when it copies an input or source tree in, and escapes when it names a
file of a snapshot, for the comparison and when it writes expectations; JSON contents and a
commit's `executable` list use the real names. The runner fails a case that holds an
unescaped name.

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
    { "id": "status", "op": "status" },
    { "id": "help", "op": "cli", "argv": ["--help"], "version": true }
  ],
  "engines": {
    "other": {
      "skip": "why the whole case does not apply (optional)",
      "steps": {
        "sync": { "skip": "why this step does not apply" },
        "status": { "expected": "expected.other/status" }
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `description` | Required. What the case pins. |
| `git` | Optional. Git sources, by repository name (below). |
| `git.<name>.commits[].executable` | Optional. Paths in the commit's tree made executable before it is committed (below). |
| `env` | Optional. Environment variables set for the whole case – the engine ops' and every `cli` step's – `${HOME}`, `${PROJECT}` and `${TMP}` replaced. |
| `claude` | Optional. `false`: the runner writes no Claude Code marker (`.claude.json`, below), so – Codex not in use either – no agent harness is detected. Default `true`. |
| `gitInit` | Optional. `["home"]`, `["project"]` or both: those directories become git work trees – `git init -q -b main` in each, after its inputs are copied, nothing committed – so a `cli` step's CLI takes git's top level as its project and git answers for them (below). |
| `steps` | Required, run in order on the same temp dirs: a step sees what the steps before it wrote. |
| `steps[].id` | Names the expectation: `expected/<id>.json`, `expected/<id>/`. Unique in the case. |
| `steps[].op` | `resolve`, `sync`, `check`, `status` or `cli` (below). |
| `steps[].scope` | `user`, `project` or `all` (default `all`), as `--scope`. Not `cli`. |
| `steps[].force` | `sync` only: `--force`. Default `false`. |
| `steps[].argv`, `cwd`, `env`, `stdin`, `version` | `cli` only (below). |
| `steps[].tree` | After the step, compare the file trees with `expected/<id>/` and their executable bits with `expected/<id>.executables.json` (below). Default `false`. |
| `engines` | Optional. Where an engine other than the reference does not, or not yet, do what TS does. |

### Engine variants

TypeScript is the reference: its runner ignores `engines` and runs every step against
`expected/`. Any other engine would read `engines.<its name>`, and nothing else is
implied – a step without an entry there must match `expected/` exactly.

- `skip` on the engine: the whole case is skipped by that engine, with the reason as the
  skip message.
- `steps.<id>.skip`: that step is skipped. Its effects are then missing for the later steps,
  so a step that reads what a skipped one wrote (a `status` after a skipped `sync`) is
  marked as well.
- `steps.<id>.expected`: that engine compares against `<value>.json` and, for a tree step,
  `<value>/` and `<value>.executables.json` (paths relative to the case dir) instead of
  `expected/<id>`. Those files are that engine's and written by hand; the TS runner never
  reads or regenerates them.

No case has an engine variant today: every engine runs every step against `expected/`.

## Environment

A runner builds, per case, under a fresh temp dir `${TMP}` (its real path, symlinks
resolved – macOS `/var` is `/private/var`):

| Path | What |
|---|---|
| `${TMP}/home` = `${HOME}` | The home dir. The runner creates `${HOME}/.claude/` and writes `${HOME}/.claude.json` as `{}` + newline – the marker that Claude Code is in use (spec §14.1) – then, when the case sets `CLAUDE_CONFIG_DIR`, creates it with its own `.claude.json` (Claude Code keeps the marker there then), then copies `home/`. With `"claude": false` it writes neither `.claude.json`. |
| `${TMP}/project` = `${PROJECT}` | The project dir, when the case has `project/`: created, then `project/` copied. |
| `${TMP}/cwd` | An empty directory outside git, a `cli` step's cwd – and so its project – when the case has no project. |
| `${TMP}/git/<name>` | The git sources (below). |
| `${TMP}/gitconfig` | The git config every git run of the case uses (below). |

The engine ops run with:

- home `${HOME}`, project dir `${PROJECT}` (or none);
- state root `${HOME}/.claude/skilletor`, cache root `${HOME}/.claude/skilletor/cache` – even
  when the case sets `CLAUDE_CONFIG_DIR`, under which the CLI keeps its state in
  `${CLAUDE_CONFIG_DIR}/skilletor` instead (a `cli` step's CLI runs with its own defaults, below);
- `CODEX_HOME` = `${HOME}/.codex`, which does not exist, so Codex is not detected – a case
  that seeds `home/.codex/config.toml` (cases 100-108) makes it detected, and that file's
  `trusted_hash` for skilletor's SessionStart hook decides the untrusted-hook warning;
  `HERMES_HOME` = `${HOME}/.hermes` – the runner passes it to the engine ops as the Hermes home,
  and a step's `env` `HERMES_HOME` reaches only a `cli` step, whose CLI otherwise uses Hermes'
  default home under `${HOME}`. Hermes is never detected: a case opts in with `"targets"` in
  `home/.claude/skilletor.json` (cases 110-125); `CLAUDE_PLUGIN_ROOT` and `CLAUDE_CONFIG_DIR` unset,
  unless the case's `env` sets them (below). The active target is Claude
  Code alone, detected from the marker (none without it, `"claude": false`) – no case sets
  `targets` unless it is about them;
- `GIT_CONFIG_GLOBAL` = `${TMP}/gitconfig` and `GIT_CONFIG_NOSYSTEM=1`, for the engine's git
  runs and the runner's alike, so no user or system git config is read;
- neither `${HOME}` nor `${PROJECT}` inside a git work tree, and git tracking none of their
  files (the runners inject both answers; a temp dir outside any repository gives them) –
  unless the case's `gitInit` makes one a work tree: then no answer is injected and git
  itself answers, as for a `cli` step's CLI;
- for templates, host name `conformance`, OS `linux`, user name `conformance`, user home
  `${HOME}` (no case's output depends on them yet).

Nothing reaches the network: every source is a `local` directory, a git repository reached
through `insteadOf`, or a source the case never fetches (an untrusted `url`); the one probe of
a generic host that finds nothing (`90`) asks 127.0.0.1 port 1, where nothing listens.

### Git sources

Each entry of `git` is a repository `${TMP}/git/<name>`, built with exactly these commands
(run in the repository, environment as above plus the commit identity below):

```sh
git init -q -b main                     # once
# per commit, in order (i counts from 1):
#   delete everything in the repository but .git, then copy <case>/<tree>/ into it – the
#   bytes, each file new with the default mode, not the mode the checkout gave it –
#   then chmod 0755 each path the commit lists in "executable" (relative to the tree)
git add -A
git update-index --chmod=-x -- <every current regular file>  # reset the prior commit's index modes
git update-index --chmod=+x -- <executable paths>              # when the list is nonempty
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
  its path (configs naming a local path, a plugin state's `installPath`; inside a JSON file the
  inserted path is JSON-escaped), and so has every string of a `cli` step's `argv`, `cwd`, `env`
  and `stdin`, and of the case's `env`. Source trees and git trees are copied byte for byte.
- **Outputs:** before comparing, every exact temp root in the step's JSON strings, a CLI
  stream or a compared file is replaced by its placeholder; plain and JSON-escaped root
  spellings remain distinct. The existing expected oracle then supplies path provenance: only
  a `/` inside its explicitly delimited placeholder-rooted path token may match a native
  separator. Decoded strings use one backslash; raw JSON string bytes require two. A root inside
  one fully paired escaped-quote scalar inside the same outer JSON string may use exactly one
  additional encoding layer; unmatched delimiters never borrow a quote from another scalar or a
  later quoted value, and missing, extra or arbitrary depths fail. Single JSON
  escapes (`\\n`, `\\t`, `\\uNNNN`), formatting, ordering and all unrelated bytes remain exact;
  no stream or file is parsed and reserialized. Replacement runs first `${HOME}`, then
  `${PROJECT}`, then `${TMP}`, so the longer, nested paths win.
- **`${VERSION}`** stands for the version the CLI reports, the plugin's (`package.json`) – and
  only in the stdout and stderr of a `cli` step with `"version": true`: there every occurrence
  is replaced, after the paths. Anywhere else a version-shaped string
  stays as it is.

## Operations

| `op` | TS call | What is compared with `expected/<id>.json` |
|---|---|---|
| `resolve` | `resolveItems` (`src/engine.ts`) | the resolve view (below) |
| `sync` | `sync` | the `SyncReport` as data – what `skilletor sync --json` prints, parsed |
| `check` | `check` | the `CheckReport` as data – what `skilletor check --json` prints, parsed |
| `status` | `status` | the `StatusReport` as data – what `skilletor status --json` prints, parsed |
| `cli` | a CLI run (below) | `{"exit": N}`; stdout and stderr byte for byte |

`sync`, `check` and `status` take `scope`; `sync` takes `force`. An engine's own spelling of
a call does not matter; the data does – compared in the canonical form below, so key order,
indent and the order of a report's lists are not pinned by these ops. Bytes are a `cli`
step's business. A config error is no failure of the step: it is the report's `error`, and a
sync with one touches nothing.

### `cli`

A command line: the CLI runs with `argv` and what it writes and exits with is compared. With
`"tree": true` the files are compared after it as after any step.

| Key | Meaning |
|---|---|
| `argv` | Required. The arguments after the program. |
| `cwd` | The working directory. Default `${PROJECT}`, else `${TMP}/cwd` (empty, outside git). |
| `env` | Variables on top of the case's `env`; `null` unsets one. |
| `stdin` | Fed through a pipe, then end of file – never a TTY. A string goes in as its UTF-8 bytes, any other value as its compact JSON (`JSON.stringify`). Default: nothing. |
| `version` | `true`: `${VERSION}` applies to stdout and stderr (above). Default `false`. |

`expected/<id>.json` holds `{"exit": N}`, compared as JSON. `expected/<id>.stdout` and
`expected/<id>.stderr` hold the bytes the CLI wrote to each, after the output placeholders;
a missing file means it wrote nothing there. They compare byte for byte – no canonical form,
no newline or encoding normalised.

The CLI's environment is built from nothing: `PATH`, `HOME` = `${HOME}`, `CODEX_HOME` = `${HOME}/.codex`, `GIT_CONFIG_GLOBAL` =
`${TMP}/gitconfig`, `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C` and `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (Bun would
otherwise keep its transpiler cache under `${HOME}`); then the case's `env`; then the
step's. On Windows it also sets `USERPROFILE` = `${HOME}`, `LOCALAPPDATA` under `${HOME}`, and
`TEMP`/`TMP` = `${TMP}`: the native home and temporary-directory APIs must stay inside the case.
The child runtime may add only its documented/platform execution values (macOS
`__CF_USER_TEXT_ENCODING`; Windows logon/system-root identity values). The runner checks that
no other parent variable or credential sentinel leaks – in particular no `CLAUDE_PROJECT_DIR`,
`SKILLETOR_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`, `GIT_DIR`,
`SKILLETOR_BIN` or credential value. It runs with its own defaults: state root
`${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skilletor`, Hermes' default home under `${HOME}`, the
project from `--project-dir` or the git top level of its cwd, and git itself answers whether
a directory lies in a work tree (none under `${TMP}` does, but what `gitInit` made one).

Which CLI runs: `SKILLETOR_CONFORMANCE_CLI`, a JSON array of strings, is put before `argv`.
Unset, the runner runs `node` and the bundle `buildToString` (`scripts/esbuild.config.mjs`)
makes of this checkout, as `test/cli.test.ts` does. Any other CLI – a packed binary, say – runs
against the same expectations:

```bash
SKILLETOR_CONFORMANCE_CLI='["'"$PWD"'/skilletor-binary"]' \
  node --test --import ./test/setup.ts test/conformance.test.ts
```

The variable is not `SKILLETOR_BIN`, which the Hermes adapter reads.

A CLI that does not start, runs past the step's timeout (30 s) or dies of a signal fails the
step. Windows has no POSIX child-signal result, so only that runner self-test assertion is skipped
there; timeout coverage still runs. A step whose `argv` starts with `hook` must expect exit 0: a
hook never fails (spec §8). Tree comparison still runs on Windows, but its POSIX executable-bit
assertion is skipped when a case expects executable files because the filesystem exposes no
corresponding mode contract.

A `hook user-prompt-submit` that finds its project due starts a real background sync –
detached, outliving the step, racing the next one and the temp dir's removal – so a case keeps
every prompt hook not due: `checkInterval` 0 or less in the user config, a `session-start`
before it that marked the project checked, or a `home/.claude/skilletor/last-check.json` whose
mark for `${PROJECT}` lies in the future (a config that fails to load makes a project due every
600 s, and a SessionStart that meets a config error marks nothing). The background sync itself
is a step of its own, `hook __sync-background` with `SKILLETOR_PROJECT_DIR`, as the prompt
hook starts it.

### `resolve`

What each scope resolves to – a sync's steps 1–3 (spec §6.1): config load and merge, trust,
every needed source resolved into its cache (git sources are fetched), catalogs scanned,
wildcards and bundles expanded with the overlap rules (§3, §15) – stopped before anything is
built: nothing is rendered, nothing written to a target, the lock or the state's records.
The items are the same for every target: which harness gets a copy where is the sync's
business. Resolution still reads logical offers from scope locks when a source or bundle
is unavailable, so those offers continue to participate in collisions. Existing malformed
or unreadable locks are not silently discarded just because the operation writes no items.

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
  files hold timestamps), the CLI's state root `${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skilletor/`
  when it lies under `${HOME}` (the case's `CLAUDE_CONFIG_DIR`, or a `cli` step's own), and the
  marker `${HOME}/.claude.json`, with `expected/<id>/home/`;
- every file under `${PROJECT}` with `expected/<id>/project/`;
- every file under `${TMP}/cwd` with `expected/<id>/cwd/`: the project of a `cli` step in a
  case without one, so a sync that writes there shows.

The `.git` directory `gitInit` made in `${HOME}` or `${PROJECT}` is left out.

The sets of relative paths (escaped, above) must be equal – a file the engine should not have written fails
as surely as one it missed – and each file's bytes must be equal after the output
placeholders are applied. That includes the inputs the step left alone, the lock
(`.claude/skilletor.lock.json`, byte for byte: key order, two-space indent, final newline),
`.gitignore` blocks, `.worktreeinclude`, `.claude/settings.json` and every installed file.

Of the file modes, only the owner's executable bit is compared: the tree's files that carry
it, as a sorted JSON array of their paths as the expected tree names them (`home/…`,
`project/…`, `cwd/…`, escaped), must equal
`expected/<id>.executables.json` – no such file means none may carry it. A source file gets
the bit through its commit's `executable` list alone: the runner writes each source file
new, never copying the mode the case's own checkout gives it, so a checkout without file
modes – or with a stray bit – still builds the same commits.
Directories, empty or not, and every other mode bit are not compared.

## Comparing JSON

Both sides are compared as data in a canonical form: every object's keys sorted, every
array sorted by the canonical JSON text of its elements, recursively. So neither key order
nor the order of items, warnings or sources matters – an engine resolving sources in
parallel orders its warnings by completion – and the order the expected files show carries
no meaning. Strings, numbers, booleans and `null` compare exactly; an absent key is not a
key with `null`. Order that does matter lives in files and is compared there, byte for byte.

## Regenerating and adding cases

The TS engine is the reference, so its runner rewrites every expectation on POSIX (Windows
verification runs normally, but Windows update mode is refused because no existing oracle is
there to distinguish native separators from literal escape data):

```bash
SKILLETOR_CONFORMANCE_UPDATE=1 node --test --import ./test/setup.ts test/conformance.test.ts
```

It writes `expected/<id>.json` and, for tree steps, replaces `expected/<id>/` and writes
`expected/<id>.executables.json` (or removes it when no file carries the bit); for `cli` steps
it writes `expected/<id>.stdout` and `.stderr`, removing the one a stream left empty. It
refuses to run while `SKILLETOR_CONFORMANCE_CLI` is set, and refuses update mode on Windows
with instructions to regenerate on POSIX: the expectations are the reference CLI's, the bundle
of this checkout, with portable path spelling. Review the diff
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
| `09-templates` | `.njk` items marked `templated`; a sync renders them, a rule gated off by project vars is skipped; `check` then finds nothing; the CLI's status and resync show the skip |
| `10-error-unknown-source` | an entry naming no source is a config error; a sync touches nothing; the CLI exits 2: sync's report on stderr (text or `--json`), check's error one stderr line even with `--json` (k171), status's report on stdout |
| `11-error-bad-entry` | an entry without `@source` in `skilletor.local.json` is a config error naming that file |
| `12-missing-items` | an unknown item, an unknown bundle, an agent with `.md` and `.md.njk`: warnings, the rest resolves |
| `13-error-proto-key` | an install key only `Object.prototype` knows (`constructor`) is no type: a config error (k144) |
| `14-trust-once` | a project-only untrusted source serving two foreign entries of one bundle: one trust request (k144) |
| `15-bundle-escape` | a `\U` escape above U+10FFFF in a bundle file is that bundle's warning; the scan goes on and another bundle resolves (k144) |
| `16-frontmatter-crlf-bom` | a skill, agent and rule file with CRLF and/or a BOM keep their `description` (k144; `.gitattributes` keeps the bytes) |
| `20-sync-user` | user-scope sync of a skill, an agent and a rule: files, lock; `check`, `status`; a second sync changes nothing; the CLI's `skilletor: up to date`, `sync --json`, check exit 0 and `--json`, status text and `--json` |
| `21-sync-project` | project-scope sync: a user source's bundle and a trusted project source; `.gitignore` block, `.worktreeinclude`, `settings.json`, lock `via`; `check`, `status`; a second sync changes nothing and names no file to commit; the CLI with `--scope project` and `--project-dir` |
| `22-sync-from-lock` | a lock an earlier sync left: undeclared items removed (files, emptied dirs, an agent's `.local.` file), an edited managed file overwritten and named, the user's own skill untouched and, in the CLI's status, no orphan |
| `23-check-drift` | `check` against a lock at an older commit: the source moved on, a declared rule missing from the lock, render inputs never recorded – an edited installed file is no drift; the sync overwrites it, `check` then finds nothing; the CLI's check exits 1 (`changed`, `--json`), then 0 |
| `24-conflicts-force` | foreign files block their item (a hand-written `SKILL.md`; an agent's plain path, `replace`); `check` does not count lasting conflicts again; `--force` adopts and replaces; a CLI sync without it names the conflicts |
| `25-gitignore-false` | `"gitignore": false`: no blocks, no `.worktreeinclude`, the source's own skill `.gitignore` installed as shipped, agents still `.local.` |
| `26-agent-skills` | an agent's `skills:`: one installed, one missing (warning, `skillsMissing` in sync and status), a `plugin:skill` name unchecked; the CLI's status and resync name it |
| `27-rules` | rules of both scopes with one name each install their own `.local.` copy; a hand-written rule stays; a rules wildcard in status; the CLI with `--scope user` and `--scope project` |
| `28-claude-settings` | the plugin requirement added to an existing tab-indented `settings.json`: order, indent, a `false` entry and other keys kept, git and github marketplaces declared, a directory one refused (`settingsSkipped`); a second sync adds nothing |
| `29-executable` | a skill's executable script keeps its bit, other files and an executable agent source get none; a second sync finds the bits in place |
| `31-claude-config-dir` | `CLAUDE_CONFIG_DIR` moves Claude Code's plugin state: the settings requirement reads the install and marketplaces there, a decoy under `~/.claude/plugins` is ignored (k142) |
| `30-untrusted-status` | an untrusted project-only source: `status` names it before any sync, the sync installs nothing but writes the project's blocks, `check` lists the trust request and asks for no sync; the CLI's status, resync and check say so |
| `32-claude-config-dir-user` | `CLAUDE_CONFIG_DIR` is the user scope's `.claude`: config, skill, lock and the detection marker (`<dir>/.claude.json`) live there, a decoy config under `~/.claude` is ignored (k145); the CLI's state root is `<dir>/skilletor` |
| `33-error-source-vars` | a source's `skilletor.json` with an array as `vars` fails its scan (k145); a lock `via` that is no array of strings is refused by `readLock`, pinned by the engine's own tests (a throw is no resolve answer) |
| `40-cli-args` | the CLI's argument layer, nothing run: `--version` only first, `--help` anywhere and alone (usage bytes), the options each command accepts and an unknown one, an unknown command, an invalid `--scope` (a missing value is the string `undefined`, k170), each missing operand (an empty source name for `trust` too), an unsafe command name escaped; the config stays untouched |
| `41-cli-project-root` | no `--project-dir`: the git top level of the CLI's cwd is the project – a sync from a subdirectory installs at the top level; from a subdirectory of a home that is a checkout the project is the home, so no project scope; `~/.claude` in a work tree gets its `.gitignore` block (`gitInit`) |
| `42-cli-unused-project` | a git checkout that never used skilletor: the user scope syncs, nothing is written in the checkout, no file is named to commit (k65) |
| `43-cli-dropped-project` | a project whose `skilletor.json` is gone: status names the orphan, the sync removes it, the lock and both blocks, names nothing to commit; status `--json` reads no lock (k65) |
| `44-cli-status-targets` | status names a scope's targets unless they are Claude Code alone: a project narrowed to `codex` on a Claude-only machine is `project scope (no targets):`; its sync installs nothing there and says why |
| `45-cli-force` | `sync --force` through the CLI: a hand-written `SKILL.md` is a conflict without it, adopted and replaced with it |
| `50-hook-session-start` | SessionStart through the CLI: a project's new skill synced, the line with the block to commit (k62) and the context with the activation hint; the same SessionStart again and the prompt after it are silent; malformed stdin counts as none, the project is then the cwd's |
| `51-hook-quiet` | the hook command's quiet and odd paths: nothing declared, no event, an unknown or unsafe event (one escaped line), `--harness codex` with Claude Code alone, `--json`, `--scope` and `--project-dir` taken off the arguments, an unknown option no error; every run exits 0 |
| `52-hook-pending-report` | `hook __sync-background` (`SKILLETOR_PROJECT_DIR` over `CLAUDE_PROJECT_DIR`) syncs silently and leaves its report; the next prompt, from a subdirectory of the checkout, hands it out once under `UserPromptSubmit` (`gitInit`) |
| `53-hook-config-error` | a config error through the hooks (k86): SessionStart's one line naming the file; the background sync leaves that line, the next prompt hands it out without context, then silence |
| `54-hook-dash-ref` | a project ref starting with `-` (k85): `sync` exits 2 naming file, source and key; SessionStart, its project from the input's cwd, exits 0 with that line; git never runs |
| `55-hook-escaped-error` | a config error naming a source with control and bidi characters is one escaped line, at SessionStart and on the prompt after the background sync (k87) |
| `56-hook-no-harness` | no harness detected (`CLAUDE_CONFIG_DIR` without markers): SessionStart's one warning line, installing nothing; the background sync's report, the same line, on the next prompt |
| `57-hook-home-project` | a session started in the home dir has no project scope (k44): the user scope synced once, no `.gitignore` block; with `CLAUDE_PROJECT_DIR` the home the same, silent; the prompt after is not due |
| `58-hook-bundles` | SessionStart's sync with a good bundle and a cyclic one: the good one's skill installed, the cycle one warning in the line and the context (k48) |
| `59-hook-unused-project` | SessionStart in a project that does not use skilletor: the user scope's skill synced, the old `.gitignore` block in the project removed silently, nothing to commit (k65) |
| `60-hook-cwd-changed` | CwdChanged (k147): a move within the session's checkout syncs nothing; one from elsewhere into its subdirectory syncs the checkout's project scope at the git top level – not `CLAUDE_PROJECT_DIR`, not the user scope – with one line naming it; the same move again is silent (`gitInit`) |
| `61-hook-move-noop` | CwdChanged and PostToolUse into a git checkout without a config, a plain directory and the home dir, or without a usable cwd: silent, nothing written (`gitInit`) |
| `62-hook-move-untrusted` | a move into a checkout whose own source awaits trust: CwdChanged's line names it and `skilletor trust`, PostToolUse's context says the same; the same `cd` again is silent; nothing fetched or written (`gitInit`) |
| `63-hook-move-config-error` | a config error in the checkout moved into: `cannot sync <dir>: <error> — run there: skilletor sync`, no context, nothing written |
| `64-hook-post-tool-use` | PostToolUse against a seeded `session-cwd.json`: a `cd` within the recorded checkout asks nothing, from another one syncs with the line and a context naming the checkout; again, or a session without a record once the lock matches, is silent (`gitInit`) |
| `65-cli-no-harness` | no agent harness (`"claude": false`, Codex absent, spec §14.1): the CLI's sync, check and status exit 2 naming the markers looked for and the fix – sync's report on stderr (text, `--json`), check's one stderr line, status's report on stdout (text, `--json`); nothing installed |
| `66-cli-home-project` | the project dir is the home (k44) – `--project-dir ~`, `~/.`, or the cwd `~` outside git: no project scope; the sync names none, status says so in one line after the user scope (alone with `--scope project`, not with `--scope user`), `--json` sets `projectIsHome`; check up to date |
| `67-cli-partial` | a lock an interrupted sync left (k71), its entry `partial`, the skill's `.gitignore` never written: status marks it (text, `--json`), check exits 1 (`declaredChanged`, `layoutChanged`, `varsChanged`), the sync completes it as updated and drops the mark; status and check then find nothing |
| `68-cli-renders-empty` | a user rule gated off by the user's vars on the first sync (k35): the CLI's sync installs the skill and names the rule skipped, exit 0, the lock's `skipped` entry and no file; status's `-` mark (text, `--json`); check up to date |
| `69-cli-agent-skills` | an agent's `skills:` as a flow list (k56): the CLI's first sync installs it with one warning naming the missing skill, a `plugin:skill` unchecked; the resync's `--json` `skillsMissing`; status names it (text, `--json`) |
| `70-cli-escaped-address` | k87: an untrusted project source whose local address holds an escape sequence, a BEL, a bidi override and a newline is escaped on every CLI line naming it – status (text; `--json`, parsing back to the address), the sync's trust request, check `--json` – nothing fetched |
| `71-cli-escaped-error` | k87: a config error naming a source with those characters: exit 2, the name escaped on every stream – sync's report on stderr (text, `--json`), check's one line (with `--json` too), status's report on stdout (text, `--json`); nothing written |
| `72-cli-source-list` | `source list` (text, `--json`): the merged map's order (project, user – an index-like name first, as JSON objects order it – local), each source's origin by author mode, its merged fields in the order `git`, `ref`, `url`, `local`, `path` (a local `ref: null` unsetting the project's); `--project-dir ~` lists the user config's alone |
| `73-cli-trust` | `trust`: a project-only git source trusted for its address, then status asks for nothing and the sync installs it; a project `local` beside `git` trusted as that path, a user source as its own; an unknown name, the home as project dir and `constructor` exit 1 |
| `74-cli-source-remove` | `source remove` (k114): a name the target config lacks exits 1 naming where else it is declared (the other scope, `skilletor.local.json`, both, nowhere), nothing written; no project scope with `--project`; installed items without `--force`; an unused source removed and the file rewritten in its key order, the sync's report or `removed source`; `--force` on a used one: exit 2, the edit saved (k103) |
| `75-cli-source-remove-no-harness` | `source remove` with no harness (`"claude": false`): an undeclared name still exits 1 before any sync (k114); a declared one is removed and the sync's config error exits 2, the edit saved and named (k103) |
| `76-cli-source-remove-refused` | the one entry config load refuses (k120, an `http://` url) still in use: exit 1 without `--force`; with it removed, other keys kept, the sync's config error exit 2 with the edit saved |
| `77-cli-source-remove-refused-project` | beside a refused project entry (k120, `ref: ""`) another source's removal exits 1 with load's error; the refused entry goes with `--project`, exit 0, `removed source`; then the other one too |
| `78-cli-config-refused` | two refused entries, one per file (k120): removing either exits 1 with the other's error, `--force` or not; `source list` (`--json` too) and `trust` exit 1 with load's first error; nothing written |
| `79-cli-source-remove-stranded` | `source remove` of the entry that gives a source its only backend while other files keep entries without one (k137): exit 1 naming each file and its way out (with or without `--project`, a hand edit of the local file), `--force` or not; overrides removed first, the source goes too |
| `80-cli-escaped-source` | k87: a project source whose local address holds an escape sequence, a BEL, a bidi override and a newline – escaped in `source list` (text, `--json`) and `trust`; status then asks for no trust; `trust` and `source remove` of such a name exit 1 with it escaped, its newline a line break |
| `81-cli-escaped-remove` | k87: a source name with those characters is a config error (`source list` exits 1, escaped); `source remove` of it removes the one refused entry (k120), `removed source …` on one escaped line; an empty `source list` is an empty line, `--json` `[]` |
| `82-cli-source-remove-null` | a source entry written as `null` is declared (the reference's `sourceEntry` tells null from absent): `source list` exits 1 with load's error, `source remove` removes it, exit 0 |
| `83-cli-add` | `add` into the user config: an explicit git address (`added source …`, trusted, the sync installs what the config asked for), the same again kept as is, a local path by derived and by given name (a third operand ignored), a generic host the probe finds through `git ls-remote` (insteadOf); `source list` after |
| `84-cli-add-project` | `add --project`: written after the project config's keys, trusted (status asks for nothing), the sync installs with the project's blocks; again kept; without `--project` the user config; an invalid name refused before the missing project scope, that before the spec |
| `85-cli-add-taken` | k101: a taken name with the same backend and address – a local path spelled otherwise, a git URL of the same identity, either field of a git + local entry – is kept as written, trusted and synced (a project-only source then installs); another address or backend exits 1 naming the entry's backends and the ways out (`--project` too); only the target file counts |
| `86-cli-add-refused-entry` | k116: a kept entry config load refuses (`ref: ""`, `ref: "-x"` with `--project`, an unknown key) exits 1 with load's error for that file, nothing trusted or synced; an entry written as `null` or an array counts as another address |
| `87-cli-add-refused-spec` | refusals before any file is read: an invalid name (k95), an empty or `-` spec (k85), an `http://` or `file://` tarball (k110), a tree link whose ref or path load refuses (k119, k126), beside a project config that is no JSON; then a valid `--project` add fails on that file |
| `88-cli-add-forge-link` | k119, k126: a GitHub tree link (insteadOf) is the repo at that ref with its skills beneath the link's directory, synced; kept again, by the bare repo link and by an entry whose path names the same directory (`./perl/`, `["perl"]`); another ref, no ref, another path, no path or two paths exit 1 naming what the entry has |
| `89-cli-add-no-harness` | k103: `add` with no harness (`"claude": false`): a new source is written and the sync's config error exits 2 naming the saved file (user or project); a kept entry wrote nothing, so its exit 2 carries the sync's own report |
| `90-cli-add-probe` | the probe of a generic host: `git ls-remote` through insteadOf makes it git at `https://<host>/<path>` (a trailing `/` dropped) or `/skills`, named after the host; kept again, refused under the taken name; at 127.0.0.1:1, where nothing listens, neither git nor the HEAD on the tarball answers: exit 1 naming both URLs (the HEAD's 2xx is the engine's own test: no TLS server here) |
| `91-cli-add-escaped` | k87: an added local path with an escape sequence, a bidi override and a newline is one escaped line in the added message; a refused add naming it escapes it on stderr, its newline a line break |
| `92-cli-add-claude-config-dir` | `add` under `CLAUDE_CONFIG_DIR` (k145): the user config written there, the decoy in `~/.claude` untouched, the saved file named when the sync stops at a project install of an undeclared source (k103); a project source trusted in the state root there |
| `93-cli-available` | `available` (text, `--json`): the merged map's trusted sources in order, a source's items then its bundles; `✓` for an item an entry of either scope declares or a lock of either scope holds for that source (a `codex:` key too, a skipped entry not), for a bundle either scope's config declares; a user source read by the user config's definition, a git source fetched; a project-only source skipped until trusted, by name too (an empty line, `[]`), then listed; `--project-dir ~` the user config and lock alone |
| `94-cli-available-item-errors` | an item that cannot be built (k100, k113, k126): listed once with `error:` on its second line – `x.md` beside `x.md.njk`, `SKILL.md` beside `SKILL.md.njk` (no description), a companion file in both forms, a name a source's `path` finds twice; `--json` carries it |
| `95-cli-available-bundles` | `available`'s bundles: members expanded through an include and an entry of another source as written, sorted; `(no items)`; `error:` for an unknown key, a cycle, an address config load refuses (k115), `.yaml` beside `.yml`; `--json` members and the bundle's own vars; `✓` from the user or the project config |
| `96-cli-available-escaped` | k87: a skill's description, a bundle's and a bundle file's key in its error with control and bidi characters escaped on their lines, umlauts, an emoji and a tab as written, `--json` parsing back; an unknown source with them exits 1, escaped |
| `97-cli-available-refused` | `available` exits 1, nothing on stdout: an unknown name, a missing local directory, a failing scan, any of them among all sources, a config load refuses, a lock that is no object; the source named alone still lists |
| `100-codex-user` | Codex alone (`"claude": false`, a `~/.codex/config.toml` without hook trust): the user sync installs the skill in `~/.agents/skills`, the agent as `~/.codex/agents/.local.helper.toml`, the rule as its section of `~/.codex/skilletor-rules.md` and the pointer block in `~/.codex/AGENTS.md`; one run warning that Codex has not trusted the SessionStart hook, in status too; check up to date, a resync changes nothing; the CLI's resync (text, `--json`), check and status |
| `101-codex-project` | Claude Code and Codex (hook trusted) in the project scope: each its own copy of skill, agent and rule, the pointer appended to the project's own `AGENTS.md`, a `.gitignore` block in `.claude` and in `.codex`, `.worktreeinclude` naming every root; no run warning; check, status, a resync changes nothing; the CLI's status names both targets |
| `102-codex-convert` | what the Codex mapping refuses or warns about: an agent whose `codex` is no mapping installs with a warning, one without a description and a rule holding a skilletor marker line install nothing, a rule that renders empty is skipped and gets no section; the resync says the same; the CLI's resync text |
| `103-codex-agents-md` | the pointer's warnings (`project_doc_max_bytes = 200`): a `~/.codex/AGENTS.md` with malformed markers gets no pointer, the rules file still written; a project `AGENTS.md` over the limit gets it and a warning that it may be cut off; an `AGENTS.override.md` beside it, that Codex reads that instead; the resync warns the same |
| `104-codex-migrate` | a lock entry of the first design (block, keyed `AGENTS.md`) whose source cannot be resolved keeps its section, read from the old block in `~/.codex/AGENTS.md`, now in `~/.codex/skilletor-rules.md`, the entry rewritten silently; a section edited by hand is overwritten and named; the old block becomes the pointer, the user's text kept; check, status, a resync overwrites nothing |
| `105-codex-off` | Codex no longer in use (its `config.toml` gone): a sync removes the skill in `~/.agents/skills`, the agent's TOML, the rules file and the pointer block, the user's text in `~/.codex/AGENTS.md` kept; Claude Code gets its copies; check and status after |
| `106-hook-codex-rules` | SessionStart under `--harness codex`: a new session's context starts with the user's rules file, then the project's, the report (its warning too) after them; with nothing to sync, `startup`, `clear`, a missing and a `null` source get exactly the rules, `resume` none; without `--harness codex` no rules, nor on the prompt |
| `107-hook-codex-prompt-move` | Codex's prompt hook follows a move (k149, `gitInit`): a session started outside any project, then a prompt in a checkout with a config – its project scope synced before the prompt returns, line and context naming it, the pending report waiting there joined to both; the same prompt again and one from a subdirectory are silent |
| `108-hook-codex-config-error` | SessionStart under Codex with a config that does not load: the line names the error, the context is the last good rules files as they are on disk, nothing written; without `--harness codex` the line alone |
| `110-hermes-user` | Hermes alone (`"claude": false`, the user config's `"targets": ["hermes"]` – Hermes is never detected), `gitInit` home: the user sync installs the skill in `~/.hermes/skills` with its own `.gitignore`, the agent and the rule nowhere, one run note naming them; the user's `~/.hermes/.gitignore` kept byte for byte, no managed block in it (`~/.claude` gets its own); check, status, a resync changes nothing; the CLI's resync (text, `--json`: up to date with the note), check and status (`user scope (hermes):`) |
| `111-hermes-project` | Claude Code and Hermes in a git project: the skill in `.claude/skills` and `.hermes/skills`, the agent for Claude Code alone with one run note; a `.gitignore` block in `.claude`, none in `.hermes`, the user's `.hermes/.gitignore` kept; `.worktreeinclude` names `/.hermes/skills/` among the roots; check, status, a resync; the CLI's status and resync |
| `112-hermes-codex-project` | Codex (hook trusted) and Hermes, `"claude": false`: the user skill gets a copy in `~/.agents/skills` and in `~/.hermes/skills`; the project's two skills only the Codex copy in `.agents/skills`, which Hermes reads – no `.hermes` in the project, one run note saying so; check, status; the CLI's resync (text, `--json`) and status |
| `113-hermes-home-move` | the one Hermes home a user-scope lock serves (spec §16.2): a CLI sync under `HERMES_HOME=~/hermes-a` installs there, status without `HERMES_HOME` serves the recorded home; under `~/hermes-b` check exits 1 (`--json` `targetsChanged: ["user"]`), a project-scope sync leaves the move to the user scope, the user sync removes both items from `~/hermes-a` with one warning and installs under `~/hermes-b` (a file already there a conflict); a plain CLI sync meets that conflict again (the new home recorded); an engine sync with the default home moves to `~/.hermes`; a last CLI sync is up to date |
| `114-hermes-upgrade` | upgrade from the auto-detecting build: a lock with a Hermes entry and its home recorded (`~/hermes-a`), no `"targets"`, Claude Code alone detected: status names the entry an orphan, check counts it as `targetsChanged`; a CLI sync under `HERMES_HOME=~/hermes-b` removes it from the recorded home, Hermes' own files kept; check after up to date |
| `115-hermes-codex-takes-over` | a project lock holding Hermes' own copy of a skill once Codex is a target too (`["codex", "hermes"]`, hook trusted, `"claude": false`): check counts `targetsChanged` for the project; the sync removes the `.hermes/skills` copy and installs the Codex copy that serves Hermes, with the run note; check then finds nothing; the CLI's status and resync |
| `116-hermes-not-opted-in` | a Hermes home in use (`HERMES_HOME`) is no target until the user's `"targets"` name hermes, and a project cannot add it: with the project narrowed to `["hermes"]`, the CLI sync installs the user skill for Claude Code, nothing in the project or the Hermes home, with the project's warning; status says `project scope (no targets):`; check |
| `117-hook-hermes-session-start` | SessionStart under `--harness hermes` (Hermes alone, `HERMES_HOME=~/srv/hermes`): the sync installs in that home and answers with the line and the context, the agent's note left unsaid; again, and the prompt hook, silent; a CLI sync without `HERMES_HOME` serves the recorded home – up to date with the note, the tree unchanged |
| `118-hook-hermes-opt-in` | SessionStart under `--harness hermes` while `hermes` is no target (spec §16.4): the sync's line and context each end with the opt-in line (`"targets": ["claude", "hermes"]`), nothing synced for Hermes; a resumed session with nothing to do gets that line alone; Claude Code's and Codex's SessionStart and Hermes' prompt hook never say it |
| `119-hook-hermes-opt-in-warning` | Claude Code and Codex (hook trusted) detected: the opt-in line names `["claude", "codex", "hermes"]` and follows the sync's warning in the line and at the end of the context; Codex's SessionStart gives its rules context and no such line |
| `120-hook-hermes-config-error` | SessionStart under `--harness hermes` with a user config that does not load: the error line, no opt-in line (the targets cannot be read), no context, nothing written |
| `121-hook-hermes-prompt-move` | Hermes' prompt hook follows a move (k149, `gitInit`): the checkout's project scope synced into `.hermes/skills` before the prompt returns, the line and the context naming it and the `hermes skills trust` it may need (k152), the pending report joined to both; the same prompt again and one from a subdirectory are silent |
| `122-hook-hermes-move-codex-copy` | the move into a checkout where Codex (hook trusted) is a target too: the skill lands as the Codex copy in `.agents/skills`, which Hermes reads, so the line and the context still name `hermes skills trust` (k152) |
| `123-hook-hermes-move-agent` | a move into a checkout that installs only an agent (Claude Code and Hermes targets): the agent synced and named, the run note left unsaid, no `hermes skills trust` (k152) |
| `124-hook-hermes-claude-move` | Claude Code's PostToolUse with Hermes the only target: the move syncs the Hermes copy and answers without `hermes skills trust` – the hint follows the harness whose hook runs, not the targets (k152) |
| `125-hook-hermes-move-removal` | a move into a checkout whose lock holds a Hermes skill the config no longer declares, its blocks in place: removed, one line `skilletor: 1 removed in ${PROJECT}`, no `hermes skills trust` (k152) |
| `126-cli-claude-config-dir-non-ascii` | non-ASCII CLAUDE_CONFIG_DIR is decoded once: config edits, installation, CLI/engine status and diagnostics use the same UTF-8 path |
| `127-cli-codex-home-plugin-root-non-ascii` | non-ASCII CODEX_HOME and CLAUDE_PLUGIN_ROOT retain their paths; Codex output and warning paths match, and the correct installed plugin marketplace is selected |
| `130-cli-install-wildcard` | `install` of a wildcard: `*` without a type prefix exits 1 naming the three prefixed forms; `rule:*@shared` stored as `*@shared` under `install.rules`, the compact user config rewritten as two-space JSON in its key order, every rule installed; `skill:perl-*@shared` and `agent:*@shared` (nothing matches yet) stored as written; status marks each item `via` its wildcard and counts them |
| `131-cli-install-bundle` | `bundle:perl@shared` beside `rule:go-*@shared`: `perl@shared` under `install.bundles`, before the pattern's `install.rules`, the bundle's rules and the pattern's installed; status `via` both, available's `✓`; a bare `tools@shared` only a bundle has is that bundle; the same bundle again is up to date; `--project` writes it into the project config |
| `132-cli-install-item-errors` | an item that cannot be built (k100, k113): exit 1 before any edit, `skilletor: <source>: <type> <name>: <error>` – `x.md` beside `x.md.njk`, `SKILL.md` beside `SKILL.md.njk` by its typed name, a companion file in both forms named after an intact item; config byte-identical, the intact items then install |
| `133-cli-install-missing-sources` | a bundle's entries of other sources no configured source serves, stdin no TTY (spec §15.6): exit 1 before any edit, one `skilletor add <name> <spec>` line per address, across bundles too, `-2` when another address holds the name, `source` for a spec without a usable name (k95), ` --project` with --project; an address load refuses is the bundle's error (k115); configured under another name, the bundle installs from it |
| `134-cli-install-missing-taken` | k102: the user config's `peter` is a local override, only the project's has the bundle's address: the command printed is `skilletor add peter-2 …`, both configs byte-identical; with --project the merged `peter` serves it and the rule installs from the local checkout |
| `135-cli-install-home-project` | `install --project` without a project scope (k44): `--project-dir` the home, or run in the home outside git, exits 1 naming the home and the ways out, nothing written; without --project the item installs into the user scope |
| `136-cli-install-escaped` | k87: an item naming a source with an escape sequence, a BEL, a bidi override and a newline exits 1 with `unknown source: …` escaped, its newline a line break; so does an item without `@` holding them |
| `137-cli-install-refused` | install's refusals in the reference's order, exit 1, every file byte-identical: an item that is not name@source, an unknown type prefix, an empty name, a pattern over bundle names or without a type; an unknown source, a project-only one (naming --project), an untrusted one (a wildcard of it too); an unknown item with the first eight suggestions, an ambiguous name, an unknown or broken bundle; a missing local directory, a config load refuses; a valid item before a failing one |
| `138-cli-install-explicit` | explicit items of a git source, fetched under the sync lock: a bare name's type from the catalog, stored after the config's own keys in their order; a typed name two types share and two items in one run; the same again is up to date; --project creates the project config's `install` after its own keys |
| `139-cli-install-no-harness` | k103: install with no harness (`"claude": false`): the entry written, then exit 2 with the sync's config error and the saved file – the user's, or the project's with --project – on stderr; an item install refuses still exits 1 before any edit |
| `140-hook-input-shape` | hook stdin that is null, a scalar or an array, and an invalid `cwd`, are ignored safely; every hook invocation still exits 0 |
| `141-project-evidence-claude` | explicit machine targets Claude and Codex, but Claude-only project evidence selects only Claude and stays stable across check, status and resync |
| `142-project-evidence-codex` | explicit machine targets Claude and Codex, but Codex-only project evidence selects only Codex and stays stable |
| `143-project-evidence-both` | Claude and Codex project evidence selects both targets in stable machine order |
| `144-project-target-explicit` | committed project `targets` override contrary project evidence while remaining inside the machine allowlist |
| `145-project-target-local` | local project `targets` override committed targets and contrary project evidence |
| `146-project-target-ambiguous` | generated-only roots leave a multi-target project unresolved; check and repeated sync warn and preserve managed and foreign files |
| `147-project-target-single` | a project without evidence bootstraps from the sole machine target |
| `148-project-target-cleanup` | Claude evidence deselects Codex, removes only Codex-owned files, preserves a foreign residual file and remains stable on resync |
| `149-project-settings-evidence-preservation` | same-marketplace plugin setup would erase genuine Claude evidence: with gitignore disabled, the settings write is skipped, both target copies stay, and check/resync/alternating hooks remain stable without perpetual drift |
| `151-cli-available-entry-refused` | available rejects a non-object lock entry with a keyed lock error instead of an internal TypeError |
| `152-cli-available-name-case` | installed item names match the available catalog ignoring case, while source aliases remain case-sensitive |
| `153-cli-sync-files-refused` | sync rejects a null ownership files map with a keyed lock error and preserves the existing lock and file tree |
| `200-cli-uninstall-explicit` | explicit uninstall after a sync: a type prefix removes only that type and its files; a bare name removes every type; the last entry removes the last file, `install` object and empty lock |
| `201-cli-uninstall-wildcard` | an explicit item also covered by a wildcard is removed with a stderr warning but stays installed; without the explicit entry the lock-confirmed item is refused naming its typed wildcard; an absent matching name gets the conditional wildcard diagnostic; removing a typed wildcard removes only its type; a bare wildcard is refused |
| `202-cli-uninstall-bundle` | an explicit item also covered by two bundles is removed with a warning naming both; without the explicit entry the lock-confirmed item is refused with both bundle commands; `bundle:` removes one declaration, a bare bundle name the other and its item; an absent bundle is refused |
| `203-cli-uninstall-scope` | a typed item declared under another type names it; an item or bundle declared in the project points to `--project`; one bad request leaves an earlier valid one untouched; `--project` removes project entries, while the home as project dir is refused |
| `204-cli-uninstall-ambiguous` | item and lock names match ignoring case; a bare name held as both an explicit item and a bundle is ambiguous and changes nothing; prefixes then remove the bundle and item separately |
| `205-cli-uninstall-no-harness` | k103: an undeclared item is refused before a sync; a valid user or project removal is saved, then the no-harness sync error exits 2 and names the edited config file |
| `241-include-syntax-error` | k160: a syntax error in an included template becomes a warning without a delayed process crash; the unaffected skill is installed and owns its lock entry, while the failed skill is absent |

The state files – `render-inputs.json` with its hash, `sources-read.json`, `unreached.json` –
are not compared here: their keys are absolute lock paths and the hash covers the project dir,
so they differ from one temp dir to the next.

Not covered yet: `available` waiting for the sync lock another run holds (k74;
`test/commands.test.ts` pins it); of `add`, a generic host whose tarball answers the probe's
HEAD (it needs a TLS server; no test pins it yet); the bytes `trust` and `add` write to
`trust.json` (state, outside the compared trees; the engine's own tests pin them); the Hermes home a user-scope lock serves as
recorded in `hermes-home.json` (state, outside the compared trees; cases 113, 114 and 117 prove
it through the syncs that follow, the engine's own tests pin the record); of the hooks, a due
prompt's real background sync, the in-session interval, the sync lock held by another run – a
move's wait on it and the race of one `cd`'s two hooks too – and the 20 s pre-write deadlines
of SessionStart and checkout moves (the engine's own tests pin these, the interval on an
injected clock, the deadlines injected); a `url`
source actually fetched (the engine takes `https://` only, so it needs a local TLS server), a
source whose fetch fails (the warning quotes git's own message), symbolic links in a target –
a `CLAUDE.md` that is the Codex `AGENTS.md`, an `AGENTS.md` that is a link –, and a sync that fails midway
(`partial`; `67` starts from the lock one left). Starting a CLI from an already-removed
working directory is covered by child-process tests in `test/cli.test.ts` (k192, k193); the shared case format does not remove the running process's
cwd.
