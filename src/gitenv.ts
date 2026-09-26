// The environment of every git skilletor runs (k91; spec §4.4, §6.4).
//
// git's repository-local variables bind a run to a repository: with GIT_DIR, GIT_WORK_TREE or
// GIT_INDEX_FILE exported – skilletor run from a git hook, `git rebase -x`, tooling – a fetch and
// `reset --hard` meant for a source's cache acted on that repository, `ls-remote` read its config,
// and `git -C <project>` answered for it with <project> as its work tree. skilletor never means
// one: each git it runs acts on the repository at its cwd or `-C` dir, found the way git finds it.
// So they are dropped – all `git rev-parse --local-env-vars` lists, except the command-line config
// (GIT_CONFIG_PARAMETERS from `git -c`, GIT_CONFIG_COUNT with its KEY_n/VALUE_n), which git itself
// keeps when it runs in another repository (a submodule): it is the user's own config, like
// `~/.gitconfig`, carries what a fetch may rely on (`http.extraHeader`, proxies, `insteadOf`),
// and cannot point git at another repository. Everything else – HOME, GIT_SSH_COMMAND,
// GIT_ASKPASS, SSH_AUTH_SOCK, proxies, GIT_CONFIG_GLOBAL – passes through.

/** `git rev-parse --local-env-vars` of git 2.47.3, minus GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT. */
export const REPO_LOCAL_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
];

/**
 * The process environment for a git run: without the repository-local variables, with
 * GIT_TERMINAL_PROMPT=0 (a hook never blocks on a credential prompt), then `extra`.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPO_LOCAL_VARS) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}
