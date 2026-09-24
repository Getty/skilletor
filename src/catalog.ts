// Scan a source's layout into a catalog of installable items (spec §4.1).
//
//   skills/<name>/SKILL.md[.njk] + companion files
//   agents/<name>.md[.njk]
//   rules/<name>.md[.njk]
//   snippets/…            (not installable)
//   bundles/<name>.yaml|.yml  (optional: named item sets, spec §15)
//   skilletor.json        (optional: { description, vars })
//   .claude-plugin/plugin.json  (optional: a Claude plugin's `skills` paths)
//
// A Claude plugin repo lists skill directories in plugin.json `skills` (a path or
// an array of paths, relative to the source root): a directory holding
// SKILL.md[.njk] is one skill, any other is scanned one level deep like skills/.
// They are added to skills/<name>/; the same directory counts once, two
// directories with one name are an error. A skill's `dir` records where it lives
// in the source; it always installs as skills/<name>/ (render.ts maps the paths).
//
// Names come from the path; descriptions from item frontmatter (read raw for
// .njk, never rendered). Symlinks anywhere in the tree are rejected (spec §9).
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { ItemType } from "./config.ts";
import { BundleError, parseBundle, type BundleDef } from "./bundles.ts";

export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface CatalogItem {
  type: ItemType;
  name: string;
  description?: string;
  /** Files that make up the item, relative to the source dir, sorted. */
  files: string[];
  /** Skills only: the skill's directory relative to the source dir (default
   *  `skills/<name>`); its files install under `skills/<name>/`. */
  dir?: string;
}

export interface SourceMeta {
  description?: string;
  vars?: Record<string, unknown>;
}

/** A bundle file (spec §15.1). A broken one carries `error` instead of `def`: that
 *  error belongs to the bundle, never to the scan (spec §15.4). */
export interface CatalogBundle {
  name: string;
  /** The bundle file(s), relative to the source dir. */
  files: string[];
  def?: BundleDef;
  error?: string;
}

export interface Catalog {
  items: CatalogItem[];
  bundles: CatalogBundle[];
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
        items.push({ type, name: entry, description: descriptionOf(file), files: walkFiles(p, dir), dir: relative(dir, p) });
      } else {
        if (!st.isFile()) continue;
        const name = itemName(entry);
        if (name === undefined) continue;
        items.push({ type, name, description: descriptionOf(p), files: [relative(dir, p)] });
      }
    }
  }

  items.push(...pluginSkills(dir, items));
  return { items, bundles: scanBundles(dir), meta: readSourceMeta(dir) };
}

/** Skills listed in `.claude-plugin/plugin.json` `skills` that `found` does not
 *  already hold (by directory); a second directory for a known name is an error. */
function pluginSkills(dir: string, found: CatalogItem[]): CatalogItem[] {
  const pdir = join(dir, ".claude-plugin");
  const p = join(pdir, "plugin.json");
  if (!existsSync(p)) return [];
  noSymlink(pdir);
  noSymlink(p);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new CatalogError(`${p}: invalid JSON (${(err as Error).message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const raw = (parsed as Record<string, unknown>).skills;
  if (raw === undefined) return [];
  const paths = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(paths) || !paths.every((x) => typeof x === "string")) {
    throw new CatalogError(`${p}: "skills" must be a string or an array of strings`);
  }

  const dirOf = new Map<string, string>(); // skill name -> its dir, relative to the source
  for (const it of found) if (it.type === "skill") dirOf.set(it.name, it.dir ?? join("skills", it.name));
  const out: CatalogItem[] = [];
  const add = (skillDir: string, file: string) => {
    const rel = relative(dir, skillDir);
    const name = basename(skillDir);
    const known = dirOf.get(name);
    if (known === rel) return;
    if (known !== undefined) {
      throw new CatalogError(`${p}: skill "${name}" found twice: ${known} and ${rel}`);
    }
    dirOf.set(name, rel);
    out.push({ type: "skill", name, description: descriptionOf(file), files: walkFiles(skillDir, dir), dir: rel });
  };

  for (const entry of paths as string[]) {
    const target = pluginPath(dir, p, entry);
    const file = skillFile(target);
    if (file) {
      add(target, file);
      continue;
    }
    for (const child of readdirSync(target).sort()) {
      const c = join(target, child);
      if (!noSymlink(c).isDirectory()) continue;
      const f = skillFile(c);
      if (f) add(c, f);
    }
  }
  return out;
}

/** Resolve one plugin.json skills path to a directory inside the source; every
 *  segment is checked, so neither `..` nor a symlink can leave the source root. */
function pluginPath(dir: string, pluginFile: string, entry: string): string {
  if (isAbsolute(entry) || entry.startsWith("/") || entry.startsWith("\\")) {
    throw new CatalogError(`${pluginFile}: skills path must not be absolute: ${entry}`);
  }
  const segments = entry.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new CatalogError(`${pluginFile}: skills path must not contain "..": ${entry}`);
  }
  let cur = dir;
  for (const seg of segments) {
    cur = join(cur, seg);
    if (!existsSync(cur) && !isDanglingLink(cur)) {
      throw new CatalogError(`${pluginFile}: skills path does not exist: ${entry}`);
    }
    noSymlink(cur);
  }
  if (!lstatSync(cur).isDirectory()) {
    throw new CatalogError(`${pluginFile}: skills path is not a directory: ${entry}`);
  }
  return cur;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `bundles/<name>.yaml|.yml`; both for one name is an error of that bundle. */
function scanBundles(dir: string): CatalogBundle[] {
  const bdir = join(dir, "bundles");
  if (!existsSync(bdir)) return [];
  noSymlink(bdir);
  const byName = new Map<string, string[]>();
  for (const entry of readdirSync(bdir).sort()) {
    const m = /^(.+)\.ya?ml$/.exec(entry);
    if (!m) continue;
    const p = join(bdir, entry);
    if (!noSymlink(p).isFile()) continue;
    byName.set(m[1]!, [...(byName.get(m[1]!) ?? []), relative(dir, p)]);
  }
  const out: CatalogBundle[] = [];
  for (const [name, files] of byName) {
    if (files.length > 1) {
      out.push({ name, files, error: `both ${files.join(" and ")} exist` });
      continue;
    }
    try {
      out.push({ name, files, def: parseBundle(readFileSync(join(dir, files[0]!), "utf8")) });
    } catch (err) {
      if (!(err instanceof BundleError)) throw err;
      out.push({ name, files, error: `${files[0]}: ${err.message}` });
    }
  }
  return out;
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
