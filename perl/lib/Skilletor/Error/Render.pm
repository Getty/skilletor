package Skilletor::Error::Render;
# ABSTRACT: A template cannot be rendered (the reference's RenderError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

# The reference's class name: Nunjucks words an error thrown inside a template's include as
# `NAME: MESSAGE`, and Text::Nunjucks asks the error for both.
sub name { 'RenderError' }

1;

=description

Thrown by L<Skilletor::Render/build> where the reference throws its
C<RenderError>: a template that fails to render (C<< <file>: <message> >>, the
message Nunjucks gives) and an include or import that leaves the source root
(C<< template escapes source root: <name> >>). See L<Skilletor::Error> for the
interface.

=method name

C<RenderError>, the reference's class name.

=cut
