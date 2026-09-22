// skilletor — generated bundle, do not edit. Rebuild with `npm run build`.

// src/cli.ts
import { fileURLToPath } from "node:url";
var VERSION = true ? "0.1.0" : "0.0.0-dev";
var USAGE = `skilletor ${VERSION}
Remote skills, agents and rules for Claude Code.

Usage:
  skilletor <command> [options]

Commands:
  add [name] <spec>     Add a source
  source list|remove    Manage sources
  available [source]    List installable items
  install <item>...     Install items and sync
  uninstall <item>...   Remove items and sync
  sync|check|status     Reconcile installed items
  trust <source>        Trust a project-declared source
  hook <event>          Internal: Claude Code hook entry point

Options:
  -h, --help            Show this help
  -v, --version         Show the version
`;
async function run(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`skilletor: unknown command: ${argv[0]}
`);
  return 2;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`skilletor: ${err?.stack ?? err}
`);
      process.exit(1);
    }
  );
}
export {
  run
};
