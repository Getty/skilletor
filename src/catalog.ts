// Scan a source's layout into a catalog of installable items (spec §4.1).
//
//   skills/<name>/SKILL.md[.njk] + companion files
//   agents/<name>.md[.njk]
//   rules/<name>.md[.njk]
//   snippets/…            (not installable)
//   skilletor.json        (optional: { description, vars })
//
// Names come from the path; descriptions from item frontmatter (read raw for
// .njk, never rendered). Symlinks anywhere in the tree are rejected (spec §9).
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { ItemType } from "./config.ts";

export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface CatalogItem {
  type: ItemType;
  name: string;
  description?: string;
  /** Files that make up the item, relative to the source dir, sorted. */
  files: string[];
}

export interface SourceMeta {
  description?: string;
  vars?: Record<string, unknown>;
}

export interface Catalog {
  items: CatalogItem[];
  meta: SourceMeta;
}

const TYPE_DIRS: { dir: string; type: ItemType }[] = [
  { dir: "skills", type: "skill" },
  { dir: "agents", type: "agent" },
  { dir: "rules", type: "rule" },
];

/** Throw if `path` is a symlink; return its lstat otherwise. */
function noSymlink(path: string) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new CatalogError(`symlink not allowed in source: ${path}`);
  }
  return st;
}

/** All files under `dir`, relative to `sourceDir`, sorted; rejects symlinks. */
function walkFiles(dir: string, sourceDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = noSymlink(p);
    if (st.isDirectory()) out.push(...walkFiles(p, sourceDir));
    else if (st.isFile()) out.push(relative(sourceDir, p));
  }
  return out.sort();
}

/** Extract a top-level frontmatter scalar (name/description). */
function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return {};
  const close = text.indexOf("\n---", firstNl);
  if (close === -1) return {};
  const block = text.slice(firstNl + 1, close);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = unquote(m[2]!.trim());
  }
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function descriptionOf(filePath: string): string | undefined {
  return frontmatter(readFileSync(filePath, "utf8")).description;
}

/** Find `SKILL.md` or `SKILL.md.njk` in a skill directory. */
function skillFile(dir: string): string | undefined {
  for (const candidate of ["SKILL.md", "SKILL.md.njk"]) {
    const p = join(dir, candidate);
    if (existsSync(p)) {
      noSymlink(p);
      return p;
    }
  }
  return undefined;
}

/** Match `<name>.md` or `<name>.md.njk`; returns the name. */
function itemName(fileName: string): string | undefined {
  const m = /^(.+?)\.md(\.njk)?$/.exec(fileName);
  return m ? m[1] : undefined;
}

export function scan(dir: string): Catalog {
  const items: CatalogItem[] = [];

  for (const { dir: sub, type } of TYPE_DIRS) {
    const typeDir = join(dir, sub);
    if (!existsSync(typeDir)) continue;
    noSymlink(typeDir);

    for (const entry of readdirSync(typeDir)) {
      const p = join(typeDir, entry);
      const st = noSymlink(p);

      if (type === "skill") {
        if (!st.isDirectory()) continue;
        const file = skillFile(p);
        if (!file) continue;
        items.push({ type, name: entry, description: descriptionOf(file), files: walkFiles(p, dir) });
      } else {
        if (!st.isFile()) continue;
        const name = itemName(entry);
        if (name === undefined) continue;
        items.push({ type, name, description: descriptionOf(p), files: [relative(dir, p)] });
      }
    }
  }

  return { items, meta: readSourceMeta(dir) };
}

function readSourceMeta(dir: string): SourceMeta {
  const p = join(dir, "skilletor.json");
  if (!existsSync(p)) return {};
  noSymlink(p);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new CatalogError(`${p}: invalid JSON (${(err as Error).message})`);
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const meta: SourceMeta = {};
  if (typeof obj.description === "string") meta.description = obj.description;
  if (obj.vars && typeof obj.vars === "object") meta.vars = obj.vars as Record<string, unknown>;
  return meta;
}
