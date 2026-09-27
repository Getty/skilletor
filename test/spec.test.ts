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

for (const row of [...rows, ...k101Rows, ...k104Rows]) {
  test(`resolves ${row.spec}`, () => {
    const r = resolveSpec(row.spec, noProbe);
    assert.equal(r.kind, row.kind, "kind");
    assert.equal(r.value, row.value, "value");
    assert.equal(r.derivedName, row.name, "derivedName");
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
  for (const row of [...rows, ...k101Rows, ...k104Rows]) {
    assert.match(resolveSpec(row.spec, noProbe).derivedName, SOURCE_NAME, row.spec);
  }
  const empties = ["/", "~", "~/", "./", "../", "/tmp/日本", "./___", "___", "github:___", "github.com/___",
    "gitlab.com/___/skills", "https://example.com/___/___", "git@host:___.git",
    "git@host:___/x.tar.gz", "file:///", "file:///x.tar.gz", "日本.__/x"];
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
