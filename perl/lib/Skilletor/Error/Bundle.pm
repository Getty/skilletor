package Skilletor::Error::Bundle;
# ABSTRACT: A bundle file is broken or cannot be expanded (the reference's BundleError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown by L<Skilletor::Bundles> where the reference throws its C<BundleError>. See L<Skilletor::Error> for the interface.

=cut
