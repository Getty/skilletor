package Skilletor::Commands;
# ABSTRACT: The CLI's config commands – add, trust, source list, source remove, available – after the reference's commands.ts

use strict;
use warnings;

use Exporter qw( import );
use JSON::MaybeXS ();
use Scalar::Util qw( blessed );
use Skilletor::Backend;
use Skilletor::Bundles qw( expand_bundle same_identity );
use Skilletor::Catalog;
use Skilletor::Config;
use Skilletor::Entry qw( SOURCE_NAME_RULE is_source_name );
use Skilletor::Error::Command;
use Skilletor::FSUtil qw( inner_segments path_join );
use Skilletor::JSON qw( js_ordered js_sort_keys js_stringify js_type );
use Skilletor::Lock qw( parse_lock_key read_lock );
use Skilletor::Probe qw( make_probe );
use Skilletor::Resolver;
use Skilletor::Source::Git;
use Skilletor::Source::Url;
use Skilletor::Spec qw( resolve_spec );
use Skilletor::State;

our $VERSION = '0.002';

our @EXPORT_OK = qw( add available config_path source_list source_remove trust );

my @ADDRESS_KEYS = qw( git url local );
my %ADDRESS_KEY  = map { ( $_ => 1 ) } @ADDRESS_KEYS;
my %DEF_KEY      = map { ( $_ => 1 ) } qw( git ref url local path );
my %TYPE_DIR     = ( skill => 'skills', agent => 'agents', rule => 'rules' );

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

#### add #######################################################################

# Add a source to one config, trust it, sync. Never replaces a source (k101): a name the config
# already has keeps its entry untouched when it has the same backend and address – still trusted
# and synced, `kept` set – and is refused, before anything is written or trusted, when it has
# another one. A name load would refuse (k95) is refused first, a definition it would refuse
# (k110) next, a kept entry it would refuse (k116) before it is trusted; a spec's ref (k119) and
# path (k126) keep an entry only at that ref and path.
sub add {
  my ( $engine, %args ) = @_;
  my ( $name, $spec ) = @args{qw( name spec )};
  my $flag = $args{project} ? ' --project' : '';
  if ( defined $name && !is_source_name($name) ) {
    _fail( 'source name '.js_stringify($name).' is not valid ('.SOURCE_NAME_RULE.'); nothing was changed' );
  }
  my $path     = config_path( $engine, $args{project} );
  my $resolved = resolve_spec( $spec, $args{probe} // make_probe() );
  $name //= $resolved->{derivedName};
  my $def = js_ordered( $resolved->{kind} => $resolved->{value} );
  $def->{$_} = $resolved->{$_} for grep { exists $resolved->{$_} } qw( ref path );
  my $invalid = _load_refusal( $name, $def );
  _fail( 'cannot add '.$spec.': '.$invalid.'; nothing was changed' ) if defined $invalid;

  my $kept = Skilletor::Config->has_source_entry( $path, $name );
  if ($kept) {
    my $existing = Skilletor::Config->source_entry( $path, $name );
    my $ways = 'add it under another name (skilletor add <name> '.$spec.$flag.') '
      .'or remove the source first (skilletor source remove '.$name.$flag.').';
    unless ( _same_address( $engine, $name, $existing, $resolved ) ) {
      _fail( 'source "'.$name.'" in '.$path.' is '._address_text($existing).', not '.$resolved->{kind}.' '.$resolved->{value}
          .'; nothing was changed. '.ucfirst($ways) );
    }
    # A spec's ref (k119) is what the user asked for: keeping the entry at another would drop it.
    my $has = $existing->{ref};
    if ( exists $resolved->{ref} && !( js_type($has) eq 'string' && $has eq $resolved->{ref} ) ) {
      _fail( 'source "'.$name.'" in '.$path.' is '._address_text($existing).' '
          .( defined $has ? 'with ref '.js_stringify($has) : 'with no ref' ).', not ref '.js_stringify( $resolved->{ref} )
          .'; nothing was changed. Set its "ref" by hand, '.$ways );
    }
    # So is a spec's path (k126): the entry would go on offering what lies elsewhere in the repo.
    if ( exists $resolved->{path} && !_same_paths( $existing->{path}, $resolved->{path} ) ) {
      _fail( 'source "'.$name.'" in '.$path.' is '._address_text($existing).' '
          .( exists $existing->{path} ? 'with path '.js_stringify( $existing->{path} ) : 'with no path' )
          .', not path '.js_stringify( $resolved->{path} ).'; nothing was changed. Set its "path" by hand, '.$ways );
    }
    # Kept as written, so checked as load reads it: an entry the sync would refuse is not trusted.
    my $refused = _load_refusal( $name, $existing, $path );
    if ( defined $refused ) {
      _fail( 'cannot add '.$spec.': '.$refused.'; nothing was changed. Source "'.$name.'" there already has this address: '
          .'fix its entry by hand, or remove it (skilletor source remove '.$name.$flag.').' );
    }
    $def = _entry_def($existing);
  }
  else {
    Skilletor::Config->add_source( $path, $name, $def );
  }
  # add is the trust act.
  Skilletor::State->new( root => $engine->state_root )
    ->trust( $name, Skilletor::Backend->resolve( { name => $name, %$def, origins => {} }, $engine->home ) );

  return { name => $name, def => $def, kept => $kept, report => $engine->sync };
}

# Why config load would refuse source $name defined as $def, by load's own check (k110) – with
# $file, as load words it for that file; undef when it would load.
sub _load_refusal {
  my ( $name, $def, $file ) = @_;
  return undef if eval { Skilletor::Config->source_fields( $def, ( defined $file ? $file.': ' : '' ).'sources.'.$name ); 1 };
  my $err = $@;
  die $err unless blessed $err && $err->isa('Skilletor::Error::Config');
  return $err->message;
}

# Does a config entry name the backend and address a spec resolved to? git and url compare as
# source identities (spec §15.6), a local path as the directory it names.
sub _same_address {
  my ( $engine, $name, $entry, $resolved ) = @_;
  return 0 unless js_type($entry) eq 'object';
  my $field = $entry->{ $resolved->{kind} };
  return 0 unless js_type($field) eq 'string';
  return same_identity( $field, $resolved->{value} ) if $resolved->{kind} ne 'local';
  my $dir = sub { Skilletor::Backend->resolve( { name => $name, local => $_[0], origins => {} }, $engine->home )->{address} };
  return $dir->($field) eq $dir->( $resolved->{value} ) ? 1 : 0;
}

# An entry's backends as written (`git https://…, local ~/dev/x`), else the entry as JSON.
sub _address_text {
  my ( $entry ) = @_;
  my @parts = js_type($entry) eq 'object'
    ? map { $_.' '.$entry->{$_} } grep { $ADDRESS_KEY{$_} && js_type( $entry->{$_} ) eq 'string' } keys %$entry
    : ();
  return @parts ? join( ', ', @parts ) : js_stringify($entry);
}

# Does an entry's `path`, as written, name the one directory $path? A string or a list of one,
# compared by segments (`./skills/` is `skills`); anything else does not.
sub _same_paths {
  my ( $entry, $path ) = @_;
  my $type = js_type($entry);
  $entry = $entry->[0] if $type eq 'array' && @$entry == 1;
  return 0 unless js_type($entry) eq 'string';
  my $segments = sub { my $s = inner_segments( $_[0] ); ref $s ? join( '/', @$s ) : undef };
  my $mine = $segments->($entry);
  my $theirs = $segments->($path);
  return defined $mine && defined $theirs && $mine eq $theirs ? 1 : 0;
}

# The source fields of an entry as written, in its key order (`path` a string or a list).
sub _entry_def {
  my ( $entry ) = @_;
  return js_ordered(
    map { ( $_ => $entry->{$_} ) } grep { $DEF_KEY{$_} && ( $_ eq 'path' || js_type( $entry->{$_} ) eq 'string' ) } keys %$entry
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

#### available #################################################################

sub available {
  my ( $engine, %args ) = @_;
  my $config    = _load($engine);
  my $installed = _installed_set( $engine, $config );
  my %declared  = map { ( Skilletor::Resolver->bundle_label($_) => 1 ) }
    @{ $config->user->{bundles} }, @{ $config->project ? $config->project->{bundles} : [] };
  my @names = defined $args{source} && length $args{source} ? ( $args{source} ) : $config->source_names;
  # A resolve writes the source cache, a scan reads it: under the sync lock (spec §6.5).
  my $list = _with_sync_lock( $engine, sub { _list_available( $engine, $config, $_[0], \@names, $installed, \%declared ) } );
  return $list;
}

sub _list_available {
  my ( $engine, $config, $state, $names, $installed, $declared ) = @_;
  my @out;
  for my $name (@$names) {
    # What install would read: the user config's definition for a user source (the user scope's,
    # spec §3), the merged one for a source only a project declares.
    my $src = $config->user_source($name) // $config->source($name) // _fail( 'unknown source: '.$name );
    my $backend = Skilletor::Backend->resolve( $src, $engine->home );
    next unless $state->is_trusted( $name, $backend );    # only trusted
    my $loc = Skilletor::Backend->make( $backend, $engine->cache_root )->resolve;
    my $cat = Skilletor::Catalog->scan( $loc->{dir}, $backend->{path} );
    for my $item ( @{ $cat->{items} } ) {
      my $entry = js_ordered( type => $item->{type}, name => $item->{name} );
      $entry->{description} = $item->{description} if defined $item->{description};
      $entry->{source}      = $name;
      $entry->{installed}   = _bool( $installed->{ $TYPE_DIR{ $item->{type} }.'/'.$item->{name}.'@'.$name } );
      $entry->{error}       = $item->{error} if defined $item->{error};
      push @out, $entry;
    }
    for my $b ( @{ $cat->{bundles} } ) {
      my $entry = js_ordered( type => 'bundle', name => $b->{name} );
      $entry->{description} = $b->{def}{description} if $b->{def};
      $entry->{source}      = $name;
      $entry->{installed}   = _bool( $declared->{ Skilletor::Resolver->bundle_label( { name => $b->{name}, source => $name } ) } );
      my $e;
      if ( eval { $e = expand_bundle( $cat, $b->{name} ); 1 } ) {
        # Members of other sources as written, with their address (spec §15.6).
        $entry->{members} = [ js_sort_keys( ( map { $_->{type}.':'.$_->{name} } @{ $e->{items} } ), map { $_->{type}.':'.$_->{entry} } @{ $e->{foreign} } ) ];
        $entry->{vars} = $b->{def}{vars};
      }
      else {
        my $err = $@;
        die $err unless blessed $err && $err->isa('Skilletor::Error::Bundle');
        $entry->{error} = $err->message;
      }
      push @out, $entry;
    }
  }
  return \@out;
}

sub _bool { $_[0] ? JSON::MaybeXS::true() : JSON::MaybeXS::false() }

# Run $code holding the sync lock, the caches swept first, as a sync runs (the reference's
# withSyncLock); $code gets the state.
sub _with_sync_lock {
  my ( $engine, $code ) = @_;
  my $state = Skilletor::State->new( root => $engine->state_root );
  my $result = $state->with_lock(
    sub {
      Skilletor::Source::Url->sweep_cache( $engine->cache_root );
      Skilletor::Source::Git->sweep_cache( $engine->cache_root );
      return $code->($state);
    },
    timeout_ms => $engine->lock_timeout_ms,
  );
  return $result;
}

# `<typedir>/<name>@<source>` of every item an explicit entry of either scope declares or a lock
# of either scope holds – under any target, unless it rendered empty there.
sub _installed_set {
  my ( $engine, $config ) = @_;
  my %set;
  $set{ $_->{target}.'@'.$_->{source} } = 1 for @{ $config->user->{install} }, @{ $config->project ? $config->project->{install} : [] };
  my $project = $engine->project_dir_of;
  for my $dir ( $engine->claude_dir, defined $project ? path_join( $project, '.claude' ) : () ) {
    my $lock = read_lock( path_join( $dir, 'skilletor.lock.json' ) );
    for my $key ( keys %$lock ) {
      my $entry = $lock->{$key};
      next if js_type($entry) ne 'object' || $entry->{skipped};    # renders empty here: nothing installed
      $set{ parse_lock_key($key)->{target}.'@'.( $entry->{source} // 'undefined' ) } = 1;
    }
  }
  return \%set;
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

  use Skilletor::Commands qw( add available source_list source_remove trust );

  my $engine = Skilletor::Engine->new( home => $ENV{HOME}, project_dir => $project );
  my $added  = add( $engine, spec => 'Getty/skills', project => 0 );   # { name, def, kept, report }
  my $list   = source_list($engine);                    # [ { name, def, origin }, ... ]
  my $r      = trust( $engine, 'team' );                 # { name, kind, url }
  my $report = source_remove( $engine, name => 'extra', project => 0, force => 0 );
  my $items  = available( $engine, source => 'team' );   # [ { type, name, description, source, installed, ... }, ... ]

=description

The commands of the CLI that read or edit the config, after the reference's
F<src/commands.ts>: the same checks in the same order, the same messages, the
config files written by L<Skilletor::Config>'s edit operations (two-space
JSON, the file's key order kept); an edit is followed by the engine's sync,
whose report the command returns. C<available> edits nothing: it reads the
sources under the sync lock, as a sync does. Each takes the L<Skilletor::Engine> the CLI
runs on as its context – home, project dir, C<CLAUDE_CONFIG_DIR>, state root –
as the reference's take its C<CommandContext>.

A refusal is a L<Skilletor::Error::Command>, a spec that does not resolve a
L<Skilletor::Error::Spec>, a config file load refuses a
L<Skilletor::Error::Config>; none of them changes anything.

=func add

  my $r = add( $engine, spec => $spec, name => $name, project => $bool, probe => $probe );

Adds the source C<$spec> resolves to (L<Skilletor::Spec/resolve_spec>) to the
user config, or the project config with C<project>, under C<name> or the name
the spec derives, trusts it for the backend it names and syncs. Returns C<<
{ name, def, kept, report } >>: C<def> the source's fields as written, in
their order, C<report> the sync's (its C<error> set when that sync stopped at a
config error; the edit stays).

It never replaces a source (k101): when the config already declares the name
with the same backend and address – git and url as one source identity, a
local path as the directory it names – that entry is kept as it is (C<kept>
set, C<def> its fields), trusted and synced. It throws, before anything is
written or trusted, for a name config load would refuse (k95), a definition it
would refuse (k110: a C<url> not C<https://>), no project scope with
C<project>, a taken name with another address, a spec's ref (k119) or path
(k126) the kept entry does not have, and a kept entry load would refuse (k116).

A generic host (C<host.tld[/path]>) is probed through C<probe>, by default
L<Skilletor::Probe/make_probe>'s.

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

=func available

  my $items = available( $engine, source => $name );

What the trusted sources offer, or source C<$name> alone: each source resolved
– fetched into the cache, as a sync would – and scanned, holding the sync lock
(L<Skilletor::State/with_lock>; the caches' leftovers swept first, as a sync
does). A source is read by the definition C<install> would use: the user
config's for a user source, the merged one for a source only a project
declares. A source not trusted is skipped, even by name.

Returns a list of C<< { type, name, description, source, installed, error } >>,
in source order, each source's items first, then its bundles. C<description>
is there when the item has one, C<error> – why it cannot be built (spec §4.1)
– when it cannot.
C<installed> (a JSON boolean): an item that an entry of either scope declares
or that a lock of either scope holds for that source, under any target,
unless it rendered empty there. A bundle is C<type> C<bundle>, C<installed>
when either scope's config declares it, with C<members> – its expanded items
as C<type:name> and its entries of other sources as written, sorted – and
C<vars>, its own var defaults; or C<error>, why it cannot be expanded (spec
§15.4).

It throws a L<Skilletor::Error::Command> for a name no source has, a
L<Skilletor::Error::Config> for a config file load refuses, and passes on what
a lock read, a resolve or a scan throws; the CLI then prints nothing else.

=func trust

  my $r = trust( $engine, $name );

Trusts source C<$name> of the merged map for the backend it would use now –
its kind and address, a C<local> one as an absolute path (the real path when
the directory exists) – in the state root's
F<trust.json>, replacing an earlier entry. Returns C<< { name, kind, url } >>;
an unknown name throws.

=cut
