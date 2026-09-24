// skilletor CLI entry point: argument parsing and dispatch (spec §7).
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sync, check, status, type EngineContext } from "./engine.ts";
import { reportJson, reportText, type SyncReport } from "./report.ts";
import {
  cmdAdd, cmdAvailable, cmdInstall, cmdSourceList, cmdSourceRemove, cmdTrust, cmdUninstall, type Prompter,
} from "./commands.ts";
import { projectRootOf, runHook, type HookContext, type HookInput } from "./hooks.ts";

declare const __SKILLETOR_VERSION__: string;
const VERSION =
  typeof __SKILLETOR_VERSION__ === "string" ? __SKILLETOR_VERSION__ : "0.0.0-dev";

const USAGE = `skilletor ${VERSION}
Remote skills, agents and rules for Claude Code and Codex.

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
                        type:*@source installs every item of that type,
                        type:perl-*@source every one whose name matches;
                        bundle:name@source installs a bundle (a bare
                        name@source does too when no item has that name);
                        sources a bundle needs are offered for adding
                        (on a terminal; otherwise the add commands are shown)
  uninstall <item>...   Remove entries ([type:]name@source, type:*@source,
                        type:perl-*@source or bundle:name@source), then sync
  trust <source>        Trust a project-declared source

Options:
  --scope <s>           user | project | all (default: all; sync, check, status)
  --project             Edit the project config instead of the user config
                        (add, install, uninstall, source remove)
  --json                Machine-readable output
                        (sync, check, status, source list, available)
  --force               sync: adopt foreign files on conflict;
                        source remove: remove even if items are installed
  --project-dir <dir>   Project root (default: git top level of cwd, else cwd)
  -h, --help            Show this help (anywhere; nothing else runs)
  -v, --version         Show the version (first argument only)

An option the command does not accept is an error (exit 2).
`;

interface Flags {
  scope: "user" | "project" | "all";
  json: boolean;
  force: boolean;
  project: boolean;
  projectDir?: string;
  /** Every option given, by name (`--scope=user` → `--scope`), in order. */
  options: string[];
  rest: string[];
}

/** The options each command accepts (spec §7); `--project-dir` goes with every one.
 *  `hook` is absent: it is internal and must never fail (spec §8). */
const ACCEPTED: Record<string, string[]> = {
  sync: ["--scope", "--json", "--force"],
  check: ["--scope", "--json"],
  status: ["--scope", "--json"],
  add: ["--project"],
  "source list": ["--json"],
  "source remove": ["--project", "--force"],
  available: ["--json"],
  install: ["--project"],
  uninstall: ["--project"],
  trust: [],
};

/** The first option `cmd` does not accept, if any. */
function unknownOption(cmd: string, flags: Flags): string | undefined {
  if (cmd !== "source" && !Object.hasOwn(ACCEPTED, cmd)) return undefined; // unknown command: its own error
  const key = cmd === "source" ? `source ${flags.rest[0]}` : cmd;
  // `source` without list/remove keeps its own usage error; any known option is fine there.
  const accepted = (Object.hasOwn(ACCEPTED, key) ? ACCEPTED[key] : undefined) ?? (cmd === "source" ? [...ACCEPTED["source list"]!, ...ACCEPTED["source remove"]!] : []);
  return flags.options.find((o) => o !== "--project-dir" && !accepted.includes(o));
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { scope: "all", json: false, force: false, project: false, options: [], rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) flags.options.push(a.startsWith("--") ? a.replace(/=.*/s, "") : a);
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
    // Same resolution as the hooks (spec §14.5): the git top level of cwd, else cwd.
    projectDir: flags.projectDir ?? projectRootOf(process.cwd()),
    stateRoot: join(home, ".claude", "skilletor"),
  };
}

/** Questions on the terminal (stdin in, stderr out, so stdout stays clean); none without a TTY. */
function ttyPrompter(): Prompter | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return {
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(`${question} `);
      } finally {
        rl.close();
      }
    },
  };
}

function statusText(report: ReturnType<typeof status>): string {
  if (report.error) return `skilletor: config error — ${report.error}`;
  const lines: string[] = [];
  for (const s of report.scopes) {
    // Name the targets unless they are just claude (output unchanged for Claude-only users).
    const claudeOnly = s.targets.length === 1 && s.targets[0] === "claude";
    lines.push(claudeOnly ? `${s.scope} scope:` : `${s.scope} scope (${s.targets.join(", ") || "no targets"}):`);
    for (const d of s.declared) {
      const mark = d.installed ? "✓" : d.skipped ? "-" : "·";
      const note = d.skipped ? " (skipped: renders empty)" : "";
      lines.push(`  ${mark} ${d.key} @${d.source}${d.via ? ` via ${d.via}` : ""}${note}`);
    }
    for (const w of s.wildcards) {
      const pattern = w.entry.slice(0, w.entry.lastIndexOf("@")).replace(/^[a-z]+:/, "");
      lines.push(`  * ${w.type}s/${pattern} @${w.source} (${w.installed} installed)`);
    }
    for (const b of s.bundles) lines.push(`  * bundle:${b.name}@${b.source} (${b.installed} installed)`);
    for (const o of s.orphans) lines.push(`  ? ${o} (in lock, not declared)`);
    for (const t of s.trustRequests) lines.push(`  trust: ${t.name} (${t.url})`);
  }
  if (report.projectIsHome) lines.push("project scope: none (the project directory is the home directory)");
  for (const w of report.warnings ?? []) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

/** The sync report, or "up to date" when no scope has anything to say; run-level
 *  warnings (the untrusted Codex hook) come in addition, never instead. */
function syncText(r: SyncReport): string {
  const text = reportText(r);
  if (r.warnings?.length && !reportText({ ...r, warnings: undefined })) return `skilletor: up to date\n${text}`;
  return text || "skilletor: up to date";
}

export async function run(argv: string[]): Promise<number> {
  // Argument hygiene (spec §7): --version only first, --help anywhere and alone.
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    // No command has its own help yet; every --help prints the general usage.
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = argv[0]!;
  if (cmd.startsWith("-")) {
    process.stderr.write(`skilletor: unknown option: ${cmd} (run skilletor --help)\n`);
    return 2;
  }
  const flags = parseFlags(argv.slice(1));
  const unknown = cmd === "hook" ? undefined : unknownOption(cmd, flags);
  if (unknown !== undefined) {
    const name = cmd === "source" && Object.hasOwn(ACCEPTED, `source ${flags.rest[0]}`) ? `source ${flags.rest[0]}` : cmd;
    process.stderr.write(`skilletor: unknown option for ${name}: ${unknown} (run skilletor --help)\n`);
    return 2;
  }
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
        process.stdout.write((flags.json ? reportJson(r) : syncText(r)) + "\n");
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
        process.stdout.write(syncText(r.report) + "\n");
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
          const lines = items.map((i) => {
            const line = `${i.installed ? "✓" : " "} ${i.type} ${i.name}@${i.source}${i.description ? ` — ${i.description}` : ""}`;
            if (i.type !== "bundle") return line;
            // A bundle's members (spec §15.5) on the next line, or why it cannot be expanded.
            return `${line}\n    ${i.error !== undefined ? `error: ${i.error}` : i.members!.join(", ") || "(no items)"}`;
          });
          process.stdout.write(lines.join("\n") + "\n");
        }
        return 0;
      }
      case "install": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: install needs at least one item\n");
          return 2;
        }
        const r = await cmdInstall({ ...ctx, prompt: ttyPrompter() }, { items: flags.rest, project: flags.project });
        process.stdout.write(syncText(r) + "\n");
        return 0;
      }
      case "uninstall": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: uninstall needs at least one item\n");
          return 2;
        }
        const r = await cmdUninstall(ctx, { items: flags.rest, project: flags.project });
        for (const h of r.hints) process.stderr.write(`skilletor: warning: ${h}\n`);
        process.stdout.write(syncText(r.report) + "\n");
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
        return runHookCommand(flags.rest);
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

/** `skilletor hook <event> [--harness codex]`: read stdin JSON, run the hook, print JSON,
 *  always exit 0. `--harness` is internal (the Codex plugin's hooks file, spec §14.8);
 *  any other value is Claude Code's behavior. */
async function runHookCommand(args: string[]): Promise<number> {
  const event = args[0];
  const at = args.indexOf("--harness");
  const harness = at === -1 ? args.find((x) => x.startsWith("--harness="))?.slice(10) : args[at + 1];
  if (!event) return 0; // nothing to do, never disturb the session
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as HookInput;
  } catch {
    // ignore malformed hook input
  }
  const home = homedir();
  // Unset under Codex: runHook then takes the git top level of input.cwd (spec §14.5).
  const projectDir = process.env.SKILLETOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || undefined;
  const ctx: HookContext = {
    home,
    projectDir,
    stateRoot: join(home, ".claude", "skilletor"),
    binPath: fileURLToPath(import.meta.url),
  };
  if (harness === "codex") ctx.harness = "codex";
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
