// A stand-in for the `claude` CLI, for test/install.test.ts: it logs every call and keeps the
// state of the `claude plugin` subcommands install.sh uses in a temp HOME, in the formats
// Claude Code 2.1 writes (`installed_plugins.json` version 2) and prints (`--json`).
//
//   FAKE_CLAUDE_LOG      file each call's arguments are appended to, one JSON array per line
//   FAKE_CLAUDE_PLUGIN   directory copied as the plugin's install path (bin/, dist/)
//   FAKE_CLAUDE_VERSION  version an install or update lands on (default 1.0.0)
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\n");
// install.sh runs every command on /dev/null: under `curl … | sh` its stdin is the script, and
// from a terminal a prompt would wait for an answer nobody gives.
if (readFileSync(0, "utf8") !== "") {
  console.error("fake claude: stdin is not empty");
  process.exit(3);
}

const home = process.env.HOME;
const plugins = join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "plugins");
const knownFile = join(plugins, "known_marketplaces.json");
const installedFile = join(plugins, "installed_plugins.json");
const read = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : empty);
const write = (file, data) => {
  mkdirSync(plugins, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
};

function install(id) {
  const [name, marketplace] = id.split("@");
  const version = process.env.FAKE_CLAUDE_VERSION ?? "1.0.0";
  const installPath = join(plugins, "cache", marketplace, name, version);
  cpSync(process.env.FAKE_CLAUDE_PLUGIN, installPath, { recursive: true });
  const data = read(installedFile, { version: 2, plugins: {} });
  const others = (data.plugins[id] ?? []).filter((e) => e.scope !== "user");
  data.plugins[id] = [...others, { scope: "user", installPath, version, installedAt: "2026-10-16T00:00:00.000Z" }];
  write(installedFile, data);
}

const cmd = args.join(" ");
if (cmd === "plugin marketplace list --json") {
  const known = read(knownFile, {});
  console.log(JSON.stringify(Object.keys(known).map((name) => ({ name, ...known[name] }))));
} else if (cmd === "plugin marketplace add Getty/marketplace") {
  write(knownFile, { ...read(knownFile, {}), getty: { source: "github", repo: "Getty/marketplace" } });
  console.log("Successfully added marketplace: getty");
} else if (cmd === "plugin marketplace update getty") {
  console.log("Successfully updated marketplace: getty");
} else if (cmd === "plugin list --json") {
  const data = read(installedFile, { version: 2, plugins: {} });
  const list = Object.entries(data.plugins).flatMap(([id, entries]) => entries.map((e) => ({ id, ...e })));
  console.log(JSON.stringify(list));
} else if (cmd === "plugin install skilletor@getty --scope user" || cmd === "plugin update skilletor@getty --scope user") {
  install("skilletor@getty");
  console.log(`done: ${cmd}`);
} else {
  console.error(`fake claude: unexpected call: ${cmd}`);
  process.exit(3);
}
