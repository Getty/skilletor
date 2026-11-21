package Skilletor::Error::Command;
# ABSTRACT: A command refused before it changed anything (the reference's CommandError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.008001';

1;

=description

Thrown by L<Skilletor::Commands> where the reference's F<src/commands.ts>
throws its C<CommandError>: an unknown source to trust or to list
C<available>; a source to add whose name or definition config load would
refuse, whose name the target config already has with another address, or
without the ref or path the spec names, or whose kept entry config load would
refuse; a source to remove that the target config does not declare, that other
files' entries still need or that has installed items; an item to install
that it cannot read, of an unknown or untrusted source, unknown or ambiguous
there, with an error of its own, or a bundle that does not exist or does not
expand, and a bundle's sources missing with no terminal to ask on; an item to
uninstall that is ambiguous or not explicitly declared in the target config;
an edit
with C<--project> without a project scope. The CLI prints the message after
C<skilletor: > and exits 1. See L<Skilletor::Error> for the interface.

=cut
