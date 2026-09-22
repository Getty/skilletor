// skilletor CLI entry point: argument parsing and dispatch (spec §7).
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sync, check, status, type EngineContext } from "./engine.ts";
import { reportJson, reportText } from "./report.ts";

declare const __SKILLETOR_VERSION__: string;
const VERSION =
  typeof __SKILLETOR_VERSION__ === "string" ? __SKILLETOR_VERSION__ : "0.0.0-dev";

const USAGE = `skilletor ${VERSION}
Remote skills, agents and rules for Claude Code.

Usage:
  skilletor <command> [options]

Commands:
  sync                  Reconcile installed items with the config
  check                 Report whether any source has changed (writes nothing)
  status                Show declared vs. installed items
  add [name] <spec>     Add a source (coming soon)
  install <item>...     Install items (coming soon)
  uninstall <item>...   Remove items (coming soon)
  trust <source>        Trust a project-declared source (coming soon)

Options:
  --scope <s>           user | project | all (default: all)
  --json                Machine-readable output
  --force               Adopt foreign files on conflict
  --project-dir <dir>   Project root (default: cwd)
  -h, --help            Show this help
  -v, --version         Show the version
`;

interface Flags {
  scope: "user" | "project" | "all";
  json: boolean;
  force: boolean;
  projectDir?: string;
  rest: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { scope: "all", json: false, force: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--scope") flags.scope = args[++i] as Flags["scope"];
    else if (a.startsWith("--scope=")) flags.scope = a.slice(8) as Flags["scope"];
    else if (a === "--project-dir") flags.projectDir = args[++i];
    else if (a.startsWith("--project-dir=")) flags.projectDir = a.slice(14);
    else flags.rest.push(a);
  }
  return flags;
}

function makeContext(flags: Flags): EngineContext {
  const home = homedir();
  return {
    home,
    projectDir: flags.projectDir ?? process.cwd(),
    stateRoot: join(home, ".claude", "skilletor"),
  };
}

function statusText(report: ReturnType<typeof status>): string {
  if (report.error) return `skilletor: config error — ${report.error}`;
  const lines: string[] = [];
  for (const s of report.scopes) {
    lines.push(`${s.scope} scope:`);
    for (const d of s.declared) lines.push(`  ${d.installed ? "✓" : "·"} ${d.key} @${d.source}`);
    for (const o of s.orphans) lines.push(`  ? ${o} (in lock, not declared)`);
    for (const t of s.trustRequests) lines.push(`  trust: ${t.name} (${t.url})`);
  }
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = argv[0]!;
  const flags = parseFlags(argv.slice(1));
  if (!["user", "project", "all"].includes(flags.scope)) {
    process.stderr.write(`skilletor: invalid --scope: ${flags.scope}\n`);
    return 2;
  }
  const ctx = makeContext(flags);

  try {
    switch (cmd) {
      case "sync": {
        const r = await sync(ctx, { scope: flags.scope, force: flags.force });
        if (r.error) {
          process.stderr.write((flags.json ? reportJson(r) : reportText(r)) + "\n");
          return 2;
        }
        const text = flags.json ? reportJson(r) : reportText(r);
        process.stdout.write((text || "skilletor: up to date") + "\n");
        return 0;
      }
      case "check": {
        const r = await check(ctx, { scope: flags.scope });
        if (r.error) {
          process.stderr.write(`skilletor: ${r.error}\n`);
          return 2;
        }
        process.stdout.write(
          (flags.json ? JSON.stringify(r, null, 2) : r.changed ? "changed" : "up to date") + "\n",
        );
        return r.changed ? 1 : 0;
      }
      case "status": {
        const r = status(ctx, { scope: flags.scope });
        process.stdout.write((flags.json ? JSON.stringify(r, null, 2) : statusText(r)) + "\n");
        return r.error ? 2 : 0;
      }
      default:
        process.stderr.write(`skilletor: unknown command: ${cmd}\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`skilletor: ${(err as Error).message}\n`);
    return 1;
  }
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
