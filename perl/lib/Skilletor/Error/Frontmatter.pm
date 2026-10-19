package Skilletor::Error::Frontmatter;
# ABSTRACT: YAML frontmatter or a bundle file outside the supported subset (the reference's FrontmatterError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.001';

1;

=description

Thrown by L<Skilletor::Frontmatter> where the reference throws its C<FrontmatterError>; the message names the line. See L<Skilletor::Error> for the interface.

=cut
