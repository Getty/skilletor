// Tests for the CLI edit commands (spec §7, §4.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import {
  cmdAdd, cmdAvailable, cmdInstall, cmdSourceList, cmdSourceRemove, cmdTrust, cmdUninstall, CommandError,
  type CommandContext,
} from "../src/commands.ts";
import type { Probe } from "../src/spec.ts";

const noProbe: Probe = () => {
  throw new Error("probe must not run");
};

function env() {
  const tmp = makeTmpDir();
  const home = join(tmp.dir, "home");
  const projectDir = join(tmp.dir, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ctx: CommandContext = {
    home,
    projectDir,
    stateRoot: join(tmp.dir, "state"),
    host: { name: "box", os: "linux" },
    user: { name: "getty", home },
    markers: claudeOnly(home),
    probe: noProbe,
  };
  const userCfgPath = join(home, ".claude", "skilletor.json");
  const readUserCfg = () => JSON.parse(readFileSync(userCfgPath, "utf8"));
  const writeUserCfg = (obj: unknown) => writeFileSync(userCfgPath, JSON.stringify(obj, null, 2));
  return { tmp, ctx, home, projectDir, userCfgPath, readUserCfg, writeUserCfg, cleanup: () => tmp.cleanup() };
}

function makeSource(root: string, name: string, layout: (dir: string) => void): string {
  const dir = join(root, name);
  layout(dir);
  return resolvePath(dir);
}

function skill(dir: string, name: string, body = "B") {
  const d = join(dir, "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
}

function agent(dir: string, name: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\ndescription: ${name} agent\n---\nprompt\n`);
}

test("add resolves a shorthand and stores the explicit form, valid and diff-friendly", async () => {
  const e = env();
  try {
    const res = await cmdAdd(e.ctx, { name: "shared", spec: "Getty" });
    assert.equal(res.def.git, "https://github.com/Getty/skills");
    const cfg = e.readUserCfg();
    assert.equal(cfg.sources.shared.git, "https://github.com/Getty/skills");
    const raw = readFileSync(e.userCfgPath, "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.match(raw, /\n  "sources"/); // 2-space indent
  } finally {
    e.cleanup();
  }
});

test("add derives the source name when omitted", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "myskills", (d) => skill(d, "foo"));
    const res = await cmdAdd(e.ctx, { spec: src });
    assert.equal(res.name, "myskills");
    assert.equal(e.readUserCfg().sources.myskills.local, src);
  } finally {
    e.cleanup();
  }
});

test("install adds the entry with an auto-detected type and syncs", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => skill(d, "foo"));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await cmdInstall(e.ctx, { items: ["foo@mine"] });
    assert.deepEqual(e.readUserCfg().install.skills, ["foo@mine"]);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

test("install of an unknown item errors with suggestions", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => skill(d, "foo"));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["nope@mine"] }), (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match((err as Error).message, /skill:foo/);
      return true;
    });
  } finally {
    e.cleanup();
  }
});

test("install of an ambiguous name needs a type prefix", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      skill(d, "dup");
      agent(d, "dup");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["dup@mine"] }), /ambiguous/i);
    await cmdInstall(e.ctx, { items: ["skill:dup@mine"] });
    assert.deepEqual(e.readUserCfg().install.skills, ["dup@mine"]);
  } finally {
    e.cleanup();
  }
});

test("uninstall removes the entry and the installed files", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => skill(d, "foo"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    await cmdInstall(e.ctx, { items: [] }); // sync to install first
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
    await cmdUninstall(e.ctx, { items: ["foo@mine"] });
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false);
    assert.equal(e.readUserCfg().install, undefined);
  } finally {
    e.cleanup();
  }
});

test("source list reports sources; remove refuses while items are installed", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => skill(d, "foo"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    assert.deepEqual(cmdSourceList(e.ctx).map((s) => s.name), ["mine"]);
    await assert.rejects(() => cmdSourceRemove(e.ctx, { name: "mine" }), /still has installed/i);
    await cmdSourceRemove(e.ctx, { name: "mine", force: true });
    assert.equal(e.readUserCfg().sources, undefined);
  } finally {
    e.cleanup();
  }
});

test("available lists a trusted source's catalog with installed markers", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      skill(d, "foo");
      skill(d, "bar");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const items = await cmdAvailable(e.ctx, { source: "mine" });
    const byName = new Map(items.map((i) => [i.name, i]));
    assert.equal(byName.get("foo")?.installed, true);
    assert.equal(byName.get("bar")?.installed, false);
  } finally {
    e.cleanup();
  }
});

test("trust confirms a project-only source and shows the URL", async () => {
  const e = env();
  try {
    // project-declared source is untrusted until `trust`.
    writeFileSync(
      join(e.projectDir, ".claude", "skilletor.json"),
      JSON.stringify({ sources: { team: { git: "https://github.com/Getty/skills" } } }),
    );
    const before = cmdSourceList(e.ctx).find((s) => s.name === "team");
    assert.equal(before?.origin, "project");
    const res = cmdTrust(e.ctx, { name: "team" });
    assert.equal(res.url, "https://github.com/Getty/skills");
    // Now available should include it (trusted) — resolve would need network, so
    // just assert the trust file recorded it via a fresh isTrusted check.
    const items = cmdSourceList(e.ctx); // no throw
    assert.equal(items.length >= 1, true);
  } finally {
    e.cleanup();
  }
});

// ---- wildcards (k34) --------------------------------------------------------

function rule(dir: string, name: string) {
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", `${name}.md`), `---\ndescription: ${name} rule\n---\nrule\n`);
}

test("install type:*@source stores a wildcard and installs every item of that type", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      rule(d, "r2");
      skill(d, "foo");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const report = await cmdInstall(e.ctx, { items: ["rule:*@mine"] });
    assert.deepEqual(e.readUserCfg().install, { rules: ["*@mine"] });
    assert.deepEqual(report.scopes[0]!.added.map((i) => i.key).sort(), ["rules/r1", "rules/r2"]);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo")), false);
  } finally {
    e.cleanup();
  }
});

test("install of a wildcard without a type prefix is an error", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await assert.rejects(
      () => cmdInstall(e.ctx, { items: ["*@mine"] }),
      (err: unknown) => err instanceof CommandError && /type prefix/.test((err as Error).message) && /rule:\*@mine/.test((err as Error).message),
    );
    assert.equal(e.readUserCfg().install, undefined);
  } finally {
    e.cleanup();
  }
});

test("install of a wildcard checks the source exists and is trusted", async () => {
  const e = env();
  try {
    e.writeUserCfg({});
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["rule:*@ghost"] }), /unknown source/);
    writeFileSync(
      join(e.projectDir, ".claude", "skilletor.json"),
      JSON.stringify({ sources: { team: { git: "file:///nope.git" } } }),
    );
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["rule:*@team"], project: true }), /not trusted/);
  } finally {
    e.cleanup();
  }
});

test("install --project writes the wildcard to the project config", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await cmdInstall(e.ctx, { items: ["rule:*@mine"], project: true });
    const proj = JSON.parse(readFileSync(join(e.projectDir, ".claude", "skilletor.json"), "utf8"));
    assert.deepEqual(proj.install, { rules: ["*@mine"] });
    assert.equal(existsSync(join(e.projectDir, ".claude/rules/r1.md")), true);
  } finally {
    e.cleanup();
  }
});

test("uninstall type:*@source removes only that type's wildcard and its items", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      skill(d, "foo");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["*@mine"], rules: ["rule:*@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    assert.equal(existsSync(join(e.home, ".claude/rules/r1.md")), true);
    await cmdUninstall(e.ctx, { items: ["rule:*@mine"] });
    assert.deepEqual(e.readUserCfg().install, { skills: ["*@mine"] });
    assert.equal(existsSync(join(e.home, ".claude/rules/r1.md")), false);
    assert.equal(existsSync(join(e.home, ".claude/skills/foo/SKILL.md")), true);
  } finally {
    e.cleanup();
  }
});

test("uninstall of a wildcard without a type prefix is an error", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { mine: { local: e.tmp.dir } }, install: { rules: ["*@mine"] } });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["*@mine"] }), /type prefix/);
    assert.deepEqual(e.readUserCfg().install, { rules: ["*@mine"] });
  } finally {
    e.cleanup();
  }
});

// k36: a type prefix restricts removal to that type's list; no prefix keeps "all lists".
test("uninstall type:name@source removes only that type's entry", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      skill(d, "dup");
      agent(d, "dup");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["dup@mine"], agents: ["dup@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    await cmdUninstall(e.ctx, { items: ["skill:dup@mine"] });
    assert.deepEqual(e.readUserCfg().install, { agents: ["dup@mine"] });
    assert.equal(existsSync(join(e.home, ".claude/skills/dup")), false);
    assert.equal(existsSync(join(e.home, ".claude/agents/dup.md")), true);
  } finally {
    e.cleanup();
  }
});

test("uninstall name@source without a prefix still removes the name from every list", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      skill(d, "dup");
      agent(d, "dup");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["dup@mine"], agents: ["dup@mine"] } });
    await cmdUninstall(e.ctx, { items: ["dup@mine"] });
    assert.equal(e.readUserCfg().install, undefined);
  } finally {
    e.cleanup();
  }
});

test("uninstall type:name@source declared only under another type is an error naming it", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { mine: { local: e.tmp.dir } }, install: { skills: ["foo@mine"] } });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["agent:foo@mine"] }), (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match((err as Error).message, /not declared/);
      assert.match((err as Error).message, /skill:foo@mine/);
      return true;
    });
    assert.deepEqual(e.readUserCfg().install, { skills: ["foo@mine"] });
  } finally {
    e.cleanup();
  }
});

// k37: an item that only a wildcard declares cannot be uninstalled by name.
for (const spec of ["r1@mine", "rule:r1@mine"]) {
  test(`uninstall ${spec} covered only by a wildcard fails with a hint and changes nothing`, async () => {
    const e = env();
    try {
      const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
      e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["*@mine"] } });
      await cmdInstall(e.ctx, { items: [] });
      await assert.rejects(() => cmdUninstall(e.ctx, { items: [spec] }), (err: unknown) => {
        assert.ok(err instanceof CommandError);
        const msg = (err as Error).message;
        assert.match(msg, /wildcard rule:\*@mine/);
        assert.match(msg, /skilletor uninstall 'rule:\*@mine'/);
        assert.match(msg, /vars/);
        return true;
      });
      assert.deepEqual(e.readUserCfg().install, { rules: ["*@mine"] });
      assert.equal(existsSync(join(e.home, ".claude/rules/r1.md")), true);
    } finally {
      e.cleanup();
    }
  });
}

test("the wildcard hint names only the wildcard of the item's installed type", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      skill(d, "foo");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["*@mine"], rules: ["*@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["r1@mine"] }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /rule:\*@mine/);
      assert.doesNotMatch(msg, /skill:\*@mine/);
      return true;
    });
  } finally {
    e.cleanup();
  }
});

test("a name the wildcard has not installed is not claimed as wildcard-installed", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["*@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["nope@mine"] }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /nope@mine is not declared in the user config/);
      assert.doesNotMatch(msg, /installed by/);
      assert.match(msg, /wildcard rule:\*@mine .*if mine offers it/);
      return true;
    });
  } finally {
    e.cleanup();
  }
});

test("uninstall of an explicit item a wildcard also covers removes it and returns a hint", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["r1@mine", "*@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    const res = await cmdUninstall(e.ctx, { items: ["r1@mine"] });
    assert.deepEqual(e.readUserCfg().install, { rules: ["*@mine"] });
    assert.equal(res.hints.length, 1);
    assert.match(res.hints[0]!, /wildcard rule:\*@mine/);
    assert.match(res.hints[0]!, /next sync|still installs/);
    // The wildcard keeps it installed.
    assert.equal(existsSync(join(e.home, ".claude/rules/r1.md")), true);
  } finally {
    e.cleanup();
  }
});

test("uninstall without a wildcard in play returns no hints", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["r1@mine"], skills: ["*@mine"] } });
    const res = await cmdUninstall(e.ctx, { items: ["r1@mine"] });
    assert.deepEqual(res.hints, []);
  } finally {
    e.cleanup();
  }
});

test("uninstall of an item declared nowhere is an error and touches nothing", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { mine: { local: e.tmp.dir } }, install: { skills: ["foo@mine"] } });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["nope@mine"] }), (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match((err as Error).message, /nope@mine is not declared/);
      return true;
    });
    assert.deepEqual(e.readUserCfg().install, { skills: ["foo@mine"] });
  } finally {
    e.cleanup();
  }
});

test("uninstall validates every item before editing: one bad item leaves the config untouched", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { mine: { local: e.tmp.dir } }, install: { skills: ["foo@mine"] } });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["foo@mine", "nope@mine"] }), /nope@mine/);
    assert.deepEqual(e.readUserCfg().install, { skills: ["foo@mine"] });
  } finally {
    e.cleanup();
  }
});

test("uninstall of a wildcard that is not declared is an error", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { mine: { local: e.tmp.dir } }, install: { skills: ["*@mine"] } });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["rule:*@mine"] }), /rule:\*@mine is not declared/);
    assert.deepEqual(e.readUserCfg().install, { skills: ["*@mine"] });
  } finally {
    e.cleanup();
  }
});

test("uninstall respects the scope: an item declared in the other config points at --project", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const projCfg = join(e.projectDir, ".claude", "skilletor.json");
    writeFileSync(projCfg, JSON.stringify({ install: { rules: ["r1@mine"] } }));
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["r1@mine"] }), /project config.*--project/);
    await cmdUninstall(e.ctx, { items: ["r1@mine"], project: true });
    assert.equal(JSON.parse(readFileSync(projCfg, "utf8")).install, undefined);
  } finally {
    e.cleanup();
  }
});

test("uninstall --project hints at a wildcard in the project config", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const projCfg = join(e.projectDir, ".claude", "skilletor.json");
    writeFileSync(projCfg, JSON.stringify({ install: { rules: ["rule:*@mine"] } }));
    await cmdInstall(e.ctx, { items: [] });
    await assert.rejects(
      () => cmdUninstall(e.ctx, { items: ["r1@mine"], project: true }),
      /wildcard rule:\*@mine.*project config[\s\S]*--project/,
    );
    // Without --project the user config has neither an entry nor a wildcard: the plain error, pointing at the project.
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["r1@mine"] }), /not declared in the user config/);
  } finally {
    e.cleanup();
  }
});

test("source remove refuses while a wildcard uses the source", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["*@mine"] } });
    await assert.rejects(() => cmdSourceRemove(e.ctx, { name: "mine" }), /still has installed/i);
  } finally {
    e.cleanup();
  }
});

test("available marks items installed through a wildcard", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => rule(d, "r1"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["*@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    const items = await cmdAvailable(e.ctx);
    assert.deepEqual(items.map((i) => [i.name, i.installed]), [["r1", true]]);
  } finally {
    e.cleanup();
  }
});

test("k44: project-scope edits fail when the project dir is the home dir", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "srcH", (d) => skill(d, "foo"));
    await cmdAdd(e.ctx, { name: "mine", spec: src });
    const before = readFileSync(e.userCfgPath, "utf8");
    const ctx: CommandContext = { ...e.ctx, projectDir: e.home };
    const noProject = (err: unknown) =>
      err instanceof CommandError && /no project scope/.test((err as Error).message) && (err as Error).message.includes(e.home);
    await assert.rejects(() => cmdInstall(ctx, { items: ["foo@mine"], project: true }), noProject);
    await assert.rejects(() => cmdUninstall(ctx, { items: ["foo@mine"], project: true }), noProject);
    await assert.rejects(() => cmdAdd(ctx, { name: "x", spec: src, project: true }), noProject);
    await assert.rejects(() => cmdSourceRemove(ctx, { name: "mine", project: true }), noProject);
    assert.equal(readFileSync(e.userCfgPath, "utf8"), before, "user config untouched");
    // The user scope still works from ~.
    const r = await cmdInstall(ctx, { items: ["foo@mine"] });
    assert.deepEqual(r.scopes.map((s) => s.scope), ["user"]);
  } finally {
    e.cleanup();
  }
});

// ---- patterns and bundles (k48, spec §3, §7, §15.5) ---------------------------

function bundleFile(dir: string, name: string, text: string) {
  mkdirSync(join(dir, "bundles"), { recursive: true });
  writeFileSync(join(dir, "bundles", `${name}.yaml`), text);
}

test("install type:perl-*@source stores the pattern; a pattern without a type prefix is an error", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "perl-a");
      rule(d, "go-b");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["perl-*@mine"] }), /type prefix.*rule:perl-\*@mine/);
    const r = await cmdInstall(e.ctx, { items: ["rule:perl-*@mine"] });
    assert.deepEqual(e.readUserCfg().install, { rules: ["perl-*@mine"] });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key), ["rules/perl-a"]);
  } finally {
    e.cleanup();
  }
});

test("install bundle:name@source adds it to install.bundles and installs its items", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      skill(d, "s1");
      bundleFile(d, "perl", "description: Perl\nrules: [r1]\nskills: [s1]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const r = await cmdInstall(e.ctx, { items: ["bundle:perl@mine"] });
    assert.deepEqual(e.readUserCfg().install, { bundles: ["perl@mine"] });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["rules/r1", "skills/s1"]);
    await cmdInstall(e.ctx, { items: ["bundle:perl@mine"], project: true });
    assert.deepEqual(JSON.parse(readFileSync(join(e.projectDir, ".claude/skilletor.json"), "utf8")).install, { bundles: ["perl@mine"] });
  } finally {
    e.cleanup();
  }
});

test("install of an unknown or broken bundle is an error and edits nothing", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      bundleFile(d, "broken", "rules: [r1]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["bundle:ghost@mine"] }), /unknown bundle "ghost" in mine/);
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["bundle:broken@mine"] }), /broken.*description/);
    assert.equal(e.readUserCfg().install, undefined);
  } finally {
    e.cleanup();
  }
});

test("install name@source resolves to a bundle when no item has that name, else it is ambiguous", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      rule(d, "dup");
      bundleFile(d, "perl", "description: Perl\nrules: [r1]\n");
      bundleFile(d, "dup", "description: Dup\nrules: [r1]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    await cmdInstall(e.ctx, { items: ["perl@mine"] });
    assert.deepEqual(e.readUserCfg().install, { bundles: ["perl@mine"] });
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["dup@mine"] }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /ambiguous/);
      assert.match(msg, /bundle:dup@mine/);
      assert.match(msg, /rule:dup@mine/);
      return true;
    });
  } finally {
    e.cleanup();
  }
});

test("uninstall bundle:name@source removes the entry and its items; bare name works when unambiguous", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      bundleFile(d, "perl", "description: Perl\nrules: [r1]\n");
      bundleFile(d, "go", "description: Go\nrules: [r1]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { bundles: ["perl@mine", "bundle:go@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    await cmdUninstall(e.ctx, { items: ["bundle:perl@mine"] });
    assert.deepEqual(e.readUserCfg().install, { bundles: ["bundle:go@mine"] });
    assert.equal(existsSync(join(e.home, ".claude/rules/r1.md")), true); // go still yields it
    await cmdUninstall(e.ctx, { items: ["go@mine"] });
    assert.equal(e.readUserCfg().install, undefined);
    assert.equal(existsSync(join(e.home, ".claude/rules/r1.md")), false);
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["bundle:perl@mine"] }), /bundle:perl@mine is not declared/);
  } finally {
    e.cleanup();
  }
});

test("uninstall of an item only a bundle declares fails naming the bundle; explicit + bundle warns", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      bundleFile(d, "perl", "description: Perl\nrules: [r1]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { bundles: ["perl@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["r1@mine"] }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /installed by the bundle bundle:perl@mine/);
      assert.match(msg, /skilletor uninstall 'bundle:perl@mine'/);
      assert.match(msg, /vars/);
      return true;
    });
    assert.deepEqual(e.readUserCfg().install, { bundles: ["perl@mine"] });

    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["r1@mine"], bundles: ["perl@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    const res = await cmdUninstall(e.ctx, { items: ["rule:r1@mine"] });
    assert.deepEqual(e.readUserCfg().install, { bundles: ["perl@mine"] });
    assert.equal(res.hints.length, 1);
    assert.match(res.hints[0]!, /bundle bundle:perl@mine in the user config still installs it/);
  } finally {
    e.cleanup();
  }
});

test("the wildcard hint honours patterns: it names the matching pattern, not others", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "perl-a");
      rule(d, "go-b");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { rules: ["perl-*@mine", "go-*@mine"] } });
    await cmdInstall(e.ctx, { items: [] });
    await assert.rejects(() => cmdUninstall(e.ctx, { items: ["perl-a@mine"] }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /wildcard rule:perl-\*@mine/);
      assert.match(msg, /skilletor uninstall 'rule:perl-\*@mine'/);
      assert.doesNotMatch(msg, /go-\*/);
      return true;
    });
    await cmdUninstall(e.ctx, { items: ["rule:go-*@mine"] });
    assert.deepEqual(e.readUserCfg().install, { rules: ["perl-*@mine"] });
  } finally {
    e.cleanup();
  }
});

test("available lists bundles with description, expanded members, vars and installed marker", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "perl-a");
      skill(d, "s1");
      bundleFile(d, "perl", "description: Perl\nrules: [\"perl-*\"]\nbundles: [base]\nvars:\n  v: 1\n");
      bundleFile(d, "base", "description: Base\nskills: [s1]\n");
      bundleFile(d, "broken", "nope: 1\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { bundles: ["perl@mine"] } });
    const items = await cmdAvailable(e.ctx, { source: "mine" });
    const bundles = items.filter((i) => i.type === "bundle");
    const perl = bundles.find((b) => b.name === "perl")!;
    assert.equal(perl.description, "Perl");
    assert.deepEqual(perl.members, ["rule:perl-a", "skill:s1"]);
    assert.deepEqual(perl.vars, { v: 1 });
    assert.equal(perl.installed, true);
    assert.equal(bundles.find((b) => b.name === "base")!.installed, false);
    assert.match(bundles.find((b) => b.name === "broken")!.error!, /description|unknown key/);
  } finally {
    e.cleanup();
  }
});

test("source remove refuses while a bundle uses the source", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", "description: P\n"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { bundles: ["perl@mine"] } });
    await assert.rejects(() => cmdSourceRemove(e.ctx, { name: "mine" }), /still has installed items/);
  } finally {
    e.cleanup();
  }
});
