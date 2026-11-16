#!/usr/bin/env perl
# One version line (k242): the dist's $VERSION (0.008) is the plugin's version (package.json,
# 0.8.0) in the other spelling, version->normal without its "v". Every module carries it, and
# the CLI reports it.
#
# The tie to package.json holds in a checkout (the tarball has no package.json) in one of two
# states:
# - released, or about to be: package.json is normal($VERSION);
# - after a release: @Git::VersionManager's BumpVersionAfterRelease has moved lib/ on to the next
#   version (0.009) while package.json still names the release (0.8.0): normal($VERSION - 0.001).
#   package.json follows with the next release's preparation.
# The release gate, maint/version-tie.pl (dist.ini: run_before_release), takes the first state
# only, for the version dzil releases.
use strict;
use warnings;
use Test::More;
use FindBin;
use Path::Tiny qw( path );
use version ();
use Skilletor ();
use Skilletor::Process qw( run_command );

my $DIST = path( $FindBin::Bin, '..' );
my $VERSION = $Skilletor::VERSION;

sub normal { version->parse( $_[0] )->normal =~ s/\Av//r }

like( $VERSION, qr/\A\d+\.\d{3}\z/, "the dist version ($VERSION) has three decimals: x.yyy is the plugin's x.y.0" );

subtest 'every module of lib/ carries the dist version' => sub {
  my @pm;
  $DIST->child('lib')->visit( sub { push @pm, $_[0] if $_[0] =~ /\.pm\z/ }, { recurse => 1 } );
  cmp_ok( scalar @pm, '>', 50, 'the modules of lib/' );
  for my $pm ( sort { "$a" cmp "$b" } @pm ) {
    my @v = $pm->slurp_raw =~ /^our \$VERSION = '([^']*)';$/mg;
    is_deeply( \@v, [$VERSION], $pm->relative($DIST).": our \$VERSION = '$VERSION'" );
  }
};

subtest 'the CLI reports the dist version' => sub {
  my @cli = ( $^X, '-I'.$DIST->child('lib'), $DIST->child( 'script', 'skilletor' )."" );
  my $v = run_command( cmd => [ @cli, '--version' ], env => {%ENV} );
  is( $v->{stdout} =~ s/\r?\n\z//r, $VERSION, '--version' );
  my $h = run_command( cmd => [ @cli, '--help' ], env => {%ENV} );
  like( $h->{stdout}, qr/\Askilletor \Q$VERSION\E\r?\n/, '--help starts with it' );
};

subtest 'package.json names the same version, or the release before it' => sub {
  my $pkg = $DIST->child('package.json');
  plan skip_all => 'no package.json (the CPAN tarball): the plugin is a checkout\'s' unless $pkg->is_file;
  my ($plugin) = $pkg->slurp_raw =~ /^  "version": "([^"]+)",$/m;
  ok( defined $plugin, 'package.json has a version' ) or return;
  my $released = normal($VERSION);
  my $before   = normal( sprintf '%.3f', $VERSION - 0.001 );
  ok( $plugin eq $released || $plugin eq $before,
    "package.json $plugin is $released (dist $VERSION) or, after its release, $before" );
};

done_testing;
