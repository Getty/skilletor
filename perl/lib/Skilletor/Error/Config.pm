package Skilletor::Error::Config;
# ABSTRACT: A config file is invalid (the reference's ConfigError)

use Moo;
use namespace::clean;

extends 'Skilletor::Error';

our $VERSION = '0.002';

1;

=description

Thrown where the reference implementation throws its C<ConfigError>. See
L<Skilletor::Error> for the interface.

=cut
