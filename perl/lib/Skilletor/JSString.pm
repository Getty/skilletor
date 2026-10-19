package Skilletor::JSString;
# ABSTRACT: String operations as JavaScript performs them

use strict;
use warnings;

use Exporter qw( import );

our $VERSION = '0.001';

our @EXPORT_OK = qw( js_lc js_trim js_ws_re js_blank );

# JavaScript's WhiteSpace and LineTerminator (what \s and String.prototype.trim take): unlike
# Perl's \s, U+FEFF is one and U+0085 is none.
my $WS = qr/[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]/;

sub js_ws_re { $WS }

sub js_trim {
  my ( $s ) = @_;
  $s =~ s/\A$WS+//;
  $s =~ s/$WS+\z//;
  return $s;
}

sub js_blank {
  my ( $s ) = @_;
  return js_trim($s) eq '' ? 1 : 0;
}

# String.prototype.toLowerCase: Perl's full lower-case mapping, plus the one context rule
# JavaScript applies – a capital sigma ending a word is a final sigma.
sub js_lc {
  my ( $s ) = @_;
  return lc $s unless $s =~ /\x{3A3}/;
  my @c = split //, $s;
  my $out = '';
  for my $i ( 0 .. $#c ) {
    if ( $c[$i] eq "\x{3A3}" && _final_sigma( \@c, $i ) ) {
      $out .= "\x{3C2}";
      next;
    }
    $out .= lc $c[$i];
  }
  return $out;
}

sub _final_sigma {
  my ( $c, $i ) = @_;
  my $j = $i - 1;
  $j-- while $j >= 0 && $c->[$j] =~ /\p{Case_Ignorable}/;
  return 0 unless $j >= 0 && $c->[$j] =~ /\p{Cased}/;
  my $k = $i + 1;
  $k++ while $k < @$c && $c->[$k] =~ /\p{Case_Ignorable}/;
  return !( $k < @$c && $c->[$k] =~ /\p{Cased}/ );
}

1;

=synopsis

  use Skilletor::JSString qw( js_lc js_trim );

  js_lc('ΟΔΟΣ');        # 'οδος' with a final sigma, as toLowerCase gives it
  js_trim("\x{FEFF} x ");  # 'x'

=description

The reference implementation lower-cases item names, trims specs and tests
whitespace with JavaScript's string methods; where Perl's builtins differ, a
name or a message would differ. These functions are the JavaScript behaviour.

=func js_lc

C<String.prototype.toLowerCase>.

=func js_trim

C<String.prototype.trim>.

=func js_blank

True when C<js_trim> leaves nothing.

=func js_ws_re

The compiled character class of JavaScript's C<\s>.

=cut
