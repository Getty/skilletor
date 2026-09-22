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
    assert.equal(cfg.checkInterval, 600); // user default
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
    assert.equal(cfg.sources.get("mine")?.origin, "user");
    assert.equal(cfg.sources.get("team")?.origin, "project");
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
    assert.equal(s?.origin, "user"); // present in user config => trusted
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

test("gitignore is project-only: rejected in user config", () => {
  const { home, projectDir, cleanup } = setup({ user: { gitignore: false } });
  try {
    assert.throws(() => loadConfig({ home, projectDir }), /gitignore/);
  } finally {
    cleanup();
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
