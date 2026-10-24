package Skilletor::Error::Target;
# ABSTRACT: No agent harness can be targeted (the reference's TargetError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown where the reference implementation throws its C<TargetError>. See
L<Skilletor::Error> for the interface.

=cut
