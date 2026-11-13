package Skilletor::CLI;
# ABSTRACT: The skilletor command line – arguments, usage, exit codes (spec §7)

use strict;
use warnings;
use utf8;

use Cwd ();
use Encode ();
use Exporter qw( import );
use Scalar::Util qw( blessed );
use Skilletor::FSUtil qw( decode_utf8_lossy encode_text path_resolve );
use Skilletor::GitEnv qw( git_env );
use Skilletor::Process qw( run_command );
use Skilletor::Report qw( display_safe report_json report_text status_text );

our $VERSION = '0.002';

our @EXPORT_OK = qw( run parse_flags unknown_option project_root_of CLI_VERSION USAGE );

# The version the CLI reports: the plugin's (package.json), which t/60-conformance.t pins.
# Provisional until k167 decides between it and the dist's own $VERSION.
use constant CLI_VERSION => '0.7.0';

use constant USAGE => 'skilletor '.CLI_VERSION."\n".<<'END_USAGE';
Remote skills, agents and rules for Claude Code, Codex and Hermes Agent.

Usage:
  skilletor <command> [options]

Commands:
  sync                  Reconcile installed items with the config
  check                 Report whether a sync is due (writes nothing)
  status                Show declared vs. installed items
  add [name] <spec>     Add and trust a source, then sync
  source list           List declared sources
  source remove <name>  Remove a source, then sync
  available [source]    List items offered by trusted sources
  install <item>...     Install items ([type:]name@source), then sync;
                        type:*@source installs every item of that type,
                        type:perl-*@source every one whose name matches;
                        bundle:name@source installs a bundle (a bare
                        name@source does too when no item has that name);
                        sources a bundle needs are offered for adding
                        (on a terminal; otherwise the add commands are shown)
  uninstall <item>...   Remove entries ([type:]name@source, type:*@source,
                        type:perl-*@source or bundle:name@source), then sync
  trust <source>        Trust a project-declared source

Options:
  --scope <s>           user | project | all (default: all; sync, check, status)
  --project             Edit the project config instead of the user config
                        (add, install, uninstall, source remove)
  --json                Machine-readable output
                        (sync, check, status, source list, available)
  --force               sync: adopt foreign files on conflict;
                        source remove: remove even if items are installed
  --project-dir <dir>   Project root (default: git top level of cwd, else cwd)
  -h, --help            Show this help (anywhere; nothing else runs)
  -v, --version         Show the version (first argument only)

An option the command does not accept is an error (exit 2).
END_USAGE

# The options each command accepts (spec §7); --project-dir goes with every one. `hook` is
# absent: it is internal and must never fail (spec §8).
my %ACCEPTED = (
  sync            => [qw( --scope --json --force )],
  check           => [qw( --scope --json )],
  status          => [qw( --scope --json )],
  add             => [qw( --project )],
  'source list'   => [qw( --json )],
  'source remove' => [qw( --project --force )],
  available       => [qw( --json )],
  install         => [qw( --project )],
  uninstall       => [qw( --project )],
  trust           => [],
);

# The reference's `source ${rest[0]}`: an absent sub-command is the string "undefined".
sub _source_key { 'source '.( $_[0]{rest}[0] // 'undefined' ) }

sub unknown_option {
  my ( $cmd, $flags ) = @_;
  return undef if $cmd ne 'source' && !exists $ACCEPTED{$cmd};    # unknown command: its own error
  my $key = $cmd eq 'source' ? _source_key($flags) : $cmd;
  # `source` without list/remove keeps its own usage error; any known option is fine there.
  my $accepted = $ACCEPTED{$key} // ( $cmd eq 'source' ? [ @{ $ACCEPTED{'source list'} }, @{ $ACCEPTED{'source remove'} } ] : [] );
  my %ok = map { ( $_ => 1 ) } @$accepted;
  return ( grep { $_ ne '--project-dir' && !$ok{$_} } @{ $flags->{options} } )[0];
}

sub parse_flags {
  my ( @args ) = @_;
  my %flags = ( scope => 'all', json => 0, force => 0, project => 0, project_dir => undef, options => [], rest => [] );
  for ( my $i = 0; $i < @args; $i++ ) {
    my $arg = $args[$i];
    push @{ $flags{options} }, ( $arg =~ /\A--/ ? $arg =~ s/=.*//sr : $arg ) if $arg =~ /\A-/;
    if    ( $arg eq '--json' )                  { $flags{json}        = 1 }
    elsif ( $arg eq '--force' )                 { $flags{force}       = 1 }
    elsif ( $arg eq '--project' )               { $flags{project}     = 1 }
    elsif ( $arg eq '--scope' )                 { $flags{scope}       = $args[ ++$i ] }    # undef past the end
    elsif ( $arg =~ /\A--scope=(.*)\z/s )       { $flags{scope}       = $1 }
    elsif ( $arg eq '--project-dir' )           { $flags{project_dir} = $args[ ++$i ] }
    elsif ( $arg =~ /\A--project-dir=(.*)\z/s ) { $flags{project_dir} = $1 }
    else                                        { push @{ $flags{rest} }, $arg }
  }
  return \%flags;
}

# Text to a stream as UTF-8, as Node writes a string.
sub _write {
  my ( $fh, $text ) = @_;
  print {$fh} Encode::encode( 'UTF-8', $text );
}

# Display lines, each escaped whole (spec §8), one newline after each.
sub _print_lines {
  my ( $fh, @lines ) = @_;
  _write( $fh, join( "\n", map { display_safe($_) } @lines )."\n" );
}

# Text whose newlines are line breaks, each line escaped.
sub _print_text {
  my ( $fh, $text ) = @_;
  my @lines = split /\n/, $text, -1;
  _print_lines( $fh, @lines ? @lines : ('') );
}

# A string's truthiness in JavaScript: set and not empty.
sub _truthy { defined $_[0] && length $_[0] }

# The project root of a directory, as the hooks find it (spec §14.5): git's top level of $cwd,
# else $cwd itself. The reference's projectRootOf: one git run, 2 s, git's environment.
sub project_root_of {
  my ( $cwd ) = @_;
  my $r = eval {
    run_command( cmd => [ 'git', '-C', encode_text($cwd), 'rev-parse', '--show-toplevel' ], env => git_env(), timeout_ms => 2_000 );
  };
  return $cwd unless $r && !$r->{spawn_error} && !$r->{timed_out} && defined $r->{code} && $r->{code} == 0;
  ( my $top = decode_utf8_lossy( $r->{stdout} ) ) =~ s/\A\s+|\s+\z//g;
  return length $top ? path_resolve($top) : $cwd;
}

# Node's os.homedir(): $HOME, else the user's passwd entry.
sub _home {
  return decode_utf8_lossy( $ENV{HOME} ) if defined $ENV{HOME};
  my $dir = ( getpwuid $< )[7];
  die "A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)\n" unless defined $dir;
  return decode_utf8_lossy($dir);
}

# The engine a command runs on, as the reference's makeContext builds it: the home, the project
# from --project-dir or the git top level of cwd. The rest is the engine's own default, read from
# this machine: the state root <CLAUDE_CONFIG_DIR or ~/.claude>/skilletor, host and user, the
# harness markers, git's answers.
sub _engine {
  my ( $flags ) = @_;
  require Skilletor::Engine;    # loaded for the commands that run it: --help and usage errors stay fast
  my $home = _home();
  my $cwd  = Cwd::getcwd();
  die "ENOENT: process.cwd failed with error no such file or directory, uv_cwd\n" unless defined $cwd;
  return Skilletor::Engine->new( home => $home, project_dir => $flags->{project_dir} // project_root_of( decode_utf8_lossy($cwd) ) );
}

# The sync report, or "up to date" when no scope has anything to say; run-level warnings and
# notes come in addition, never instead (the reference's syncText).
sub _sync_text {
  my ( $r ) = @_;
  my $text = report_text($r);
  my $run_level = @{ $r->{warnings} // [] } || @{ $r->{notes} // [] };
  if ($run_level) {
    my %scopes_only = %$r;
    delete @scopes_only{qw( warnings notes )};
    return "skilletor: up to date\n$text" unless length report_text( \%scopes_only );
  }
  return length $text ? $text : 'skilletor: up to date';
}

# A sync that stopped at a config error (spec §7): its report on stderr, exit 2. With `saved`,
# the config file the command's edit wrote before the sync: it stays, and the lines say so
# (k103).
sub _sync_failed {
  my ( $r, %opts ) = @_;
  if ( !defined $opts{saved} ) {
    _print_text( \*STDERR, $opts{json} ? report_json($r) : report_text($r) );
  }
  else {
    _print_lines( \*STDERR, 'skilletor: config error, nothing synced — '.$r->{error},
      'skilletor: the config edit itself was saved in '.$opts{saved}.' (not rolled back); fix the error, then run skilletor sync' );
  }
  return 2;
}

sub _sync {
  my ( $flags ) = @_;
  my $r = _engine($flags)->sync( scope => $flags->{scope}, force => $flags->{force} );
  return _sync_failed( $r, json => $flags->{json} ) if _truthy( $r->{error} );
  _print_text( \*STDOUT, $flags->{json} ? report_json($r) : _sync_text($r) );
  return 0;
}

sub _check {
  my ( $flags ) = @_;
  my $r = _engine($flags)->check( scope => $flags->{scope} );
  if ( _truthy( $r->{error} ) ) {    # a line, never JSON – under --json too
    _print_lines( \*STDERR, 'skilletor: '.$r->{error} );
    return 2;
  }
  _print_text( \*STDOUT, $flags->{json} ? report_json($r) : $r->{changed} ? 'changed' : 'up to date' );
  return $r->{changed} ? 1 : 0;
}

sub _status {
  my ( $flags ) = @_;
  my $r = _engine($flags)->status( scope => $flags->{scope} );
  _print_text( \*STDOUT, $flags->{json} ? report_json($r) : status_text($r) );    # an error too: stdout, exit 2
  return _truthy( $r->{error} ) ? 2 : 0;
}

# A usage error (spec §7): its line on stderr, exit 2.
sub _usage_error {
  my ( $line ) = @_;
  _write( \*STDERR, "$line\n" );
  return 2;
}

# A command whose engine side this CLI does not have yet: say so, exit 1.
sub _not_ported {
  my ( $what ) = @_;
  _print_lines( \*STDERR, "skilletor: $what is not ported to the Perl CLI yet" );
  return 1;
}

# What a caught error says: a Skilletor::Error's message, else Perl's text without the
# " at FILE line N." it appends.
sub _message {
  my ( $err ) = @_;
  return $err->message if blessed $err && $err->can('message');
  my $text = "$err";
  $text =~ s/ at (?:(?! at ).)+ line \d+(?:, <[^>]*> (?:line|chunk) \d+)?\.\n\z//s;
  chomp $text;
  return $text;
}

sub run {
  my ( @argv ) = map { Encode::decode( 'UTF-8', $_ ) } @_;
  # Argument hygiene (spec §7): --version only first, --help anywhere and alone.
  if ( @argv && ( $argv[0] eq '--version' || $argv[0] eq '-v' ) ) {
    _write( \*STDOUT, CLI_VERSION."\n" );
    return 0;
  }
  if ( !@argv || grep { $_ eq '--help' || $_ eq '-h' } @argv ) {
    _write( \*STDOUT, USAGE );    # no command has its own help yet
    return 0;
  }

  my $cmd = $argv[0];
  if ( $cmd =~ /\A-/ ) {
    _print_lines( \*STDERR, "skilletor: unknown option: $cmd (run skilletor --help)" );
    return 2;
  }
  my $flags = parse_flags( @argv[ 1 .. $#argv ] );
  # Ahead of every check (k164): a hook never fails on its arguments.
  return _not_ported('hook') if $cmd eq 'hook';
  my $unknown = unknown_option( $cmd, $flags );
  if ( defined $unknown ) {
    my $name = $cmd eq 'source' && exists $ACCEPTED{ _source_key($flags) } ? _source_key($flags) : $cmd;
    _print_lines( \*STDERR, "skilletor: unknown option for $name: $unknown (run skilletor --help)" );
    return 2;
  }
  my $scope = $flags->{scope};
  if ( !defined $scope || !grep { $scope eq $_ } qw( user project all ) ) {
    _print_lines( \*STDERR, 'skilletor: invalid --scope: '.( $scope // 'undefined' ) );
    return 2;
  }

  my $code;
  return $code if eval { $code = _dispatch( $cmd, $flags ); 1 };
  _print_text( \*STDERR, 'skilletor: '._message($@) );
  return 1;
}

sub _dispatch {
  my ( $cmd, $flags ) = @_;
  my @rest = @{ $flags->{rest} };
  my $given = sub { defined $_[0] && length $_[0] };    # JavaScript's truthiness of a string
  return _sync($flags)   if $cmd eq 'sync';
  return _check($flags)  if $cmd eq 'check';
  return _status($flags) if $cmd eq 'status';
  return _not_ported($cmd) if $cmd eq 'available';
  if ( $cmd eq 'add' ) {
    return _usage_error('skilletor: add needs a source spec') unless @rest;
    return _not_ported('add');
  }
  if ( $cmd eq 'source' ) {
    my $sub = $rest[0] // '';
    return _not_ported('source list') if $sub eq 'list';
    if ( $sub eq 'remove' ) {
      return _usage_error('skilletor: source remove needs a name') unless $given->( $rest[1] );
      return _not_ported('source remove');
    }
    return _usage_error('skilletor: usage: source list | source remove <name>');
  }
  if ( $cmd eq 'install' || $cmd eq 'uninstall' ) {
    return _usage_error("skilletor: $cmd needs at least one item") unless @rest;
    return _not_ported($cmd);
  }
  if ( $cmd eq 'trust' ) {
    return _usage_error('skilletor: trust needs a source name') unless $given->( $rest[0] );
    return _not_ported('trust');
  }
  _print_lines( \*STDERR, "skilletor: unknown command: $cmd" );
  return 2;
}

1;

=synopsis

  use Skilletor::CLI;
  exit Skilletor::CLI::run(@ARGV);

=description

The command line of the Perl port, after the reference's F<src/cli.ts>: the
same usage text, version, options, error lines and exit codes, byte for byte –
the shared conformance cases (F<../conformance>, op C<cli>) run either CLI
against the same expectations.

It runs C<sync>, C<check> and C<status> on L<Skilletor::Engine>, with
C<--scope>, C<--force> and C<--json> as the reference reads them:

=over 4

=item * C<sync> prints its report, or C<skilletor: up to date> when no scope
has anything to say; C<--json> prints the report as JSON. A config error puts
the report (text, or JSON with C<--json>) on stderr and exits 2.

=item * C<check> prints C<changed> and exits 1 when a sync is due, else
C<up to date> and 0; C<--json> prints the report. An error is the one line
C<skilletor: E<lt>errorE<gt>> on stderr, exit 2 – never JSON, with C<--json>
too.

=item * C<status> prints the declared items per scope, naming its targets unless
they are Claude Code alone; C<--json> prints the report. An error goes to
stdout as well, exit 2.

=back

The engine runs on this machine: the home from C<$HOME>, the project from
C<--project-dir> or the git top level of the working directory
(L</project_root_of>), state under C<$CLAUDE_CONFIG_DIR> or F<~/.claude>, in
F<skilletor/>, and the real host and user for templates. The engine is loaded
only for these commands, so C<--help> and a usage error stay quick.

Every other command and C<hook> is not ported yet: it says so on stderr and
exits 1. Beside them the CLI has the argument layer: C<--help>, C<--version>,
the options each command accepts, an unknown option or command, an invalid
C<--scope> and a missing operand.

Output is UTF-8; every line a user's input reaches is escaped by
L<Skilletor::Report/display_safe>.

=func run

  my $exit = Skilletor::CLI::run(@ARGV);

Runs one command line – the arguments as the operating system passes them,
UTF-8 bytes – writing to C<STDOUT> and C<STDERR>, and returns the exit code: 0,
1 for a failure, 2 for a usage error.

=func parse_flags

  my $flags = parse_flags(@args);

The arguments after the command: C<< { scope, json, force, project,
project_dir, options, rest } >>. C<options> lists every option given, by name
(C<--scope=user> is C<--scope>), in order; C<rest> holds the operands and every
option the parser does not know. C<scope> is C<undef> when C<--scope> is the
last argument.

=func project_root_of

  my $root = project_root_of($cwd);

The project of a working directory as the reference's hooks and CLI find it:
C<git -C $cwd rev-parse --show-toplevel> in git's environment
(L<Skilletor::GitEnv>), given 2 seconds; when git fails, times out or prints
nothing, C<$cwd> itself.

=func unknown_option

  my $option = unknown_option( $cmd, $flags );

The first option C<$cmd> does not accept, or C<undef>.

=cut
