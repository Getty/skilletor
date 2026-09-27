// A git remote helper for tests (k118): `git-remote-<transport>` in `binDir`, which serves the
// local repository its address names through the helper protocol's `connect` capability and
// appends every address git hands it to `log`, one per line. With `binDir` on PATH, git fetches
// `<transport>::<path>` the way it fetches `codecommit::region://repo` through AWS's helper.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Put `dir` first on PATH, where git looks for a remote helper; returns the restore. */
export function prependPath(dir: string): () => void {
  const saved = process.env.PATH;
  process.env.PATH = saved ? `${dir}${delimiter}${saved}` : dir;
  return () => {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  };
}

export function writeRemoteHelper(binDir: string, transport: string, log: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, `git-remote-${transport}`);
  writeFileSync(script, [
    "#!/bin/sh",
    "# git-remote-<transport> <remote> <address>",
    `printf '%s\\n' "$2" >> '${log.replace(/'/g, "'\\''")}'`,
    "unset GIT_DIR",
    "while read -r cmd arg; do",
    "  case \"$cmd\" in",
    "    capabilities) printf 'connect\\n\\n' ;;",
    "    connect) printf '\\n'; exec git \"${arg#git-}\" \"$2\" ;;",
    "    *) exit 1 ;;",
    "  esac",
    "done",
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
}
