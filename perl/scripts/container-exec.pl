#!/usr/bin/env perl
# Run a command in a running container as if it ran here, for a conformance `cli` step
# (SKILLETOR_CONFORMANCE_CLI; scripts/container-proof.sh sets it up):
#   container-exec.pl [--docker-host URL] [--docker-config DIR] CONTAINER COMMAND [ARG...]
# Every variable of this process' environment goes along but PATH (the container keeps its
# own), and the working directory and stdin with it; the exit code, stdout and stderr come back
# as they are (exec, nothing in between). The paths must exist in the container under the same
# names: bind-mount them there. --docker-host and --docker-config are for the docker CLI only:
# the runner's environment is built from nothing, and its HOME is the case's, where the CLI
# must not write.
use strict;
use warnings;
use Cwd ();

my %opt;
while ( @ARGV && $ARGV[0] =~ /\A--docker-(host|config)\z/ ) {
  shift @ARGV;
  defined( $opt{$1} = shift @ARGV ) or die "container-exec.pl: --docker-$1 needs a value\n";
}
my ( $container, @cmd ) = @ARGV;
die "usage: container-exec.pl [--docker-host URL] [--docker-config DIR] CONTAINER COMMAND [ARG...]\n"
  unless defined $container && @cmd;

my $cwd = Cwd::getcwd() // die "container-exec.pl: no working directory: $!\n";
my @env = map { ( '-e', $_ ) } grep { $_ ne 'PATH' } sort keys %ENV;    # -e NAME: its value from here
$ENV{DOCKER_HOST}   = $opt{host}   if defined $opt{host};
$ENV{DOCKER_CONFIG} = $opt{config} if defined $opt{config};
exec { 'docker' } 'docker', 'exec', '-i', '-w', $cwd, @env, $container, @cmd
  or die "container-exec.pl: cannot run docker: $!\n";
