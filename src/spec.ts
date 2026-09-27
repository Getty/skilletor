// Shorthand resolution for `skilletor add [name] <spec>` (spec §4.2).
//
// Resolution happens once, at add time; the config always stores the explicit
// form. Known forges resolve without any network access; only truly generic
// hosts are probed, via an injected `probe` (never by hooks).
import { isSourceName } from "./config.ts";

export type SourceKind = "git" | "url" | "local";

export interface ResolvedSpec {
  kind: SourceKind;
  value: string;
  derivedName: string;
}

/** Result of probing a base URL: which of `git ls-remote` / `HEAD .tar.gz` responded. */
export interface ProbeResult {
  git?: boolean;
  tarball?: boolean;
}

export type Probe = (baseUrl: string) => ProbeResult;

export class SpecError extends Error {
  override name = "SpecError";
}

const KNOWN_FORGES = ["github.com", "gitlab.com", "codeberg.org", "hf.co", "huggingface.co"];
const DEFAULT_REPO = "skills";
/** The derived name of a spec normalization leaves nothing of (`/`, `~`, `~/日本`) (k95). */
const FALLBACK_NAME = "source";

/** Lowercase and reduce to [a-z0-9-]. */
function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Last non-empty path segment. */
function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function isLocal(spec: string): boolean {
  return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~");
}

function hasScheme(spec: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//.test(spec);
}

function isScpLike(spec: string): boolean {
  // git@host:owner/repo.git
  return /^[^@/]+@[^:/]+:/.test(spec);
}

function isTarball(url: string): boolean {
  return url.endsWith(".tar.gz") || url.endsWith(".tgz");
}

/** The name of a git repo `owner/repo` (k101): the repo's, unless it is the default repo
 *  (or empty) – then the owner's, so `Getty/karr` is "karr" and `Getty` "getty". */
function repoName(owner: string, repo: string | undefined): string {
  const name = repo === undefined ? "" : normalizeName(repo);
  return name && name !== DEFAULT_REPO ? name : normalizeName(owner);
}

/** A git address's path segments: the repo is the last one (as `git clone` names its
 *  directory), the owner the first; a single segment names both. */
function nameFromPath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return normalizeName(path);
  return repoName(segs[0]!, segs.length > 1 ? segs[segs.length - 1] : undefined);
}

/** derivedName for an explicit URL or scp-like address. */
function nameFromUrl(spec: string, kind: SourceKind): string {
  if (isScpLike(spec)) {
    const path = spec.slice(spec.indexOf(":") + 1);
    if (kind === "git") return nameFromPath(path);
    return normalizeName(basename(path.split("/")[0] ?? path));
  }
  try {
    const u = new URL(spec);
    const segs = u.pathname.split("/").filter(Boolean);
    if (kind === "git" && segs.length > 0) return nameFromPath(u.pathname);
    return normalizeName(u.hostname);
  } catch {
    return normalizeName(spec);
  }
}

/** Resolve a spec; its derived name is always a valid source name (spec §3), since config
 *  load refuses any other (k95). */
export function resolveSpec(spec: string, probe: Probe): ResolvedSpec {
  const r = resolveAddress(spec, probe);
  return isSourceName(r.derivedName) ? r : { ...r, derivedName: FALLBACK_NAME };
}

function resolveAddress(spec: string, probe: Probe): ResolvedSpec {
  const s = spec.trim();

  // 0. An address kept verbatim below would reach git as an option (k85).
  if (s.startsWith("-")) throw new SpecError(`cannot resolve "${spec}": a source must not start with "-"`);

  // 1. Local paths.
  if (isLocal(s)) {
    return { kind: "local", value: s, derivedName: normalizeName(basename(s)) };
  }

  // 2. Explicit URLs / scp-like git addresses: kept verbatim.
  if (hasScheme(s) || isScpLike(s)) {
    const kind: SourceKind = isTarball(s) ? "url" : "git";
    return { kind, value: s, derivedName: nameFromUrl(s, kind) };
  }

  // 3. github:owner/repo (manage-skills compatibility). An empty repo segment is skipped,
  //    as in 4. and 6., so `github:Getty/` is the default repo (k104).
  if (s.startsWith("github:")) {
    const path = s.slice("github:".length);
    const [owner, ...more] = path.split("/");
    if (!owner) throw new SpecError(`cannot resolve "${spec}": expected github:owner[/repo]`);
    const repo = more.find(Boolean);
    return {
      kind: "git",
      value: `https://github.com/${owner}/${repo ?? DEFAULT_REPO}`,
      derivedName: repoName(owner, repo),
    };
  }

  const slash = s.indexOf("/");
  const firstSeg = slash === -1 ? s : s.slice(0, slash);
  const rest = slash === -1 ? "" : s.slice(slash + 1);

  // 4. Known forge with an owner (never probed).
  if (KNOWN_FORGES.includes(firstSeg.toLowerCase()) && slash !== -1) {
    const segs = rest.split("/").filter(Boolean);
    const owner = segs[0];
    if (!owner) throw new SpecError(`cannot resolve "${spec}": expected ${firstSeg}/owner[/repo]`);
    const repo = segs[1] ?? DEFAULT_REPO;
    return {
      kind: "git",
      value: `https://${firstSeg.toLowerCase()}/${owner}/${repo}`,
      derivedName: repoName(owner, repo),
    };
  }

  // 5. Single token (no slash).
  if (slash === -1) {
    if (!firstSeg.includes(".")) {
      // A bare word -> GitHub owner with the default repo.
      return {
        kind: "git",
        value: `https://github.com/${firstSeg}/${DEFAULT_REPO}`,
        derivedName: normalizeName(firstSeg),
      };
    }
    // A dotted token -> generic host, default path /skills, probed.
    return probeGeneric(`https://${firstSeg}/${DEFAULT_REPO}`, firstSeg, spec, probe);
  }

  // 6. owner/repo where the first segment has no dot -> GitHub.
  if (!firstSeg.includes(".")) {
    const segs = rest.split("/").filter(Boolean);
    const repo = segs[0] ?? DEFAULT_REPO;
    return {
      kind: "git",
      value: `https://github.com/${firstSeg}/${repo}`,
      derivedName: repoName(firstSeg, repo),
    };
  }

  // 7. host.tld[/path] -> generic host, probed.
  const path = rest.replace(/\/+$/, "");
  const base = path ? `https://${firstSeg}/${path}` : `https://${firstSeg}/${DEFAULT_REPO}`;
  return probeGeneric(base, firstSeg, spec, probe);
}

function probeGeneric(baseUrl: string, host: string, original: string, probe: Probe): ResolvedSpec {
  const result = probe(baseUrl);
  if (result.git) {
    return { kind: "git", value: baseUrl, derivedName: normalizeName(host) };
  }
  if (result.tarball) {
    return { kind: "url", value: `${baseUrl}.tar.gz`, derivedName: normalizeName(host) };
  }
  throw new SpecError(
    `cannot resolve "${original}": neither ${baseUrl} (git) nor ${baseUrl}.tar.gz (tarball) responded`,
  );
}
