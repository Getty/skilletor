package Skilletor::Error::TOML;
# ABSTRACT: A value TOML cannot hold (the reference's TomlWriteError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.008000';

1;

=description

Thrown by L<Skilletor::TOML/stringify_toml> where the reference throws its
C<TomlWriteError>: a non-integer number, a float that is not finite, a nested
table, an array of anything but strings, a value without a TOML form. The
message names the key (C<< <table>.<key>: ... >>). See L<Skilletor::Error> for
the interface.

=cut
