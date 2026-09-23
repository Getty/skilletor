# Bundles — full reference

A bundle names a set of items in a source so a config declares one entry instead of a
list. Declared as `name@source` under `install.bundles`; expanded against the source on
every sync, like a wildcard.

## The file

`bundles/<name>.yaml` or `bundles/<name>.yml` in the source — both for one name is an
error for that bundle. skilletor's YAML subset: mappings, block and flow lists, plain and
quoted scalars; no anchors, aliases or tags.

```yaml
# bundles/perl.yaml
description: Everything for Perl projects
skills:
  - "perl-*"                   # a leading * must be quoted in a block list
  - testing
  - karr@gitlab.com/peter      # an item of another source, by address
agents: [perl-reviewer]
rules: [perl-*, "*-style"]
bundles: [base]                # bundles/base.yaml of this source, included
vars:
  perl_version: "5.40"
```

| Key | Meaning |
|---|---|
| `description` | Required. Shown by `skilletor available` |
| `skills`, `agents`, `rules` | Names or patterns of that type: bare = this source, `name@<spec>` = another source by address |
| `bundles` | Other bundles of **this** source, bare names only (no `@`, no patterns); nested recursively |
| `vars` | Var defaults for the items this bundle yields |

Any other key is an error. Unquoted `- *-style` in a block list fails to parse
("anchors, aliases and tags are not supported"); inside a flow list (`[*-style]`) it works,
but quote it anyway.

## Installing

```bash
skilletor install bundle:perl@shared [--project]   # adds "perl@shared" to install.bundles, then sync
skilletor install perl@shared [--project]          # same, if no skill/agent/rule of shared is named perl
skilletor uninstall bundle:perl@shared [--project] # removes the entry; its items go on sync
```

A bare `perl@shared` that also matches an item fails: `"perl" is ambiguous in shared; use
one of: skill:perl@shared, bundle:perl@shared`. There are no patterns over bundle names.

## Expansion

Per type: names and patterns, then the included bundles, depth first. A cycle
(`a` → `b` → `a`) is a bundle error naming the cycle.

- An item reached through several bundles of the same source installs once.
- A pattern that matches nothing, or a name the source lacks, warns:
  `bundle perl@shared: pattern rule:nomatch-* matches nothing`.
- Bundle items join the wildcard overlap rules: an explicit entry wins (silent for the
  same source, warning for another: `rule "perl-style" from bundle:perl@shared ignored:
  explicitly declared as perl-style@pete`); the same name from two different sources is
  skipped with a warning and an installed copy stays.
- Empty-render skip and `targets` apply unchanged.

## Vars

`source defaults < bundle vars < user < project < local`

- Bundle vars reach only the items that bundle yields. An item declared explicitly gets
  **no** bundle vars, even when a bundle also yields it.
- Nested: the outer bundle wins (`perl` includes `base`, both set `perl_version` →
  `perl`'s value).
- Two chains set one key differently for the same item (`perl`→`base` and `ci` both reach
  `commit-style`) → neither applies to that key; the item falls back to the source default
  and the report warns once naming both bundles.
- For an item of another source, "source defaults" are that source's `skilletor.json`.

## Items of other sources

`name@<spec>` (patterns too: `perl-*@gitlab.com/peter`). `<spec>` is the `skilletor add`
shorthand, restricted to forms that resolve without a network probe:

| Allowed | Refused (bundle error) |
|---|---|
| `Getty`, `Getty/repo`, `gitlab.com/peter`, `hf.co/user`, `https://…`, `https://….tar.gz` | generic host `example.org/foo` (write `https://example.org/foo`), local paths `~/…`, `./…`, `/…` |

- **Matching is by URL, not config name.** The entry is served by whichever configured
  source (visible to the bundle's scope) has the same resolved `git`/`url`; case of host,
  trailing `/` and `.git` are ignored. Calling it `pete` instead of `peter` is fine; a
  `local`-only source never matches. A `local` override of a matched source (author mode)
  still applies.
- **`install bundle:…` on a TTY** asks per missing source:
  `bundle perl needs a source you don't have yet: gitlab.com/peter → https://gitlab.com/peter/skills — add it as [peter]? (name, or n to skip)`.
  A name adds it to the config the bundle goes into, exactly like `skilletor add` (that is
  the act of trust); `n` leaves those items to the sync warning below.
- **Without a TTY** `install` exits 1 before editing anything and prints the commands:
  `skilletor add peter gitlab.com/peter --project`. Run them, then install again.
- **`sync` and the hooks never add a source** — a trusted source must not pull in an
  untrusted one. One warning per missing source and bundle
  (`bundle perl@shared needs gitlab.com/peter (https://gitlab.com/peter/skills): run skilletor install bundle:perl@shared`);
  those items are skipped, installed copies stay, everything else syncs.
- A source only in the project config and not yet trusted counts as present — the usual
  `skilletor trust` request applies.

## Errors

A broken bundle affects only itself; other entries sync and items it installed before
stay. Broken = not in the catalog, unparseable, unknown key, no `description`, both `.yaml`
and `.yml`, a refused `@<spec>`, a cycle. `available` shows the error under the bundle.

## Seeing it

- `available [source]`: type `bundle`, description, expanded members on the next line
  (`skill:karr@gitlab.com/peter`, …) or the error; `--json` adds `members` and `vars`.
- `status`: items `✓ skills/perl-moo @shared via bundle:perl@shared` (`via` in `--json`),
  one line per bundle `* bundle:perl@shared (7 installed)`.
- The lock records items only, each with `"via": ["bundle:perl@shared"]`; a bundle has no
  lock entry.
- `uninstall rule:perl-style@shared` on a bundle-only item exits 1 and names the bundle:
  uninstall `bundle:perl@shared`, or gate the item via vars (empty render = skipped).
