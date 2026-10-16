// The plugin requirement in a project's committed `.claude/settings.json` (spec §6.8, k140):
// a project that uses skilletor enables `skilletor@<marketplace>` there and declares every
// marketplace an `enabledPlugins` entry of the file needs, so a fresh checkout gets Claude
// Code's offer to install the plugins. Add-only: no existing key is changed or removed. The
// marketplace and its source come from Claude Code's own plugin state under
// `<home>/.claude/plugins`; a source that only means something on this machine (a directory)
// is never written into a committed file. Never throws: what it cannot do is a warning.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { samePath } from "./fsutil.ts";

/** Claude Code's built-in marketplace: known everywhere, never declared. */
export const OFFICIAL_MARKETPLACE = "claude-plugins-official";

const PLUGIN = "skilletor";

type Json = Record<string, unknown>;

/** What a sync would add to the settings file, and what it cannot. */
export interface SettingsPlan {
  /** The new file text; absent when nothing is added (the file is left as it is). */
  next?: string;
  /** `enabledPlugins` keys added (`skilletor@getty`). */
  enabled: string[];
  /** `extraKnownMarketplaces` names added. */
  declared: string[];
  /** What could not be added, or why the file was left alone; one line each. */
  warnings: string[];
}

export interface PlanInput {
  /** `<project>/.claude/settings.json`. */
  file: string;
  /** How the report names the file (`.claude/settings.json`). */
  label: string;
  /** The project root: a project-scope plugin install counts only for this project. */
  projectDir: string;
  /** Stands in for `~`: Claude Code's plugin state is `<home>/.claude/plugins`. */
  home: string;
  /** `CLAUDE_PLUGIN_ROOT` of the running plugin, when skilletor runs as one. */
  pluginRoot?: string;
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A JSON object file, or undefined (missing, unreadable, not JSON, not an object). */
function readObject(path: string): Json | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `name@marketplace` → its parts; undefined for a key of another form. */
function pluginKey(key: string): { name: string; marketplace: string } | undefined {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return undefined;
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

interface Install {
  marketplace: string;
  scope?: string;
  installPath?: string;
  projectPath?: string;
}

/** skilletor's installs from `installed_plugins.json` (version 2: a list per key; an older
 *  file's single object is read as a list of one). */
function skilletorInstalls(home: string): Install[] {
  const file = readObject(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = file?.plugins;
  if (!isObject(plugins)) return [];
  const out: Install[] = [];
  for (const [key, value] of Object.entries(plugins)) {
    const k = pluginKey(key);
    if (k?.name !== PLUGIN) continue;
    for (const e of Array.isArray(value) ? value : [value]) {
      if (!isObject(e)) continue;
      const str = (x: unknown) => (typeof x === "string" ? x : undefined);
      out.push({ marketplace: k.marketplace, scope: str(e.scope), installPath: str(e.installPath), projectPath: str(e.projectPath) });
    }
  }
  return out;
}

/**
 * The marketplace skilletor is installed from, for this project: the install the running
 * plugin is (`CLAUDE_PLUGIN_ROOT` is its install path), else the one marketplace of the user's
 * install and this project's. Several of those: ambiguous, the file gets none.
 */
export function skilletorMarketplace(
  home: string, projectDir: string, pluginRoot?: string,
): { name?: string; ambiguous?: string[] } {
  const installs = skilletorInstalls(home);
  const unique = (xs: Install[]) => [...new Set(xs.map((x) => x.marketplace))];
  if (pluginRoot) {
    const running = unique(installs.filter((i) => i.installPath !== undefined && samePath(i.installPath, pluginRoot)));
    if (running.length === 1) return { name: running[0] };
  }
  const here = unique(installs.filter((i) =>
    i.scope === "user" || (i.projectPath !== undefined && samePath(i.projectPath, projectDir))));
  if (here.length === 1) return { name: here[0] };
  return here.length > 1 ? { ambiguous: here.sort() } : {};
}

/** A git address that names no machine: a URL with a network scheme or the scp form. */
function isRemoteGit(url: string): boolean {
  return /^(https?|ssh|git):\/\//i.test(url) || /^[\w.-]+@[\w.-]+:(?!\/\/)/.test(url);
}

/**
 * Why a marketplace source must not go into a committed file – it names something on this
 * machine, or is of a kind skilletor does not know – or undefined when it may: `github` with a
 * `repo`, `git` with a remote `url`, `url` with an http(s) URL.
 */
export function notDeclarable(source: unknown): string | undefined {
  if (!isObject(source)) return "no readable source";
  const kind = typeof source.source === "string" ? source.source : "unknown";
  if (kind === "github" && typeof source.repo === "string" && source.repo) return undefined;
  if (kind === "git" && typeof source.url === "string" && isRemoteGit(source.url)) return undefined;
  if (kind === "url" && typeof source.url === "string" && /^https?:\/\//i.test(source.url)) return undefined;
  if (kind === "git") return "a git source on a local path";
  return `a ${kind} source`;
}

/** The text layout of an existing file: its indent, line ending and final newline. */
function layoutOf(text: string): { indent: string; eol: string; final: boolean } {
  const m = /^([ \t]+)"/m.exec(text);
  const indent = m && m[1]!.length <= 10 ? m[1]! : "  ";
  return { indent, eol: text.includes("\r\n") ? "\r\n" : "\n", final: /\n$/.test(text) };
}

/** Plan the additions to the settings file; reads it and Claude Code's plugin state only. */
export function planClaudeSettings(a: PlanInput): SettingsPlan {
  const plan: SettingsPlan = { enabled: [], declared: [], warnings: [] };
  const leave = (why: string): SettingsPlan => {
    plan.warnings.push(`${a.label} ${why}; plugin requirement not written`);
    return plan;
  };
  let text: string | undefined;
  try {
    const st = lstatSync(a.file);
    if (st.isSymbolicLink()) return leave("is a symbolic link");
    if (!st.isFile()) return leave("is not a file");
    text = readFileSync(a.file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return leave(`cannot be read (${(err as Error).message})`);
  }
  let settings: Json = {};
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return leave(`is not valid JSON (${(err as Error).message})`);
    }
    if (!isObject(parsed)) return leave("is not a JSON object");
    settings = parsed;
  }
  for (const key of ["enabledPlugins", "extraKnownMarketplaces"]) {
    if (settings[key] !== undefined && !isObject(settings[key])) return leave(`has an "${key}" that is not an object`);
  }
  const enabled = (settings.enabledPlugins ?? {}) as Json;
  const declared = (settings.extraKnownMarketplaces ?? {}) as Json;
  const known = readObject(join(a.home, ".claude", "plugins", "known_marketplaces.json")) ?? {};
  const sourceOf = (m: string): unknown => (isObject(known[m]) ? (known[m] as Json).source : undefined);
  const NEEDS = "a committed file takes a github, git or url source";

  // skilletor itself – unless the file names it already, from any marketplace, on or off.
  if (!Object.keys(enabled).some((k) => pluginKey(k)?.name === PLUGIN)) {
    const own = skilletorMarketplace(a.home, a.projectDir, a.pluginRoot);
    if (own.ambiguous) {
      plan.warnings.push(`skilletor is installed from several marketplaces (${own.ambiguous.join(", ")}); ` +
        `${a.label} does not get it – enable the one teammates should use`);
    } else if (own.name !== undefined) {
      const why = own.name === OFFICIAL_MARKETPLACE || Object.hasOwn(declared, own.name) ? undefined
        : known[own.name] === undefined ? "no entry in Claude Code's known marketplaces" : notDeclarable(sourceOf(own.name));
      if (why) plan.warnings.push(`skilletor's marketplace "${own.name}" has ${why} on this machine; ${a.label} does not get skilletor@${own.name} (${NEEDS})`);
      else plan.enabled.push(`${PLUGIN}@${own.name}`);
    }
  }

  // Every marketplace an entry that is not switched off needs, in the order of the entries.
  const additions: [string, unknown][] = [];
  const wanted = [...Object.entries(enabled).filter(([, on]) => on !== false).map(([k]) => k), ...plan.enabled];
  const seen = new Set<string>();
  for (const key of wanted) {
    const m = pluginKey(key)?.marketplace;
    if (m === undefined || seen.has(m)) continue;
    seen.add(m);
    if (m === OFFICIAL_MARKETPLACE || Object.hasOwn(declared, m)) continue;
    const users = wanted.filter((k) => pluginKey(k)?.marketplace === m).join(", ");
    if (known[m] === undefined) {
      plan.warnings.push(`marketplace "${m}" (${users}) is not known to Claude Code on this machine; not declared in ${a.label}`);
      continue;
    }
    const why = notDeclarable(sourceOf(m));
    if (why) {
      plan.warnings.push(`marketplace "${m}" (${users}) has ${why} on this machine; not declared in ${a.label} (${NEEDS})`);
      continue;
    }
    additions.push([m, { source: structuredClone(sourceOf(m)) }]);
    plan.declared.push(m);
  }
  if (plan.enabled.length === 0 && additions.length === 0) return plan;

  // Add only: every key stays where it was, new ones go last.
  const next: Json = { ...settings };
  if (plan.enabled.length) next.enabledPlugins = { ...enabled, ...Object.fromEntries(plan.enabled.map((k) => [k, true])) };
  if (additions.length) next.extraKnownMarketplaces = { ...declared, ...Object.fromEntries(additions) };
  const { indent, eol, final } = text === undefined ? { indent: "  ", eol: "\n", final: true } : layoutOf(text);
  const body = JSON.stringify(next, null, indent);
  plan.next = (eol === "\n" ? body : body.split("\n").join(eol)) + (final ? eol : "");
  return plan;
}
