#!/usr/bin/env perl
# JavaScript's numbers are doubles, and the reference reads and writes every number as one. A
# perl whose NV is wider (a long double, a __float128) holds more bits: a decimal read into it
# and then rounded to a double is rounded twice, and a number written from it shows the digits
# of the wider value. Each case runs on this perl's own way of reading decimals and, where that
# is the NV, once more on the strtod way a wider NV takes, so a double perl tests both.
use strict;
use warnings;
use Test::More;

use POSIX ();
use Skilletor::Frontmatter qw( parse_yaml_document );
use Skilletor::JSON qw( js_number js_parse js_stringify js_ordered );
use Skilletor::TOML qw( stringify_toml toml_float );

my $INF = 9**9**9;

sub toml_error {
  my ( $table ) = @_;
  return eval { stringify_toml($table); 1 } ? undef : ref $@ ? $@->message : "$@";
}

sub cases {
  # Beside the midpoint of two doubles: 1 + 2**-53 lies between 1 and 1 + 2**-52, 1 + 3 * 2**-53
  # between 1 + 2**-52 and 1 + 2**-51. A long double holds the midpoint itself, which then rounds
  # to its even neighbour, 1 or 1 + 2**-51; Node reads both texts as 1 + 2**-52.
  is( js_stringify( js_parse('1.0000000000000001110323') ), '1.0000000000000002', 'JSON: just above 1 + 2**-53' );
  is( js_stringify( js_parse('1.0000000000000003330569') ), '1.0000000000000002', 'JSON: just below 1 + 3 * 2**-53' );
  is( js_stringify( js_parse('1.0000000000000001110122') ), '1', 'JSON: just below 1 + 2**-53' );
  is( js_stringify( js_parse('[1e999,-1e999,1e-999]') ), '[null,null,0]', 'JSON: beyond the doubles' );
  is( js_stringify( js_parse('[0.1,4.35,1e-7,5e-324,1.7976931348623157e308,12345678901234567890]') ),
    '[0.1,4.35,1e-7,5e-324,1.7976931348623157e+308,12345678901234567000]', 'JSON: the shortest digits of each double' );

  my $yaml = parse_yaml_document("a: 1.0000000000000003330569\nb: 1e999\nc: -1e999\nd: .5\ne: 5.\nf: +1.5e-7\ng: -0.0\nh: 1E5\n");
  is( js_number( $yaml->{a}->value ), '1.0000000000000002', 'YAML: just below 1 + 3 * 2**-53' );
  ok( $yaml->{b}->value == $INF, 'YAML: 1e999 is Infinity' );
  ok( $yaml->{c}->value == -$INF, 'YAML: -1e999 is -Infinity' );
  is( join( ' ', map { js_number( $yaml->{$_}->value ) } qw( d e f g h ) ), '0.5 5 1.5e-7 0 100000', 'YAML: the other forms' );

  is( Skilletor::JSON::js_to_number('15e-1'), 1.5, 'js_to_number: an exponent' );
  is( Skilletor::JSON::js_to_number('-.5'), -0.5, 'js_to_number: a sign and no integer part' );
  is( js_number( Skilletor::JSON::js_to_number('1e99999999999999999999') ), 'null', 'js_to_number: an exponent beyond any integer' );
  is( js_number( Skilletor::JSON::js_to_number('0e99999999999999999999') ), '0', 'js_to_number: zero with that exponent' );
  is( js_number( Skilletor::JSON::js_to_number('1e-99999999999999999999') ), '0', 'js_to_number: and below' );
}

my @ways = ( [ 'this perl' => $Skilletor::JSON::STRTOD ], $Skilletor::JSON::STRTOD ? () : [ strtod => 1 ] );
for my $way (@ways) {
  my ( $name, $strtod ) = @$way;
  local $Skilletor::JSON::STRTOD = $strtod;
  subtest "decimals are read as Node reads them ($name)" => \&cases;
}

subtest 'Perl numbers are written as the double nearest them' => sub {
  is( js_number(0.1), '0.1', '0.1' );
  is( js_number(4.35), '4.35', '4.35' );
  is( js_number(1e-7), '1e-7', '1e-7' );
  is( js_number(-1e-6), '-0.000001', '-1e-6' );
  is( js_number(5e-324), '5e-324', 'the smallest subnormal' );
  is( js_number(123456789.123456789), '123456789.12345679', 'more digits than a double holds' );
  is( js_number(9007199254740993), '9007199254740992', 'an integer beyond 2**53' );
  is( js_number(1e400), 'null', '1e400, finite in a long double, is Infinity' );
  is( js_stringify( [ 0.2, 1e400 ] ), '[0.2,null]', 'js_stringify' );
    is( stringify_toml( js_ordered( x => toml_float(0.1), n => 1e15 ) ), "x = 0.1\nn = 1000000000000000\n", 'TOML: a float, an integer' );
  is( toml_error( js_ordered( x => toml_float(1e400) ) ), 'x: Infinity is not a finite float', 'TOML: 1e400 is no finite float' );
  ok( Skilletor::JSON::js_double(1e400) == $INF, 'js_double(1e400) is Infinity' );
};

# strtod reads the radix of LC_NUMERIC; js_to_number hands it the digits without one.
subtest 'a comma locale' => sub {
  my $was = POSIX::setlocale( POSIX::LC_NUMERIC() );
  my ($comma) = grep { POSIX::setlocale( POSIX::LC_NUMERIC(), $_ ) && POSIX::localeconv()->{decimal_point} eq ',' }
    qw( de_DE.UTF-8 de_DE.utf8 de_DE fr_FR.UTF-8 fr_FR.utf8 fr_FR );
  plan skip_all => 'no locale with a decimal comma here' unless $comma;
  local $Skilletor::JSON::STRTOD = 1;
  is( js_stringify( js_parse('[0.1,1.0000000000000003330569]') ), '[0.1,1.0000000000000002]', "$comma: js_parse, js_number" );
  is( Skilletor::JSON::js_to_number('1.5'), 1.5, "$comma: 1.5" );
  POSIX::setlocale( POSIX::LC_NUMERIC(), $was );
};

done_testing;
