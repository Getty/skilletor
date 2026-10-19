package Skilletor::Error::JSON;
# ABSTRACT: A text is not JSON (JSON.parse's SyntaxError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown where the reference implementation throws its C<SyntaxError>. See
L<Skilletor::Error> for the interface.

=cut
