package Skilletor::Targets;
# ABSTRACT: Which agent harnesses a sync installs for (detection and the targets merge)

use strict;
use warnings;

use Exporter qw( import );
use Skilletor::Error::Target;
use Skilletor::FSUtil qw( path_join );
use Skilletor::JSString qw( js_trim );

our $VERSION = '0.001';

our @EXPORT_OK = qw( DETECTED default_markers detect_harnesses select_targets default_hermes_home );

# Only Claude and Codex are detected; Hermes is a target only when `targets` names it.
use constant DETECTED => qw( claude codex );

sub default_markers {
  my ( $home, $codex_home ) = @_;
  my $cx = ( defined $codex_home && length $codex_home ) ? $codex_home : path_join( $home, '.codex' );
  return {
    claude => [ path_join( $home, '.claude.json' ), path_join( $home, '.claude', 'settings.json' ), path_join( $home, '.claude', 'projects' ) ],
    codex  => [ map { path_join( $cx, $_ ) } qw( config.toml auth.json sessions installation_id ) ],
  };
}

sub detect_harnesses {
  my ( $markers ) = @_;
  return [ grep { my $h = $_; grep { -e $_ } @{ $markers->{$h} // [] } } DETECTED ];
}

# Hermes' default home: ~/.hermes; on native Windows %LOCALAPPDATA%\hermes.
sub default_hermes_home {
  my ( $home, $platform, $env ) = @_;
  $platform //= $^O;
  $env //= \%ENV;
  return path_join( $home, '.hermes' ) unless $platform eq 'MSWin32';
  my $local = js_trim( $env->{LOCALAPPDATA} // '' );
  $local = $home.'\\AppData\\Local' unless length $local;
  ( my $joined = $local.'\\hermes' ) =~ s{[\\/]+}{\\}g;
  return $joined;
}

# The merge rule (spec §14.1): machine = user targets // detected (empty is an error); the user
# scope gets the machine set; the project scope the machine set narrowed to the project's.
sub select_targets {
  my ( $configured, $detected, $markers ) = @_;
  my $machine = $configured->{user} // $detected;
  unless (@$machine) {
    my $looked = $markers
      ? ' (looked for '.join( '; ', map { $_.': '.join( ', ', @{ $markers->{$_} } ) } grep { $markers->{$_} } DETECTED ).')'
      : '';
    Skilletor::Error::Target->throw( 'no agent harness detected'.$looked
      .'; set "targets": ["claude"], "codex" and/or "hermes" in ~/.claude/skilletor.json' );
  }
  my @warnings;
  my $project = [@$machine];
  if ( my $want = $configured->{project} ) {
    my %in = map { $_ => 1 } @$want;
    $project = [ grep { $in{$_} } @$machine ];
    unless (@$project) {
      push @warnings, 'project targets ('.join( ', ', @$want ).') are not in use on this machine '
        .'('.join( ', ', @$machine ).'); nothing is installed for the project';
    }
  }
  return { user => [@$machine], project => $project, warnings => \@warnings };
}

1;

=synopsis

  use Skilletor::Targets qw( default_markers detect_harnesses select_targets );

  my $markers = default_markers( $home, $ENV{CODEX_HOME} );
  my $sel = select_targets(
    { user => $config->user->{targets}, project => $config->project && $config->project->{targets} },
    detect_harnesses($markers),
    $markers,
  );
  # { user => ['claude'], project => ['claude'], warnings => [] }

=description

The detection and target selection of the reference's C<targets.ts>
(spec §14.1). A harness is detected by markers it creates itself, never by
C<~/.claude> alone. Where each harness reads each item type (the layout table)
is not ported yet.

=func default_markers

  default_markers( $home, $codex_home );

C<< { claude => [...], codex => [...] } >>: the paths whose existence means the
harness is in use.

=func detect_harnesses

The detected harnesses, in the order C<claude>, C<codex>.

=func select_targets

  select_targets( { user => $u, project => $p }, $detected, $markers );

C<< { user => [...], project => [...], warnings => [...] } >>; throws
L<Skilletor::Error::Target> when no harness applies.

=func default_hermes_home

  default_hermes_home( $home, $platform, \%env );

=func DETECTED

The harnesses detection looks for: C<claude>, C<codex>.

=cut
