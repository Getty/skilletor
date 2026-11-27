// The getty-bun starter (bootstrap/getty-bun.sh) in tests, offline (k281): a GETTY_HOME of the
// test's own whose slot for the pinned Bun is already "installed" – bin/bun a link to the Bun
// running the suite, receipt.json with the three lines the starter's fast path reads – so `run`
// starts that Bun and never downloads. GETTY_BUN_MIRROR points nowhere: a missing slot fails
// with the starter's line instead of fetching from the network. readySlotWindows is the same for
// bootstrap/getty-bun.ps1 on Windows: bin\bun.exe a copy of the suite's Bun (a link would need
// a privilege there).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../..", import.meta.url));
export const STARTER = join(repo, "bootstrap", "getty-bun.sh");
export const STARTER_PS1 = join(repo, "bootstrap", "getty-bun.ps1");
/** How the plugin's Windows lines start the PowerShell starter (hooks/codex-hooks.json, the
 *  Hermes adapter's POWERSHELL): the starter's path follows. */
export const POWERSHELL_FILE = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

/** Env for a starter run against `gettyHome`: never the machine's ~/.getty, never the network. */
export function gettyEnv(gettyHome: string): NodeJS.ProcessEnv {
  return { GETTY_HOME: gettyHome, GETTY_BUN_MIRROR: "file:///nonexistent-getty-bun-mirror" };
}

/** Make the pinned slot under `gettyHome` ready with the suite's own Bun; returns the env. */
export function readySlot(gettyHome: string): NodeJS.ProcessEnv {
  const env = gettyEnv(gettyHome);
  const status = JSON.parse(execFileSync("sh", [STARTER, "status"], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  })) as SlotStatus;
  if (status.state !== "ready") {
    mkdirSync(join(status.slot, "bin"), { recursive: true });
    symlinkSync(process.execPath, join(status.slot, "bin", "bun"));
    writeReceipt(status);
  }
  return env;
}

/** readySlot for getty-bun.ps1 (Windows only): the slot `status` names – the target its AVX2
 *  probe picks – with bin\bun.exe a copy of the suite's Bun; returns the env. */
export function readySlotWindows(gettyHome: string): NodeJS.ProcessEnv {
  const env = gettyEnv(gettyHome);
  const status = JSON.parse(execFileSync(POWERSHELL_FILE[0]!, [...POWERSHELL_FILE.slice(1), STARTER_PS1, "status"], {
    encoding: "utf8", env: { ...process.env, ...env },
  })) as SlotStatus;
  if (status.state !== "ready") {
    mkdirSync(join(status.slot, "bin"), { recursive: true });
    copyFileSync(process.execPath, join(status.slot, "bin", "bun.exe"));
    writeReceipt(status);
  }
  return env;
}

interface SlotStatus { pin: string; target: string; slot: string; state: string }

/** The receipt's first three lines, LF-separated: all either starter's fast path reads. */
function writeReceipt(status: SlotStatus): void {
  writeFileSync(join(status.slot, "receipt.json"),
    `{\n  "version": "${status.pin}",\n  "target": "${status.target}",\n  "contractVersion": 1\n}\n`);
}

/**
 * The process Codex starts for a hook line on Windows (skill getty-bun-integration, codex.md):
 * `${PLUGIN_ROOT}` replaced as text, then the line handed to the session shell – PowerShell by
 * default, `-NoProfile -Command <line>` – or, without a local turn environment, to `%COMSPEC%`
 * with `/C`. For cmd the line is the whole command string (spawn with `shell`), as cmd parses
 * its own command line rather than an argv.
 */
export function codexWindowsCommand(line: string, pluginRoot: string, shell: "powershell" | "cmd"):
  { file: string; args: string[] } | { shellLine: string } {
  const substituted = line.replaceAll("${PLUGIN_ROOT}", pluginRoot);
  return shell === "powershell" ? { file: "powershell.exe", args: ["-NoProfile", "-Command", substituted] } : { shellLine: substituted };
}
