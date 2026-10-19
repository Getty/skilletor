package Skilletor::FSUtil;
# ABSTRACT: File and path helpers that behave as the reference's Node calls do

use strict;
use warnings;

use Carp qw( croak );
use Cwd ();
use Digest::SHA qw( sha256_hex );
use Encode ();
use Exporter qw( import );
use Fcntl ();
use Path::Tiny qw( path );

our $VERSION = '0.001';

our @EXPORT_OK = qw(
  read_text decode_utf8_lossy encode_text
  inner_segments hash_bytes is_executable
  atomic_write write_text
  path_join path_normalize path_resolve is_absolute
  real_or_resolved same_path to_posix
);

use constant WIN32 => $^O eq 'MSWin32';

#### Text ##############################################################

# readFileSync(path, "utf8"): bytes decoded as UTF-8, every ill-formed sequence one U+FFFD as
# the WHATWG decoder (and so V8) replaces it. No BOM is stripped.
sub decode_utf8_lossy {
  my ( $bytes ) = @_;
  my $copy = $bytes;
  my $text = eval { Encode::decode( 'UTF-8', $copy, Encode::FB_CROAK() ) };
  return $text if defined $text;
  my $out = '';
  my ( $needed, $seen, $cp, $lower, $upper ) = ( 0, 0, 0, 0x80, 0xBF );
  my @bytes = unpack 'C*', $bytes;
  my $i = 0;
  while ( $i < @bytes ) {
    my $b = $bytes[$i];
    if ( $needed == 0 ) {
      $i++;
      if ( $b <= 0x7F ) { $out .= chr $b; next }
      if ( $b >= 0xC2 && $b <= 0xDF ) { $needed = 1; $cp = $b & 0x1F; next }
      if ( $b >= 0xE0 && $b <= 0xEF ) {
        $lower = 0xA0 if $b == 0xE0;
        $upper = 0x9F if $b == 0xED;
        $needed = 2;
        $cp = $b & 0xF;
        next;
      }
      if ( $b >= 0xF0 && $b <= 0xF4 ) {
        $lower = 0x90 if $b == 0xF0;
        $upper = 0x8F if $b == 0xF4;
        $needed = 3;
        $cp = $b & 0x7;
        next;
      }
      $out .= "\x{FFFD}";
      next;
    }
    if ( $b < $lower || $b > $upper ) {
      ( $needed, $seen, $cp, $lower, $upper ) = ( 0, 0, 0, 0x80, 0xBF );
      $out .= "\x{FFFD}";
      next;    # the byte is read again as the start of a sequence
    }
    $i++;
    ( $lower, $upper ) = ( 0x80, 0xBF );
    $cp = ( $cp << 6 ) | ( $b & 0x3F );
    next unless ++$seen == $needed;
    $out .= chr $cp;
    ( $needed, $seen, $cp ) = ( 0, 0, 0 );
  }
  $out .= "\x{FFFD}" if $needed;
  return $out;
}

sub read_text {
  my ( $file ) = @_;
  return decode_utf8_lossy( path($file)->slurp_raw );
}

# A JavaScript string as UTF-8, as Buffer.from(s) and writeFileSync encode it: a lone
# surrogate becomes U+FFFD.
sub encode_text {
  my ( $text ) = @_;
  no warnings qw( surrogate utf8 );
  ( my $clean = "$text" ) =~ s/[\x{D800}-\x{DFFF}]/\x{FFFD}/g;
  return Encode::encode( 'UTF-8', $clean );
}

#### Paths #############################################################

sub is_absolute {
  my ( $p ) = @_;
  return 1 if $p =~ m{\A/};
  return 1 if WIN32 && $p =~ m{\A(?:[\\]|[A-Za-z]:[\\/])};
  return 0;
}

# path.normalize (posix): "." segments and doubled slashes go, ".." pops (never above the
# root; kept in front of a relative path), a trailing slash stays, "" is ".".
sub path_normalize {
  my ( $p ) = @_;
  return '.' if $p eq '';
  my $abs      = $p =~ m{\A/} ? 1 : 0;
  my $trailing = $p =~ m{/\z} ? 1 : 0;
  my @out;
  for my $seg ( split m{/+}, $p ) {
    next if $seg eq '' || $seg eq '.';
    if ( $seg eq '..' ) {
      if ( @out && $out[-1] ne '..' ) { pop @out }
      elsif ( !$abs ) { push @out, '..' }
      next;
    }
    push @out, $seg;
  }
  my $joined = join '/', @out;
  return $abs ? '/' : ( $trailing ? './' : '.' ) if $joined eq '';
  return ( $abs ? '/' : '' ).$joined.( $trailing ? '/' : '' );
}

sub path_join {
  my ( @parts ) = @_;
  my $joined = join '/', grep { length } @parts;
  return path_normalize($joined);
}

# path.resolve (posix): right to left until an absolute path, then the cwd; normalized,
# without a trailing slash.
sub path_resolve {
  my ( @parts ) = @_;
  my $resolved = '';
  for my $part ( reverse @parts ) {
    next unless defined $part && length $part;
    $resolved = $part.( length $resolved ? '/'.$resolved : '' );
    last if is_absolute($part);
  }
  $resolved = Cwd::getcwd().( length $resolved ? '/'.$resolved : '' ) unless is_absolute($resolved);
  my $n = path_normalize($resolved);
  $n =~ s{(?<=.)/\z}{};
  return $n;
}

sub to_posix {
  my ( $p ) = @_;
  return $p unless WIN32;
  ( my $q = $p ) =~ s{\\}{/}g;
  return $q;
}

# The segments of a path relative to some root ("\" separates like "/", empty and "."
# segments dropped), or why it names nothing beneath that root.
sub inner_segments {
  my ( $entry ) = @_;
  return 'absolute' if is_absolute($entry) || $entry =~ m{\A[/\\]};
  my @segments = grep { $_ ne '' && $_ ne '.' } split m{[\\/]}, $entry, -1;
  return 'dotdot' if grep { $_ eq '..' } @segments;
  return @segments ? \@segments : 'root';
}

sub real_or_resolved {
  my ( $p ) = @_;
  my $real = -e $p ? eval { Cwd::abs_path($p) } : undef;
  return defined $real ? $real : path_resolve($p);
}

sub same_path {
  my ( $a, $b ) = @_;
  return real_or_resolved($a) eq real_or_resolved($b) ? 1 : 0;
}

#### Content ###########################################################

sub hash_bytes {
  my ( $bytes ) = @_;
  return 'sha256:'.sha256_hex($bytes);
}

sub is_executable {
  my ( $mode ) = @_;
  return ( ( $mode // 0 ) & 0100 ) ? 1 : 0;
}

my @BASE36 = ( 0 .. 9, 'a' .. 'z' );

sub atomic_write {
  my ( $file, $bytes, $executable ) = @_;
  croak __PACKAGE__.'->atomic_write needs bytes, not characters' if $bytes =~ /[^\x{0}-\x{FF}]/;
  my $dir = path($file)->parent;
  $dir->mkpath;
  my $tmp = $dir->child( '.skilletor-tmp-'.$$.'-'.join '', map { $BASE36[ int rand 36 ] } 1 .. 11 );
  my $ok = eval {
    sysopen( my $fh, "$tmp", Fcntl::O_WRONLY() | Fcntl::O_CREAT() | Fcntl::O_TRUNC(), $executable ? 0777 : 0666 )
      or croak 'open '.$tmp.': '.$!;
    binmode $fh;
    print {$fh} $bytes or croak 'write '.$tmp.': '.$!;
    close $fh or croak 'close '.$tmp.': '.$!;
    rename "$tmp", "$file" or croak 'rename '.$tmp.': '.$!;
    1;
  };
  unless ($ok) {
    my $err = $@;
    unlink "$tmp";
    die $err;
  }
  return;
}

sub write_text {
  my ( $file, $text, $executable ) = @_;
  return atomic_write( $file, encode_text($text), $executable );
}

1;

=synopsis

  use Skilletor::FSUtil qw( read_text write_text inner_segments path_join );

  my $text = read_text('/home/me/.claude/skilletor.json');    # as readFileSync(…, "utf8")
  write_text( $file, $json."\n" );                            # temp file + rename

  my $segs = inner_segments('skills/../x');                   # 'dotdot'

=description

The port of the reference's C<fsutil.ts>, plus the pieces of Node's
C<node:path> and C<node:fs> whose behaviour reaches a file name, a message or
a hash: C<path.join>, C<path.normalize> and C<path.resolve> (POSIX), and
C<readFileSync(…, "utf8")>'s lossy decoding. Plain functions, exported on
request.

=func read_text

The file's bytes decoded as UTF-8, each ill-formed sequence replaced by one
U+FFFD as the WHATWG decoder does (Node's behaviour); a BOM stays.

=func decode_utf8_lossy

The decoding L</read_text> uses, for bytes already in hand.

=func encode_text

A character string as UTF-8 bytes, a lone surrogate as U+FFFD – what Node's
C<Buffer.from(string)> and C<createHash().update(string)> make of it.

=func write_text

  write_text( $file, $text, $executable );

L</atomic_write> of L</encode_text>.

=func atomic_write

  atomic_write( $file, $bytes, $executable );

Creates the parent directories, writes a C<.skilletor-tmp-*> file beside the
target with mode 0666 (0777 when C<$executable>) less the umask, and renames it
over the target. Croaks on characters above 0xFF: encode first.

=func inner_segments

  inner_segments('a/./b');    # ['a', 'b']
  inner_segments('/a');       # 'absolute'
  inner_segments('a/../b');   # 'dotdot'
  inner_segments('.');        # 'root'

The segments of a path relative to some root, or why it names nothing beneath
it. C<\> separates like C</>.

=func path_join

C<path.join> of Node's POSIX path module.

=func path_normalize

C<path.normalize> of Node's POSIX path module.

=func path_resolve

C<path.join>, C<path.normalize>, C<path.resolve> of Node's POSIX path module.

=func is_absolute

C<path.isAbsolute>; on Windows a drive or backslash path too.

=func real_or_resolved

The real path of an existing path, else its L</path_resolve> form.

=func same_path

True when two paths name the same location once symlinks are resolved.

=func to_posix

The path with C</> between its parts (a no-op off Windows).

=func hash_bytes

C<sha256:> and the hex digest – the hash of a lock entry's file.

=func is_executable

True when a mode has the owner's executable bit.

=cut
