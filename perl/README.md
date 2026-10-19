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

## Development

```bash
prove -lr t/                          # t/50-parity.t also drives the reference (needs node)
node maint/oracle-config.mjs > t/data/config-oracle.json   # regenerate an oracle
dzil test
```

## Author

Torsten Raudssus <getty@cpan.org>

## License

This library is free software; you can redistribute it and/or modify it under the same terms as Perl itself.
