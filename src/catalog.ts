// Scan a source's layout into a catalog of installable items (spec §4.1).
//
//   skills/<name>/SKILL.md[.njk] + companion files
//   agents/<name>.md[.njk]
//   rules/<name>.md[.njk]
//   snippets/…            (not installable)
//   bundles/<name>.yaml|.yml  (optional: named item sets, spec §15)
//   skilletor.json        (optional: { description, vars })
//   .claude-plugin/plugin.json  (optional: a Claude plugin's `skills` paths)
//   .claude/skills/<name>/, .claude/agents/<name>.md[.njk], .claude/rules/<name>.md[.njk]
//                         (the Claude project layout, best effort)
//
// A Claude plugin repo lists skill directories in plugin.json `skills` (a path or
// an array of paths, relative to the source root): a directory holding
// SKILL.md[.njk] is one skill, any other is scanned one level deep like skills/.
// They are added to skills/<name>/; the same directory counts once, two
// directories with one name are an error. A skill's `dir` records where it lives
// in the source; it always installs as skills/<name>/ (render.ts maps the paths).
//
// The Claude project layout is read last (k96): a `.claude/` item whose name the
// published layout or plugin.json already gave its type is skipped silently. It is
// best effort – what the published layout rejects there (a symlink at `.claude`, a
// type dir, an item or any file of a skill) skips that directory or item, never the
// scan – and skilletor's own installed copies there are not offered. Agents and rules
// found there carry `dir` too; every item installs as skills/<name>/, agents/<name>.md,
// rules/<name>.md, whatever its source path.
//
// A source entry's `path` (config, spec §3; k126) says where the source's skills lie
// instead: `scan(dir, paths)` walks each path down to the directories holding
// SKILL.md[.njk] and offers those skills and nothing else – none of the layout above
// but skilletor.json, and no bundles. skilletor's own installed copies are skipped there
// too (k129).
//
// Names come from the path; descriptions from item frontmatter (read raw for
// .njk, never rendered). Symlinks anywhere in the tree are rejected (spec §9); in
// `.claude/` they are skipped, never followed. An agent or rule with both `<name>.md`
// and `<name>.md.njk` is one item carrying an error, never a failed scan (k100);
// `.claude/` keeps the first of the two silently. A skill holding `f` beside `f.njk`,
// which both install as `f`, carries an error naming every such pair – in `.claude/`
// too, where one skill directory has no "which item wins" question (k113).
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix, relative } from "node:path";
import { innerSegments, toPosix } from "./fsutil.ts";
import { nameKey, type ItemType } from "./config.ts";
import { BundleError, parseBundle, type BundleDef } from "./bundles.ts";
import { SKILL_GITIGNORE } from "./gitignore.ts";

export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface CatalogItem {
  type: ItemType;
  name: string;
  description?: string;
  /** Files that make up the item, relative to the source dir, sorted. */
  files: string[];
  /** Where the item lives, relative to the source dir: a skill's directory (default
   *  `skills/<name>`), the directory holding an agent's or rule's file (default `agents`,
   *  `rules`). Its files install under `skills/<name>/`, `agents/`, `rules/` (render.ts). */
  dir?: string;
  /** Why the item cannot be built: both `<name>.md` and `<name>.md.njk` exist (k100), a
   *  skill holds `f` beside `f.njk` (k113), or the name, ignoring case, comes from several
   *  directories or files of one type (k126, k127, k135; no `dir` then). That error belongs to
   *  the item, never to the scan (spec §4.1); `files` holds every file of them. */
  error?: string;
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
    else if (st.isFile()) out.push(toPosix(relative(sourceDir, p)));
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

/** The skill in `skillDir`, whose main file is `file`. `f` beside `f.njk` in it both install
 *  as `f`: an error of the skill naming every such pair in sorted order, never a failed scan
 *  (spec §4.1, k113); while SKILL.md is one of them, which description is meant is unknown. */
function skillItem(dir: string, skillDir: string, file: string, files = walkFiles(skillDir, dir)): CatalogItem {
  const have = new Set(files);
  const twice = files.filter((f) => !f.endsWith(".njk") && have.has(`${f}.njk`));
  const item: CatalogItem = { type: "skill", name: basename(skillDir), files, dir: toPosix(relative(dir, skillDir)) };
  if (!twice.includes(toPosix(relative(dir, file)))) item.description = descriptionOf(file);
  if (twice.length > 0) item.error = twice.map((f) => `both ${f} and ${f}.njk exist`).join("; ");
  return item;
}

/** Match `<name>.md` or `<name>.md.njk`; returns the name. */
function itemName(fileName: string): string | undefined {
  const m = /^(.+?)\.md(\.njk)?$/.exec(fileName);
  return m ? m[1] : undefined;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(xs: string[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** The error of skills one name comes from several directories of (k126, k127). */
function inDirs(where: string[], why: string): string {
  return `found in ${where.length} directories${why}: ${listed(where)}`;
}

/** The error of an agent or rule one name comes from several files of (k100, k135). */
function bothExist(where: string[], why: string): string {
  return `${where.length === 2 ? "both " : ""}${listed(where)} exist${why}`;
}

/**
 * `items` of one type with one item per name ignoring case (k127, k135), in first-seen order.
 * Names equal ignoring case are one name – they install into one directory or file on a
 * case-insensitive file system (macOS, Windows) – on every platform, so a lock is the same
 * everywhere. A name alone keeps its item; a name found more than once is an error of each of
 * its spellings, as a config names one of them exactly: `error` gets where they lie (a
 * skill's directory, an agent's or rule's file) in sorted order and why, `files` are all of
 * theirs, and no `dir` is set.
 */
function oneName(items: CatalogItem[], error: (where: string[], why: string) => string): CatalogItem[] {
  const groups = new Map<string, CatalogItem[]>();
  for (const item of items) groups.set(nameKey(item.name), [...(groups.get(nameKey(item.name)) ?? []), item]);
  const out: CatalogItem[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const names = [...new Set(group.map((i) => i.name))];
    const where = group.map((i) => (i.type === "skill" ? i.dir! : i.files[0]!)).sort();
    const why = names.length > 1 ? ", names equal ignoring case" : "";
    const files = group.flatMap((i) => i.files).sort();
    for (const name of names) out.push({ type: group[0]!.type, name, files: [...files], error: error(where, why) });
  }
  return out;
}

/** The catalog of the source tree at `dir`. With `paths` – a source entry's `path` (spec §3,
 *  §4.1; k126) – the items are the skills lying beneath those paths and nothing else: the
 *  layout's own directories, plugin.json, `.claude/` and bundles are not read. */
export function scan(dir: string, paths?: string[]): Catalog {
  if (paths !== undefined) return { items: pathSkills(dir, paths), bundles: [], meta: readSourceMeta(dir) };
  const items: CatalogItem[] = [];

  for (const { dir: sub, type } of TYPE_DIRS) {
    const typeDir = join(dir, sub);
    if (!existsSync(typeDir)) continue;
    noSymlink(typeDir);

    const found: CatalogItem[] = []; // a skill per directory, an agent or rule per file
    for (const entry of readdirSync(typeDir)) {
      const p = join(typeDir, entry);
      const st = noSymlink(p);

      if (type === "skill") {
        if (!st.isDirectory()) continue;
        const file = skillFile(p);
        if (!file) continue;
        found.push(skillItem(dir, p, file));
      } else {
        if (!st.isFile()) continue;
        const name = itemName(entry);
        if (name === undefined) continue;
        found.push({ type, name, files: [toPosix(relative(dir, p))] });
      }
    }
    // Both `<name>.md` and `<name>.md.njk` is an error of that item, like a bundle's `.yaml`
    // beside its `.yml` (spec §4.1, §15.4); so are two spellings of one name (k135).
    items.push(...oneName(found, type === "skill" ? inDirs : bothExist).map((i) =>
      i.error === undefined && type !== "skill" ? { ...i, description: descriptionOf(join(dir, i.files[0]!)) } : i));
  }

  items.push(...pluginSkills(dir, items));
  items.push(...claudeItems(dir, items));
  return { items, bundles: scanBundles(dir), meta: readSourceMeta(dir) };
}

/** Is `path` a directory, not a symlink? False when it cannot be read. */
function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The name prefix of installed agents and rules (spec §6.4). */
const LOCAL_PREFIX = ".local.";

/**
 * Items of the Claude project layout, `.claude/{skills,agents,rules}` (spec §4.1, k96), whose
 * name `found` does not hold for their type yet. Best effort: a symlink, an unreadable
 * entry or anything else the published layout would reject skips that directory or item,
 * and nothing is followed. skilletor's own installed copies are skipped as well (spec
 * §6.4) – a skill whose `.gitignore` is skilletor's, a `.local.` agent or rule: a sync in
 * that project wrote them from other sources, and git ignores them, so a `local` checkout
 * offers what its clone does.
 */
function claudeItems(dir: string, found: CatalogItem[]): CatalogItem[] {
  const out: CatalogItem[] = [];
  const base = join(dir, ".claude");
  if (!isPlainDir(base)) return out;
  const known = new Set(found.map((i) => `${i.type}:${nameKey(i.name)}`)); // ignoring case (k135)
  for (const { dir: sub, type } of TYPE_DIRS) {
    const typeDir = join(base, sub);
    if (!isPlainDir(typeDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(typeDir).sort();
    } catch {
      continue;
    }
    const here: CatalogItem[] = [];
    for (const entry of entries) {
      let item: CatalogItem | undefined;
      try {
        item = claudeItem(dir, typeDir, entry, type);
      } catch {
        continue; // a symlink or an unreadable file: this item only
      }
      // A name found before is skipped; `<name>.md` beside `<name>.md.njk` here takes the first.
      if (!item || known.has(`${type}:${nameKey(item.name)}`) || here.some((i) => i.name === item.name)) continue;
      here.push(item);
    }
    // Two spellings of one name here are an error of each, as in the published layout (k135).
    out.push(...oneName(here, type === "skill" ? inDirs : bothExist));
  }
  return out;
}

/** One entry of a `.claude/<type>` dir as an item; undefined when it is none. Throws
 *  where the published layout would (a symlink), and on a file it cannot read. */
function claudeItem(dir: string, typeDir: string, entry: string, type: ItemType): CatalogItem | undefined {
  const p = join(typeDir, entry);
  const st = noSymlink(p);
  if (type === "skill") {
    if (!st.isDirectory()) return undefined;
    const file = skillFile(p);
    if (!file) return undefined;
    if (isInstalledCopy(p)) return undefined;
    return skillItem(dir, p, file);
  }
  if (!st.isFile()) return undefined;
  const name = itemName(entry);
  if (name === undefined || name.startsWith(LOCAL_PREFIX)) return undefined;
  return { type, name, description: descriptionOf(p), files: [toPosix(relative(dir, p))], dir: toPosix(relative(dir, typeDir)) };
}

/** Is the skill directory `skillDir` one of skilletor's own installed copies – its `.gitignore`
 *  a plain file holding skilletor's (spec §6.4)? Then a sync wrote it from other sources and
 *  git ignores it, so a scan passes it over (k96, k129) without reading the rest of it. */
function isInstalledCopy(skillDir: string): boolean {
  const gitignore = join(skillDir, ".gitignore");
  try {
    return lstatSync(gitignore).isFile() && readFileSync(gitignore, "utf8") === SKILL_GITIGNORE;
  } catch {
    return false;
  }
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

  // skill name ignoring case (k135) -> its dir(s), relative to the source
  const dirsOf = new Map<string, string[]>();
  const known = (name: string, rel: string) => dirsOf.set(nameKey(name), [...(dirsOf.get(nameKey(name)) ?? []), rel]);
  for (const it of found) if (it.type === "skill") known(it.name, it.dir ?? posix.join("skills", it.name));
  const out: CatalogItem[] = [];
  const add = (skillDir: string, file: string) => {
    const rel = toPosix(relative(dir, skillDir));
    const name = basename(skillDir);
    const dirs = dirsOf.get(nameKey(name)) ?? [];
    if (dirs.includes(rel)) return;
    if (dirs.length > 0) {
      const why = dirs.every((d) => posix.basename(d) === name) ? "" : ", names equal ignoring case";
      throw new CatalogError(`${p}: skill "${name}" found twice${why}: ${dirs[0]} and ${rel}`);
    }
    known(name, rel);
    out.push(skillItem(dir, skillDir, file));
  };

  for (const entry of paths as string[]) {
    const target = innerDir(dir, `${p}: skills path`, entry);
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

/**
 * The skills beneath a source entry's `path` values (spec §4.1, k126), sorted by name. Each
 * value is held to what a plugin.json `skills` path is (`innerDir`); from there the walk goes
 * down to any depth: a directory holding SKILL.md[.njk] is one skill, named by its basename,
 * and is not searched further; any other directory is walked. On the way down nothing is
 * followed and nothing fails – a symlinked entry and a dot-directory that is no skill (`.git`)
 * are passed over – while a skill directory keeps every skill's rules (a symlink in it fails
 * the scan). skilletor's own installed copies are passed over as in `.claude/` (k129). A
 * directory reached through two overlapping paths counts once; a name two
 * directories yield is one item carrying an error naming them in sorted order, never a
 * failed scan: an addition in a foreign repository must not take the whole source down.
 * Names equal ignoring case are one name (k127) – they install into one directory on a
 * case-insensitive file system – on every platform, so a lock is the same everywhere: each
 * spelling is an item carrying that error, since a config names one of them exactly.
 */
function pathSkills(dir: string, paths: string[]): CatalogItem[] {
  const found = new Map<string, CatalogItem>(); // a skill per directory, relative to the source
  const visit = (cur: string, named: boolean): void => {
    const file = skillFile(cur);
    if (file) {
      if (isInstalledCopy(cur)) return;
      const item = skillItem(dir, cur, file);
      if (!found.has(item.dir!)) found.set(item.dir!, item);
      return;
    }
    if (!named && basename(cur).startsWith(".")) return;
    for (const entry of readdirSync(cur).sort()) {
      const p = join(cur, entry);
      if (isPlainDir(p)) visit(p, false);
    }
  };
  for (const entry of paths) visit(innerDir(dir, '"path"', entry), true);

  return oneName([...found.values()], inDirs).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Resolve one path of a source – a plugin.json `skills` path, a source entry's `path` – to a
 *  directory inside the source; every segment is checked, so neither `..` nor a symlink can
 *  leave the source root. `what` names it in the error. */
function innerDir(dir: string, what: string, entry: string): string {
  const segments = innerSegments(entry);
  if (segments === "absolute") throw new CatalogError(`${what} must not be absolute: ${entry}`);
  if (segments === "dotdot") throw new CatalogError(`${what} must not contain "..": ${entry}`);
  if (segments === "root") {
    // Its name would be the source root's basename, i.e. the cache directory's.
    throw new CatalogError(`${what} must not be the source root: ${JSON.stringify(entry)}`);
  }
  let cur = dir;
  for (const seg of segments) {
    cur = join(cur, seg);
    if (!existsSync(cur) && !isDanglingLink(cur)) {
      throw new CatalogError(`${what} does not exist: ${entry}`);
    }
    noSymlink(cur);
  }
  if (!lstatSync(cur).isDirectory()) {
    throw new CatalogError(`${what} is not a directory: ${entry}`);
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
    byName.set(m[1]!, [...(byName.get(m[1]!) ?? []), toPosix(relative(dir, p))]);
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
