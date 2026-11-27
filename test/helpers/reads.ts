// The state files a run reads from disk (k250): every readFileSync of a file directly in `root`,
// by name – a missing one counts too. src/state.ts calls readFileSync through node:fs's module
// object, so the mock on that object sees its reads (on Bun a named import would not).
import fs from "node:fs";
import { basename, dirname } from "node:path";
import { mock } from "node:test";

export async function readsOf(root: string, fn: () => unknown): Promise<Record<string, number>> {
  const reads: Record<string, number> = {};
  const original = fs.readFileSync;
  const spy = mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    const file = String(args[0]);
    if (dirname(file) === root) reads[basename(file)] = (reads[basename(file)] ?? 0) + 1;
    return original(...args);
  }) as typeof fs.readFileSync);
  try {
    await fn();
  } finally {
    spy.mock.restore();
  }
  return reads;
}
