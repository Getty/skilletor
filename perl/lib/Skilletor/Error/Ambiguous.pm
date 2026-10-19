package Skilletor::Error::Ambiguous;
# ABSTRACT: A lookup that would have to hide one of two items: a rule both scopes declare

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown by L<Skilletor/resolve_rule> and L<Skilletor/resolve_item> when the user
and the project scope both declare a rule of the name and no C<scope> narrows
the lookup: Claude Code loads both, neither overrides the other, so a single
answer would hide one. L<Skilletor/resolve_rules> and L<Skilletor/resolve_items>
give both. See L<Skilletor::Error> for the interface.

=cut
