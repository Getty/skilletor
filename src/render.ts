// Build an item in memory (spec §5).
//
// `X.njk` is rendered by Nunjucks and emitted as `X`; every other file is
// copied byte for byte, so skills that use `{{ }}`/`{% %}` themselves stay
// intact. The Nunjucks environment has autoescape off (Markdown) and
// throwOnUndefined on (a typo must not silently produce an empty skill).
// Includes/imports/macros resolve against the source root via a custom loader
// that rejects any path leaving it. `render` knows nothing of the target
// filesystem — it returns paths relative to the source (with `.njk` stripped).
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import nunjucks from "nunjucks";
import type { ItemType } from "./config.ts";
import type { CatalogItem } from "./catalog.ts";

export class RenderError extends Error {
  override name = "RenderError";
}

/** Template context (spec §5). Deliberately excludes env.* and the git branch. */
export interface RenderContext {
  vars: Record<string, unknown>;
  project?: { dir: string; name: string; git_remote?: string };
  scope: "user" | "project";
  target: { dir: string };
  host: { name: string; os: string };
  user: { name: string; home: string };
  item: { name: string; type: ItemType; source: string };
}

/** A Nunjucks loader confined to `root`; includes may not escape it. */
function makeLoader(root: string): nunjucks.ILoaderAny {
  const base = resolvePath(root);
  return {
    async: false,
    getSource(name: string) {
      const path = resolvePath(base, name);
      if (path !== base && !path.startsWith(base + sep)) {
        throw new RenderError(`template escapes source root: ${name}`);
      }
      let src: string;
      try {
        src = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      return { src, path, noCache: true };
    },
  } as nunjucks.ILoaderAny;
}

function makeEnv(sourceDir: string): nunjucks.Environment {
  return new nunjucks.Environment(makeLoader(sourceDir), {
    autoescape: false,
    throwOnUndefined: true,
  });
}

/** Build one item: render `.njk` files, copy the rest verbatim. */
export function build(
  item: CatalogItem,
  sourceDir: string,
  context: RenderContext,
): Map<string, Buffer> {
  const env = makeEnv(sourceDir);
  const out = new Map<string, Buffer>();

  for (const file of item.files) {
    if (file.endsWith(".njk")) {
      let rendered: string;
      try {
        rendered = env.render(file, context as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof RenderError) throw err;
        throw new RenderError(`${file}: ${(err as Error).message}`);
      }
      out.set(file.slice(0, -".njk".length), Buffer.from(rendered, "utf8"));
    } else {
      out.set(file, readFileSync(join(sourceDir, file)));
    }
  }

  return out;
}
