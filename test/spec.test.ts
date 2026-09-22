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
  { spec: "github:Getty/repo", kind: "git", value: "https://github.com/Getty/repo", name: "getty" },
  { spec: "Getty", kind: "git", value: "https://github.com/Getty/skills", name: "getty" },
  { spec: "GETTY", kind: "git", value: "https://github.com/GETTY/skills", name: "getty" },
  { spec: "Getty/repo", kind: "git", value: "https://github.com/Getty/repo", name: "getty" },
  { spec: "hf.co/user", kind: "git", value: "https://hf.co/user/skills", name: "user" },
  { spec: "hf.co/user/repo", kind: "git", value: "https://hf.co/user/repo", name: "user" },
  { spec: "huggingface.co/user", kind: "git", value: "https://huggingface.co/user/skills", name: "user" },
  { spec: "codeberg.org/u", kind: "git", value: "https://codeberg.org/u/skills", name: "u" },
  { spec: "gitlab.com/u/r", kind: "git", value: "https://gitlab.com/u/r", name: "u" },
];

for (const row of rows) {
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

test("known forges are never probed", () => {
  // noProbe throws if called; these must resolve without it.
  assert.doesNotThrow(() => resolveSpec("github.com/user", noProbe));
  assert.doesNotThrow(() => resolveSpec("gitlab.com/user/repo", noProbe));
});
