package Skilletor::Error::Lock;
# ABSTRACT: A scope's lock file cannot be read (the reference's LockError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown by L<Skilletor::Lock> where the reference throws its C<LockError>. See L<Skilletor::Error> for the interface.

=cut
