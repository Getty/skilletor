package Skilletor::GitEnv;
# ABSTRACT: The environment of every git run – without git's repository-local variables

use strict;
use warnings;

use Exporter qw( import );

our $VERSION = '0.001';

our @EXPORT_OK = qw( git_env REPO_LOCAL_VARS );

# `git rev-parse --local-env-vars` of git 2.47.3, minus GIT_CONFIG_PARAMETERS and
# GIT_CONFIG_COUNT: the command-line config is the user's own and git keeps it for a submodule.
use constant REPO_LOCAL_VARS => qw(
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_OBJECT_DIRECTORY GIT_DIR GIT_WORK_TREE
  GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS
  GIT_REPLACE_REF_BASE GIT_PREFIX GIT_SHALLOW_FILE GIT_COMMON_DIR
);

sub git_env {
  my ( %extra ) = @_;
  my %env = %ENV;
  delete @env{ +REPO_LOCAL_VARS };
  return { %env, GIT_TERMINAL_PROMPT => '0', %extra };
}

1;

=synopsis

  use Skilletor::GitEnv qw( git_env );

  my $env = git_env( GIT_CEILING_DIRECTORIES => '/path/to/cache' );

=description

The reference's C<gitenv.ts> (k91). With C<GIT_DIR>, C<GIT_WORK_TREE> or
C<GIT_INDEX_FILE> exported – skilletor run from a git hook, C<git rebase -x> – a
fetch and C<reset --hard> meant for a cache would act on that repository.
Skilletor never means one, so every git it runs gets the process environment
without them, with C<GIT_TERMINAL_PROMPT=0> (a hook never waits on a credential
prompt), then the extra variables. Everything else – C<HOME>,
C<GIT_SSH_COMMAND>, proxies, C<GIT_CONFIG_GLOBAL> – passes through.

=func git_env

  git_env(%extra);

A new hash reference; C<%ENV> is not changed.

=func REPO_LOCAL_VARS

The variables dropped.

=cut
