// Black-box test of the built CLI bundle: build it, run it, assert on its output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildToString } from "../scripts/esbuild.config.mjs";
import { claudeOnlyEnv } from "./helpers/harness.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

let tmp: TmpDir;
// Written as .mjs so Node runs the ESM bundle as ESM even outside a package.json.
let bundle: string;
// k123: the cwd of a spawn that names none – an empty directory outside git, so a command or
// hook without --project-dir or a cwd of its own never takes this checkout, whose
// .claude/skilletor.json is real, as its project.
let noProject: string;

before(async () => {
  tmp = makeTmpDir();
  bundle = join(tmp.dir, "skilletor.mjs");
  writeFileSync(bundle, await buildToString());
  noProject = join(tmp.dir, "no-project");
  mkdirSync(noProject);
});

after(() => tmp.cleanup());

function runCli(args: string[], env?: NodeJS.ProcessEnv, input?: string, cwd?: string) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: env ?? process.env, input, cwd: cwd ?? noProject });
}

test("--version prints the package version", () => {
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("--help prints usage including the program name", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skilletor/);
  assert.match(r.stdout, /usage/i);
});

// The usage text must track the dispatcher: every command in run()'s switch and
// every flag parseFlags accepts is listed. `hook` is internal (plugin hooks only).
test("--help lists every dispatched command and parsed flag, nothing 'coming soon'", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const commands = [...src.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!).filter((c) => c !== "hook");
  const flags = [...src.matchAll(/a === "(--[a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(commands.length >= 9, `expected to find the dispatcher cases, got ${commands.join(",")}`);
  assert.ok(flags.length >= 5, `expected to find parseFlags literals, got ${flags.join(",")}`);

  const out = runCli(["--help"]).stdout;
  for (const c of commands) assert.match(out, new RegExp(`^  ${c}\\b`, "m"), `usage misses command ${c}`);
  for (const f of flags) assert.match(out, new RegExp(`${f}(?![a-z-])`), `usage misses flag ${f}`);
  for (const sub of ["source list", "source remove <name>"]) assert.ok(out.includes(sub), `usage misses ${sub}`);
  assert.doesNotMatch(out, /coming soon/i);
  assert.doesNotMatch(out, /^  hook\b/m);
});

test("no arguments prints usage", () => {
  const r = runCli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage/i);
});

test("an unknown command exits non-zero with a message", () => {
  for (const args of [["frobnicate"], ["frobnicate", "--json"], ["constructor", "--json"]]) {
    const r = runCli(args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown command/i);
  }
  const sub = runCli(["source", "toString", "--json"]);
  assert.equal(sub.status, 2);
  assert.match(sub.stderr, /usage: source list \| source remove/);
});

// k34: wildcard install through the real binary, with HOME in a temp dir.
test("install 'rule:*@src' and status text marks wildcard items", () => {
  const home = join(tmp.dir, "wild-home");
  const proj = join(tmp.dir, "wild-proj");
  const src = join(tmp.dir, "wild-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "r1.md"), "---\ndescription: r1\n---\nR1\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { shared: { local: src } } }));
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];

  const bare = runCli(["install", "*@shared", ...common], env);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /type prefix/);

  const ok = runCli(["install", "rule:*@shared", ...common], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\+ rules\/r1/);

  const st = runCli(["status", "--scope", "user", ...common], env);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /rules\/r1 @shared via \*@shared/);
  assert.match(st.stdout, /\* rules\/\* @shared \(1 installed\)/);
});

// k71: an entry a sync that stopped midway left partial. Asserts: status names it in text
// and JSON, so a user sees why the next sync has work to do.
test("status marks an item the last sync left partial", () => {
  const home = join(tmp.dir, "partial-home");
  const proj = join(tmp.dir, "partial-proj");
  const src = join(tmp.dir, "partial-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nFOO\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { shared: { local: src } } }));
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];
  const ok = runCli(["install", "foo@shared", ...common], env);
  assert.equal(ok.status, 0, ok.stderr);
  const lockFile = join(home, ".claude", "skilletor.lock.json");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  lock["skills/foo"].partial = true;
  writeFileSync(lockFile, JSON.stringify(lock));

  const st = runCli(["status", "--scope", "user", ...common], env);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^ {2}✓ skills\/foo @shared \(partial: the last sync stopped midway\)$/m);
  const json = runCli(["status", "--scope", "user", "--json", ...common], env);
  assert.equal(JSON.parse(json.stdout).scopes[0].declared[0].partial, true);
});

// k48: bundles and patterns through the real binary, with HOME in a temp dir.
test("install bundle:name@src and a pattern; status and available show bundles; uninstall bundle:", () => {
  const home = join(tmp.dir, "bundle-home");
  const proj = join(tmp.dir, "bundle-proj");
  const src = join(tmp.dir, "bundle-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  mkdirSync(join(src, "bundles"), { recursive: true });
  for (const r of ["perl-a", "perl-b", "go-c"]) writeFileSync(join(src, "rules", `${r}.md`), `---\ndescription: ${r}\n---\nX\n`);
  writeFileSync(join(src, "bundles", "perl.yaml"), "description: Perl things\nrules: [\"perl-*\"]\nvars:\n  v: 1\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { shared: { local: src } } }));
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];

  const ok = runCli(["install", "bundle:perl@shared", "rule:go-*@shared", ...common], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\+ rules\/perl-a/);
  assert.match(ok.stdout, /\+ rules\/go-c/);

  const st = runCli(["status", "--scope", "user", ...common], env);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /rules\/perl-a @shared via bundle:perl@shared/);
  assert.match(st.stdout, /rules\/go-c @shared via go-\*@shared/);
  assert.match(st.stdout, /\* rules\/go-\* @shared \(1 installed\)/);
  assert.match(st.stdout, /\* bundle:perl@shared \(2 installed\)/);

  const av = runCli(["available", "shared", ...common], env);
  assert.equal(av.status, 0, av.stderr);
  assert.match(av.stdout, /✓ bundle perl@shared — Perl things\n\s+rule:perl-a, rule:perl-b/);
  const avJson = JSON.parse(runCli(["available", "shared", "--json", ...common], env).stdout);
  assert.deepEqual(avJson.find((i: { type: string }) => i.type === "bundle").vars, { v: 1 });

  const only = runCli(["uninstall", "perl-a@shared", ...common], env);
  assert.equal(only.status, 1);
  assert.match(only.stderr, /bundle bundle:perl@shared/);

  const un = runCli(["uninstall", "bundle:perl@shared", ...common], env);
  assert.equal(un.status, 0, un.stderr);
  assert.match(un.stdout, /- rules\/perl-a/);
});

// k100: `rules/x.md` beside `rules/x.md.njk`, through the real binary. Asserts: `available`
// prints x once with an `error:` line naming both files (as a broken bundle's), and the other
// rule plainly; `install x@shared` exits 1 with that error on stderr and leaves the config
// byte-identical; `sync` of a wildcard exits 0, installs the other rule and names both files.
test("k100: x.md beside x.md.njk: available shows the error, install exits 1, sync installs the rest", () => {
  const home = join(tmp.dir, "k100-home");
  const proj = join(tmp.dir, "k100-proj");
  const src = join(tmp.dir, "k100-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "x.md"), "---\ndescription: x\n---\nX\n");
  writeFileSync(join(src, "rules", "x.md.njk"), "---\ndescription: x\n---\nX\n");
  writeFileSync(join(src, "rules", "ok.md"), "---\ndescription: fine\n---\nOK\n");
  const cfgPath = join(home, ".claude", "skilletor.json");
  const cfg = JSON.stringify({ sources: { shared: { local: src } } });
  writeFileSync(cfgPath, cfg);
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];

  const av = runCli(["available", "shared", ...common], env);
  assert.equal(av.status, 0, av.stderr);
  assert.equal(av.stdout, "  rule ok@shared — fine\n  rule x@shared\n    error: both rules/x.md and rules/x.md.njk exist\n");

  const inst = runCli(["install", "x@shared", ...common], env);
  assert.equal(inst.status, 1);
  assert.equal(inst.stdout, "");
  assert.match(inst.stderr, /shared: rule x: both rules\/x\.md and rules\/x\.md\.njk exist/);
  assert.equal(readFileSync(cfgPath, "utf8"), cfg);

  writeFileSync(cfgPath, JSON.stringify({ sources: { shared: { local: src } }, install: { rules: ["*@shared"] } }));
  const sy = runCli(["sync", "--scope", "user", ...common], env);
  assert.equal(sy.status, 0, sy.stderr);
  assert.match(sy.stdout, /\+ rules\/ok/);
  assert.match(sy.stdout, /rule x@shared: both rules\/x\.md and rules\/x\.md\.njk exist/);
  assert.equal(existsSync(join(home, ".claude", "rules", ".local.x.md")), false);
});

// k113: inside a skill, `f` beside `f.njk`, through the real binary. Asserts: `available` prints
// each broken skill with an `error:` line naming both files (SKILL.md's pair without a
// description, a companion's pair with SKILL.md's) and the intact one plainly; `install y@shared`
// exits 1 with that error on stderr and leaves the config byte-identical; `sync` of a wildcard
// exits 0, installs the intact skill, names both files of each broken one and installs neither.
test("k113: a skill with f beside f.njk: available shows the error, install exits 1, sync installs the rest", () => {
  const home = join(tmp.dir, "k113-home");
  const proj = join(tmp.dir, "k113-proj");
  const src = join(tmp.dir, "k113-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const put = (rel: string, content: string) => {
    mkdirSync(join(src, rel, ".."), { recursive: true });
    writeFileSync(join(src, rel), content);
  };
  put("skills/ok/SKILL.md", "---\ndescription: fine\n---\nOK\n");
  put("skills/x/SKILL.md", "---\ndescription: x\n---\nX\n");
  put("skills/x/SKILL.md.njk", "---\ndescription: x\n---\nX\n");
  put("skills/y/SKILL.md", "---\ndescription: runs x\n---\nY\n");
  put("skills/y/scripts/x.sh", "#!/bin/sh\n");
  put("skills/y/scripts/x.sh.njk", "#!/bin/sh\n");
  const cfgPath = join(home, ".claude", "skilletor.json");
  const cfg = JSON.stringify({ sources: { shared: { local: src } } });
  writeFileSync(cfgPath, cfg);
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];

  const av = runCli(["available", "shared", ...common], env);
  assert.equal(av.status, 0, av.stderr);
  assert.equal(av.stdout, [
    "  skill ok@shared — fine",
    "  skill x@shared",
    "    error: both skills/x/SKILL.md and skills/x/SKILL.md.njk exist",
    "  skill y@shared — runs x",
    "    error: both skills/y/scripts/x.sh and skills/y/scripts/x.sh.njk exist",
  ].join("\n") + "\n");

  const inst = runCli(["install", "y@shared", ...common], env);
  assert.equal(inst.status, 1);
  assert.equal(inst.stdout, "");
  assert.match(inst.stderr, /shared: skill y: both skills\/y\/scripts\/x\.sh and skills\/y\/scripts\/x\.sh\.njk exist/);
  assert.equal(readFileSync(cfgPath, "utf8"), cfg);

  writeFileSync(cfgPath, JSON.stringify({ sources: { shared: { local: src } }, install: { skills: ["*@shared"] } }));
  const sy = runCli(["sync", "--scope", "user", ...common], env);
  assert.equal(sy.status, 0, sy.stderr);
  assert.match(sy.stdout, /\+ skills\/ok/);
  assert.match(sy.stdout, /skill x@shared: both skills\/x\/SKILL\.md and skills\/x\/SKILL\.md\.njk exist/);
  assert.match(sy.stdout, /skill y@shared: both skills\/y\/scripts\/x\.sh and skills\/y\/scripts\/x\.sh\.njk exist/);
  assert.equal(existsSync(join(home, ".claude", "skills", "x")), false);
  assert.equal(existsSync(join(home, ".claude", "skills", "y")), false);
});

// k48 phase B: without a TTY, a bundle needing an unknown source exits 1 and edits nothing.
test("install bundle: with a missing source and no TTY exits 1, prints the add command, edits nothing", () => {
  const home = join(tmp.dir, "foreign-home");
  const proj = join(tmp.dir, "foreign-proj");
  const src = join(tmp.dir, "foreign-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "bundles"), { recursive: true });
  writeFileSync(join(src, "bundles", "perl.yaml"), "description: Perl\nrules: [\"p-*@gitlab.com/peter\"]\n");
  const cfgPath = join(home, ".claude", "skilletor.json");
  const cfg = JSON.stringify({ sources: { shared: { local: src } } });
  writeFileSync(cfgPath, cfg);
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];

  const r = runCli(["install", "bundle:perl@shared", ...common], env, "");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skilletor add peter gitlab\.com\/peter/);
  // k87: the error's own line breaks stay line breaks – the add command is a line to copy.
  assert.match(r.stderr, /install again:\n {2}skilletor add peter gitlab\.com\/peter\n$/);
  assert.equal(readFileSync(cfgPath, "utf8"), cfg);

  const av = runCli(["available", "shared", ...common], env);
  assert.match(av.stdout, /bundle perl@shared — Perl\n\s+rule:p-\*@gitlab\.com\/peter/);
});

// k37: uninstall through the real binary: wildcard-only exits 1 with the hint,
// explicit-plus-wildcard exits 0 and still warns.
test("uninstall of a wildcard-covered item: exit 1 alone, exit 0 with a warning when explicit", () => {
  const home = join(tmp.dir, "unwild-home");
  const proj = join(tmp.dir, "unwild-proj");
  const src = join(tmp.dir, "unwild-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "r1.md"), "---\ndescription: r1\n---\nR1\n");
  const cfg = join(home, ".claude", "skilletor.json");
  writeFileSync(cfg, JSON.stringify({ sources: { shared: { local: src } }, install: { rules: ["*@shared"] } }));
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];

  const only = runCli(["uninstall", "r1@shared", ...common], env);
  assert.equal(only.status, 1);
  assert.match(only.stderr, /wildcard rule:\*@shared/);
  assert.match(only.stderr, /skilletor uninstall 'rule:\*@shared'/);

  const none = runCli(["uninstall", "nope@shared", ...common], env);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /nope@shared is not declared/);

  writeFileSync(cfg, JSON.stringify({ sources: { shared: { local: src } }, install: { rules: ["r1@shared", "*@shared"] } }));
  const both = runCli(["uninstall", "r1@shared", ...common], env);
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stderr, /warning: .*wildcard rule:\*@shared/);
  assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")).install, { rules: ["*@shared"] });
});

// k35: a gated-off rule through the real binary: exit 0, skip line, status marker.
test("sync reports a rule that renders empty as skipped and exits 0", () => {
  const home = join(tmp.dir, "empty-home");
  const proj = join(tmp.dir, "empty-proj");
  const src = join(tmp.dir, "empty-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "k8s.md.njk"), "{% if vars.k8s %}K{% endif %}\n");
  writeFileSync(
    join(home, ".claude", "skilletor.json"),
    JSON.stringify({ sources: { s: { local: src } }, install: { rules: ["k8s@s"] }, vars: { k8s: false } }),
  );
  const env = claudeOnlyEnv(home);
  const common = ["--scope", "user", "--project-dir", proj];

  const r = runCli(["sync", ...common], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rules\/k8s skipped \(renders empty\)/);
  const st = runCli(["status", ...common], env);
  assert.match(st.stdout, /rules\/k8s @s \(skipped: renders empty\)/);
});

// spec §14: a Codex-only machine (temp HOME + CODEX_HOME), hook input as Codex
// sends it — no CLAUDE_PROJECT_DIR, cwd in a subdirectory of the repo.
test("codex hook through the binary: project skill lands in <repo>/.agents/skills, JSON out, exit 0", () => {
  const home = join(tmp.dir, "codex-home");
  const codexHome = join(home, ".codex");
  const repo = join(tmp.dir, "codex-repo");
  const src = join(tmp.dir, "codex-src");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "installation_id"), "test\n"); // what Codex writes on first run
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "skills", "bar"), { recursive: true });
  writeFileSync(join(src, "skills", "bar", "SKILL.md"), "---\nname: bar\ndescription: bar\n---\nBAR\n");
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "agents", "helper.md"), "---\nname: helper\ndescription: helps\nmodel: opus\n---\nYou help.\n");
  mkdirSync(join(src, "rules"), { recursive: true });
  writeFileSync(join(src, "rules", "style.md"), "Use tabs.\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } } }));
  mkdirSync(join(repo, ".claude"), { recursive: true });
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["bar@s"] } }));
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } }, install: { agents: ["helper@s"], rules: ["style@s"] } }));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.SKILLETOR_PROJECT_DIR;

  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: join(repo, "sub"), session_id: "s1" });
  const r = runCli(["hook", "session-start", "--harness", "codex"], env, input);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /skill bar@s \(codex\): active from the next Codex session/);
  // --harness codex: the user rules file leads the context, the report follows (spec §14.8).
  const rules = readFileSync(join(codexHome, "skilletor-rules.md"), "utf8");
  assert.match(rules, /^<!-- skilletor:rules scope=user -->\n[\s\S]*<!-- skilletor:rule style source=s -->\nUse tabs\.\n$/);
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(rules + "\nskilletor synced items:\n"));
  // k62: the new project block asks for a commit, to the user and to the model.
  assert.match(out.systemMessage, /\.claude\/\.gitignore updated — commit it/);
  assert.match(out.hookSpecificOutput.additionalContext, /^- \.claude\/\.gitignore updated — commit it$/m);
  assert.equal(existsSync(join(realpathSync(repo), ".agents/skills/bar/SKILL.md")), true);
  assert.equal(existsSync(join(repo, ".claude/skills")), false); // Claude not in use here
  // The user agent became a Codex agent role under CODEX_HOME.
  assert.equal(
    readFileSync(join(codexHome, "agents", ".local.helper.toml"), "utf8"),
    "name = \"helper\"\ndescription = \"helps\"\ndeveloper_instructions = '''\nYou help.\n'''\n",
  );

  // $CODEX_HOME/AGENTS.md only points to the rules file.
  const agents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("`" + join(codexHome, "skilletor-rules.md") + "` before you start a task"), agents);
  assert.doesNotMatch(agents, /Use tabs/);
  // resume: synced, but no second copy of the rules.
  const resume = runCli(["hook", "session-start", "--harness", "codex"], env, input.replace("startup", "resume"));
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(resume.stdout, "");

  const st = runCli(["status", "--project-dir", repo], env);
  assert.match(st.stdout, /^project scope \(codex\):$/m);
  assert.match(st.stdout, /✓ codex:skills\/bar @s/);
  // The hook was never trusted in this CODEX_HOME: status says so once (spec §14.8).
  assert.equal(st.stdout.match(/^warning: Codex has not trusted skilletor's SessionStart hook/gm)?.length, 1);
  // A no-change sync still says it is up to date; the trust warning comes in addition.
  const again = runCli(["sync", "--project-dir", repo], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^skilletor: up to date$/m);
  assert.equal(again.stdout.match(/^skilletor: warning: Codex has not trusted skilletor's SessionStart hook/gm)?.length, 1);
});

test("no harness on the machine: sync fails with the fix named, exit 2", () => {
  const home = join(tmp.dir, "bare-home");
  const proj = join(tmp.dir, "bare-proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, ".claude", "skilletor.json"), "{}");
  const r = runCli(["sync", "--scope", "user", "--project-dir", proj], { ...process.env, HOME: home, CODEX_HOME: join(home, "nope") });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no agent harness detected.*set "targets"/);
});

// k44: run from ~ (or with --project-dir ~) there is no project scope.
test("project dir = home: status says so in one line, --project edits fail", () => {
  const home = join(tmp.dir, "hp-home");
  const src = join(tmp.dir, "hp-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nF\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } }, install: { skills: ["foo@s"] } }));
  const env = claudeOnlyEnv(home);

  const sy = runCli(["sync", "--project-dir", home], env);
  assert.equal(sy.status, 0, sy.stderr);
  assert.doesNotMatch(sy.stdout, /project/);
  const st = runCli(["status", "--project-dir", home], env);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^user scope:$/m);
  assert.doesNotMatch(st.stdout, /^project scope:$/m);
  assert.match(st.stdout, /^project scope: none \(the project directory is the home directory\)$/m);
  assert.equal(JSON.parse(runCli(["status", "--json", "--project-dir", home], env).stdout).projectIsHome, true);

  const inst = runCli(["install", "foo@s", "--project", "--project-dir", home], env);
  assert.equal(inst.status, 1);
  assert.match(inst.stderr, /no project scope: the project directory is the home directory/);
});

// k43: without --project-dir the CLI takes the git top level of cwd, like the hooks.
test("default project dir: git top level of cwd; a subdir of a git ~ has no project scope", () => {
  const home = join(tmp.dir, "top-home");
  const repo = join(tmp.dir, "top-repo");
  const src = join(tmp.dir, "top-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "skills", "bar"), { recursive: true });
  writeFileSync(join(src, "skills", "bar", "SKILL.md"), "---\nname: bar\ndescription: bar\n---\nB\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } } }));
  mkdirSync(join(repo, ".claude"), { recursive: true });
  mkdirSync(join(repo, "sub", "deep"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["bar@s"] } }));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const env = claudeOnlyEnv(home);
  delete env.CLAUDE_PROJECT_DIR;
  delete env.SKILLETOR_PROJECT_DIR;

  const r = runCli(["sync"], env, undefined, join(repo, "sub", "deep"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(repo, ".claude/skills/bar/SKILL.md")), true);
  assert.equal(existsSync(join(repo, "sub", "deep", ".claude")), false);
  const st = runCli(["status"], env, undefined, join(repo, "sub"));
  assert.match(st.stdout, /✓ skills\/bar @s/);

  // Outside git, cwd itself stays the project.
  const plain = join(tmp.dir, "top-plain");
  mkdirSync(join(plain, ".claude"), { recursive: true });
  writeFileSync(join(plain, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["bar@s"] } }));
  assert.equal(runCli(["sync"], env, undefined, plain).status, 0);
  assert.equal(existsSync(join(plain, ".claude/skills/bar/SKILL.md")), true);

  // ~ as a git checkout (dotfiles): from a subdir of ~ the project is ~, so no project scope.
  execFileSync("git", ["init", "-q", "-b", "main", home]);
  mkdirSync(join(home, "notes"), { recursive: true });
  const hs = runCli(["status"], env, undefined, join(home, "notes"));
  assert.equal(hs.status, 0, hs.stderr);
  assert.match(hs.stdout, /^project scope: none/m);
});

// k65 (spec §6.4): every sync runs the project scope of the directory it starts in; where
// skilletor is not used it writes nothing and asks for no commit.
test("sync in a git repo or a plain dir that never used skilletor: nothing written there, no commit hint", () => {
  const home = join(tmp.dir, "unused-home");
  const src = join(tmp.dir, "unused-src");
  const repo = join(tmp.dir, "unused-repo");
  const plain = join(tmp.dir, "unused-plain");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nF\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } }, install: { skills: ["foo@s"] } }));
  mkdirSync(repo, { recursive: true });
  mkdirSync(plain, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const env = claudeOnlyEnv(home);
  delete env.CLAUDE_PROJECT_DIR;
  delete env.SKILLETOR_PROJECT_DIR;

  const r = runCli(["sync"], env, undefined, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}\+ skills\/foo \(active now\)$/m);
  assert.doesNotMatch(r.stdout, /project scope|commit it/);
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.equal(existsSync(join(repo, ".claude")), false);

  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nG\n");
  const p = runCli(["sync"], env, undefined, plain);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^ {2}~ skills\/foo \(active now\)$/m);
  assert.doesNotMatch(p.stdout, /project scope|commit it/);
  assert.deepEqual(readdirSync(plain), []);
});

// k65 (spec §6.4): a project that drops skilletor keeps nothing behind — the lock without
// entries is deleted, not left as an unignored `{}`.
test("a committed project drops skilletor: sync leaves only deletions of tracked files, status --json reads no lock", () => {
  const home = join(tmp.dir, "drop-home");
  const src = join(tmp.dir, "drop-src");
  const repo = join(tmp.dir, "drop-repo");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nF\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } } }));
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skilletor.json"), JSON.stringify({ install: { skills: ["foo@s"] } }));
  const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { env: G, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const env = claudeOnlyEnv(home);

  const first = runCli(["sync", "--project-dir", repo], env);
  assert.equal(first.status, 0, first.stderr);
  git("add", "-A");
  git("commit", "-qm", "use skilletor");
  assert.deepEqual(git("ls-files").split("\n").filter(Boolean), [".claude/.gitignore", ".claude/skilletor.json"]);

  rmSync(join(repo, ".claude", "skilletor.json"));
  const drop = runCli(["sync", "--project-dir", repo], env);
  assert.equal(drop.status, 0, drop.stderr);
  assert.match(drop.stdout, /^ {2}- skills\/foo \(removed\)$/m);
  assert.doesNotMatch(drop.stdout, /commit it/);
  assert.equal(git("status", "--porcelain"), " D .claude/.gitignore\n D .claude/skilletor.json\n"); // no ?? lock
  assert.deepEqual(readdirSync(join(repo, ".claude")), []);

  const st = runCli(["status", "--json", "--project-dir", repo], env);
  assert.equal(st.status, 0, st.stderr);
  const project = JSON.parse(st.stdout).scopes.find((s: { scope: string }) => s.scope === "project");
  assert.deepEqual([project.declared, project.orphans, project.sourceVersions], [[], [], {}]);
});

// k55: argument hygiene (spec §7).
function hygieneHome(name: string) {
  const home = join(tmp.dir, `${name}-home`);
  const src = join(tmp.dir, `${name}-src`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nF\n");
  const cfg = JSON.stringify({ sources: { s: { local: src } }, install: { skills: ["foo@s"] } });
  writeFileSync(join(home, ".claude", "skilletor.json"), cfg);
  const env = claudeOnlyEnv(home);
  const untouched = () => {
    assert.equal(existsSync(join(home, ".claude/skills/foo")), false, "nothing installed");
    assert.equal(existsSync(join(home, ".claude/skilletor.lock.json")), false, "no lock written");
    assert.equal(readFileSync(join(home, ".claude", "skilletor.json"), "utf8"), cfg, "config untouched");
  };
  return { home, env, untouched };
}

test("-h/--help anywhere prints the usage and does nothing else: sync --help never syncs", () => {
  const h = hygieneHome("help");
  const cases = [
    ["sync", "--help"], ["sync", "-h"], ["sync", "--scope", "user", "--help"], ["--help", "sync"],
    ["install", "bar@s", "--help"], ["uninstall", "foo@s", "-h"], ["source", "remove", "s", "--help"],
    ["add", "x", "/nowhere", "--help"], ["trust", "s", "-h"], ["sync", "--bogus", "--help"],
  ];
  for (const args of cases) {
    const r = runCli([...args, "--project-dir", h.home], h.env);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:$/m, args.join(" "));
    assert.equal(r.stderr, "", args.join(" "));
    h.untouched();
  }
});

test("-v/--version counts only as the first argument", () => {
  const h = hygieneHome("ver");
  for (const v of ["-v", "--version"]) {
    const first = runCli([v, "sync"], h.env);
    assert.equal(first.status, 0);
    assert.match(first.stdout.trim(), /^\d+\.\d+\.\d+/);
    const later = runCli(["sync", v, "--project-dir", h.home], h.env);
    assert.equal(later.status, 2, v);
    assert.match(later.stderr, new RegExp(`unknown option.*${v}`), v);
    assert.equal(later.stdout, "");
    h.untouched();
  }
});

test("an option the command does not accept: exit 2, named, nothing touched", () => {
  const h = hygieneHome("unk");
  const cases: [string[], string][] = [
    [["sync", "--bogus"], "--bogus"], [["sync", "--project"], "--project"], [["sync", "-x"], "-x"],
    [["check", "--force"], "--force"], [["status", "--force"], "--force"],
    [["install", "foo@s", "--json"], "--json"], [["install", "foo@s", "--scope", "user"], "--scope"],
    [["uninstall", "foo@s", "--force"], "--force"], [["add", "x", "/nowhere", "--json"], "--json"],
    [["source", "list", "--force"], "--force"], [["source", "remove", "s", "--json"], "--json"],
    [["available", "--project"], "--project"], [["trust", "s", "--json"], "--json"],
    [["--bogus"], "--bogus"], [["sync", "--scope=user", "--jsn"], "--jsn"],
  ];
  for (const [args, opt] of cases) {
    const r = runCli([...args, "--project-dir", h.home], h.env);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^skilletor: unknown option( for [a-z ]+)?: /, args.join(" "));
    assert.ok(r.stderr.includes(`: ${opt} `), `${args.join(" ")}: ${r.stderr}`);
    h.untouched();
  }
});

test("every documented option still works for its command", () => {
  const h = hygieneHome("ok");
  const pd = ["--project-dir", h.home];
  const cases: string[][] = [
    ["status", "--json", "--scope", "user"], ["status", "--scope=all"], ["check", "--json", "--scope", "user"],
    ["available", "s", "--json"], ["source", "list", "--json"],
    ["sync", "--json", "--force", "--scope", "user"], ["sync", "--project-dir=" + h.home],
    ["install", "foo@s", "--project"], ["uninstall", "foo@s", "--project"],
    ["trust", "nope"], ["add", "extra", join(tmp.dir, "ok-src"), "--project"],
    ["source", "remove", "extra", "--project", "--force"],
  ];
  for (const args of cases) {
    const r = runCli([...args, ...pd], h.env);
    assert.doesNotMatch(r.stderr, /unknown option/, args.join(" "));
    assert.notEqual(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  // The internal hook flag stays accepted, and the hook still exits 0 on anything. Its input
  // names no cwd, so the project is the spawn's cwd: ~, as for the commands above.
  const hook = runCli(["hook", "session-start", "--harness", "codex", "--whatever"], h.env, "{}", h.home);
  assert.equal(hook.status, 0);
});

// k56: status names an agent's missing briefing skills, in text and --json.
test("status shows an agent's briefing skills that are not installed", () => {
  const home = join(tmp.dir, "brief-home");
  const src = join(tmp.dir, "brief-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "agents", "rev.md"), "---\ndescription: d\nbriefing:\n  skills: [gone, \"p:x\"]\n---\nB\n");
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { s: { local: src } }, install: { agents: ["rev@s"] } }));
  const env = claudeOnlyEnv(home);
  const sy = runCli(["sync", "--project-dir", home], env);
  assert.equal(sy.status, 0, sy.stderr);
  assert.match(sy.stdout, /warning: agent rev \(claude\): briefing skills not installed: gone —/);
  const st = runCli(["status", "--project-dir", home], env);
  assert.match(st.stdout, /✓ agents\/rev @s \(briefing skills not installed: gone\)/);
  const js = JSON.parse(runCli(["status", "--json", "--project-dir", home], env).stdout);
  assert.deepEqual(js.scopes[0].declared[0].briefingMissing, ["gone"]);
});

// k85: a ref that would reach git as an option is a config error. Asserts: through the built
// bundle, `sync` exits 2 naming the file, the source and the key on stderr; the SessionStart
// hook on the same project exits 0 with one JSON line whose systemMessage says the same.
test("k85: a project ref starting with \"-\": sync fails naming it, the hook exits 0 with one warning", () => {
  const home = join(tmp.dir, "dash-home");
  const proj = join(tmp.dir, "dash-proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(proj, ".claude"), { recursive: true });
  const cfg = join(proj, ".claude", "skilletor.json");
  const ref = `--upload-pack=touch '${join(tmp.dir, "dash-pwned")}'`; // never run: a marker in the temp dir
  writeFileSync(cfg, JSON.stringify({
    sources: { team: { git: "https://example.invalid/skills", ref } },
    install: { skills: ["foo@team"] },
  }));
  const env = claudeOnlyEnv(home);
  delete env.CLAUDE_PROJECT_DIR;
  delete env.SKILLETOR_PROJECT_DIR;
  const problem = `${cfg}: sources.team.ref ${JSON.stringify(ref)} must not start with "-" (git would read it as an option)`;

  const sy = runCli(["sync", "--project-dir", proj], env);
  assert.equal(sy.status, 2);
  assert.equal(sy.stderr, `skilletor: config error, nothing changed — ${problem}\n`);

  const hook = runCli(["hook", "session-start"], env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: proj }));
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, JSON.stringify({ systemMessage: `skilletor: ${problem}` }) + "\n");
  assert.equal(existsSync(join(tmp.dir, "dash-pwned")), false);
});

// ---- k87: strings from a config, a source or git are display-safe --------------------

/** An ANSI color escape, a BEL, a right-to-left override and a newline. */
const EVIL = "\u001b[31mred\u0007\u202eevil\nnext";
/** How EVIL shows: each of them escaped the JSON way, the text around them as it was. */
const SHOWN = "\\u001b[31mred\\u0007\\u202eevil\\nnext";
/** A character no output line carries raw (a tab may; a newline only between lines). */
const RAW = /(?![\t\n])[\p{Cc}\p{Bidi_Control}\u200b\u2028\u2029\u2060\ufeff]/u;

/** A home, a project whose config (a cloned repo) declares a source placed with EVIL. Its name
 *  is plain: one with EVIL is a config error since k95 (the next test). */
function evilProject(tag: string) {
  const home = join(tmp.dir, `${tag}-home`);
  const proj = join(tmp.dir, `${tag}-proj`);
  const payload = join(tmp.dir, `${tag}-payload`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "skilletor.json"), JSON.stringify({
    sources: { team: { local: payload + EVIL } },
    install: { skills: ["foo@team"] },
  }));
  return { home, proj, payload, env: claudeOnlyEnv(home), common: ["--project-dir", proj] };
}

// Asserts: `status`, `source list` and `trust` name an untrusted project source whose address
// carries EVIL escaped, each on its one line, nothing raw; `status --json` carries it escaped
// too, and parses back to the very address (JSON's own escapes).
test("k87: status, source list and trust show a project source's address escaped", () => {
  const p = evilProject("k87-status");
  const st = runCli(["status", "--scope", "project", ...p.common], p.env);
  assert.equal(st.status, 0, st.stderr);
  assert.doesNotMatch(st.stdout, RAW);
  assert.ok(st.stdout.split("\n").includes(`  trust: team (local ${p.payload}${SHOWN})`), st.stdout);

  const json = runCli(["status", "--scope", "project", "--json", ...p.common], p.env);
  assert.equal(json.status, 0, json.stderr);
  assert.doesNotMatch(json.stdout, RAW);
  assert.ok(json.stdout.includes(`"url": "${p.payload}${SHOWN}"`), json.stdout);
  assert.deepEqual(JSON.parse(json.stdout).scopes[0].trustRequests, [{ name: "team", kind: "local", url: p.payload + EVIL }]);

  const list = runCli(["source", "list", ...p.common], p.env);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, `team [project] {"local":"${p.payload}${SHOWN}"}\n`);

  const trust = runCli(["trust", "team", ...p.common], p.env);
  assert.equal(trust.status, 0, trust.stderr);
  assert.equal(trust.stdout, `trusted source team (local ${p.payload}${SHOWN})\n`);
});

// Asserts: a source name with EVIL – a config error (k95), found before the source's unknown
// key – is one escaped line on sync's and check's stderr, nothing changed, and the SessionStart
// hook through the binary gives that line as its systemMessage; an error thrown for an unknown
// source of that name shows no raw escape, BEL or override.
test("k87: a config error or a failed command naming such a source is escaped on stderr and in the hook", () => {
  const p = evilProject("k87-error");
  const cfg = join(p.proj, ".claude", "skilletor.json");
  writeFileSync(cfg, JSON.stringify({ sources: { [`team${EVIL}`]: { local: "/src", x: 1 } } }));
  const problem = `${cfg}: source name "team${SHOWN}" is not valid ` +
    `(ASCII letters, digits, ".", "_" and "-", starting with a letter or digit)`;

  const sy = runCli(["sync", ...p.common], p.env);
  assert.equal(sy.status, 2);
  assert.equal(sy.stderr, `skilletor: config error, nothing changed — ${problem}\n`);
  assert.equal(existsSync(join(p.proj, ".claude", "skilletor.lock.json")), false, "nothing written");
  assert.equal(existsSync(join(p.home, ".claude", "skilletor.lock.json")), false, "nothing written");
  const ch = runCli(["check", ...p.common], p.env);
  assert.equal(ch.status, 2);
  assert.equal(ch.stderr, `skilletor: ${problem}\n`);

  const env = { ...p.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.SKILLETOR_PROJECT_DIR;
  const hook = runCli(["hook", "session-start"], env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: p.proj }));
  assert.equal(hook.status, 0, hook.stderr);
  assert.doesNotMatch(hook.stdout, RAW);
  assert.deepEqual(JSON.parse(hook.stdout), { systemMessage: `skilletor: ${problem}` });

  writeFileSync(cfg, "{}");
  const un = runCli(["install", `foo@team${EVIL}`, ...p.common], p.env);
  assert.equal(un.status, 1);
  assert.doesNotMatch(un.stderr, /[\u001b\u0007\u202e]/);
  assert.ok(un.stderr.includes("team\\u001b[31mred\\u0007\\u202eevil"), un.stderr);
});

// Asserts: `available` shows a source's free text – a skill's description, a bundle's – with
// EVIL escaped and each item on its line(s), while ordinary text (umlauts, emoji, a tab) is
// printed as written.
test("k87: available shows a source's descriptions escaped, ordinary text as written", () => {
  const home = join(tmp.dir, "k87-av-home");
  const proj = join(tmp.dir, "k87-av-proj");
  const src = join(tmp.dir, "k87-av-src");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  mkdirSync(join(src, "bundles"), { recursive: true });
  const oneLine = EVIL.replace("\n", " ");
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), `---\nname: foo\ndescription: Grüße 🍳\tok ${oneLine}\n---\nFOO\n`);
  writeFileSync(join(src, "bundles", "b.yaml"), `description: ${JSON.stringify(`Perl${EVIL}`)}\nskills: [foo]\n`);
  writeFileSync(join(home, ".claude", "skilletor.json"), JSON.stringify({ sources: { shared: { local: src } } }));
  const env = claudeOnlyEnv(home);

  const av = runCli(["available", "shared", "--project-dir", proj], env);
  assert.equal(av.status, 0, av.stderr);
  assert.doesNotMatch(av.stdout, RAW);
  assert.deepEqual(av.stdout.split("\n").filter(Boolean).sort(), [
    `    skill:foo`,
    `  bundle b@shared — Perl${SHOWN}`,
    `  skill foo@shared — Grüße 🍳\tok ${SHOWN.replace("\\n", " ")}`,
  ].sort());
});

// k101: `add` never replaces a source, through the real binary. Two local directories both
// named `tools` derive the same name. Asserts: the same address again exits 0, says the entry
// is kept and leaves the file byte-identical; the other address exits 1 with the existing
// address and the fix on stderr, nothing on stdout, and the file byte-identical.
test("k101: add of a taken name: same address kept (exit 0), another address refused (exit 1)", () => {
  const home = join(tmp.dir, "k101-home");
  const proj = join(tmp.dir, "k101-proj");
  const a = join(tmp.dir, "k101-a", "tools");
  const b = join(tmp.dir, "k101-b", "tools");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  for (const d of [a, b]) {
    mkdirSync(join(d, "skills", "foo"), { recursive: true });
    writeFileSync(join(d, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nFOO\n");
  }
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];
  const cfg = join(home, ".claude", "skilletor.json");

  const first = runCli(["add", a, ...common], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^added source tools /m);
  const written = readFileSync(cfg);

  const again = runCli(["add", a, ...common], env);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes(`source tools already added (${JSON.stringify({ local: a })}), kept as is`), again.stdout);
  assert.deepEqual(readFileSync(cfg), written, "same address: config byte-identical");

  const other = runCli(["add", b, ...common], env);
  assert.equal(other.status, 1, other.stderr);
  assert.equal(other.stdout, "");
  assert.ok(other.stderr.startsWith(`skilletor: source "tools" in ${cfg} is local ${a}`), other.stderr);
  assert.ok(other.stderr.includes(`skilletor add <name> ${b}`), other.stderr);
  assert.ok(other.stderr.includes("skilletor source remove tools"), other.stderr);
  assert.deepEqual(readFileSync(cfg), written, "another address: config byte-identical");
});

// k103: the sync that add, install, uninstall and source remove run after their edit stops at
// a config error (here: no harness on the machine). Asserts, per command: exit 2 as `sync`;
// the error on stderr, not stdout; stderr says the edit was saved and names the config file,
// never "nothing changed"; the file keeps the edit (no rollback). An `add` that keeps an
// existing entry writes nothing: exit 2 with sync's own message, config byte-identical.
test("k103: a config error in the sync after add, install, uninstall, source remove: exit 2, edit kept and named", () => {
  const src = join(tmp.dir, "k103-src");
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nFOO\n");
  const shared = { shared: { local: src } };
  const cases: { label: string; config: object; args: string[]; trust?: true; saved: boolean; after: (cfg: any) => void }[] = [
    { label: "add", config: {}, args: ["add", "shared", src], saved: true,
      after: (cfg) => assert.deepEqual(cfg.sources, shared) },
    { label: "add (kept)", config: { sources: shared }, args: ["add", "shared", src], saved: false,
      after: (cfg) => assert.deepEqual(cfg, { sources: shared }) },
    { label: "install", config: { sources: shared }, args: ["install", "foo@shared"], trust: true, saved: true,
      after: (cfg) => assert.deepEqual(cfg.install, { skills: ["foo@shared"] }) },
    { label: "uninstall", config: { sources: shared, install: { skills: ["foo@shared"] } }, args: ["uninstall", "foo@shared"],
      saved: true, after: (cfg) => assert.deepEqual(cfg, { sources: shared }) },
    { label: "source remove", config: { sources: shared }, args: ["source", "remove", "shared"], saved: true,
      after: (cfg) => assert.equal(cfg.sources, undefined) },
  ];
  for (const [i, c] of cases.entries()) {
    const home = join(tmp.dir, `k103-home-${i}`);
    const proj = join(tmp.dir, `k103-proj-${i}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(proj, { recursive: true });
    const cfg = join(home, ".claude", "skilletor.json");
    writeFileSync(cfg, JSON.stringify(c.config, null, 2) + "\n");
    // No harness marker in this HOME: every sync stops at a config error.
    const env = { ...process.env, HOME: home, CODEX_HOME: join(home, ".no-codex") };
    const common = ["--project-dir", proj];
    if (c.trust) assert.equal(runCli(["trust", "shared", ...common], env).status, 0, `${c.label}: trust`);
    const before = readFileSync(cfg);

    const r = runCli([...c.args, ...common], env);
    assert.equal(r.status, 2, `${c.label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^skilletor: config error, .*no agent harness detected/m, `${c.label}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /config error/, `${c.label}: ${r.stdout}`);
    if (c.saved) {
      assert.ok(r.stderr.includes(`the config edit itself was saved in ${cfg}`), `${c.label}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /nothing changed/, `${c.label}: ${r.stderr}`);
    } else {
      assert.match(r.stderr, /^skilletor: config error, nothing changed — /m, `${c.label}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /saved/, `${c.label}: ${r.stderr}`);
      assert.deepEqual(readFileSync(cfg), before, `${c.label}: config byte-identical`);
    }
    c.after(JSON.parse(readFileSync(cfg, "utf8")));
  }
});

// k114: `source remove` of a name the target config lacks printed "removed source", exited 0
// after a sync, and since k103 claimed "the config edit itself was saved" when that sync hit a
// config error. Asserts, through the real binary: exit 1, nothing on stdout (no "removed"
// line), the exact error on stderr naming the target config and where else the name is
// declared; both configs byte-identical and no lock written (no sync ran). With no harness
// detected – the sync would stop at a config error – still exit 1, never "saved".
test("k114: source remove of a name the target config lacks exits 1, prints no removed line, writes nothing", () => {
  const src = join(tmp.dir, "k114-src");
  mkdirSync(join(src, "skills", "foo"), { recursive: true });
  writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nFOO\n");
  for (const harness of [true, false]) {
    const home = join(tmp.dir, `k114-home-${harness}`);
    const proj = join(tmp.dir, `k114-proj-${harness}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(proj, ".claude"), { recursive: true });
    const env = harness ? claudeOnlyEnv(home) : { ...process.env, HOME: home, CODEX_HOME: join(home, ".no-codex") };
    const common = ["--project-dir", proj];
    const cfg = join(home, ".claude", "skilletor.json");
    const projCfg = join(proj, ".claude", "skilletor.json");
    writeFileSync(cfg, JSON.stringify({ sources: { shared: { local: src } }, install: { skills: ["foo@shared"] } }, null, 2) + "\n");
    writeFileSync(projCfg, JSON.stringify({ sources: { team: { local: src } } }, null, 2) + "\n");
    const before = [readFileSync(cfg), readFileSync(projCfg)];
    const cases: [string[], string][] = [
      [["source", "remove", "nope"], `source "nope" is not declared in the user config (${cfg}); it is not a configured source`],
      [["source", "remove", "nope", "--project", "--force"],
        `source "nope" is not declared in the project config (${projCfg}); it is not a configured source`],
      [["source", "remove", "team"], `source "team" is not declared in the user config (${cfg}); the project config declares it (use --project)`],
      [["source", "remove", "shared", "--project"],
        `source "shared" is not declared in the project config (${projCfg}); the user config declares it (run without --project)`],
    ];
    for (const [args, message] of cases) {
      const label = `${harness ? "" : "no harness: "}${args.join(" ")}`;
      const r = runCli([...args, ...common], env);
      assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "", label);
      assert.equal(r.stderr, `skilletor: ${message}\n`, label);
      assert.deepEqual([readFileSync(cfg), readFileSync(projCfg)], before, `${label}: configs byte-identical`);
      assert.equal(existsSync(join(home, ".claude", "skilletor.lock.json")), false, `${label}: no sync, no user lock`);
      assert.equal(existsSync(join(proj, ".claude", "skilletor.lock.json")), false, `${label}: no sync, no project lock`);
    }
  }
});

// k110: `add` of a spec that resolves to a url config load refuses (http://, file://) wrote it,
// and the sync after it failed (exit 2 since k103, "the edit was saved") – a config every later
// sync and `source remove` refused. Asserts, through the real binary: exit 1 as any refusal
// before the edit, nothing on stdout, stderr names the value and the https rule and never says
// "saved"; the user config byte-identical, no project config; the config still loads.
test("k110: add of an http:// or file:// tarball exits 1 before writing, config untouched and loadable", () => {
  const home = join(tmp.dir, "k110-home");
  const proj = join(tmp.dir, "k110-proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];
  const cfg = join(home, ".claude", "skilletor.json");
  writeFileSync(cfg, `{ "sources": { "keep": { "local": "${home}" } } }\n`);
  const written = readFileSync(cfg);
  const cases: [string[], string][] = [
    [["add", "http://host/x.tar.gz"], `skilletor: cannot add http://host/x.tar.gz: sources.host.url "http://host/x.tar.gz" must be an https:// URL; nothing was changed\n`],
    [["add", "web", "file:///x.tar.gz", "--project"], `skilletor: cannot add file:///x.tar.gz: sources.web.url "file:///x.tar.gz" must be an https:// URL; nothing was changed\n`],
  ];
  for (const [args, stderr] of cases) {
    const r = runCli([...args, ...common], env);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, stderr);
    assert.deepEqual(readFileSync(cfg), written, "user config byte-identical");
    assert.equal(existsSync(join(proj, ".claude", "skilletor.json")), false, "no project config");
  }
  const list = runCli(["source", "list", ...common], env);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^keep \[user\] /m);
});

// k116: `add` of an address the config already holds kept that entry – trusted it and synced –
// even when config load refuses its other fields (a hand-written `ref: ""`), and the sync then
// exited 2. Asserts, through the real binary: exit 1 as any refusal before the edit, nothing on
// stdout, stderr quotes load's error for the entry and both ways out; the config byte-identical,
// nothing trusted, no lock (no sync ran).
test("k116: add of an address whose kept entry config load refuses exits 1, trusts nothing", () => {
  const home = join(tmp.dir, "k116-home");
  const proj = join(tmp.dir, "k116-proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(proj, ".claude"), { recursive: true });
  const env = claudeOnlyEnv(home);
  const common = ["--project-dir", proj];
  const url = "https://example.invalid/Getty/tools";
  const cases: [string, string[], string, string][] = [
    [join(home, ".claude", "skilletor.json"), ["add", url], `"ref": ""`, `sources.tools.ref "" must not be empty (omit "ref" for the remote's HEAD)`],
    [join(proj, ".claude", "skilletor.json"), ["add", "tools", url, "--project"], `"ref": "-x"`,
      `sources.tools.ref "-x" must not start with "-" (git would read it as an option)`],
  ];
  for (const [cfg, args, field, problem] of cases) {
    const raw = `{ "sources": { "tools": { "git": "${url}", ${field} } } }\n`;
    writeFileSync(cfg, raw);
    const r = runCli([...args, ...common], env);
    const flag = args.includes("--project") ? " --project" : "";
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `skilletor: cannot add ${url}: ${cfg}: ${problem}; nothing was changed. ` +
      `Source "tools" there already has this address: fix its entry by hand, or remove it (skilletor source remove tools${flag}).\n`);
    assert.equal(readFileSync(cfg, "utf8"), raw, "config byte-identical");
    assert.equal(existsSync(join(home, ".claude", "skilletor", "trust.json")), false, "nothing trusted");
    assert.equal(existsSync(join(home, ".claude", "skilletor.lock.json")), false, "no sync, no user lock");
    assert.equal(existsSync(join(proj, ".claude", "skilletor.lock.json")), false, "no sync, no project lock");
    rmSync(cfg);
  }
});
