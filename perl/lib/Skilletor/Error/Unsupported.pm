package Skilletor::Error::Unsupported;
# ABSTRACT: An item the Perl port cannot serve: a Nunjucks template

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown by L<Skilletor/resolve_skill> and its siblings for an item with a C<.njk> file: the Perl port renders no templates, and an unrendered template is never served as if it were the item. See L<Skilletor::Error> for the interface.

=cut
