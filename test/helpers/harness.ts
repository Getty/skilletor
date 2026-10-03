// Harness fixtures (spec §14.1): tests never detect the real machine's Claude
// Code or Codex. In-process tests inject markers; spawned CLIs get a temp HOME
// with a Claude marker and a CODEX_HOME that does not exist.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessMarkers } from "../../src/targets.ts";

/** Markers under which only Claude Code is "in use" (`home` must exist). */
export function claudeOnly(home: string): HarnessMarkers {
  return { claude: [home], codex: [] };
}

/** The variables that name the home directory: HOME, and on Windows USERPROFILE, which is
 *  what os.homedir() reads there. */
export function homeEnv(home: string): NodeJS.ProcessEnv {
  return process.platform === "win32" ? { HOME: home, USERPROFILE: home } : { HOME: home };
}

/** Env for a spawned CLI whose HOME looks like a Claude-only machine. */
export function claudeOnlyEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  writeFileSync(join(home, ".claude.json"), "{}\n");
  return { ...process.env, ...homeEnv(home), CODEX_HOME: join(home, ".no-codex"), ...extra };
}
