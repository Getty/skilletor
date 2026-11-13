package Skilletor::Hooks;
# ABSTRACT: The Claude Code hooks – SessionStart, UserPromptSubmit and the background sync (spec §8)

use strict;
use warnings;
use utf8;

use Cwd ();
use Exporter qw( import );
use Scalar::Util qw( blessed );
use Skilletor::FSUtil qw( decode_utf8_lossy encode_text path_resolve same_path );
use Skilletor::GitEnv qw( git_env );
use Skilletor::JSON qw( js_ordered js_type );
use Skilletor::Process qw( run_command spawn_detached );
use Skilletor::Report qw( display_safe empty_scope_report report_hook );

our $VERSION = '0.002';

our @EXPORT_OK = qw( run_hook project_root_of default_background SESSION_START_TIMEOUT_MS DEFAULT_INTERVAL );

# A SessionStart check and sync give each source this long (the reference's 5 s).
use constant SESSION_START_TIMEOUT_MS => 5_000;

# The in-session check's interval when the config cannot be loaded; the config's own default
# (checkInterval, 1800 s) is Skilletor::Config's.
use constant DEFAULT_INTERVAL => 600;

# State, Config and Engine are loaded by the events that use them: a prompt with nothing due
# loads no engine.

# The project of a directory, as the hooks and the CLI find it (spec §14.5): git's top level of
# $cwd – of the repository found from $cwd, never one an exported GIT_DIR names (k91) – else $cwd
# itself. The reference's projectRootOf: one git run, 2 s, git's environment. Never dies.
sub project_root_of {
  my ( $cwd ) = @_;
  my $r = eval {
    run_command( cmd => [ 'git', '-C', encode_text($cwd), 'rev-parse', '--show-toplevel' ], env => git_env(), timeout_ms => 2_000 );
  };
  return $cwd unless $r && !$r->{spawn_error} && !$r->{timed_out} && defined $r->{code} && $r->{code} == 0;
  ( my $top = decode_utf8_lossy( $r->{stdout} ) ) =~ s/\A\s+|\s+\z//g;
  return length $top ? path_resolve($top) : $cwd;
}

# A string's truthiness in JavaScript: set and not empty.
sub _truthy { defined $_[0] && length $_[0] }

# A hook input's string field, when it is a non-empty one.
sub _text { js_type( $_[0] ) eq 'string' && length $_[0] ? $_[0] : undef }

# The session a hook input belongs to; '' when it names none.
sub _session_of { js_type( $_[0]{session_id} ) eq 'string' ? $_[0]{session_id} : '' }

sub _project_key {
  my ( $ctx, $input ) = @_;
  return $ctx->{project_dir} // _text( $input->{cwd} ) // '';
}

# The project dir, unless it is the home dir itself: then there is no project scope.
sub _project_dir_of {
  my ( $ctx ) = @_;
  my $p = $ctx->{project_dir};
  return undef if !_truthy($p) || same_path( $p, $ctx->{home} );
  return $p;
}

# Claude Code's config dir as the hook's context gives it, else CLAUDE_CONFIG_DIR.
sub _claude_config_dir {
  my ( $ctx ) = @_;
  return $ctx->{claude_config_dir} if _truthy( $ctx->{claude_config_dir} );
  return _truthy( $ENV{CLAUDE_CONFIG_DIR} ) ? decode_utf8_lossy( $ENV{CLAUDE_CONFIG_DIR} ) : undef;
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

sub _lock_timeout { blessed $_[0] && $_[0]->isa('Skilletor::Error::LockTimeout') }

# One warning line; the message – an error, git's stderr, a name from a config – display-safe.
sub _warn { js_ordered( systemMessage => display_safe( 'skilletor: '.$_[0] ) ) }

# A sync report as hook output: the line and, under the event's name, the context.
sub _to_output {
  my ( $report, $event ) = @_;
  my $h = report_hook($report);
  return js_ordered() unless _truthy( $h->{systemMessage} ) || _truthy( $h->{additionalContext} );
  return js_ordered(
    ( defined $h->{systemMessage} ? ( systemMessage => $h->{systemMessage} ) : () ),
    hookSpecificOutput =>
      js_ordered( hookEventName => $event, ( defined $h->{additionalContext} ? ( additionalContext => $h->{additionalContext} ) : () ) ),
  );
}

sub _state {
  my ( $ctx ) = @_;
  require Skilletor::State;
  return Skilletor::State->new( root => $ctx->{state_root} );
}

# The engine for the hook's project; %defaults (a per-source timeout) yield to the context's own
# engine arguments.
sub _engine {
  my ( $ctx, %defaults ) = @_;
  require Skilletor::Engine;
  return Skilletor::Engine->new(
    %defaults,
    home              => $ctx->{home},
    project_dir       => $ctx->{project_dir},
    claude_config_dir => _claude_config_dir($ctx),
    state_root        => $ctx->{state_root},
    %{ $ctx->{engine} // {} },
  );
}

sub _cwd {
  my $cwd = Cwd::getcwd();
  die "ENOENT: process.cwd failed with error no such file or directory, uv_cwd\n" unless defined $cwd;
  return decode_utf8_lossy($cwd);
}

sub run_hook {
  my ( $event, $input, $hook_ctx ) = @_;
  my $out;
  return $out if eval { $out = _dispatch( $event, $input, $hook_ctx ); 1 };
  return _warn( _message($@) );
}

sub _dispatch {
  my ( $event, $input, $hook_ctx ) = @_;
  # The checkout-move hooks (spec §8) come with k182.
  return _warn("hook $event is not ported to the Perl CLI yet") if $event eq 'cwd-changed' || $event eq 'post-tool-use';
  my $ctx = _truthy( $hook_ctx->{project_dir} ) ? $hook_ctx : { %$hook_ctx, project_dir => project_root_of( _text( $input->{cwd} ) // _cwd() ) };
  return _session_start( $input, $ctx )      if $event eq 'session-start';
  return _user_prompt_submit( $input, $ctx ) if $event eq 'user-prompt-submit';
  if ( $event eq '__sync-background' ) {
    _sync_background( $input, $ctx );
    return js_ordered();
  }
  return _warn("unknown hook event: $event");
}

# Codex's rules context and Hermes' opt-in line (`--harness codex|hermes`) come with k184 and
# k185; until then such a SessionStart answers as Claude Code's.
sub _session_start {
  my ( $input, $ctx ) = @_;
  my $out;
  $out = _warn( _message($@) ) unless eval { $out = _check_and_sync( $input, $ctx ); 1 };
  _record_session_cwd( $input, $ctx );
  return $out;
}

sub _check_and_sync {
  my ( $input, $ctx ) = @_;
  my $state = _state($ctx);
  my $key = _project_key( $ctx, $input );
  my $engine = _engine( $ctx, timeout_ms => SESSION_START_TIMEOUT_MS );

  my $chk = $engine->check;
  return _warn( $chk->{error} ) if _truthy( $chk->{error} );
  $state->mark_checked($key);

  return _unchanged_output($chk) unless $chk->{changed};
  my $report;
  unless ( eval { $report = $engine->sync; 1 } ) {
    my $err = $@;
    $state->due_again($key) if _lock_timeout($err);
    die $err;
  }
  return _to_output( $report, 'SessionStart' );
}

# A check with nothing to sync: its warnings in one line – or, when a source awaits trust, the
# report a sync would give, trust requests and warnings alike (spec §4.3, §8).
sub _unchanged_output {
  my ( $chk ) = @_;
  unless ( @{ $chk->{trustRequests} // [] } ) {
    return @{ $chk->{warnings} } ? _warn( join '; ', @{ $chk->{warnings} } ) : js_ordered();
  }
  return _to_output( _trust_report($chk), 'SessionStart' );
}

# The report a sync would give of a check whose sources await trust (at least one).
sub _trust_report {
  my ( $chk ) = @_;
  my $report = js_ordered( scopes => [] );
  my %by_scope;
  for my $t ( @{ $chk->{trustRequests} } ) {
    my $rep = $by_scope{ $t->{scope} } //= do {
      my $r = empty_scope_report( $t->{scope} );
      push @{ $report->{scopes} }, $r;
      $r;
    };
    push @{ $rep->{trustRequests} }, js_ordered( map { ( $_ => $t->{$_} ) } grep { $_ ne 'scope' } keys %$t );
  }
  push @{ $report->{scopes}[0]{warnings} }, @{ $chk->{warnings} };
  return $report;
}

# Where a session's SessionStart looked (k149). Best effort: without the record the first move
# looks once more.
sub _record_session_cwd {
  my ( $input, $ctx ) = @_;
  my $cwd = _text( $input->{cwd} ) // return;
  eval { _state($ctx)->put_session_cwd( _session_of($input), $cwd ); 1 };
  return;
}

# Codex's and Hermes' prompt hook follows a move first (k149); that comes with k184 and k185.
sub _user_prompt_submit {
  my ( $input, $ctx ) = @_;
  my $state = _state($ctx);
  my $key = _project_key( $ctx, $input );
  my $pending = $state->take_pending_report($key);

  my $interval = DEFAULT_INTERVAL;
  eval {    # a config error: the fallback throttle; the background sync reports it
    require Skilletor::Config;
    $interval = Skilletor::Config->load( home => $ctx->{home}, claude_config_dir => _claude_config_dir($ctx), project_dir => _project_dir_of($ctx) )
      ->check_interval;
    1;
  };

  # checkInterval <= 0 turns the in-session check off entirely (SessionStart still syncs).
  if ( $interval > 0 && $state->is_due( $key, $interval ) ) {
    $state->mark_checked($key);
    ( $ctx->{background} // \&default_background )->($ctx);
  }
  return $pending // js_ordered();
}

# Runs in the detached child: sync, then leave the result as a pending report – its stdout
# reaches no one. A sync that dies leaves its error, the line SessionStart would give; one that
# timed out on the sync lock leaves no report – the run that holds the lock reports its own sync
# (spec §6.5) – and the project due, so the next prompt retries.
sub _sync_background {
  my ( $input, $ctx ) = @_;
  my $key = _project_key( $ctx, $input );
  my $state = _state($ctx);
  my $output;
  unless ( eval { $output = _to_output( _engine($ctx)->sync, 'UserPromptSubmit' ); 1 } ) {
    my $err = $@;
    return $state->due_again($key) if _lock_timeout($err);
    $output = _warn( _message($err) );
  }
  $state->put_pending_report( $key, $output ) if _truthy( $output->{systemMessage} ) || $output->{hookSpecificOutput};
  return;
}

# Start `hook __sync-background` of this CLI, detached (the default background).
sub default_background {
  my ( $ctx, $spawn ) = @_;
  my $cmd = $ctx->{self_command} or return;
  ( $spawn // \&spawn_detached )->(
    cmd => [ @$cmd, 'hook', '__sync-background' ],
    env => { %ENV, SKILLETOR_PROJECT_DIR => encode_text( $ctx->{project_dir} // '' ) },
  );
  return;
}

1;

=synopsis

  use Skilletor::Hooks qw( run_hook );

  my $out = run_hook( 'session-start', { source => 'startup', cwd => $dir }, {
    home         => $ENV{HOME},
    project_dir  => $ENV{CLAUDE_PROJECT_DIR},    # undef: the git top level of the input's cwd
    state_root   => "$ENV{HOME}/.claude/skilletor",
    self_command => [ $^X, $0 ],                 # what `default_background` re-runs
  } );
  # {} or { systemMessage => …, hookSpecificOutput => { hookEventName, additionalContext? } }

=description

The reference's F<src/hooks.ts> for Claude Code: a black box from a hook's
input to its output, which never disturbs the session – every path catches and
says what went wrong in one warning line (C<skilletor: …>, display-safe).
L<Skilletor::CLI> runs it as C<skilletor hook E<lt>eventE<gt>>.

=over 4

=item * C<session-start>: a L<Skilletor::Engine/check> of every source, 5 s
each, marks the project checked; when it says changed, a sync, whose report
(L<Skilletor::Report/report_hook>) is the answer. Nothing changed: the check's
warnings in one line, or the trust requests as a sync would report them. A
sync that timed out on the sync lock leaves the project due again. The input's
C<cwd> is recorded for its session (C<session-cwd.json>).

=item * C<user-prompt-submit>: hands out the project's pending report; when
the project is due (C<checkInterval> of the config, 600 s when it cannot be
loaded; 0 or less never), marks it checked and starts the background sync. No
engine is loaded on this path.

=item * C<__sync-background>: a sync whose answer becomes the project's pending
report; a lock timeout leaves none, and the project due again.

=back

Without C<project_dir> the project is the git top level of the input's C<cwd>,
else of the process's (L</project_root_of>). The project dir is also the key of
the check mark and the pending report.

Not ported yet: C<cwd-changed> and C<post-tool-use> (k182) answer that they are
not, in one warning line; C<harness> C<codex> or C<hermes> changes nothing yet
(Codex's rules context, Hermes' opt-in line and their prompt hook's move, k184
and k185) – such a hook answers as Claude Code's.

=func run_hook

  my $out = run_hook( $event, \%input, \%ctx );

Never dies. C<%ctx>: C<home>, C<project_dir>, C<state_root>, C<harness>,
C<claude_config_dir> (default C<CLAUDE_CONFIG_DIR>), C<self_command>,
C<background> (a code ref called with the context instead of
L</default_background>) and C<engine>, more arguments of
L<Skilletor::Engine/new> (C<markers>, C<timeout_ms>, C<lock_timeout_ms>, …),
which win over the hook's own.

=func default_background

  default_background( \%ctx );
  default_background( \%ctx, $spawn );   # $spawn->( cmd => [...], env => {...} ) instead

Starts C<< @{ $ctx->{self_command} } hook __sync-background >> with
L<Skilletor::Process/spawn_detached>: detached, its own session, no stdio, the
environment with C<SKILLETOR_PROJECT_DIR> set to the project. Without
C<self_command> it starts nothing.

=func project_root_of

  my $root = project_root_of($cwd);

C<git -C $cwd rev-parse --show-toplevel> in git's environment
(L<Skilletor::GitEnv>), given 2 seconds; when git fails, times out or prints
nothing, C<$cwd> itself.

=func SESSION_START_TIMEOUT_MS

=func DEFAULT_INTERVAL

=cut
