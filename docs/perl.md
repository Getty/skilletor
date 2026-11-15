# The Perl port (`perl/`, dist `Skilletor`)

Decision record for karr #143 (2026-10-19, Getty: "own Perl dist in the skilletor repo,
same flow as TS, shared conformance fixtures against divergence").

## Why

langertha-raider, a Perl coding agent, should behave as much like Claude Code as it can.
That means offering the same skills, agents and rules that skilletor installs, and loading
a skill or agent straight from its source ("skill as include"). It should do this without
Node and without plugins. So skilletor's resolution has to run in Perl, and it must not
drift away from what the TypeScript engine does.

## Shape

- **The TypeScript engine stays the reference.** The Perl port follows it, never the
  other way round. When the two disagree, TS wins unless TS has a bug. A TS bug gets
  its own commit with a TS test, and the Perl port then follows the fixed behaviour
  (for example the corrupt tar size check, 90d3842).
- **Shared state, not just shared formats.** Perl reads the same config files
  (`~/.claude/skilletor.json`, `<proj>/.claude/skilletor.json`,
  `<proj>/.claude/skilletor.local.json`). It fetches into the same cache dirs, which
  are named by the same identity hash as `gitCacheName`/`urlCacheName`. It writes the
  same `trust.json` and state records and takes the same sync lock. A TS run and a Perl
  run on one machine share one fetch and never write at the same time.
- **Byte-identical JSON.** Lock, state and config edits must come out with the same
  bytes as `JSON.stringify(x, null, 2)`. That is why the port has its own JSON layer
  (`Skilletor::JSON`, which keeps key order and matches JS escaping and number output)
  instead of JSON::MaybeXS's pretty printer. For the same reason it ports TS's own tar
  reader, gzip handling and YAML subset (frontmatter, bundles) rather than using
  Archive::Tar or YAML::PP: the cache trees and error messages have to match.
- **Moo**, so the dist stays lean. Moose consumers like raider take Moo classes as they
  are.
- **Templates through Text::Nunjucks.** A sync renders `.njk` items with
  Text::Nunjucks, a 1:1 Perl port of the Nunjucks 3.2.4 the reference uses, through a
  loader confined to the source root as the reference's is (`Skilletor::Render::Loader`).
  The port converts its JSON values at the boundary (null, booleans, key order), and
  `t/53-parity-render.t` renders the same templates with both engines. Render context is
  constructed only when an item actually renders a `.njk` file, companions included, and
  reused within that build; plain copies do not require an OS passwd entry (k161).
  Text::Nunjucks needs Perl 5.40 and is not on CPAN yet.
- **Claude Code, Codex and Hermes targets** for sync/check/status (Codex since k184, Hermes
  since k185).
- **Project-local target defaults** (k229) match the reference: user `targets` sets the
  machine allowlist and user-scope targets; explicit project/local targets select a subset.
  Otherwise genuine project-owned harness files choose it, never skilletor's own artifacts.
  A sole machine target bootstraps a new project; an ambiguous multi-target project is left
  unchanged with a warning. User-only operations do not read project evidence or its lock.
  See [`superpowers/specs/2026-11-15-project-targets-design.md`](superpowers/specs/2026-11-15-project-targets-design.md).
  Automatic Claude plugin settings are also guarded: a proposed write that would change
  inferred targets is skipped, with an explicit-targets-then-sync warning (k234). Both
  engines keep settings and inferred targets stable while synchronizing items normally;
  they record no provenance and do not turn the skipped settings update into perpetual
  `check` drift.

## Against divergence: `conformance/`

The cases live in `conformance/cases/<NN-slug>/` and are language-neutral: JSON plus
plain file trees, with the format given in `conformance/README.md`. Each case has a
config, source trees (git sources are built as real repos and reached offline through
`insteadOf`), steps (`resolve`, `sync`, `check`, `status`, and `cli`, which runs a whole
command line) and the expected results. `test/conformance.test.ts` and
`perl/t/60-conformance.t` both run every case and compare the outputs as canonical data,
and the installed files byte for byte; a `cli` step's exit code, stdout and stderr are
compared as bytes. Each runner takes the CLI to run from `SKILLETOR_CONFORMANCE_CLI` (a
JSON argv prefix), so either runner can hold the other implementation's CLI to the same
cases. A case
expects a different outcome in Perl only where it says so explicitly under
`engines.perl`, with the reason given; no case does today.

The expectations are generated from TS (`SKILLETOR_CONFORMANCE_UPDATE=1 npm test`) and
then hand-reviewed against the design spec, because an expectation that only mirrors the
code proves nothing. Beside the cases, the Perl suite replays recorded TS outputs
("oracles", made by `perl/maint/*.mjs`) and runs parity tests (`t/5x-parity*.t`) that
drive both engines live against the same remotes and cache.

## The raider API

`Skilletor->new(home => …, project_dir => …)` provides the following:

- `resolve` returns TS `resolveItems`, field for field.
- `resolve_skill`, `resolve_agent` and `resolve_rule` return a path into the source or
  cache, with nothing installed.
- `resolve_item` and `items` return the item records.
- `sync`, `check` and `status` work for the Claude Code, Codex and Hermes targets.

Decisions that differ from the TS engine on purpose:

- **No detected harness needed to resolve.** TS `resolveItems`, like sync, stops with
  "no agent harness detected". Resolving does not depend on a harness, and raider runs
  where neither Claude Code nor Codex is installed. `require_harness => 1` restores the
  TS behaviour, and the conformance runner uses it.
- **Fetch policy.** `fetch => 'always'` is the default and matches TS. `'missing'`
  fetches only sources that have no cache yet. `'never'` uses no network at all. raider
  resolves at startup, so it can choose not to wait on the network.
- **Precedence per type, as in Claude Code.** TS installs an item in both scopes and
  needs no lookup rule. A lookup by name does need one, and the rule follows Claude
  Code's documented behaviour:
  - skills: personal (user) over project;
  - agents: project over user;
  - rules: no shadowing, both load with user first. `resolve_rules($name)` returns
    both, user first. `resolve_rule($name)` throws `Skilletor::Error::Ambiguous` when
    both scopes declare the rule and no scope is given, because any single answer
    would hide a rule Claude Code does load.
- **`.njk` items in a lookup.** `resolve_skill` and its siblings serve files of the
  source tree, so they refuse a templated item with `Skilletor::Error::Unsupported`
  rather than serve an unrendered template; a sync renders it. TS has no lookup to
  match.
- **Hermes as the CLI has it.** Skills only, in the Hermes home's `skills` (`$HERMES_HOME`,
  else the recorded home, else `~/.hermes`) and `<repo>/.hermes/skills`, with no managed
  `.gitignore` block; never auto-detected as a machine target, enabled there only through the
  user config's `"targets"`. Project selection follows the evidence, override and bootstrap
  rules above; in a project with Codex active, the Codex copy serves Hermes.
  One home per user-scope lock,
  recorded in `hermes-home.json`; a sync under another home moves the items first and warns.
  `Skilletor::Engine` takes `hermes_home` as the CLI takes `HERMES_HOME`.
- **Report text.** `Skilletor::Report` ports the CLI's sync, status and check text and
  exit codes, so raider can show the same lines the CLI prints.

## Fixture names

A fixture tree must not hold a live `.gitignore`. Inside the repository git would apply
it to the fixture files next to it, and the expected lock and items would never get
committed. That happened to the first sync cases. So a path segment starting with
`.git` is stored as `dot.git…` (`dot.gitignore`). Both runners unescape these names when
they copy a tree in and escape them when they write or compare expectations, and they
fail a case that holds an unescaped name.

## Proof of shared state

`perl/t/52-parity-sync.t` syncs one machine from the same starting state with TS and with
Perl, and requires the following to come out byte-identical:

- the reports and the installed trees;
- the lock;
- `render-inputs.json`, `sources-read.json` and `unreached.json`.

It also requires each engine's `check` to accept the other engine's sync.

`perl/t/54-parity-cli.t` does the same for the two command lines (`node dist/skilletor.js`
and `bin/skilletor`): it restores one saved machine before each CLI runs, so both run in the
same paths, and compares exit codes, both streams and every file under the temp dir as raw
bytes – the lock, `render-inputs.json`, `sources-read.json`, `unreached.json`, trust and the
hooks' records included. It drives five conformance cases, git's failure wording, a template
rendered with the real host and user, and one sync lock that either CLI holds while the
other's `sync` and SessionStart wait or time out. It skips without node or the bundle.

## Known gaps

- The Codex target is ported (k184): skills in `.agents/skills`, agents as TOML, the rules
  file with its `AGENTS.md` pointer, its warnings and the migration of a first-design rules
  block, and the warning while Codex has not trusted skilletor's SessionStart hook; its
  conversion came with k183
  (`Skilletor::Convert`, `Skilletor::TOML`). The Claude hooks are ported
  (`Skilletor::Hooks`, k181): `hook session-start`, `hook user-prompt-submit` and its detached
  background sync (`hook __sync-background`; a PAR-packed binary re-runs itself through
  `PAR_PROGNAME`, plain perl re-runs `$^X` with the script), and the checkout-move hooks
  (`hook cwd-changed`, `hook post-tool-use`, k147; ported in k182). Under
  `--harness codex` a new session's context starts with the Codex rules files and the prompt
  hook follows a move (k184); under `--harness hermes` SessionStart ends with the line saying
  how to opt in while `hermes` is no target, and the prompt hook follows a move, naming
  `hermes skills trust` once a skill Hermes loads landed (k185).
  The Perl CLI (`bin/skilletor`) runs `sync`, `check`, `status` (k173), `trust`, `source list`,
  `source remove` (k175), `add` with the probe of a generic host (k176: `git ls-remote`, then a
  HEAD on the tarball through HTTP::Tiny in the process, so a packed binary needs neither Node
  nor Perl for it), `available` (k177), `install` (k178), `uninstall` (k179), and the hooks.
  Shared cases 130–139 and 200–205 cover the two config-edit commands against both CLIs.
  The default plugin launchers still use Node: packed-binary platform verification,
  performance checks and activation remain gated under k166/k191.
- Windows is untested. The process layer has a Windows path (k186: `run_command` through
  temp files on a no-wait spawn, `spawn_detached` through Win32::Process, the sync lock
  refreshed by its holder instead of a forked child), exercised on Linux through an injected
  seam; nothing has run on real Windows yet. Known open points: k207 (a dead lock owner),
  k209 (non-ASCII paths), k210 (the Windows binary's modules and smoke).
- There are no conformance cases for a `url` fetch (it needs TLS), for symlink
  conflicts, or for partial syncs. `perl/t/62-engine.t` covers partial syncs.

Known divergences are kept on karr #143. The TS oddities the port found (duplicate trust
requests, a `\U` escape above U+10FFFF aborting a source scan, a lost `description` with CRLF
or a BOM, an inherited object key such as `constructor` accepted as an install key or a forge,
a non-string install entry crashing `removeInstallEntries`) were fixed in the reference
(k144) and are pinned by cases 13 to 16 and the oracles in `perl/t/data/`; the port mirrors
none of them any more.
