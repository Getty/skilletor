// Tests for config loading, merging and validation (spec §3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { loadConfig, ConfigError } from "../src/config.ts";

type FileValue = Record<string, unknown> | string | undefined;

/** Lay out home/project config trees in a temp dir. */
function setup(files: { user?: FileValue; project?: FileValue; local?: FileValue }) {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const put = (p: string, v: FileValue) => {
    if (v === undefined) return;
    writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, 2));
  };
  put(join(home, ".claude", "skilletor.json"), files.user);
  put(join(projectDir, ".claude", "skilletor.json"), files.project);
  put(join(projectDir, ".claude", "skilletor.local.json"), files.local);
  return { home, projectDir, cleanup: () => tmp.cleanup() };
}

// ---- missing files ----------------------------------------------------------

test("missing files are not an error: empty config with defaults", () => {
  const { home, projectDir, cleanup } = setup({});
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.equal(cfg.sources.size, 0);
    assert.equal(cfg.user.install.length, 0);
    assert.equal(cfg.checkInterval, 1800); // user default (30 min)
    assert.ok(cfg.project);
    assert.equal(cfg.project.gitignore, true); // project default
  } finally {
    cleanup();
  }
});

test("no projectDir given: no project scope", () => {
  const { home, cleanup } = setup({ user: { checkInterval: 42 } });
  try {
    const cfg = loadConfig({ home });
    assert.equal(cfg.project, undefined);
    assert.equal(cfg.checkInterval, 42);
  } finally {
    cleanup();
  }
});

// ---- source merging ---------------------------------------------------------

test("distinct user and project sources both appear with correct origin", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { mine: { local: "~/dev/s" } } },
    project: { sources: { team: { git: "https://example.com/team" } } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.sources.get("mine")?.origins, { local: "user" });
    assert.deepEqual(cfg.sources.get("team")?.origins, { git: "project" });
    assert.deepEqual([...cfg.userSources.keys()], ["mine"]);
  } finally {
    cleanup();
  }
});

test("each merged backend field keeps its origin; the user scope sees the user config's sources alone (k66)", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { shared: { git: "https://example.com/a" } } },
    project: { sources: { shared: { local: "/project/payload", ref: "evil" } } },
    local: { sources: { shared: { url: "https://example.com/b.tar.gz", ref: "mine" } } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.sources.get("shared"), {
      name: "shared",
      git: "https://example.com/a",
      local: "/project/payload",
      url: "https://example.com/b.tar.gz",
      ref: "mine",
      origins: { git: "user", local: "project", url: "user" },
    });
    // Neither the project nor skilletor.local.json changes the user scope's source, ref included.
    assert.deepEqual(cfg.userSources.get("shared"), { name: "shared", git: "https://example.com/a", origins: { git: "user" } });
  } finally {
    cleanup();
  }
});

test("author mode: user local field merges over project git definition", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { shared: { local: "~/dev/skills" } } },
    project: { sources: { shared: { git: "https://github.com/Getty/skills", ref: "main" } } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    const s = cfg.sources.get("shared");
    assert.equal(s?.git, "https://github.com/Getty/skills");
    assert.equal(s?.ref, "main");
    assert.equal(s?.local, "~/dev/skills"); // user field merged in
    assert.deepEqual(s?.origins, { git: "project", local: "user" }); // per field, not per source
  } finally {
    cleanup();
  }
});

test("local config overrides user for a source field", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { shared: { git: "https://example.com/a" } } },
    local: { sources: { shared: { git: "https://example.com/b" } } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.equal(cfg.sources.get("shared")?.git, "https://example.com/b");
  } finally {
    cleanup();
  }
});

// ---- vars merging -----------------------------------------------------------

test("project-scope vars merge user < project < local", () => {
  const { home, projectDir, cleanup } = setup({
    user: { vars: { a: 1, b: 1, c: 1 } },
    project: { vars: { b: 2, c: 2 } },
    local: { vars: { c: 3 } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.project?.vars, { a: 1, b: 2, c: 3 });
    assert.deepEqual(cfg.user.vars, { a: 1, b: 1, c: 1 }); // user scope: user vars only
  } finally {
    cleanup();
  }
});

// ---- install parsing --------------------------------------------------------

test("install entry name@source parses to type/name/source/target", () => {
  const { home, projectDir, cleanup } = setup({
    project: {
      sources: { shared: { git: "https://example.com/s" } },
      install: { skills: ["perl-moo@shared"], agents: ["karr@shared"] },
    },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    const skill = cfg.project?.install.find((i) => i.name === "perl-moo");
    assert.deepEqual(
      { type: skill?.type, name: skill?.name, source: skill?.source, target: skill?.target },
      { type: "skill", name: "perl-moo", source: "shared", target: "skills/perl-moo" },
    );
    const agent = cfg.project?.install.find((i) => i.name === "karr");
    assert.equal(agent?.target, "agents/karr");
  } finally {
    cleanup();
  }
});

test("explicit type: prefix must match the array's type", () => {
  const { home, projectDir, cleanup } = setup({
    project: {
      sources: { shared: { git: "https://example.com/s" } },
      install: { skills: ["agent:karr@shared"] },
    },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match((e as Error).message, /type/i);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("user-scope install may not reference a project-only source", () => {
  const { home, projectDir, cleanup } = setup({
    user: { install: { skills: ["x@team"] } },
    project: { sources: { team: { git: "https://example.com/t" } } },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /unknown source/i);
  } finally {
    cleanup();
  }
});

test("project-scope install may reference a user source", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { shared: { git: "https://example.com/s" } } },
    project: { install: { skills: ["x@shared"] } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.equal(cfg.project?.install[0]?.source, "shared");
  } finally {
    cleanup();
  }
});

// ---- validation errors ------------------------------------------------------

test("broken JSON names the file", () => {
  const { home, projectDir, cleanup } = setup({ user: "{ not json" });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match((e as Error).message, /skilletor\.json/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("unknown top-level key is rejected", () => {
  const { home, projectDir, cleanup } = setup({ user: { nope: true } });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /unknown key.*nope/i);
  } finally {
    cleanup();
  }
});

test("install referencing an unknown source is rejected", () => {
  const { home, projectDir, cleanup } = setup({
    project: { install: { skills: ["x@ghost"] } },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /unknown source.*ghost/i);
  } finally {
    cleanup();
  }
});

test("duplicate target (same type+name) across sources is rejected", () => {
  const { home, projectDir, cleanup } = setup({
    project: {
      sources: { a: { git: "https://example.com/a" }, b: { git: "https://example.com/b" } },
      install: { skills: ["foo@a", "foo@b"] },
    },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /duplicate/i);
  } finally {
    cleanup();
  }
});

test("url source without https is rejected", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { team: { url: "http://insecure.example/skills.tar.gz" } } },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /https/i);
  } finally {
    cleanup();
  }
});

// k85: git still parses options after the remote name, so a ref (or address) starting with
// "-" – `--upload-pack=<cmd>` – would run <cmd>, and trust binds no ref. Asserts: in each of
// the three files either field is a ConfigError naming the file, the source and the key,
// with the value quoted.
test('k85: a git ref or git address starting with "-" is refused, naming file, source and key', () => {
  const cases: [keyof Parameters<typeof setup>[0], Record<string, string>, string, string][] = [
    ["user", { git: "https://example.com/s", ref: "--upload-pack=touch x" }, "ref", '"--upload-pack=touch x"'],
    ["project", { git: "https://example.com/s", ref: "-b" }, "ref", '"-b"'],
    ["local", { git: "https://example.com/s", ref: "--end-of-options" }, "ref", '"--end-of-options"'],
    ["project", { git: "--upload-pack=touch x" }, "git", '"--upload-pack=touch x"'],
    ["local", { git: "-oProxyCommand=x@host:repo" }, "git", '"-oProxyCommand=x@host:repo"'],
  ];
  for (const [file, def, key, quoted] of cases) {
    const { home, projectDir, cleanup } = setup({ [file]: { sources: { team: def } } });
    const path = file === "user" ? join(home, ".claude", "skilletor.json")
      : join(projectDir, ".claude", file === "local" ? "skilletor.local.json" : "skilletor.json");
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.equal((e as Error).message, `${path}: sources.team.${key} ${quoted} must not start with "-" (git would read it as an option)`);
        return true;
      });
    } finally {
      cleanup();
    }
  }
});

// k85: what `git check-ref-format` forbids character by character turns a name into refspec
// or revision syntax (`a:b` writes a ref, `^a` negates, `*` globs) or is never a ref at all.
// Asserts: each such ref is a ConfigError naming source and key; ordinary names still load.
test("k85: a ref with whitespace, control characters or refspec syntax is refused; ordinary names load", () => {
  const bad = ["main branch", "main\t", "a\nb", "a\u007fb", "main:refs/heads/x", "^main", "v1~1", "v1^{}",
    "refs/heads/*", "a?b", "a[b", "a\\b", "a..b", "main@{1}"];
  for (const ref of bad) {
    const { home, projectDir, cleanup } = setup({ project: { sources: { team: { git: "https://example.com/s", ref } } } });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /: sources\.team\.ref ".*" is not a git ref name \(no whitespace, control characters, ~ \^ : \? \* \[ \\, "\.\." or "@\{"\)$/s);
        assert.ok((e as Error).message.includes(JSON.stringify(ref)), (e as Error).message);
        return true;
      });
    } finally {
      cleanup();
    }
  }
  for (const ref of ["main", "v1.2.0", "refs/pull/12/head", "feature/x-y", "0123abc", "release_2026-09", "ümlaut", "a-", "@"]) {
    const { home, projectDir, cleanup } = setup({ project: { sources: { team: { git: "https://example.com/s", ref } } } });
    try {
      assert.equal(loadConfig({ home, projectDir }).sources.get("team")?.ref, ref);
    } finally {
      cleanup();
    }
  }
});

/** The config file `setup` writes for `file`. */
function configPath(file: "user" | "project" | "local", home: string, projectDir: string): string {
  return file === "user" ? join(home, ".claude", "skilletor.json")
    : join(projectDir, ".claude", file === "local" ? "skilletor.local.json" : "skilletor.json");
}

// k88: a source field is taken only as a string, so `ref: 123` dropped the pin (HEAD
// installed) and `git: 1` next to a `url` fell back to the url, both without a word.
// Asserts: in each of the three files, a git, ref or local present with any non-string JSON
// value is a ConfigError naming file, source and key, with the value as JSON.
test("k88: a git, ref or local that is not a string is refused, naming file, source and key", () => {
  const others: Record<string, Record<string, string>> = {
    git: { url: "https://example.com/s.tar.gz" },
    ref: { git: "https://example.com/s" },
    local: { git: "https://example.com/s" },
  };
  const files = ["user", "project", "local"] as const;
  const values: unknown[] = [123, true, null, ["main"], { name: "main" }];
  for (const [i, key] of ["git", "ref", "local"].entries()) {
    for (const [j, value] of values.entries()) {
      const file = files[(i + j) % files.length];
      const { home, projectDir, cleanup } = setup({ [file]: { sources: { team: { ...others[key], [key]: value } } } });
      try {
        assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
          assert.ok(e instanceof ConfigError, String(e));
          assert.equal((e as Error).message,
            `${configPath(file, home, projectDir)}: sources.team.${key} ${JSON.stringify(value)} must be a string`);
          return true;
        });
      } finally {
        cleanup();
      }
    }
  }
});

// k88: `ref: ""` read as unpinned for the cache dir but was fetched and checked as a ref named
// "" – reported changed every session, and a cache shared with the unpinned name under another
// resolver key; `local: ""` resolved to the process cwd, an existing directory, which author
// mode then took over `git`/`url`; `git: ""` won over a `url` beside it. The spec gives "" no
// meaning, so each is refused. Asserts: in each file an empty ref is a ConfigError naming
// file, source and key (a local "" cannot unset a project's pin either), and so is an empty
// git or local beside a valid backend; a source without `ref` still loads unpinned.
test('k88: an empty git, ref or local is refused, naming file, source and key; no ref stays unpinned', () => {
  for (const file of ["user", "project", "local"] as const) {
    const { home, projectDir, cleanup } = setup({
      project: { sources: { team: { git: "https://example.com/s", ...(file === "project" ? {} : { ref: "main" }) } } },
      [file]: { sources: { team: { git: "https://example.com/s", ref: "" } } },
    });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        assert.equal((e as Error).message,
          `${configPath(file, home, projectDir)}: sources.team.ref "" must not be empty (omit "ref" for the remote's HEAD)`);
        return true;
      });
    } finally {
      cleanup();
    }
  }
  const beside: [string, "user" | "project" | "local", Record<string, string>][] = [
    ["git", "project", { url: "https://example.com/s.tar.gz", git: "" }],
    ["git", "local", { git: "" }],
    ["local", "user", { git: "https://example.com/s", local: "" }],
    ["local", "project", { url: "https://example.com/s.tar.gz", local: "" }],
  ];
  for (const [key, file, def] of beside) {
    const { home, projectDir, cleanup } = setup({
      project: { sources: { team: { git: "https://example.com/s" } } },
      [file]: { sources: { team: def } },
    });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        assert.equal((e as Error).message, `${configPath(file, home, projectDir)}: sources.team.${key} "" must not be empty`);
        return true;
      });
    } finally {
      cleanup();
    }
  }
  const { home, projectDir, cleanup } = setup({ user: { sources: { team: { git: "https://example.com/s" } } } });
  try {
    const team = loadConfig({ home, projectDir }).sources.get("team");
    assert.equal(team?.git, "https://example.com/s");
    assert.equal(team?.ref, undefined);
  } finally {
    cleanup();
  }
});

// k95: a source name reaches lock entries, state keys (trust.json, sources-read.json) and
// `name@source` specs, yet any key under `sources` loaded – control characters, spaces,
// slashes. The rule (maintainer, 2026-09-27) is the bundle prompt's pattern. Asserts: in each
// of the three files a name outside ^[A-Za-z0-9][A-Za-z0-9._-]*$ is a ConfigError naming the
// file and the name as JSON – no raw C0 control in the message – checked before the source's
// own fields (the `x` key would be an error too, printing the name raw).
test("k95: a source name outside the pattern is refused in each file, naming the file and the name as JSON", () => {
  const bad = ["", " team", "team ", "team x", "a/b", "../up", ".hidden", "-x", "_x", "team\u0007", "a\nb",
    "\u001b[31mred", "t‮am", "tëam", "a@b", "a:b", "a*", "__proto__"];
  const files = ["user", "project", "local"] as const;
  for (const [i, name] of bad.entries()) {
    const file = files[i % files.length]!;
    const { home, projectDir, cleanup } = setup({ [file]: { sources: { [name]: { git: "https://example.com/s", x: 1 } } } });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        const msg = (e as Error).message;
        assert.equal(msg, `${configPath(file, home, projectDir)}: source name ${JSON.stringify(name)} is not valid ` +
          `(ASCII letters, digits, ".", "_" and "-", starting with a letter or digit)`);
        assert.doesNotMatch(msg, /[\x00-\x1f\x7f]/);
        return true;
      });
    } finally {
      cleanup();
    }
  }
});

// k95: the rule's other side. Asserts: names inside the pattern – a digit first, dots,
// underscores, dashes, `..` inside – load from every file, and `name@source` resolves them.
test("k95: source names inside the pattern load and can be referenced", () => {
  const good = ["a", "Z", "0", "team", "Team.X", "my_src", "a-b", "peter-2", "v1.2", "a..b", "x_", "9-.x"];
  const files = ["user", "project", "local"] as const;
  for (const [i, name] of good.entries()) {
    const file = files[i % files.length]!;
    const { home, projectDir, cleanup } = setup({
      [file]: { sources: { [name]: { git: "https://example.com/s" } }, install: { skills: [`foo@${name}`] } },
    });
    try {
      const cfg = loadConfig({ home, projectDir });
      assert.equal(cfg.sources.get(name)?.git, "https://example.com/s");
      const items = file === "user" ? cfg.user.install : cfg.project!.install;
      assert.deepEqual(items.map((it) => it.source), [name]);
    } finally {
      cleanup();
    }
  }
});

test("source with no kind is rejected", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { empty: {} } },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("checkInterval is user-only: rejected in project config", () => {
  const { home, projectDir, cleanup } = setup({ project: { checkInterval: 30 } });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /checkInterval/);
  } finally {
    cleanup();
  }
});

// k51: user "gitignore" used to be a load error ("project-only"); it now switches
// the user-scope blocks off and leaves the project value alone (spec §3, §6.4).
test("gitignore in user config switches only the user scope", () => {
  const { home, projectDir, cleanup } = setup({ user: { gitignore: false } });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.equal(cfg.user.gitignore, false);
    assert.equal(cfg.project?.gitignore, true);
  } finally {
    cleanup();
  }
});

test("gitignore defaults to true in user config and must be a boolean", () => {
  const def = setup({});
  try {
    assert.equal(loadConfig({ home: def.home }).user.gitignore, true);
  } finally {
    def.cleanup();
  }
  const bad = setup({ user: { gitignore: "no" } });
  try {
    assert.throws(() => loadConfig({ home: bad.home }), /"gitignore" must be a boolean/);
  } finally {
    bad.cleanup();
  }
});

test("gitignore false in project config is honored", () => {
  const { home, projectDir, cleanup } = setup({ project: { gitignore: false } });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.equal(cfg.project?.gitignore, false);
  } finally {
    cleanup();
  }
});

// ---- wildcards (k34) --------------------------------------------------------

test("wildcard entries parse into wildcards, not install; a matching type prefix is allowed", () => {
  const { home, projectDir, cleanup } = setup({
    user: {
      sources: { shared: { git: "https://example.com/s" } },
      install: { rules: ["*@shared"], skills: ["skill:*@shared", "foo@shared"] },
    },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.user.install.map((i) => i.target), ["skills/foo"]);
    assert.deepEqual(
      cfg.user.wildcards.map((w) => ({ type: w.type, source: w.source, raw: w.raw })).sort((a, b) => a.type.localeCompare(b.type)),
      [
        { type: "rule", source: "shared", raw: "*@shared" },
        { type: "skill", source: "shared", raw: "skill:*@shared" },
      ],
    );
    assert.deepEqual(cfg.project?.wildcards, []);
  } finally {
    cleanup();
  }
});

test("a wildcard referencing an unknown source is rejected", () => {
  const { home, projectDir, cleanup } = setup({ user: { install: { rules: ["*@ghost"] } } });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /unknown source.*ghost/i);
  } finally {
    cleanup();
  }
});

test("a wildcard with a mismatched type prefix is rejected", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { s: { git: "https://example.com/s" } }, install: { rules: ["agent:*@s"] } },
  });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /type/i);
  } finally {
    cleanup();
  }
});

test("the same wildcard twice in one scope is rejected, also across project and local", () => {
  const one = setup({
    user: { sources: { s: { git: "https://example.com/s" } }, install: { rules: ["*@s", "rule:*@s"] } },
  });
  try {
    assert.throws(() => loadConfig({ home: one.home, projectDir: one.projectDir }), /duplicate/i);
  } finally {
    one.cleanup();
  }
  const two = setup({
    project: { sources: { s: { git: "https://example.com/s" } }, install: { rules: ["*@s"] } },
    local: { install: { rules: ["*@s"] } },
  });
  try {
    assert.throws(() => loadConfig({ home: two.home, projectDir: two.projectDir }), /duplicate/i);
  } finally {
    two.cleanup();
  }
});

test("wildcards from two sources in one type are not a config error", () => {
  const { home, projectDir, cleanup } = setup({
    user: {
      sources: { a: { git: "https://example.com/a" }, b: { git: "https://example.com/b" } },
      install: { rules: ["*@a", "*@b", "foo@a"] },
    },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.user.wildcards.map((w) => w.source), ["a", "b"]);
  } finally {
    cleanup();
  }
});

// k48: `*` anywhere in the name is a pattern (spec §3).
test("patterns parse into wildcards with their pattern; different patterns of one source coexist", () => {
  const { home, projectDir, cleanup } = setup({
    user: {
      sources: { s: { git: "https://example.com/s" } },
      install: { rules: ["perl-*@s", "rule:*-style@s", "*@s", "plain@s"] },
    },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.user.wildcards.map((w) => [w.pattern, w.raw]), [
      ["perl-*", "perl-*@s"], ["*-style", "rule:*-style@s"], ["*", "*@s"],
    ]);
    assert.deepEqual(cfg.user.install.map((i) => i.name), ["plain"]);
  } finally {
    cleanup();
  }
});

test("the same pattern twice in one scope is rejected, also across project and local", () => {
  const one = setup({
    user: { sources: { s: { git: "https://example.com/s" } }, install: { rules: ["perl-*@s", "rule:perl-*@s"] } },
  });
  try {
    assert.throws(() => loadConfig({ home: one.home, projectDir: one.projectDir }), /duplicate/i);
  } finally {
    one.cleanup();
  }
  const two = setup({
    project: { sources: { s: { git: "https://example.com/s" } }, install: { rules: ["perl-*@s"] } },
    local: { install: { rules: ["perl-*@s"] } },
  });
  try {
    assert.throws(() => loadConfig({ home: two.home, projectDir: two.projectDir }), /duplicate/i);
  } finally {
    two.cleanup();
  }
});

// ---- bundles (k48, spec §15) ------------------------------------------------

test("install.bundles parses name@source, with or without a bundle: prefix", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { s: { git: "https://example.com/s" } }, install: { bundles: ["perl@s", "bundle:go@s"] } },
    project: { install: { bundles: ["perl@s"] } },
    local: { install: { bundles: ["base@s"] } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.user.bundles, [
      { name: "perl", source: "s", raw: "perl@s" },
      { name: "go", source: "s", raw: "bundle:go@s" },
    ]);
    assert.deepEqual(cfg.project?.bundles.map((b) => b.raw), ["perl@s", "base@s"]);
    assert.deepEqual(cfg.user.install, []);
    assert.deepEqual(cfg.user.wildcards, []);
  } finally {
    cleanup();
  }
});

test("install.bundles errors: unknown source, pattern, wrong prefix, not a list, duplicate", () => {
  const cases: [unknown, RegExp][] = [
    [{ bundles: ["perl@ghost"] }, /unknown source.*ghost/],
    [{ bundles: ["perl-*@s"] }, /pattern/],
    [{ bundles: ["rule:perl@s"] }, /bundle/],
    [{ bundles: "perl@s" }, /array/],
    [{ bundles: ["perl"] }, /name@source/],
    [{ bundles: ["perl@s", "bundle:perl@s"] }, /duplicate/],
  ];
  for (const [install, re] of cases) {
    const { home, projectDir, cleanup } = setup({ user: { sources: { s: { git: "https://example.com/s" } }, install } });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), re, JSON.stringify(install));
    } finally {
      cleanup();
    }
  }
  const across = setup({
    project: { sources: { s: { git: "https://example.com/s" } }, install: { bundles: ["perl@s"] } },
    local: { install: { bundles: ["perl@s"] } },
  });
  try {
    assert.throws(() => loadConfig({ home: across.home, projectDir: across.projectDir }), /duplicate/);
  } finally {
    across.cleanup();
  }
});

// ---- targets (spec §14.1) -----------------------------------------------------

test("targets: unset everywhere reads as undefined (auto-detect)", () => {
  const { home, projectDir, cleanup } = setup({ user: {}, project: {} });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.equal(cfg.user.targets, undefined);
    assert.equal(cfg.project?.targets, undefined);
  } finally {
    cleanup();
  }
});

test("targets: user, project and local are read; local wins over project", () => {
  const { home, projectDir, cleanup } = setup({
    user: { targets: ["claude", "codex"] },
    project: { targets: ["claude"] },
    local: { targets: ["codex"] },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual(cfg.user.targets, ["claude", "codex"]);
    assert.deepEqual(cfg.project?.targets, ["codex"]);
  } finally {
    cleanup();
  }
});

test("targets: must be a non-empty array of known harnesses without duplicates", () => {
  for (const [bad, re] of [
    [[], /non-empty array/],
    ["claude", /non-empty array/],
    [["cursor"], /unknown harness "cursor"/],
    [["claude", "claude"], /"claude" twice/],
  ] as const) {
    const { home, projectDir, cleanup } = setup({ project: { targets: bad } });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (err: Error) => err instanceof ConfigError && re.test(err.message));
    } finally {
      cleanup();
    }
  }
});

// ---- sources: path (k126) -----------------------------------------------------

// k126: `path` on a source entry – where its skills lie (spec §3, §4.1). Asserts: a string and
// an array of strings load as written, in each of the three files and beside every backend;
// a source without one has none.
test("k126: a source's path loads as written, a string or an array of strings", () => {
  const { home, projectDir, cleanup } = setup({
    user: { sources: { a: { git: "https://example.com/a", ref: "v1", path: "skills" }, plain: { git: "https://example.com/p" } } },
    project: { sources: { b: { url: "https://example.com/b.tar.gz", path: ["skills", "optional-skills/mlops", "./x/"] } } },
    local: { sources: { c: { local: "~/dev/c", path: ["one"] } } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    assert.deepEqual([cfg.sources.get("a")?.path, cfg.sources.get("a")?.ref], ["skills", "v1"]);
    assert.deepEqual(cfg.sources.get("b")?.path, ["skills", "optional-skills/mlops", "./x/"]);
    assert.deepEqual(cfg.sources.get("c")?.path, ["one"]);
    assert.equal(cfg.sources.get("plain")?.path, undefined);
    assert.equal("path" in cfg.sources.get("plain")!, false);
    assert.equal(cfg.userSources.get("a")?.path, "skills");
  } finally {
    cleanup();
  }
});

// k126: a `path` of another shape would have to be read as absent – the whole default layout
// offered where one directory was meant – or guessed at. Asserts: in each file, anything but a
// non-empty string or a non-empty array of non-empty strings is a ConfigError naming file,
// source and key (the array index for an element), with the value as JSON (the k88 style).
test("k126: a path that is no non-empty string or array of them is refused, naming file, source and key", () => {
  const omit = ` (omit "path" for the default layout)`;
  const cases: [unknown, string][] = [
    [123, `.path 123 must be a string or an array of strings`],
    [true, `.path true must be a string or an array of strings`],
    [null, `.path null must be a string or an array of strings`],
    [{ dir: "skills" }, `.path {"dir":"skills"} must be a string or an array of strings`],
    ["", `.path "" must not be empty${omit}`],
    [[], `.path [] must not be empty${omit}`],
    [["skills", 7], `.path[1] 7 must be a string`],
    [[["skills"]], `.path[0] ["skills"] must be a string`],
    [[null], `.path[0] null must be a string`],
    [["skills", ""], `.path[1] "" must not be empty`],
  ];
  const files = ["user", "project", "local"] as const;
  for (const [i, [value, problem]] of cases.entries()) {
    const file = files[i % files.length]!;
    const { home, projectDir, cleanup } = setup({ [file]: { sources: { team: { git: "https://example.com/s", path: value } } } });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        assert.equal((e as Error).message, `${configPath(file, home, projectDir)}: sources.team${problem}`);
        return true;
      }, JSON.stringify(value));
    } finally {
      cleanup();
    }
  }
});

// k126: what a path may not be whatever the source holds – absolute, with "..", the source
// root itself – needs no file system, so config load says it, as it does for a `ref` git could
// not take (and `add` then never writes one, k110). Asserts: each is a ConfigError naming file,
// source, key and value; "\" separates like "/" (a Windows-written config); a path that merely
// does not exist loads – that is the scan's to say.
test('k126: a path that is absolute, contains ".." or is the source root is a config error', () => {
  const abs = "must not be absolute (it is relative to the source root)";
  const root = "must not be the source root (name the directories its skills lie in)";
  const cases: [unknown, string][] = [
    ["/etc/skills", `.path "/etc/skills" ${abs}`],
    ["\\skills", `.path "\\\\skills" ${abs}`],
    [["skills", "/abs"], `.path[1] "/abs" ${abs}`],
    ["../other", `.path "../other" must not contain ".."`],
    ["skills/../../x", `.path "skills/../../x" must not contain ".."`],
    [["a", "b\\..\\c"], `.path[1] "b\\\\..\\\\c" must not contain ".."`],
    [".", `.path "." ${root}`],
    ["./", `.path "./" ${root}`],
    [["skills", "././"], `.path[1] "././" ${root}`],
  ];
  const files = ["user", "project", "local"] as const;
  for (const [i, [value, problem]] of cases.entries()) {
    const file = files[i % files.length]!;
    const { home, projectDir, cleanup } = setup({ [file]: { sources: { team: { local: "~/dev/s", path: value } } } });
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        assert.equal((e as Error).message, `${configPath(file, home, projectDir)}: sources.team${problem}`);
        return true;
      }, JSON.stringify(value));
    } finally {
      cleanup();
    }
  }
  const { home, projectDir, cleanup } = setup({ user: { sources: { team: { local: "~/dev/s", path: ["no/such/dir", "a..b", "..."] } } } });
  try {
    assert.deepEqual(loadConfig({ home, projectDir }).sources.get("team")?.path, ["no/such/dir", "a..b", "..."]);
  } finally {
    cleanup();
  }
});

// k126: `path` merges like `ref` (spec §3): same name, the user's value over the project's,
// the local file's over both – the whole value, never a concatenation – and a file that gives
// none keeps the one below. It is no backend field: it has no origin, and the user scope's
// sources are the user config's alone.
test("k126: path merges project < user < local, replaced whole; the user scope keeps the user config's", () => {
  const git = "https://example.com/s";
  const { home, projectDir, cleanup } = setup({
    project: { sources: {
      both: { git, path: ["p1", "p2"] }, onlyProject: { git, path: "p" }, userNone: { git, path: ["p1"] }, all: { git, path: "p" },
    } },
    user: { sources: { both: { git, path: "u" }, userNone: { git, ref: "v2" }, all: { git, path: ["u1", "u2"] }, onlyUser: { git, path: "u" } } },
    local: { sources: { all: { git, path: ["l"] }, onlyUser: { git } } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    const merged = (name: string) => cfg.sources.get(name)?.path;
    assert.deepEqual(merged("both"), "u");
    assert.deepEqual(merged("onlyProject"), "p");
    assert.deepEqual(merged("userNone"), ["p1"]); // the user gives none: the project's stays
    assert.equal(cfg.sources.get("userNone")?.ref, "v2");
    assert.deepEqual(merged("all"), ["l"]);
    assert.deepEqual(merged("onlyUser"), "u"); // the local file gives none: the user's stays
    const user = (name: string) => cfg.userSources.get(name)?.path;
    assert.deepEqual([user("both"), user("userNone"), user("all"), user("onlyUser")], ["u", undefined, ["u1", "u2"], "u"]);
    assert.equal(cfg.userSources.has("onlyProject"), false);
    assert.deepEqual(cfg.sources.get("all")?.origins, { git: "user" }); // no origin for path
  } finally {
    cleanup();
  }
});

// k128: every entry needed a backend of its own, so a skilletor.local.json could not pin or
// re-path a source the project declares without repeating its `git`. Rule (maintainer,
// 2026-10-15): an entry without `git`, `url` or `local` is allowed when another config file
// of the merge (project < user < local) gives the source one; it then changes only `ref` and
// `path`, and every backend field keeps the file it came from. Asserts: a local `{ref}` and a
// local `{path}` alone override the project's; a user `{ref}` alone does too; the author-mode
// merge is unchanged – a user `local` beside the project's `git`, its `ref` overridden by
// the local file, keeps all three with their origins.
test("k128: an entry without a backend overrides ref or path of a source another file defines", () => {
  const git = "https://github.com/Getty/skills";
  const { home, projectDir, cleanup } = setup({
    project: { sources: {
      pinned: { git, ref: "main" }, pathed: { git, path: "skills" }, both: { git, ref: "v1", path: "a" },
      authored: { git, ref: "main" }, byUser: { git },
    } },
    user: { sources: { authored: { local: "~/dev/skills" }, byUser: { ref: "v3" } } },
    local: { sources: {
      pinned: { ref: "v2" }, pathed: { path: ["x", "y"] }, both: { ref: "v4", path: "b" }, authored: { ref: "dev" },
    } },
  });
  try {
    const cfg = loadConfig({ home, projectDir });
    const s = (name: string) => cfg.sources.get(name);
    assert.deepEqual(s("pinned"), { name: "pinned", git, ref: "v2", origins: { git: "project" } });
    assert.deepEqual(s("pathed"), { name: "pathed", git, path: ["x", "y"], origins: { git: "project" } });
    assert.deepEqual(s("both"), { name: "both", git, ref: "v4", path: "b", origins: { git: "project" } });
    assert.deepEqual(s("authored"), {
      name: "authored", git, ref: "dev", local: "~/dev/skills", origins: { git: "project", local: "user" },
    });
    assert.deepEqual(s("byUser"), { name: "byUser", git, ref: "v3", origins: { git: "project" } });
  } finally {
    cleanup();
  }
});

// k128: the user scope reads the user config's sources alone (spec §3), so a user entry
// without a backend has nothing to build a user-scope item from. Asserts: it is no user-scope
// source, and a user install naming it is a ConfigError that says why, not "unknown source";
// the project scope still installs from the merged source.
test("k128: a user entry without a backend is no user-scope source; a user install of it says why", () => {
  const git = "https://github.com/Getty/skills";
  const project = { sources: { shared: { git } }, install: { skills: ["foo@shared"] } };
  const ok = setup({ project, user: { sources: { shared: { ref: "v2" } } } });
  try {
    const cfg = loadConfig({ home: ok.home, projectDir: ok.projectDir });
    assert.equal(cfg.userSources.has("shared"), false);
    assert.equal(cfg.sources.get("shared")?.ref, "v2");
    assert.deepEqual(cfg.project?.install.map((i) => i.raw), ["foo@shared"]);
  } finally {
    ok.cleanup();
  }
  const bad = setup({ project, user: { sources: { shared: { ref: "v2" } }, install: { skills: ["bar@shared"] } } });
  try {
    assert.throws(() => loadConfig({ home: bad.home, projectDir: bad.projectDir }), (e: unknown) => {
      assert.ok(e instanceof ConfigError, String(e));
      assert.equal((e as Error).message, `${configPath("user", bad.home, bad.projectDir)}: user install "bar@shared" ` +
        `references source "shared", which has no "git", "url" or "local" in this file ` +
        `(user-scope items are built from the user config's sources alone)`);
      return true;
    });
  } finally {
    bad.cleanup();
  }
});

// k128: an entry without a backend in any file of the merge stays an error. Asserts: the
// ConfigError names the source and every file that declares it, in merge order – one file,
// several files, and the user config alone when there is no project.
test("k128: a source without a backend in any config file is refused, naming the source and its files", () => {
  const cases: { files: Partial<Record<"user" | "project" | "local", FileValue>>; named: ("user" | "project" | "local")[] }[] = [
    { files: { local: { sources: { team: { ref: "v2" } } } }, named: ["local"] },
    { files: { project: { sources: { team: { path: "skills" } } }, user: { sources: { team: { ref: "v2" } } } }, named: ["project", "user"] },
    { files: { project: { sources: { team: { ref: "v1" } } }, local: { sources: { team: { path: ["a"] } } } }, named: ["project", "local"] },
  ];
  const tail = (n: number) => `: sources.team needs one of "git", "url" or "local"; ${n === 1 ? "no other config file gives one" : "none of these files gives one"} ` +
    `(an entry without one only changes "ref" or "path" of a source another file defines)`;
  for (const c of cases) {
    const { home, projectDir, cleanup } = setup(c.files);
    try {
      assert.throws(() => loadConfig({ home, projectDir }), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        assert.equal((e as Error).message, c.named.map((f) => configPath(f, home, projectDir)).join(" and ") + tail(c.named.length));
        return true;
      }, JSON.stringify(c.files));
    } finally {
      cleanup();
    }
  }
  const { home, projectDir, cleanup } = setup({ user: { sources: { team: { ref: "v2" } } }, project: { sources: { team: { git: "https://example.com/s" } } } });
  try {
    assert.throws(() => loadConfig({ home }), { name: "ConfigError", message: configPath("user", home, projectDir) + tail(1) }, "no project");
  } finally {
    cleanup();
  }
});

// k135: names equal ignoring case install into one directory on macOS and Windows (k127), yet
// `Foo@a` and `foo@b` under one type and scope loaded. Asserts: in one file and across the
// project and local files they are the duplicate-target ConfigError any same name is; under
// two types, or in the two scopes, they are not.
test("k135: two install entries whose names are equal ignoring case are a duplicate target", () => {
  const sources = { a: { git: "https://example.com/a" }, b: { git: "https://example.com/b" } };
  const one = setup({ user: { sources, install: { skills: ["Foo@a", "foo@b"] } } });
  try {
    assert.throws(() => loadConfig({ home: one.home, projectDir: one.projectDir }), {
      name: "ConfigError", message: `${configPath("user", one.home, one.projectDir)}: duplicate skill target "foo" declared as Foo@a and foo@b`,
    });
  } finally {
    one.cleanup();
  }
  const two = setup({ project: { sources, install: { rules: ["Foo@a"] } }, local: { install: { rules: ["fOO@a"] } } });
  try {
    assert.throws(() => loadConfig({ home: two.home, projectDir: two.projectDir }), {
      name: "ConfigError", message: `${configPath("project", two.home, two.projectDir)}: duplicate rule target "fOO" declared as Foo@a and fOO@a`,
    });
  } finally {
    two.cleanup();
  }
  const fine = setup({ user: { sources, install: { skills: ["Foo@a"], agents: ["foo@b"] } }, project: { install: { skills: ["foo@b"] } } });
  try {
    const cfg = loadConfig({ home: fine.home, projectDir: fine.projectDir });
    assert.deepEqual([cfg.user.install.map((i) => i.raw), cfg.project?.install.map((i) => i.raw)], [["Foo@a", "foo@b"], ["foo@b"]]);
  } finally {
    fine.cleanup();
  }
});
