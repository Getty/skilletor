package Skilletor::Error::Catalog;
# ABSTRACT: A source tree cannot be scanned (the reference's CatalogError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown by L<Skilletor::Catalog> where the reference throws its C<CatalogError>, and for a file system call that fails during a scan, worded as Node words it. See L<Skilletor::Error> for the interface.

=cut
