package Skilletor::Hooks;
# ABSTRACT: The Claude Code hooks – SessionStart, UserPromptSubmit, the background sync and the checkout moves (spec §8)

use strict;
use warnings;
use utf8;

use Cwd ();
use Exporter qw( import );
use Scalar::Util qw( blessed );
use Time::HiRes ();
use Skilletor::FSUtil qw( decode_utf8_lossy encode_text path_join path_resolve same_path );
use Skilletor::GitEnv qw( git_env );
use Skilletor::JSON qw( js_ordered js_type );
use Skilletor::Process qw( run_command spawn_detached );
use Skilletor::Report qw( display_safe empty_scope_report report_hook );

our $VERSION = '0.002';

our @EXPORT_OK = qw( run_hook project_root_of default_background SESSION_START_TIMEOUT_MS DEFAULT_INTERVAL MOVE_DEADLINE_MS );

# A SessionStart check and sync give each source this long (the reference's 5 s).
use constant SESSION_START_TIMEOUT_MS => 5_000;

# The in-session check's interval when the config cannot be loaded; the config's own default
# (checkInterval, 1800 s) is Skilletor::Config's.
use constant DEFAULT_INTERVAL => 600;

# A move's sync writes nothing once this has passed (spec §8): Claude Code kills the hook at 30 s,
# which leaves the local rest of a sync 10 s. Its two move hooks wait for the sync lock up to it.
use constant MOVE_DEADLINE_MS => 20_000;

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
  # The checkout the session moved into is the project, never the session's own (spec §8).
  return _cwd_changed( $input, $hook_ctx )   if $event eq 'cwd-changed';
  return _post_tool_use( $input, $hook_ctx ) if $event eq 'post-tool-use';
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

# ---- checkout moves (spec §8) ----------------------------------------------------------------

sub _now_ms { int( Time::HiRes::time() * 1000 ) }

# A session moved into $move->{cwd} (the reference's moveCheckout): the checkout is the git top
# level of the new cwd, never the session's project. Nothing to do – no source asked, nothing
# written – when it is the old cwd's checkout, the home dir, has no `.claude/skilletor.json`, or
# its lock already matches its config (a local check). Otherwise its project scope syncs as at
# SessionStart – 5 s per source, nothing written once the deadline has passed – unless, once the
# sync lock is held, its lock matches after all: another run synced it meanwhile. One line names
# the checkout and, when something is left to do, the command to run there. Never dies.
#
# $move: cwd, old_cwd (when the event names one), event (the answer's hookEventName),
# lock_until_deadline (wait for the sync lock until the deadline, not the usual 5 s: Claude Code
# fires two move hooks for one `cd`, and the second waits out the other's sync). Returns the
# answer and – when it answered for the checkout, with a sync or with what is left to do there –
# that checkout. Hermes' `hermes skills trust` line (k152) comes with k185: the Perl engine adds
# no Codex or Hermes skill yet.
sub _move_checkout {
  my ( $move, $ctx ) = @_;
  my $root = project_root_of( $move->{cwd} );
  my @result;
  return @result if eval { @result = _move_checkout_of( $root, $move, $ctx ); 1 };
  my $err = $@;
  # Timed out on the sync lock: another run holds it – a background sync of this very checkout,
  # maybe – and synced nothing here, so the interval check is left to retry (k89).
  return ( _cannot_sync( $root, _message($err) ), _lock_timeout($err) ? undef : $root );
}

sub _move_checkout_of {
  my ( $root, $move, $ctx ) = @_;
  return js_ordered() if same_path( $root, $ctx->{home} ) || !-e encode_text( path_join( $root, '.claude', 'skilletor.json' ) );
  return js_ordered() if defined $move->{old_cwd} && same_path( project_root_of( $move->{old_cwd} ), $root );
  my $deadline = $ctx->{deadline} // _now_ms() + MOVE_DEADLINE_MS;
  # Past the deadline the sync writes nothing: a longer wait would be for nothing.
  my $lock_timeout = ( $ctx->{engine} // {} )->{lock_timeout_ms};
  if ( !defined $lock_timeout && $move->{lock_until_deadline} ) {
    $lock_timeout = $deadline - _now_ms();
    $lock_timeout = 0 if $lock_timeout < 0;
  }
  my $engine = _engine( { %$ctx, project_dir => $root }, timeout_ms => SESSION_START_TIMEOUT_MS );
  my $chk = $engine->check( scope => 'project', local => 1 );
  return ( _cannot_sync( $root, $chk->{error} ), $root ) if _truthy( $chk->{error} );
  unless ( $chk->{changed} ) {
    return ( _moved_output( _trust_report($chk), $root, $move->{event} ), $root ) if @{ $chk->{trustRequests} // [] };
    return @{ $chk->{warnings} } ? ( _cannot_sync( $root, join '; ', @{ $chk->{warnings} } ), $root ) : js_ordered();
  }
  # No scopes: a run this one waited for on the sync lock – the other Claude Code hook of the
  # same `cd`, say – synced the checkout meanwhile, and its answer was that run's to give.
  my $report = $engine->sync( scope => 'project', if_changed => 1, deadline => $deadline, lock_timeout_ms => $lock_timeout );
  return js_ordered() if !_truthy( $report->{error} ) && !@{ $report->{scopes} };
  return ( _cannot_sync( $root, $report->{error} ), $root ) if _truthy( $report->{error} );
  return ( _moved_output( $report, $root, $move->{event} ), $root );
}

# The one line of a move that could not sync: the checkout, why, and what to run there.
sub _cannot_sync {
  my ( $dir, $message ) = @_;
  return _warn("cannot sync $dir: $message — run there: skilletor sync");
}

# A move's report: the line says where, and what to run there for what is left – trusting a
# source, or a sync that shows each warning and conflict; the context says where first.
sub _moved_output {
  my ( $report, $dir, $event ) = @_;
  my $out = _to_output( $report, $event );
  return $out unless _truthy( $out->{systemMessage} );
  my ( @fixes, %seen );
  for my $s ( @{ $report->{scopes} } ) {
    push @fixes, grep { !$seen{$_}++ } map { "skilletor trust $_->{name}" } @{ $s->{trustRequests} // [] };
  }
  push @fixes, 'skilletor sync' if grep { @{ $_->{warnings} // [] } || @{ $_->{conflicts} // [] } } @{ $report->{scopes} };
  my $result = js_ordered( systemMessage => display_safe( "$out->{systemMessage} in $dir".( @fixes ? ' — run there: '.join( '; ', @fixes ) : '' ) ) );
  my $context = ( $out->{hookSpecificOutput} // {} )->{additionalContext};
  if ( _truthy($context) ) {
    $result->{hookSpecificOutput} = js_ordered( hookEventName => $event, additionalContext => display_safe("skilletor: in $dir:")."\n$context" );
  }
  return $result;
}

# Claude Code's CwdChanged (spec §8): it is not awaited, and its output takes no context (only
# `watchPaths`), so the line is all it gives – it reaches the user, not the model. It never
# writes the session's cwd record: PostToolUse, fired for the same `cd`, would take it for a move
# already done and answer before this hook's sync is.
sub _cwd_changed {
  my ( $input, $ctx ) = @_;
  my $cwd = _text( $input->{new_cwd} ) // _text( $input->{cwd} ) // return js_ordered();
  my ($out) = _move_checkout( { cwd => $cwd, old_cwd => _text( $input->{old_cwd} ), event => 'CwdChanged', lock_until_deadline => 1 }, $ctx );
  return _truthy( $out->{systemMessage} ) ? js_ordered( systemMessage => $out->{systemMessage} ) : js_ordered();
}

# Claude Code's PostToolUse, which its hooks file runs on a Bash call with a `cd` only (spec §8):
# awaited – the next tool call waits for it – with the cwd after the command as `cwd`, and no old
# one: the session's record stands in. Its context reaches the model.
sub _post_tool_use {
  my ( $input, $ctx ) = @_;
  return _session_move( $input, $ctx, _state($ctx), { event => 'PostToolUse', lock_until_deadline => 1 } );
}

# A move a hook sees only as the session's cwd (the reference's sessionMove): Claude Code's
# PostToolUse on a Bash `cd` – and, with k184 and k185, Codex's and Hermes' prompt hook (k149).
# The cwd the session's hook last looked at is kept per session id (written at SessionStart): the
# same cwd again asks nothing; another goes to the move core, which tells a move within one
# checkout from one into another. A move that answered for its checkout marks it checked, so the
# interval check starts no second sync of it beside this one.
sub _session_move {
  my ( $input, $ctx, $state, $event ) = @_;
  my $cwd = _text( $input->{cwd} ) // return js_ordered();
  my $session = _session_of($input);
  my $last = $state->session_cwd($session);
  return js_ordered() if defined $last && same_path( $last, $cwd );
  my ( $out, $answered ) = _move_checkout( { cwd => $cwd, old_cwd => $last, %$event }, $ctx );
  eval {    # the state dir cannot be written: the next move looks again
    $state->mark_checked($answered) if defined $answered;
    $state->put_session_cwd( $session, $cwd );
    1;
  };
  return $out;
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

=item * C<cwd-changed>: the session moved from C<old_cwd> into C<new_cwd>
(else C<cwd>); the checkout moved into is synced (below). Its answer is the
line alone – Claude Code's CwdChanged takes no context – and it writes no
session record.

=item * C<post-tool-use>, after a Bash C<cd>: the session's C<cwd> against
the one its session record names (SessionStart's, or the last move's); the
same cwd asks nothing, another is a move from the recorded one. The answer
has the line and a context for the model; a move that answered for its
checkout marks that checkout checked, and the record moves to the new cwd.

=back

A move into another checkout (spec §8) syncs that checkout – the git top level
of the new cwd, never C<project_dir> – in project scope: nothing happens when it
is the old cwd's checkout, the home dir, has no F<.claude/skilletor.json>, or
its lock already matches its config (a check with C<local>: no source asked).
Otherwise a sync with C<if_changed>, 5 s per source, writes nothing once
C<MOVE_DEADLINE_MS> (20 s) has passed and waits for the sync lock until then;
a trust request is answered without a sync. The line names the checkout
(C<… in E<lt>dirE<gt>>) and what to run there for what is left (C<skilletor
trust E<lt>nameE<gt>>, C<skilletor sync>); a failure is C<cannot sync
E<lt>dirE<gt>: E<lt>messageE<gt> — run there: skilletor sync>.

Without C<project_dir> the project is the git top level of the input's C<cwd>,
else of the process's (L</project_root_of>). The project dir is also the key of
the check mark and the pending report.

Not ported yet: C<harness> C<codex> or C<hermes> changes nothing yet (Codex's
rules context, Hermes' opt-in line and their prompt hook's move, k184 and
k185) – such a hook answers as Claude Code's.

=func run_hook

  my $out = run_hook( $event, \%input, \%ctx );

Never dies. C<%ctx>: C<home>, C<project_dir>, C<state_root>, C<harness>,
C<claude_config_dir> (default C<CLAUDE_CONFIG_DIR>), C<self_command>,
C<background> (a code ref called with the context instead of
L</default_background>), C<deadline> (a move's, in epoch ms; default
C<MOVE_DEADLINE_MS> from the hook's start) and C<engine>, more arguments of
L<Skilletor::Engine/new> (C<markers>, C<timeout_ms>, C<lock_timeout_ms>, …),
which win over the hook's own – a C<lock_timeout_ms> there over a move's wait
until its deadline as well.

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

=func MOVE_DEADLINE_MS

=cut
