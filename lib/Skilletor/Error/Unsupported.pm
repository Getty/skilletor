package Skilletor::Error::Unsupported;
# ABSTRACT: An item a lookup cannot serve: a Nunjucks template

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.008001';

1;

=description

Thrown by L<Skilletor/resolve_skill> and its siblings for an item with a C<.njk> file: a lookup serves files of the source tree, and an unrendered template is never served as if it were the item; a sync renders it. See L<Skilletor::Error> for the interface.

=cut
