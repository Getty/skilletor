package Skilletor::Error::CacheRejected;
# ABSTRACT: A cache that must not be served (the reference's CacheRejected)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown where the reference implementation throws its C<CacheRejected>. See
L<Skilletor::Error> for the interface.

=cut
