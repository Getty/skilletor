// Table test for shorthand resolution (spec §4.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpec, SpecError, type Probe } from "../src/spec.ts";

// A probe that never runs; used for rows that must not be probed.
const noProbe: Probe = () => {
  throw new Error("probe must not be called for this spec");
};

interface Row {
  spec: string;
  kind: "git" | "url" | "local";
  value: string;
  name: string;
  /** The ref a GitHub tree link pins (k119); every other row has none. */
  ref?: string;
}

// Deterministic rows: known forms that never hit the probe.
const rows: Row[] = [
  { spec: "/abs/path/myskills", kind: "local", value: "/abs/path/myskills", name: "myskills" },
  { spec: "./rel", kind: "local", value: "./rel", name: "rel" },
  { spec: "~/dev/skills", kind: "local", value: "~/dev/skills", name: "skills" },
  { spec: "../up/skills/", kind: "local", value: "../up/skills/", name: "skills" },
  { spec: "https://github.com/Getty/skills", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "https://example.com/s.tar.gz", kind: "url", value: "https://example.com/s.tar.gz", name: "example-com" },
  { spec: "https://example.com/s.tgz", kind: "url", value: "https://example.com/s.tgz", name: "example-com" },
  { spec: "git@github.com:Getty/skills.git", kind: "git", value: "git@github.com:Getty/skills.git", name: "getty" },
  { spec: "ssh://git@example.com/Getty/skills", kind: "git", value: "ssh://git@example.com/Getty/skills", name: "getty" },
  { spec: "github:Getty/repo", kind: "git", value: "https://github.com/Getty/repo", name: "repo" },
  { spec: "Getty", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "GETTY", kind: "git", value: "https://github.com/GETTY/skills", name: "getty" },
  { spec: "Getty/repo", kind: "git", value: "https://github.com/Getty/repo", name: "repo" },
  { spec: "hf.co/user", kind: "git", value: "https://hf.co/user/skills", name: "user" },
  { spec: "hf.co/user/repo", kind: "git", value: "https://hf.co/user/repo", name: "repo" },
  { spec: "huggingface.co/user", kind: "git", value: "https://huggingface.co/user/skills", name: "user" },
  { spec: "codeberg.org/u", kind: "git", value: "https://codeberg.org/u/skills", name: "u" },
  { spec: "gitlab.com/u/r", kind: "git", value: "https://gitlab.com/u/r", name: "r" },
];

// k101: a git spec naming a repo other than the default `skills` derives the repo's name
// (normalized, `.git` stripped), so `Getty/karr` and `Getty` no longer both become "getty".
// A default-repo spec, a generic probed host, a url and a local path keep their names.
const k101Rows: Row[] = [
  { spec: "Getty/karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "obra/superpowers", kind: "git", value: "https://github.com/obra/superpowers", name: "superpowers" },
  { spec: "github:Getty/karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "gitlab.com/u/tools", kind: "git", value: "https://gitlab.com/u/tools", name: "tools" },
  { spec: "Getty/My_Repo.git", kind: "git", value: "https://github.com/Getty/My_Repo.git", name: "my-repo" },
  { spec: "https://github.com/Getty/karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "https://github.com/Getty/karr.git", kind: "git", value: "https://github.com/Getty/karr.git", name: "karr" },
  { spec: "https://github.com/Getty/karr/", kind: "git", value: "https://github.com/Getty/karr/", name: "karr" },
  { spec: "git@github.com:Getty/karr.git", kind: "git", value: "git@github.com:Getty/karr.git", name: "karr" },
  { spec: "ssh://git@example.com/Getty/karr.git", kind: "git", value: "ssh://git@example.com/Getty/karr.git", name: "karr" },
  // The repo is the last path segment, as `git clone` names its directory.
  { spec: "https://gitlab.com/group/sub/Tools.git", kind: "git", value: "https://gitlab.com/group/sub/Tools.git", name: "tools" },
  // Default repo: the owner, as before.
  { spec: "anthropics", kind: "git", value: "https://github.com/anthropics/skills", name: "anthropics" },
  { spec: "github:Getty", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "Getty/skills", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "Getty/Skills.git", kind: "git", value: "https://github.com/Getty/Skills.git", name: "getty" },
  { spec: "github.com/u", kind: "git", value: "https://github.com/u/skills", name: "u" },
  { spec: "gitlab.com/u/skills", kind: "git", value: "https://gitlab.com/u/skills", name: "u" },
  { spec: "https://github.com/Getty/skills.git", kind: "git", value: "https://github.com/Getty/skills.git", name: "getty" },
  { spec: "https://gitlab.com/group/sub/skills", kind: "git", value: "https://gitlab.com/group/sub/skills", name: "group" },
  // One path segment: that segment, as before.
  { spec: "https://example.com/Tools.git", kind: "git", value: "https://example.com/Tools.git", name: "tools" },
  { spec: "git@example.com:tools.git", kind: "git", value: "git@example.com:tools.git", name: "tools" },
  // url and local: unchanged.
  { spec: "https://example.com/org/pack.tar.gz", kind: "url", value: "https://example.com/org/pack.tar.gz", name: "example-com" },
  { spec: "~/dev/karr", kind: "local", value: "~/dev/karr", name: "karr" },
];

// k104: an empty path segment is skipped, so a missing repo means the default repo in every
// git shorthand. `github:` used to keep the empty segment and store `https://github.com/Getty/`.
const k104Rows: Row[] = [
  { spec: "github:Getty/", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "github:Getty//", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "github:Getty//karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  // The sibling forms already skip empty segments; pinned so all three agree.
  { spec: "Getty/", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "Getty//karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "github.com/Getty/", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "github.com/Getty//karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "gitlab.com/u/", kind: "git", value: "https://gitlab.com/u/skills", name: "u" },
];

// k109: a scheme or `github:` in another case fell through to owner/repo and became a GitHub
// owner with a colon (`HTTPS://host/x.tar.gz` -> https://github.com/HTTPS:/host). Both match
// case-insensitively; the stored scheme is lower-case, host and path stay as written.
const k109Rows: Row[] = [
  { spec: "GitHub:Getty", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "GITHUB:Getty/karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "Github:Getty/", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "HTTPS://host/x.tar.gz", kind: "url", value: "https://host/x.tar.gz", name: "host" },
  { spec: "HTTPS://Host/X.tar.gz", kind: "url", value: "https://Host/X.tar.gz", name: "host" },
  { spec: "Https://github.com/Getty/karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "SSH://git@Example.com/Getty/Karr.git", kind: "git", value: "ssh://git@Example.com/Getty/Karr.git", name: "karr" },
  { spec: "Git+SSH://git@host/o/r", kind: "git", value: "git+ssh://git@host/o/r", name: "r" },
  { spec: "HTTP://Host/x.tar.gz", kind: "url", value: "http://Host/x.tar.gz", name: "host" },
  { spec: "FILE:///Tmp/X", kind: "git", value: "file:///Tmp/X", name: "x" },
];

// k109, pinned: colon-bearing forms that resolved to a working address keep their result.
const k109Pinned: Row[] = [
  { spec: "http://host/x.tar.gz", kind: "url", value: "http://host/x.tar.gz", name: "host" },
  { spec: "file:///tmp/x", kind: "git", value: "file:///tmp/x", name: "x" },
  { spec: "git://example.com/Getty/karr", kind: "git", value: "git://example.com/Getty/karr", name: "karr" },
  { spec: "git+ssh://git@host/o/r", kind: "git", value: "git+ssh://git@host/o/r", name: "r" },
  { spec: "Git@GitHub.com:Getty/karr.git", kind: "git", value: "Git@GitHub.com:Getty/karr.git", name: "karr" },
  { spec: "user:pw@host:o/r", kind: "git", value: "user:pw@host:o/r", name: "r" },
  { spec: "/abs/with:colon", kind: "local", value: "/abs/with:colon", name: "with-colon" },
  { spec: "./rel:colon", kind: "local", value: "./rel:colon", name: "rel-colon" },
  { spec: "../x:y", kind: "local", value: "../x:y", name: "x-y" },
  { spec: "~/dir:x", kind: "local", value: "~/dir:x", name: "dir-x" },
];

// k117, pinned: forms next to the new owner, repo and port rules keep their result – a
// GitHub owner or repo of the characters GitHub allows, a known forge's owner or repo with
// characters GitHub would not take (`.`, `_`), segments past the repo ignored, an explicit URL
// verbatim whatever its path holds, and a git source of any scheme: git and its remote helpers
// (`codecommit://`, `persistent-https://`) decide what they fetch, so `foo://bar` fails there.
const k117Pinned: Row[] = [
  { spec: "my-org/my.repo_x", kind: "git", value: "https://github.com/my-org/my.repo_x", name: "my-repo-x" },
  { spec: "github:my-org/my.repo_x", kind: "git", value: "https://github.com/my-org/my.repo_x", name: "my-repo-x" },
  { spec: "github.com/my-org/my.repo_x", kind: "git", value: "https://github.com/my-org/my.repo_x", name: "my-repo-x" },
  { spec: "123/456", kind: "git", value: "https://github.com/123/456", name: "456" },
  { spec: "gitlab.com/group.name/sub_repo", kind: "git", value: "https://gitlab.com/group.name/sub_repo", name: "sub-repo" },
  { spec: "codeberg.org/user_name/re.po", kind: "git", value: "https://codeberg.org/user_name/re.po", name: "re-po" },
  { spec: "hf.co/Org-X/model_1", kind: "git", value: "https://hf.co/Org-X/model_1", name: "model-1" },
  { spec: "github:Getty/karr/tree/main", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "Getty/karr/extra", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "https://github.com//skills", kind: "git", value: "https://github.com//skills", name: "skills" },
  { spec: "https://github.com/a b/re:po", kind: "git", value: "https://github.com/a b/re:po", name: "re-po" },
  { spec: "ssh+git://git@host/o/r", kind: "git", value: "ssh+git://git@host/o/r", name: "r" },
  { spec: "ftp://host.example/o/r", kind: "git", value: "ftp://host.example/o/r", name: "r" },
  { spec: "foo://bar", kind: "git", value: "foo://bar", name: "bar" },
  { spec: "FOO://bar", kind: "git", value: "foo://bar", name: "bar" },
  { spec: "codecommit://my-repo", kind: "git", value: "codecommit://my-repo", name: "my-repo" },
  { spec: "persistent-https://host/o/r", kind: "git", value: "persistent-https://host/o/r", name: "r" },
];

// k117: a tarball extension in another case resolved as git (`https://host/X.TAR.GZ` a git source
// named "x-tar-gz"), and a repo segment of blanks was the repo (`github:Getty/ /x` ->
// https://github.com/Getty/ ). Asserts: `.tar.gz`/`.tgz` match in any case, the address kept as
// written; a whitespace-only repo segment is skipped like an empty one (k104), in every form.
const k117Rows: Row[] = [
  { spec: "https://host/X.TAR.GZ", kind: "url", value: "https://host/X.TAR.GZ", name: "host" },
  { spec: "https://host/x.TGZ", kind: "url", value: "https://host/x.TGZ", name: "host" },
  { spec: "HTTPS://Host/X.Tar.Gz", kind: "url", value: "https://Host/X.Tar.Gz", name: "host" },
  { spec: "git@host.example:team/X.TGZ", kind: "url", value: "git@host.example:team/X.TGZ", name: "team" },
  { spec: "github:Getty/ /x", kind: "git", value: "https://github.com/Getty/x", name: "x" },
  { spec: "github:Getty/ /", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "Getty/ /karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "Getty/\t/", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "github.com/Getty/ /karr", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "gitlab.com/u/ /r", kind: "git", value: "https://gitlab.com/u/r", name: "r" },
];

// k118: git's remote-helper form `<transport>::<address>` (`codecommit::us-east-1://my-repo`, AWS
// CodeCommit with a region) was the unknown prefix "codecommit:" (k109), before k109 a stored
// https://github.com/codecommit::us-east-1:/my-repo. Asserts: a transport – a letter, then
// letters, digits, "+", "." or "-" – with "::" and a non-empty address is a git source kept
// exactly as written (the transport's case, the address's scheme, a tarball extension, an
// scp-like address) and named as its address would be: an explicit or scp-like address as an
// explicit one is (`us-east-1://profile@my-repo` -> my-repo, as `codecommit://profile@my-repo`),
// any other by its path as a git repo (k101).
const k118Rows: Row[] = [
  { spec: "codecommit::us-east-1://my-repo", kind: "git", value: "codecommit::us-east-1://my-repo", name: "my-repo" },
  { spec: "codecommit::us-east-1://profile@my-repo", kind: "git", value: "codecommit::us-east-1://profile@my-repo", name: "my-repo" },
  { spec: "CodeCommit::US-East-1://Profile@My-Repo", kind: "git", value: "CodeCommit::US-East-1://Profile@My-Repo", name: "my-repo" },
  { spec: " codecommit::eu-west-1://tools ", kind: "git", value: "codecommit::eu-west-1://tools", name: "tools" },
  { spec: "hg::https://hg.example.com/team/tools", kind: "git", value: "hg::https://hg.example.com/team/tools", name: "tools" },
  { spec: "hg::HTTPS://Host/Getty/skills", kind: "git", value: "hg::HTTPS://Host/Getty/skills", name: "getty" },
  { spec: "hg::https://host/x.tar.gz", kind: "git", value: "hg::https://host/x.tar.gz", name: "x-tar-gz" },
  { spec: "gcrypt::rsync://host/path/repo.git", kind: "git", value: "gcrypt::rsync://host/path/repo.git", name: "repo" },
  { spec: "gcrypt::git@host:team/secret.git", kind: "git", value: "gcrypt::git@host:team/secret.git", name: "secret" },
  { spec: "testgit::/srv/git/repo.git", kind: "git", value: "testgit::/srv/git/repo.git", name: "repo" },
  { spec: "bzr::lp:project", kind: "git", value: "bzr::lp:project", name: "lp-project" },
  { spec: "my.helper+x-1::addr", kind: "git", value: "my.helper+x-1::addr", name: "addr" },
  // git reads "::" before any other form, so `github::` names a helper; `github:` is the shorthand.
  { spec: "github::Getty", kind: "git", value: "github::Getty", name: "getty" },
];

// k119: a GitHub browser link was an explicit URL kept verbatim (`https://github.com/Getty/karr/
// tree/main`, a git source no fetch serves, named "main") or a known-forge shorthand whose
// segments past the repo were dropped (`github.com/Getty/karr/tree/main` tracked HEAD). Asserts:
// `[https://]github.com/<owner>/<repo>/tree/<ref>[/]` – scheme and host in any case, a blank
// segment skipped, a `?query` or `#fragment` ignored – is git https://github.com/<owner>/<repo>
// with that ref, named after the repo (k101), never probed; the ref is taken as written, config
// load judges it (k110).
const k119Rows: Row[] = [
  { spec: "https://github.com/Getty/karr/tree/main", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "main" },
  { spec: "github.com/Getty/karr/tree/main", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "main" },
  { spec: "https://github.com/Getty/karr/tree/main/", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "main" },
  { spec: " github.com/Getty/karr/tree/v1.2.0/ ", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "v1.2.0" },
  { spec: "HTTPS://GitHub.com/Getty/Karr/tree/v1", kind: "git", value: "https://github.com/Getty/Karr", name: "karr", ref: "v1" },
  { spec: "GitHub.com/Getty/karr/tree/0f3a9c1", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "0f3a9c1" },
  { spec: "github.com/Getty/skills/tree/main", kind: "git", value: "https://github.com/Getty/skills", name: "getty", ref: "main" },
  { spec: "https://github.com/obra/superpowers/tree/release-1.x", kind: "git", value: "https://github.com/obra/superpowers", name: "superpowers", ref: "release-1.x" },
  { spec: "github.com/Getty//karr/tree/main", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "main" },
  { spec: "https://github.com/Getty/karr/tree/main~1", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "main~1" },
  // A heading anchor or a view query is the page's, not the ref's: GitHub escapes "#" and "?" in a ref.
  { spec: "https://github.com/Getty/karr/tree/main#installation", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "main" },
  { spec: "github.com/Getty/karr/tree/v1?tab=readme-ov-file", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "v1" },
  { spec: "https://github.com/Getty/karr/tree/v1/?x=a/b#c/d", kind: "git", value: "https://github.com/Getty/karr", name: "karr", ref: "v1" },
];

// k119, pinned: forms next to a GitHub browser link keep their result – no ref, as before. Only
// github.com links map to a ref: `http://`, `www.` and another forge's link (`/-/tree/` on
// GitLab) stay what they were, as do the `github:` and owner/repo shorthands, a repo named
// "tree" or "blob", and a GitHub archive tarball.
// (`github:Getty/karr/tree/main` is pinned in k117Pinned.)
const k119Pinned: Row[] = [
  { spec: "Getty/karr/tree/main", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "github.com/Getty/karr/issues", kind: "git", value: "https://github.com/Getty/karr", name: "karr" },
  { spec: "github.com/Getty/tree", kind: "git", value: "https://github.com/Getty/tree", name: "tree" },
  { spec: "github.com/tree/blob", kind: "git", value: "https://github.com/tree/blob", name: "blob" },
  { spec: "https://github.com/Getty/tree", kind: "git", value: "https://github.com/Getty/tree", name: "tree" },
  { spec: "http://github.com/Getty/karr/tree/main", kind: "git", value: "http://github.com/Getty/karr/tree/main", name: "main" },
  { spec: "https://www.github.com/Getty/karr/tree/main", kind: "git", value: "https://www.github.com/Getty/karr/tree/main", name: "main" },
  { spec: "https://gitlab.com/u/r/-/tree/main", kind: "git", value: "https://gitlab.com/u/r/-/tree/main", name: "main" },
  { spec: "gitlab.com/u/r/-/tree/main", kind: "git", value: "https://gitlab.com/u/r", name: "r" },
  { spec: "codeberg.org/u/r/src/branch/main", kind: "git", value: "https://codeberg.org/u/r", name: "r" },
  {
    spec: "https://github.com/Getty/karr/archive/refs/tags/v1.tar.gz", kind: "url",
    value: "https://github.com/Getty/karr/archive/refs/tags/v1.tar.gz", name: "github-com",
  },
];

const allRows = [
  ...rows, ...k101Rows, ...k104Rows, ...k109Rows, ...k109Pinned, ...k117Pinned, ...k117Rows, ...k118Rows, ...k119Rows,
  ...k119Pinned,
];

for (const row of allRows) {
  test(`resolves ${row.spec}`, () => {
    const r = resolveSpec(row.spec, noProbe);
    assert.equal(r.kind, row.kind, "kind");
    assert.equal(r.value, row.value, "value");
    assert.equal(r.derivedName, row.name, "derivedName");
    assert.equal(r.ref, row.ref, "ref");
  });
}

// Generic hosts (first segment has a dot, not a known forge): must be probed.

test("generic host, probe says git", () => {
  const probe: Probe = (url) => {
    assert.equal(url, "https://host.tld/skills");
    return { git: true };
  };
  const r = resolveSpec("host.tld", probe);
  assert.deepEqual(r, { kind: "git", value: "https://host.tld/skills", derivedName: "host-tld" });
});

test("generic host with trailing slash defaults to /skills", () => {
  const r = resolveSpec("host.tld/", () => ({ git: true }));
  assert.equal(r.value, "https://host.tld/skills");
});

test("k101: a probed generic host keeps the host's name, whatever its path", () => {
  const r = resolveSpec("mydir.com/team/tools", () => ({ git: true }));
  assert.deepEqual(r, { kind: "git", value: "https://mydir.com/team/tools", derivedName: "mydir-com" });
});

test("generic host with a path, probe says tarball", () => {
  const probe: Probe = (url) => {
    assert.equal(url, "https://mydir.com/x");
    return { tarball: true };
  };
  const r = resolveSpec("mydir.com/x", probe);
  assert.deepEqual(r, { kind: "url", value: "https://mydir.com/x.tar.gz", derivedName: "mydir-com" });
});

test("generic host where nothing responds errors with both attempted addresses", () => {
  assert.throws(
    () => resolveSpec("host.tld", () => ({})),
    (e: unknown) => {
      assert.ok(e instanceof SpecError);
      assert.match((e as Error).message, /https:\/\/host\.tld\/skills/);
      assert.match((e as Error).message, /https:\/\/host\.tld\/skills\.tar\.gz/);
      return true;
    },
  );
});

test("owner/repo with a dotted first segment is a generic host, not GitHub", () => {
  // Ensures the discriminator is "first segment has a dot" -> probe.
  let probed = false;
  resolveSpec("mydir.com/x", () => {
    probed = true;
    return { git: true };
  });
  assert.equal(probed, true);
});

test("k104: github: with an empty owner is still an error", () => {
  assert.throws(() => resolveSpec("github:/karr", noProbe), (e: unknown) => {
    assert.ok(e instanceof SpecError);
    assert.equal((e as Error).message, 'cannot resolve "github:/karr": expected github:owner[/repo]');
    return true;
  });
});

// What a spec no form takes is told (k109, k111), git's transport::address among them (k118).
const forms = "expected a local path (/path, ./path, ../path, ~/path), scheme://..., transport::address, user@host:path, " +
  "github:owner[/repo], owner[/repo] or host.tld[/path]";

// k109: a first segment without a dot is a GitHub owner, which cannot contain a colon, so a
// prefix no form supports (`gitlab:u/r` -> https://github.com/gitlab:u/r) was stored as a broken
// URL. Asserts: each such spec is a SpecError naming the spec, its prefix and the supported
// forms, the probe never called; `github:` in another case keeps its own empty-owner error.
test("k109: an unknown word: prefix is a SpecError, never a GitHub owner, never probed", () => {
  const cases: [string, string][] = [
    ["gitlab:u/r", "gitlab:"], ["Gitlab:u/r", "Gitlab:"], ["gitlab:u", "gitlab:"], ["bitbucket:team/repo", "bitbucket:"],
    ["HTTPS:/host", "HTTPS:"], ["https:host", "https:"], ["localhost:8080", "localhost:"], ["localhost:8080/x", "localhost:"],
    [":foo", ":"], ["user:pw@localhost/x", "user:"],
    // On Windows a drive path is a local source.
    ...(process.platform === "win32" ? [] : [["C:\\skills", "C:"] as [string, string]]),
  ];
  for (const [spec, prefix] of cases) {
    assert.throws(() => resolveSpec(spec, noProbe), (e: unknown) => {
      assert.ok(e instanceof SpecError, `${spec}: ${String(e)}`);
      assert.equal((e as Error).message, `cannot resolve "${spec}": unknown prefix "${prefix}"; ${forms}`);
      return true;
    });
  }
  assert.throws(() => resolveSpec("GitHub:/karr", noProbe), (e: unknown) => {
    assert.ok(e instanceof SpecError);
    assert.equal((e as Error).message, 'cannot resolve "GitHub:/karr": expected github:owner[/repo]');
    return true;
  });
});

// k109, pinned: a colon after a dotted first segment is a port or userinfo of a generic host,
// probed as before.
test("k109: a dotted host keeps its port or userinfo and is probed as before", () => {
  const cases: [string, string, string][] = [
    ["mydir.com:8080/x", "https://mydir.com:8080/x", "mydir-com-8080"],
    ["mydir.com:8080", "https://mydir.com:8080/skills", "mydir-com-8080"],
    ["user:pw@host.tld/x", "https://user:pw@host.tld/x", "user-pw-host-tld"],
  ];
  for (const [spec, url, name] of cases) {
    const probed: string[] = [];
    const r = resolveSpec(spec, (u) => {
      probed.push(u);
      return { git: true };
    });
    assert.deepEqual(probed, [url], spec);
    assert.deepEqual(r, { kind: "git", value: url, derivedName: name }, spec);
  }
});

// k111: an empty spec fell through to a bare word and became git https://github.com//skills
// (named "source"), and an owner of blanks became https://github.com/ /karr. Asserts: an empty
// or whitespace-only spec is a SpecError naming the spec, the problem and the supported forms;
// a github: or known-forge owner of whitespace only is that form's empty-owner error, as the
// empty owners already were; the probe never called.
test("k111: an empty spec or a blank owner is a SpecError, never https://github.com//skills, never probed", () => {
  for (const spec of ["", " ", "  \t\n "]) {
    assert.throws(() => resolveSpec(spec, noProbe), (e: unknown) => {
      assert.ok(e instanceof SpecError, `${JSON.stringify(spec)}: ${String(e)}`);
      assert.equal((e as Error).message, `cannot resolve "${spec}": empty source; ${forms}`);
      return true;
    });
  }
  const owners: [string, string][] = [
    ["github: /karr", "github:owner[/repo]"], ["GitHub:\t/karr", "github:owner[/repo]"],
    ["github.com/ /karr", "github.com/owner[/repo]"], ["gitlab.com/ /r", "gitlab.com/owner[/repo]"],
    // Already errors; pinned so the empty and the blank owner agree.
    ["github:", "github:owner[/repo]"], ["github: ", "github:owner[/repo]"], ["github.com/", "github.com/owner[/repo]"],
  ];
  for (const [spec, form] of owners) {
    assert.throws(() => resolveSpec(spec, noProbe), (e: unknown) => {
      assert.ok(e instanceof SpecError, `${JSON.stringify(spec)}: ${String(e)}`);
      assert.equal((e as Error).message, `cannot resolve "${spec}": expected ${form}`);
      return true;
    });
  }
});

/** Assert `spec` is a SpecError with exactly `message`, the probe never called. */
function refused(spec: string, message: string): void {
  assert.throws(() => resolveSpec(spec, noProbe), (e: unknown) => {
    assert.ok(e instanceof SpecError, `${JSON.stringify(spec)}: ${String(e)}`);
    assert.equal((e as Error).message, message);
    return true;
  });
}

// k117: resolveSpec stored shorthands no forge can serve and probed a typo. A GitHub owner or
// repo took any character (`github:gitlab:u` -> https://github.com/gitlab:u/skills, `Getty/re:po`,
// `@`, `a b`, `github: Getty`), so did a known forge's (`gitlab.com/a b/r`); a colon after a
// dotted host was a port whatever followed (`github.com:Getty/karr` probed as
// https://github.com:Getty/karr). Asserts: each is a SpecError naming the spec and the offending
// segment or port, never probed – a GitHub owner of ASCII letters, digits and "-" (github:,
// owner[/repo], a bare owner, github.com/), a GitHub repo of those and "." "_"; another known
// forge's owner or repo only without whitespace, control characters, ":" and "@"; a port of digits.
test("k117: an owner, repo or port no forge takes is a SpecError, never stored, never probed", () => {
  const owner = (seg: string) => `GitHub owner "${seg}" may only contain ASCII letters, digits and "-"`;
  const repo = (seg: string) => `GitHub repo "${seg}" may only contain ASCII letters, digits, ".", "_" and "-"`;
  const github: [string, string][] = [
    ["github:gitlab:u", owner("gitlab:u")], ["GitHub:HTTPS://x", owner("HTTPS:")], // (1)
    ["Getty/re:po", repo("re:po")], ["github:Getty/re:po", repo("re:po")], // (2)
    ["@", owner("@")], ["@/karr", owner("@")], // (6)
    ["a b", owner("a b")], ["a b/karr", owner("a b")], ["github: Getty", owner(" Getty")], // (7)
    ["___", owner("___")], ["Gétty/karr", owner("Gétty")], ["github.com/a_b/r", owner("a_b")],
    ["github:Getty/re po", repo("re po")], ["github.com/Getty/re@po", repo("re@po")], ["GitHub.com/u/r!", repo("r!")],
  ];
  for (const [spec, why] of github) refused(spec, `cannot resolve "${spec}": ${why}; ${forms}`);

  const lenient = (host: string, what: string, seg: string) =>
    `${host} ${what} "${seg}" must not contain whitespace, control characters, ":" or "@"`;
  const forge: [string, string][] = [
    ["gitlab.com/a b/r", lenient("gitlab.com", "owner", "a b")],
    ["codeberg.org/u:x/r", lenient("codeberg.org", "owner", "u:x")],
    ["hf.co/u/re@po", lenient("hf.co", "repo", "re@po")],
    ["huggingface.co/u/r\x01", lenient("huggingface.co", "repo", "r\x01")],
    ["GitLab.com/u/re po", lenient("GitLab.com", "repo", "re po")],
  ];
  for (const [spec, why] of forge) refused(spec, `cannot resolve "${spec}": ${why}; ${forms}`);

  const ports: [string, string, string][] = [ // (3)
    ["github.com:Getty/karr", "Getty", "github.com"], ["gitlab.com:u/r", "u", "gitlab.com"],
    ["host.tld:/x", "", "host.tld"], ["mydir.com:80a/x", "80a", "mydir.com"], ["mydir.com:x", "x", "mydir.com"],
    ["gitlab:u.x/r", "u.x", "gitlab"],
  ];
  for (const [spec, port, host] of ports) {
    refused(spec, `cannot resolve "${spec}": port "${port}" of ${host} is not a number; ${forms}`);
  }
});

// k118, pinned: only `<transport>::<address>` is git's form. Asserts: a single colon
// (`gitlab:u/r`, `codecommit:us-east-1://my-repo`), a "::" without an address, and a "::" after
// no transport word (a leading digit, an "_", nothing) stay k109's unknown prefix, never probed.
test("k118: a single colon, an empty address or no transport word stays an unknown prefix", () => {
  const cases: [string, string][] = [
    ["gitlab:u/r", "gitlab:"], ["codecommit:us-east-1://my-repo", "codecommit:"], ["codecommit::", "codecommit:"],
    ["codecommit:: ", "codecommit:"], ["1helper::x", "1helper:"], ["my_helper::x", "my_helper:"], ["::x", ":"],
  ];
  for (const [spec, prefix] of cases) refused(spec, `cannot resolve "${spec}": unknown prefix "${prefix}"; ${forms}`);
});

// k119: a GitHub link to a file, into a subdirectory or without a ref was kept verbatim as a git
// source (https://…) or tracked the repo's HEAD (github.com/…). Asserts: each is a SpecError
// naming the spec and what to add instead, never probed – a `blob` link is a file, a source a
// whole repository; a `tree` link past its ref names a subdirectory (a ref with "/" cannot be
// told from one, so the message says to add the repo and set "ref" by hand); a `tree` link
// without a ref names none. Owner and repo keep GitHub's rules (k117).
test("k119: a GitHub file link, a subdirectory link or a tree link without a ref is a SpecError, never probed", () => {
  const repo = "https://github.com/Getty/karr";
  const file = (ref?: string) => `a GitHub file link; a source is a whole repository: add ${repo}` +
    (ref === undefined ? "" : `, or ${repo}/tree/${ref} to pin ref "${ref}"`);
  const subdir = (sub: string, ref: string) => `skilletor installs a whole repository, not its subdirectory "${sub}"; ` +
    `add ${repo}/tree/${ref} to pin ref "${ref}". A link cannot tell a ref with "/" from a subdirectory: ` +
    `for such a ref, add ${repo} and set its "ref" by hand`;
  const cases: [string, string][] = [
    ["https://github.com/Getty/karr/blob/main/README.md", file("main")],
    ["github.com/Getty/karr/blob/v1/skills/x/SKILL.md", file("v1")],
    ["GITHUB.COM/Getty/karr/blob", file()],
    ["https://github.com/Getty/karr/tree/main/skills/foo", subdir("skills/foo", "main")],
    ["github.com/Getty/karr/tree/main/skills/", subdir("skills", "main")],
    ["https://github.com/Getty/karr/tree/feature/x", subdir("x", "feature")],
    ["https://github.com/Getty/karr/blob/main/README.md#L10", file("main")],
    ["https://github.com/Getty/karr/tree", `a GitHub tree link without a ref; add ${repo}`],
    ["github.com/Getty/karr/tree/", `a GitHub tree link without a ref; add ${repo}`],
  ];
  for (const [spec, why] of cases) refused(spec, `cannot resolve "${spec}": ${why}`);
  refused("https://github.com/Get_ty/karr/tree/main",
    `cannot resolve "https://github.com/Get_ty/karr/tree/main": GitHub owner "Get_ty" may only contain ASCII letters, ` +
      `digits and "-"; ${forms}`);
  refused("github.com/Getty/re:po/tree/main",
    `cannot resolve "github.com/Getty/re:po/tree/main": GitHub repo "re:po" may only contain ASCII letters, digits, ` +
      `".", "_" and "-"; ${forms}`);
});

test("known forges are never probed", () => {
  // noProbe throws if called; these must resolve without it.
  assert.doesNotThrow(() => resolveSpec("github.com/user", noProbe));
  assert.doesNotThrow(() => resolveSpec("gitlab.com/user/repo", noProbe));
});

// k95: a derived name becomes a config key, and config load refuses a source name outside
// the pattern, so an `add` without a name – or a bundle prompt's default – must never produce
// one. Normalization leaves nothing of a spec without an ASCII letter or digit where the name
// comes from. Asserts: every table row derives a name inside the pattern, and each such spec
// derives "source" (a probe that says git for the generic host).
test('k95: a derived name is always a valid source name; one normalization empties is "source"', () => {
  const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  for (const row of allRows) {
    assert.match(resolveSpec(row.spec, noProbe).derivedName, SOURCE_NAME, row.spec);
  }
  // "___" is no GitHub owner since k117 (the k117 test asserts its error); "---" is one.
  const empties = ["/", "~", "~/", "./", "../", "/tmp/日本", "./___", "github:---", "github.com/---",
    "gitlab.com/___/skills", "https://example.com/___/___", "git@host:___.git",
    "git@host:___/x.tar.gz", "file:///", "file:///x.tar.gz", "日本.__/x",
    "codecommit::us-east-1://___", "x::___", "x::日本"];
  for (const spec of empties) {
    assert.equal(resolveSpec(spec, () => ({ git: true })).derivedName, "source", spec);
  }
});

// k85: an explicit or scp-like address is stored verbatim, so `-oProxyCommand=…@host:repo`
// would become a git address that reaches git as an option. Asserts: every spec starting with
// "-" (after trimming) is a SpecError before anything else, the probe never called.
test('k85: a spec starting with "-" is refused, never probed', () => {
  for (const spec of ["-oProxyCommand=touch x@host:repo", "--upload-pack=touch x", " -x.tld", "-owner/repo"]) {
    assert.throws(() => resolveSpec(spec, noProbe), (e: unknown) => {
      assert.ok(e instanceof SpecError);
      assert.equal((e as Error).message, `cannot resolve "${spec}": a source must not start with "-"`);
      return true;
    });
  }
});
