#!/usr/bin/env perl
# The Perl runner of the shared conformance cases (../conformance, k143): the format is
# ../conformance/README.md, the reference runner ../test/conformance.test.ts. Every case runs in
# a fresh temp dir – HOME, the project, the git sources and a git config of its own – exactly as
# the reference runner sets it up, so both engines build the same commits and cache dir names. A
# `cli` step runs a CLI – bin/skilletor, or the one SKILLETOR_CONFORMANCE_CLI names (the
# reference's bundle, say) – in an environment built from nothing.
use strict;
use warnings;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( git_ok );

use Cwd ();
use Encode ();
use File::Spec ();
use JSON::MaybeXS ();
use Path::Tiny qw( path tempdir );
use Skilletor::CLI ();
use Skilletor::FSUtil qw( encode_text read_text );
use Skilletor::JSON qw( js_ordered js_parse js_sort_keys js_stringify js_type );
use Skilletor::Engine;
use Skilletor::Process qw( run_command );

my $ROOT = path( $FindBin::Bin, '..', '..', 'conformance', 'cases' );
plan skip_all => 'needs the shared conformance cases (../conformance, a skilletor checkout)' unless $ROOT->is_dir;

# The version a `cli` step that asks for it writes as ${VERSION} (README: placeholders): the
# plugin's, which the Perl CLI reports as well – provisional, k167.
my $VERSION = js_parse( read_text( path( $FindBin::Bin, '..', '..', 'package.json' ) ) )->{version};
is( Skilletor::CLI::CLI_VERSION, $VERSION, "the Perl CLI reports the plugin's version (package.json)" );

# The CLI of `cli` steps as an argv prefix (README: which CLI): SKILLETOR_CONFORMANCE_CLI, a JSON
# array, else this perl running bin/skilletor from lib/.
my @CLI = do {
  my $override = $ENV{SKILLETOR_CONFORMANCE_CLI};
  if ( defined $override ) {
    my $prefix = js_parse( Encode::decode( 'UTF-8', $override ) );
    BAIL_OUT("SKILLETOR_CONFORMANCE_CLI is no JSON array of strings: $override")
      unless js_type($prefix) eq 'array' && @$prefix && !grep { js_type($_) ne 'string' } @$prefix;
    map { encode_text($_) } @$prefix;
  }
  else {
    ( $^X, '-I'.path( $FindBin::Bin, '..', 'lib' )->realpath, path( $FindBin::Bin, '..', 'bin', 'skilletor' )->realpath."" );
  }
};
my $CLI_TIMEOUT_MS = 30_000;

# The commit identity and date every source commit is made with (README: git sources).
my %COMMIT_ENV = (
  GIT_AUTHOR_NAME     => 'skilletor-conformance',
  GIT_AUTHOR_EMAIL    => 'conformance@skilletor.invalid',
  GIT_AUTHOR_DATE     => '2026-01-01T00:00:00+0000',
  GIT_COMMITTER_NAME  => 'skilletor-conformance',
  GIT_COMMITTER_EMAIL => 'conformance@skilletor.invalid',
  GIT_COMMITTER_DATE  => '2026-01-01T00:00:00+0000',
);

# Every file under $dir, relative and /-separated, sorted; $skip holds relative paths left out.
sub walk {
  my ( $dir, $skip, $base ) = @_;
  $skip //= [];
  $base //= $dir;
  return () unless -d $dir;
  my @out;
  opendir( my $dh, $dir ) or die "opendir $dir: $!";
  my @entries = sort grep { $_ ne '.' && $_ ne '..' } readdir $dh;
  closedir $dh;
  for my $entry (@entries) {
    my $p   = "$dir/$entry";
    my $rel = substr $p, length($base) + 1;
    next if grep { $_ eq $rel } @$skip;
    if   ( -d $p ) { push @out, walk( $p, $skip, $base ) }
    else           { push @out, $rel }
  }
  return sort @out;
}

# Keys sorted, arrays sorted by the canonical text of their elements, recursively (README).
sub canonical {
  my ( $v ) = @_;
  my $type = js_type($v);
  if ( $type eq 'array' ) {
    my %by;
    my @texts = map { my $c = canonical($_); my $t = js_stringify($c); $by{$t} = $c; $t } @$v;
    return [ map { $by{$_} } js_sort_keys(@texts) ];
  }
  return { map { ( $_ => canonical( $v->{$_} ) ) } keys %$v } if $type eq 'object';
  return $v;
}

# The projection of a resolve the cases pin (README: resolve).
sub resolve_view {
  my ( $r ) = @_;
  return { error => $r->{error}, scopes => [] } if defined $r->{error};
  return {
    scopes => [
      map {
        my $s = $_;
        +{
          scope   => $s->{scope},
          sources => [
            map {
              my $src = $_;
              my %o = ( name => $src->{name}, state => $src->{state} );
              if ( my $b = $src->{backend} ) {
                @o{qw( kind address origin )} = @{$b}{qw( kind address origin )};
                $o{ref}  = $b->{ref}  if defined $b->{ref};
                $o{path} = $b->{path} if defined $b->{path};
              }
              defined $src->{$_} and $o{$_} = $src->{$_} for qw( cache dir version );
              \%o;
            } @{ $s->{sources} }
          ],
          items => [
            map {
              my $i = $_;
              my %o = (
                type       => $i->{type},
                name       => $i->{name},
                source     => $i->{source},
                declaredBy => $i->{declaredBy},
                path       => $i->{type} eq 'skill' ? $i->{item}{dir} : $i->{item}{files}[0],
                files      => $i->{item}{files},
                templated  => ( grep { /\.njk\z/ } @{ $i->{item}{files} } ) ? JSON::MaybeXS::true() : JSON::MaybeXS::false(),
                vars       => $i->{vars},
              );
              $o{via}         = $i->{via}               if $i->{via};
              $o{description} = $i->{item}{description} if defined $i->{item}{description};
              \%o;
            } @{ $s->{items} }
          ],
          warnings      => $s->{warnings},
          trustRequests => $s->{trustRequests},
        };
      } @{ $r->{scopes} }
    ],
  };
}

sub placeholders {
  my ( $r ) = @_;
  return ( [ $r->{home}, '${HOME}' ], ( $r->{project} ? [ $r->{project}, '${PROJECT}' ] : () ), [ $r->{tmp}, '${TMP}' ] );
}

sub abstract {
  my ( $text, $r ) = @_;
  $text =~ s/\Q$_->[0]\E/$_->[1]/g for placeholders($r);
  return $text;
}

sub concrete {
  my ( $text, $r ) = @_;
  $text =~ s/\Q$_->[1]\E/$_->[0]/g for placeholders($r);
  return $text;
}

# A path as a case stores it (README: escaped names): every name starting with `.git` gets the
# prefix `dot`, since a `.gitignore` in a fixture would be live in the repository.
sub escape_name   { join q{/}, map { /\A\.git/ ? "dot$_" : $_ } split m{/}, $_[0], -1 }
sub unescape_name { join q{/}, map { /\Adot\.git/ ? substr( $_, 3 ) : $_ } split m{/}, $_[0], -1 }

# Copy a case's input tree, placeholders substituted in every file (README: inputs).
sub copy_input {
  my ( $from, $to, $r ) = @_;
  for my $rel ( walk($from) ) {
    my $dest = path( $to, unescape_name($rel) );
    $dest->parent->mkpath;
    $dest->spew_raw( encode_text( concrete( read_text("$from/$rel"), $r ) ) );
  }
}

# Copy a source tree byte for byte, in a new file's mode: the checkout's mode of the fixture
# does not count (README: trees).
sub copy_tree {
  my ( $from, $to ) = @_;
  for my $rel ( walk($from) ) {
    my $dest = path( $to, unescape_name($rel) );
    $dest->parent->mkpath;
    $dest->spew_raw( path( $from, $rel )->slurp_raw );
  }
}

# Build the case's git sources and the git config that reaches them (README: git sources).
sub build_git {
  my ( $case_dir, $c, $r ) = @_;
  local @ENV{ keys %COMMIT_ENV } = values %COMMIT_ENV;
  my @config;
  my $git = $c->{git} // {};
  for my $name ( keys %$git ) {
    my $g    = $git->{$name};
    my $repo = path( $r->{tmp}, 'git', $name );
    $repo->mkpath;
    git_ok( "$repo", 'init', '-q', '-b', 'main' );
    my $i = 0;
    for my $commit ( @{ $g->{commits} } ) {
      $i++;
      $_->basename eq '.git' or $_->remove_tree( { safe => 0 } ) for $repo->children;
      copy_tree( "$case_dir/$commit->{tree}", "$repo" );
      chmod 0755, "$repo/$_" for @{ $commit->{executable} // [] };
      git_ok( "$repo", 'add', '-A' );
      git_ok( "$repo", 'commit', '-q', '--allow-empty', '-m', "conformance $i" );
      git_ok( "$repo", 'tag', $commit->{tag} )       if defined $commit->{tag};
      git_ok( "$repo", 'branch', $commit->{branch} ) if defined $commit->{branch};
    }
    push @config, '[url "file://'.$repo.'"]', "\tinsteadOf = ".$g->{url};
  }
  path( $r->{tmp}, 'gitconfig' )->spew_raw( encode_text( join( "\n", @config )."\n" ) );
}

# A `cli` step's environment, built from nothing (README: cli): the case's, then the step's
# variables on top of the fixed ones; a step's null unsets one. Values are bytes.
sub cli_env {
  my ( $c, $step, $r ) = @_;
  my %env = (
    PATH                => $ENV{PATH} // '',
    HOME                => $r->{home},
    CODEX_HOME          => "$r->{home}/.codex",
    GIT_CONFIG_GLOBAL   => "$r->{tmp}/gitconfig",
    GIT_CONFIG_NOSYSTEM => '1',
    LC_ALL              => 'C',
  );
  $env{PERL5LIB} = $ENV{PERL5LIB} if defined $ENV{PERL5LIB};    # a Perl CLI's modules
  $env{$_} = encode_text( concrete( $c->{env}{$_}, $r ) ) for keys %{ $c->{env} // {} };
  for my $k ( keys %{ $step->{env} // {} } ) {
    my $v = $step->{env}{$k};
    if   ( defined $v ) { $env{$k} = encode_text( concrete( $v, $r ) ) }
    else                { delete $env{$k} }
  }
  return \%env;
}

# Input placeholders in every string of a JSON value, key order kept.
sub concrete_deep {
  my ( $v, $r ) = @_;
  my $type = js_type($v);
  return concrete( $v, $r ) if $type eq 'string';
  return [ map { concrete_deep( $_, $r ) } @$v ] if $type eq 'array';
  return js_ordered( map { ( $_ => concrete_deep( $v->{$_}, $r ) ) } keys %$v ) if $type eq 'object';
  return $v;
}

# Run a `cli` step's CLI (README: cli): stdin a pipe with the step's bytes. Returns
# { exit, stdout, stderr } (bytes), or { failed => why } for a CLI that does not start, outlives
# its timeout or dies of a signal.
sub run_cli {
  my ( $prefix, $step, $r, $env, $timeout_ms ) = @_;
  my $argv = $step->{argv};
  return { failed => 'argv is no array of strings' }
    unless js_type($argv) eq 'array' && !grep { js_type($_) ne 'string' } @$argv;
  my $stdin =
      !defined $step->{stdin}                ? ''
    : js_type( $step->{stdin} ) eq 'string' ? concrete( $step->{stdin}, $r )
    :                                         js_stringify( concrete_deep( $step->{stdin}, $r ) );
  my $res = run_command(
    cmd        => [ @$prefix, map { encode_text( concrete( $_, $r ) ) } @$argv ],
    cwd        => encode_text( defined $step->{cwd} ? concrete( $step->{cwd}, $r ) : $r->{project} // $r->{cwd} ),
    env        => $env,
    stdin      => encode_text($stdin),
    timeout_ms => $timeout_ms // $CLI_TIMEOUT_MS,
  );
  my $what = join ' ', @$prefix;
  return { failed => "$what did not start: $res->{spawn_error}{message}" } if $res->{spawn_error};
  return { failed => "$what outlived its timeout" }                         if $res->{timed_out};
  return { failed => "$what was killed by signal $res->{signal}" }         if !defined $res->{code};
  return { exit => $res->{code}, stdout => $res->{stdout}, stderr => $res->{stderr} };
}

# Output placeholders on raw bytes (README: placeholders), ${VERSION} only where asked.
sub abstract_bytes {
  my ( $bytes, $r, $version ) = @_;
  $bytes =~ s/\Q@{[ encode_text( $_->[0] ) ]}\E/$_->[1]/g for placeholders($r);
  $bytes =~ s/\Q$VERSION\E/\${VERSION}/g if $version;
  return $bytes;
}

# An expected stream: no file means empty.
sub read_stream { -f $_[0] ? path( $_[0] )->slurp_raw : '' }

# The relative paths under HOME a tree leaves out (README: trees): the marker, skilletor's state
# dir and the CLI's own, ${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skilletor.
sub home_skip {
  my ( $r, $config_dir ) = @_;
  my $state = ( defined $config_dir && length $config_dir ? $config_dir : "$r->{home}/.claude" ).'/skilletor';
  return [ '.claude/skilletor', '.claude.json', index( $state, "$r->{home}/" ) == 0 ? substr( $state, length( $r->{home} ) + 1 ) : () ];
}

# The files a tree step compares (README: trees): HOME but the state dirs and the marker, all of
# PROJECT – each without the .git a gitInit made there – and all of ${TMP}/cwd.
sub snapshot {
  my ( $r, $skip, $git_init ) = @_;
  my %init = map { ( $_ => 1 ) } @$git_init;
  my %out;
  $out{ "home/".escape_name($_) } = abstract( read_text("$r->{home}/$_"), $r ) for walk( $r->{home}, [ @$skip, $init{home} ? '.git' : () ] );
  if ( $r->{project} ) {
    $out{ "project/".escape_name($_) } = abstract( read_text("$r->{project}/$_"), $r ) for walk( $r->{project}, [ $init{project} ? '.git' : () ] );
  }
  $out{ "cwd/".escape_name($_) } = abstract( read_text("$r->{cwd}/$_"), $r ) for walk( $r->{cwd} );
  return \%out;
}

sub run_case {
  my ( $name ) = @_;
  my $case_dir = "$ROOT/$name";
  my $c = js_parse( read_text("$case_dir/case.json") );
  my @live = grep { grep { /\A\.git/ } split m{/} } walk($case_dir);
  is_deeply( \@live, [], 'fixture names starting with .git are stored escaped (dot.gitignore)' );
  my $engine = ( $c->{engines} // {} )->{perl} // {};
  plan skip_all => $engine->{skip} if defined $engine->{skip};
  my $tempdir = tempdir( 'skilletor-conformance-XXXXXX', TMPDIR => 1 );    # removed with the case
  my $tmp = Cwd::realpath("$tempdir");
  my $r = { tmp => $tmp, home => "$tmp/home", cwd => "$tmp/cwd" };
  $r->{project} = "$tmp/project" if -d "$case_dir/project";

  local $ENV{GIT_CONFIG_GLOBAL}   = "$tmp/gitconfig";
  local $ENV{GIT_CONFIG_NOSYSTEM} = '1';
  local @ENV{qw( CODEX_HOME HERMES_HOME CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR )};
  delete @ENV{qw( CODEX_HOME HERMES_HOME CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR )};
  $ENV{$_} = concrete( $c->{env}{$_}, $r ) for sort keys %{ $c->{env} // {} };
  build_git( $case_dir, $c, $r );
  path( $r->{home}, '.claude' )->mkpath;
  my $marker = !( exists $c->{claude} && !$c->{claude} );    # "claude": false – no marker, Claude Code is not in use
  path( $r->{home}, '.claude.json' )->spew_raw("{}\n") if $marker;    # Claude Code is in use (spec §14.1)
  if ( defined $ENV{CLAUDE_CONFIG_DIR} ) {    # Claude Code keeps its .claude.json inside a custom config dir
    path( $ENV{CLAUDE_CONFIG_DIR} )->mkpath;
    path( $ENV{CLAUDE_CONFIG_DIR}, '.claude.json' )->spew_raw("{}\n") if $marker;
  }
  copy_input( "$case_dir/home", $r->{home}, $r );
  if ( $r->{project} ) {
    path( $r->{project} )->mkpath;
    copy_input( "$case_dir/project", $r->{project}, $r );
  }
  path( $r->{cwd} )->mkpath;
  my $git_init = $c->{gitInit} // [];
  for my $where (@$git_init) {
    my $dir = $where eq 'home' ? $r->{home} : $where eq 'project' ? $r->{project} : undef;
    return fail("gitInit names $where, which this case does not have") unless defined $dir;
    git_ok( $dir, 'init', '-q', '-b', 'main' );
  }
  my $sk = Skilletor::Engine->new(
    home             => $r->{home},
    ( $r->{project} ? ( project_dir => $r->{project} ) : () ),
    state_root       => "$r->{home}/.claude/skilletor",
    codex_home       => "$r->{home}/.codex",
    require_harness  => 1,              # the reference's resolve: a machine without a harness is an error
    # Neither dir lies in a work tree, git tracks none of their files – unless gitInit made one:
    # then git answers, as for the CLI.
    ( @$git_init ? () : ( is_git_work_tree => sub { 0 }, git_tracked => sub { [] } ) ),
    host             => { name => 'conformance', os => 'linux' },    # for templates (README: environment)
    user             => { name => 'conformance', home => $r->{home} },
  );

  for my $step ( @{ $c->{steps} } ) {
    my $id = $step->{id};
    my $variant = ( $engine->{steps} // {} )->{$id} // {};
    if ( defined $variant->{skip} ) {
      pass( "step $id skipped: $variant->{skip}" );
      next;
    }
    my $expected = defined $variant->{expected} ? "$case_dir/$variant->{expected}" : "$case_dir/expected/$id";
    my $config_dir = $ENV{CLAUDE_CONFIG_DIR};
    if ( $step->{op} eq 'cli' ) {
      my $env = cli_env( $c, $step, $r );
      $config_dir = $env->{CLAUDE_CONFIG_DIR};
      my $got = run_cli( \@CLI, $step, $r, $env );
      if ( defined $got->{failed} ) {
        fail("step $id: $got->{failed}");
        next;
      }
      my $want = js_parse( read_text("$expected.json") );
      ok( $want->{exit} == 0, "step $id: a hook step expects exit 0" ) if ( $step->{argv}[0] // '' ) eq 'hook';
      is( js_stringify( canonical( { exit => $got->{exit} } ), 2 ), js_stringify( canonical($want), 2 ), "step $id: the exit code" )
        or diag( "stderr: $got->{stderr}" );
      for my $stream (qw( stdout stderr )) {
        is( abstract_bytes( $got->{$stream}, $r, $step->{version} ), read_stream("$expected.$stream"), "step $id: $stream" );
      }
    }
    else {
      my %opts = ( scope => $step->{scope} // 'all' );
      my $result =
          $step->{op} eq 'resolve' ? resolve_view( $sk->resolve(%opts) )
        : $step->{op} eq 'sync'    ? $sk->sync( %opts, force => $step->{force} ? 1 : 0 )
        : $step->{op} eq 'check'   ? $sk->check(%opts)
        : $step->{op} eq 'status'  ? $sk->status(%opts)
        :                            die "unknown op $step->{op}";
      my $actual = canonical( js_parse( abstract( js_stringify($result), $r ) ) );
      my $want   = canonical( js_parse( read_text("$expected.json") ) );
      is( js_stringify( $actual, 2 ), js_stringify( $want, 2 ), "step $id" );
    }
    next unless $step->{tree};
    my $have  = snapshot( $r, home_skip( $r, $config_dir ), $git_init );
    my %want  = map { ( $_ => read_text("$expected/$_") ) } walk($expected);
    is_deeply( [ sort keys %$have ], [ sort keys %want ], "step $id: the files in the tree" );
    is( $have->{$_}, $want{$_}, "step $id: $_" ) for sort keys %want;
    my @execs = grep {
      my ( $where, $rel ) = unescape_name($_) =~ m{\A(home|project|cwd)/(.*)\z}s;
      ( ( stat( $r->{$where}.'/'.$rel ) )[2] // 0 ) & 0100;
    } sort keys %$have;
    my $want_execs = -f "$expected.executables.json" ? js_parse( read_text("$expected.executables.json") ) : [];
    is_deeply( \@execs, [@$want_execs], "step $id: the files with the executable bit" );
  }
}

my @cases = sort grep { -f "$ROOT/$_/case.json" } map { $_->basename } $ROOT->children;
ok( scalar @cases, 'the cases directory holds cases' );
for my $name (@cases) {
  subtest "conformance: $name" => sub { run_case($name) };
}

# The harness itself (README: cli), on a stand-in CLI that reports what it got. Asserts: the
# child's environment is exactly the fixed variables, the case's and the step's (a variable of the
# runner – CLAUDE_PROJECT_DIR here – never leaks in, null unsets); argv, cwd and stdin take the
# input placeholders; stdin is a string's bytes or a value's JSON, through a pipe.
subtest "a cli step's CLI gets the README's environment, argv, cwd and stdin – nothing else" => sub {
  my $tempdir = tempdir( 'skilletor-conformance-XXXXXX', TMPDIR => 1 );
  my $tmp = Cwd::realpath("$tempdir");
  my $r = { tmp => $tmp, home => "$tmp/home", cwd => "$tmp/cwd" };
  path($_)->mkpath for $r->{home}, $r->{cwd};
  my @echo = ( $^X, '-MCwd', '-e', 'local $/; my $in = <STDIN>; print join "\0", Cwd::getcwd(), -p STDIN ? "pipe" : "no pipe", $in, @ARGV, map { "$_=$ENV{$_}" } sort keys %ENV' );
  my $c = { env => { CLAUDE_CONFIG_DIR => '${HOME}/cfg', DROPPED => 'x' } };
  my $step = { id => 'echo', op => 'cli', argv => [ 'status', '${HOME}' ], env => { DROPPED => undef, EXTRA => '${TMP}/e' }, stdin => js_ordered( cwd => '${HOME}', n => [1] ) };
  local $ENV{CLAUDE_PROJECT_DIR} = $tmp;
  my $got = run_cli( \@echo, $step, $r, cli_env( $c, $step, $r ) );
  my %env = (
    PATH => $ENV{PATH} // '', HOME => $r->{home}, CODEX_HOME => "$r->{home}/.codex", GIT_CONFIG_GLOBAL => "$tmp/gitconfig",
    GIT_CONFIG_NOSYSTEM => '1', LC_ALL => 'C', CLAUDE_CONFIG_DIR => "$r->{home}/cfg", EXTRA => "$tmp/e",
    ( defined $ENV{PERL5LIB} ? ( PERL5LIB => $ENV{PERL5LIB} ) : () ),
  );
  is_deeply(
    [ split /\0/, $got->{stdout}, -1 ],
    [ $r->{cwd}, 'pipe', '{"cwd":"'.$r->{home}.'","n":[1]}', 'status', $r->{home}, map { "$_=$env{$_}" } sort keys %env ],
    'cwd, stdin as JSON through a pipe, argv, the environment'
  );
  my $raw = { %$step, stdin => 'not json ${TMP}', cwd => '${HOME}' };
  my @got = split /\0/, run_cli( \@echo, $raw, $r, cli_env( $c, $raw, $r ) )->{stdout}, -1;
  is_deeply( [ @got[ 0 .. 2 ] ], [ $r->{home}, 'pipe', "not json $tmp" ], 'a string is stdin as it is; a step cwd' );
};

subtest 'a cli step fails when its CLI dies of a signal or outlives its timeout' => sub {
  my $dir = File::Spec->tmpdir;
  my $r = { tmp => $dir, home => $dir, cwd => $dir };
  my $step = { id => 'dies', op => 'cli', argv => [] };
  my %env = ( PATH => $ENV{PATH} // '' );
  like( run_cli( [ $^X, '-e', 'kill KILL => $$' ], $step, $r, \%env )->{failed}, qr/killed by signal 9/, 'a signal' );
  like( run_cli( [ $^X, '-e', 'sleep 10' ], $step, $r, \%env, 300 )->{failed}, qr/outlived its timeout/, 'the timeout' );
};

done_testing;
