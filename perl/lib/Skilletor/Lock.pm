package Skilletor::Lock;
# ABSTRACT: A scope's lock file (skilletor.lock.json) – reading it and its keys

use strict;
use warnings;

use Errno ();
use Exporter qw( import );
use Scalar::Util qw( blessed );
use Skilletor::Error::Lock;
use Skilletor::FSUtil qw( decode_utf8_lossy encode_text node_fs_error );
use Skilletor::JSON qw( js_parse js_ordered js_type );

our $VERSION = '0.001';

our @EXPORT_OK = qw( read_lock parse_lock_key key_to_type_name );

# The lock key prefix of each harness; Claude's keys carry none.
my %HARNESS_OF_PREFIX = ( 'codex:' => 'codex', 'hermes:' => 'hermes' );
my %TYPE_OF_DIR = ( skills => 'skill', agents => 'agent', rules => 'rule' );

# The lock at $path as an ordered hash of entries; a missing file is an empty lock.
sub read_lock {
  my ( $path ) = @_;
  my $bytes = encode_text($path);
  my $text;
  if ( -d $bytes ) {
    Skilletor::Error::Lock->throw( $path.': cannot read lock (EISDIR: illegal operation on a directory, read)' );
  }
  if ( open my $fh, '<:raw', $bytes ) {
    local $/;
    $text = decode_utf8_lossy( <$fh> // '' );
    close $fh;
  }
  else {
    return js_ordered() if $!{ENOENT};
    Skilletor::Error::Lock->throw( $path.': cannot read lock ('.node_fs_error( 0 + $!, 'open', $path ).')' );
  }
  my $value;
  my $ok = eval {
    $value = js_parse($text);
    die { message => 'expected an object' } unless js_type($value) eq 'object';
    1;
  };
  unless ($ok) {
    my $err = $@;
    my $msg = ref $err eq 'HASH' ? $err->{message} : blessed $err && $err->can('message') ? $err->message : "$err";
    Skilletor::Error::Lock->throw( $path.': invalid lock JSON ('.$msg.')' );
  }
  return $value;
}

# A lock key – `skills/foo`, `codex:agents/x` – as { harness, target, type, name }. A prefix no
# harness has leaves the harness undefined; a directory no type has reads as a rule.
sub parse_lock_key {
  my ( $key ) = @_;
  my $colon   = index $key, ':';
  my $slash   = index $key, '/';
  my $harness = 'claude';
  my $target  = $key;
  if ( $colon != -1 && ( $slash == -1 || $colon < $slash ) ) {
    $harness = $HARNESS_OF_PREFIX{ substr $key, 0, $colon + 1 };
    $target  = substr $key, $colon + 1;
  }
  my ( $dir, @rest ) = split m{/}, $target, -1;
  $dir //= '';
  return { harness => $harness, target => $target, type => $TYPE_OF_DIR{$dir} // 'rule', name => join( '/', @rest ) };
}

sub key_to_type_name {
  my ( $key ) = @_;
  my $k = parse_lock_key($key);
  return { type => $k->{type}, name => $k->{name} };
}

1;

=synopsis

  use Skilletor::Lock qw( read_lock key_to_type_name );

  my $lock = read_lock("$project/.claude/skilletor.lock.json");
  for my $key ( keys %$lock ) {
    my $it = key_to_type_name($key);    # { type => 'skill', name => 'perl-moo' }
    print "$it->{type} $it->{name} from $lock->{$key}{source}\n";
  }

=description

The reading half of the reference's C<lock.ts> (spec §6.2): one lock per
scope, C<< <scope>/.claude/skilletor.lock.json >>, the ownership boundary of
what skilletor installed. A resolve reads it to keep offering what an
unreachable source or an unexpandable bundle installed before (spec §3,
§15.4). Writing it comes with the sync.

=func read_lock

  read_lock($path);

The entries, in file order; C<{}> when there is no file. Throws
L<Skilletor::Error::Lock> on a file it cannot read or that holds no JSON
object, worded as the reference.

=func parse_lock_key

  parse_lock_key('codex:skills/foo');   # { harness => 'codex', target => 'skills/foo', type => 'skill', name => 'foo' }

=func key_to_type_name

  key_to_type_name('agents/reviewer');   # { type => 'agent', name => 'reviewer' }

=cut
