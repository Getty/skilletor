package Skilletor::Render::Loader;
# ABSTRACT: A Nunjucks loader confined to an item's source root – the reference's makeLoader

use Moo;
use Path::Tiny qw( path );
use Skilletor::Error::Render;
use Skilletor::FSUtil qw( decode_utf8_lossy encode_text path_resolve );
use namespace::clean;

extends 'Text::Nunjucks::Loader';

our $VERSION = '0.008001';

has root => (
  is       => 'ro',
  required => 1,
);

# The reference's loader has no isRelative, so Nunjucks never resolves a name against the
# template that includes it: `./x.md` and `../x.md` are relative to the source root as well.
sub is_relative { 0 }

sub get_source {
  my ( $self, $name ) = @_;
  my $base = path_resolve( $self->root );
  my $path = path_resolve( $base, $name );
  Skilletor::Error::Render->throw( 'template escapes source root: '.$name ) if $path ne $base && index( $path, $base.'/' ) != 0;
  # readFileSync(path, "utf8"): whatever cannot be read (missing, a directory) is no template.
  my $bytes = eval { path( encode_text($path) )->slurp_raw };
  return undef unless defined $bytes;
  return { src => decode_utf8_lossy($bytes), path => $path, noCache => !!1 };
}

1;

=synopsis

  use Text::Nunjucks::Environment;
  use Skilletor::Render::Loader;

  my $env = Text::Nunjucks::Environment->new( Skilletor::Render::Loader->new( root => $source_dir ),
    { autoescape => !!0, throwOnUndefined => !!1 } );

=description

The loader L<Skilletor::Render> renders an item's templates through: a
L<Text::Nunjucks::Loader> that serves files of one source tree, the reference's
C<makeLoader> (spec §5). A template, an include, an import or a macro file is
looked up by its path relative to the source root; a name that resolves outside
it – C<../x.md>, C</etc/passwd> – throws a L<Skilletor::Error::Render>
C<< template escapes source root: <name> >>. A file is read as UTF-8 the way
Node reads it (an ill-formed sequence becomes U+FFFD) and never cached.

=attr root

The source root, the item's source tree.

=method get_source

  $loader->get_source('snippets/shared.md');   # { src, path, noCache }

The template's source and absolute path, or undef when there is no such file.

=method is_relative

False for every name: a name is always relative to the source root, never to
the template that includes it.

=cut
