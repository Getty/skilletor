// Local source backend (spec §4.4): read a directory directly, no fetch or
// cache. `version` is always "local" and `check` always reports changed, so
// the caller re-renders every run. A missing directory is not an error here —
// `exists()` lets the caller fall back to the source's git/url definition.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Source, SourceLocation } from "./types.ts";

/** Expand a leading `~` / `~/` against `home`; other paths pass through. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export class LocalSource implements Source {
  readonly dir: string;

  constructor(localPath: string, home: string) {
    this.dir = expandHome(localPath, home);
  }

  exists(): boolean {
    try {
      return statSync(this.dir).isDirectory();
    } catch {
      return false;
    }
  }

  async resolve(): Promise<SourceLocation> {
    if (!existsSync(this.dir)) {
      throw new Error(`local source directory does not exist: ${this.dir}`);
    }
    return { dir: this.dir, version: "local" };
  }

  async check(_cachedVersion?: string): Promise<boolean> {
    // Local sources are always re-rendered.
    return true;
  }
}
