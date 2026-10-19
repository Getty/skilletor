package Skilletor::Error::Spec;
# ABSTRACT: An add shorthand cannot be resolved (the reference's SpecError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown where the reference implementation throws its C<SpecError>. See
L<Skilletor::Error> for the interface.

=cut
