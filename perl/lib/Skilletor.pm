package Skilletor;
# ABSTRACT: Install skills, agents and rules from remote sources – the Perl port of skilletor

use Moo;
use Carp qw( croak );
use Skilletor::Entry qw( name_key );
use Skilletor::Error::Unsupported;
use Skilletor::FSUtil qw( path_join );
use Skilletor::Resolver;
use namespace::clean;

our $VERSION = '0.001';

has home => (
  is       => 'ro',
  required => 1,
);

has project_dir => (
  is => 'ro',
);

has fetch => (
  is      => 'ro',
  default => sub { 'always' },
);

has require_harness => (
  is      => 'ro',
  default => sub { 0 },
);

has [qw( state_root cache_root codex_home timeout_ms lock_timeout_ms )] => (
  is => 'ro',
);

has resolver => (
  is      => 'lazy',
  builder => sub {
    my ( $self ) = @_;
    return Skilletor::Resolver->new(
      home            => $self->home,
      project_dir     => $self->project_dir,
      fetch           => $self->fetch,
      require_harness => $self->require_harness,
      map { defined $self->$_ ? ( $_ => $self->$_ ) : () } qw( state_root cache_root codex_home timeout_ms lock_timeout_ms ),
    );
  },
);

# The resolution of every scope that resolve_* answer from, made on first use.
has _resolution => (
  is       => 'lazy',
  init_arg => undef,
  clearer  => 'refresh',
  builder  => sub { $_[0]->resolver->resolve( scope => 'all', throw => 1 ) },
);

sub resolve {
  my ( $self, %opts ) = @_;
  return $self->resolver->resolve(%opts);
}

# One resolved item as the record resolve_item returns.
sub _record {
  my ( $self, $scope, $ri ) = @_;
  my $ci    = $ri->{item};
  my $root  = $ri->{sourceDir};
  my @files = @{ $ci->{files} };
  my ( $path, $dir, $main );
  if ( $ri->{type} eq 'skill' ) {
    $path = $ci->{dir};
    $dir  = path_join( $root, $path );
    ($main) = grep { $_ eq $path.'/SKILL.md' } @files;
    $main //= $path.'/SKILL.md.njk';
  }
  else {
    $path = $main = $files[0];
    ( my $parent = $path ) =~ s{/[^/]*\z}{};
    $dir = path_join( $root, $parent eq $path ? '' : $parent );
  }
  my @templates = grep { /\.njk\z/ } @files;
  my %source = map { ( $_->{name} => $_ ) } @{ $self->_scope_report($scope)->{sources} };
  return {
    type       => $ri->{type},
    name       => $ri->{name},
    scope      => $scope,
    source     => $ri->{source},
    version    => $source{ $ri->{source} } ? $source{ $ri->{source} }{version} : undef,
    source_dir => $root,
    path       => $path,
    dir        => $dir,
    file       => path_join( $root, $main ),
    files      => [ map { path_join( $root, $_ ) } @files ],
    ( defined $ci->{description} ? ( description => $ci->{description} ) : () ),
    vars       => $ri->{vars},
    declaredBy => $ri->{declaredBy},
    ( $ri->{via} ? ( via => $ri->{via} ) : () ),
    templated  => @templates ? 1 : 0,
    templates  => \@templates,
  };
}

sub _scope_report {
  my ( $self, $scope ) = @_;
  my ($rep) = grep { $_->{scope} eq $scope } @{ $self->_resolution->{scopes} };
  return $rep;
}

sub _scopes_for {
  my ( $scope ) = @_;
  $scope //= 'all';
  croak 'scope must be user, project or all' unless $scope =~ /\A(?:user|project|all)\z/;
  return $scope eq 'all' ? qw( project user ) : ($scope);
}

# Every item, one per type and name: the project's shadows the user's.
sub items {
  my ( $self, %opts ) = @_;
  my ( %seen, @out );
  for my $scope ( _scopes_for( $opts{scope} ) ) {
    my $rep = $self->_scope_report($scope) or next;
    for my $ri ( @{ $rep->{items} } ) {
      next if defined $opts{type} && $ri->{type} ne $opts{type};
      next if $seen{ $ri->{type}.'/'.name_key( $ri->{name} ) }++;
      push @out, $self->_record( $scope, $ri );
    }
  }
  return \@out;
}

sub resolve_item {
  my ( $self, $type, $name, %opts ) = @_;
  croak 'type must be skill, agent or rule' unless defined $type && $type =~ /\A(?:skill|agent|rule)\z/;
  return undef unless defined $name && length $name;
  my $key = name_key($name);
  for my $scope ( _scopes_for( $opts{scope} ) ) {
    my $rep = $self->_scope_report($scope) or next;
    for my $ri ( @{ $rep->{items} } ) {
      return $self->_record( $scope, $ri ) if $ri->{type} eq $type && name_key( $ri->{name} ) eq $key;
    }
  }
  return undef;
}

sub _main_file {
  my ( $self, $type, $name, %opts ) = @_;
  my $rec = $self->resolve_item( $type, $name, %opts ) or return undef;
  if ( $rec->{templated} ) {
    Skilletor::Error::Unsupported->throw( $type.' '.$rec->{name}.'@'.$rec->{source}.' is a Nunjucks template ('
      .join( ', ', @{ $rec->{templates} } ).'); the Perl port of skilletor renders no templates' );
  }
  return $rec->{file};
}

sub resolve_skill { my $self = shift; return $self->_main_file( skill => @_ ) }
sub resolve_agent { my $self = shift; return $self->_main_file( agent => @_ ) }
sub resolve_rule  { my $self = shift; return $self->_main_file( rule  => @_ ) }

1;

=synopsis

  use Skilletor;

  my $sk = Skilletor->new( home => $ENV{HOME}, project_dir => $project );

  # The skill as an include, straight from the source tree or the shared cache:
  my $file = $sk->resolve_skill('perl-moo');    # …/cache/79eb247685294166/skills/perl-moo/SKILL.md
  my $item = $sk->resolve_item( skill => 'perl-moo' );
  # { type, name, scope, source, version, source_dir, path, dir, file, files,
  #   description, vars, declaredBy, via?, templated, templates }

  for my $agent ( @{ $sk->items( type => 'agent' ) } ) { ... }

  # Startup without the network: what the cache holds.
  my $offline = Skilletor->new( home => $ENV{HOME}, project_dir => $project, fetch => 'never' );

  # The reference's resolveItems, field for field:
  my $report = $sk->resolve( scope => 'all' );

=description

L<skilletor|https://github.com/Getty/skilletor> installs skills, agents and
rules from remote sources (git repositories, https tarballs, local
directories) into Claude Code, Codex and Hermes, at user and project scope.
Its reference implementation is TypeScript; this distribution is its Perl
port, living in the same repository, for Perl programs – an agent such as
L<Langertha::Raider> – that must resolve skills exactly as skilletor does,
straight from the same config and the same cache, without Node.

The port shares everything on disk with the reference: the config files
(C<~/.claude/skilletor.json>, C<< <project>/.claude/skilletor.json >>,
C<skilletor.local.json>), the source cache under C<~/.claude/skilletor/cache>
(the same directory names, so one fetch serves both), C<trust.json>, the sync
lock, and the JSON bytes either writes. Error messages and warnings are the
reference's, word for word; the shared conformance cases
(F<conformance/> in the repository) hold both to that.

This class answers "where is skill X" the way a sync would install it, but
without installing anything: an item is served from the source tree it lies
in – a C<local> directory or the cache dir a git or url source was fetched
into.

=head2 Scopes and shadowing

Every scope resolves on its own, as a sync installs it: the user scope from
the user config alone, the project scope from the merged project, local and
user config (spec §3). The reference installs an item declared in both scopes
twice – once per scope – and has no rule which one wins; here a lookup without
a C<scope> asks the project scope first: B<a project item shadows a user item
of the same type and name> (names ignore case, as everywhere in skilletor).
Pass C<< scope => 'user' >> or C<< scope => 'project' >> to look in one scope
only. Within a scope a type and name is one item at most – the overlap rules
(explicit entries over wildcards and bundles, two sources offering one name
skip it) see to that.

=head2 Fetching

L</fetch> is the fetch policy: C<always> (default) resolves every source as a
sync does – a git fetch, a url download, a failure falling back to the cache
with a warning; C<missing> fetches only a source with no usable cache yet;
C<never> touches no network and serves what the cache holds, a source that was
never fetched being a warning. Every lookup method answers from one resolution
of every scope, made at the first call; L</refresh> drops it.

=head2 Templates

The Perl port renders no Nunjucks. An item with a C<.njk> file resolves like
any other – its record says C<< templated => 1 >> and lists the C<templates> –
but L</resolve_skill>, L</resolve_agent> and L</resolve_rule> refuse it with a
L<Skilletor::Error::Unsupported>: an unrendered template is never served as if
it were the item.

=head2 Modules

=over 4

=item * L<Skilletor::Resolver> – the resolve itself (the reference's C<resolveItems>).

=item * L<Skilletor::Config> – load, merge and validate the three config files; edit them.

=item * L<Skilletor::Catalog>, L<Skilletor::Bundles>, L<Skilletor::Frontmatter> –
source trees, bundle files and their YAML subset.

=item * L<Skilletor::Entry> – install entries, patterns and bundle entries.

=item * L<Skilletor::Spec> – resolve an C<add> shorthand to a source.

=item * L<Skilletor::Backend> – choose a source's backend (author mode) and build it.

=item * L<Skilletor::Source::Local>, L<Skilletor::Source::Git>, L<Skilletor::Source::Url>
– the backends (L<Skilletor::Role::Source>), with L<Skilletor::Cache>,
L<Skilletor::Tar> and L<Skilletor::Gzip>.

=item * L<Skilletor::State> – trust and the sync lock; L<Skilletor::Lock> – lock files.

=item * L<Skilletor::Targets> – harness detection and the targets merge.

=item * L<Skilletor::JSON>, L<Skilletor::JSString>, L<Skilletor::URL>,
L<Skilletor::FSUtil>, L<Skilletor::GitEnv>, L<Skilletor::Process> – JavaScript and
Node behaviour where it reaches a byte, a name or a message.

=back

Rendering and the C<sync>/C<check>/C<status> pipeline follow.

=head1 CONVENTIONS

Data structures carry the reference's field names (C<derivedName>,
C<declaredBy>, C<trustRequests>) so they compare with the TypeScript side
directly; methods are snake_case. Paths are character strings, as the
reference's are; Perl hands their UTF-8 bytes to the file system. A home
directory is always passed in – nothing reads C<$ENV{HOME}> on its own.

=attr home

Required: the home whose C<.claude/skilletor.json> and cache are used.

=attr project_dir

The project; none (or the home dir itself) means the user scope alone.

=attr fetch

C<always> (default), C<missing> or C<never>; see L</Fetching>.

=attr require_harness

True: fail as the reference does when no agent harness (Claude Code, Codex)
is detected and the user config names no C<targets>. Default false: resolving
needs no harness.

=attr state_root

=attr cache_root

=attr codex_home

=attr timeout_ms

=attr lock_timeout_ms

Passed to L<Skilletor::Resolver>; its defaults without them.

=attr resolver

The L<Skilletor::Resolver> doing the work.

=method resolve

  my $report = $sk->resolve( scope => 'user' | 'project' | 'all' );

A fresh resolve, the reference's C<ResolveReport> (see L<Skilletor::Resolver>):
C<< { scopes => [ { scope, items, sources, warnings, trustRequests } ] } >>, or
C<< { scopes => [], error => $message } >> on a config error.

=method resolve_item

  my $rec = $sk->resolve_item( skill => 'perl-moo', scope => 'all' );

The item record, or undef for a name no scope resolves to (also when the item
was declared but its source or the item itself could not be read – the
warning in L</resolve> says why):

  {
    type => 'skill', name => 'perl-moo', scope => 'project',
    source => 'shared', version => 'git:30993b3',
    source_dir => '/home/me/.claude/skilletor/cache/b966aec947fa313b',
    path  => 'skills/perl-moo',                  # relative to source_dir, as in the report
    dir   => '…/skills/perl-moo',                # a skill's directory; an agent's or rule's parent
    file  => '…/skills/perl-moo/SKILL.md',       # the main file
    files => [ '…/skills/perl-moo/SKILL.md', … ],
    description => 'Write Moo classes',          # when the frontmatter has one
    vars => { … }, declaredBy => [ … ], via => [ … ],
    templated => 0, templates => [],             # the .njk files, relative
  }

A config error throws L<Skilletor::Error::Config>; an unreadable lock file and
a sync lock held too long throw too.

=method resolve_skill

  my $file = $sk->resolve_skill( 'perl-moo', scope => 'all' );

The absolute path of the skill's C<SKILL.md> in its source tree, or undef.
Throws L<Skilletor::Error::Unsupported> for a templated skill.

=method resolve_agent

The agent's C<< <name>.md >>, as L</resolve_skill>.

=method resolve_rule

The rule's C<< <name>.md >>, as L</resolve_skill>. Claude Code reads the rules
of both scopes; ask C<< scope => 'user' >> for the user's when the project
declares one of the same name.

=method items

  my $records = $sk->items( type => 'skill', scope => 'all' );

Every item record (L</resolve_item>), one per type and name: the project's
shadows the user's. C<type> and C<scope> are optional filters.

=method refresh

Drop the resolution the lookup methods answer from; the next call resolves
again (and fetches, by L</fetch>).

=seealso

L<https://github.com/Getty/skilletor> – the reference implementation and its
design spec, F<docs/superpowers/specs/2026-09-22-skilletor-design.md>.

=cut
