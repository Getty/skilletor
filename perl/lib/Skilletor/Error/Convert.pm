package Skilletor::Error::Convert;
# ABSTRACT: An item cannot be converted for a harness (the reference's ConvertError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown by L<Skilletor::Convert> where the reference throws its C<ConvertError>:
an agent Codex would reject (no description, an empty name, a
C<codex.briefing> key, a C<briefing.skills> name the comment line cannot
carry), a rule that holds a skilletor marker line, unreadable frontmatter (the
L<Skilletor::Error::Frontmatter> message), a file missing from the build. See
L<Skilletor::Error> for the interface.

=cut
