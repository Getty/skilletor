// Loaded by `npm test` (`--import`) into the test runner and every test file, before any test
// code (k93). `npm test` run from a git hook or `git rebase -x` inherits git's repository-local
// variables – GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … – naming that repository, and a fixture's
// `git init`, `add` and `commit` in its temp dir then act on it: the developer's checkout. Deleting
// the list gitEnv() drops (src/gitenv.ts), once, gives every fixture git, every spawned CLI and the
// code under test the environment of a shell outside any repository. A test that exports one on
// purpose sets it around the call under test and restores it (test/gitenv.test.ts). A test file
// run by hand gets this with `node --test --import ./test/setup.ts test/<file>.test.ts`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_LOCAL_VARS } from "../src/gitenv.ts";

for (const name of REPO_LOCAL_VARS) delete process.env[name];

// On Windows os.homedir() reads USERPROFILE and ignores HOME, so a test that sets only HOME for
// a spawned CLI still had it sync into the developer's real profile (~/.claude/skilletor.json,
// skills, agents, ~/.codex). Every test process gets a throwaway home of its own there instead;
// tests that want a specific one pass it through homeEnv() (test/helpers/harness.ts).
if (process.platform === "win32") {
  const home = mkdtempSync(join(tmpdir(), "skilletor-test-home-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
}
