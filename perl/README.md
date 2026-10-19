# Skilletor

Install skills, agents and rules from remote sources – the Perl port of
[skilletor](https://github.com/Getty/skilletor).

skilletor's reference implementation is TypeScript (`../src`). This
distribution is its Perl port, for Perl programs that must resolve skills,
agents and rules exactly as skilletor does – the same config files, the same
source cache (`~/.claude/skilletor/cache`, one fetch serves both), the same
`trust.json`, the same bytes in every JSON file, the same error messages –
and sync them into Claude Code's directories as the CLI does, without Node.

## Installation

```bash
cpanm Skilletor
```

## Usage

### Skilletor – where is skill X?

A skill as an include – the file to read, straight from the source tree or
the shared cache:

```perl
use Skilletor;

my $sk = Skilletor->new( home => $ENV{HOME}, project_dir => $project );

my $file  = $sk->resolve_skill('perl-moo');  # …/.claude/skilletor/cache/<hash>/skills/perl-moo/SKILL.md
my $agent = $sk->resolve_agent('reviewer');  # undef when no scope resolves to it
my @rules = $sk->resolve_rules('style');     # every scope's rule of the name, the user's first
my $rec   = $sk->resolve_item( skill => 'perl-moo' );
# { type, name, scope, source, version, source_dir, path, dir, file, files,
#   description, vars, declaredBy, via?, templated, templates }

my $all    = $sk->items( type => 'rule' );    # every record of a type, by its precedence
my $report = $sk->resolve( scope => 'all' );  # the reference's resolveItems, field for field
```

An item is resolved as a sync would install it – config merge, trust, sources
fetched into the shared cache, wildcards, bundles and the overlap rules – but
nothing is installed: the paths point into the `local` directory or the cache
dir the item lies in.

- **Precedence per type, as Claude Code has it:** both scopes may declare an
  item of one name; a lookup without `scope` follows Claude Code's documented
  rules (names ignore case).
  - Skills: the **personal** one wins ("personal over project":
    `~/.claude/skills/deploy` beats the project's) – `resolve_skill` gives the
    user's.
  - Agents: the **project's** wins (project `.claude/agents/` over
    `~/.claude/agents/`) – `resolve_agent` gives the project's.
  - Rules: **neither** wins – Claude Code loads the user's, then the
    project's, and both apply. `resolve_rules` gives both, the user's first;
    `resolve_rule` gives one only when one scope declares it and throws
    `Skilletor::Error::Ambiguous` rather than hide one. `resolve_items` gives
    every record of a type and name in that order.

  `scope => 'user'` or `'project'` looks in one scope.
- **Fetching:** `fetch => 'always'` (default) fetches every source as a sync
  does; `'missing'` only sources without a cache yet; `'never'` touches no
  network and serves what the cache holds. The lookups answer from one
  resolution, made at the first call; `$sk->refresh` (or a `sync`) drops it.
- **Templates:** nothing is rendered. An item with a `.njk` file has
  `templated => 1`, and `resolve_skill`/`_agent`/`_rule`/`_rules` refuse it
  with a `Skilletor::Error::Unsupported` – an unrendered template is never
  served as the item.
- **No harness needed:** unlike the reference, resolving does not fail on a
  machine without Claude Code or Codex markers (`require_harness => 1` restores
  that).
- Like the reference, a resolve holds the sync lock
  (`~/.claude/skilletor/sync.lock/`), so the two never work one cache at once.

### Sync, check, status – for Claude Code

```perl
use Skilletor::Report qw( report_text status_text exit_code );

my $report = $sk->sync( scope => 'all', force => 0 );   # `skilletor sync --json`, field for field
print report_text($report) || 'skilletor: up to date', "\n";

my $check = $sk->check;     # { changed, sources, declaredChanged?, varsChanged?, … }
print status_text( $sk->status ), "\n";
exit exit_code( check => $check );   # 2 error, 1 a sync is due, 0 up to date
```

The CLI's commands for the Claude Code target, ported whole: the same
installed files and executable bits, the same lock, `.gitignore` blocks,
`.worktreeinclude` and `.claude/settings.json` plugin requirement, conflicts and
`force`, removal of what is no longer declared, `partial` entries after a
failed write, the briefing check, the same reports – and the same state
records (`render-inputs.json`, `sources-read.json`, `unreached.json`), so the
CLI's `check` and its session hooks accept what the port synced and the other
way round.

- **Claude Code only:** a scope that targets Codex or Hermes (`"targets"`, or
  Codex detected without `"targets"`) is refused – the report's `error`,
  nothing touched – and so is a sync where the CLI left Codex or Hermes state
  behind (their lock entries, the Codex rules file). Set
  `"targets": ["claude"]`, or run the CLI.
- **Templates:** a sync never installs a `.njk` item unrendered. It warns and
  leaves the item as the CLI installed it, files and lock entry; `check`
  keeps asking for a sync until the CLI's renders it.
- A config error or a machine without an agent harness is the report's
  `error`; a write that fails midway throws, as the CLI's sync does.
- `is_git_work_tree`, `git_tracked`, `git_remote` and `plugin_root` replace
  the questions to git and `CLAUDE_PLUGIN_ROOT` (tests, sandboxes).

### Building blocks

```perl
use Skilletor::Config;
use Skilletor::Backend;
use Skilletor::State;
use Skilletor::Cache qw( cache_root );

my $home   = $ENV{HOME};
my $config = Skilletor::Config->load( home => $home, project_dir => '/path/to/project' );
my $state  = Skilletor::State->for_home($home);

for my $name ( $config->source_names ) {
  my $backend = Skilletor::Backend->resolve( $config->source($name), $home );
  next unless $state->is_trusted( $name, $backend );
  my $loc = Skilletor::Backend->make( $backend, cache_root($home) )->resolve;
  print "$name: $loc->{dir} ($loc->{version})\n";
}
```

### Skilletor::Config

```perl
my $config = Skilletor::Config->load( home => $home, project_dir => $project );
my $items  = $config->project->{install};      # [ { type, name, source, target, raw } ]
my $src    = $config->source('shared');        # { name, git, ref, local, origins => {...} }

Skilletor::Config->add_source( $file, shared => { git => 'https://github.com/Getty/skills' } );
Skilletor::Config->add_install_entry( $file, skill => 'perl-moo@shared' );
```

### Skilletor::Spec

```perl
use Skilletor::Spec qw( resolve_spec );
my $r = resolve_spec( 'Getty/karr', sub { {} } );
# { kind => 'git', value => 'https://github.com/Getty/karr', derivedName => 'karr' }
```

### Sources

```perl
use Skilletor::Source::Git;
my $git = Skilletor::Source::Git->new( url => $url, ref => 'main', cache_root => cache_root($home) );
my $loc = $git->resolve;                 # { dir, version => 'git:ab12cd3', warning? }
my $moved = $git->check( $loc->{version} );
```

`Skilletor::Source::Url` (an https `.tar.gz`) and `Skilletor::Source::Local`
work the same way.

### Skilletor::JSON

```perl
use Skilletor::JSON qw( js_parse js_stringify );
my $data = js_parse($text);                 # JSON.parse: key order kept, V8's errors
my $out  = js_stringify( $data, 2 )."\n";   # JSON.stringify(data, null, 2), byte for byte
```

### Catalogs, bundles, frontmatter

```perl
use Skilletor::Catalog;
use Skilletor::Bundles qw( expand_bundle );
use Skilletor::Frontmatter qw( split_frontmatter );

my $cat = Skilletor::Catalog->scan($source_dir);   # { items, bundles, meta }
my $x   = expand_bundle( $cat, 'perl' );            # { items, foreign, warnings }
my $fm  = split_frontmatter($agent_md);             # { data, body } – the reference's YAML subset
```

## Development

```bash
prove -lr t/                          # t/50-parity.t, t/51-parity-resolve.t, t/52-parity-sync.t also drive the reference (needs node)
node maint/oracle-config.mjs > t/data/config-oracle.json     # regenerate an oracle
node maint/oracle-resolve.mjs > t/data/resolve-oracle.json   # YAML, bundles, catalog scans
dzil test
```

`t/60-conformance.t` runs the shared cases of `../conformance` (see its
README), every step: `resolve`, `sync`, `check`, `status`. Where the port
differs on purpose (a sync of a `.njk` item) a case holds its own
`expected.perl/`. It skips outside a checkout of the repository.
`t/52-parity-sync.t` has the reference and the port sync one machine and
compares every byte they leave, the state records included.

## Author

Torsten Raudssus <getty@cpan.org>

## License

This library is free software; you can redistribute it and/or modify it under the same terms as Perl itself.
