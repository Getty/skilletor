#!/usr/bin/env perl
# The Codex target where a shared conformance case cannot hold it (k184): what a fixture tree
# cannot carry – a CLAUDE.md that is the AGENTS.md (a symbolic or a hard link), an AGENTS.md
# that is a link or a directory, a rules file that cannot be read or written – synced by the
# reference and by Skilletor::Engine from the same state in the same paths, which must leave the
# same files and links and give the same reports, down to the --json bytes. Then the port's own
# pieces: the tracked-file warning of the rules file (git injected), the run notes of what a
# harness gets no copy of (only Hermes makes any; t/74-engine-hermes.t syncs them), and the
# rules files the SessionStart hook reads. Needs node and the TypeScript tree beside perl/ for the
# first part.
use strict;
use warnings;
use utf8;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( write_json );

use IPC::Open2 qw( open2 );
use Path::Tiny qw( path tempdir );
use Skilletor::Engine;
use Skilletor::FSUtil qw( decode_utf8_lossy encode_text );
use Skilletor::JSON qw( js_parse js_sort_keys js_stringify js_type );
use Skilletor::Report qw( report_json );

binmode Test::More->builder->$_, ':encoding(UTF-8)' for qw( output failure_output todo_output );

my $runner = path( $FindBin::Bin, '..', 'maint', 'ts-run.mjs' );
my $src_ts = path( $FindBin::Bin, '..', '..', 'src', 'engine.ts' );
my $why_no_ts =
    !( $runner->exists && $src_ts->exists )                               ? 'needs the skilletor checkout (../src) and maint/ts-run.mjs'
  : !grep( { -x path( $_, 'node' ) } split /:/, $ENV{PATH} // '' )          ? 'needs node'
  : !path( $FindBin::Bin, '..', '..', 'node_modules', 'nunjucks' )->exists ? 'needs the reference\'s node_modules'
  :                                                                          undef;

sub ts {
  my ( $req ) = @_;
  my $pid = open2( my $out, my $in, 'node', "$runner" );
  binmode $in, ':raw';
  print {$in} encode_text( js_stringify($req) );
  close $in;
  local $/;
  my $text = <$out>;
  waitpid $pid, 0;
  die 'ts-run failed: '.( $text // '' ) unless defined $text && length $text;
  my $answer = js_parse( decode_utf8_lossy($text) );
  die 'ts-run: '.$answer->{error} if defined $answer->{error};
  return $answer->{result};
}

# Keys sorted, arrays sorted by their elements' canonical text.
sub canonical {
  my ( $v ) = @_;
  my $type = js_type($v);
  return [ map { js_parse($_) } js_sort_keys( map { js_stringify( canonical($_) ) } @$v ) ] if $type eq 'array';
  return { map { ( $_ => canonical( $v->{$_} ) ) } keys %$v } if $type eq 'object';
  return $v;
}

sub files {
  my ( $root, %files ) = @_;
  for my $rel ( keys %files ) {
    my $p = path( $root, $rel );
    $p->parent->mkpath;
    $p->spew_raw( encode_text( $files{$rel} ) );
  }
}

# Every entry under $dir: a file as its bytes, a link as `-> target`, a directory as `dir` – the
# sync state under ~/.claude/skilletor left out – and which files share one inode.
sub tree {
  my ( $dir ) = @_;
  my ( %out, %inode );
  return \%out unless -d $dir;
  path($dir)->visit(
    sub {
      my ( $p ) = @_;
      my $rel = $p->relative($dir)->stringify;
      return if $rel =~ m{\Ahome/\.claude/skilletor(?:/|\z)};
      if    ( -l $p ) { $out{$rel} = '-> '.readlink $p }
      elsif ( -d $p ) { $out{$rel} = 'dir' }
      else {
        $out{$rel} = $p->slurp_raw;
        push @{ $inode{ join ':', ( stat $p )[ 0, 1 ] } }, $rel;
      }
    },
    { recurse => 1 },
  );
  $out{"links $_->[0]"} = join ' ', @$_ for grep { @$_ > 1 } map { [ sort @$_ ] } values %inode;
  return \%out;
}

my $tmp  = tempdir;
my $root = $tmp->realpath;
my $SRC  = "$root/src";
files(
  $SRC,
  'rules/style.md'        => "Write short sentences.\n",
  'skills/greet/SKILL.md' => "---\ndescription: greets\n---\nSay hello.\n",
);
my $TRUSTED = qq{[hooks.state."skilletor\@getty:hooks/codex-hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:00"\n};

# A machine at $root/m: Codex in use (its hook trusted), Claude Code too unless $codex_only, a
# user and a project config installing the rule and the skill from a local source; $extra builds
# the rest.
sub machine {
  my ( $codex_only, $extra ) = @_;
  my $m = { home => "$root/m/home", project => "$root/m/project" };
  path("$root/m")->remove_tree( { safe => 0 } );
  path( $m->{$_}, '.claude' )->mkpath for qw( home project );
  path( $m->{home}, '.claude.json' )->spew_raw("{}\n") unless $codex_only;
  files( $m->{home}, '.codex/config.toml' => $TRUSTED );
  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $SRC } }, install => { rules => ['style@s'] } } );
  write_json( "$m->{project}/.claude/skilletor.json", { install => { rules => ['style@s'], skills => ['greet@s'] } } );
  $extra->($m);
  return $m;
}

sub perl_engine {
  my ( $m ) = @_;
  return Skilletor::Engine->new( home => $m->{home}, project_dir => $m->{project}, codex_home => "$m->{home}/.codex",
    is_git_work_tree => sub { 0 }, git_tracked => sub { [] } );
}

# Both engines sync the machine $build makes, from the same state in the same paths.
# $blur, when given, rewrites both --json texts first (what cannot match byte for byte).
sub parity {
  my ( $name, $codex_only, $build, $also, $blur ) = @_;
  subtest $name => sub {
    plan skip_all => $why_no_ts if $why_no_ts;
    my $m = machine( $codex_only, $build );
    my $text = ts( { op => 'sync', home => $m->{home}, projectDir => $m->{project}, json => JSON::MaybeXS::true() } );
    my $ts_tree = tree("$root/m");
    $m = machine( $codex_only, $build );
    my $report = perl_engine($m)->sync;
    my $json   = report_json($report);
    ( $text, $json ) = map { $blur->($_) } $text, $json if $blur;
    is_deeply( tree("$root/m"), $ts_tree, 'the same files and links' );
    is( js_stringify( canonical( js_parse($json) ), 2 ), js_stringify( canonical( js_parse($text) ), 2 ), 'the same report' );
    is( $json, $text, 'the same --json bytes' );
    $also->( $report, $m ) if $also;
  };
}

sub warnings_of { [ map { @{ $_->{warnings} } } @{ $_[0]{scopes} } ] }

parity(
  'CLAUDE.md is the AGENTS.md, Claude Code a target: no pointer, a warning; the rules files written',
  0,
  sub {
    my ( $m ) = @_;
    files( $m->{project}, 'AGENTS.md' => "# Notes\n" );
    symlink 'AGENTS.md', "$m->{project}/CLAUDE.md" or die $!;
    files( $m->{home}, '.codex/AGENTS.md' => "# Mine\n" );
    link "$m->{home}/.codex/AGENTS.md", "$m->{home}/.claude/CLAUDE.md" or die $!;
  },
  sub {
    my ( $r, $m ) = @_;
    is_deeply( warnings_of($r), [
      '.codex/AGENTS.md is the same file as .claude/CLAUDE.md (Claude Code would read it); pointer to the Codex rules not written',
      'AGENTS.md is the same file as CLAUDE.md (Claude Code would read it); pointer to the Codex rules not written',
    ], 'the warnings, as the reference words them' );
    is( path( $m->{project}, 'AGENTS.md' )->slurp_utf8, "# Notes\n", 'the AGENTS.md as it was' );
    ok( -f "$m->{project}/.codex/skilletor-rules.md", 'the rules file is there' );
  },
);

parity(
  'the project .claude/CLAUDE.md is the AGENTS.md: refused too',
  0,
  sub {
    my ( $m ) = @_;
    files( $m->{project}, 'AGENTS.md' => "# Notes\n" );
    symlink '../AGENTS.md', "$m->{project}/.claude/CLAUDE.md" or die $!;
  },
  sub {
    is_deeply( warnings_of( $_[0] ),
      ['AGENTS.md is the same file as .claude/CLAUDE.md (Claude Code would read it); pointer to the Codex rules not written'], 'the warning' );
  },
);

parity(
  'Codex alone: a CLAUDE.md that is the AGENTS.md is no reason to refuse',
  1,
  sub {
    my ( $m ) = @_;
    files( $m->{project}, 'AGENTS.md' => "# Notes\n" );
    symlink 'AGENTS.md', "$m->{project}/CLAUDE.md" or die $!;
  },
  sub {
    my ( $r, $m ) = @_;
    is_deeply( warnings_of($r), [], 'no warning' );
    like( path( $m->{project}, 'AGENTS.md' )->slurp_utf8, qr/\A# Notes\n\n<!-- skilletor:begin -->\n/, 'the pointer appended' );
  },
);

parity(
  'an AGENTS.md that is a link or a directory: never written through, a warning',
  1,
  sub {
    my ( $m ) = @_;
    files( $m->{project}, 'notes.md' => "# Notes\n" );
    symlink 'notes.md', "$m->{project}/AGENTS.md" or die $!;
    path( $m->{home}, '.codex', 'AGENTS.md' )->mkpath;
  },
  sub {
    is_deeply( warnings_of( $_[0] ), [
      '.codex/AGENTS.md is a directory; pointer to the Codex rules not written',
      'AGENTS.md is a symlink (skilletor does not write through it); pointer to the Codex rules not written',
    ], 'the warnings' );
  },
);

parity(
  'a rules file that cannot be read is rewritten',
  1,
  sub {
    my ( $m ) = @_;
    files( $m->{project}, '.codex/skilletor-rules.md' => "old\n" );
    chmod 0, "$m->{project}/.codex/skilletor-rules.md";
  },
  sub {
    my ( $r, $m ) = @_;
    like( path( $m->{project}, '.codex/skilletor-rules.md' )->slurp_utf8, qr/\A<!-- skilletor:rules scope=project -->\n/, 'the new rules file' );
  },
) if $> != 0;

# The failed write's own words differ: Node's "EISDIR: illegal operation on a directory, rename
# '<tmp>' -> '<file>'" against the port's "rename <tmp>: Is a directory" (FSUtil's atomic_write),
# and the temp name is random in both.
parity(
  'a rules file path that is a directory: the rules are not written, a warning; no pointer either',
  1,
  sub { path( $_[0]{project}, '.codex', 'skilletor-rules.md' )->mkpath },
  sub {
    my ( $r ) = @_;
    my ($w) = grep {/rules file/} @{ warnings_of($r) };
    like( $w, qr{\A\.codex/skilletor-rules\.md: cannot write the Codex rules file \(.*\.skilletor-tmp-.*\)\z}, 'the warning names the file' );
  },
  sub { $_[0] =~ s/(cannot write the Codex rules file \()[^"]*\)"/$1…)"/gr },
);

subtest 'a rules file git tracks: one warning with the command that untracks it' => sub {
  my $m = machine( 1, sub { } );
  my @asked;
  my $e = Skilletor::Engine->new( home => $m->{home}, project_dir => $m->{project}, codex_home => "$m->{home}/.codex",
    is_git_work_tree => sub { 0 },
    git_tracked => sub { my ( $dir, $paths ) = @_; push @asked, [ $dir, [ sort @$paths ] ]; [ grep { $_ eq 'skilletor-rules.md' } @$paths ] } );
  my $r = $e->sync( scope => 'project' );
  is_deeply( $r->{scopes}[0]{warnings},
    ['.codex/skilletor-rules.md is tracked by git although skilletor manages it — untrack it: git rm --cached .codex/skilletor-rules.md'],
    'the reference\'s wording: no item key, the file\'s path' );
  ok( ( grep { $_->[0] eq "$m->{project}/.codex" && grep { $_ eq 'skilletor-rules.md' } @{ $_->[1] } } @asked ), 'asked in the Codex root' );
  $r = $e->sync( scope => 'project' );
  is_deeply( $r->{scopes}[0]{warnings}, [], 'a sync that writes nothing asks about nothing' );
};

subtest 'the run notes: one line per harness without a counterpart, one per harness and scope served from another root' => sub {
  my $notes = sub { [ Skilletor::Engine::_run_notes(@_) ] };
  is_deeply( $notes->( [] ), [], 'nothing to say' );
  is_deeply(
    $notes->( [
      { harness => 'hermes', type => 'agent', scope => 'user' },
      { harness => 'hermes', type => 'rule',  scope => 'user' },
      { harness => 'hermes', type => 'agent', scope => 'project' },
      { harness => 'hermes', type => 'skill', scope => 'project', via => 'codex' },
      { harness => 'hermes', type => 'skill', scope => 'project', via => 'codex' },
      { harness => 'codex',  type => 'skill', scope => 'project', via => 'claude' },
    ] ),
    [
      '2 agent(s) and 1 rule(s) not installed for Hermes (Hermes has no agent files and no rules directory)',
      '2 skill(s) not installed for Hermes in the project scope (Hermes reads the Codex copy in .agents/skills)',
      '1 skill(s) not installed for Codex in the project scope (Codex reads the Claude Code copy in its own root)',
    ],
    'counted per type in the order skill, agent, rule; groups in the order first seen; the fallbacks of the reference\'s tables',
  );
  is_deeply( $notes->( [ { harness => 'claude', type => 'rule', scope => 'user' } ] ),
    ['1 rule(s) not installed for Claude Code (Claude Code has no counterpart)'], 'a harness without its own words' );
};

subtest 'the rules files the SessionStart hook reads' => sub {
  my $m = machine( 1, sub { } );
  my $e = perl_engine($m);
  is_deeply( [ $e->codex_rules_files ], [], 'none before a sync' );
  $e->sync;
  my @both = ( "$m->{home}/.codex/skilletor-rules.md", "$m->{project}/.codex/skilletor-rules.md" );
  is_deeply( [ $e->codex_rules_files ], \@both, 'the user\'s, then the project\'s' );
  is_deeply( [ Skilletor::Engine->new( home => $m->{home}, codex_home => "$m->{home}/.codex" )->codex_rules_files ], [ $both[0] ],
    'no project dir: the user\'s alone' );
  write_json( "$m->{project}/.claude/skilletor.local.json", { targets => ['claude'] } );
  is_deeply( [ perl_engine($m)->codex_rules_files ], [ $both[0] ], 'a scope that does not target Codex: its file left out, stale or not' );
  path( $m->{home}, '.claude', 'skilletor.json' )->spew_raw("{ broken\n");
  is_deeply( [ perl_engine($m)->codex_rules_files ], \@both, 'a config that does not load: every file there is, the last good state' );
};

done_testing;
