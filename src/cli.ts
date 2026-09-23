// skilletor CLI entry point: argument parsing and dispatch (spec §7).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sync, check, status, type EngineContext } from "./engine.ts";
import { reportJson, reportText } from "./report.ts";
import {
  cmdAdd, cmdAvailable, cmdInstall, cmdSourceList, cmdSourceRemove, cmdTrust, cmdUninstall,
} from "./commands.ts";
import { runHook, type HookContext, type HookInput } from "./hooks.ts";

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
  add [name] <spec>     Add and trust a source, then sync
  source list           List declared sources
  source remove <name>  Remove a source, then sync
  available [source]    List items offered by trusted sources
  install <item>...     Install items ([type:]name@source), then sync;
                        type:*@source installs every item of that type
  uninstall <item>...   Remove items ([type:]name@source or type:*@source),
                        then sync
  trust <source>        Trust a project-declared source

Options:
  --scope <s>           user | project | all (default: all; sync, check, status)
  --project             Edit the project config instead of the user config
                        (add, install, uninstall, source remove)
  --json                Machine-readable output
                        (sync, check, status, source list, available)
  --force               sync: adopt foreign files on conflict;
                        source remove: remove even if items are installed
  --project-dir <dir>   Project root (default: cwd)
  -h, --help            Show this help
  -v, --version         Show the version
`;

interface Flags {
  scope: "user" | "project" | "all";
  json: boolean;
  force: boolean;
  project: boolean;
  projectDir?: string;
  rest: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { scope: "all", json: false, force: false, project: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--project") flags.project = true;
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
    for (const d of s.declared) {
      lines.push(`  ${d.installed ? "✓" : "·"} ${d.key} @${d.source}${d.via ? ` via ${d.via}` : ""}`);
    }
    for (const w of s.wildcards) lines.push(`  * ${w.type}s/* @${w.source} (${w.installed} installed)`);
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
      case "add": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: add needs a source spec\n");
          return 2;
        }
        const name = flags.rest.length >= 2 ? flags.rest[0] : undefined;
        const spec = flags.rest.length >= 2 ? flags.rest[1]! : flags.rest[0]!;
        const r = await cmdAdd(ctx, { name, spec, project: flags.project });
        process.stdout.write(`added source ${r.name} (${JSON.stringify(r.def)})\n`);
        process.stdout.write((reportText(r.report) || "skilletor: up to date") + "\n");
        return 0;
      }
      case "source": {
        const sub = flags.rest[0];
        if (sub === "list") {
          const list = cmdSourceList(ctx);
          process.stdout.write(
            (flags.json ? JSON.stringify(list, null, 2) : list.map((s) => `${s.name} [${s.origin}] ${JSON.stringify(s.def)}`).join("\n")) + "\n",
          );
          return 0;
        }
        if (sub === "remove") {
          const name = flags.rest[1];
          if (!name) {
            process.stderr.write("skilletor: source remove needs a name\n");
            return 2;
          }
          const r = await cmdSourceRemove(ctx, { name, project: flags.project, force: flags.force });
          process.stdout.write((reportText(r) || `removed source ${name}`) + "\n");
          return 0;
        }
        process.stderr.write("skilletor: usage: source list | source remove <name>\n");
        return 2;
      }
      case "available": {
        const items = await cmdAvailable(ctx, { source: flags.rest[0] });
        if (flags.json) {
          process.stdout.write(JSON.stringify(items, null, 2) + "\n");
        } else {
          process.stdout.write(
            items.map((i) => `${i.installed ? "✓" : " "} ${i.type} ${i.name}@${i.source}${i.description ? ` — ${i.description}` : ""}`).join("\n") + "\n",
          );
        }
        return 0;
      }
      case "install": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: install needs at least one item\n");
          return 2;
        }
        const r = await cmdInstall(ctx, { items: flags.rest, project: flags.project });
        process.stdout.write((reportText(r) || "skilletor: up to date") + "\n");
        return 0;
      }
      case "uninstall": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: uninstall needs at least one item\n");
          return 2;
        }
        const r = await cmdUninstall(ctx, { items: flags.rest, project: flags.project });
        process.stdout.write((reportText(r) || "skilletor: up to date") + "\n");
        return 0;
      }
      case "trust": {
        const name = flags.rest[0];
        if (!name) {
          process.stderr.write("skilletor: trust needs a source name\n");
          return 2;
        }
        const r = cmdTrust(ctx, { name });
        process.stdout.write(`trusted source ${r.name} (${r.url})\n`);
        return 0;
      }
      case "hook":
        return runHookCommand(flags.rest[0]);
      default:
        process.stderr.write(`skilletor: unknown command: ${cmd}\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`skilletor: ${(err as Error).message}\n`);
    return 1;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** `skilletor hook <event>`: read stdin JSON, run the hook, print JSON, always exit 0. */
async function runHookCommand(event: string | undefined): Promise<number> {
  if (!event) return 0; // nothing to do, never disturb the session
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as HookInput;
  } catch {
    // ignore malformed hook input
  }
  const home = homedir();
  const projectDir =
    process.env.SKILLETOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot: join(home, ".claude", "skilletor"),
    binPath: fileURLToPath(import.meta.url),
  };
  try {
    const out = await runHook(event, input, ctx);
    if (out.systemMessage || out.hookSpecificOutput) {
      process.stdout.write(JSON.stringify(out) + "\n");
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ systemMessage: `skilletor: ${(err as Error).message}` }) + "\n");
  }
  return 0;
}

/** True when this module is the executed entry point. Compares real paths so a
 *  symlinked directory (e.g. macOS /var -> /private/var) does not fool it. */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return argv1 === self;
  }
}

// Run only when executed as the entry point, not when imported by a test.
if (isEntryPoint()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`skilletor: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
