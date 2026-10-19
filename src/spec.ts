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
  /** The ref a GitHub tree link pins (k119); `add` stores it as the source's `ref`. */
  ref?: string;
  /** The directory a GitHub tree link leads into (k126), "/"-joined; `add` stores it as the
   *  source's `path`. Only ever beside a `ref`. */
  path?: string;
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

/** The known forges (never probed), by host, with the name their errors use. */
const FORGES: Record<string, string> = {
  "github.com": "GitHub", "gitlab.com": "GitLab", "codeberg.org": "Codeberg", "hf.co": "Hugging Face", "huggingface.co": "Hugging Face",
};
/** Whether a host is a known forge: an own key, never one inherited from Object.prototype (k144). */
const isForge = (host: string): boolean => Object.hasOwn(FORGES, host);
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

const WIN32 = process.platform === "win32";

/** Last non-empty path segment; on Windows "\" separates segments too. */
function basename(path: string): string {
  const parts = path.split(WIN32 ? /[\\/]/ : "/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function isLocal(spec: string): boolean {
  if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~")) return true;
  // Windows: a drive path (C:\x, C:/x), a UNC path, or .\x and ..\x.
  return WIN32 && (/^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith("\\\\") || /^\.\.?\\/.test(spec));
}

/** A scheme matches in any case (k109); `lowerScheme` stores it lower-case. */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?=\/\/)/i;

function hasScheme(spec: string): boolean {
  return SCHEME.test(spec);
}

function lowerScheme(spec: string): string {
  return spec.replace(SCHEME, (scheme) => scheme.toLowerCase());
}

/** git's remote-helper form `<transport>::<address>` (k118): git runs `git-remote-<transport>`
 *  with the address. The transport names that program, so it keeps its case, unlike a scheme. */
const TRANSPORT = /^[A-Za-z][A-Za-z0-9+.-]*::/;

/** The address of a `<transport>::<address>` spec; undefined for another form or no address. */
function helperAddress(spec: string): string | undefined {
  const m = TRANSPORT.exec(spec);
  return m && spec.length > m[0].length ? spec.slice(m[0].length) : undefined;
}

/** What an unknown prefix (k109), an empty source (k111) or an owner, repo or port no
 *  address takes (k117) is told. */
const FORMS = "expected a local path (/path, ./path, ../path, ~/path), scheme://..., transport::address, user@host:path, " +
  "github:owner[/repo], owner[/repo] or host.tld[/path]";

/** The characters GitHub allows in an owner and in a repo (k117). */
const GITHUB_OWNER = /^[A-Za-z0-9-]+$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/;
/** What no known forge's owner or repo holds (k117); their own rules differ. */
const NOT_IN_SEGMENT = /[\s\p{Cc}:@]/u;

/** A path segment that is empty or whitespace only is skipped (k104, k117). */
function filled(seg: string): boolean {
  return seg.trim() !== "";
}

/** A GitHub owner and repo (`undefined`: the default) as a shorthand gives them (k117). */
function checkGithub(spec: string, owner: string, repo: string | undefined): void {
  if (!GITHUB_OWNER.test(owner)) {
    throw new SpecError(`cannot resolve "${spec}": GitHub owner "${owner}" may only contain ASCII letters, digits and "-"; ${FORMS}`);
  }
  if (repo !== undefined && !GITHUB_REPO.test(repo)) {
    throw new SpecError(
      `cannot resolve "${spec}": GitHub repo "${repo}" may only contain ASCII letters, digits, ".", "_" and "-"; ${FORMS}`,
    );
  }
}

/** A known forge's link or shorthand (k119, k125, k126), from `host` (lower-case) and `rest`,
 *  what follows the host: the repository, at a ref when the link names a branch, tag or commit,
 *  its skills beneath a directory when it names one. The query and fragment are the page's
 *  (a forge escapes both in a ref and a path) and are cut; blank segments are skipped (k104,
 *  k117). Which segments are the repository and which the page is the forge's own shape:
 *  `<owner>/<repo>` (Hugging Face: `datasets/` or `spaces/` before it), on GitLab every segment
 *  before `/-/` (nested groups). A page that is no branch, tag, commit or directory of the
 *  repository, a file link and a link missing its ref are errors naming the repository. Ref and
 *  path are %-decoded segment by segment; the segment after a tree view is the ref, the rest
 *  the path (a ref with "/" writes it as %2F). `explicit`: the spec is an https:// URL, kept as
 *  written (the query and fragment cut) unless it names a page. */
function forgeLink(spec: string, written: string, rest: string, explicit?: string): ResolvedSpec {
  const host = written.toLowerCase();
  const forge = FORGES[host]!;
  const segs = rest.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  const hf = forge === "Hugging Face" && (segs[0] === "datasets" || segs[0] === "spaces");
  const prefix = hf ? [segs.shift()!] : [];
  const owner = segs[0];
  if (!owner?.trim()) {
    if (explicit !== undefined) return { kind: "git", value: explicit, derivedName: nameFromUrl(explicit, "git") };
    throw new SpecError(`cannot resolve "${spec}": expected ${written}/${prefix.map((p) => `${p}/`).join("")}owner[/repo]`);
  }
  const tail = segs.slice(1).filter(filled);
  let repoPath: string[];
  let view: string[];
  if (host === "gitlab.com") {
    const dash = tail.indexOf("-");
    repoPath = dash === -1 ? tail : tail.slice(0, dash);
    view = dash === -1 ? [] : tail.slice(dash + 1);
  } else {
    repoPath = tail.slice(0, 1);
    view = tail.slice(1);
  }
  const repo = repoPath[repoPath.length - 1];
  if (explicit !== undefined && view.length === 0) {
    return { kind: "git", value: explicit, derivedName: nameFromUrl(explicit, "git") };
  }
  if (host === "github.com") checkGithub(spec, owner, repo);
  else for (const seg of repoPath.length ? repoPath : [DEFAULT_REPO]) checkForge(spec, written, owner, seg);
  const value = `https://${host}/${[...prefix, owner, ...(repoPath.length ? repoPath : [DEFAULT_REPO])].join("/")}`;
  const resolved: ResolvedSpec = { kind: "git", value, derivedName: repoName(owner, repo) };
  if (view.length === 0) return resolved;

  const fail = (why: string): never => {
    throw new SpecError(`cannot resolve "${spec}": ${why}`);
  };
  const page = () => fail(`a ${forge} ${JSON.stringify(view.join("/"))} page is not a source; add ${value}`);
  const decode = (seg: string): string => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return fail(`${JSON.stringify(seg)} in the link is not a valid %-escape`);
    }
  };
  /** A tree link: `at` the index of its ref in `view`. */
  const tree = (at: number): ResolvedSpec => {
    if (view[at] === undefined) fail(`a ${forge} tree link without a ref; add ${value}`);
    const link: ResolvedSpec = { ...resolved, ref: decode(view[at]!) };
    const sub = view.slice(at + 1).map(decode);
    if (sub.length > 0) link.path = sub.join("/");
    return link;
  };
  /** A link naming one tag or commit: `at` the index of it in `view`, nothing after it. */
  const pin = (at: number, what: "release" | "commit"): ResolvedSpec => {
    if (view[at] === undefined) fail(`a ${forge} ${what} link without a ${what === "release" ? "tag" : "commit"}; add ${value}`);
    if (view.length > at + 1) page();
    return { ...resolved, ref: decode(view[at]!) };
  };
  /** A file link: `at` the index of its ref, `treeOf` the tree link pinning it. */
  const file = (at: number, treeOf: (ref: string) => string): never => {
    const ref = view[at];
    const pinned = ref === undefined ? "" : `, or ${treeOf(ref)} to pin ref "${ref}"`;
    return fail(`a ${forge} file link; a source is a repository, not a file: add ${value}${pinned}`);
  };
  const [v0, v1] = view;
  switch (forge) {
    case "GitHub":
    case "Hugging Face":
      if (v0 === "tree") return tree(1);
      if (v0 === "blob" || (forge === "Hugging Face" && (v0 === "resolve" || v0 === "raw"))) return file(1, (r) => `${value}/tree/${r}`);
      if (v0 === "commit") return pin(1, "commit");
      if (forge === "GitHub" && v0 === "releases" && v1 === "tag") return pin(2, "release");
      return page();
    case "GitLab":
      if (v0 === "tree") return tree(1);
      if (v0 === "blob" || v0 === "raw") return file(1, (r) => `${value}/-/tree/${r}`);
      if (v0 === "commit") return pin(1, "commit");
      if (v0 === "tags" || v0 === "releases") return pin(1, "release");
      return page();
    default: { // Codeberg (Forgejo): src|raw|media/branch|tag|commit/<ref>
      const kinds = ["branch", "tag", "commit"];
      if (v0 === "src" && v1 !== undefined && kinds.includes(v1)) return tree(2);
      if (v0 === "src" && v1 === undefined) return fail(`a ${forge} tree link without a ref; add ${value}`);
      if ((v0 === "raw" || v0 === "media") && v1 !== undefined && kinds.includes(v1)) return file(2, (r) => `${value}/src/${v1}/${r}`);
      if (v0 === "commit") return pin(1, "commit");
      if (v0 === "releases" && v1 === "tag") return pin(2, "release");
      return page();
    }
  }
}

/** Another known forge's owner and repo (k117): only what none of them takes is refused. */
function checkForge(spec: string, forge: string, owner: string, repo: string): void {
  for (const [what, seg] of [["owner", owner], ["repo", repo]] as const) {
    if (NOT_IN_SEGMENT.test(seg)) {
      throw new SpecError(
        `cannot resolve "${spec}": ${forge} ${what} "${seg}" must not contain whitespace, control characters, ":" or "@"; ${FORMS}`,
      );
    }
  }
}

function isScpLike(spec: string): boolean {
  // git@host:owner/repo.git
  return /^[^@/]+@[^:/]+:/.test(spec);
}

/** `.tar.gz` or `.tgz`, in any case (k117). */
function isTarball(url: string): boolean {
  return /\.(?:tar\.gz|tgz)$/i.test(url);
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

/** derivedName for `<transport>::<address>` (k118): an explicit or scp-like address named as
 *  one (`us-east-1://profile@my-repo` → "my-repo", as `codecommit://profile@my-repo`), any
 *  other by its path as a git repo (`/srv/repo.git` → "repo"). */
function nameFromHelper(address: string): string {
  return hasScheme(address) || isScpLike(address) ? nameFromUrl(address, "git") : nameFromPath(address);
}

/** Resolve a spec; its derived name is always a valid source name (spec §3), since config
 *  load refuses any other (k95). */
export function resolveSpec(spec: string, probe: Probe): ResolvedSpec {
  const r = resolveAddress(spec, probe);
  return isSourceName(r.derivedName) ? r : { ...r, derivedName: FALLBACK_NAME };
}

function resolveAddress(spec: string, probe: Probe): ResolvedSpec {
  const s = spec.trim();

  // 0. An empty spec would be a bare word, stored as https://github.com//skills (k111); an
  //    address kept verbatim below would reach git as an option (k85).
  if (!s) throw new SpecError(`cannot resolve "${spec}": empty source; ${FORMS}`);
  if (s.startsWith("-")) throw new SpecError(`cannot resolve "${spec}": a source must not start with "-"`);

  // 1. Local paths.
  if (isLocal(s)) {
    return { kind: "local", value: s, derivedName: normalizeName(basename(s)) };
  }

  // 2. Explicit URLs / scp-like git addresses: kept verbatim, but for a lower-case scheme. Any
  //    scheme is git's to judge: a remote helper (`codecommit://`, `s3://`) fetches its own (k117).
  //    git's `<transport>::<address>` comes first, as git reads it, and is kept exactly as
  //    written, never a url: `codecommit::us-east-1://my-repo` (k118). An https:// link to a
  //    known forge is read as in 4. (k119, k125, k126): a repository link loses only its query
  //    and fragment, a branch, tag, commit or directory link is the repo at that ref.
  const address = helperAddress(s);
  if (address !== undefined) return { kind: "git", value: s, derivedName: nameFromHelper(address) };
  if (hasScheme(s) || isScpLike(s)) {
    const value = lowerScheme(s);
    const kind: SourceKind = isTarball(value) ? "url" : "git";
    const forge = /^https:\/\/([^/?#]+)\//.exec(value);
    if (kind === "git" && forge && isForge(forge[1]!.toLowerCase())) {
      return forgeLink(spec, forge[1]!, value.slice(forge[0].length), value.split(/[?#]/, 1)[0]!);
    }
    return { kind, value, derivedName: nameFromUrl(value, kind) };
  }

  // 3. github:owner/repo (manage-skills compatibility), in any case (k109). An empty or blank
  //    repo segment is skipped, as in 4. and 6., so `github:Getty/` is the default repo (k104,
  //    k117); a blank owner is as empty as none (k111). Owner and repo take GitHub's characters;
  //    what follows the repo reads as a github.com link does (k125).
  if (/^github:/i.test(s)) {
    const path = s.slice("github:".length);
    if (!path.split(/[/?#]/, 1)[0]!.trim()) throw new SpecError(`cannot resolve "${spec}": expected github:owner[/repo]`);
    return forgeLink(spec, "github.com", path);
  }

  const slash = s.indexOf("/");
  const firstSeg = slash === -1 ? s : s.slice(0, slash);
  const rest = slash === -1 ? "" : s.slice(slash + 1);

  // 4. Known forge with an owner (never probed); github.com takes GitHub's characters, another
  //    forge whatever a URL path segment holds but whitespace, control characters, ":" and "@".
  //    A browser link (github.com/o/r/tree/<ref>[/<dir>], gitlab.com/g/r/-/tree/<ref>, …) is the
  //    repo at that ref, its skills beneath <dir> when the link names one (k119, k125, k126).
  if (isForge(firstSeg.toLowerCase()) && slash !== -1) return forgeLink(spec, firstSeg, rest);

  // 5. and 6. take a first segment without a dot as a GitHub owner, which cannot contain a
  //    colon: `gitlab:u/r` is an unknown prefix, never https://github.com/gitlab:u/r (k109).
  const colon = firstSeg.indexOf(":");
  if (colon !== -1 && !firstSeg.includes(".")) {
    throw new SpecError(`cannot resolve "${spec}": unknown prefix "${firstSeg.slice(0, colon + 1)}"; ${FORMS}`);
  }

  // 5. and 7. take a colon after a dotted host as its port, a number: `github.com:Getty/karr`
  //    is never probed as https://github.com:Getty/karr (k117). A colon before an "@" is userinfo.
  const hostPort = firstSeg.slice(firstSeg.lastIndexOf("@") + 1);
  const portAt = hostPort.indexOf(":");
  if (portAt !== -1 && !/^\d+$/.test(hostPort.slice(portAt + 1))) {
    throw new SpecError(
      `cannot resolve "${spec}": port "${hostPort.slice(portAt + 1)}" of ${hostPort.slice(0, portAt)} is not a number; ${FORMS}`,
    );
  }

  // 5. Single token (no slash).
  if (slash === -1) {
    if (!firstSeg.includes(".")) {
      // A bare word -> GitHub owner with the default repo.
      checkGithub(spec, firstSeg, undefined);
      return {
        kind: "git",
        value: `https://github.com/${firstSeg}/${DEFAULT_REPO}`,
        derivedName: normalizeName(firstSeg),
      };
    }
    // A dotted token -> generic host, default path /skills, probed.
    return probeGeneric(`https://${firstSeg}/${DEFAULT_REPO}`, firstSeg, spec, probe);
  }

  // 6. owner/repo where the first segment has no dot -> GitHub, read as a github.com link (k125).
  if (!firstSeg.includes(".")) return forgeLink(spec, "github.com", s);

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
