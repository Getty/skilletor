package Skilletor::AgentSkills;
# ABSTRACT: Are the skills an installed agent declares there? (spec §6.7)

use strict;
use warnings;
use utf8;

use Encode ();
use Exporter qw( import );
use Skilletor::FSUtil qw( encode_text path_join read_text );
use Skilletor::Frontmatter qw( split_frontmatter );
use Skilletor::JSON qw( js_sort_keys js_type );

our $VERSION = '0.008001';

our @EXPORT_OK = qw( declared_skills skill_roots missing_skills skills_warning );

# The skills an installed agent file declares in its top-level `skills:`; undef when it cannot be read.
sub declared_skills {
  my ( $text ) = @_;
  my $fm = eval { split_frontmatter($text) } or return undef;
  my $skills = $fm->{data}{skills};
  return [] unless js_type($skills) eq 'array';
  return [ grep { !ref $_ && js_type($_) eq 'string' && length } @$skills ];
}

sub _subdirs {
  my ( $dir ) = @_;
  opendir( my $dh, encode_text($dir) ) or return ();
  my @names = grep { $_ ne '.' && $_ ne '..' } readdir $dh;
  closedir $dh;
  return js_sort_keys( grep { my $p = encode_text( path_join( $dir, $_ ) ); !-l $p && -d $p } map { Encode::decode( 'UTF-8', $_ ) } @names );
}

# <claude config dir>/plugins/cache/*/skills and …/cache/*/*/skills, as far as they exist.
sub _plugin_cache_roots {
  my ( $claude_dir ) = @_;
  my $cache = path_join( $claude_dir, 'plugins', 'cache' );
  my @out;
  for my $a ( _subdirs($cache) ) {
    push @out, path_join( $cache, $a, 'skills' );
    push @out, path_join( $cache, $a, $_, 'skills' ) for _subdirs( path_join( $cache, $a ) );
  }
  return @out;
}

# The skill roots Claude Code searches for an agent of this scope.
# $r: { home, claude_dir?, project_dir? }; claude_dir defaults to <home>/.claude.
sub skill_roots {
  my ( $scope, $r ) = @_;
  my $project = ( $scope eq 'project' && defined $r->{project_dir} && length $r->{project_dir} ) ? $r->{project_dir} : undef;
  my $claude_dir = ( defined $r->{claude_dir} && length $r->{claude_dir} ) ? $r->{claude_dir} : path_join( $r->{home}, '.claude' );
  return [ ( $project ? path_join( $project, '.claude', 'skills' ) : () ), path_join( $claude_dir, 'skills' ),
    _plugin_cache_roots($claude_dir) ];
}

# Bare declared skill names of the agent file that resolve in none of the roots; undef when the
# file cannot be read or parsed.
sub missing_skills {
  my ( $file, $roots ) = @_;
  my $text = eval { read_text($file) };
  return undef unless defined $text;
  my $declared = declared_skills($text) or return undef;
  my @missing;
  for my $name (@$declared) {
    next if index( $name, ':' ) >= 0 || grep { $_ eq $name } @missing;
    # A name that is not one path segment resolves nowhere (and is never probed).
    my $segment = $name !~ m{[\\/]} && $name ne '.' && $name ne '..';
    push @missing, $name if !$segment || !grep { -e encode_text( path_join( $_, $name, 'SKILL.md' ) ) } @$roots;
  }
  return \@missing;
}

sub skills_warning {
  my ( $name, $harness, $missing ) = @_;
  return 'agent '.$name.' ('.$harness.'): skills not installed: '.join( ', ', @$missing ).' — '
    .'install them, or ship the agent and its skills together as a bundle';
}

1;

=synopsis

  use Skilletor::AgentSkills qw( skill_roots missing_skills skills_warning );

  my $roots   = skill_roots( project => { home => $home, project_dir => $project } );
  my $missing = missing_skills( "$project/.claude/agents/.local.reviewer.md", $roots );
  print skills_warning( 'reviewer', 'claude', $missing ), "\n" if $missing && @$missing;

=description

The reference's C<agent-skills.ts> (spec §6.7). A Claude agent declares the skills Claude
Code preloads for it in the top-level C<skills:> of its frontmatter; Claude Code skips a name
it cannot find without a word. This reads the installed agent file – never renders it – and
names the bare skill names no root Claude Code's lookup searches holds: the project's
C<.claude/skills> (a project agent), C<~/.claude/skills> and Claude Code's plugin cache.
C<plugin:skill> names are not checked. Only Claude agents are checked: the Codex role file
carries no skills. Read-only; a file it cannot parse yields nothing.

=func declared_skills

  declared_skills($text);   # [ names ], or undef when the frontmatter cannot be read

=func skill_roots

  skill_roots( $scope, { home, claude_dir?, project_dir? } );

=func missing_skills

  missing_skills( $file, $roots );   # [ names ], or undef

=func skills_warning

The report line for one agent and target.

=cut
