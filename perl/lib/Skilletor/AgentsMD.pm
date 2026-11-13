package Skilletor::AgentsMD;
# ABSTRACT: The Codex rules file's name, its marker lines and the text of a section

use strict;
use warnings;

use Exporter qw( import );
use Skilletor::JSString qw( js_ws_re );

our $VERSION = '0.002';

our @EXPORT_OK = qw( RULES_FILE MARKER_LINE normalize_section );

use constant RULES_FILE => 'skilletor-rules.md';

# Any skilletor marker line; a rule body must not contain one. `\b` with JavaScript's ASCII
# word characters, so `<!-- skilletor:ruleé` is one too.
use constant MARKER_LINE => qr/\A<!-- skilletor:(?:begin|end|rules?)\b/a;

my $WS = js_ws_re();

sub normalize_section {
  my ( $text ) = @_;
  $text =~ s/\A(?:[ \t]*\r?\n)+//;
  $text =~ s/$WS+\z//;
  return $text."\n";
}

1;

=synopsis

  use Skilletor::AgentsMD qw( RULES_FILE MARKER_LINE normalize_section );

  my $text = normalize_section("\n\nUse tabs.\n\n");   # "Use tabs.\n"
  die 'marker' if grep { $_ =~ MARKER_LINE } split /\n/, $body;

=description

The part of the reference's C<agentsmd.ts> (spec §14.8) that
L<Skilletor::Convert> needs to turn a rule into its section of the Codex rules
file. The rest of that module – the rules file itself, the pointer block in a
Codex C<AGENTS.md>, the checks of Codex's C<config.toml> – is not ported yet.

=func RULES_FILE

C<skilletor-rules.md>, the rules file's name in C<$CODEX_HOME> (user scope) or
C<< <repo>/.codex >> (project scope), and the lock key of every rule section.

=func MARKER_LINE

A pattern for a skilletor marker line (C<< <!-- skilletor:begin >>, C<end>,
C<rule>, C<rules>), matched against a trimmed line.

=func normalize_section

Leading blank lines and trailing whitespace (JavaScript's C<\s>) dropped, one
final newline added.

=cut
