// skilletor CLI entry point.
//
// Scaffold stub: only --version / --help / usage for now. The real command
// dispatch (add, source, available, install, uninstall, sync, check, status,
// trust, hook) arrives in later tickets.
import { fileURLToPath } from "node:url";

// Injected at build time by esbuild (see scripts/esbuild.config.mjs). The
// `typeof` guard keeps the source runnable un-bundled, where it is undefined.
declare const __SKILLETOR_VERSION__: string;
const VERSION =
  typeof __SKILLETOR_VERSION__ === "string" ? __SKILLETOR_VERSION__ : "0.0.0-dev";

const USAGE = `skilletor ${VERSION}
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

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`skilletor: unknown command: ${argv[0]}\n`);
  return 2;
}

// Run only when executed as the entry point, not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`skilletor: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
