// Bundles (spec §15) and name patterns (spec §3).
//
// A bundle is `bundles/<name>.yaml|.yml` in a source: a named set of that
// source's items (names or `*` patterns per type), other bundles of the source
// included recursively, and var defaults for the items it yields. This module
// parses one bundle file and expands a bundle against a scanned catalog; it
// knows nothing about config, rendering or the target filesystem.
import type { ItemType } from "./config.ts";
import { FrontmatterError, parseYamlDocument, YamlFloat, type YamlValue } from "./frontmatter.ts";
import { resolveSpec, SpecError } from "./spec.ts";
import type { Catalog } from "./catalog.ts";

export class BundleError extends Error {
  override name = "BundleError";
}

/** The character that makes a name a pattern (spec §3). */
export const PATTERN_CHAR = "*";

export function isPattern(name: string): boolean {
  return name.includes(PATTERN_CHAR);
}

/** `*` matches any run of characters (including none); everything else is literal. */
export function matchesPattern(pattern: string, name: string): boolean {
  const re = pattern.split(PATTERN_CHAR).map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}$`).test(name);
}

/** An entry naming an item of another source by address (spec §15.6). */
export interface ForeignEntry {
  type: ItemType;
  /** The entry as written, e.g. `perl-*@gitlab.com/peter`. */
  entry: string;
  /** Name or pattern. */
  name: string;
  /** The address as written. */
  spec: string;
  /** The resolved `git`/`url` identity of that source. */
  url: string;
  /** How `skilletor add` would store it (§4.2). */
  kind: "git" | "url";
  /** The source name `skilletor add` would derive (§4.2). */
  derivedName: string;
}

/** Two source identities (`git`/`url` values) are the same modulo a trailing `/`, `.git` and host case. */
export function sameIdentity(a: string, b: string): boolean {
  return normalizeIdentity(a) === normalizeIdentity(b);
}

function normalizeIdentity(u: string): string {
  let s = u.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(s);
  if (m) s = m[1]!.toLowerCase() + m[2]!.toLowerCase() + m[3];
  return s;
}

/** Catalog items of `type` a name or pattern names (spec §3). */
export function matchEntry(cat: Catalog, type: ItemType, entry: string): Catalog["items"] {
  return isPattern(entry)
    ? cat.items.filter((i) => i.type === type && matchesPattern(entry, i.name))
    : cat.items.filter((i) => i.type === type && i.name === entry);
}

export interface BundleDef {
  description: string;
  /** Names or patterns of this source's items, in file order (skills, agents, rules). */
  items: { type: ItemType; entry: string }[];
  foreign: ForeignEntry[];
  /** Other bundles of this source, bare names. */
  bundles: string[];
  vars: Record<string, unknown>;
}

const TYPE_KEYS: Record<string, ItemType> = { skills: "skill", agents: "agent", rules: "rule" };
const KEYS = new Set(["description", "skills", "agents", "rules", "bundles", "vars"]);

/** A probe that refuses: an address that would need one is a bundle error (spec §15.6). */
const noProbe = (): never => {
  throw new SpecError("probe");
};

/** A YAML value as plain JSON-like data (floats become numbers). */
function plain(v: YamlValue): unknown {
  if (v instanceof YamlFloat) return v.value;
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

function stringList(value: YamlValue | undefined, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BundleError(`${key} must be a list`);
  return value.map((v) => {
    if (typeof v !== "string") throw new BundleError(`${key} entries must be strings (got ${JSON.stringify(plain(v))})`);
    if (v.trim() === "") throw new BundleError(`${key} has an empty entry`);
    return v.trim();
  });
}

/** Resolve `name@<spec>` without a probe; local paths and generic hosts are errors. */
function foreignEntry(type: ItemType, entry: string, key: string): ForeignEntry {
  const at = entry.indexOf("@");
  const name = entry.slice(0, at);
  const spec = entry.slice(at + 1);
  if (name === "" || spec === "") throw new BundleError(`${key}: "${entry}" has an empty name or address`);
  let url: string;
  let kind: "git" | "url";
  let derivedName: string;
  try {
    const r = resolveSpec(spec, noProbe);
    if (r.kind === "local") {
      throw new BundleError(`${key}: "${entry}" names a local path; a bundle can only name remote sources`);
    }
    url = r.value;
    kind = r.kind;
    derivedName = r.derivedName;
  } catch (err) {
    if (err instanceof BundleError) throw err;
    if (err instanceof SpecError && err.message === "probe") {
      throw new BundleError(`${key}: "${entry}": a generic host must be written as a full https:// URL`);
    }
    throw new BundleError(`${key}: "${entry}": ${(err as Error).message}`);
  }
  return { type, entry, name, spec, url, kind, derivedName };
}

/** Parse and validate one bundle file (spec §15.1). Throws a BundleError. */
export function parseBundle(text: string): BundleDef {
  let data: Record<string, YamlValue>;
  try {
    data = parseYamlDocument(text);
  } catch (err) {
    if (err instanceof FrontmatterError) throw new BundleError(err.message);
    throw err;
  }
  for (const key of Object.keys(data)) {
    if (!KEYS.has(key)) throw new BundleError(`unknown key "${key}" (allowed: ${[...KEYS].join(", ")})`);
  }
  if (typeof data.description !== "string" || data.description.trim() === "") {
    throw new BundleError("description is required (a string)");
  }
  const def: BundleDef = { description: data.description, items: [], foreign: [], bundles: [], vars: {} };
  for (const [key, type] of Object.entries(TYPE_KEYS)) {
    for (const entry of stringList(data[key], key)) {
      if (entry.includes("@")) def.foreign.push(foreignEntry(type, entry, key));
      else def.items.push({ type, entry });
    }
  }
  for (const name of stringList(data.bundles, "bundles")) {
    if (name.includes("@")) throw new BundleError(`bundles: "${name}" must be a bare name of this source`);
    if (isPattern(name)) throw new BundleError(`bundles: "${name}": patterns over bundle names are not supported`);
    def.bundles.push(name);
  }
  const vars = data.vars;
  if (vars !== undefined && vars !== null) {
    if (typeof vars !== "object" || Array.isArray(vars) || vars instanceof YamlFloat) {
      throw new BundleError("vars must be a mapping");
    }
    def.vars = plain(vars) as Record<string, unknown>;
  }
  return def;
}

// ---- expansion (spec §15.2) ---------------------------------------------------

/** One way an item is reached: the bundle path (declared bundle first) and its vars. */
export interface Chain {
  path: string[];
  /** Bundle vars along the path, the outer bundle winning (spec §15.3). */
  vars: Record<string, unknown>;
  /** Per var key, the bundle whose value won. */
  setters: Record<string, string>;
}

export interface BundleMember {
  type: ItemType;
  name: string;
  chains: Chain[];
}

export interface Expansion {
  items: BundleMember[];
  /** Entries of other sources (spec §15.6), with the chain they were found on; the
   *  caller serves them from a configured source with the same identity. */
  foreign: (ForeignEntry & { chain: Chain })[];
  /** A missing name, a pattern matching nothing, an unsupported entry: one each,
   *  with the bundle (declared or included) whose file has the entry. */
  warnings: { bundle: string; message: string }[];
}

/** The warning for an entry that matched `count` items, if any (a bare `*` stays silent, spec §3). */
export function entryMiss(type: ItemType, entry: string, count: number): string | undefined {
  if (count > 0 || entry === PATTERN_CHAR) return undefined;
  return isPattern(entry) ? `pattern ${type}:${entry} matches nothing` : `${type} ${entry} not found in the source`;
}

/** Expand a bundle of `cat` (spec §15.2). A bundle error (§15.4) throws a BundleError. */
export function expandBundle(cat: Catalog, name: string): Expansion {
  const byName = new Map(cat.bundles.map((b) => [b.name, b]));
  const members = new Map<string, BundleMember>();
  const out: Expansion = { items: [], foreign: [], warnings: [] };

  const visit = (bundle: string, path: string[], outer: Chain | undefined) => {
    const cb = byName.get(bundle);
    if (!cb) {
      throw new BundleError(path.length === 0 ? `bundle ${bundle} not found` : `bundle ${bundle} (included by ${path.at(-1)}) not found`);
    }
    if (cb.error !== undefined) {
      throw new BundleError(path.length === 0 ? `bundle ${bundle}: ${cb.error}` : `bundle ${bundle} (included by ${path.at(-1)}): ${cb.error}`);
    }
    const here = [...path, bundle];
    // Inner vars first, then the outer chain on top: the outer bundle wins.
    const chain: Chain = { path: here, vars: { ...cb.def!.vars }, setters: {} };
    for (const k of Object.keys(cb.def!.vars)) chain.setters[k] = bundle;
    if (outer) {
      Object.assign(chain.vars, outer.vars);
      Object.assign(chain.setters, outer.setters);
    }
    for (const { type, entry } of cb.def!.items) {
      const found = matchEntry(cat, type, entry);
      const miss = entryMiss(type, entry, found.length);
      if (miss) out.warnings.push({ bundle, message: miss });
      for (const ci of found) {
        const key = `${ci.type}/${ci.name}`;
        const m = members.get(key) ?? { type: ci.type, name: ci.name, chains: [] };
        if (!m.chains.some((c) => c.path.join("/") === here.join("/"))) m.chains.push(chain);
        members.set(key, m);
      }
    }
    for (const f of cb.def!.foreign) out.foreign.push({ ...f, chain });
    for (const inner of cb.def!.bundles) {
      if (here.includes(inner)) throw new BundleError(`bundle cycle ${[...here.slice(here.indexOf(inner)), inner].join(" → ")}`);
      visit(inner, here, { ...chain, path: here });
    }
  };
  visit(name, [], undefined);
  out.items = [...members.values()];
  return out;
}
