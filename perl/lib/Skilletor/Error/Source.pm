package Skilletor::Error::Source;
# ABSTRACT: A source backend failed to resolve or check

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown where the reference implementation throws its C<Error>. See
L<Skilletor::Error> for the interface.

=cut
