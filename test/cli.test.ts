// Black-box test of the built CLI bundle: build it, run it, assert on its output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildToString } from "../scripts/esbuild.config.mjs";
import { claudeOnlyEnv } from "./helpers/harness.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";

let tmp: TmpDir;
// Written as .mjs so Node runs the ESM bundle as ESM even outside a package.json.
let bundle: string;

before(async () => {
  tmp = makeTmpDir();
  bundle = join(tmp.dir, "skilletor.mjs");
  writeFileSync(bundle, await buildToString());
});

after(() => tmp.cleanup());

function runCli(args: string[], env?: NodeJS.ProcessEnv, input?: string, cwd?: string) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: env ?? process.env, input, cwd });
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
  const r = runCli(["frobnicate"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command/i);
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
  assert.equal(existsSync(join(realpathSync(repo), ".agents/skills/bar/SKILL.md")), true);
  assert.equal(existsSync(join(repo, ".claude/skills")), false); // Claude not in use here
  // The user agent became a Codex agent role under CODEX_HOME.
  assert.equal(
    readFileSync(join(codexHome, "agents", "helper.toml"), "utf8"),
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
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "skilletor.json"), "{}");
  const r = runCli(["sync", "--scope", "user"], { ...process.env, HOME: home, CODEX_HOME: join(home, "nope") });
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
