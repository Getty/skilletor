package Skilletor::Commands;
# ABSTRACT: The CLI's config commands – trust, source list, source remove – after the reference's commands.ts

use strict;
use warnings;

use Exporter qw( import );
use Scalar::Util qw( blessed );
use Skilletor::Backend;
use Skilletor::Config;
use Skilletor::Error::Command;
use Skilletor::FSUtil qw( path_join );
use Skilletor::JSON qw( js_ordered js_type );
use Skilletor::State;

our $VERSION = '0.002';

our @EXPORT_OK = qw( config_path source_list source_remove trust );

my @ADDRESS_KEYS = qw( git url local );

sub _fail { Skilletor::Error::Command->throw( $_[0] ) }

# The project root of a --project edit; the home dir as project dir has no project scope.
sub _project_root {
  my ( $engine ) = @_;
  my $dir = $engine->project_dir_of;
  return $dir if defined $dir;
  my $given = $engine->project_dir;
  _fail(
    ( defined $given && length $given )
    ? 'no project scope: the project directory is the home directory ('.$engine->home.'); '
      .'run from a project, pass --project-dir, or drop --project to edit the user config'
    : 'no project scope: no project directory'
  );
}

sub config_path {
  my ( $engine, $project ) = @_;
  return path_join( $project ? path_join( _project_root($engine), '.claude' ) : $engine->claude_dir, 'skilletor.json' );
}

# The config as the engine sees it: no project config when the project dir is the home dir.
sub _load {
  my ( $engine, %more ) = @_;
  return Skilletor::Config->load(
    home              => $engine->home,
    claude_config_dir => $engine->claude_config_dir,
    project_dir       => $engine->project_dir_of,
    %more,
  );
}

#### source list ###############################################################

sub source_list {
  my ( $engine ) = @_;
  my $config = _load($engine);
  return [
    map {
      js_ordered( name => $_->{name}, def => _pick_def($_), origin => Skilletor::Backend->resolve( $_, $engine->home )->{origin} )
    } @{ $config->sources }
  ];
}

# A source's fields as merged, in the order the reference writes them.
sub _pick_def {
  my ( $s ) = @_;
  my $def = js_ordered();
  for my $key (qw( git ref url local )) {
    $def->{$key} = $s->{$key} if defined $s->{$key} && length $s->{$key};
  }
  $def->{path} = $s->{path} if exists $s->{path};
  return $def;
}

#### source remove #############################################################

sub source_remove {
  my ( $engine, %args ) = @_;
  my $name    = $args{name};
  my $project = $args{project} ? 1 : 0;
  my $path    = config_path( $engine, $project );
  unless ( Skilletor::Config->has_source_entry( $path, $name ) ) {
    _fail( 'source "'.$name.'" is not declared in the '.( $project ? 'project' : 'user' ).' config ('.$path.')'
        ._source_elsewhere( $engine, $name, $project ) );
  }
  my $stranded = _stranded_overrides( $engine, $name, $project );
  _fail($stranded) if defined $stranded;
  my $config = _removal_config( $engine, $path, $name );
  if ( _used_sources($config)->{$name} && !$args{force} ) {
    _fail( 'source "'.$name.'" still has installed items; use --force to remove anyway' );
  }
  Skilletor::Config->remove_source( $path, $name );
  return $engine->sync;
}

# The config a removal checks the source's use in: the engine's; or, when load refuses it, the
# config loaded with the entry being removed unchecked (k120). Any error left stops the command.
sub _removal_config {
  my ( $engine, $path, $name ) = @_;
  my $config;
  return $config if eval { $config = _load($engine); 1 };
  my $err = $@;
  die $err unless blessed $err && $err->isa('Skilletor::Error::Config');
  return _load( $engine, unchecked => { path => $path, name => $name } );
}

# Does an entry as written name a backend (k128)?
sub _gives_backend {
  my ( $entry ) = @_;
  return 0 unless js_type($entry) eq 'object';
  return ( grep { exists $entry->{$_} } @ADDRESS_KEYS ) ? 1 : 0;
}

# Why removing the source from the target config would leave other files' entries for it
# without a backend (k137); undef when it strands nothing.
sub _stranded_overrides {
  my ( $engine, $name, $project ) = @_;
  my $path = config_path( $engine, $project );
  return undef unless _gives_backend( Skilletor::Config->source_entry( $path, $name ) );
  my $root = $engine->project_dir_of;
  return undef unless defined $root;    # the user config alone: no other file
  my $local = path_join( $root, '.claude', 'skilletor.local.json' );
  my $other = config_path( $engine, !$project );
  my @others = grep { Skilletor::Config->has_source_entry( $_->{path}, $name ) } (
    { path => $other, shown => 'the '.( $project ? 'user' : 'project' ).' config ('.$other.')',
      way => 'skilletor source remove '.$name.( $project ? '' : ' --project' ) },
    { path => $local, shown => $local, way => 'edit '.$local.' by hand' },
  );
  return undef if !@others || grep { _gives_backend( Skilletor::Config->source_entry( $_->{path}, $name ) ) } @others;
  my $many = @others > 1;
  return 'source "'.$name.'" in the '.( $project ? 'project' : 'user' ).' config ('.$path.') gives its only "git", "url" or "local", '
    .'and the '.( $many ? 'entries' : 'entry' ).' in '.join( ' and ', map { $_->{shown} } @others ).' '.( $many ? 'have' : 'has' ).' none: '
    .'config load would refuse '.( $many ? 'those entries' : 'that entry' ).' once this one is gone. '
    .'Remove '.( $many ? 'those entries' : 'that entry' ).' first ('.join( '; ', map { $_->{way} } @others ).'), '
    .'or give '.( $many ? 'one of them' : 'it' ).' a "git", "url" or "local" of its own; nothing was changed.';
}

# Where else a source is declared: the other scope's config, the project's local file.
sub _source_elsewhere {
  my ( $engine, $name, $project ) = @_;
  my $root = $engine->project_dir_of;
  return '; it is not a configured source' unless defined $root;
  my $local = path_join( $root, '.claude', 'skilletor.local.json' );
  my @hits;
  if ( Skilletor::Config->has_source_entry( config_path( $engine, !$project ), $name ) ) {
    push @hits, $project ? 'the user config declares it (run without --project)' : 'the project config declares it (use --project)';
  }
  push @hits, $local.' declares it (edit that file by hand)' if Skilletor::Config->has_source_entry( $local, $name );
  return '; '.( @hits ? join( '; ', @hits ) : 'it is not a configured source' );
}

# Sources an explicit entry, a wildcard or a bundle of any scope names.
sub _used_sources {
  my ( $config ) = @_;
  my %used;
  for my $scope ( grep { defined } $config->user, $config->project ) {
    $used{ $_->{source} } = 1 for @{ $scope->{install} }, @{ $scope->{wildcards} }, @{ $scope->{bundles} };
  }
  return \%used;
}

#### trust #####################################################################

sub trust {
  my ( $engine, $name ) = @_;
  my $src = _load($engine)->source($name) or _fail( 'unknown source: '.$name );
  my $backend = Skilletor::Backend->resolve( $src, $engine->home );
  Skilletor::State->new( root => $engine->state_root )->trust( $name, $backend );
  return js_ordered( name => $name, kind => $backend->{kind}, url => $backend->{address} );
}

1;

=synopsis

  use Skilletor::Commands qw( source_list source_remove trust );

  my $engine = Skilletor::Engine->new( home => $ENV{HOME}, project_dir => $project );
  my $list   = source_list($engine);                    # [ { name, def, origin }, ... ]
  my $r      = trust( $engine, 'team' );                 # { name, kind, url }
  my $report = source_remove( $engine, name => 'extra', project => 0, force => 0 );

=description

The commands of the CLI that read or edit the config without fetching, after
the reference's F<src/commands.ts>: the same checks in the same order, the
same messages, the config files written by L<Skilletor::Config>'s edit
operations (two-space JSON, the file's key order kept). Each takes the
L<Skilletor::Engine> the CLI runs on as its context – home, project dir,
C<CLAUDE_CONFIG_DIR>, state root – as the reference's take its
C<CommandContext>.

A refusal is a L<Skilletor::Error::Command>, a config file load refuses a
L<Skilletor::Error::Config>; neither changes anything.

=func config_path

  my $file = config_path( $engine, $project );

The config file an edit writes: the user config (C<< <CLAUDE_CONFIG_DIR or
~/.claude>/skilletor.json >>), or with C<$project> the project's
F<.claude/skilletor.json>. With C<$project> and no project scope – the project
dir is the home dir, or there is none – it throws, saying which.

=func source_list

  my $list = source_list($engine);

Every source as the project scope sees it, in the merged map's order: C<<
{ name, def, origin } >>, C<def> the merged fields in the order C<git>,
C<ref>, C<url>, C<local>, C<path>, C<origin> that of the backend author mode
would use (L<Skilletor::Backend/resolve>).

=func source_remove

  my $report = source_remove( $engine, name => $name, project => $bool, force => $bool );

Removes source C<$name> from the user config, or the project config with
C<project>, then syncs and returns the sync's report (its C<error> set when
that sync stopped at a config error; the edit stays). It throws, changing
nothing, when that config does not declare the name (naming where else it is
declared, k114), when the entry gives the source its only backend and another
file keeps an entry for it without one (k137), when a config file still fails
to load with the entry unchecked (k120), and – without C<force> – when an
entry, a wildcard or a bundle of either scope still uses the source.

=func trust

  my $r = trust( $engine, $name );

Trusts source C<$name> of the merged map for the backend it would use now –
its kind and address, a C<local> one as an absolute path (the real path when
the directory exists) – in the state root's
F<trust.json>, replacing an earlier entry. Returns C<< { name, kind, url } >>;
an unknown name throws.

=cut
