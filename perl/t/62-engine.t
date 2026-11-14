#!/usr/bin/env perl
# What the shared cases cannot show: templates in a sync – the render context, a template error,
# an empty render, an executable template; the port's own rules – a scope of Hermes, or one the
# reference left Hermes entries in, is refused before anything is written – a sync that fails
# midway (partial entries, records cleared), the facade, and the report text. The Codex target:
# t/72-engine-codex.t.
use strict;
use warnings;
use utf8;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/lib";
use SkilletorTest qw( write_json );

use Path::Tiny qw( path tempdir );
use Skilletor;
use Skilletor::Apply qw( apply );
use Skilletor::Engine;
use Skilletor::FSUtil qw( encode_text hash_bytes );
use Skilletor::JSON qw( js_parse );
use Skilletor::Lock qw( read_lock );
use Skilletor::Report qw( check_text display_safe exit_code report_text status_text );
use Skilletor::State;

sub files {
  my ( $root, %files ) = @_;
  for my $rel ( keys %files ) {
    my $p = path( $root, $rel );
    $p->parent->mkpath;
    $p->spew_raw( encode_text( $files{$rel} ) );
  }
  return "$root";
}

sub skill { "---\ndescription: $_[0]\n---\nbody of $_[0]\n" }

# A temp home with Claude Code in use, and a local source.
sub machine {
  my ( %src ) = @_;
  my $root = tempdir->realpath;
  my $m = { root => $root, home => "$root/home", project => "$root/project" };
  path( $m->{home}, '.claude' )->mkpath;
  path( $m->{home}, '.claude.json' )->spew_raw("{}\n");
  path( $m->{project}, '.claude' )->mkpath;
  $m->{src} = files( "$root/src", %src );
  $m->{engine} = sub {
    Skilletor::Engine->new( home => $m->{home}, project_dir => $m->{project}, codex_home => "$m->{home}/.codex",
      is_git_work_tree => sub { 0 }, git_tracked => sub { [] }, @_ );
  };
  return $m;
}

sub state_json {
  my ( $m, $name ) = @_;
  my $f = "$m->{home}/.claude/skilletor/$name";
  return -f $f ? js_parse( path($f)->slurp_utf8 ) : {};
}

subtest 'a template renders with the reference context; the scope records are complete' => sub {
  my $m = machine(
    'skills/greet/SKILL.md.njk' => "---\ndescription: greets\n---\nhello {{ vars.who }} from {{ item.source }}: {{ item.type }} {{ item.name }}, "
      ."{{ scope }}/{{ harness }} into {{ target.dir }}, {{ user.name }} at {{ user.home }} on {{ host.name }} ({{ host.os }}), "
      ."{{ project is defined }}{% include \"snippets/sig.md\" %}\n",
    'snippets/sig.md'      => ' – {{ vars.sig }}',
    'skills/plain/SKILL.md' => skill('plain {{ not rendered }}'),
    'skilletor.json'       => '{"vars": {"who": "source", "sig": "the source"}}',
  );
  write_json( "$m->{home}/.claude/skilletor.json",
    { sources => { s => { local => $m->{src} } }, install => { skills => [ 'greet@s', 'plain@s' ] }, vars => { who => 'me' } } );
  my $e = $m->{engine}->( host => { name => 'box', os => 'linux' }, user => { name => 'getty', home => $m->{home} } );
  my $s = $e->sync( scope => 'user' )->{scopes}[0];
  is_deeply( [ map { $_->{key} } @{ $s->{added} } ], [ 'skills/greet', 'skills/plain' ], 'both installed' );
  is_deeply( $s->{warnings}, [], 'no warning' );
  is( path( $m->{home}, '.claude', 'skills', 'greet', 'SKILL.md' )->slurp_utf8,
    "---\ndescription: greets\n---\nhello me from s: skill greet, user/claude into $m->{home}/.claude, getty at $m->{home} on box (linux), "
      ."false – the source\n", 'rendered: vars, item, scope, harness, target, user, host, no project, an include' );
  ok( !-e "$m->{home}/.claude/skills/greet/SKILL.md.njk", 'installed without .njk' );
  is( path( $m->{home}, '.claude', 'skills', 'plain', 'SKILL.md' )->slurp_utf8, skill('plain {{ not rendered }}'), 'a plain file is copied as is' );

  my $lock_path = "$m->{home}/.claude/skilletor.lock.json";
  ok( exists state_json( $m, 'render-inputs.json' )->{$lock_path}, 'what it rendered with is recorded' );
  ok( exists state_json( $m, 'sources-read.json' )->{$lock_path}{s}, 'and what it read of the source' );
  my $check = $e->check( scope => 'user' );
  ok( !exists $check->{varsChanged}, 'check: the render inputs hold' ) or diag explain $check;
  write_json( "$m->{home}/.claude/skilletor.json",
    { sources => { s => { local => $m->{src} } }, install => { skills => [ 'greet@s', 'plain@s' ] }, vars => { who => 'you' } } );
  is_deeply( $e->check( scope => 'user' )->{varsChanged}, ['user'], 'until a var changes' );
  is_deeply( [ map { $_->{key} } @{ $e->sync( scope => 'user' )->{scopes}[0]{updated} } ], ['skills/greet'], 'which the next sync renders' );
  like( path( $m->{home}, '.claude', 'skills', 'greet', 'SKILL.md' )->slurp_utf8, qr/hello you /, 'with the new value' );

  my $p = $m->{engine}->( host => { name => 'box', os => 'linux' }, user => { name => 'getty', home => $m->{home} },
    git_remote => sub { 'https://example.invalid/app.git' } );
  write_json( "$m->{project}/.claude/skilletor.json", { install => { agents => ['who@s'] } } );
  files( $m->{src}, 'agents/who.md.njk' => "---\nname: who\n---\n{{ project.name }} {{ project.dir }} {{ project.git_remote }} {{ scope }} {{ target.dir }}\n" );
  my $ps = $p->sync( scope => 'project' )->{scopes}[0];
  is_deeply( [ map { $_->{key} } @{ $ps->{added} } ], ['agents/who'], 'a project agent' );
  is( path( $m->{project}, '.claude', 'agents', '.local.who.md' )->slurp_utf8,
    "---\nname: who\n---\nproject $m->{project} https://example.invalid/app.git project $m->{project}/.claude\n", 'sees the project' );
};

subtest 'a template error leaves the installed copy; the source still counts as read' => sub {
  my $m = machine( 'skills/greet/SKILL.md.njk' => skill('hello {{ vars.who }}') );
  write_json( "$m->{home}/.claude/skilletor.json",
    { sources => { s => { local => $m->{src} } }, install => { skills => ['greet@s'] }, vars => { who => 'me' } } );
  my $e = $m->{engine}->();
  $e->sync( scope => 'user' );
  my $lock_path = "$m->{home}/.claude/skilletor.lock.json";
  my $before    = path($lock_path)->slurp_raw;
  files( $m->{src}, 'skills/greet/SKILL.md.njk' => skill('hello {{ vars.typo }}') );
  my $s = $e->sync( scope => 'user' )->{scopes}[0];
  is_deeply( $s->{warnings}, [ "template error in skill greet: skills/greet/SKILL.md.njk: ($m->{src}/skills/greet/SKILL.md.njk) "
      ."[Line 2, Column 20]\n  attempted to output null or undefined value" ], 'the warning, the reference\'s words' );
  is_deeply( [ map { @{ $s->{$_} } } qw( added updated removed ) ], [], 'nothing changed' );
  is( path( $m->{home}, '.claude', 'skills', 'greet', 'SKILL.md' )->slurp_utf8, skill('hello me'), 'the installed copy stays' );
  is( path($lock_path)->slurp_raw, $before, 'and its lock entry' );
  ok( exists state_json( $m, 'sources-read.json' )->{$lock_path}{s}, 'the source counts as read' );
  ok( !exists $e->check( scope => 'user' )->{varsChanged}, 'check does not ask again for what a sync could not do' );

  files( $m->{src}, 'skills/greet/SKILL.md.njk' => skill('{% include "../../outside.md" %}') );
  like( $e->sync( scope => 'user' )->{scopes}[0]{warnings}[0],
    qr/\Atemplate error in skill greet: skills\/greet\/SKILL\.md\.njk: \(\Q$m->{src}\E\/skills\/greet\/SKILL\.md\.njk\)\n  RenderError: template escapes source root: \.\.\/\.\.\/outside\.md\z/,
    'an include leaving the source root' );
};

subtest 'renders empty: skipped, what it installed removed' => sub {
  my $m = machine( 'rules/k8s.md.njk' => "---\ndescription: K\n---\n{% if vars.kubernetes %}Use kubectl.{% endif %}\n" );
  my $config = sub {
    write_json( "$m->{home}/.claude/skilletor.json",
      { sources => { s => { local => $m->{src} } }, install => { rules => ['k8s@s'] }, vars => { kubernetes => $_[0] } } );
  };
  my $e = $m->{engine}->();
  $config->( JSON::MaybeXS::true() );
  is_deeply( [ map { $_->{key} } @{ $e->sync( scope => 'user' )->{scopes}[0]{added} } ], ['rules/k8s'], 'gated on: installed' );
  ok( -f "$m->{home}/.claude/rules/.local.k8s.md", 'as its .local. file' );
  $config->( JSON::MaybeXS::false() );
  my $s = $e->sync( scope => 'user' )->{scopes}[0];
  is_deeply( [ map { $_->{key} } @{ $s->{skipped} } ], ['rules/k8s'], 'gated off: skipped' );
  is_deeply( [ map { $_->{key} } @{ $s->{removed} } ], ['rules/k8s'], 'what it installed removed' );
  ok( !-e "$m->{home}/.claude/rules/.local.k8s.md", 'the file is gone' );
  my $entry = read_lock("$m->{home}/.claude/skilletor.lock.json")->{'rules/k8s'};
  is( $entry->{skipped}, 'renders-empty', 'the lock says why' );
  is_deeply( { %{ $entry->{files} } }, {}, 'and owns no file' );
  is( $e->status( scope => 'user' )->{scopes}[0]{declared}[0]{skipped}, 'renders-empty', 'status: skipped' );
};

subtest 'an executable template passes its bit to what it renders' => sub {
  my $m = machine( 'skills/tool/SKILL.md.njk' => skill('tool'), 'skills/tool/run.sh.njk' => "#!/bin/sh\necho {{ item.name }}\n" );
  chmod 0755, "$m->{src}/skills/tool/run.sh.njk";
  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => ['tool@s'] } } );
  $m->{engine}->()->sync( scope => 'user' );
  my $run = "$m->{home}/.claude/skills/tool/run.sh";
  is( path($run)->slurp_utf8, "#!/bin/sh\necho tool\n", 'rendered' );
  ok( ( ( stat $run )[2] & 0100 ), 'and executable' );
  ok( !( ( stat "$m->{home}/.claude/skills/tool/SKILL.md" )[2] & 0100 ), 'the main file is not' );
};

subtest 'Hermes: refused before anything is written' => sub {
  my $m = machine( 'skills/a/SKILL.md' => skill('a') );
  write_json( "$m->{home}/.claude/skilletor.json",
    { sources => { s => { local => $m->{src} } }, install => { skills => ['a@s'] }, targets => [ 'claude', 'codex', 'hermes' ] } );
  my $e = $m->{engine}->();
  my $want = 'the user scope targets hermes; the Perl port of skilletor installs for Claude Code and Codex only (leave "hermes" out of "targets" in ~/.claude/skilletor.json, or use the skilletor CLI)';
  is_deeply( $e->sync, { scopes => [], error => $want }, 'sync: an error' );
  ok( !-e "$m->{home}/.claude/skills", 'nothing installed' );
  ok( !-e "$m->{home}/.agents", 'nothing for Codex either' );
  ok( !-e "$m->{home}/.hermes", 'nor for Hermes' );
  is( $e->check->{error}, $want, 'check refuses too' );
  is( $e->status->{error}, $want, 'and status' );

  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => ['a@s'] }, targets => ['claude'] } );
  write_json( "$m->{project}/.claude/skilletor.json", { targets => ['codex'] } );
  my $r = $e->sync;
  is( $r->{error}, undef, 'a project narrowed to a harness not in use is no error' );
  like( $r->{scopes}[1]{warnings}[0], qr/\Aproject targets \(codex\) are not in use on this machine/, 'the reference\'s warning' );
};

subtest 'Hermes entries the reference left: refused, untouched' => sub {
  my $m = machine( 'skills/a/SKILL.md' => skill('a') );
  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => ['a@s'] } } );
  files( "$m->{home}/.hermes", 'skills/a/SKILL.md' => skill('a') );
  write_json( "$m->{home}/.claude/skilletor.lock.json",
    { 'hermes:skills/a' => { source => 's', version => 'local', files => { 'skills/a/SKILL.md' => hash_bytes( encode_text( skill('a') ) ) } } } );
  my $r = $m->{engine}->()->sync;
  is( $r->{error}, "$m->{home}/.claude/skilletor.lock.json holds items of another harness (hermes:skills/a); the Perl port of skilletor "
      .'installs for Claude Code and Codex only and leaves them to the skilletor CLI (run skilletor sync)', 'a lock with Hermes entries' );
  ok( -e "$m->{home}/.hermes/skills/a/SKILL.md", 'the Hermes copy stays' );
  ok( !-e "$m->{home}/.claude/skills/a", 'and nothing was installed' );
  my $status = $m->{engine}->()->status( scope => 'user' );
  is_deeply( $status->{scopes}[0]{orphans}, ['hermes:skills/a'], 'status reads it: an entry of an inactive target' );
  ok( $m->{engine}->()->check( scope => 'user' )->{targetsChanged}, 'check: target drift, as the reference says' );

  path( $m->{home}, '.claude', 'skilletor.lock.json' )->remove;
  write_json( "$m->{home}/.claude/skilletor.lock.json", { 'future:skills/x' => { source => 's', version => 'local', files => {} } } );
  my $ok = $m->{engine}->()->sync( scope => 'user' );
  is( $ok->{error}, undef, 'an entry of an unknown harness is no refusal' );
  ok( exists read_lock("$m->{home}/.claude/skilletor.lock.json")->{'future:skills/x'}, 'it is kept untouched' );
};

subtest 'no agent harness: the reference\'s error, nothing touched' => sub {
  my $m = machine( 'skills/a/SKILL.md' => skill('a') );
  path( $m->{home}, '.claude.json' )->remove;
  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => ['a@s'] } } );
  like( $m->{engine}->()->sync->{error}, qr/\Ano agent harness detected \(looked for claude: /, 'sync' );
  ok( !-e "$m->{home}/.claude/skills", 'nothing installed' );
};

subtest 'apply: a run that throws leaves a lock owning what landed, marked partial' => sub {
  my $dir = tempdir->realpath;
  my $item = sub { { key => "skills/$_[0]", type => 'skill', name => $_[0], source => 's', version => 'v', output => [ [ "skills/$_[0]/SKILL.md", "x\n" ] ] } };
  my $err;
  eval { apply( [ $item->('good'), $item->('bad name') ], target_dir => "$dir" ); 1 } or $err = $@;
  isa_ok( $err, 'Skilletor::Error::Apply' );
  is( $err->message, 'invalid item name: bad name', 'the reference\'s message' );
  my $lock = read_lock("$dir/skilletor.lock.json");
  is_deeply( [ keys %$lock ], ['skills/good'], 'the lock owns the item that landed' );
  ok( $lock->{'skills/good'}{partial}, 'marked partial' );
};

SKIP: {
  skip 'root writes into a read-only directory', 1 unless $> != 0;
  subtest 'sync: a write that fails midway' => sub {
    my $m = machine( 'skills/a/SKILL.md' => skill('a'), 'skills/b/SKILL.md' => skill('b') );
    write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => [ 'a@s', 'b@s' ] } } );
    my $blocked = path( $m->{home}, '.claude', 'skills', 'b' );
    $blocked->mkpath;
    chmod 0555, "$blocked";
    my $lock_path = "$m->{home}/.claude/skilletor.lock.json";
    my $state = Skilletor::State->new( root => "$m->{home}/.claude/skilletor" );
    $state->put_render_inputs( $lock_path, 'sha256:earlier' );
    my $err;
    eval { $m->{engine}->()->sync( scope => 'user' ); 1 } or $err = $@;
    ok( $err, 'the sync throws' ) or return;
    my $lock = read_lock($lock_path);
    ok( $lock->{'skills/a'}{partial}, 'what landed is owned, partial' );
    ok( !$lock->{'skills/b'}, 'what did not land is not' );
    is( $state->render_inputs($lock_path), undef, 'the scope\'s records are cleared' );
    my $check = $m->{engine}->()->check( scope => 'user' );
    is_deeply( $check->{declaredChanged}, ['user'], 'check asks for the retry' );
    ok( $m->{engine}->()->status( scope => 'user' )->{scopes}[0]{declared}[0]{partial}, 'status: partial' );
    chmod 0755, "$blocked";
    my $r = $m->{engine}->()->sync( scope => 'user' );
    is_deeply( [ map { $_->{key} } @{ $r->{scopes}[0]{updated} } ], ['skills/a'], 'the retry completes the partial item (updated)' );
    is_deeply( [ map { $_->{key} } @{ $r->{scopes}[0]{added} } ], ['skills/b'], 'and installs the other' );
    ok( !read_lock($lock_path)->{'skills/a'}{partial}, 'the marker goes' );
  };
}

subtest 'the facade: sync, check, status, and the lookups after a sync' => sub {
  my $m = machine( 'skills/a/SKILL.md' => skill('a'), 'agents/r.md' => skill('r') );
  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => ['a@s'] } } );
  my $sk = Skilletor->new( home => $m->{home}, codex_home => "$m->{home}/.codex", is_git_work_tree => sub { 0 } );
  is( $sk->resolve_agent('r'), undef, 'not declared yet' );
  my $r = $sk->sync;
  is( exit_code( sync => $r ), 0, 'exit 0' );
  is( report_text($r), "skilletor: user scope\n  + skills/a (active now)", 'the CLI\'s text' );
  write_json( "$m->{home}/.claude/skilletor.json", { sources => { s => { local => $m->{src} } }, install => { skills => ['a@s'], agents => ['r@s'] } } );
  is( exit_code( check => $sk->check ), 1, 'check: a sync is due (exit 1)' );
  is( check_text( $sk->check ), 'changed', 'check text' );
  $r = $sk->sync;
  is( report_text($r), "skilletor: user scope\n  + agents/r (active after /reload-plugins or restart)", 'an agent\'s hint' );
  is( $sk->resolve_agent('r'), "$m->{src}/agents/r.md", 'a sync drops the resolution the lookups answer from' );
  is( report_text( $sk->sync ), '', 'nothing to say: empty (the CLI prints "up to date")' );
  is( status_text( $sk->status ), "user scope:\n  ✓ skills/a \@s\n  ✓ agents/r \@s", 'the status text' );
  my $bad = Skilletor->new( home => "$m->{root}/nowhere" );
  is( exit_code( status => $bad->status ), 2, 'an error: exit 2' );
};

subtest 'display_safe' => sub {
  my $want = join '', 'a', "\\", 'nb', "\t", 'c', "\\", 'u001b[31m', "\\", 'u202ed', "\x{200d}";
  is( display_safe("a\nb\tc\x{1b}[31m\x{202e}d\x{200d}"), $want, 'controls and bidi escaped; tab and ZWJ stay' );
};

done_testing;
