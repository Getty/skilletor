// Small filesystem helpers shared by the engine.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** sha256 of a buffer, as "sha256:<hex>". */
export function hashBuffer(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/** Write atomically: temp file in the same directory, then rename. */
export function atomicWrite(path: string, data: string | Buffer): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.skilletor-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
