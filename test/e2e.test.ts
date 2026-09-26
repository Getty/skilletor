// End-to-end test through the built bundle (spec §11). No internal modules, no
// network — a local bare-git source drives the whole lifecycle.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { claudeOnlyEnv } from "./helpers/harness.ts";
import { makeTmpDir, type TmpDir } from "./helpers/tmp.ts";
import { buildToString } from "../scripts/esbuild.config.mjs";

const GIT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

let bundleTmp: TmpDir;
let bundle: string;

before(async () => {
  bundleTmp = makeTmpDir();
  bundle = join(bundleTmp.dir, "skilletor.mjs");
  writeFileSync(bundle, await buildToString());
});
after(() => bundleTmp.cleanup());

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT }, stdio: "ignore" });
}

test("full lifecycle: add, install, update, re-render, author mode, uninstall", async () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp.dir, "home");
    const project = join(tmp.dir, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });

    // Build a source repo (working tree + bare remote).
    const work = join(tmp.dir, "src");
    const put = (rel: string, content: string) => {
      const p = join(work, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    };
    put("skills/greet/SKILL.md.njk", "Hello {{ project.name }} foo={{ vars.foo }} {% include \"snippets/tag.md\" %}\n");
    put("skills/greet/ref.md", "reference\n");
    put("agents/helper.md", "---\ndescription: helper\n---\nhelp\n");
    put("rules/style.md.njk", "style foo={{ vars.foo }}\n");
    put("snippets/tag.md", "TAG");
    const bare = join(tmp.dir, "src.git");
    execFileSync("git", ["init", "-q", "-b", "main", "--bare", bare]);
    git(work, "init", "-q", "-b", "main");
    git(work, "add", ".");
    git(work, "commit", "-qm", "init");
    const url = "file://" + resolvePath(bare);
    git(work, "push", "-q", url, "main");

    const run = (args: string[], input?: string) =>
      spawnSync(process.execPath, [bundle, ...args], {
        encoding: "utf8",
        input,
        env: claudeOnlyEnv(home, { CLAUDE_PROJECT_DIR: project }),
      });

    // A hand-written own skill that must never be touched.
    mkdirSync(join(project, ".claude/skills/mine"), { recursive: true });
    writeFileSync(join(project, ".claude/skills/mine/SKILL.md"), "MY OWN");

    // 1. add (trusts the source) + install into the project scope.
    writeFileSync(join(project, ".claude/skilletor.json"), JSON.stringify({ vars: { foo: "bar" } }, null, 2));
    let r = run(["add", "shared", url, "--project", "--project-dir", project]);
    assert.equal(r.status, 0, r.stderr);
    r = run(["install", "greet@shared", "agent:helper@shared", "style@shared", "--project", "--project-dir", project]);
    assert.equal(r.status, 0, r.stderr);

    const greetPath = join(project, ".claude/skills/greet/SKILL.md");
    assert.match(readFileSync(greetPath, "utf8"), /Hello project foo=bar TAG/);
    assert.equal(existsSync(join(project, ".claude/agents/.local.helper.md")), true);
    assert.equal(existsSync(join(project, ".claude/rules/.local.style.md")), true);
    const lock = JSON.parse(readFileSync(join(project, ".claude/skilletor.lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["agents/helper", "rules/style", "skills/greet"]);
    // Fixed ignore rules (k62): the skill carries its own .gitignore, the block never lists items.
    const gitignore = readFileSync(join(project, ".claude/.gitignore"), "utf8");
    assert.match(gitignore, /^agents\/\*\*\/\.local\.\*$/m);
    assert.doesNotMatch(gitignore, /greet|helper|style/);
    assert.match(readFileSync(join(project, ".claude/skills/greet/.gitignore"), "utf8"), /^\*$/m);

    // 2. new commit in the source -> session-start hook reports an update.
    put("skills/greet/SKILL.md.njk", "Hello {{ project.name }} v2 foo={{ vars.foo }} {% include \"snippets/tag.md\" %}\n");
    git(work, "commit", "-aqm", "v2");
    git(work, "push", "-q", url, "main");
    r = run(["hook", "session-start"], JSON.stringify({ source: "startup", cwd: project }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /updated/i);
    assert.match(readFileSync(greetPath, "utf8"), /v2/);

    // 3. change vars in the project config -> next sync re-renders, no source change.
    writeFileSync(join(project, ".claude/skilletor.json"),
      JSON.stringify({ sources: { shared: { git: url } }, install: { skills: ["greet@shared"], agents: ["helper@shared"], rules: ["style@shared"] }, vars: { foo: "CHANGED" } }, null, 2));
    r = run(["sync", "--scope", "project", "--project-dir", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(greetPath, "utf8"), /foo=CHANGED/);

    // 4. author mode: a user local override lands on the next sync.
    const localCheckout = join(tmp.dir, "local-src");
    mkdirSync(join(localCheckout, "skills/greet"), { recursive: true });
    writeFileSync(join(localCheckout, "skills/greet/SKILL.md.njk"), "LOCAL EDIT foo={{ vars.foo }}\n");
    writeFileSync(join(localCheckout, "skills/greet/ref.md"), "reference\n");
    mkdirSync(join(localCheckout, "agents"), { recursive: true });
    writeFileSync(join(localCheckout, "agents/helper.md"), "---\ndescription: helper\n---\nhelp\n");
    mkdirSync(join(localCheckout, "rules"), { recursive: true });
    writeFileSync(join(localCheckout, "rules/style.md.njk"), "style foo={{ vars.foo }}\n");
    writeFileSync(join(home, ".claude/skilletor.json"), JSON.stringify({ sources: { shared: { local: localCheckout } } }, null, 2));
    r = run(["sync", "--scope", "project", "--project-dir", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(greetPath, "utf8"), /LOCAL EDIT/);

    // 5. uninstall greet -> files and lock entry gone, the block unchanged; own skill untouched.
    r = run(["uninstall", "greet@shared", "--project", "--project-dir", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(project, ".claude/skills/greet")), false);
    const lock2 = JSON.parse(readFileSync(join(project, ".claude/skilletor.lock.json"), "utf8"));
    assert.equal("skills/greet" in lock2, false);
    assert.equal(readFileSync(join(project, ".claude/.gitignore"), "utf8"), gitignore);
    assert.equal(readFileSync(join(project, ".claude/skills/mine/SKILL.md"), "utf8"), "MY OWN");
  } finally {
    tmp.cleanup();
  }
});
