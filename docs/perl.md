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
- **No templates.** `.njk` items are reported as unsupported, never rendered. No
  template is used across Getty's fleet, and a second Nunjucks implementation would be
  a constant source of divergence.
- **Claude target only** for sync/check/status. Codex and Hermes stay TS-only.

## Against divergence: `conformance/`

The cases live in `conformance/cases/<NN-slug>/` and are language-neutral: JSON plus
plain file trees, with the format given in `conformance/README.md`. Each case has a
config, source trees (git sources are built as real repos and reached offline through
`insteadOf`), steps (`resolve`, `sync`, `check`, `status`) and the expected results.
`test/conformance.test.ts` and `perl/t/60-conformance.t` both run every case and
compare the outputs as canonical data, and the installed files byte for byte. A case
expects a different outcome in Perl only where it says so explicitly under
`engines.perl`, with the reason given (for example `.njk`).

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
- `sync`, `check` and `status` work for the Claude target.

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
- **`.njk` items in a sync.** A templated item is never installed unrendered. The sync
  warns, keeps any installed copy and its lock entry, and records the source as not
  reached. That keeps the scope open for both engines' `check`, so the next TS sync
  (the hooks) renders the item. If Perl recorded the scope as complete, TS `check`
  would go quiet and the item would never be installed. Case 09 pins this in
  `expected.perl/`.
- **Other harnesses are refused, not half-written.** A scope that targets Codex or
  Hermes is refused with an error, and nothing is touched. The same goes for a sync
  that would change Codex or Hermes state (their lock entries, `block` entries, the
  Codex rules file).
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

## Known gaps

- Codex and Hermes targets are not ported, and neither are `hooks.ts` or pending reports.
- Windows is untested.
- There are no conformance cases for a `url` fetch (it needs TLS), for symlink
  conflicts, or for partial syncs. `perl/t/62-engine.t` covers partial syncs.

Known divergences are kept on karr #143. The TS oddities the port found (duplicate trust
requests, a `\U` escape above U+10FFFF aborting a source scan, a lost `description` with CRLF
or a BOM, an inherited object key such as `constructor` accepted as an install key or a forge,
a non-string install entry crashing `removeInstallEntries`) were fixed in the reference
(k144) and are pinned by cases 13 to 16 and the oracles in `perl/t/data/`; the port mirrors
none of them any more.
