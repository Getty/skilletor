#!/usr/bin/env perl
# A Codex rules file that is a directory is "cannot read … (EISDIR: illegal operation on a
# directory, read)" on every system (k273). Linux fails the read of a directory; NetBSD,
# DragonFly and GNU/Hurd read(2) it and give its entries, which then went into the session's
# context as rules. Every read of a directory here gives entries, as there, so the test holds on
# any system; t/73-hooks-codex.t has the line the hook makes of it.
use strict;
use warnings;
use Test::More;

BEGIN {
  *CORE::GLOBAL::readline = sub {
    my $fh = @_ ? $_[0] : \*ARGV;
    return "\x{1}\x{0}\x{0}\x{0}.\x{0}..\x{0}" if -d $fh;
    return wantarray ? CORE::readline($fh) : scalar CORE::readline($fh);
  };
}

use Path::Tiny qw( tempdir );
use Skilletor::Hooks;

my $dir = tempdir;
my $rules = "$dir/skilletor-rules.md";
mkdir $rules or die "mkdir $rules: $!";
my $got = Skilletor::Hooks::_read_rules($rules);
is( ref $got ? $$got : "the text '$got'", 'EISDIR: illegal operation on a directory, read', 'a directory is no rules file' );

Path::Tiny::path("$dir/file.md")->spew_raw("rule\n");
is( Skilletor::Hooks::_read_rules("$dir/file.md"), "rule\n", 'a file still reads' );

done_testing;
