package Skilletor::Error::LockTimeout;
# ABSTRACT: Another run held the sync lock too long (the reference's SyncLockTimeoutError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown by L<Skilletor::State/with_lock> where the reference throws its C<SyncLockTimeoutError>. See L<Skilletor::Error> for the interface.

=cut
