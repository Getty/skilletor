// Tests for the CLI edit commands (spec §7, §4.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { claudeOnly } from "./helpers/harness.ts";
import {
  cmdAdd, cmdAvailable, cmdInstall, cmdSourceList, cmdSourceRemove, cmdTrust, cmdUninstall, CommandError,
  type CommandContext,
} from "../src/commands.ts";
import { resolveSpec, SpecError, type Probe } from "../src/spec.ts";
import { State } from "../src/state.ts";
import { check, status, sync } from "../src/engine.ts";
import { ConfigError, loadConfig } from "../src/config.ts";

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
    isGitWorkTree: () => false, // never the real location of the temp dir
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

// k101: `add` never replaces a source. The same backend and address again keeps the entry
// exactly as written (a ref pin, a local override stay; the file is not rewritten), and it is
// still trusted and synced. Asserts: bytes unchanged, returned def is the file's entry,
// the backend it names is trusted, the sync installed from it.
test("k101: re-adding a source's own address keeps its entry as is, trusts and syncs it", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "tools", ["t-one"]);
    const projPath = join(e.projectDir, ".claude/skilletor.json");
    const raw = `{"sources": {"tools": {"git": "${url}", "ref": "main", "local": "~/no/such/dir"}},\n` +
      ` "install": {"rules": ["t-one@tools"]}}\n`;
    writeFileSync(projPath, raw);
    // The same identity written without `.git`.
    const res = await cmdAdd(e.ctx, { name: "tools", spec: url.replace(/\.git$/, ""), project: true });
    assert.equal(readFileSync(projPath, "utf8"), raw, "config byte-identical");
    assert.equal(res.kept, true);
    assert.deepEqual(res.def, { git: url, ref: "main", local: "~/no/such/dir" });
    assert.equal(new State(e.ctx.stateRoot).isTrusted("tools", { kind: "git", address: url, origin: "project" }), true);
    const proj = res.report.scopes.find((s) => s.scope === "project")!;
    assert.deepEqual(proj.added.map((i) => `${i.key}@${i.source}`), ["rules/t-one@tools"]);

    // A local path is the same address however it is written (~ or absolute).
    const src = makeSource(e.home, "team", (d) => skill(d, "foo"));
    const userRaw = `{ "sources": { "team": { "local": "~/team" } } }\n`;
    writeFileSync(e.userCfgPath, userRaw);
    const again = await cmdAdd(e.ctx, { name: "team", spec: src });
    assert.equal(again.kept, true);
    assert.deepEqual(again.def, { local: "~/team" });
    assert.equal(readFileSync(e.userCfgPath, "utf8"), userRaw);
    const fresh = await cmdAdd(e.ctx, { name: "other", spec: src });
    assert.equal(fresh.kept, false);
  } finally {
    e.cleanup();
  }
});

// k101: a name the target config already gives another address is an error before anything is
// written or trusted. Asserts: CommandError naming the existing address and both ways out
// (with --project when editing the project config), file bytes unchanged, no trust entry.
test("k101: add with a name another address holds fails, config byte-identical, nothing trusted", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "karr", (d) => skill(d, "foo"));
    const raw = `{ "sources": { "karr": { "git": "https://example.invalid/Getty/karr", "ref": "v1" } } }\n`;
    writeFileSync(e.userCfgPath, raw);
    await assert.rejects(() => cmdAdd(e.ctx, { spec: src }), (err: unknown) => {
      assert.ok(err instanceof CommandError, String(err));
      const msg = (err as Error).message;
      assert.ok(msg.includes(`source "karr" in ${e.userCfgPath} is git https://example.invalid/Getty/karr`), msg);
      assert.ok(msg.includes("nothing was changed"), msg);
      assert.ok(msg.includes(`skilletor add <name> ${src}`), msg);
      assert.ok(msg.includes("skilletor source remove karr"), msg);
      assert.doesNotMatch(msg, /--project/);
      return true;
    });
    assert.equal(readFileSync(e.userCfgPath, "utf8"), raw, "user config byte-identical");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");

    // Another local path is another address; the hints carry --project.
    const projPath = join(e.projectDir, ".claude/skilletor.json");
    const praw = `{"sources":{"karr":{"local":"~/dev/karr"}}}`;
    writeFileSync(projPath, praw);
    await assert.rejects(() => cmdAdd(e.ctx, { name: "karr", spec: src, project: true }), (err: unknown) => {
      assert.ok(err instanceof CommandError, String(err));
      const msg = (err as Error).message;
      assert.ok(msg.includes(`source "karr" in ${projPath} is local ~/dev/karr`), msg);
      assert.ok(msg.includes(`skilletor add <name> ${src} --project`), msg);
      assert.ok(msg.includes("skilletor source remove karr --project"), msg);
      return true;
    });
    assert.equal(readFileSync(projPath, "utf8"), praw, "project config byte-identical");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");
  } finally {
    e.cleanup();
  }
});

// k95: config load refuses a source name outside ^[A-Za-z0-9][A-Za-z0-9._-]*$, so `add` must
// not write one. Asserts: an explicit name outside the pattern is a CommandError naming it as
// JSON, raised before the spec is resolved (the probe would throw) – neither config file is
// created, nothing is trusted.
test("k95: add refuses an explicit name outside the pattern before resolving or writing anything", async () => {
  const e = env();
  try {
    const projPath = join(e.projectDir, ".claude/skilletor.json");
    for (const [i, name] of ["a b", "../x", ".x", "-x", "team\u0007", "a/b", ""].entries()) {
      await assert.rejects(() => cmdAdd(e.ctx, { name, spec: "host.tld", project: i % 2 === 1 }), (err: unknown) => {
        assert.ok(err instanceof CommandError, String(err));
        assert.equal((err as Error).message, `source name ${JSON.stringify(name)} is not valid ` +
          `(ASCII letters, digits, ".", "_" and "-", starting with a letter or digit); nothing was changed`);
        return true;
      });
    }
    assert.equal(existsSync(e.userCfgPath), false, "no user config");
    assert.equal(existsSync(projPath), false, "no project config");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");
  } finally {
    e.cleanup();
  }
});

// k95: a directory whose name has no ASCII letter or digit derived "" – written as the
// source's key, which config load now refuses. Asserts: `add` without a name stores the
// fallback "source", and the sync it runs loads that config and installs from it.
test("k95: add without a name derives a valid one even from a directory named without ASCII", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "日本", (d) => skill(d, "foo"));
    const res = await cmdAdd(e.ctx, { spec: src });
    assert.equal(res.name, "source");
    assert.deepEqual(e.readUserCfg().sources, { source: { local: src } });
    assert.equal(res.report.error, undefined);
    e.writeUserCfg({ ...e.readUserCfg(), install: { skills: ["foo@source"] } });
    const r = await sync(e.ctx);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`), ["skills/foo@source"]);
  } finally {
    e.cleanup();
  }
});

// k110: resolveSpec keeps an explicit address verbatim and makes a `.tar.gz`/`.tgz` a `url`, so
// `add http://host/x.tar.gz` wrote a url config load refuses (https only) – every later sync
// failed, and `source remove` could not undo it. Asserts: each such spec, named or not, in the
// user or the project config, is a CommandError naming key, value and rule, before anything is
// written or trusted (user config byte-identical, no project config, no trust.json); load says
// the same of the def written by hand, and re-adding that hand-written entry (k101's keep path)
// is refused too; an https:// tarball is still added and loads.
test("k110: add refuses a spec that resolves to a url config load refuses, before writing or trusting", async () => {
  const e = env();
  try {
    const projPath = join(e.projectDir, ".claude/skilletor.json");
    const userRaw = `{ "sources": { "keep": { "git": "https://example.invalid/keep" } } }\n`;
    writeFileSync(e.userCfgPath, userRaw);
    const specs: [string, string][] = [
      ["http://host/x.tar.gz", "host"],
      ["file:///x.tar.gz", "source"],
      ["ftp://files.example/x.tgz", "files-example"],
      ["ssh://git@host.example/x.tar.gz", "host-example"],
      ["git@host.example:team/x.tar.gz", "team"],
    ];
    let i = 0;
    for (const [spec, derived] of specs) {
      for (const name of [undefined, "web"]) {
        const project = i++ % 2 === 1;
        await assert.rejects(() => cmdAdd(e.ctx, { name, spec, project }), (err: unknown) => {
          assert.ok(err instanceof CommandError, String(err));
          assert.equal((err as Error).message, `cannot add ${spec}: sources.${name ?? derived}.url ` +
            `${JSON.stringify(spec)} must be an https:// URL; nothing was changed`);
          return true;
        });
      }
    }
    assert.equal(readFileSync(e.userCfgPath, "utf8"), userRaw, "user config byte-identical");
    assert.equal(existsSync(projPath), false, "no project config");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");

    // The one rule: load refuses the same def with the same words, and add keeps no such entry.
    const handRaw = `{ "sources": { "web": { "url": "http://host/x.tar.gz" } } }\n`;
    writeFileSync(e.userCfgPath, handRaw);
    assert.throws(() => loadConfig({ home: e.home }), (err: unknown) => {
      assert.ok(err instanceof ConfigError, String(err));
      assert.equal((err as Error).message, `${e.userCfgPath}: sources.web.url "http://host/x.tar.gz" must be an https:// URL`);
      return true;
    });
    await assert.rejects(() => cmdAdd(e.ctx, { name: "web", spec: "http://host/x.tar.gz" }), (err: unknown) => {
      assert.ok(err instanceof CommandError, String(err));
      assert.equal((err as Error).message,
        `cannot add http://host/x.tar.gz: sources.web.url "http://host/x.tar.gz" must be an https:// URL; nothing was changed`);
      return true;
    });
    assert.equal(readFileSync(e.userCfgPath, "utf8"), handRaw, "hand-written config byte-identical");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");

    // What load takes, add still writes.
    writeFileSync(e.userCfgPath, userRaw);
    const ok = await cmdAdd(e.ctx, { spec: "https://host.example/x.tar.gz" });
    assert.deepEqual(ok.def, { url: "https://host.example/x.tar.gz" });
    assert.deepEqual(loadConfig({ home: e.home }).sources.get("host-example")?.url, "https://host.example/x.tar.gz");
  } finally {
    e.cleanup();
  }
});

// k116: k101's keep path trusted an entry with the same address whose other fields config load
// refuses (a hand-written `ref: ""`), then the sync after it stopped at that config error.
// Asserts, for each such entry in the user or the project config: `add` of that address is a
// CommandError quoting config load's own error for the entry, naming both ways out; the file
// byte-identical, nothing trusted, no sync (no lock in either scope). Fixed by hand, the same
// `add` keeps and trusts it again.
test("k116: add of an address whose kept entry config load refuses fails before trusting it", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "tools", ["t-one"]);
    const projPath = join(e.projectDir, ".claude/skilletor.json");
    const cases: { entry: Record<string, unknown>; spec: string; name?: string; project: boolean }[] = [
      { entry: { git: url, ref: "" }, spec: url, project: false },
      { entry: { git: url, ref: "-x" }, spec: url.replace(/\.git$/, ""), name: "tools", project: false },
      { entry: { git: url, ref: 5 }, spec: url, project: true },
      { entry: { git: url, rev: "main" }, spec: url, name: "tools", project: true },
    ];
    for (const c of cases) {
      const path = c.project ? projPath : e.userCfgPath;
      rmSync(e.userCfgPath, { force: true });
      rmSync(projPath, { force: true });
      const raw = `{ "sources": { "tools": ${JSON.stringify(c.entry)} } }\n`;
      writeFileSync(path, raw);
      let loadMsg = "";
      assert.throws(() => loadConfig({ home: e.home, projectDir: e.projectDir }), (err: unknown) => {
        assert.ok(err instanceof ConfigError, String(err));
        loadMsg = (err as Error).message;
        return true;
      });
      const flag = c.project ? " --project" : "";
      await assert.rejects(() => cmdAdd(e.ctx, { name: c.name, spec: c.spec, project: c.project }), (err: unknown) => {
        assert.ok(err instanceof CommandError, String(err));
        assert.equal((err as Error).message, `cannot add ${c.spec}: ${loadMsg}; nothing was changed. ` +
          `Source "tools" there already has this address: fix its entry by hand, or remove it ` +
          `(skilletor source remove tools${flag}).`);
        return true;
      });
      const label = JSON.stringify(c.entry);
      assert.equal(readFileSync(path, "utf8"), raw, `${label}: config byte-identical`);
      assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, `${label}: nothing trusted`);
      assert.equal(existsSync(join(e.home, ".claude/skilletor.lock.json")), false, `${label}: no sync, no user lock`);
      assert.equal(existsSync(join(e.projectDir, ".claude/skilletor.lock.json")), false, `${label}: no sync, no project lock`);
    }

    // Fixed by hand, the entry is kept, trusted and synced again.
    const fixed = `{ "sources": { "tools": { "git": "${url}", "ref": "main" } } }\n`;
    writeFileSync(projPath, fixed);
    const res = await cmdAdd(e.ctx, { spec: url, project: true });
    assert.equal(res.kept, true);
    assert.equal(res.report.error, undefined);
    assert.equal(readFileSync(projPath, "utf8"), fixed);
    assert.equal(new State(e.ctx.stateRoot).isTrusted("tools", { kind: "git", address: url, origin: "project" }), true);
  } finally {
    e.cleanup();
  }
});

// k109: `add gitlab:u/r` stored git https://github.com/gitlab:u/r, and `add HTTPS://…` a GitHub
// owner "HTTPS:". Asserts: an unknown prefix is the SpecError before anything is written or
// trusted (no config, no trust.json); an upper-case scheme is stored lower-case and loads.
test("k109: add refuses an unknown prefix before writing, and stores an upper-case scheme lower-case", async () => {
  const e = env();
  try {
    await assert.rejects(() => cmdAdd(e.ctx, { spec: "gitlab:u/r" }), (err: unknown) => {
      assert.ok(err instanceof SpecError, String(err));
      assert.match((err as Error).message, /^cannot resolve "gitlab:u\/r": unknown prefix "gitlab:"; expected /);
      return true;
    });
    assert.equal(existsSync(e.userCfgPath), false, "no config written");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");

    const ok = await cmdAdd(e.ctx, { spec: "HTTPS://host.example/x.tar.gz" });
    assert.deepEqual(ok.def, { url: "https://host.example/x.tar.gz" });
    assert.equal(loadConfig({ home: e.home }).sources.get("host-example")?.url, "https://host.example/x.tar.gz");
  } finally {
    e.cleanup();
  }
});

// k111: `add ""` stored git https://github.com//skills as source "source" and trusted it.
// Asserts: an empty or whitespace-only spec – with or without a name, to either config – is the
// SpecError before anything is written or trusted (no user or project config, no trust.json).
test("k111: add refuses an empty or whitespace-only spec before writing or trusting anything", async () => {
  const e = env();
  try {
    const calls = [{ spec: "" }, { spec: " \t" }, { name: "shared", spec: "" }, { spec: "", project: true }];
    for (const args of calls) {
      await assert.rejects(() => cmdAdd(e.ctx, args), (err: unknown) => {
        assert.ok(err instanceof SpecError, `${JSON.stringify(args)}: ${String(err)}`);
        assert.match((err as Error).message, /^cannot resolve "[ \t]*": empty source; expected /);
        return true;
      });
    }
    assert.equal(existsSync(e.userCfgPath), false, "no user config written");
    assert.equal(existsSync(join(e.projectDir, ".claude", "skilletor.json")), false, "no project config written");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");
  } finally {
    e.cleanup();
  }
});

// k117: `add github.com:Getty/karr` probed https://github.com:Getty/karr twice before failing,
// and `add Getty/re:po`, `add "a b"`, `add gitlab.com/a b/r` stored and trusted a source no fetch
// could serve. Asserts: each is the SpecError before anything is probed (the probe throws),
// written or trusted (no user or project config, no trust.json).
test("k117: add refuses an owner, repo or port no forge takes before probing, writing or trusting", async () => {
  const e = env();
  try {
    const calls = [
      { spec: "github.com:Getty/karr" }, { spec: "Getty/re:po" }, { spec: "a b", project: true },
      { name: "x", spec: "Getty/re po" }, { spec: "gitlab.com/a b/r" },
    ];
    for (const args of calls) {
      await assert.rejects(() => cmdAdd(e.ctx, args), (err: unknown) => {
        assert.ok(err instanceof SpecError, `${JSON.stringify(args)}: ${String(err)}`);
        assert.ok((err as Error).message.startsWith(`cannot resolve "${args.spec}": `), (err as Error).message);
        return true;
      });
    }
    assert.equal(existsSync(e.userCfgPath), false, "no user config written");
    assert.equal(existsSync(join(e.projectDir, ".claude", "skilletor.json")), false, "no project config written");
    assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");
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

// k65 (spec §6.4): a lock without entries is deleted; its readers take the missing file as empty.
test("uninstalling the last user item deletes the lock; status, check, available, source remove read it as empty", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => skill(d, "foo"));
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    const lockFile = join(e.home, ".claude/skilletor.lock.json");
    await cmdInstall(e.ctx, { items: [] });
    assert.equal(existsSync(lockFile), true);
    await cmdUninstall(e.ctx, { items: ["foo@mine"] });
    assert.equal(existsSync(lockFile), false);

    const st = status(e.ctx);
    assert.equal(st.error, undefined);
    assert.deepEqual(st.scopes.map((s) => [s.scope, s.declared, s.orphans, s.sourceVersions]),
      [["user", [], [], {}], ["project", [], [], {}]]);
    const chk = await check(e.ctx);
    assert.deepEqual([chk.error, chk.changed, chk.targetsChanged], [undefined, false, undefined]);
    assert.deepEqual((await cmdAvailable(e.ctx, { source: "mine" })).map((i) => [i.name, i.installed]), [["foo", false]]);
    const again = await sync(e.ctx);
    assert.deepEqual(again.scopes.map((s) => [s.added, s.removed, s.unchanged]), [[[], [], []], [[], [], []]]);
    await cmdSourceRemove(e.ctx, { name: "mine" }); // nothing installed: no --force needed
    assert.equal(e.readUserCfg().sources, undefined);
    assert.equal(existsSync(lockFile), false);
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

// k114: `source remove` of a name the target config lacks wrote nothing, synced and reported
// "removed source". Asserts, like `uninstall` of an absent entry (spec §7): a CommandError,
// `--force` or not, before anything else – the in-use check included – naming the target
// config and file, then where else the name is declared (the other scope's config, the
// project's skilletor.local.json), else that it is not a configured source; every config
// byte-identical, no project config created, and no sync run (no lock in either scope).
test("k114: source remove of a name the target config lacks fails and names where else it is declared", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => skill(d, "foo"));
    const projCfg = join(e.projectDir, ".claude", "skilletor.json");
    const localCfg = join(e.projectDir, ".claude", "skilletor.local.json");
    // `mine` is only the user config's (and installed from), `team` only the project's, `loc` only the local file's.
    e.writeUserCfg({ sources: { mine: { local: src } }, install: { skills: ["foo@mine"] } });
    writeFileSync(projCfg, JSON.stringify({ sources: { team: { local: src } } }, null, 2));
    writeFileSync(localCfg, JSON.stringify({ sources: { loc: { local: src } } }, null, 2));
    const files = [e.userCfgPath, projCfg, localCfg];
    const before = files.map((f) => readFileSync(f));
    const userWhere = `source "%s" is not declared in the user config (${e.userCfgPath})`;
    const projWhere = `source "%s" is not declared in the project config (${projCfg})`;
    const cases: [{ name: string; project?: boolean; force?: boolean }, string][] = [
      [{ name: "nope" }, `${userWhere}; it is not a configured source`],
      [{ name: "nope", force: true }, `${userWhere}; it is not a configured source`],
      [{ name: "nope", project: true, force: true }, `${projWhere}; it is not a configured source`],
      [{ name: "team" }, `${userWhere}; the project config declares it (use --project)`],
      [{ name: "mine", project: true }, `${projWhere}; the user config declares it (run without --project)`],
      [{ name: "mine", project: true, force: true }, `${projWhere}; the user config declares it (run without --project)`],
      [{ name: "loc" }, `${userWhere}; ${localCfg} declares it (edit that file by hand)`],
      [{ name: "loc", project: true }, `${projWhere}; ${localCfg} declares it (edit that file by hand)`],
    ];
    for (const [args, message] of cases) {
      await assert.rejects(() => cmdSourceRemove(e.ctx, args), {
        name: "CommandError",
        message: message.replace("%s", args.name),
      }, JSON.stringify(args));
    }
    assert.deepEqual(files.map((f) => readFileSync(f)), before, "every config byte-identical");
    assert.equal(existsSync(join(e.home, ".claude", "skilletor.lock.json")), false, "no sync: no user lock");
    assert.equal(existsSync(join(e.projectDir, ".claude", "skilletor.lock.json")), false, "no sync: no project lock");

    // Only the project config and the local file declare `both`: each is named.
    writeFileSync(projCfg, JSON.stringify({ sources: { both: { local: src } } }, null, 2));
    writeFileSync(localCfg, JSON.stringify({ sources: { both: { local: src } } }, null, 2));
    await assert.rejects(() => cmdSourceRemove(e.ctx, { name: "both" }), {
      message: `${userWhere.replace("%s", "both")}; the project config declares it (use --project); ` +
        `${localCfg} declares it (edit that file by hand)`,
    });
    // Without a project config at all, --project creates none.
    rmSync(projCfg);
    await assert.rejects(() => cmdSourceRemove(e.ctx, { name: "mine", project: true }), /user config declares it/);
    assert.equal(existsSync(projCfg), false, "no project config created");
  } finally {
    e.cleanup();
  }
});

// k114: without a project scope (the project dir is the home dir) there is no other config to
// name. Asserts: the plain error for the user config, the user config byte-identical.
test("k114: source remove of an unknown name without a project scope says it is not a configured source", async () => {
  const e = env();
  try {
    e.writeUserCfg({ sources: { mine: { local: e.home } } });
    const before = readFileSync(e.userCfgPath);
    await assert.rejects(() => cmdSourceRemove({ ...e.ctx, projectDir: e.home }, { name: "nope" }), {
      name: "CommandError",
      message: `source "nope" is not declared in the user config (${e.userCfgPath}); it is not a configured source`,
    });
    assert.deepEqual(readFileSync(e.userCfgPath), before);
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
    assert.equal(existsSync(join(e.projectDir, ".claude/rules/.local.r1.md")), true);
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
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), true);
    await cmdUninstall(e.ctx, { items: ["rule:*@mine"] });
    assert.deepEqual(e.readUserCfg().install, { skills: ["*@mine"] });
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), false);
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
    assert.equal(existsSync(join(e.home, ".claude/agents/.local.dup.md")), true);
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
      assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), true);
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
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), true);
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
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), true); // go still yields it
    await cmdUninstall(e.ctx, { items: ["go@mine"] });
    assert.equal(e.readUserCfg().install, undefined);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.r1.md")), false);
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

// k100: `agents/x.md` beside `agents/x.md.njk` is an error of item x (spec §4.1), like a
// bundle's `.yaml`/`.yml` clash (§15.4). Asserts: install of x – typed or bare – fails naming
// both files and edits nothing, as a broken bundle's does; available lists x once, with that
// error, and every other item without one; the source's other items still install.
test("k100: an item with both x.md and x.md.njk: install fails naming both, available lists it with its error", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      agent(d, "x");
      writeFileSync(join(d, "agents", "x.md.njk"), "---\ndescription: x template\n---\nprompt\n");
      agent(d, "ok");
      skill(d, "s1");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    for (const spec of ["agent:x@mine", "x@mine"]) {
      await assert.rejects(() => cmdInstall(e.ctx, { items: [spec] }),
        (err: unknown) => err instanceof CommandError &&
          err.message === "mine: agent x: both agents/x.md and agents/x.md.njk exist", spec);
    }
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["ok@mine", "x@mine"] }), /both agents\/x\.md and agents\/x\.md\.njk/);
    assert.equal(e.readUserCfg().install, undefined);

    const items = await cmdAvailable(e.ctx, { source: "mine" });
    assert.deepEqual(items.map((i) => [`${i.type}:${i.name}`, i.error]).sort(), [
      ["agent:ok", undefined],
      ["agent:x", "both agents/x.md and agents/x.md.njk exist"],
      ["skill:s1", undefined],
    ]);

    const r = await cmdInstall(e.ctx, { items: ["ok@mine", "s1@mine"] });
    assert.deepEqual(r.scopes[0]!.added.map((i) => i.key).sort(), ["agents/ok", "skills/s1"]);
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

// ---- bundles naming items of other sources (k48 phase B, spec §15.6) -----------

/** A bare git repo (file:// URL) with the given rules: a remote that resolves offline. */
function gitRepo(root: string, name: string, rules: string[]): string {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
  for (const r of rules) rule(work, r);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
  execFileSync("git", ["add", "."], { cwd: work, env: G });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: work, env: G });
  const url = "file://" + resolvePath(bare);
  execFileSync("git", ["push", "-q", url, "main"], { cwd: work, env: G });
  return url;
}

/** A prompter answering from a list and recording the questions. */
function answers(...list: string[]) {
  const questions: string[] = [];
  return {
    questions,
    prompt: { ask: async (q: string) => { questions.push(q); return list.shift() ?? "n"; } },
  };
}

test("install bundle: without a TTY fails before editing anything and prints the add commands", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      bundleFile(d, "perl", "description: P\nrules: [r1, x@gitlab.com/peter, y@gitlab.com/peter, z@Getty/repo]\n");
    });
    const cfg = { sources: { mine: { local: src }, repo: { git: "https://example.com/other" } } };
    e.writeUserCfg(cfg);
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["bundle:perl@mine"] }), (err: unknown) => {
      assert.ok(err instanceof CommandError);
      const msg = (err as Error).message;
      assert.match(msg, /bundle perl needs sources you don't have yet/);
      assert.match(msg, /^  skilletor add peter gitlab\.com\/peter$/m);
      // Getty/repo derives its repo's name (k101), and "repo" is taken by another identity.
      assert.match(msg, /^  skilletor add repo-2 Getty\/repo$/m);
      assert.equal(msg.match(/skilletor add peter /g)!.length, 1); // once per source
      return true;
    });
    assert.deepEqual(e.readUserCfg(), cfg);
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["bundle:perl@mine"], project: true }), /skilletor add peter gitlab\.com\/peter --project/);
  } finally {
    e.cleanup();
  }
});

test("install bundle: on a TTY asks per missing source; accepting adds and trusts it like add", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", `description: P\nrules: ["p-*@${url}"]\n`));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const derived = resolveSpec(url, noProbe).derivedName;
    const a = answers("");
    const r = await cmdInstall({ ...e.ctx, prompt: a.prompt }, { items: ["bundle:perl@mine"] });
    assert.deepEqual(a.questions, [
      `bundle perl needs a source you don't have yet: ${url} → ${url} — add it as [${derived}]? (name, or n to skip)`,
    ]);
    const cfg = e.readUserCfg();
    assert.deepEqual(cfg.sources[derived], { git: url });
    assert.deepEqual(cfg.install, { bundles: ["perl@mine"] });
    assert.equal(new State(e.ctx.stateRoot).isTrusted(derived, { kind: "git", address: url, origin: "project" }), true);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`), [`rules/p-one@${derived}`]);
  } finally {
    e.cleanup();
  }
});

test("install bundle: a taken name is refused and asked again; n skips; --project adds to the project", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", `description: P\nrules: [p-one@${url}]\n`));
    e.writeUserCfg({ sources: { mine: { local: src }, taken: { git: "https://example.com/other" } } });
    const a = answers("taken", "pete");
    await cmdInstall({ ...e.ctx, prompt: a.prompt }, { items: ["bundle:perl@mine"], project: true });
    assert.equal(a.questions.length, 2);
    assert.match(a.questions[1]!, /"taken" is already a source with another address/);
    const proj = JSON.parse(readFileSync(join(e.projectDir, ".claude/skilletor.json"), "utf8"));
    assert.deepEqual(proj.sources, { pete: { git: url } });
    assert.deepEqual(proj.install, { bundles: ["perl@mine"] });
    assert.equal(e.readUserCfg().sources.pete, undefined);

    const b = answers("n");
    const r = await cmdInstall({ ...e.ctx, prompt: b.prompt }, { items: ["bundle:perl@mine"] });
    assert.equal(b.questions.length, 1);
    assert.equal(e.readUserCfg().sources.pete, undefined); // user scope does not see the project's source
    assert.deepEqual(e.readUserCfg().install, { bundles: ["perl@mine"] });
    assert.match(r.scopes[0]!.warnings.join("\n"), /bundle perl@mine needs/);
  } finally {
    e.cleanup();
  }
});

// k102: the missing-source prompt never writes over an entry of the config it writes to, as
// `add` never replaces one (k101). Here the user file's `peter` is a local override and only
// the project file gives it the bundle's address, so the user scope has no source serving it.
// Asserts: without a TTY the printed command names `peter-2` (`add peter` would be refused)
// and both files stay byte-identical; on a TTY `peter-2` is the default, typing `peter` is
// refused naming the user file's own entry, and accepting adds `peter-2` – user `peter` and
// the project file untouched, `peter-2` trusted and installed from.
test("k102: install bundle never proposes or writes over a name its target config already has", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    const derived = resolveSpec(url, noProbe).derivedName;
    assert.equal(derived, "peter");
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", `description: P\nrules: [p-one@${url}]\n`));
    const checkout = makeSource(e.tmp.dir, "peter-checkout", (d) => rule(d, "x-one"));
    e.writeUserCfg({ sources: { mine: { local: src }, peter: { local: checkout } } });
    const projPath = join(e.projectDir, ".claude/skilletor.json");
    const projRaw = JSON.stringify({ sources: { peter: { git: url } } }, null, 2) + "\n";
    writeFileSync(projPath, projRaw);
    const userRaw = readFileSync(e.userCfgPath, "utf8");

    await assert.rejects(() => cmdInstall(e.ctx, { items: ["bundle:perl@mine"] }), (err: unknown) => {
      const lines = (err as Error).message.split("\n");
      assert.ok(lines.includes(`  skilletor add peter-2 ${url}`), (err as Error).message);
      return true;
    });
    assert.equal(readFileSync(e.userCfgPath, "utf8"), userRaw);
    assert.equal(readFileSync(projPath, "utf8"), projRaw);

    const a = answers("peter", "");
    const r = await cmdInstall({ ...e.ctx, prompt: a.prompt }, { items: ["bundle:perl@mine"] });
    const question = `bundle perl needs a source you don't have yet: ${url} → ${url} — add it as [peter-2]? (name, or n to skip)`;
    assert.deepEqual(a.questions, [
      question,
      `"peter" is already a source with another address (local ${checkout}). ${question}`,
    ]);
    assert.deepEqual(e.readUserCfg().sources, { mine: { local: src }, peter: { local: checkout }, "peter-2": { git: url } });
    assert.equal(readFileSync(projPath, "utf8"), projRaw);
    assert.equal(new State(e.ctx.stateRoot).isTrusted("peter-2", { kind: "git", address: url, origin: "project" }), true);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`), ["rules/p-one@peter-2"]);
  } finally {
    e.cleanup();
  }
});

// k95: the prompt and config load share one rule. This pins the prompt side: a name config
// load would refuse is refused and asked again, and the name it takes loads. Asserts: "a b"
// and "_x" each get the note and the question again, "ok.name" is added and the sync installs
// from it without a config error.
test("k95: the bundle prompt refuses what config load refuses and takes what it loads", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", `description: P\nrules: [p-one@${url}]\n`));
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const a = answers("a b", "_x", "ok.name");
    const r = await cmdInstall({ ...e.ctx, prompt: a.prompt }, { items: ["bundle:perl@mine"] });
    const question = `bundle perl needs a source you don't have yet: ${url} → ${url} — add it as [peter]? (name, or n to skip)`;
    assert.deepEqual(a.questions, [
      question,
      `"a b" is not a valid source name. ${question}`,
      `"_x" is not a valid source name. ${question}`,
    ]);
    assert.deepEqual(e.readUserCfg().sources, { mine: { local: src }, "ok.name": { git: url } });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`), ["rules/p-one@ok.name"]);
  } finally {
    e.cleanup();
  }
});

// k95: a bundle entry's address with no ASCII letter or digit in its name part derived "",
// so without a TTY the printed command was `skilletor add  ___` – a spec where the name goes.
// Asserts: the printed command names the fallback "source", config untouched. (`___` itself is
// no GitHub owner since k117, so a known forge's owner of underscores stands in.)
test("k95: install bundle without a TTY prints a valid derived name for any address", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", "description: P\nrules: [x@gitlab.com/___]\n"));
    const cfg = { sources: { mine: { local: src } } };
    e.writeUserCfg(cfg);
    await assert.rejects(() => cmdInstall(e.ctx, { items: ["bundle:perl@mine"] }), (err: unknown) => {
      assert.ok(err instanceof CommandError, String(err));
      assert.ok((err as Error).message.split("\n").includes("  skilletor add source gitlab.com/___"), (err as Error).message);
      return true;
    });
    assert.deepEqual(e.readUserCfg(), cfg);
  } finally {
    e.cleanup();
  }
});

// k110: the prompt adds a missing source as `add` would, from the same resolveSpec, so a bundle
// entry `x@http://host/x.tar.gz` would be added as a url config load refuses. Asserts: without
// a TTY and on one, install is a CommandError naming the bundle, the address, key, value and
// rule before any question is asked; the user config stays byte-identical (not even the bundle
// entry or the source's own items), nothing is trusted.
test("k110: install bundle refuses a missing source it could only add as a url config load refuses", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      bundleFile(d, "perl", "description: P\nrules: [r1, x@http://host/x.tar.gz]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const raw = readFileSync(e.userCfgPath, "utf8");
    const msg = `bundle perl needs http://host/x.tar.gz, which cannot be added as a source: ` +
      `sources.host.url "http://host/x.tar.gz" must be an https:// URL; nothing was changed`;
    for (const tty of [false, true]) {
      const a = answers("");
      await assert.rejects(
        () => cmdInstall({ ...e.ctx, prompt: tty ? a.prompt : undefined }, { items: ["bundle:perl@mine", "rule:r1@mine"] }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError, String(err));
          assert.equal((err as Error).message, msg);
          return true;
        },
      );
      assert.deepEqual(a.questions, [], "no question asked");
      assert.equal(readFileSync(e.userCfgPath, "utf8"), raw, "user config byte-identical");
      assert.equal(existsSync(join(e.ctx.stateRoot, "trust.json")), false, "nothing trusted");
    }
  } finally {
    e.cleanup();
  }
});

test("install bundle: a source already configured under any name is not asked for", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", `description: P\nrules: [p-one@${url}]\n`));
    e.writeUserCfg({ sources: { mine: { local: src }, whatever: { git: url } } });
    const a = answers();
    await cmdInstall({ ...e.ctx, prompt: a.prompt }, { items: ["bundle:perl@mine"] });
    assert.deepEqual(a.questions, []);
    assert.equal(existsSync(join(e.home, ".claude/rules/.local.p-one.md")), true);
  } finally {
    e.cleanup();
  }
});

test("available lists a bundle's members of other sources with their address", async () => {
  const e = env();
  try {
    const src = makeSource(e.tmp.dir, "s", (d) => {
      rule(d, "r1");
      bundleFile(d, "perl", "description: P\nrules: [r1, \"p-*@gitlab.com/peter\"]\n");
    });
    e.writeUserCfg({ sources: { mine: { local: src } } });
    const perl = (await cmdAvailable(e.ctx, { source: "mine" })).find((i) => i.type === "bundle")!;
    assert.deepEqual(perl.members, ["rule:p-*@gitlab.com/peter", "rule:r1"]);
  } finally {
    e.cleanup();
  }
});

// ---- the sync lock (k74) ------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Another run holding `sync.lock/` (spec §6.5) until `release()`. */
function holdSyncLock(stateRoot: string) {
  let free!: () => void;
  const held = new State(stateRoot).withLock(() => new Promise<void>((r) => (free = r)));
  return { release: async () => { free(); await held; } };
}

// k74 (spec §6.5): resolving writes the source cache, so `available` resolves under the sync
// lock, as a sync does. Asserts: while another run holds the lock, available has not
// returned, has written nothing to the cache, and has left a dead run's leftovers alone; once
// the lock is free it sweeps them, lists the source's items and frees the lock again.
test("k74: available waits for a held sync lock before it fetches, then sweeps leftovers and lists", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    e.writeUserCfg({ sources: { peter: { git: url } } });
    const cache = join(e.ctx.stateRoot, "cache");
    const leftovers = ["0123456789abcdef.backup-Ef34Gh", "0123456789abcdef.stage-Ab12Cd"];
    for (const d of leftovers) mkdirSync(join(cache, d), { recursive: true });
    const lock = holdSyncLock(e.ctx.stateRoot);
    let done = false;
    const run = cmdAvailable(e.ctx).then((r) => { done = true; return r; });
    try {
      await delay(200);
      assert.equal(done, false, "available waits for the lock");
      assert.deepEqual(readdirSync(cache).sort(), leftovers, "nothing fetched, nothing swept while another run holds it");
    } finally {
      await lock.release();
      await run.catch(() => {});
    }
    const items = await run;
    assert.deepEqual(items.map((i) => `${i.type}:${i.name}@${i.source}`), ["rule:p-one@peter"]);
    assert.deepEqual(readdirSync(cache).filter((d) => /\.(stage|backup)-/.test(d)), []);
    assert.equal(existsSync(join(e.ctx.stateRoot, "sync.lock")), false);
  } finally {
    e.cleanup();
  }
});

// k74: install resolves under the lock for its planning pass only: the sync it runs takes
// the lock itself (the mutex is not reentrant), and a question must not hold what the hooks
// wait for. Asserts: while another run holds the lock, install neither fetches nor edits the
// config; after release it installs the item (its own sync got the lock, no timeout); while
// it asks about a bundle's missing source, the lock is free.
test("k74: install plans under the sync lock, then asks and syncs without holding it", async () => {
  const e = env();
  try {
    const url = gitRepo(e.tmp.dir, "peter", ["p-one"]);
    e.writeUserCfg({ sources: { peter: { git: url } } });
    const cache = join(e.ctx.stateRoot, "cache");
    const lock = holdSyncLock(e.ctx.stateRoot);
    let done = false;
    const run = cmdInstall(e.ctx, { items: ["p-one@peter"] }).then((r) => { done = true; return r; });
    try {
      await delay(200);
      assert.equal(done, false, "install waits for the lock");
      assert.equal(existsSync(cache), false, "nothing fetched while another run holds the lock");
      assert.equal(e.readUserCfg().install, undefined, "config untouched");
    } finally {
      await lock.release();
      await run.catch(() => {});
    }
    const r = await run;
    assert.equal(r.error, undefined);
    assert.deepEqual(r.scopes[0]!.added.map((i) => `${i.key}@${i.source}`), ["rules/p-one@peter"]);

    const paul = gitRepo(e.tmp.dir, "paul", ["q-one"]);
    const src = makeSource(e.tmp.dir, "s", (d) => bundleFile(d, "perl", `description: P\nrules: [q-one@${paul}]\n`));
    e.writeUserCfg({ ...e.readUserCfg(), sources: { peter: { git: url }, mine: { local: src } } });
    const held: boolean[] = [];
    const prompt = { ask: async () => { held.push(existsSync(join(e.ctx.stateRoot, "sync.lock"))); return "n"; } };
    await cmdInstall({ ...e.ctx, prompt }, { items: ["bundle:perl@mine"] });
    assert.deepEqual(held, [false], "asked once, with the lock free");
  } finally {
    e.cleanup();
  }
});
