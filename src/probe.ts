// Real probe for generic hosts during `skilletor add` (spec §4.2): try
// `git ls-remote`, then a HEAD on <url>.tar.gz. Both run synchronously (the
// Probe interface is sync); the HEAD is done in a short-lived child node so we
// can await fetch without making resolveSpec async.
import { execFileSync } from "node:child_process";
import type { Probe } from "./spec.ts";

export function makeProbe(timeoutMs = 5_000): Probe {
  return (baseUrl) => {
    try {
      execFileSync("git", ["ls-remote", baseUrl], {
        stdio: "ignore",
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { git: true };
    } catch {
      // fall through to the tarball probe
    }
    if (headOk(`${baseUrl}.tar.gz`, timeoutMs)) return { tarball: true };
    return {};
  };
}

function headOk(url: string, timeoutMs: number): boolean {
  const script =
    `const c=new AbortController();const t=setTimeout(()=>c.abort(),${timeoutMs});` +
    `fetch(${JSON.stringify(url)},{method:'HEAD',signal:c.signal})` +
    `.then(r=>{clearTimeout(t);process.exit(r.ok?0:1)}).catch(()=>process.exit(1));`;
  try {
    execFileSync(process.execPath, ["-e", script], { stdio: "ignore", timeout: timeoutMs + 1_000 });
    return true;
  } catch {
    return false;
  }
}
