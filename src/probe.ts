// Real probe for generic hosts during `skilletor add` (spec §4.2): try
// `git ls-remote`, then a HEAD on <url>.tar.gz, fetched in this process (k278:
// no child runtime). Asynchronous, so `add` resolves through resolveSpecProbing.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./gitenv.ts";
import type { AsyncProbe } from "./spec.ts";

export function makeProbe(timeoutMs = 5_000): AsyncProbe {
  return async (baseUrl) => {
    try {
      execFileSync("git", ["ls-remote", "--", baseUrl], { // `--`: never an option (k85)
        stdio: "ignore",
        timeout: timeoutMs,
        env: gitEnv(), // never steered by an exported GIT_DIR's config (k91)
      });
      return { git: true };
    } catch {
      // fall through to the tarball probe
    }
    if (await headOk(`${baseUrl}.tar.gz`, timeoutMs)) return { tarball: true };
    return {};
  };
}

async function headOk(url: string, timeoutMs: number): Promise<boolean> {
  try {
    // A file: URL is a file that exists or not: Bun's fetch answers 200 for a missing one (k278).
    if (url.startsWith("file:")) return statSync(fileURLToPath(url)).isFile();
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}
