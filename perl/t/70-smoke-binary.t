#!/usr/bin/env perl
# The keeper of scripts/smoke-binary.sh's expectation (skill perl-par-binary-release): the
# release-binaries workflow smokes each packed binary on a clean machine against
# t/data/smoke/expected.txt. This test runs the same script with the Perl CLI from lib/ in place
# of the binary, so the transcript is what the Perl code writes and the smoke cannot rot.
# Regenerate after a change to the CLI's output (then review the diff):
#   SKILLETOR_SMOKE_UPDATE=1 prove -l t/70-smoke-binary.t
use strict;
use warnings;
use Test::More;
use FindBin;
use Cwd ();
use Path::Tiny qw( path tempdir );

my $dist = path( $FindBin::Bin, '..' )->realpath;
my $script = $dist->child( 'scripts', 'smoke-binary.sh' );
plan skip_all => 'needs scripts/smoke-binary.sh and ../package.json (a skilletor checkout)'
  unless $script->is_file && $dist->parent->child('package.json')->is_file;
plan skip_all => 'a Unix shell test (the Windows smoke runs in the workflow)' if $^O eq 'MSWin32';
plan skip_all => 'needs bash and tar' unless grep { -x "$_/bash" } split /:/, $ENV{PATH} // '';

# The stand-in binary: this perl running bin/skilletor from lib/, its module path baked in,
# since the script runs the binary under `env -i`.
sub sq { my $s = shift; $s =~ s/'/'\\''/g; "'$s'" }
my $tmp  = tempdir;
my $base = 'skilletor-smoke-linux-x86_64';
my $bin  = $tmp->child($base);
my $perl5lib = join ':', $dist->child('lib'), map { path($_)->absolute } grep { length } split /:/, $ENV{PERL5LIB} // '';
$bin->spew_raw( "#!/bin/sh\nPERL5LIB=".sq($perl5lib)." exec ".sq($^X).' '.sq( $dist->child( 'bin', 'skilletor' ) )." \"\$\@\"\n" );
$bin->chmod(0755);

# The tarball as the workflow packs it: <base>/skilletor, LICENSE, README.
my $pkg = $tmp->child( 'pkg', $base );
$pkg->mkpath;
$bin->copy( $pkg->child('skilletor') )->chmod(0755);
$dist->child('LICENSE')->copy( $pkg->child('LICENSE') );
$pkg->child('README')->spew_raw("skilletor smoke stand-in\n");
my $tarball = $tmp->child("$base.tar.gz");
is( system( 'tar', '-C', $tmp->child('pkg'), '-czf', $tarball, $base ), 0, 'the stand-in tarball is packed' );

my $cwd = Cwd::getcwd();
chdir $dist or die "chdir $dist: $!";
my $out = qx{bash scripts/smoke-binary.sh @{[ sq($bin) ]} @{[ sq($tarball) ]} 2>&1};
my $rc  = $? >> 8;
chdir $cwd or die "chdir $cwd: $!";

is( $rc, 0, 'scripts/smoke-binary.sh passes with the Perl CLI from lib/' )
  or diag $out, "\nregenerate the expectation: SKILLETOR_SMOKE_UPDATE=1 prove -l t/70-smoke-binary.t";
like( $out, qr/^smoke tarball: OK \(\Q$base\E\)$/m, 'the tarball is checked' );
if ( $ENV{SKILLETOR_SMOKE_UPDATE} ) {
  like( $out, qr/^smoke: transcript written/m, 'the expectation is written' );
}
else {
  like( $out, qr/^smoke sync, check, status: OK/m, 'the transcript equals t/data/smoke/expected.txt' );
  like( $out, qr/^smoke: OK$/m, 'every smoke stage passes' );
}

# The expectation covers what the smoke claims: the rendered template, the url source's warning.
my $expected = $dist->child( 't', 'data', 'smoke', 'expected.txt' );
ok( $expected->is_file, 't/data/smoke/expected.txt exists' );
my $text = $expected->is_file ? $expected->slurp_raw : '';
like( $text, qr/^Hello WORLD from loc \(claude, user\)\.$/m, 'the expectation holds the rendered template' );
like( $text, qr/^  warning: source web: url source https:\/\/127\.0\.0\.1:1\/skills\.tar\.gz failed: /m,
  "the expectation holds the url source's warning" );

done_testing;
