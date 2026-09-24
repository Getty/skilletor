// Build an item in memory (spec §5).
//
// `X.njk` is rendered by Nunjucks and emitted as `X`; every other file is
// copied byte for byte, so skills that use `{{ }}`/`{% %}` themselves stay
// intact. The Nunjucks environment has autoescape off (Markdown) and
// throwOnUndefined on (a typo must not silently produce an empty skill).
// Includes/imports/macros resolve against the source root via a custom loader
// that rejects any path leaving it. `render` knows nothing of the target
// filesystem — it returns paths relative to the source (with `.njk` stripped),
// except that a skill's files always land under `skills/<name>/` (spec §4.1).
import { readFileSync } from "node:fs";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import nunjucks from "nunjucks";
import type { Harness, ItemType } from "./config.ts";
import type { CatalogItem } from "./catalog.ts";

export class RenderError extends Error {
  override name = "RenderError";
}

/** Template context (spec §5). Deliberately excludes env.* and the git branch. */
export interface RenderContext {
  vars: Record<string, unknown>;
  project?: { dir: string; name: string; git_remote?: string };
  scope: "user" | "project";
  /** The harness this copy is rendered for (spec §14.3). */
  harness: Harness;
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
      out.set(installPath(item, file.slice(0, -".njk".length)), Buffer.from(rendered, "utf8"));
    } else {
      out.set(installPath(item, file), readFileSync(join(sourceDir, file)));
    }
  }

  return out;
}

/** Where a source file of `item` installs: a skill's files go under `skills/<name>/`
 *  wherever its directory sits in the source (a Claude plugin's nested skills, spec
 *  §4.1); agents and rules keep their source path. */
function installPath(item: CatalogItem, file: string): string {
  if (item.type !== "skill" || item.dir === undefined) return file;
  return join("skills", item.name, relative(item.dir, file));
}

/** A leading YAML frontmatter block (after optional whitespace), closed by `---`. */
const FRONTMATTER = /^\s*---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * True if the item's main file is a template whose rendered output is
 * whitespace-only once a leading frontmatter block is removed (spec §5): the
 * item does not apply in this scope. A non-template main file is never empty.
 */
export function rendersEmpty(item: CatalogItem, output: Map<string, Buffer>): boolean {
  const src = item.type === "skill" ? join(item.dir ?? join("skills", item.name), "SKILL.md") : `${item.type}s/${item.name}.md`;
  if (!item.files.includes(`${src}.njk`) || item.files.includes(src)) return false;
  const text = output.get(installPath(item, src))?.toString("utf8");
  if (text === undefined) return false;
  return text.replace(FRONTMATTER, "").trim() === "";
}
