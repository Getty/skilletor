package Skilletor;
# ABSTRACT: Install skills, agents and rules from remote sources – the Perl port of skilletor

use strict;
use warnings;

our $VERSION = '0.001';

1;

=synopsis

  use Skilletor::Config;
  use Skilletor::Backend;
  use Skilletor::State;
  use Skilletor::Cache qw( cache_root );

  my $home   = $ENV{HOME};
  my $config = Skilletor::Config->load( home => $home, project_dir => $project );
  my $state  = Skilletor::State->for_home($home);

  for my $name ( $config->source_names ) {
    my $backend = Skilletor::Backend->resolve( $config->source($name), $home );
    next unless $state->is_trusted( $name, $backend );    # a project's own source: ask first
    my $loc = Skilletor::Backend->make( $backend, cache_root($home) )->resolve;
    print "$name: $loc->{dir} ($loc->{version})\n";
    warn "$loc->{warning}\n" if $loc->{warning};
  }

=description

L<skilletor|https://github.com/Getty/skilletor> installs skills, agents and
rules from remote sources (git repositories, https tarballs, local
directories) into Claude Code, Codex and Hermes, at user and project scope.
Its reference implementation is TypeScript; this distribution is its Perl
port, living in the same repository, for Perl programs – an agent such as
L<Langertha::Raider> – that must resolve skills exactly as skilletor does,
straight from the same config and the same cache, without Node.

The port shares everything on disk with the reference: the config files
(C<~/.claude/skilletor.json>, C<< <project>/.claude/skilletor.json >>,
C<skilletor.local.json>), the source cache under C<~/.claude/skilletor/cache>
(the same directory names, so one fetch serves both), C<trust.json>, and the
JSON bytes either writes. Error messages are the reference's, word for word.

This release lays the foundation:

=over 4

=item * L<Skilletor::Config> – load, merge and validate the three config files; edit them.

=item * L<Skilletor::Entry> – install entries, patterns and bundle entries.

=item * L<Skilletor::Spec> – resolve an C<add> shorthand to a source.

=item * L<Skilletor::Backend> – choose a source's backend (author mode) and build it.

=item * L<Skilletor::Source::Local>, L<Skilletor::Source::Git>, L<Skilletor::Source::Url>
– the backends (L<Skilletor::Role::Source>), with L<Skilletor::Cache>,
L<Skilletor::Tar> and L<Skilletor::Gzip>.

=item * L<Skilletor::State> – trust.

=item * L<Skilletor::Targets> – harness detection and the targets merge.

=item * L<Skilletor::JSON>, L<Skilletor::JSString>, L<Skilletor::URL>,
L<Skilletor::FSUtil>, L<Skilletor::GitEnv>, L<Skilletor::Process> – JavaScript and
Node behaviour where it reaches a byte, a name or a message.

=back

Catalog scan, bundles and wildcard expansion, rendering, and the
C<sync>/C<check>/C<status> pipeline follow.

=head1 CONVENTIONS

Data structures carry the reference's field names (C<derivedName>,
C<claudeSettings>, C<origins>) so they compare with the TypeScript side
directly; methods are snake_case. Paths are character strings, as the
reference's are; Perl hands their UTF-8 bytes to the file system. A home
directory is always passed in – nothing reads C<$ENV{HOME}> on its own.

=seealso

L<https://github.com/Getty/skilletor> – the reference implementation and its
design spec, F<docs/superpowers/specs/2026-09-22-skilletor-design.md>.

=cut
