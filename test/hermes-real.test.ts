// The `hermes` target and the Hermes plugin against real Hermes Agent (spec §16.6): the built
// CLI installs into a throwaway HERMES_HOME, and a fresh Hermes process per step looks at it
// through Hermes' own skill listing, plugin loader and hook dispatch. No model is called.
//
// $HERMES_PYTHON, else ~/dev/hermes-citiai/.dev/venv/bin/python; skipped without it. The
// throwaway homes live under <checkout>/.tmp-hermes (gitignored), never under the system temp
// directory – a tmpfs on the machine this was written on – and are removed afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildToString } from "../scripts/esbuild.config.mjs";
import { gitEnv } from "../src/gitenv.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(root, "hermes", "skilletor");
const HERMES_PYTHON = process.env.HERMES_PYTHON || join(homedir(), "dev/hermes-citiai/.dev/venv/bin/python");
const HERMES = join(dirname(HERMES_PYTHON), "hermes");

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const skip = executable(HERMES_PYTHON) && executable(HERMES) ? false : `no Hermes Agent at ${HERMES_PYTHON}`;

const SCRATCH = join(root, ".tmp-hermes");
const run = join(SCRATCH, `real-${process.pid}`);
/** The CLI under test: a shim around a bundle built from this source, not the committed dist/. */
let cli: string;

before(async () => {
  if (skip) return;
  mkdirSync(run, { recursive: true });
  const bundle = join(run, "skilletor.mjs");
  writeFileSync(bundle, await buildToString());
  cli = join(run, "skilletor");
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${bundle}' "$@"\n`);
  chmodSync(cli, 0o755);
});

after(() => {
  rmSync(run, { recursive: true, force: true });
  try {
    if (readdirSync(SCRATCH).length === 0) rmdirSync(SCRATCH);
  } catch {
    // not there, or another run's homes are
  }
});

const SKILL = (name: string, body = "BODY") =>
  `---\nname: ${name}\ndescription: Use when testing skilletor on Hermes (${name}).\n---\n\n# ${name}\n\n${body}\n`;

let cases = 0;

/** One throwaway machine: a home with skilletor's config, a Hermes home, a git project, a source. */
function machine(opts: { enabled?: string[]; trustProject?: boolean } = {}) {
  const dir = join(run, `case-${++cases}`);
  const home = join(dir, "home");
  const hermesHome = join(dir, "hermes-home");
  const project = join(dir, "project");
  const src = join(dir, "source");
  for (const d of [join(home, ".claude"), join(hermesHome, "plugins"), join(project, ".claude"), join(dir, "tmp")]) {
    mkdirSync(d, { recursive: true });
  }
  execFileSync("git", ["init", "-q", project], { env: gitEnv() });
  const config = (enabled: string[], trust: boolean) => writeFileSync(join(hermesHome, "config.yaml"), [
    "plugins:", enabled.length ? "  enabled:" : "  enabled: []", ...enabled.map((p) => `    - ${p}`),
    ...(trust ? ["skills:", "  trusted_project_dirs:", `    - ${project}`] : []), "",
  ].join("\n"));
  config(opts.enabled ?? ["skilletor"], opts.trustProject ?? false);
  const skill = (name: string, body?: string) => {
    mkdirSync(join(src, "skills", name), { recursive: true });
    writeFileSync(join(src, "skills", name, "SKILL.md"), SKILL(name, body));
  };
  const declare = (user: string[], inProject: string[] = []) => {
    writeFileSync(join(home, ".claude", "skilletor.json"),
      JSON.stringify({ sources: { mine: { local: src } }, install: { skills: user.map((n) => `${n}@mine`) } }));
    writeFileSync(join(project, ".claude", "skilletor.json"),
      JSON.stringify({ install: { skills: inProject.map((n) => `${n}@mine`) } }));
  };
  /** The environment of a Hermes (or skilletor) process on this machine: nothing of the
   *  developer's Hermes, Claude Code, Codex or skilletor, and its temp files on disk. */
  const env = (more: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const kept = Object.fromEntries(Object.entries(gitEnv()).filter(([k]) =>
      !/^(HERMES_|CLAUDE_|CLAUDECODE|CODEX_|SKILLETOR_|AI_AGENT)/.test(k)));
    return {
      ...kept, HOME: home, HERMES_HOME: hermesHome, CODEX_HOME: join(home, ".no-codex"), TMPDIR: join(dir, "tmp"),
      SKILLETOR_BIN: cli, PYTHONDONTWRITEBYTECODE: "1", // no __pycache__ in the linked plugin directory
      ...more,
    };
  };
  const installPlugin = (how: "link" | "copy") => {
    const at = join(hermesHome, "plugins", "skilletor");
    if (how === "link") symlinkSync(PLUGIN, at);
    else cpSync(PLUGIN, at, { recursive: true, filter: (p) => !p.includes("__pycache__") });
  };
  const skilletor = (args: string[], cwd = project, more: Record<string, string> = {}) =>
    spawnSync(cli, args, { encoding: "utf8", env: env(more), cwd });
  /** `hermes <args>`: a fresh Hermes process. */
  const hermes = (args: string[], cwd = project, more: Record<string, string> = {}) =>
    spawnSync(HERMES, args, { encoding: "utf8", env: env(more), cwd, timeout: 300_000 });
  /** A fresh Hermes process running `body`, which fills `out`; its JSON is the last line. */
  const python = (body: string, cwd = project, more: Record<string, string> = {}): Record<string, any> => {
    const r = spawnSync(HERMES_PYTHON, ["-c", HEAD + body + TAIL], { encoding: "utf8", env: env(more), cwd, timeout: 300_000 });
    assert.equal(r.status, 0, r.stderr.slice(-3000));
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  };
  return { dir, home, hermesHome, project, src, config, skill, declare, env, installPlugin, skilletor, hermes, python };
}

const HEAD = `
import json, os, sys
out = {}

def listing():
    """What the model's skills_list tool answers, and what skill_view makes of each name asked."""
    from tools.skills_tool import skills_list, skill_view
    names = sorted(s["name"] for s in json.loads(skills_list())["skills"])
    views = {}
    for name in os.environ.get("VIEW", "").split():
        v = json.loads(skill_view(name))
        views[name] = {"success": v.get("success"), "content": v.get("content"), "error": v.get("error"),
                       "skill_dir": v.get("skill_dir")}
    return {"names": names, "views": views}

def plugin():
    from hermes_cli.plugins import discover_plugins, get_plugin_manager, has_hook
    discover_plugins()
    listed = [p for p in get_plugin_manager().list_plugins() if p["key"] == "skilletor"]
    return {"listed": [{k: p[k] for k in ("name", "enabled", "error", "hooks", "source")} for p in listed],
            "hooks": {name: has_hook(name) for name in ("on_session_start", "pre_llm_call")}}

def session_start(session_id="s1", platform="cli"):
    from hermes_cli.lifecycle import invoke_hook
    return invoke_hook("on_session_start", session_id=session_id, model="m", platform=platform)

def turn(session_id="s1", first=True, platform="cli"):
    # The kwargs of agent/turn_context.py:792-804.
    from hermes_cli.lifecycle import invoke_hook
    return invoke_hook(
        "pre_llm_call", session_id=session_id, task_id="t1", turn_id="turn1", user_message="hi",
        conversation_history=[], is_first_turn=first, model="m", platform=platform,
        parent_session_id="", sender_id="")
`;
const TAIL = "\nprint(json.dumps(out))\n";

test("a user skill installed for the target hermes is in Hermes' own listing and loads", { skip }, () => {
  const m = machine();
  m.skill("sk-demo");
  m.declare(["sk-demo"]);
  const sync = m.skilletor(["sync"]);
  assert.equal(sync.status, 0, sync.stderr);
  // Hermes alone is in use on this machine: detected by the config.yaml in its home. (The
  // throwaway home lies inside this checkout, so the report also has .gitignore lines.)
  assert.match(sync.stdout, /^skilletor: user scope\n {2}\+ hermes:skills\/sk-demo \(active from the next Hermes session\)\n/);
  assert.doesNotMatch(sync.stdout, /^ {2}[+~] (?!hermes:)/m);
  assert.equal(existsSync(join(m.home, ".claude", "skills")), false);

  const listed = m.hermes(["skills", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /sk-demo\s*│[^\n]*local[^\n]*enabled/);

  const out = m.python("out.update(listing())", m.project, { VIEW: "sk-demo" });
  assert.deepEqual(out.names, ["sk-demo"]);
  assert.deepEqual(out.views["sk-demo"], {
    success: true, content: SKILL("sk-demo"), error: null, skill_dir: join(m.hermesHome, "skills", "sk-demo"),
  });

  // Uninstalled: gone from Hermes too.
  m.declare([]);
  assert.match(m.skilletor(["sync"]).stdout, /- hermes:skills\/sk-demo \(removed\)/);
  assert.deepEqual(m.python("out.update(listing())").names, []);
});

test("a project skill: under .hermes/skills in a trusted project; with Codex active the Codex copy serves Hermes", { skip }, () => {
  const m = machine({ trustProject: true });
  m.skill("sk-proj");
  m.declare([], ["sk-proj"]);
  assert.equal(m.skilletor(["sync"]).status, 0);
  assert.equal(existsSync(join(m.project, ".hermes/skills/sk-proj/SKILL.md")), true);
  const own = m.python("out.update(listing())", m.project, { VIEW: "sk-proj" });
  assert.deepEqual(own.names, ["sk-proj"]);
  assert.equal(own.views["sk-proj"].skill_dir, join(m.project, ".hermes/skills/sk-proj"));

  // Not from an untrusted project (Hermes' rule; skilletor leaves the trust list alone).
  m.config(["skilletor"], false);
  assert.deepEqual(m.python("out.update(listing())").names, []);
  m.config(["skilletor"], true);

  // Codex comes into use: its copy in .agents/skills is the one Hermes reads.
  const codexHome = join(m.dir, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const both = { CODEX_HOME: codexHome };
  const sync = m.skilletor(["sync"], m.project, both);
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /\+ codex:skills\/sk-proj/);
  assert.match(sync.stdout, /- hermes:skills\/sk-proj \(removed\)/);
  assert.match(sync.stdout, /note: 1 skill\(s\) not installed for Hermes in the project scope \(Hermes reads the Codex copy in \.agents\/skills\)/);
  assert.equal(existsSync(join(m.project, ".hermes/skills")), false);
  const served = m.python("out.update(listing())", m.project, { ...both, VIEW: "sk-proj" });
  assert.deepEqual(served.names, ["sk-proj"]);
  assert.deepEqual([served.views["sk-proj"].success, served.views["sk-proj"].skill_dir],
    [true, join(m.project, ".agents/skills/sk-proj")]);

  // Why Hermes gets no copy of its own then: the same name in both project directories is
  // one Hermes refuses to load (agent/skill_utils.py:469). Should this start to pass, the
  // rule in targets.ts (projectVia) has lost its reason.
  cpSync(join(m.project, ".agents/skills/sk-proj"), join(m.project, ".hermes/skills/sk-proj"), { recursive: true });
  const twice = m.python("out.update(listing())", m.project, { ...both, VIEW: "sk-proj" });
  assert.deepEqual(twice.names, []);
  assert.equal(twice.views["sk-proj"].success, false);
  assert.match(twice.views["sk-proj"].error, /Ambiguous skill name/);
});

test("the plugin loads through plugins.enabled; a session start syncs; the first turn carries the report", { skip }, () => {
  const m = machine();
  m.installPlugin("link");
  m.skill("sk-demo");
  m.declare(["sk-demo"]);
  const at = join(m.hermesHome, "skills", "sk-demo", "SKILL.md");
  const out = m.python(`
out.update(plugin())
out["before"] = os.path.exists(${JSON.stringify(at)})
out["start"] = session_start()
out["after"] = os.path.exists(${JSON.stringify(at)})
out["first"] = turn()
out["second"] = turn(first=False)
out["child"] = [session_start("c1", "subagent"), turn("c1", platform="subagent")]
out["listing"] = listing()
`, m.project, { VIEW: "sk-demo" });
  assert.deepEqual(out.listed, [{ name: "skilletor", enabled: true, error: null, hooks: 2, source: "user" }]);
  assert.deepEqual(out.hooks, { on_session_start: true, pre_llm_call: true });
  // Hermes' own on_session_start dispatch ran the sync …
  assert.deepEqual([out.before, out.start, out.after], [false, [], true]);
  // … and its pre_llm_call dispatch returns what Hermes appends to the user message.
  assert.equal(out.first.length, 1);
  assert.deepEqual(Object.keys(out.first[0]), ["context"]);
  assert.match(out.first[0].context,
    /^skilletor synced items:\n- skill sk-demo@mine \(hermes\): active from the next Hermes session(\n|$)/);
  assert.deepEqual(out.second, []);
  assert.deepEqual(out.child, [[], []]);
  // In the same process the skill tools already see it (the prompt's index is built earlier).
  assert.deepEqual(out.listing.names, ["sk-demo"]);
  assert.equal(out.listing.views["sk-demo"].success, true);
  assert.equal(readFileSync(at, "utf8"), SKILL("sk-demo"));

  // The next session: nothing changed, nothing said; a source that moved is picked up.
  assert.deepEqual(m.python(`out["s"] = [session_start("s2"), turn("s2")]`).s, [[], []]);
  m.skill("sk-demo", "NEW");
  const next = m.python(`out["s"] = [session_start("s3"), turn("s3")]`);
  assert.match(next.s[1][0].context, /^skilletor synced items:\n- skill sk-demo@mine \(hermes\)/);
  assert.equal(readFileSync(at, "utf8"), SKILL("sk-demo", "NEW"));
});

test("placing the plugin is not enough: without plugins.enabled nothing is registered or synced", { skip }, () => {
  const m = machine({ enabled: [] });
  m.installPlugin("copy");
  m.skill("sk-demo");
  m.declare(["sk-demo"]);
  const out = m.python(`
out.update(plugin())
out["start"] = [session_start(), turn()]
`);
  assert.deepEqual(out.listed.map((p: { enabled: boolean }) => p.enabled), [false]);
  assert.deepEqual(out.hooks, { on_session_start: false, pre_llm_call: false });
  assert.deepEqual(out.start, [[], []]);
  assert.equal(existsSync(join(m.hermesHome, "skills", "sk-demo")), false);
});

test("fail open under Hermes: no CLI, or one that fails – the hooks answer nothing and Hermes goes on", { skip }, () => {
  const m = machine();
  m.installPlugin("copy");
  m.skill("sk-demo");
  m.declare(["sk-demo"]);
  const failing = join(m.dir, "failing");
  writeFileSync(failing, "#!/bin/sh\necho '{\"systemMessage\": \"never shown\"}'\nexit 1\n");
  chmodSync(failing, 0o755);
  for (const bin of [join(m.dir, "missing"), failing]) {
    const out = m.python(`
out.update(plugin())
out["start"] = [session_start(), turn(), turn(first=False)]
`, m.project, { SKILLETOR_BIN: bin });
    assert.deepEqual(out.listed.map((p: { error: unknown }) => p.error), [null], bin);
    assert.deepEqual(out.start, [[], [], []], bin);
  }
  assert.equal(existsSync(join(m.hermesHome, "skills", "sk-demo")), false);
});

test("hermes skilletor …: the CLI, for this Hermes home", { skip }, () => {
  const m = machine();
  m.installPlugin("link");
  m.skill("sk-demo");
  m.declare(["sk-demo"]);
  const sync = m.hermes(["skilletor", "sync", "--scope", "user"]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /\+ hermes:skills\/sk-demo/);
  const status = m.hermes(["skilletor", "status", "--scope", "user"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /user scope \(hermes\):\n {2}✓ hermes:skills\/sk-demo @mine/);
  // The CLI's exit code is Hermes'.
  assert.equal(m.hermes(["skilletor", "frobnicate"]).status, 2);
});

test("hermes plugins doctor --ci passes without a finding", { skip }, () => {
  const m = machine();
  const r = m.hermes(["plugins", "doctor", PLUGIN, "--ci"], m.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /warning|error/i);
  // Doctor's own temporary Hermes home went to this machine's TMPDIR, on disk, and is gone.
  assert.deepEqual(readdirSync(join(m.dir, "tmp")).filter((n) => n.startsWith("hermes-plugin-doctor-")), []);
});
