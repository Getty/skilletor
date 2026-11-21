package Skilletor::Error::Block;
# ABSTRACT: The skilletor markers in an AGENTS.md are malformed (the reference's BlockError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.008000';

1;

=description

Thrown by L<Skilletor::AgentsMD/parse_block> where the reference throws its
C<BlockError>: a C<< <!-- skilletor:begin --> >> or C<< <!-- skilletor:end -->
>> twice, one without the other, or the end before the begin.
L<Skilletor::AgentsMD/inspect_agents_md> turns it into the reason a sync
leaves the pointer alone. See L<Skilletor::Error> for the interface.

=cut
