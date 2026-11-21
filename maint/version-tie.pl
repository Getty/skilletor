#!/usr/bin/env perl
# The release gate of the one version line (k242), dist.ini's run_before_release:
#   perl maint/version-tie.pl VERSION      from the repository root, VERSION the one dzil releases
# VERSION keeps both sub-levels (k269): six decimals, x.yyyzzz. Exits 0 when package.json names it
# in the plugin's spelling (x.y.z, 0.008000 -> 0.8.0: version->normal without its "v"), else 1
# naming both. t/02-version.t also accepts the state after a release (package.json one release
# behind lib/); a release takes the strict tie only, so the tag, the CPAN tarball and the
# plugin's package.json name one version.
use strict;
use warnings;
use version ();

my ($release) = @ARGV;
defined $release && $release =~ /\A\d+\.\d{6}\z/
  or die "usage: perl maint/version-tie.pl VERSION (x.yyyzzz, the dist version)\n";
open my $fh, '<:raw', 'package.json' or die "version-tie: cannot read package.json (run from the repository root): $!\n";
my ($plugin) = do { local $/; <$fh> } =~ /^  "version": "([^"]+)",$/m
  or die "version-tie: no version in package.json\n";
my $want = version->parse($release)->normal =~ s/\Av//r;
if ( $plugin ne $want ) {
  print STDERR "version-tie: dzil releases $release, so package.json must say $want, not $plugin;"
    ." bump package.json, package-lock.json, .codex-plugin/plugin.json and hermes/skilletor/plugin.yaml"
    ." to $want and rebuild dist/ (npm run build) first\n";
  exit 1;
}
print "version-tie: dist $release = plugin $plugin\n";
