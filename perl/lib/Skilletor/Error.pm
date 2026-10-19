package Skilletor::Error;
# ABSTRACT: Exception base class of Skilletor

use Moo;
use Carp qw( croak );
use overload
  '""'     => sub { $_[0]->message },
  'bool'   => sub { 1 },
  fallback => 1;
use namespace::clean;

our $VERSION = '0.001';

has message => (
  is       => 'ro',
  required => 1,
);

sub throw {
  my ( $class, @args ) = @_;
  croak( $class->new( @args == 1 ? ( message => $args[0] ) : @args ) );
}

1;

=synopsis

  use Skilletor::Error::Config;

  Skilletor::Error::Config->throw('~/.claude/skilletor.json: sources must be an object');

  # caller
  my $ok = eval { ...; 1 };
  if ( !$ok && ref $@ && $@->isa('Skilletor::Error::Config') ) {
    print $@->message, "\n";
  }

=description

Every error Skilletor reports to a user is an object of a subclass of this
class. Its L</message> is the reference implementation's message for the same
case, exactly – no Perl file and line appended – and the object stringifies to
it, so C<print "$@"> shows what C<skilletor> would show.

=attr message

The message, as the reference implementation words it.

=method throw

  Skilletor::Error::Config->throw($message);
  Skilletor::Error::Config->throw( message => $message );

Builds the error and C<croak>s with it.

=seealso

L<Skilletor::Error::Config>, L<Skilletor::Error::Spec>, L<Skilletor::Error::Source>,
L<Skilletor::Error::Tar>, L<Skilletor::Error::JSON>, L<Skilletor::Error::Target>

=cut
