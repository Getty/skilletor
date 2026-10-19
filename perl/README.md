# Skilletor

Install skills, agents and rules from remote sources – the Perl port of
[skilletor](https://github.com/Getty/skilletor).

skilletor's reference implementation is TypeScript (`../src`). This
distribution is its Perl port, for Perl programs that must resolve skills,
agents and rules exactly as skilletor does – the same config files, the same
source cache (`~/.claude/skilletor/cache`, one fetch serves both), the same
`trust.json`, the same bytes in every JSON file, the same error messages –
without Node.

## Installation

```bash
cpanm Skilletor
```

## Usage

### Skilletor – where is skill X?

```perl
use Skilletor;

my $sk = Skilletor->new( home => $ENV{HOME}, project_dir => $project );

my $file = $sk->resolve_skill('perl-moo');   # …/.claude/skilletor/cache/<hash>/skills/perl-moo/SKILL.md
my $file = $sk->resolve_agent('reviewer');   # undef when no scope resolves to it
my $rec  = $sk->resolve_item( skill => 'perl-moo' );
# { type, name, scope, source, version, source_dir, path, dir, file, files,
#   description, vars, declaredBy, via?, templated, templates }

my $all    = $sk->items( type => 'skill' );   # one record per name
my $report = $sk->resolve( scope => 'all' );  # the reference's resolveItems, field for field
```

An item is resolved as a sync would install it – config merge, trust, sources
fetched into the shared cache, wildcards, bundles and the overlap rules – but
nothing is installed: the paths point into the `local` directory or the cache
dir the item lies in.

- **Scopes:** a lookup asks the project scope first – a project item shadows a
  user item of the same type and name (names ignore case); `scope => 'user'` or
  `'project'` looks in one.
- **Fetching:** `fetch => 'always'` (default) fetches every source as a sync
  does; `'missing'` only sources without a cache yet; `'never'` touches no
  network and serves what the cache holds. The lookups answer from one
  resolution, made at the first call; `$sk->refresh` drops it.
- **Templates:** nothing is rendered. An item with a `.njk` file has
  `templated => 1`, and `resolve_skill`/`_agent`/`_rule` refuse it with a
  `Skilletor::Error::Unsupported`.
- **No harness needed:** unlike the reference, resolving does not fail on a
  machine without Claude Code or Codex markers (`require_harness => 1` restores
  that).
- Like the reference, a resolve holds the sync lock
  (`~/.claude/skilletor/sync.lock/`), so the two never work one cache at once.

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
prove -lr t/                          # t/50-parity.t and t/51-parity-resolve.t also drive the reference (needs node)
node maint/oracle-config.mjs > t/data/config-oracle.json     # regenerate an oracle
node maint/oracle-resolve.mjs > t/data/resolve-oracle.json   # YAML, bundles, catalog scans
dzil test
```

`t/60-conformance.t` runs the shared cases of `../conformance` (see its
README) – the `resolve` steps so far; `sync`, `check` and `status` follow. It
skips outside a checkout of the repository.

## Author

Torsten Raudssus <getty@cpan.org>

## License

This library is free software; you can redistribute it and/or modify it under the same terms as Perl itself.
