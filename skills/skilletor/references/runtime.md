# skilletor's runtime — Bun through the getty-bun starter

## How skilletor starts

Every hook and every CLI call runs the plugin's starter with the bundle:
`sh <plugin root>/bootstrap/getty-bun.sh run dist/skilletor.js <args>` (`bin/skilletor` and
`install.sh`'s command do exactly this). `<plugin root>` is two directories above the
skill's base directory (the one holding its `SKILL.md`, shown when the skill loads):
`…/skilletor/<version>/skills/skilletor` → `…/skilletor/<version>`. The starter installs
the Bun version pinned in it into `<GETTY_HOME>/runtimes/bun/<version>/<target>/` (`GETTY_HOME` defaults to `~/.getty`), one
slot shared by every plugin pinned to that version. Node, Perl and any Bun on `PATH` play no
part.

- The first hook after an install or update downloads Bun: a slow first session start is
  that, not a hang (hook timeout 600 s; waiting for another process's install up to
  `GETTY_BUN_LOCK_WAIT`, default 300 s).
- Hook lines are `hook <event> claude-code|codex|hermes`; `--harness <host>` is the
  deprecated spelling, still accepted. An update that changes the hook lines needs Codex
  users to trust them again in `/hooks` — until then Codex runs no skilletor hook.

| Platform | Works | Not supported |
|---|---|---|
| Linux, WSL | Claude Code, Codex, Hermes, the CLI | — |
| Windows | Codex hooks (`commandWindows`: the `.ps1` starter); Hermes hooks from a checkout | Claude Code; `install.sh`; the CLI with options (`--project`, `--json`, …) through `getty-bun.ps1` — they are not passed safely |
| macOS, Alpine (musl), Windows on ARM | — | everything: `getty-bun: unsupported target …` |

## A line starting `getty-bun: `

It comes from the starter (exit 1), before skilletor ran — skilletor's own lines start
`skilletor:`. Reproduce, then act on `state`:

```sh
sh <plugin root>/bootstrap/getty-bun.sh status   # one JSON line, installs nothing
sh <plugin root>/bootstrap/getty-bun.sh ensure   # installs the pinned Bun if missing; silent on success
```

Windows: `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
"<plugin root>\bootstrap\getty-bun.ps1" status` (keep the quotes).

**The CLI on native Windows:** `bin/skilletor` is `sh`; call the `.ps1` starter instead —
`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
"<plugin root>\bootstrap\getty-bun.ps1" run dist/skilletor.js sync` (`status`, `check` the
same way). No options: an argument beginning with `-` is not passed safely.

| `state` | Meaning | Next step |
|---|---|---|
| `ready` | Bun is installed | The failure is skilletor's: run the hook line or `skilletor sync` by hand. `run` ends with exit 126 (or a crash) and no `getty-bun: ` line: a damaged `bun` in the slot — same repair as `mismatch` |
| `missing` | no slot yet | `ensure`; on failure report its `getty-bun: ` line verbatim |
| `mismatch` | something at the slot path is not this pin's install; every run fails closed | report the `slot` path; removing that directory, then `ensure`, is the repair — other plugins share the slot, so the user decides. Never patch it in place |

Exit 1 instead of JSON: read its `getty-bun: ` line — `GETTY_HOME` or `HOME` not absolute,
`GETTY_BUN_LOCK_WAIT` not a whole number of seconds, under Git Bash/MSYS/Cygwin no `cygpath`,
no `getty-bun.ps1` beside the `.sh` or no PowerShell, or an unsupported target (table above).

- **`download of … failed (<curl|wget> exit N)`** — offline, proxy, GitHub blocked (curl
  exit 6: host not resolved, typical behind a proxy that is not set). See "Proxy, mirror,
  air-gapped" below.
- **`timed out after N s waiting for the install lock`** — another install of the same slot,
  usually right after a plugin install or update: wait and retry. Never delete the lock.
- **`checksum mismatch`, `version mismatch`** — a proxy or mirror serves another file. Fix
  the source, never the pin.
- **`<tool> not found on PATH`** — installing needs `curl` or `wget`, `unzip`, `sha256sum` or
  `shasum`, `flock` and `mktemp`; running a ready slot needs none.
- **Windows, PowerShell refuses the script** — the hook line already passes
  `-ExecutionPolicy Bypass`; a policy set by Group Policy overrides it, and AppLocker, WDAC
  or antivirus can block it too. Report the error text; change no policy or security
  setting.
- **Works by hand, not in the host** — compare `GETTY_HOME` and `HOME` (Windows:
  `%USERPROFILE%`) of your shell and the host. Codex hides a failed start hook's stderr:
  run its hook line by hand to see the line.

## Proxy, mirror, air-gapped

Network is needed only while a slot is `missing`: the first run after an install, and again
after an update that changes the Bun pin. A `ready` slot never downloads, so **one
successful `ensure` from a shell with the right environment is enough** — the variables
below need not reach the host's hook process. Run it, check `status` says `ready`, restart
the session.

- **Proxy.** The starter downloads with `curl -q` (else `wget --no-config`): `~/.curlrc`
  and wgetrc are ignored, the proxy comes from the environment only — `https_proxy` (curl
  also reads `HTTPS_PROXY`; wget only the lowercase one) and `no_proxy`. Example:
  `https_proxy=http://proxy.corp:3128 sh <plugin root>/bootstrap/getty-bun.sh ensure`
  (credentials go in the URL: `http://user:pass@proxy.corp:3128`). A proxy that re-signs
  TLS needs its CA: curl takes `CURL_CA_BUNDLE` or `SSL_CERT_FILE` from the environment
  (curl exit 60 is that failure); wget has no such variable without its rc file — use the
  mirror.
  Windows: the `.ps1` starter downloads with .NET; getty-bun documents no proxy handling for
  it — use the mirror. Proxies are not tested by getty-bun.
- **Mirror.** `GETTY_BUN_MIRROR` replaces `https://github.com/oven-sh/bun/releases/download`
  in the URL `<base>/bun-v<version>/<archive>`, base without a trailing `/`. `<version>`
  is the `# version` line of the starter's pin block, `<archive>` the second field of its
  `# target <target> <archive> <sha256> <member>` line for the `target` `status` prints
  (`bun-linux-x64-baseline.zip`, …). The archive must be byte-identical to Bun's release:
  the pinned SHA256 decides. Schemes: curl `http`, `https`, `file`; wget no `file`.
- **Air-gapped.** Copy the archive in, place it at `<dir>/bun-v<version>/<archive>`, then
  `GETTY_BUN_MIRROR=file://<dir> sh <plugin root>/bootstrap/getty-bun.sh ensure` (needs
  curl). Copying a slot directory from another machine is not a documented getty-bun
  route — use the `file://` mirror; the slot lives at the `slot` path `status` prints.

Slot layout, every variable, the entry's `agent-bun-runtime: ` lines and the repair in full:
skill `getty-bun` (source `Getty/agent-bun-runtime`, `path` `skills`), if installed.
