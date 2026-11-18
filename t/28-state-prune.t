#!/usr/bin/env perl
use strict;
use warnings;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( write_json );

use Path::Tiny qw( path tempdir );
use Skilletor::JSON qw( js_ordered js_stringify );
use Skilletor::State;

# k254: sources-read.json is keyed by lock path, and every scope a sync ever saw left its key –
# gone worktrees, fixtures under /tmp, the relative keys a relative --project-dir made. A put drops
# the keys of scopes that are gone: a key that is no absolute path, or whose lock's directory (the
# scope's .claude) no longer exists. The scope written stays, even before its lock does; a scope
# whose .claude exists keeps its record without a lock (a sync that installed nothing leaves none,
# and that record is what `check` compares its sources with, k80). As the reference's state.ts.

sub read_of {
  my ( $version ) = @_;
  return js_ordered( s => js_ordered( kind => 'git', address => 'https://example.invalid/s.git', version => $version ) );
}

sub file_of { js_stringify( $_[0], 2 )."\n" }

subtest 'a put drops gone scopes and relative keys, keeps the live ones byte for byte' => sub {
  my $tmp     = tempdir;
  my $root    = path( $tmp, 'state' );
  my $live    = "$tmp/live/.claude/skilletor.lock.json";
  my $bare    = "$tmp/bare/.claude/skilletor.lock.json";    # its .claude, no lock
  my $gone    = "$tmp/gone/.claude/skilletor.lock.json";
  my $written = "$tmp/new/.claude/skilletor.lock.json";     # nothing on disk yet
  path($live)->parent->mkpath;
  path($live)->spew_raw("{}\n");
  path($bare)->parent->mkpath;
  # A live record as another writer left it: fields in another order, one no version knows.
  my $live_record = js_ordered( s => js_ordered( version => 'git:1', address => 'https://example.invalid/s.git', kind => 'git', extra => [1] ) );
  write_json( $root->child('sources-read.json'), js_ordered(
    $gone => read_of('git:0'), '.claude/skilletor.lock.json' => read_of('git:0'), $live => $live_record, $bare => read_of('git:2'),
  ) );

  Skilletor::State->new( root => "$root" )->put_sources_read( $written, read_of('git:3') );
  is( $root->child('sources-read.json')->slurp_utf8,
    file_of( js_ordered( $live => $live_record, $bare => read_of('git:2'), $written => read_of('git:3') ) ),
    'the live scopes and the one written stay, in their order; the rest is gone' );
};

subtest 'a put that changes no record still drops gone scopes; with none to drop it writes nothing' => sub {
  my $tmp  = tempdir;
  my $root = path( $tmp, 'state' );
  my $live = "$tmp/live/.claude/skilletor.lock.json";
  my $gone = "$tmp/gone/.claude/skilletor.lock.json";
  path($live)->parent->mkpath;
  path($live)->spew_raw("{}\n");
  my $file = write_json( $root->child('sources-read.json'), js_stringify( js_ordered( $gone => read_of('git:0'), $live => read_of('git:1') ) ) );
  my $state = Skilletor::State->new( root => "$root" );
  $state->put_sources_read( $live, read_of('git:1') );
  is( $file->slurp_utf8, file_of( js_ordered( $live => read_of('git:1') ) ), 'the gone scope dropped' );
  my $compact = js_stringify( js_ordered( $live => read_of('git:1') ) );    # as no put writes it: a rewrite would show
  $file->spew_raw($compact);
  $state->put_sources_read( $live, read_of('git:1') );
  is( $file->slurp_utf8, $compact, 'nothing to drop, nothing changed: not written' );
};

done_testing;
