package Skilletor::CLI;
# ABSTRACT: Retired stub, see Skilletor

use strict;
use warnings;

our $VERSION = '0.009000';

our $NOTICE = q{skilletor's Perl port is retired: the CPAN distribution Skilletor ships only empty stubs now. Install skilletor as the plugin for Claude Code (/plugin marketplace add Getty/marketplace, then /plugin install skilletor@getty), Codex or Hermes Agent, or with install.sh for the command line: https://github.com/Getty/skilletor#install. Then remove this distribution with cpanm --uninstall Skilletor.};

sub run {
  shift if @_ && defined $_[0] && $_[0] eq __PACKAGE__;
  print STDERR "$NOTICE\n";
  return @_ && defined $_[0] && $_[0] eq 'hook' ? 0 : 1;
}

=method run

    exit Skilletor::CLI::run(@ARGV);
    exit Skilletor::CLI->run(@ARGV);

Prints the retirement notice, C<$Skilletor::CLI::NOTICE>, and a newline to
standard error and returns the exit status: 0 when the first argument is
C<hook>, else 1. Called as a class method, it drops the class name first. The
C<skilletor> program calls the function form, the one of 0.008000 too, so a
C<skilletor> command left over from that release says what to do.

C<hook> returns 0, unlike every other command (and unlike the retired
App-Briefing, whose stub always returns 1): the plugins run C<skilletor hook>
at session events, and a hook exits 0 whatever happens (skilletor's design
spec, section 8). A plugin checkout that still starts this Perl code thus never
disturbs the session.

=cut

1;

=description

A stub: skilletor's Perl port is retired. L<Skilletor> names the replacement.
Only L</run> is left, for the C<skilletor> command.

This last release of the distribution ships its modules as empty stubs, so an
upgrade replaces the earlier library code.

=seealso

=over

=item * L<Skilletor>

=item * L<https://github.com/Getty/skilletor#install>

=back

=cut
