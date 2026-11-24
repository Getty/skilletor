#!/usr/bin/env perl
# A cwd another process removed is gone also where getcwd still names it (k273): Cygwin keeps the
# path of a removed cwd and gives it back. The CLI then asks for --project-dir and a hook says
# what Node says when process.cwd fails, as where getcwd fails. Here getcwd names a directory
# that does not exist, as there, so the test holds on any system; t/68-cli.t and t/69-hooks.t
# remove the cwd itself.
use strict;
use warnings;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( error_of );

use Cwd ();
use Path::Tiny qw( tempdir );
use Skilletor::CLI;
use Skilletor::Hooks;

my $base = tempdir;
my $tmp = $base->realpath;
local $ENV{HOME} = "$tmp";
local $ENV{GIT_CEILING_DIRECTORIES} = "$tmp";
my $named;
{
  no warnings 'redefine';
  *Cwd::getcwd = sub { $named };
}

$named = "$tmp/gone";
is( error_of( sub { Skilletor::CLI::_engine( {} ) } ), "the current directory no longer exists; pass --project-dir <dir>\n",
  'the CLI: the actionable error' );
is( error_of( sub { Skilletor::CLI::_engine( { project_dir => 'project' } ) } ),
  "the current directory no longer exists; pass --project-dir <dir>\n", 'a relative project dir: the same' );
is( error_of( sub { Skilletor::Hooks::_cwd() } ), "ENOENT: process.cwd failed with error no such file or directory, uv_cwd\n",
  'a hook: Node\'s words' );

$named = "$tmp";
is( Skilletor::CLI::_engine( {} )->project_dir, "$tmp", 'a cwd that is there: the project' );
is( Skilletor::Hooks::_cwd(), "$tmp", 'and the hook\'s cwd' );

done_testing;
