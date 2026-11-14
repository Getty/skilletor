package Skilletor::Error::Command;
# ABSTRACT: A command refused before it changed anything (the reference's CommandError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown by L<Skilletor::Commands> where the reference's F<src/commands.ts>
throws its C<CommandError>: an unknown source to trust or to list
C<available>; a source to add whose name or definition config load would
refuse, whose name the target config already has with another address, or
without the ref or path the spec names, or whose kept entry config load would
refuse; a source to remove that the target config does not declare, that other
files' entries still need or that has installed items; an edit with
C<--project> without a project scope. The CLI prints the message after
C<skilletor: > and exits 1. See L<Skilletor::Error> for the interface.

=cut
