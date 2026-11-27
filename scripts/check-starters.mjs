// `bun run check-starters` — fail if the committed getty-bun starters drifted (k282).
//
// CI only: it writes the project's .claude/ (trust state stays in a scratch home), so run it on a
// fresh checkout, where no project lock exists yet. Usage: bun scripts/check-starters.mjs [checkout]
// (default: the checkout this script is in). It runs this checkout's dist/skilletor.js with the
// running Bun in a scratch HOME whose user config targets Claude only, trusts agent-bun-runtime
// (the one source the checks need), syncs the project scope and then asserts:
//   1. the fresh render of skills/getty-bun-install equals the committed one: the plugin item is in
//      the new lock (a fresh checkout has none, so only a byte- and mode-identical render is
//      adopted), every locked hash matches the file, no file is outside the lock, and git sees no
//      change under skills/getty-bun-install;
//   2. bootstrap/getty-bun.{sh,ps1} equal the copies in skills/getty-bun-install/bootstrap/;
//   3. bootstrap/getty-bun.sh pins package.json gettyBun.bunVersion ("# version X");
//   4. package.json gettyBun satisfies agent-bun-runtime's requirement.schema.json at the pinned
//      ref (the copy the sync just installed) and equals vars.bun_version.
// The sync clones agent-bun-runtime over the network.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/skilletor.js", import.meta.url));
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const SKILL = "skills/getty-bun-install";
const PLUGIN_KEY = `plugin:${SKILL}`;
const SCHEMA = ".claude/skills/getty-bun-integration/assets/requirement.schema.json";

const problems = [];
const problem = (text) => problems.push(text);
const at = (rel) => join(root, ...rel.split("/"));
const readJson = (rel) => JSON.parse(readFileSync(at(rel), "utf8"));

function die(text) {
  console.error(`check-starters: ${text}`);
  process.exit(1);
}

if (existsSync(at(".claude/skilletor.lock.json"))) {
  die(`${root} has a project lock; run on a fresh checkout (the lock would hide a render that no longer matches)`);
}

const pkg = readJson("package.json");
const pin = pkg.gettyBun?.bunVersion;

// The scratch environment: nothing of the machine's home, Claude, Codex, Hermes or git repository.
const scratch = mkdtempSync(join(tmpdir(), "skilletor-check-starters-"));
let sync;
try {
  const home = join(scratch, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "skilletor.json"), '{"targets":["claude"]}\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share") };
  for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR", "SKILLETOR_PROJECT_DIR", "HERMES_HOME",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) {
    delete env[name];
  }
  const skilletor = (...args) => spawnSync(process.execPath, [cli, ...args, "--project-dir", root], { cwd: root, env, encoding: "utf8" });

  const trust = skilletor("trust", "agent-bun-runtime");
  if (trust.status !== 0) die(`skilletor trust agent-bun-runtime failed (exit ${trust.status}):\n${trust.stdout}${trust.stderr}`);
  sync = skilletor("sync", "--scope", "project");
  process.stdout.write(sync.stdout);
  process.stderr.write(sync.stderr);
  if (sync.status !== 0) die(`skilletor sync --scope project failed (exit ${sync.status})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 1. The fresh render equals the committed one.
const lockPath = at(".claude/skilletor.lock.json");
const entry = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8"))[PLUGIN_KEY] : undefined;
if (!entry) {
  problem(`${SKILL} is not in the new lock: the render failed or differs from the committed files (see the sync output above)`);
} else {
  const locked = Object.keys(entry.files ?? {});
  for (const rel of locked) {
    const actual = existsSync(at(rel)) ? `sha256:${createHash("sha256").update(readFileSync(at(rel))).digest("hex")}` : "missing";
    if (actual !== entry.files[rel]) problem(`${rel} differs from the fresh render`);
  }
  for (const rel of walk(at(SKILL))) {
    if (!locked.includes(rel)) problem(`${rel} is committed but not part of the fresh render`);
  }
}
const git = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", SKILL], { cwd: root, encoding: "utf8" });
if (git.status !== 0) problem(`git status failed: ${git.stderr.trim()}`);
else if (git.stdout !== "") problem(`the sync changed ${SKILL}:\n${git.stdout.trimEnd()}\n${execFileSync("git", ["diff", "--", SKILL], { cwd: root, encoding: "utf8" })}`);

// 2. The plugin's copies equal the rendered starters.
for (const name of ["getty-bun.sh", "getty-bun.ps1"]) {
  const copy = `bootstrap/${name}`;
  const rendered = `${SKILL}/bootstrap/${name}`;
  if (!existsSync(at(copy)) || !existsSync(at(rendered)) || !readFileSync(at(copy)).equals(readFileSync(at(rendered)))) {
    problem(`${copy} differs from ${rendered}: copy the rendered starter into bootstrap/`);
  }
}

// 3. The starter pins the declared Bun.
const starterLines = existsSync(at("bootstrap/getty-bun.sh")) ? readFileSync(at("bootstrap/getty-bun.sh"), "utf8").split("\n") : [];
if (!starterLines.includes(`# version ${pin}`)) problem(`bootstrap/getty-bun.sh has no line "# version ${pin}" (package.json gettyBun.bunVersion)`);

// 4. package.json gettyBun against the contract's schema, and against vars.bun_version.
if (!existsSync(at(SCHEMA))) problem(`${SCHEMA} was not installed by the sync`);
else for (const text of validate(pkg.gettyBun, readJson(SCHEMA), "gettyBun")) problem(`package.json ${text}`);
const varsPin = readJson(".claude/skilletor.json").vars?.bun_version;
if (varsPin !== pin) problem(`.claude/skilletor.json vars.bun_version is ${JSON.stringify(varsPin)}, package.json gettyBun.bunVersion ${JSON.stringify(pin)}`);

if (problems.length > 0) {
  for (const text of problems) console.error(`check-starters: ${text}`);
  process.exit(1);
}
console.log(`check-starters: the starters match a fresh render for Bun ${pin}.`);

/** Every file under `dir`, as a checkout-relative path with "/". */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(path));
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

/** The JSON Schema keywords requirement.schema.json uses; any other keyword is refused, not ignored. */
function validate(value, schema, path) {
  const known = new Set(["$schema", "title", "description", "type", "additionalProperties", "required", "properties", "const", "pattern"]);
  const unknown = Object.keys(schema).filter((k) => !known.has(k));
  if (unknown.length > 0) return [`${path}: the schema uses ${unknown.join(", ")}, which this check does not implement`];
  const out = [];
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (schema.type === "object" && !isObject) return [`${path} must be an object`];
  if (schema.type === "string" && typeof value !== "string") return [`${path} must be a string`];
  if ("const" in schema && value !== schema.const) out.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    out.push(`${path} ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (isObject) {
    for (const key of schema.required ?? []) if (!(key in value)) out.push(`${path}.${key} is missing`);
    for (const [key, sub] of Object.entries(value)) {
      if (schema.properties?.[key]) out.push(...validate(sub, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${key} is not allowed`);
    }
  }
  return out;
}
