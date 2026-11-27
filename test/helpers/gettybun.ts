// The getty-bun starter (bootstrap/getty-bun.sh) in tests, offline (k281): a GETTY_HOME of the
// test's own whose slot for the pinned Bun is already "installed" – bin/bun a link to the Bun
// running the suite, receipt.json with the three lines the starter's fast path reads – so `run`
// starts that Bun and never downloads. GETTY_BUN_MIRROR points nowhere: a missing slot fails
// with the starter's line instead of fetching from the network. POSIX only.
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../..", import.meta.url));
export const STARTER = join(repo, "bootstrap", "getty-bun.sh");

/** Env for a starter run against `gettyHome`: never the machine's ~/.getty, never the network. */
export function gettyEnv(gettyHome: string): NodeJS.ProcessEnv {
  return { GETTY_HOME: gettyHome, GETTY_BUN_MIRROR: "file:///nonexistent-getty-bun-mirror" };
}

/** Make the pinned slot under `gettyHome` ready with the suite's own Bun; returns the env. */
export function readySlot(gettyHome: string): NodeJS.ProcessEnv {
  const env = gettyEnv(gettyHome);
  const status = JSON.parse(execFileSync("sh", [STARTER, "status"], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  })) as { pin: string; target: string; slot: string; state: string };
  if (status.state !== "ready") {
    mkdirSync(join(status.slot, "bin"), { recursive: true });
    symlinkSync(process.execPath, join(status.slot, "bin", "bun"));
    writeFileSync(join(status.slot, "receipt.json"),
      `{\n  "version": "${status.pin}",\n  "target": "${status.target}",\n  "contractVersion": 1\n}\n`);
  }
  return env;
}
