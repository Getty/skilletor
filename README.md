# skilletor

![skilletor](assets/github.png)

> **MYAAH! Your skills are mine… to sync.**

Remote skills, agents and rules for Claude Code, Codex and Hermes Agent — declared once,
synced on every session, templated per project.

skilletor installs the skills, agents and rules your coding agent works with from wherever
they live: a git repository, an HTTPS tarball, a local directory, a Claude plugin repository,
another project's own `.claude/`. You name the items once, in a small `skilletor.json`, for
yourself or for one project. skilletor puts them where Claude Code, Codex and Hermes Agent read
them, renders templates per project, and at every session start brings them up to date and
tells the model what changed. A project's committed `skilletor.json` gives everyone who works
on it the same set, and a source that only a cloned project declares is fetched once you trust
it, never before. Want shared skills? This is most likely the tool.

It comes as a plugin for Claude Code and for Codex, from Getty's marketplace, as a plugin for
Hermes Agent, and as a `skilletor` command for your shell.

## Install

On the machine it needs `git` and a POSIX `sh`; it runs on Bun, which it installs itself on first use ([Requirements](#requirements)). What is released and what is tested where:
[Status](#status).

### In Claude Code

In Claude Code, type:

```
/plugin marketplace add Getty/marketplace
/plugin install skilletor@getty
/reload-plugins
```

`/reload-plugins` loads the plugin into the running session; a new session does the same. Claude
then has the bundled `skilletor` skill, and the `skilletor` command is on the `PATH` of its Bash
tool. From the next session start on, the plugin's hooks keep your items current
([How it works](#how-it-works)).

### In Codex

In a terminal:

```bash
codex plugin marketplace add Getty/marketplace
codex plugin add skilletor@getty
```

Then start Codex, type `/hooks` and trust skilletor's `SessionStart` and `UserPromptSubmit`
hooks. Codex runs a plugin's hooks only once you trust them and skips them without a word until
then: no syncs, no rules. An update that changes the hooks needs that trust again. Codex puts
no plugin's `bin/` on `PATH`, but the bundled skill tells the session where skilletor's launcher
is, so asking the session works; for your own terminal, [`install.sh`](#from-the-command-line)
gives you a `skilletor` command. What Codex gets, and where: [Codex](#codex); the plugin
there: [The plugin under Codex](#the-plugin-under-codex).

### In Hermes Agent

Hermes gets skills only, once you opt in: name it in the `targets` of
`~/.claude/skilletor.json`, together with every other harness you use, since user `targets`
replace detection:

```json
{ "targets": ["claude", "hermes"] }
```

It has a plugin of its own, installed with `hermes plugins install`, which runs the
`skilletor` command (`$SKILLETOR_BIN`, else the one on `PATH`): see
[The plugin under Hermes](#the-plugin-under-hermes). What Hermes gets, and where:
[Hermes Agent](#hermes-agent).

### From the command line

```bash
curl -fsSL https://raw.githubusercontent.com/Getty/skilletor/main/install.sh | sh
skilletor add Getty && skilletor install getty-perl-moo@getty
```

Outside a Claude Code session the plugin's `bin/` is not on `PATH`; `install.sh` gives you a
`skilletor` command that is. With `claude` on `PATH` it runs
`claude plugin marketplace add Getty/marketplace` (or `marketplace update getty` when it is
known) and `claude plugin install skilletor@getty` in user scope (or `plugin update` when it is
installed), then writes `~/.local/bin/skilletor`: a small script that looks up the plugin's
current user-scope install in Claude Code's `installed_plugins.json` and runs its
getty-bun starter, so plugin updates do not break it. Without Claude Code (Codex or Hermes only),
or with `--no-plugin`, it clones this repository into `~/.local/share/skilletor`
(`$XDG_DATA_HOME/skilletor`) and links the clone's `bin/skilletor` there instead. Run it again
to update either one.

The installer needs neither Node.js nor Bun nor a JSON tool: `sh`, `awk` and `git`. The
`skilletor --version` it ends with runs the getty-bun starter, which installs the pinned Bun
under `~/.getty` (`$GETTY_HOME`) on its first run ([Which engine runs](#which-engine-runs)).
A `skilletor` script written by an older installer ran Node: run the installer again after an
update.

```bash
curl -fsSL https://raw.githubusercontent.com/Getty/skilletor/main/install.sh | sh -s -- --no-plugin --bin-dir ~/bin
sh install.sh               # in a clone: the same, but the CLI-only path links this clone
```

`--bin-dir DIR` (`SKILLETOR_BIN_DIR`) puts the command elsewhere, `--no-plugin`
(`SKILLETOR_NO_PLUGIN=1`) leaves Claude Code alone, `SKILLETOR_REPO` clones another URL (a
fork, a mirror). The first start of the command downloads Bun with `curl` or `wget`. It
never uses `sudo`, says what it did,
warns when the directory is not on your `PATH`, and replaces no `skilletor` there that it did
not write itself (a symlink excepted). Installing the plugin yourself (`claude plugin install …`
in a dotfiles script, say)? Run the script afterwards for the command; it finds the plugin
installed and only updates it.

**With Perl:** the CPAN distribution `Skilletor` is retired. Its last release, 0.009000, ships
its modules as empty stubs, and its `skilletor` command only says where to go instead. Remove it
with `cpanm --uninstall Skilletor` and install skilletor one of the ways above.

Windows: the script is for Linux (macOS waits for getty-bun, see [Status](#status)). On
Windows only the Codex hooks and the Hermes adapter run today, through
`bootstrap\getty-bun.ps1`; Claude Code on Windows and a `skilletor` command for PowerShell are
not supported yet ([Requirements](#requirements)). A command without options runs there
through the starter: `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy
Bypass -File "<plugin root>\bootstrap\getty-bun.ps1" run dist/skilletor.js sync` (an argument
beginning with `-` is not passed on safely yet).

## First steps

Tell the session what you want ("add Getty's skills with skilletor and install
getty-perl-moo"), and it runs the commands. Or type them in a shell that has `skilletor` on its
`PATH`:

```console
$ skilletor add Getty
added source getty ({"git":"https://github.com/Getty/skills"})
skilletor: up to date
$ skilletor install getty-perl-moo@getty
skilletor: user scope
  + skills/getty-perl-moo (active now)
```

That is a machine with Claude Code alone. Where Codex is installed too, the report adds
`+ codex:skills/getty-perl-moo (active from the next Codex session)`, and until you trust
skilletor's hooks in Codex, every sync (the one `add` and `install` run too) and `status` end
with a warning, `Codex has not trusted skilletor's SessionStart hook …`
([trust the hooks](#the-plugin-under-codex)).

`add` registers a source, trusts it and syncs: `Getty` is short for the git repository
`https://github.com/Getty/skills`, kept as the source `getty` in your user config
`~/.claude/skilletor.json`. `install` adds the item to that config and syncs it onto disk:
`~/.claude/skills/getty-perl-moo/` for Claude Code, and `~/.agents/skills/getty-perl-moo/` too
when Codex is on the machine. Each line of the report says when the item takes effect: in
Claude Code a skill at once, an agent or a rule after `/reload-plugins` or a restart; in Codex
and Hermes from the next session.

From then on every session start checks your sources and brings what you installed up to date.
During a session a background check does the same, at most every 30 minutes
([how to quiet it](#the-in-session-check-and-how-to-quiet-it)).

## Everyday use

**More sources.** A git repository with `skills/`, `agents/` or `rules/`, a Claude plugin
repository, a project that keeps its own items in `.claude/`, an HTTPS tarball or a directory
of your own ([Sources](#sources)):

```bash
skilletor add obra/superpowers            # a Claude plugin repository: source "superpowers"
skilletor add Getty/karr                  # a project: its .claude/ skills, agents and rules
skilletor add mine ~/dev/my-skills        # a local directory, under the name "mine"
skilletor available getty                 # what a source offers; ✓ marks what is installed
```

**Many items at once.** A name pattern, every item of a type, or a bundle: a named set the
source defines. Quote a pattern, so the shell leaves the `*` alone:

```bash
skilletor install 'skill:getty-perl-*@getty'   # every skill whose name matches
skilletor install 'rule:*@getty'               # every rule of the source
skilletor install bundle:house@getty           # the bundle "house" of the source getty
```

What a pattern or a bundle stands for is worked out again on every sync, so items added
upstream arrive by themselves ([Wildcards](#wildcards-and-name-patterns),
[Bundles](#bundles-a-named-set-from-a-source)).

**For one project, for everyone on it.** `--project` edits the project's
`.claude/skilletor.json` instead of yours, and the items go into the project. On a machine
with the Claude Code plugin installed from Getty's marketplace:

```console
$ cd ~/src/shop
$ skilletor add Getty --project
added source getty ({"git":"https://github.com/Getty/skills"})
skilletor: project scope
  .claude/.gitignore updated — commit it
  .worktreeinclude updated — commit it
  .claude/settings.json updated (enables skilletor@getty; declares marketplace getty) — commit it
$ skilletor install bundle:house@getty --project
skilletor: project scope
  + rules/engineering-discipline (active after /reload-plugins or restart)
  + rules/agent-delegation (active after /reload-plugins or restart)
  + rules/publish-gate (active after /reload-plugins or restart)
```

Commit `.claude/skilletor.json`, `.claude/.gitignore`, `.worktreeinclude` and
`.claude/settings.json`. The installed files stay out of git; each checkout gets them from its
own sync. The `.claude/settings.json` line makes the plugin a requirement of the project, so a
teammate's Claude Code offers to install it
([Sharing a project](#sharing-a-project-require-the-plugin)); without the Claude Code plugin
installed, that line is not there. What only this machine should use goes into
`.claude/skilletor.local.json`, which stays out of git.

**A project someone else set up.** A source that only the project's config declares is not
fetched until you trust it: rendering a source's templates can run code
([Security & trust](#security--trust)). The session start names it, and so does `sync`:

```console
$ skilletor sync
skilletor: project scope
  trust: source "getty" (git https://github.com/Getty/skills) — run: skilletor trust getty
$ skilletor trust getty
trusted source getty (git https://github.com/Getty/skills)
$ skilletor sync
skilletor: project scope
  + rules/engineering-discipline (active after /reload-plugins or restart)
  + rules/agent-delegation (active after /reload-plugins or restart)
  + rules/publish-gate (active after /reload-plugins or restart)
```

**Keep an eye on it.** The hooks sync for you; by hand:

```bash
skilletor status          # per scope: what is declared, ✓ what is installed
skilletor check           # is a sync due? exit 1 when it is; writes nothing
skilletor sync            # bring everything in line now
```

**One source, many projects: templates and vars.** A source file ending in `.njk` is rendered
with Nunjucks for each project, and `vars` in your config or the project's switch items on and
off ([Templates](#templates)):

```json
{ "vars": { "kubernetes": true } }
```

**Taking things out.** `uninstall` removes the entry, and the sync it runs removes the files;
`source remove` refuses while items of the source are installed, unless you pass `--force`:

```bash
skilletor uninstall getty-perl-moo@getty      # --project for the project's config
skilletor source remove getty
```

Every command and option: [CLI reference](#cli-reference).

## Status

What is released, what is switched on, and what is tested where:

- **Released.** The plugin's newest release is 0.7.0 (tag `v0.7.0`, MIT). This README
  describes 0.8.0, which is prepared and not released yet; its CPAN spelling is `0.008000`. On
  CPAN, `Skilletor` 0.001 is the Perl library alone: Claude Code only, no template rendering,
  no `skilletor` command. The marketplace entries name no version, so Claude Code and Codex
  install this repository's `main` as it stands.
- **Runtime: Bun through getty-bun.** skilletor runs on the Bun version pinned in
  `package.json` (`gettyBun.bunVersion`, 1.4.5), started by the getty-bun starters in
  `bootstrap/` from [agent-bun-runtime](https://github.com/Getty/agent-bun-runtime). Node.js,
  the Perl port and the planned release binaries are gone. getty-bun has no macOS target yet,
  and Claude Code on Windows waits for its `.cmd` starter: until both exist this runtime is not
  released ([Which engine runs](#which-engine-runs)).
- **Tested.** On every push, SimpiCI (`.cicd/`) runs in the `oven/bun` image of the pinned
  version: typecheck, the tests, a rebuild of `dist/skilletor.js` compared byte for byte with
  the committed one, and `check-starters`, which renders `getty-bun-install` afresh and
  compares it with `skills/getty-bun-install/` and with the copies in `bootstrap/`. `ci.yml`
  runs the same gates on Ubuntu; its macOS and Windows legs are advisory and expected red until
  getty-bun supports those platforms. On Windows the tests of the sh scripts (`install.sh`,
  `bin/skilletor`) skip themselves, as do those of the Hermes adapter. The Hermes support is
  tested against a real Hermes Agent on Linux only, on a machine that has one
  (`test/hermes-real.test.ts`, skipped in CI). Live Claude Code, Codex and Hermes sessions are
  not part of CI.

### Requirements

- `git` and a POSIX `sh`. Bun is not a requirement: the starter installs the pinned version
  per user under `~/.getty` (`$GETTY_HOME`) on the first start, downloading it with `curl` or
  `wget`, and every later start runs it from there without the network.
- Linux. macOS: not yet (above).
- Windows: the Codex hooks (`commandWindows`) and the Hermes adapter run
  `bootstrap\getty-bun.ps1` through `powershell.exe -ExecutionPolicy Bypass -File`. Claude Code
  on Windows and a `skilletor` command for PowerShell or cmd are not supported yet. Sources
  are checked out with the repository's line endings, whatever `core.autocrlf` says, so a
  project synced on Windows and on Linux gets the same files and lock.

### Which engine runs

One: `dist/skilletor.js`, bundled with `bun build`, on the pinned Bun. Every hook calls the
starter itself (`sh bootstrap/getty-bun.sh run dist/skilletor.js hook <event> <host>`, the
host `claude-code`, `codex` or `hermes` as a word, never a `--` flag); `bin/skilletor` — the
command `install.sh` links, the Claude Code plugin puts on `PATH` and the Hermes adapter's
fallback — is a small sh script that does the same with its arguments passed through.

The first start after an install, or after an update that moves the Bun pin, downloads Bun
under a lock, so that hook can take a while: the hooks allow 600 seconds. Offline, with no Bun
installed yet, the starter prints one `getty-bun: …` line and exits 1 before skilletor runs;
once a Bun is installed nothing needs the network. Repairing the runtime: `sh
<plugin>/bootstrap/getty-bun.sh status`, then `ensure` (the bundled skill has the details).

## How it works

![How skilletor works: sources (git, tarball, local dir) are rendered, diffed against disk and lock, and installed for Claude Code and Codex](assets/concept.png)

1. **Source** — a git repo, an HTTPS tarball or a local directory is resolved and scanned.
2. **Render** — `.njk` files go through Nunjucks, everything else is copied.
3. **Diff + lock** — the result is diffed against what is on disk and the lock.
4. **Install** — into the user's or the project's directories:

| | user | project |
|---|---|---|
| Claude Code | `~/.claude/{skills,agents,rules}` | `<project>/.claude/{skills,agents,rules}` |
| Codex | `~/.agents/skills`, `$CODEX_HOME/{agents,skilletor-rules.md}` | `<project>/.agents/skills`, `<project>/.codex/{agents,skilletor-rules.md}` |
| Hermes Agent (skills only, opt-in) | `<Hermes home>/skills` | `<project>/.hermes/skills`, not while Codex is a target of that project |

Hooks run it, in every harness the plugin supports:

| | session start | each prompt | the session moves into another checkout |
|---|---|---|---|
| Claude Code | `SessionStart` | `UserPromptSubmit` | after a Bash `cd`: `PostToolUse`, awaited; any other move: `CwdChanged`, not awaited |
| Codex | `SessionStart`, also after `/cd` (a new session) | `UserPromptSubmit` | the next `UserPromptSubmit`, awaited |
| Hermes | `on_session_start` | `pre_llm_call` | the next `pre_llm_call`, awaited |

So a worktree made with plain `git worktree add`, which has the committed config but none of
the gitignored items, can complete itself: the `cd` into it (Claude Code), or the next turn
there (Codex, Hermes), syncs that checkout using its project targets. Commit explicit project
`targets` for a metadata-only checkout on a multi-harness machine; an ambiguous project is
left untouched. Worktrees Claude Code creates itself get the items copied through
[`.worktreeinclude`](#git--your-own-skills).

- **Session start** — check every source (5s timeout each) and compare the config with what
  is installed; on a change, sync and report. An untrusted project source is named every
  session until you trust it.
- **Each prompt** — when the throttle is due, kick off a detached background sync (no
  console window on Windows) and deliver its result on a later prompt; otherwise return
  instantly and silent.
- **A move into another checkout of a skilletor project** — compare that checkout's lock
  with its config, without asking any source; on a difference, sync its project scope as at
  session start, say so in one line (`skilletor: 17 item(s) updated in <dir>`) and tell the
  model what landed. If it cannot (an untrusted source, a config error), the line names what
  to run there: `skilletor trust <name>` or `skilletor sync`. A move within the same
  checkout, or into a directory without `.claude/skilletor.json`, does nothing. A move is a
  change of the session's directory, not of the directory each command runs in.
  - Claude Code waits for the sync after a Bash `cd`: from the model's next message on,
    every tool call (an agent spawn too) finds the items there; a spawn sent in the same
    message as the `cd` starts in the old directory. A move without a Bash `cd`
    (`EnterWorktree` into an existing worktree, `pushd`) has `CwdChanged` alone, which an
    agent spawned right after it can outrun.
  - Codex and Hermes: a shell `cd` moves no session. A session moves only between turns
    (Codex: an app-server turn with a new `cwd`; Hermes: `/worktree new`, a gateway's
    re-anchor), and the next prompt waits for the sync. Under Hermes the line also names
    `hermes skills trust <dir>` when skills landed, since Hermes hides a project's skills
    until it trusts that directory.

In Claude Code skills become usable immediately; agents and rules activate after
`/reload-plugins` or a restart. Codex and Hermes list what a sync wrote from their next
session. The report says so per item. When an update changes the hooks, Codex runs them
only after you trust them again in `/hooks`. The Hermes plugin is updated on its own, with
`hermes plugins update skilletor`.

## Sources

A source is a git repo, an HTTPS `.tar.gz`, or a local directory. `skilletor add`
resolves a shorthand once and stores the explicit form, under the name you pass or the one
shown here:

| `<spec>` | resolves to | name |
|---|---|---|
| `Getty` | `git: https://github.com/Getty/skills` | `getty` |
| `Getty/repo` | `git: https://github.com/Getty/repo` | `repo` |
| `hf.co/user` | `git: https://hf.co/user/skills` | `user` |
| `gitlab.com/u/r` | `git: https://gitlab.com/u/r` | `r` |
| `https://github.com/u/r/tree/<ref>` (a browser link; also `…/releases/tag/<tag>`, `…/commit/<sha>`) | `git: https://github.com/u/r` with `ref: <ref>` | `r` |
| `https://github.com/u/r/tree/<ref>/<dir>` (a link into a directory) | the same with `path: <dir>` (see [Skills elsewhere](#skills-elsewhere-path)) | `r` |
| `host.tld/` | `https://host.tld/skills` (probed: git, then `.tar.gz`) | `host-tld` |
| `https://…/x.tar.gz` | `url` (HTTPS tarball) | the host |
| `~/dev/skills`, `./path`, `/abs` | `local` | the directory name |

A git repo other than `skills` is named after the repo, explicit URLs too
(`https://github.com/Getty/karr.git`, `git@github.com:Getty/karr.git` → `karr`); the
default repo after its owner. `add` never replaces a source: the same address again keeps
the entry as it is (a `ref` or `local` you set stays) and syncs — unless that entry is one
config load refuses (a hand-written `"ref": ""`, say), which fails (exit 1, nothing trusted
or changed) until you fix it; a name the config already gives another address fails (exit
1, nothing changed) — pass a name (`skilletor add <name> <spec>`) or `skilletor source
remove <name>` first. A GitHub tree link (`…/tree/<ref>`) pins that ref; the same address
already configured without it or with another ref fails the same way — set `ref` by hand.
A link into a directory (`…/tree/<ref>/<dir>`) stores that directory as the source's `path`
as well, and an entry with no `path` or another one fails likewise — set `path` by hand or
pass a name. A file link (`…/blob/…`) is refused: a source is a repository or directories of
it, not a file. So is any other page (`…/issues`, `…/pulls`, `…/releases`), naming the
repository to add instead. A link's `?query` and `#anchor` are dropped, and `%`-escapes in
its ref and path decoded (`…/tree/main/my%20skills` → `path: my skills`). Every GitHub form
reads a link the same way (`Getty/karr/tree/v1`, `github:Getty/karr/tree/v1`), and so do the
other known forges' links: GitLab `gitlab.com/g/r/-/tree/<ref>[/<dir>]` (`/-/commit/<sha>`,
`/-/tags/<tag>`; every segment before `/-/` is the project, nested groups included),
Codeberg `codeberg.org/u/r/src/branch|tag|commit/<ref>[/<dir>]`, Hugging Face
`hf.co/u/r/tree/<ref>[/<dir>]` (`datasets/` and `spaces/` repositories too). The segment
after `tree` is always taken as the ref, so write a `/` in a ref as `%2F`
(`…/tree/feature%2Fx/skills`), or add the repository and set `ref` (and `path`) by hand.

A source's layout (convention, no manifest):

```
skills/<name>/SKILL.md[.njk] + companion files
agents/<name>.md[.njk]
rules/<name>.md[.njk]
bundles/<name>.yaml        # optional: named sets of items (see Bundles)
snippets/…                 # includes only, not installable
skilletor.json             # optional: { "description": "…", "vars": { defaults } }
.claude/skills/<name>/     # a project's own Claude layout: read last, best effort
.claude/agents/<name>.md[.njk]
.claude/rules/<name>.md[.njk]
```

Claude plugin repos work too: paths listed in `.claude-plugin/plugin.json` `skills` (a
skill directory, or a directory of them) are added to those under `skills/<name>/` and install as
`skills/<name>/` wherever they sit. So does a project that keeps its skills, agents and rules
in its own `.claude/`: they install as `skills/<name>/`, `agents/<name>.md` and
`rules/<name>.md` like published ones; a name the layout above already offers wins, and a
symlink there, or a copy skilletor itself installed there, is skipped, never an error. For
example:

```bash
skilletor add anthropics          # → anthropics/skills, source "anthropics"
skilletor add obra/superpowers    # source "superpowers"
skilletor add mattpocock          # → mattpocock/skills, skills listed in its plugin.json
skilletor add Getty/karr          # source "karr", a project: its .claude/ skills, agents and rules
```

### Skills elsewhere: `path`

A repository that keeps its skills somewhere else — by category, say, with no `plugin.json`
— offers nothing under the layout above. Give its source entry a `path`: a directory, or a
list of them, relative to the repository root.

```json
"hermes": { "git": "https://github.com/NousResearch/hermes-agent", "path": ["skills", "optional-skills"] }
```

skilletor walks each path down, to any depth: a directory holding a `SKILL.md[.njk]` is one
skill, named after that directory and installed as `skills/<name>/`; it is not searched
further, and everything else on the way (a category's `DESCRIPTION.md`, an index cache,
symlinks, `.git`) is passed over. So a path can be the whole tree, one category
(`skills/research`) or a single skill (`skills/research/arxiv`). A skill carrying
skilletor's own `.gitignore` is a copy a sync installed there and is passed over too, so a
`path` into a project's `.claude/skills` offers its own skills only.

- `path` **replaces** the layout above for that source: it offers those skills and nothing
  else — no `skills/<name>/`, agents, rules, `plugin.json` or `.claude/` items, no bundles.
  The source's `skilletor.json` (description, var defaults) is still read. For both, add the
  repository under two names; they share one clone.
- Two directories with the same name make that one skill an error (`available` shows it,
  `install` refuses it, `sync` warns and keeps an installed copy); every other skill is
  offered. Names that differ only in case (`Foo`, `foo`) count as the same name on every
  system, since macOS and Windows would install both into one directory.
- A path that is absolute, contains `..` or is the repository root (`.`) is a config error;
  one that does not exist, is not a directory or is a symlink makes the source unresolvable
  for that sync — a warning, and what it installed stays.
- `path` is not part of what a source *is*: cache and trust follow the address alone. It
  merges across the config files like `ref` — the user's value replaces the project's, the
  local file's both, as a whole. Changing it syncs once, with the next session.
- The whole repository is still cloned (shallow); `path` narrows what is offered, not what is
  fetched.

A GitHub link into a directory sets it for you — `skilletor add
https://github.com/NousResearch/hermes-agent/tree/main/optional-skills` stores `ref: main`
and `path: optional-skills`; a list of paths, or a `path` without a `ref`, is written into
the entry by hand.

## Declaring what you want

`skilletor.json` at three levels; the scope follows from which file declares an item:

| File | Scope | Installs into (Claude Code; Codex: see [Codex](#codex)) |
|---|---|---|
| `~/.claude/skilletor.json` | user | `~/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.json` | project (committed) | `<project>/.claude/{skills,agents,rules}` |
| `<project>/.claude/skilletor.local.json` | machine-local (not committed) | as project |

With `CLAUDE_CONFIG_DIR` set, Claude Code's config dir stands in for `~/.claude` everywhere in the user scope:
the user config, the lock, the installed items, the state dir and the detection markers.

```json
{
  "sources": {
    "shared": { "git": "https://github.com/Getty/skills", "ref": "main" },
    "team":   { "url": "https://skills.example.com/skills.tar.gz" },
    "mine":   { "local": "~/dev/my-skills" }
  },
  "install": {
    "skills": ["perl-moo@shared"],
    "agents": ["karr@shared"],
    "rules":  ["commit-style@team"],
    "bundles": ["perl@shared"]
  },
  "vars": { "kubernetes": true },
  "gitignore": true,
  "checkInterval": 1800
}
```

Only `skill`, `agent` and `rule` are installable — skilletor never syncs hooks,
`settings.json` or MCP configs (it only adds the plugin requirement to a project's
`.claude/settings.json`, see [Sharing a project](#sharing-a-project-require-the-plugin)). An optional `"targets"` key picks the harnesses to install
for (`claude`, `codex`) — see [Codex](#codex).

A source's `git`, `ref` or `local`, when present, must be a non-empty string (omit `ref`
for the remote's HEAD, never `""`), and `url` an `https://` URL; a `path` (see [Skills
elsewhere](#skills-elsewhere-path)) a non-empty string or a non-empty list of them. Anything
else is a config error naming the file, the source and the key — never a field quietly read
as absent.

A source declared in one file can be changed from another: the user config and
`skilletor.local.json` merge over the project's `skilletor.json`, field by field. An entry
there needs no `git`, `url` or `local` of its own when another file gives one, so
`{ "sources": { "shared": { "ref": "v2" } } }` in `skilletor.local.json` pins the project's
`shared` on this machine, and `{ "path": [...] }` re-paths it. A `ref` is used only while the
source is read from `git`, and stays when a higher file gives another `git` without one;
`{ "ref": null }` unpins it — the files below lose their `ref`, the remote's HEAD is used, and
a file above may pin again. A source no file gives a backend is a config error naming the
source and the files declaring it, so `source remove` refuses to remove the one entry giving
the backend while another file keeps an entry without one; the error names those files. Your user config's sources alone build your user-scope items, so an entry there without a
backend changes projects only — and fails where no project declares that source.

A source's name — its key under `sources` — is ASCII letters, digits, `.`, `_` and `-`,
starting with a letter or digit; any other name is a config error naming the file and the
name, and `skilletor add` refuses it before writing anything. It likewise refuses a spec
that resolves to a source config load would refuse, such as an `http://` or `file://` tarball
(exit 1, nothing written or trusted); a bundle entry naming such an address is an error of
that bundle, which `available` and `sync` show and `install` refuses.

`skilletor uninstall` removes explicit entries from one config — the user config, or the
project config with `--project`. `rule:k8s@shared` removes only from `rules`;
`k8s@shared` removes from every list. Every item is checked before anything is edited:
an item with no explicit entry in that config fails the command (exit 1, config
untouched), and the error names where it comes from instead — a wildcard, a bundle,
another type's list, or the other scope's config.

### Wildcards and name patterns

`"*@source"` in an install list declares every item of that type the source offers; `*`
may stand anywhere in the name, so a pattern picks the matching ones:

```json
{ "install": { "rules": ["*@shared"], "skills": ["perl-*@shared"] } }
```

`"rule:*@shared"` is the same with an explicit type (`"rule:*-style@shared"` for a
pattern). On the command line the type prefix is required, and the argument must be
quoted so the shell does not glob it:

```bash
skilletor install 'rule:*@shared' 'skill:perl-*@shared' [--project]
skilletor uninstall 'rule:*@shared' [--project]
```

A wildcard is expanded against the source on every sync, so items added upstream arrive
on the next sync and items removed upstream are deleted. A pattern that matches nothing
warns (`skill wildcard zzz-*@shared matches nothing in source shared`); a bare `*` stays
silent, since a source without rules is normal. When names overlap (per type and scope)
nothing fails:

- an explicit entry and a wildcard over the **same** source name the same item → the
  explicit entry is used, silently;
- an explicit entry and **another** source's wildcard → the explicit entry wins, the
  report warns;
- two wildcards or bundles of the **same** source yield the same name (`perl-*` and
  `*-style` both match `perl-style`) → installed once, silently;
- wildcards or bundles of **different** sources offer the same name → that one name is
  skipped with a warning (an installed copy stays as it is); every other item proceeds.

Names that differ only in case (`Foo`, `foo`) are the same name throughout — in a source,
across sources and in your install lists — on every system, since macOS and Windows would
install both into one directory: two of them in one source are an error of each (`available`
shows it, `install` refuses it, `sync` warns and keeps an installed copy), and two install
entries or two sources' offers of them collide like the same name. `uninstall foo@shared`
removes an entry `Foo@shared`, and an item whose name changes only in case (`Foo@shared` →
`foo@shared`, or upstream renaming its directory) is taken over in place: on macOS and
Windows the sync keeps the file both spellings name instead of deleting it with the old one.

An item installed through a wildcard cannot be uninstalled by name — the wildcard would
bring it back. Uninstall the wildcard (`skilletor uninstall 'rule:*@shared'`), or keep it
and switch the item off via vars ([empty render = skipped](#switching-items-on-and-off-with-vars)).
Uninstalling an explicit entry that a wildcard also covers works, with a warning that the
item returns on the next sync.

Declaring the same wildcard twice in one scope is a config error. If a source cannot be
resolved (offline without cache, untrusted, broken layout), everything it installed —
explicitly or through a wildcard — stays in place; deletion only follows a successful
resolve. `skilletor status` marks such items `via *@shared` (or `via perl-*@shared`) and
adds one line per wildcard, e.g. `* rules/* @shared (3 installed)`.

### Bundles: a named set from a source

A source can name a set of items in `bundles/<name>.yaml` (or `.yml` — not both), so a
project declares one entry instead of repeating a list:

```yaml
# bundles/perl.yaml in github.com/Getty/skills
description: Everything for Perl projects
skills:
  - "perl-*"                   # quote a leading * in a block list
  - testing
  - karr@gitlab.com/peter      # an item of another source, by address
agents: [perl-reviewer]
rules: ["*-style"]
bundles: [base]                # another bundle of this source, included
vars:
  perl_version: "5.40"
```

`description` is required; `skills`, `agents`, `rules` take names and patterns (bare =
this source); `bundles` takes bare names of this source's bundles, nested recursively
(a cycle is an error); `vars` sets defaults for the items this bundle yields. Any other
key is an error. The YAML is skilletor's own subset: no anchors, aliases or tags — which
is why an unquoted `- *-style` fails to parse and must be written `- "*-style"`.

```bash
skilletor install bundle:perl@shared [--project]     # adds "perl@shared" to install.bundles
skilletor uninstall bundle:perl@shared [--project]
```

`perl@shared` without the prefix works too when no skill, agent or rule of `shared` is
called `perl`; otherwise the command fails as ambiguous and names both forms
(`skill:perl@shared, bundle:perl@shared`). Bundles are expanded on every sync, like
wildcards, and their items follow the same overlap rules. A name the source lacks or a
pattern that matches nothing warns; a broken bundle (missing, unparseable, cycle, bad
address) affects only itself, and what it installed before stays.

**Vars.** For an item a bundle yields: `source defaults < bundle vars < user < project <
local`. Bundle vars reach only that bundle's items. Along a chain the outer bundle wins
(`perl` over the `base` it includes). If one item is reached through two chains that set
a key differently, neither value applies — the item falls back to the source default and
the report warns, naming both bundles. An item you declare explicitly gets no bundle vars,
even when a bundle yields it too.

**Items of other sources.** `name@<spec>` (patterns too: `perl-*@gitlab.com/peter`) names
an item of another source by its address, so a bundle means the same on every machine.
`<spec>` is the `skilletor add` shorthand, limited to forms that need no network probe:
`Getty`, `Getty/repo`, `gitlab.com/peter`, `hf.co/user`, full git URLs (a tarball only as
`https://…`). A generic host must be written as a full `https://` URL, and local paths are
not allowed; an address config load would refuse as a source, or a link carrying a ref
(`…/tree/<ref>`), is an error of the bundle — an entry names a repository only. The entry
is served by whichever configured source has the same resolved `git`/`url` — its config
name does not matter, and a `local` override of it (authoring mode) still applies.

If that source is missing:

- `skilletor install bundle:perl@shared` on a terminal asks per missing source —
  `bundle perl needs a source you don't have yet: gitlab.com/peter →
  https://gitlab.com/peter/skills — add it as [peter]? (name, or n to skip)` — and adds it
  like `skilletor add` (which trusts it) to the config the bundle goes into.
- Without a terminal the command changes nothing, exits 1 and prints the commands to run:
  `skilletor add peter gitlab.com/peter --project`.
- `sync` and the hooks **never** add a source — a trusted source must not pull in an
  untrusted one, since rendering runs code. They warn once per missing source and bundle
  (`bundle perl@shared needs gitlab.com/peter (https://gitlab.com/peter/skills): run
  skilletor install bundle:perl@shared`), skip those items and keep installed copies.

**Seeing and removing.** `skilletor available` lists each bundle (type `bundle`) with its
description and expanded members; `--json` adds `members` and `vars`. `skilletor status`
marks items `via bundle:perl@shared` and adds `* bundle:perl@shared (7 installed)`. An item
only a bundle declares cannot be uninstalled by name: the error names the bundle — uninstall
the bundle, or switch the item off via vars.

**Agents and their skills.** A Claude agent lists the skills Claude Code preloads for it in
the top-level `skills:` of its frontmatter (`skills: [a, b]` or a block list); Claude Code
skips a name it cannot find without a word. After every sync skilletor checks each installed
Claude agent against the skill roots Claude Code searches (`~/.claude/skills`, plus the
project's `.claude/skills` for a project agent, plus Claude plugin caches) and warns:
`agent reviewer (claude): skills not installed: perl-core`. `plugin:skill` names
are not checked, and a Codex role file carries no skills, so Codex agents are not checked.
`status` shows the same per agent (`skillsMissing` in `--json`); the
`SessionStart` hook mentions it only when it changed something. Ship an agent and its
skills together in one bundle so they are always installed as a set.

### The in-session check (and how to quiet it)

skilletor always reconciles at **session start**. During a session it also
re-checks your sources in the background, throttled by `checkInterval` (user
config only — in a project or local file it is a config error that stops skilletor
loading its config; seconds, **default 1800 = 30 min**). If that's too chatty for you:

```json
{ "checkInterval": 0 }   // turn the in-session check off entirely
```

With `0` (or any value ≤ 0) skilletor only syncs at session start — no
background fetching while you work. Raise the number instead to check less often
(e.g. `3600` for hourly).

## Templates

A source file ending in `.njk` is rendered with Nunjucks and installed with `.njk`
stripped; everything else is copied byte for byte, so skills that use `{{ }}`/`{% %}`
themselves stay intact. A skill's file keeps its source file's executable bit (a template
passes its own to what it renders), so a skill can tell the model to run `scripts/x.sh`.
An agent or rule published as both `<name>.md` and `<name>.md.njk` is an error of that
item, as is a skill holding any file beside its template (`SKILL.md` and `SKILL.md.njk`,
`scripts/x.sh` and `scripts/x.sh.njk`): `available` shows it, `install` refuses it, and
`sync` warns and keeps an installed copy.

```njk
{% if vars.kubernetes %}
Use the {{ project.name }} cluster in namespace {{ vars.k8s_namespace }}.
{% endif %}
```

Context: `vars.*` (source defaults < [bundle vars](#bundles-a-named-set-from-a-source) < user < project < local), `project.*` (project
scope: `dir`, `name`, `git_remote`), `scope`, `harness` (`claude`, `codex` or `hermes`),
`target.dir`, `host.*`, `user.*`, `item.*`. There is deliberately no `env.*`, and printing an undefined variable (`{{ vars.x }}`) is an error (so a typo can't
ship an empty skill). Testing one (`{% if vars.x %}`) is not: it is simply false.

Tags are not whitespace-trimmed, so a `{% if %}` on its own line leaves a blank line. In
frontmatter that matters: a `skills:` list stays gap-free. Use `{%- if … %}` / `{%- endif %}` there (left side only – `-%}` would also eat the
next line break and glue the list items together).

### Switching items on and off with vars

If an item's main file is a template — `SKILL.md.njk` for a skill, `<name>.md.njk` for
an agent or rule — and it renders to nothing but whitespace (a leading frontmatter block
does not count), the item does not apply in that scope. It is skipped as a whole: nothing
is written (for a skill, none of its other files either), an already installed copy is
removed, and it is neither an error nor a warning. A main file that is not a template is
never skipped, even if empty. The sync report says `· rules/k8s skipped (renders empty)`,
or `- rules/k8s (removed: renders empty)` when a copy was deleted; `status` shows
`(skipped: renders empty)`.

That makes a source of small, gated rules — one per concern — switchable per config:

```njk
---
paths: ["**/*.yaml"]
---
{% if vars.kubernetes %}
Use kubectl --context {{ vars.k8s_context }}.
{% endif %}
```

Install the whole set once with `"rules": ["*@shared"]` and turn individual rules on with
`"vars": { "kubernetes": true }` in the user, project or local config. `k8s_context`
is printed inside the gate, so it needs a default in the source's `skilletor.json`.
Vars follow the item's scope: a user-scope item sees only user vars (plus source
defaults); project and local vars switch items installed in project scope.

## Authoring mode

Maintaining a source? Override the same-named source with a `local` checkout in your
**user** config:

```json
{ "sources": { "shared": { "local": "~/dev/skills" } } }
```

skilletor then reads that directory directly and re-renders on every sync — edits land
immediately. Push with git and every machine pulls them on the next check. Installed
files are build artifacts; there are no hardlinks.

## Git & your own skills

Installed items sit next to your own skills, agents and rules, and a fixed set of ignore
rules keeps them out of commits:

- **Skills** keep their name (`.claude/skills/perl-moo/`); each installed skill directory
  gets its own `.gitignore` containing `*`.
- **Agents and rules** are installed as `.claude/agents/.local.<name>.md` and
  `.claude/rules/.local.<name>.md` (Codex agents: `.codex/agents/.local.<name>.toml`). The
  agent keeps the name from its frontmatter; the prefix follows Claude Code's convention
  for files that are not committed (`CLAUDE.local.md`, `settings.local.json`).
- **`<project>/.claude/.gitignore`** holds a marked block that never changes:

  ```gitignore
  # >>> skilletor >>>
  agents/**/.local.*
  rules/**/.local.*
  skilletor.local.json
  skilletor.lock.json
  # <<< skilletor <<<
  ```

  `<project>/.codex/.gitignore` gets the same kind of block for Codex agents and the rules
  file. Only projects that use skilletor (a `skilletor.json` or `skilletor.local.json`, or
  items still installed) get a block; a repository you merely open stays untouched.

- **`<project>/.worktreeinclude`** gets a fixed block too, naming the installed skill,
  agent and rule paths of every harness, the lock and `skilletor.local.json`. Claude Code
  copies the gitignored files it matches into each worktree it creates (`--worktree`,
  subagents with `isolation: worktree`, desktop parallel sessions), so agent worktrees have
  the project's installed items without a sync. Your own lines in that file stay untouched.

Commit `skilletor.json`, the `.gitignore` files and `.worktreeinclude`; the report asks you
to once, when sync creates or changes a block. Your own hand-written skills, agents and rules stay
version-controlled and are never touched — only don't name your own files `.local.*` in
`agents/` or `rules/`, that prefix is skilletor's. A hand-written `agents/foo.md` next to an
installed agent `foo` is reported as a conflict (two agents would share the name);
`--force` replaces it with the installed one. Set `"gitignore": false` in the project
config to commit everything instead (useful only for items without machine-specific
variables); the file names stay the same.

Took over a file git already tracks (a skill you committed, then adopted with `--force`,
or files committed while `"gitignore"` was `false`)? `.gitignore` does not untrack it:
when sync writes such a file, the report names the item and the command that fixes it,
e.g. `git rm -r --cached .claude/skills/foo`. skilletor never touches the git index itself.

Keep `~` or `~/.claude` in a dotfiles repository? `~/.claude` and `$CODEX_HOME` get the
same fixed block when they lie inside a git work tree; the `~/.claude` block also lists
the state directory `skilletor/`, never `skilletor.json`. A root outside a work tree gets
no block. `"gitignore": false` in `~/.claude/skilletor.json` removes the user blocks; it
does not affect projects.

A file is skilletor-managed exactly when it appears in
`<scope>/.claude/skilletor.lock.json`. Managed files are overwritten on the next sync —
change them in the source, not in place. A sync that stops on a write error (a full disk,
a permission) still records what it wrote, so the next sync picks up where it stopped;
until then `status` marks the item `(partial: the last sync stopped midway)`.

### Shipping a rendered skill in your plugin: `"into": "plugin"`

A plugin repository can ship a skill skilletor renders: name the install as an object with
`"into": "plugin"` in the project's `.claude/skilletor.json`.

```json
{ "install": { "skills": [ { "skill": "getty-bun-install@agent-bun-runtime", "into": "plugin" } ] } }
```

The skill is rendered once, with the project's vars, into the plugin's own skills directory —
the `skills` path of `.claude-plugin/plugin.json`, else `skills/` — whatever the `targets`, and
not into `.claude/skills`. You commit the result: it is a file of the plugin (the report says
`a file of the plugin: commit it`), and the lock owns it as `plugin:skills/<name>`, so sync
updates it, `check` reports drift, a hand edit is a conflict and uninstalling removes it. A
fresh checkout has no lock; files there that equal the render byte for byte, mode included,
are taken over without a conflict (the report says `= plugin:skills/<name> (adopted: already on
disk as rendered)`, `adopted` in `sync --json`). Only skills, only in a project, one named item
(no pattern); a project without the plugin manifest is a config error. skilletor itself ships
`skills/getty-bun-install/` this way, and its CI renders it again and compares.

### Sharing a project: require the plugin

Installed items are not committed, so a fresh checkout has `skilletor.json`, and skills or
rules of your own that may mention skilletor, but none of the installed items until
skilletor syncs it. So a project sync makes the plugin a requirement of the project in its
committed `.claude/settings.json`: it enables `skilletor@<marketplace>` — the marketplace
your Claude Code installed skilletor from — and declares in `extraKnownMarketplaces` every
marketplace an `enabledPlugins` entry there needs, with the
source Claude Code knows it by. The report says what it added once:

```
.claude/settings.json updated (enables skilletor@getty; declares marketplace getty) — commit it
```

Commit it with `skilletor.json`. When a teammate trusts the checkout, Claude Code offers to
add the marketplace and install the plugin; the first session then syncs the project.

- It runs only for a project with a committed `.claude/skilletor.json` (not
  `skilletor.local.json` alone) and Claude Code among its targets. `~/.claude/settings.json`
  and `settings.local.json` are never touched.
- Add-only: existing keys, their order, the file's indent and line endings stay; nothing to
  add, no write. An entry `"skilletor@getty": false` (or skilletor from another marketplace)
  is left as it is; a key you delete comes back — set it to `false` instead.
- A marketplace with a source that only exists on your machine (a `directory`, a git
  checkout on disk) is never written, nor is one Claude Code does not know; the report warns.
  A `settings.json` that does not parse is left alone with a warning.
- `"claudeSettings": false` in the project's `skilletor.json` (or `skilletor.local.json`, or
  `~/.claude/skilletor.json` for every project) turns it off.
- **Inferred targets stay stable.** If the proposed settings addition would change the
  project's inferred targets — for example, make genuine marketplace-only settings look
  generated — skilletor leaves the settings file unchanged and warns. Items still sync to
  the stable selected targets; only the plugin-settings update is skipped. Set explicit project
  `targets` and sync again to allow the normal update. It does not invent target choices or
  store provenance; this skipped settings update is not perpetual drift for `check`.

Running the standalone CLI without the plugin, skilletor knows no marketplace to enable;
add it by hand (merge the keys into the existing file):

```json
{
  "extraKnownMarketplaces": {
    "getty": { "source": { "source": "github", "repo": "Getty/marketplace" } }
  },
  "enabledPlugins": { "skilletor@getty": true }
}
```

Codex has no equivalent project requirement: Codex users install the plugin themselves
([The plugin under Codex](#the-plugin-under-codex)).

## Codex

skilletor installs for Claude Code, the OpenAI Codex CLI, or both — from the same sources
and the same `skilletor.json`. Config, lock and state stay under `.claude/` for both
harnesses, even on a Codex-only machine.

### Which harnesses: detection and `targets`

Without user `targets`, skilletor detects the harnesses available on the machine from
files the harness itself creates (never `~/.claude/` alone — skilletor's own config lives
there). These are the user-scope targets and the allowlist for project targets, not a request
to install every harness into every project:

| Harness | In use when any of these exists |
|---|---|
| `claude` | `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/projects/` |
| `codex` | in `$CODEX_HOME` (default `~/.codex`): `config.toml`, `auth.json`, `sessions/`, `installation_id` |

**Hermes Agent is never auto-detected as a machine target.** `hermes` is available only
when the `targets` of `~/.claude/skilletor.json` names it.

User `"targets"` – any of `"claude"`, `"codex"`, `"hermes"` – replaces machine detection,
so list every harness available for use, not just the one you add. To allow Hermes on a
machine with Claude Code and Codex:

```json
{ "targets": ["claude", "codex", "hermes"] }
```

The rules:

1. **Machine targets** = the user config's `targets` if set, else the detected set (Claude
   Code and Codex only). If that is empty, `sync`, `check` and `status` stop with a config
   error naming the markers, and nothing is touched — set `targets` in
   `~/.claude/skilletor.json`.
2. **User scope** installs for the machine targets.
3. **Project scope** first uses explicit project `targets` (`skilletor.local.json` before
   `skilletor.json`), intersected with the machine allowlist. A project cannot enable a
   machine-disallowed harness; an empty explicit intersection installs nothing and warns.
4. **Without project `targets`, the project decides:** its own Claude instructions, settings
   or items select Claude; own `.agents` skills or `.codex` files select Codex; genuine use
   of both selects both. Own `.hermes` files can select Hermes after its machine-level
   opt-in; `.agents` alone never selects Hermes. Global `targets: ["claude", "codex"]` alone
   therefore does not put Codex files into a Claude-only project.
5. **Skilletor's own files do not opt a project in.** Its configuration, lock/state, generated
   settings, `.local.*` items and installed-skill markers are excluded. Empty settings and
   empty leftover directories do not count either; a skill needs `SKILL.md` or a user-owned
   link. Generic `AGENTS.md` alone is not specific to Codex.
6. **No clear project evidence:** with one machine target, use that target. With several,
   leave the project scope untouched and warn to set project `targets`; user-scope work
   continues. This avoids guessing a target or deleting existing project files.

To make a fresh checkout unambiguous, add `"targets": ["claude"]` (or the desired subset)
to its existing `.claude/skilletor.json`; use `skilletor.local.json` for a machine-local
choice. This also makes an intentional multi-harness project explicit. The choice does not
change with the harness that invokes the next hook.

Detection runs on every sync, so a harness that disappears (say `~/.codex` is deleted) has
its items removed on the next sync — pin user `targets` if that is not what you want. A
project's definite selection likewise removes only skilletor-owned outputs of deselected
targets, leaving foreign files alone; ambiguous projects are preserved instead. What
`hermes` gets is in [Hermes Agent](#hermes-agent).

### Where items go

`<base>` is `~` for user scope and the project root for project scope.

| Type | Claude Code | Codex |
|---|---|---|
| skill | `<base>/.claude/skills/<name>/` | `<base>/.agents/skills/<name>/` |
| agent | `<base>/.claude/agents/.local.<name>.md` | user: `$CODEX_HOME/agents/.local.<name>.toml`; project: `<project>/.codex/agents/.local.<name>.toml` |
| rule | `<base>/.claude/rules/.local.<name>.md` | a section of `$CODEX_HOME/skilletor-rules.md` (user) or `<project>/.codex/skilletor-rules.md` (project), delivered by the `SessionStart` hook |

Every item is rendered once per target, with `harness` (`claude`, `codex` or `hermes`) in
the template context, so a source can branch on it. Gating a whole item works like any other
[empty render](#switching-items-on-and-off-with-vars): a skill whose `SKILL.md.njk` is
wrapped in `{% if harness == "claude" %}` is installed for Claude Code and skipped for
Codex. Skills are copied as they are — Codex accepts Claude's SKILL.md format.

The lock stays one file per scope (`<base>/.claude/skilletor.lock.json`); Codex entries
are keyed `codex:skills/<name>`, `codex:agents/<name>`, `codex:rules/<name>`, and the sync
report and `status` list them under those keys. Codex items are active from the next Codex
session.

Codex reads project agents from `<project>/.codex/agents/` only in a project it
**trusts**; in an untrusted project it ignores `.codex/` with a warning.

### Agents: the `codex:` block

A Codex agent role is a TOML file. skilletor renders the agent's Markdown for `codex` and
converts it: `name` and `description` come from the frontmatter, the body becomes
`developer_instructions`. Codex-specific settings go under an optional `codex:` mapping,
passed through as top-level TOML keys (they override the three above):

```markdown
---
name: reviewer
description: Reviews diffs for correctness and style.
model: sonnet
tools: Read, Grep
codex:
  model_reasoning_effort: high
  sandbox_mode: read-only
---
You review code. …
```

becomes

```toml
name = "reviewer"
description = "Reviews diffs for correctness and style."
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = '''
You review code. …
'''
```

- **Claude-only keys are not carried over** — `model`, `tools`, `allowed-tools`, `color`
  and any other key outside `codex:` — and nothing is reported for them. There is no
  faithful mapping (`model: sonnet` means nothing to Codex); put Codex values under `codex:`.
- `codex:` values may be strings, numbers, booleans, string arrays, or one level of tables
  of those. Anything else is dropped with a warning naming the key. skilletor does not
  check the values against Codex's schema — Codex ignores the whole role on a bad value.
- **`skills:` stays on the Claude side.** The Codex role file carries no skills, so the
  top-level `skills:` list is not converted and not checked for the Codex copy.
- An agent without a `description` is not written for Codex (warning) — Codex rejects
  such a role. An agent whose body is empty is skipped for Codex.

### Rules: the rules file, the hook and a pointer in `AGENTS.md`

Codex has no rules directory, and `AGENTS.md` is usually committed, cannot be partly
ignored and is cut at `project_doc_max_bytes` — so no rule text goes there. skilletor
writes all of a scope's Codex rules into one **rules file**, and its `SessionStart` hook
hands that file to Codex:

| Scope | Rules file | Pointer block in |
|---|---|---|
| user | `$CODEX_HOME/skilletor-rules.md` | `$CODEX_HOME/AGENTS.md` |
| project | `<project>/.codex/skilletor-rules.md` | `<project>/AGENTS.md` |

```markdown
<!-- skilletor:rules scope=project -->
<!-- managed by skilletor — edits are overwritten; change the rule in its source -->

<!-- skilletor:rule k8s source=shared -->
Applies when working with files matching: `k8s/**`, `*.yaml`.

Use kubectl carefully.
```

- One section per rule, sorted by name. The body is the rule rendered for `codex` without
  its frontmatter; a `paths:` list (Codex cannot load a rule conditionally) becomes the
  leading "Applies when working with files matching" line.
- **The file is wholly skilletor's.** It exists exactly while the scope has a Codex rule and
  is deleted with the last one. A section edited or deleted by hand is restored on the next
  sync and reported as an overwritten local change (`.codex/skilletor-rules.md#rules/k8s`).
  Change the rule in its source.
- **Delivery.** On `startup` and `clear` the hook puts the user rules file, then the project
  one, at the start of the session's context — read from disk, so a failed or timed-out
  sync still delivers the last good rules. On `resume` it adds nothing: the resumed history
  already holds the first copy, and a second would duplicate it. `UserPromptSubmit` never
  adds rules.
- **The pointer.** `AGENTS.md` gets only a fixed block telling Codex to read the rules file
  when the hook's message is gone (after compaction, say). Its text never changes, so it
  appears in a diff only when a scope gains its first Codex rule or loses its last one:

  ```markdown
  <!-- skilletor:begin -->
  <!-- managed by skilletor — edits inside are overwritten -->
  Additional rules for this project are managed by skilletor. They are normally provided at
  session start as a developer message beginning with `<!-- skilletor:rules`. If that message
  is not in your context (for example after context compaction), read
  `.codex/skilletor-rules.md` before you start a task, and follow it.
  <!-- skilletor:end -->
  ```

  The user block says "for all projects" and names the user rules file by absolute path.
  Everything outside the markers is yours and never modified. A missing `AGENTS.md` is
  created with just the block; an existing one gets it appended. When the rules file goes,
  the block goes; a file left empty is deleted.
- **Refusals** skip only the pointer — the rules file and the hook delivery are unaffected.
  skilletor warns and leaves `AGENTS.md` alone; `--force` does not override:
  - the markers are malformed: `begin` without `end`, `end` before `begin`, either twice;
  - `AGENTS.md` is a symlink (commonly `AGENTS.md` → `CLAUDE.md`: writing through it would
    send Claude Code to the Codex rules), a directory, or unreadable;
  - Claude Code is a target too and a `CLAUDE.md` it reads is the same file as that
    `AGENTS.md` (`CLAUDE.md` or `.claude/CLAUDE.md` in a project, `~/.claude/CLAUDE.md` for
    `$CODEX_HOME/AGENTS.md`; linked or hard-linked).
- **Warnings:** an `AGENTS.override.md` next to the file (Codex reads the override
  instead, so the pointer is not seen); a project `AGENTS.md` larger than Codex's
  `project_doc_max_bytes` (default 32768, read from `$CODEX_HOME/config.toml`) — Codex cuts
  project instructions from the end, where the pointer sits.
- **Git:** with `"gitignore": true` (the default) the project rules file is listed in the
  managed `.codex/.gitignore` block, so rule text stays out of commits; only the small
  pointer block shows up in the diff of `AGENTS.md`.
- **Coming from an older skilletor:** rules that used to sit as sections of the block in
  `AGENTS.md` move to the rules file on the next sync, and the block is replaced by the
  pointer. The report lists the rules as updated, not as overwritten local changes.

### The plugin under Codex

The repository ships a Codex plugin manifest (`.codex-plugin/plugin.json`) next to the
Claude one; both ship the bundled skill. The Codex manifest points at its own
`hooks/codex-hooks.json` — the same hooks as `hooks/hooks.json`, run with the host `codex`
through the starter (`commandWindows` runs `bootstrap\getty-bun.ps1` on Windows),
plus the rules delivery; `CwdChanged` is not among them, Codex has no such event, nor is
`PostToolUse`: a Codex shell `cd` moves no session. A Codex
session moves only between turns (an app-server turn with a new `cwd`; `/cd` starts a new
session, which syncs at its start), so `UserPromptSubmit` syncs a checkout the session moved
into before the turn goes on; Codex gives it 30 s, as `SessionStart`. A skill that sync writes
is on disk at once but listed by Codex only from the next session.

- **Trust the hooks.** Codex runs a plugin's hooks only after you trust them — open
  `/hooks` in Codex and trust skilletor's `SessionStart` and `UserPromptSubmit` hooks.
  Until then Codex skips them without a word: no syncs, no rules. While Codex is a target
  and `$CODEX_HOME/config.toml` holds no trust entry for skilletor's `SessionStart` hook,
  `sync` and `status` warn once per run — in `--json` output as a top-level `warnings`
  array (`{ "scopes": […], "warnings": ["Codex has not trusted …"] }`, absent when empty;
  the per-scope `warnings` of `sync` are unchanged). An update that changes the hook file
  makes Codex mark the hook as modified; trust it again in `/hooks`. skilletor does not
  detect that case — the entry is still there.
- **Codex does not add a plugin's `bin/` to `PATH`.** A separately installed `skilletor`
  can still be available there; use that CLI when present. Otherwise the bundled skill locates the current plugin's launcher
  by absolute path: `$CODEX_HOME/plugins/cache/<marketplace>/skilletor/<version>/bin/skilletor`
  (it runs the getty-bun starter beside it, [Which engine runs](#which-engine-runs)). In your own shell,
  [`install.sh`](#from-the-command-line) puts a `skilletor` on `PATH`;
  or put that file or a clone of this repository there yourself, by a symlink
  (`ln -s ~/src/skilletor/bin/skilletor ~/.local/bin/skilletor`) or an alias
  (`alias skilletor=~/src/skilletor/bin/skilletor`) — `dist/` is committed, no `bun install`
  needed; the launcher follows its own symlinks to find it.
- Codex sets no `CLAUDE_PROJECT_DIR`; the hook takes the git top level of the session's
  working directory as the project root, so a session started in a subdirectory still
  finds `<repo>/.claude/skilletor.json`.

## Hermes Agent

skilletor also installs for NousResearch [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(`hermes`): **skills**, in both scopes, from the same sources and the same `skilletor.json`.
The Hermes support is tested on Linux only.

**Hermes is opt-in.** It is never auto-detected on the machine; name it in the `targets`
of `~/.claude/skilletor.json`, together with every other harness you use, since user
`targets` replaces machine detection ([above](#which-harnesses-detection-and-targets)):

```json
{ "targets": ["claude", "hermes"] }
```

A project's `targets` can select Hermes only from that machine allowlist. Without explicit
project targets, its own harness files (or the sole-machine-target fallback) decide; opting
Hermes in globally does not by itself enable it in every project. Until the machine opts in,
the [plugin](#the-plugin-under-hermes) adds one line at each Hermes session start saying
what to set. Remove `hermes` from user `targets` again, and the next sync removes the
skills it installed for Hermes.

| Type | Hermes |
|---|---|
| skill, user scope | `<Hermes home>/skills/<name>/` |
| skill, project scope | `<project>/.hermes/skills/<name>/` — not while `codex` is a target of that project, see below |
| agent | not installed: Hermes has no agent files (`delegate_task` takes a goal, not a role file) |
| rule | not installed: Hermes has no rules directory (see [what is missing](#what-is-missing)) |

Lock keys are `hermes:skills/<name>`; `harness` is `hermes` in the template context; Hermes
reads Claude's `SKILL.md` format as it is. Each installed skill carries its own `.gitignore`
like everywhere else, and skilletor never writes a `.gitignore` of a Hermes directory. A
skill is on disk — and reachable by `skill_view` — as soon as the sync ran, and in the
skill index of the system prompt from the next Hermes session.

What an active harness gets no copy of is said once per `skilletor sync`, as a note:

```
skilletor: note: 2 agent(s) and 1 rule(s) not installed for Hermes (Hermes has no agent files and no rules directory)
```

**Project skills need the project trusted.** Hermes loads `<project>/.hermes/skills` and
`<project>/.agents/skills` only from a project root listed in `skills.trusted_project_dirs`
— run `hermes skills trust` in the project once. skilletor does not touch that list.

**With Codex in the same project, Hermes reads the Codex copy.** Hermes reads
`<project>/.agents/skills` too, where the Codex copy of a project skill lives, and refuses
to load a name it finds in both directories. So while `codex` is an active target of a
project, skilletor installs no second copy under `.hermes/skills` there (and removes one it
installed before); the note says so. That copy is rendered with `harness == "codex"`.

### The Hermes home

User-scope skills go to one Hermes home. Which one:

1. `$HERMES_HOME`, when the run has it — the plugin passes the session's;
2. else the home the last sync ran under (skilletor remembers it in
   `~/.claude/skilletor/hermes-home.json` when it is not the default);
3. else the default Hermes itself uses: `~/.hermes`; on native Windows
   `%LOCALAPPDATA%\hermes`, as in Hermes (the Hermes support is tested on Linux only).

So a Hermes started with a home of its own (a service unit, a development home) is served
by every later sync, also by the one a Claude Code or Codex session start runs: you need
the plugin below only where Hermes is the one harness that runs. A sync under **another**
home moves the skills: it deletes what skilletor installed in the old home and installs
in the new one, and warns once. One home at a time — two Hermes profiles that both enable
the plugin move the user-scope skills back and forth; enable it in one.

### The plugin under Hermes

`hermes/skilletor/` in this repository is a native Hermes plugin. It runs the same two
hooks as under Claude Code — a sync when a session starts, the throttled check on each
later turn — and gives the report to the model with the turn (Hermes appends it to the
user message). Hermes has no `CwdChanged`; a terminal `cd` does not move the session, but
`/worktree new` and a gateway's re-anchor do, between turns, and the next turn syncs the
checkout the session moved into before the model is called. A new worktree is a project Hermes
does not trust yet, so when skills landed there the report names `hermes skills trust <dir>` as
possibly needed. Install it with Hermes:

```bash
hermes plugins install Getty/skilletor/hermes/skilletor --enable
```

Hermes clones only that directory of this repository into `$HERMES_HOME/plugins/skilletor`
and enables it (without `--enable` it asks, or — not on a terminal — leaves it disabled:
`hermes plugins enable skilletor`). `hermes plugins update skilletor` fetches it again
(`hermes plugins check-updates` calls such a one-directory install "drift" and cannot tell),
`hermes plugins remove skilletor` takes it out. It is a custom source to Hermes, not a
catalog entry, so Hermes says "custom (unreviewed) source"; its install-time scan passes it.

**The plugin needs the CLI**, which it does not bring: `$SKILLETOR_BIN`, else the getty-bun
starter of a skilletor checkout it is linked into (`sh`, on Windows `powershell.exe -File`),
else `skilletor` on `PATH`; without one it does nothing. Once per Hermes process its first
hook starts the starter's `ensure` in the background (up to 600 seconds), so the first start can
install Bun while each hook keeps its own short limit; until that is done, session starts and
prompts deliver nothing, and after a failure the next session start tries again ([Which engine runs](#which-engine-runs)).
[`install.sh`](#from-the-command-line) places a `skilletor` command in `~/.local/bin`. Hermes reads `$HERMES_HOME/.env` into
its environment, so name the CLI there once:

```bash
curl -fsSL https://raw.githubusercontent.com/Getty/skilletor/main/install.sh | sh
echo "SKILLETOR_BIN=$HOME/.local/bin/skilletor" >> "${HERMES_HOME:-$HOME/.hermes}/.env"
```

— or leave `.env` alone when `~/.local/bin` is on the `PATH` Hermes starts with. Your own
clone works the same way: `SKILLETOR_BIN=$HOME/src/skilletor/bin/skilletor`, or a symlink
(`ln -s ~/src/skilletor/bin/skilletor ~/.local/bin/skilletor`).

Run `install.sh` again (or `git pull` your clone) to update the CLI; the plugin and the CLI
are updated separately.

Or install it by hand, as a link into that clone — then the plugin runs the clone's
`bin/skilletor` itself and a `git pull` updates both:

```bash
ln -s ~/src/skilletor/hermes/skilletor "${HERMES_HOME:-$HOME/.hermes}/plugins/skilletor"
```

and enable it in `$HERMES_HOME/config.yaml` (plugins are opt-in; do not copy a second
`plugins:` key into a file that has one):

```yaml
plugins:
  enabled:
    - skilletor
```

`hermes plugins list` shows it; `hermes skilletor status` (any CLI command after
`hermes skilletor`) runs the CLI with that Hermes' home as `HERMES_HOME`.

The plugin never holds a session up for long and never fails one: it gives the sync at a
session start 20 s and each turn's hook 25 s (room for a move's sync; otherwise the hook
returns at once), and without a CLI, on an error or at the limit the turn simply runs
without a message. A delegated subagent triggers nothing.

### What is missing

- **Rules.** Not delivered to Hermes yet. In a project where `codex` is a target too,
  Hermes reads the pointer skilletor puts into `AGENTS.md` for Codex and finds
  `.codex/skilletor-rules.md` through it — unless a `.hermes.md` shadows `AGENTS.md`.
- **Agents.** No counterpart in Hermes.
- **Several Hermes homes side by side** (see [the Hermes home](#the-hermes-home)).
- **No look at Hermes' other skills.** If a bundled or hub skill of that Hermes home
  already has the name (in `skills/<category>/<name>/`), Hermes calls the name ambiguous:
  the other skill stays reachable as `<category>/<name>`, the one skilletor installed does
  not load. Rename or remove one. The [`path` example](#skills-elsewhere-path) source,
  `NousResearch/hermes-agent`, is exactly that case: its skills are the ones Hermes already
  ships, so it is a source for Claude Code and Codex — on a machine whose `targets` names
  `hermes`, its skills land next to Hermes' own copies and none of them loads.
- No entry in Hermes' plugin catalog, and the plugin bundles neither the CLI nor the
  `skilletor` skill — install that like any other skill.

## Security & trust

**Trust means code execution** — Nunjucks is not a sandbox, so a source can run code when
rendered. This is the same trust level as installing a plugin.

- Adding a source with `skilletor add` (or your own user config) trusts it.
- A source that appears **only** in a project config (a cloned repo) is never fetched
  until you run `skilletor trust <name>`; each session start names it until then. Trust
  is stored for the backend actually used — kind and address, a `local` path as its real
  path — so it lapses when the project changes the address or the backend in use switches
  (say, a project adds a `local` directory to a source you trusted by its git URL).
- Trust does not cover a git `ref`, so a `git` address or `ref` that starts with `-`, and a
  `ref` with whitespace, control characters or `~ ^ : ? * [ \`, `..` or `@{`, is a config
  error: nothing syncs, and the session start names the file and the source.
- Nor does it cover a source's `path`: a project may change which directories of a trusted
  source are scanned. A `path` cannot leave the source (absolute, `..` and symlinks are
  refused).
- A project cannot change what your user-scope items are built from: those resolve
  against your user config's sources alone. A project field merged into one of your
  sources (a `local` path, say) counts as the project's and needs its own trust; your
  own `local` override (author mode) stays trusted.
- What a config, a source or git's output puts into a report — a source name, an address,
  an error — shows control characters, terminal escapes and Unicode bidi overrides escaped
  (`\u001b`, `\u202e`, a newline as `\n`), in the hook's session context and on the CLI
  alike, so it cannot recolor, move or hide text in your terminal or in the model's context.
- Fixed target directories per harness; item names, tar entries and includes may not escape the
  source or target root; symlinks in sources are rejected; `url` is HTTPS-only.
- skilletor never writes or deletes through a linked skill directory or item file: a link
  there is a conflict, and any conflict blocks the whole item. `--force` replaces the link
  itself and leaves its target alone. A `~/.claude/skills` or `~/.claude/agents` linked
  into your dotfiles works as before. A directory where an item has a file is never
  deleted, `--force` or not: move or remove it yourself.

## Coming from manage-skills

[manage-skills](https://github.com/Getty/manage-skills) hardlinks a single source-of-truth
file into each project. skilletor installs **build artifacts** (rendered per instance) from remote sources and keeps them
current automatically. Use skilletor when you want templated, auto-updating items from a
shared remote; manage-skills remains for hardlinked local sharing.

## CLI reference

```
skilletor add [name] <spec> [--project]   # add a source (resolves shorthand, trusts it), then sync
skilletor source list [--json] | source remove <name> [--project] [--force]   # --force: even with installed items
skilletor available [source] [--json]     # catalog of trusted sources
skilletor install <item>... [--project]   # name@source (type:name@source if ambiguous), then sync
skilletor install 'rule:*@shared' [--project]   # wildcard: every rule of the source (type prefix required)
skilletor install 'skill:perl-*@shared'   # name pattern: every skill whose name matches
skilletor install bundle:perl@shared      # a bundle; offers to add sources it needs (terminal only)
skilletor uninstall <item>... [--project] # [type:]name@source (no type: every list); wildcards, bundle: as written
skilletor sync | check | status           # --scope user|project|all, --json, --project-dir <dir>
skilletor sync --force                    # overwrite and adopt unmanaged files reported as conflicts
skilletor trust <source>
```

`check` writes nothing and exits non-zero when a sync is due: a source moved since the last
sync read it (or now points at another URL or ref), or what is installed no longer matches
the config (an item added or removed, a pin changed, a target switched, the last sync
stopped midway), or the vars changed since the last sync rendered with them (in a project
also its git remote; the first check after upgrading counts once). What the last sync could
not install although its source was there (an item the source lacks, a conflict) does not
count again until a sync runs anyway – also when nothing of that source got installed.
`--project-dir` goes with every command; any other option a command does not list is an
error (exit 2, nothing runs). A config error (no harness detected, say) stops `sync` with
exit 2, nothing changed; `add`, `install`, `uninstall` and `source remove` exit 2 too when
the sync they run after their edit hits one — the edit itself is saved and stays, and the
message names the config file. `source remove` of a name the target config (user, or project
with `--project`) does not declare exits 1 and changes nothing, `--force` or not; the error
names where else it is declared (the other config, `skilletor.local.json`), if anywhere. It
removes a source whose entry config load refuses (an `http://` url, a hand-written
`"ref": ""`) when that entry is all the config load refuses; any other config error stops
it (exit 1, nothing changed). Nor does it remove the entry giving a source its only `git`,
`url` or `local` while another config file keeps an entry for that source without one (exit
1, nothing changed, `--force` or not): the error names those files and how to remove them.
`-h`/`--help` anywhere prints the usage and runs nothing (`sync --help` does not sync);
`-v`/`--version` only as the first argument.

Every command that fetches sources — `sync`, `available`, `install`, and the sync that
`add`, `uninstall` and `source remove` run — shares one lock with the hooks, so two runs
never write the source cache or your items at once. While another skilletor run holds it
(a session's sync, say), a command waits up to 5 s, then stops with `timed out acquiring
sync lock at <dir>`; run it again.

## Develop

The engine is TypeScript in `src/`, run on Bun. Its bundle, `dist/skilletor.js`, is committed,
so a checkout runs without `bun install`, and every change to `src/` ships with a rebuilt
bundle (CI rebuilds it with the pinned Bun and compares the bytes). The design spec is
[docs/superpowers/specs/2026-09-22-skilletor-design.md](docs/superpowers/specs/2026-09-22-skilletor-design.md);
the release steps are in [docs/release.md](docs/release.md). The Perl port that once lived at
the root (CPAN `Skilletor`, last release 0.009000, a set of stubs) is gone from the tree and
stays in the history.

Build and test, with the Bun version in `package.json` (`gettyBun.bunVersion`):

```bash
bun install --frozen-lockfile
bun run typecheck && bun run test && bun run build && bun run check-dist
bun run check-starters    # bootstrap/ and skills/getty-bun-install/ against a fresh render
```

`bootstrap/getty-bun.sh` and `.ps1` are never edited by hand: `.claude/skilletor.json` renders
`getty-bun-install@agent-bun-runtime` into `skills/getty-bun-install/` (`"into": "plugin"`),
and `bootstrap/` holds copies of its two starters. A Bun bump changes `vars.bun_version` there
and `gettyBun.bunVersion` in `package.json`, then syncs, copies the starters and rebuilds
`dist/` in one commit.

A CLI run from a checkout acts on your real `~/.claude`, Codex home and Hermes home, and on the
project of the current directory (its git top level: in a checkout, the checkout itself). For
a hand test, set a temporary `HOME`, `CODEX_HOME` and `GETTY_HOME`, unset `CLAUDE_CONFIG_DIR` and
`HERMES_HOME`, and run it from a temporary directory, or with `--project-dir` pointing at one.

`conformance/` holds cases the engine must pass: configs and source trees, plus the expected
resolution and, for sync cases, the files, lock, check and status they should produce.
`test/conformance.test.ts` runs them, and
`SKILLETOR_CONFORMANCE_UPDATE=1 bun run test` regenerates them from TypeScript, to be reviewed by
hand.

## License

Artistic License 2.0 from 0.008000 (plugin 0.8.0) on; the plugin releases up to 0.7.0 were MIT,
the Perl dist's 0.001 on CPAN Perl 5. See [LICENSE](LICENSE).
