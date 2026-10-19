package Skilletor::Error::Tar;
# ABSTRACT: A url source's archive is unsafe (the reference's TarError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown where the reference implementation throws its C<TarError>. See
L<Skilletor::Error> for the interface.

=cut
