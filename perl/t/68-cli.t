#!/usr/bin/env perl
# Skilletor::CLI's pieces no conformance case reaches (../conformance runs the commands
# themselves, against the reference's bytes): the project root of a cwd, a sync's text with
# run-level warnings and notes (the Perl engine targets Claude Code alone, so it makes none), and
# the lines of a sync that failed after a command's config edit (no ported command edits one
# yet). The expected text is the reference's (cli.ts syncText, syncFailed; report.ts reportText).
use strict;
use warnings;
use utf8;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( git_ok );

use Cwd ();
use Encode ();
use Path::Tiny qw( path tempdir );
use Skilletor::CLI qw( project_root_of );
use Skilletor::JSON qw( js_ordered );
use Skilletor::Report qw( empty_scope_report );

subtest 'project_root_of: the git top level of a directory, else the directory itself' => sub {
  my $tmp  = tempdir;
  my $root = Cwd::realpath("$tmp");
  local $ENV{GIT_CEILING_DIRECTORIES} = $root;    # whatever holds the temp dir is no work tree here
  my ( $repo, $other ) = ( "$root/repo", "$root/other" );
  path($_)->mkpath for "$repo/sub/deep", $other, "$root/plain";
  git_ok( $_, 'init', '-q', '-b', 'main' ) for $repo, $other;
  is( project_root_of("$repo/sub/deep"), $repo, 'a subdirectory of a work tree: its top level' );
  is( project_root_of($repo),            $repo, 'the top level: itself' );
  is( project_root_of("$root/plain"), "$root/plain", 'outside git: the directory' );
  is( project_root_of("$root/gone"),  "$root/gone",  'a directory git cannot enter: the directory' );
  local $ENV{GIT_DIR} = "$other/.git";
  is( project_root_of("$repo/sub"), $repo, "an exported GIT_DIR does not answer for it: git runs in git's environment" );
};

my $added = js_ordered( %{ empty_scope_report('user') } );
$added->{added} = [ js_ordered( key => 'skills/a', type => 'skill', name => 'a', source => 's' ) ];

subtest "a sync's text: its report, or up to date; run-level lines come in addition" => sub {
  my $text = \&Skilletor::CLI::_sync_text;
  is( $text->( js_ordered( scopes => [ empty_scope_report('user') ] ) ), 'skilletor: up to date', 'nothing to say' );
  is( $text->( js_ordered( scopes => [$added] ) ), "skilletor: user scope\n  + skills/a (active now)", 'a change' );
  is(
    $text->( js_ordered( scopes => [ empty_scope_report('user') ], warnings => ['the hook is not trusted'] ) ),
    "skilletor: up to date\nskilletor: warning: the hook is not trusted",
    'only a run-level warning: up to date, then the warning'
  );
  is(
    $text->( js_ordered( scopes => [], notes => ['hermes gets no agents'] ) ),
    "skilletor: up to date\nskilletor: note: hermes gets no agents",
    'only a note: the same'
  );
  is(
    $text->( js_ordered( scopes => [$added], warnings => ['w'], notes => ['n'] ) ),
    "skilletor: user scope\n  + skills/a (active now)\nskilletor: warning: w\nskilletor: note: n",
    'a change and run-level lines: no up to date'
  );
  is( $text->( js_ordered( scopes => [ empty_scope_report('user') ], warnings => [], notes => [] ) ),
    'skilletor: up to date', 'empty run-level lists say nothing' );
};

sub stderr_of {
  my ( $code ) = @_;
  my $buf = '';
  my $ret;
  {
    local *STDERR;
    open( STDERR, '>', \$buf ) or die "stderr to a buffer: $!";
    $ret = $code->();
  }
  return ( $ret, Encode::decode( 'UTF-8', $buf ) );
}

subtest 'a sync that stopped at a config error: exit 2, its report on stderr' => sub {
  my $r = js_ordered( scopes => [], error => "bad \x{1b}[31mconfig" );
  my $failed = \&Skilletor::CLI::_sync_failed;
  is_deeply( [ stderr_of( sub { $failed->($r) } ) ], [ 2, "skilletor: config error, nothing changed — bad \\u001b[31mconfig\n" ],
    'the text, escaped' );
  is_deeply(
    [ stderr_of( sub { $failed->( $r, json => 1 ) } ) ],
    [ 2, qq({\n  "scopes": [],\n  "error": "bad \\u001b[31mconfig"\n}\n) ],
    '--json: the report as JSON'
  );
  is_deeply(
    [ stderr_of( sub { $failed->( $r, json => 1, saved => '/p/.claude/skilletor.json' ) } ) ],
    [
      2,
      "skilletor: config error, nothing synced — bad \\u001b[31mconfig\n"
        ."skilletor: the config edit itself was saved in /p/.claude/skilletor.json (not rolled back); fix the error, then run skilletor sync\n"
    ],
    "after a command's config edit: two lines naming the file that stays, never JSON (k103)"
  );
};

done_testing;
