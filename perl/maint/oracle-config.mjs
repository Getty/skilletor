// Regenerates t/data/config-oracle.json: what the reference's loadConfig makes of each
// scenario – the loaded config, or the ConfigError's message with the temp home and project
// written as <HOME> and <PROJECT>. Run from perl/:
//   node maint/oracle-config.mjs > t/data/config-oracle.json
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";

const G = (url = "https://github.com/Getty/skills") => ({ git: url });
const S = { s: G() };
const scenarios = [
  // missing files, defaults
  { name: "nothing at all" },
  { name: "no project dir", noProject: true, user: { sources: S, install: { skills: ["a@s"] } } },
  { name: "empty objects", user: {}, project: {}, local: {} },
  // file-level errors
  { name: "broken JSON user", user: '{"sources": {' },
  { name: "broken JSON project", project: '{"a":1 "b":2}' },
  { name: "broken JSON local with BOM", local: "﻿{}" },
  { name: "top level array", user: "[]" },
  { name: "top level null", project: "null" },
  { name: "top level string", local: '"x"' },
  { name: "unknown key", user: { sources: {}, foo: 1 } },
  { name: "unknown key order", user: '{"zeta":1,"alpha":2}' },
  { name: "checkInterval in project", project: { checkInterval: 5 } },
  { name: "checkInterval in local", local: { checkInterval: 5 } },
  { name: "checkInterval not a number", user: { checkInterval: "5" } },
  { name: "checkInterval null", user: { checkInterval: null } },
  { name: "checkInterval infinite", user: '{"checkInterval": 1e999}' },
  { name: "checkInterval set", user: { checkInterval: 600 } },
  { name: "checkInterval float", user: { checkInterval: 0.5 } },
  { name: "user error wins over project error", user: "[", project: "[" },
  { name: "project read before local", project: "{x", local: "{y" },
  // sources
  { name: "sources not an object", user: { sources: [] } },
  { name: "sources null", user: { sources: null } },
  { name: "source def not an object", user: { sources: { s: "https://x" } } },
  { name: "source unknown key", user: { sources: { s: { git: "https://x", branch: "main" } } } },
  { name: "source name invalid", user: { sources: { "-bad": G() } } },
  { name: "source name invalid unicode", project: { sources: { "skïlls": G() } } },
  { name: "source name invalid empty", local: { sources: { "": G() } } },
  { name: "source names valid", user: { sources: { "a.b_c-d": G(), "0x": G(), "A": G() }, install: { skills: ["x@a.b_c-d", "y@0x", "z@A"] } } },
  { name: "integer source names keep object order", user: { sources: { b: G(), "2": G(), "10": G(), a: G() } } },
  { name: "git not a string", user: { sources: { s: { git: 5 } } } },
  { name: "git null", user: { sources: { s: { git: null } } } },
  { name: "git empty", user: { sources: { s: { git: "" } } } },
  { name: "git dash", user: { sources: { s: { git: "--upload-pack=x" } } } },
  { name: "ref empty", user: { sources: { s: { git: "https://x", ref: "" } } } },
  { name: "ref not a string", user: { sources: { s: { git: "https://x", ref: 1 } } } },
  { name: "ref dash", user: { sources: { s: { git: "https://x", ref: "-x" } } } },
  { name: "ref space", user: { sources: { s: { git: "https://x", ref: "a b" } } } },
  { name: "ref dotdot", user: { sources: { s: { git: "https://x", ref: "a..b" } } } },
  { name: "ref reflog", user: { sources: { s: { git: "https://x", ref: "a@{1}" } } } },
  { name: "ref control", user: { sources: { s: { git: "https://x", ref: "a\u0001" } } } },
  { name: "ref ok forms", user: { sources: { s: { git: "https://x", ref: "feature/x-1.2" }, t: { git: "https://x", ref: "v1.0.0" }, u: { git: "https://x", ref: "0123abcd" }, v: { git: "https://x", ref: "a@b" } } } },
  { name: "local empty", user: { sources: { s: { local: "" } } } },
  { name: "local not a string", user: { sources: { s: { local: [] } } } },
  { name: "url http", user: { sources: { s: { url: "http://x/a.tgz" } } } },
  { name: "url not a string", user: { sources: { s: { url: 7 } } } },
  { name: "url null", user: { sources: { s: { url: null } } } },
  { name: "url ok", user: { sources: { s: { url: "https://x/a.tar.gz" } } } },
  { name: "all three backends", user: { sources: { s: { git: "https://x", url: "https://y/z.tgz", local: "~/dev/s", ref: "main" } } } },
  { name: "no backend anywhere user", user: { sources: { s: { ref: "main" } } } },
  { name: "no backend anywhere project+local", project: { sources: { s: { ref: "a" } } }, local: { sources: { s: { path: "x" } } } },
  { name: "no backend in three files", project: { sources: { s: { ref: "a" } } }, user: { sources: { s: { ref: "b" } } }, local: { sources: { s: { ref: "c" } } } },
  { name: "no backend, no project scope", noProject: true, user: { sources: { s: { ref: "x" } } } },
  { name: "empty source def", user: { sources: { s: {} } } },
  // path
  { name: "path string", user: { sources: { s: { git: "https://x", path: "skills" } } } },
  { name: "path array", user: { sources: { s: { git: "https://x", path: ["skills", "optional-skills"] } } } },
  { name: "path empty array", user: { sources: { s: { git: "https://x", path: [] } } } },
  { name: "path empty string", user: { sources: { s: { git: "https://x", path: "" } } } },
  { name: "path number", user: { sources: { s: { git: "https://x", path: 7 } } } },
  { name: "path element number", user: { sources: { s: { git: "https://x", path: ["a", 7] } } } },
  { name: "path element empty", user: { sources: { s: { git: "https://x", path: ["a", ""] } } } },
  { name: "path absolute", user: { sources: { s: { git: "https://x", path: "/abs" } } } },
  { name: "path backslash absolute", user: { sources: { s: { git: "https://x", path: ["\\abs"] } } } },
  { name: "path dotdot", user: { sources: { s: { git: "https://x", path: "../x" } } } },
  { name: "path dotdot inner", user: { sources: { s: { git: "https://x", path: ["a", "a\\..\\b"] } } } },
  { name: "path root dot", user: { sources: { s: { git: "https://x", path: "." } } } },
  { name: "path root dotslash", user: { sources: { s: { git: "https://x", path: ["./"] } } } },
  { name: "path null", user: { sources: { s: { git: "https://x", path: null } } } },
  // merging
  { name: "distinct sources with origins", user: { sources: { u: G("https://u") } }, project: { sources: { p: G("https://p") } }, local: { sources: { l: G("https://l") } } },
  { name: "author mode", project: { sources: { s: { git: "https://p", ref: "v1" } }, install: { skills: ["a@s"] } }, user: { sources: { s: { local: "~/dev/s" } } } },
  { name: "local overrides user field", project: { sources: { s: G("https://p") } }, user: { sources: { s: G("https://u") } }, local: { sources: { s: G("https://l") } } },
  { name: "ref merges, kept when higher gives git alone", project: { sources: { s: { git: "https://p", ref: "v1" } } }, user: { sources: { s: { git: "https://u" } } } },
  { name: "ref null unsets", project: { sources: { s: { git: "https://p", ref: "v1" } } }, user: { sources: { s: { ref: null } } } },
  { name: "ref null then local sets", project: { sources: { s: { git: "https://p", ref: "v1" } } }, user: { sources: { s: { ref: null } } }, local: { sources: { s: { ref: "v4" } } } },
  { name: "ref null in local", project: { sources: { s: { git: "https://p", ref: "v1" } } }, local: { sources: { s: { ref: null, path: "p" } } } },
  { name: "ref null alone in user scope", user: { sources: { s: { git: "https://u", ref: null } }, install: { skills: ["a@s"] } } },
  { name: "path merges whole", project: { sources: { s: { git: "https://p", path: ["a", "b"] } } }, user: { sources: { s: { git: "https://u", path: "c" } } }, local: { sources: { s: { path: ["d"] } } } },
  { name: "entry without backend overrides ref", project: { sources: { s: G("https://p") }, install: { skills: ["a@s"] } }, local: { sources: { s: { ref: "v2" } } } },
  { name: "user entry without backend", project: { sources: { s: G("https://p") } }, user: { sources: { s: { ref: "v2" } }, install: { skills: ["a@s"] } } },
  { name: "user bundle on entry without backend", project: { sources: { s: G("https://p") } }, user: { sources: { s: { ref: "v2" } }, install: { bundles: ["b@s"] } } },
  { name: "user scope sees user sources only", project: { sources: { p: G("https://p") } }, user: { install: { skills: ["a@p"] } } },
  { name: "project install of user source", user: { sources: { u: G("https://u") } }, project: { install: { skills: ["a@u"] } } },
  { name: "merge order user then local new names", project: { sources: { b: G(), a: G() } }, user: { sources: { c: G(), a: G("https://ua") } }, local: { sources: { d: G(), b: { ref: "x" } } } },
  // install
  { name: "install not an object", user: { install: [] } },
  { name: "install bad type", user: { sources: S, install: { skill: [] } } },
  { name: "install proto key", user: '{"sources":{"s":{"git":"https://x"}},"install":{"constructor":["a@s"]}}' },
  { name: "install list not array", user: { sources: S, install: { skills: "a@s" } } },
  { name: "install entry not string", user: { sources: S, install: { agents: ["a@s", 5] } } },
  { name: "install entry no at", user: { sources: S, install: { skills: ["a"] } } },
  { name: "install entry leading at", user: { sources: S, install: { skills: ["@s"] } } },
  { name: "install entry trailing at", user: { sources: S, install: { rules: ["a@"] } } },
  { name: "install entry empty name", user: { sources: S, install: { skills: ["skill:@s"] } } },
  { name: "install entry prefix mismatch", user: { sources: S, install: { skills: ["agent:a@s"] } } },
  { name: "install entry prefix match", user: { sources: S, install: { skills: ["skill:a@s"], agents: ["agent:b@s"], rules: ["rule:c@s"] } } },
  { name: "install entry name with at", user: { sources: S, install: { skills: ["a@b@s"] } } },
  { name: "install unknown source", user: { sources: S, install: { skills: ["a@t"] } } },
  { name: "install unknown source project", project: { install: { skills: ["a@t"] } } },
  { name: "install duplicate", user: { sources: { s: G(), t: G() }, install: { skills: ["a@s", "a@t"] } } },
  { name: "install duplicate case", user: { sources: { s: G(), t: G() }, install: { skills: ["Foo@s", "foo@t"] } } },
  { name: "install duplicate sigma", user: { sources: { s: G(), t: G() }, install: { skills: ["ΟΔΟΣ@s", "οδος@t"] } } },
  { name: "install same name two types", user: { sources: S, install: { skills: ["a@s"], agents: ["a@s"], rules: ["a@s"] } } },
  { name: "install duplicate across project and local", project: { sources: S, install: { skills: ["a@s"] } }, local: { install: { skills: ["A@s"] } } },
  { name: "wildcards", user: { sources: { s: G(), t: G() }, install: { skills: ["*@s", "perl-*@s", "*-style@t", "x@s"], rules: ["rule:*@s"] } } },
  { name: "wildcard unknown source", user: { sources: S, install: { skills: ["*@t"] } } },
  { name: "wildcard prefix mismatch", user: { sources: S, install: { rules: ["skill:*@s"] } } },
  { name: "wildcard twice", user: { sources: S, install: { skills: ["*@s", "*@s"] } } },
  { name: "wildcard twice across project and local", project: { sources: S, install: { skills: ["perl-*@s"] } }, local: { install: { skills: ["perl-*@s"] } } },
  { name: "wildcard pattern case matters", project: { sources: S, install: { skills: ["Perl-*@s", "perl-*@s"] } } },
  { name: "wildcards two sources", user: { sources: { s: G(), t: G() }, install: { skills: ["*@s", "*@t"] } } },
  { name: "bundles", user: { sources: S, install: { bundles: ["perl@s", "bundle:k8s@s"] } } },
  { name: "bundles not array", user: { sources: S, install: { bundles: {} } } },
  { name: "bundles entry not string", user: { sources: S, install: { bundles: [1] } } },
  { name: "bundles bad prefix", user: { sources: S, install: { bundles: ["skill:x@s"] } } },
  { name: "bundles pattern", user: { sources: S, install: { bundles: ["perl-*@s"] } } },
  { name: "bundles empty name", user: { sources: S, install: { bundles: ["bundle:@s"] } } },
  { name: "bundles no at", user: { sources: S, install: { bundles: ["perl"] } } },
  { name: "bundles unknown source", user: { sources: S, install: { bundles: ["perl@t"] } } },
  { name: "bundles duplicate", user: { sources: S, install: { bundles: ["perl@s", "bundle:perl@s"] } } },
  { name: "bundles case differs", user: { sources: S, install: { bundles: ["perl@s", "Perl@s"] } } },
  { name: "bundles duplicate across project and local", project: { sources: S, install: { bundles: ["perl@s"] } }, local: { install: { bundles: ["perl@s"] } } },
  { name: "install types checked before entries", user: { sources: S, install: { skills: [5], bogus: [] } } },
  { name: "bundles checked after types", user: { sources: S, install: { bundles: [1], rules: [2] } } },
  // vars
  { name: "vars merge", user: { vars: { a: 1, b: "u", n: { x: 1 } } }, project: { vars: { b: "p", c: true, "2": 2 } }, local: { vars: { c: false, d: null } } },
  { name: "vars not object user", user: { vars: [1] } },
  { name: "vars not object project", project: { vars: "x" } },
  { name: "vars null local", local: { vars: null } },
  // gitignore / claudeSettings
  { name: "gitignore user false", user: { gitignore: false } },
  { name: "gitignore user not bool", user: { gitignore: "no" } },
  { name: "gitignore user null", user: { gitignore: null } },
  { name: "gitignore project false", project: { gitignore: false } },
  { name: "gitignore local over project", project: { gitignore: false }, local: { gitignore: true } },
  { name: "gitignore local bad named as project", local: { gitignore: 1 } },
  { name: "gitignore local null falls to project", project: { gitignore: false }, local: { gitignore: null } },
  { name: "gitignore project null", project: { gitignore: null } },
  { name: "claudeSettings user false flows to project", user: { claudeSettings: false } },
  { name: "claudeSettings project true over user false", user: { claudeSettings: false }, project: { claudeSettings: true } },
  { name: "claudeSettings local over project", project: { claudeSettings: true }, local: { claudeSettings: false } },
  { name: "claudeSettings bad local", local: { claudeSettings: "x" } },
  { name: "claudeSettings bad project and local", project: { claudeSettings: 1 }, local: { claudeSettings: "x" } },
  { name: "claudeSettings null project", project: { claudeSettings: null } },
  // targets
  { name: "targets all levels", user: { targets: ["claude", "codex"] }, project: { targets: ["codex"] }, local: { targets: ["claude"] } },
  { name: "targets project only", project: { targets: ["hermes"] } },
  { name: "targets empty", user: { targets: [] } },
  { name: "targets not array", project: { targets: "claude" } },
  { name: "targets null", local: { targets: null } },
  { name: "targets unknown", user: { targets: ["claude", "cursor"] } },
  { name: "targets number", user: { targets: [1] } },
  { name: "targets duplicate", user: { targets: ["codex", "codex"] } },
  // unchecked
  { name: "unchecked source in user", user: { sources: { s: { ref: "x" }, t: G() } }, unchecked: { file: "user", name: "s" } },
  { name: "unchecked invalid name tolerated", project: { sources: { "-x": "anything" } }, unchecked: { file: "project", name: "-x" } },
  { name: "unchecked other file still checked", project: { sources: { s: { ref: "a" } } }, local: { sources: { s: { ref: "b" } } }, unchecked: { file: "local", name: "s" } },
  { name: "unchecked user entry not an override", user: { sources: { s: { ref: "x" } }, install: { skills: ["a@s"] } }, unchecked: { file: "user", name: "s" } },
];

const root = mkdtempSync(join(tmpdir(), "skilletor-oracle-"));
const out = [];
for (const sc of scenarios) {
  const base = mkdtempSync(join(root, "c-"));
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  const write = (file, v) => {
    if (v === undefined) return;
    writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
  };
  const files = { user: join(home, ".claude", "skilletor.json"), project: join(project, ".claude", "skilletor.json"), local: join(project, ".claude", "skilletor.local.json") };
  write(files.user, sc.user);
  write(files.project, sc.project);
  write(files.local, sc.local);
  const opts = { home };
  if (!sc.noProject) opts.projectDir = project;
  if (sc.unchecked) opts.unchecked = { path: files[sc.unchecked.file], name: sc.unchecked.name };
  const hide = (s) => s.split(project).join("<PROJECT>").split(home).join("<HOME>");
  const files_ = Object.fromEntries(["user", "project", "local"].map((k) => [k, typeof sc[k] === "string" ? sc[k] : sc[k] === undefined ? null : JSON.stringify(sc[k], null, 2) + "\n"]));
  const entry = { name: sc.name, files: files_, noProject: !!sc.noProject, unchecked: sc.unchecked ?? null };
  try {
    const c = loadConfig(opts);
    entry.loaded = JSON.parse(hide(JSON.stringify({
      sources: [...c.sources.entries()],
      checkInterval: c.checkInterval,
      user: c.user,
      ...(c.project ? { project: c.project } : {}),
      userSources: [...c.userSources.entries()],
    })));
  } catch (e) {
    if (e.name !== "ConfigError") throw e;
    entry.error = hide(e.message);
  }
  out.push(entry);
}
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
