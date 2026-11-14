package Skilletor::Error::Command;
# ABSTRACT: A command refused before it changed anything (the reference's CommandError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown by L<Skilletor::Commands> where the reference's F<src/commands.ts>
throws its C<CommandError>: an unknown source to trust, a source to remove
that the target config does not declare, that other files' entries still need
or that has installed items, an edit with C<--project> without a project
scope. The CLI prints the message after C<skilletor: > and exits 1. See
L<Skilletor::Error> for the interface.

=cut
