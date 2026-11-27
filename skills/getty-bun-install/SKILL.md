---
name: getty-bun-install
description: "Use when putting the getty-bun starters (getty-bun.sh, getty-bun.ps1) into an agent plugin or tool, wiring its Claude Code or Codex hooks through them, setting or bumping vars.bun_version, or when a plugin's bootstrap/getty-bun.* differs from a fresh render."
---

# getty-bun-install

This skill is a skilletor template. Rendered, its directory holds the two getty-bun
starters pinned to the consumer's `vars.bun_version`:

```
bootstrap/getty-bun.sh    POSIX sh starter (Linux; under Git Bash it forwards to the .ps1)
bootstrap/getty-bun.ps1   Windows PowerShell 5.1 / 7 starter
```

Each carries one pin block: the Bun version and the SHA256 per target, from the version
table of the agent-bun-runtime release this skill came from. skilletor renders only into
this skill's own directory, so the plugin gets the starters by copy, and its CI checks the
copy. Using the runtime afterwards (status, troubleshooting): skill `getty-bun`. Building
the entry on `@getty/agent-bun-runtime`: skill `getty-bun-integration`.

## 1. Pin the version

In the plugin's `.claude/skilletor.json` (project scope):

```json
{
  "sources": {
    "agent-bun-runtime": {
      "git": "https://github.com/Getty/agent-bun-runtime",
      "ref": "v0.1.0",
      "path": "skills"
    }
  },
  "vars": { "bun_version": "1.4.5" },
  "install": { "skills": ["getty-bun-install@agent-bun-runtime"] }
}
```

- `vars.bun_version` has no default: a plugin pins explicitly. Missing, or a version the
  template's table does not carry, fails the render with
  `Unable to call vars_bun_version_is_missing_or_not_in_the_getty_bun_install_version_table`.
  Fix the var or move `ref` to a release whose table has that version; never edit a pin
  block by hand.
- `ref` pins skill and SDK together: use the tag of the `@getty/agent-bun-runtime`
  version in the plugin's `package.json`.
- Keep `gettyBun.bunVersion` in the plugin's `package.json` equal to `vars.bun_version`.

Then `skilletor trust agent-bun-runtime` (a project-declared source renders nothing until
trusted) and `skilletor sync --scope project`. A failed render is a `warning: template
error in skill getty-bun-install` line, and sync still exits 0: it installs nothing, or
keeps the copy rendered before (executed, see the end of section 4). Read the sync output.

## 2. Copy the starters into the plugin

```sh
skill=.claude/skills/getty-bun-install    # the rendered copy (Claude target; others alike)
mkdir -p bootstrap
cp -p "$skill/bootstrap/getty-bun.sh" "$skill/bootstrap/getty-bun.ps1" bootstrap/
```

- The plugin root is the parent of `bootstrap/`: the starters find the entry as
  `<root>/<entry>`, from their own path, never from the working directory.
- Commit both files unchanged, beside the bundled entry (`dist/hook.js` below). Both
  always: the `.sh` forwards to the `.ps1` under Git Bash.
- `cp -p` keeps the mode. The hooks start the starters through `sh` and
  `powershell -File`, so no exec bit is needed.
- Commit a `.gitattributes` with `* text=auto eol=lf` (at least
  `bootstrap/getty-bun.sh` and `bootstrap/getty-bun.ps1 text eol=lf`). Without it, Git for
  Windows with `core.autocrlf=true` checks out a CRLF `getty-bun.sh`: the Git Bash
  forwarding breaks and the `cmp` of section 4 fails. Rule and reasons: skill
  `getty-bun-integration`,
  [paths-platforms.md](../getty-bun-integration/references/paths-platforms.md),
  "Repository hygiene".

## 3. Wire the hooks

Every hook that needs Bun calls a starter with `run <entry> [args...]`. Arguments must not
begin with `-` (Windows parameter binding), and an entry serving both hosts takes the host
from its own argument (`claude-code`, `codex`); the SDK never guesses it.

**Claude Code** (`hooks/hooks.json`), Linux. Shell form:

```json
{ "type": "command",
  "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js claude-code",
  "timeout": 600 }
```

Exec form (Claude Code 2.1.139 or later; no quoting, `sh` resolved on PATH):

```json
{ "type": "command", "command": "sh",
  "args": ["${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh", "run", "dist/hook.js", "claude-code"],
  "timeout": 600 }
```

Windows under Claude Code is an open decision in agent-bun-runtime (`docs/plan.md`,
"Open decisions"): shell form runs Git Bash there, and the `.sh` forwards to the `.ps1`;
without Git Bash the line fails. Claim no Claude Code support on Windows yet.

**Codex** (its own hook file, named by the `hooks` entry of the Codex manifest, because
Claude Code always reads `hooks/hooks.json` and has no `commandWindows`):

```json
{ "type": "command",
  "command": "sh \"${PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js codex",
  "commandWindows": "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${PLUGIN_ROOT}\\bootstrap\\getty-bun.ps1\" run dist/hook.js codex",
  "timeout": 600 }
```

Keep `commandWindows` valid in PowerShell and `cmd` alike: bare `powershell.exe`,
double-quoted paths, no `&`, `$env:` or `%VAR%`.

The hook lines are source-checked against the hosts, not executed under them by this
project yet; the starters themselves are executed in agent-bun-runtime CI.

**Timeout.** Set `timeout` explicitly on every starter hook, above the lock wait
(`GETTY_BUN_LOCK_WAIT`, default 300 s) plus one Bun download (ADR 0007): the first hook
after an install or a Bun bump downloads, and a hook that waited out a crashed installer
downloads itself. `600` leaves 300 s for the download. Host defaults are lower on some
events (Claude Code `UserPromptSubmit`: 30 s). Put no starter call on `SessionEnd` or
Codex `Interrupt`: their budget is seconds.

No separate install hook and no Bun on PATH: the first hook installs, concurrent hooks
wait on the starter's lock.

## 4. Check the copy in CI

The committed starters must equal a fresh render of the pinned version, and the pin must
equal `package.json`. A CI job with skilletor installed (its `install.sh --no-plugin`). A
fresh runner has no `~/.claude`, and skilletor without a detected harness stops with
`no agent harness detected` (exit 2), so the CI job names the target in the user config
first. This line is for the CI job only, and it never replaces an existing file:

```sh
mkdir -p ~/.claude && { [ -e ~/.claude/skilletor.json ] || echo '{"targets":["claude"]}' > ~/.claude/skilletor.json; }
```

Then, in CI and locally:

```sh
skilletor trust agent-bun-runtime
skilletor sync --scope project
cmp bootstrap/getty-bun.sh  .claude/skills/getty-bun-install/bootstrap/getty-bun.sh
cmp bootstrap/getty-bun.ps1 .claude/skills/getty-bun-install/bootstrap/getty-bun.ps1
grep -qx "# version $(jq -r .gettyBun.bunVersion package.json)" bootstrap/getty-bun.sh
```

`cmp` fails when the render failed (a fresh checkout has no rendered copy); the `grep`
catches a stale local copy. Run the second block (`trust`, `sync`, `cmp`, `grep`) before
every commit that touches the starters, the pin or the `ref`; a machine where skilletor
detects a harness needs no user-config line.

Evidence: executed 2026-11-26 on linux-x64 (Linux x86_64), skilletor `3641b4b`
(`dist/skilletor.js`, 0.9.0) run on Bun 1.4.5, `HOME` a temporary directory, the source
declared as `"local": "<agent-bun-runtime checkout>", "path": "skills"` instead of `git`/`ref`:
`skilletor sync --scope project` before `trust` installed nothing and named the `trust`
command; `skilletor trust agent-bun-runtime`, then `sync --scope project`, rendered both
starters, and both `cmp` lines against agent-bun-runtime `bootstrap/` passed for 1.4.5.
With `9.9.9`, sync printed the template error and exited 0, kept the 1.4.5 copy, and on an
empty `.claude/skills` installed nothing. Without the user-config `targets`, sync exited 2
as above. Not executed: the `git` source at a release tag, the `grep` line, and the job in a
consumer's CI.

## Bumping Bun

One plugin release: set `vars.bun_version` (and `ref`, if the version comes with a newer
agent-bun-runtime release) and `gettyBun.bunVersion`, sync, copy both starters, rebuild the
bundled entry with that Bun, commit together. The new slot installs beside the old one on
the first hook. Codex asks for a new hook review when a plugin's bundled scripts change
(documented, not executed).
