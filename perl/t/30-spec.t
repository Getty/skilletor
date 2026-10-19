#!/usr/bin/env perl
use strict;
use warnings;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( error_of );

use Path::Tiny qw( path );
use Skilletor::JSON qw( js_parse js_stringify );
use Skilletor::Spec qw( resolve_spec decode_uri_component normalize_name );

# t/data/spec-oracle.json: the reference's resolveSpec for every string literal of its own
# test/spec.test.ts and maint/spec-extra.json, with the probe below (maint/oracle-spec.mjs).
my $oracle = js_parse( path( $FindBin::Bin, 'data', 'spec-oracle.json' )->slurp_utf8 );

# Where the port knowingly differs: spec.ts looks a forge up as FORGES[host], which an
# inherited property passes – "constructor/foo" became https://constructor/foo/skills.
my %DIVERGES = (
  'constructor/foo' => { kind => 'git', value => 'https://github.com/constructor/foo', derivedName => 'foo' },
  '__proto__/x'     => 'cannot resolve "__proto__/x": GitHub owner "__proto__" may only contain ASCII letters, digits and "-"; '
    .'expected a local path (/path, ./path, ../path, ~/path), scheme://..., transport::address, user@host:path, '
    .'github:owner[/repo], owner[/repo] or host.tld[/path]',
);

for my $case (@$oracle) {
  my $spec = $case->{spec};
  my @probed;
  my $probe = sub {
    my ( $url ) = @_;
    push @probed, $url;
    return { git => scalar( $url =~ /git/ ), tarball => scalar( $url =~ /tar|tgz|pkg/ ) };
  };
  my $result;
  my $err = error_of( sub { $result = resolve_spec( $spec, $probe ) } );
  my $label = js_stringify($spec);
  if ( exists $case->{error} ) {
    is( $err, $case->{error}, 'error for '.$label );
  }
  else {
    is( $err, undef, 'resolves '.$label ) or next;
    is_deeply( $result, { %{ $case->{result} } }, 'result for '.$label );
  }
  is_deeply( \@probed, $case->{probed}, 'probed for '.$label );
}

for my $spec ( sort keys %DIVERGES ) {
  my $want = $DIVERGES{$spec};
  my $result;
  my $err = error_of( sub { $result = resolve_spec( $spec, sub { {} } ) } );
  if ( ref $want ) { is_deeply( $result, $want, 'known divergence (inherited key): '.$spec ) }
  else             { is( $err, $want, 'known divergence (inherited key): '.$spec ) }
}

is( decode_uri_component('a%20b%C3%BC%2F'), "a b\x{fc}/", 'decodeURIComponent' );
ok( !defined decode_uri_component($_), 'URIError for '.$_ ) for qw( % %4 %zz %C3 %C3%28 %ED%A0%80 %C0%AF %F8%80%80%80 );
is( normalize_name('My.Repo.git'), 'my-repo', 'normalize_name' );

done_testing;
