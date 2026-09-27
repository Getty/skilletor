// Loaded by `npm test` (`--import`) into the test runner and every test file, before any test
// code (k93). `npm test` run from a git hook or `git rebase -x` inherits git's repository-local
// variables – GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … – naming that repository, and a fixture's
// `git init`, `add` and `commit` in its temp dir then act on it: the developer's checkout. Deleting
// the list gitEnv() drops (src/gitenv.ts), once, gives every fixture git, every spawned CLI and the
// code under test the environment of a shell outside any repository. A test that exports one on
// purpose sets it around the call under test and restores it (test/gitenv.test.ts). A test file
// run by hand gets this with `node --test --import ./test/setup.ts test/<file>.test.ts`.
import { REPO_LOCAL_VARS } from "../src/gitenv.ts";

for (const name of REPO_LOCAL_VARS) delete process.env[name];

// k123: the same for the project a spawned `skilletor hook` takes from its environment. A suite
// run from a Claude Code hook inherits CLAUDE_PROJECT_DIR naming that project – the developer's
// checkout, whose .claude/skilletor.json is real – and every hook a test spawns would sync it.
// A test that needs one sets it in the env it spawns with (test/e2e.test.ts).
for (const name of ["CLAUDE_PROJECT_DIR", "SKILLETOR_PROJECT_DIR"]) delete process.env[name];
