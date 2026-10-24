package Skilletor::Error::Apply;
# ABSTRACT: A build plan that cannot be applied: an invalid item name, a path leaving its root

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown by L<Skilletor::Apply/apply>, worded as the reference's C<ApplyError>
(C<invalid item name: …>, C<path escapes target: …>). What the run wrote before
it is owned by the lock, its entries marked C<partial>. See L<Skilletor::Error>
for the interface.

=cut
