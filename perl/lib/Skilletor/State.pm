package Skilletor::State;
# ABSTRACT: Instance state under ~/.claude/skilletor – trust so far

use Moo;
use Path::Tiny qw( path );
use Skilletor::FSUtil qw( read_text write_text path_join );
use Skilletor::JSON qw( js_parse js_stringify js_ordered js_type );
use namespace::clean;

our $VERSION = '0.001';

has root => (
  is       => 'ro',
  required => 1,
);

sub BUILD {
  my ( $self ) = @_;
  path( $self->root )->mkpath;
}

sub for_home {
  my ( $class, $home ) = @_;
  return $class->new( root => $class->default_root($home) );
}

sub default_root {
  my ( $class, $home ) = @_;
  return path_join( $home, '.claude', 'skilletor' );
}

sub _file { path_join( $_[0]->root, $_[1] ) }

# A state file as an object; anything unreadable or no object reads as an empty one.
sub _read_json {
  my ( $self, $name ) = @_;
  my $value = eval { js_parse( read_text( $self->_file($name) ) ) };
  return ( defined $value && js_type($value) eq 'object' ) ? $value : js_ordered();
}

sub _write_json {
  my ( $self, $name, $value ) = @_;
  write_text( $self->_file($name), js_stringify( $value, 2 )."\n" );
}

#### Trust #############################################################

sub trust {
  my ( $self, $name, $backend ) = @_;
  my $trust = $self->_read_json('trust.json');
  $trust->{$name} = js_ordered( kind => $backend->{kind}, address => $backend->{address} );
  $self->_write_json( 'trust.json', $trust );
}

# A user-origin backend is trusted as is; a project-origin one needs an entry for exactly its
# kind and address. An entry written before k66 is the URL alone: it counts for a git or url
# backend at exactly that URL, never for a local one.
sub is_trusted {
  my ( $self, $name, $backend ) = @_;
  return 1 if ( $backend->{origin} // '' ) eq 'user';
  my $trust = $self->_read_json('trust.json');
  return 0 unless exists $trust->{$name};
  my $entry = $trust->{$name};
  my $type  = js_type($entry);
  if ( $type eq 'string' ) {
    return ( $backend->{kind} ne 'local' && $entry eq $backend->{address} ) ? 1 : 0;
  }
  return 0 unless $type eq 'object';
  return ( js_type( $entry->{kind} ) eq 'string' && $entry->{kind} eq $backend->{kind}
      && js_type( $entry->{address} ) eq 'string' && $entry->{address} eq $backend->{address} ) ? 1 : 0;
}

1;

=synopsis

  use Skilletor::State;

  my $state = Skilletor::State->for_home( $ENV{HOME} );     # ~/.claude/skilletor
  $state->trust( team => { kind => 'git', address => 'https://example.com/team/skills' } );

  my $ok = $state->is_trusted( team => { kind => 'git', address => '…', origin => 'project' } );

=description

The reference's C<state.ts>, so far its trust part (spec §4.3): a source only a
project config declares is not fetched until the user trusts it, and the
confirmation – name, backend kind and address – lives in C<trust.json> under
the state root. Both implementations read and write the same file, the same
bytes: entries keep their order, a new name is appended, and an unreadable file
counts as empty.

Last-check marks, pending reports, the sync lock and the other state files come
with the sync phase.

=attr root

The state directory; created when the object is.

=method for_home

  Skilletor::State->for_home($home);

=method default_root

C<< <home>/.claude/skilletor >>.

=method trust

  $state->trust( $name, { kind => 'git', address => $url } );

Replaces an earlier entry of the name.

=method is_trusted

  $state->is_trusted( $name, { kind => ..., address => ..., origin => 'user' | 'project' } );

=cut
