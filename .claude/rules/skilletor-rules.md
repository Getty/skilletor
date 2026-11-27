# skilletor House Rules

The shared house rules come from skilletor — bundle `getty-house@getty`: engineering
discipline, the delegation lock, the publish gate, karr coordination. They load as
`.claude/rules/.local.*.md`; if they are missing, run `skilletor sync` and publish nothing
until they load. This file adds what is true only here, and wins where it differs.

## What this repo is

The Claude Code plugin + CLI that installs skills, agents and rules from remote sources; its
payload is other people's skills (architecture: skill `skilletor-core`). Public artifacts —
code, comments, docs, skills — are English. Read first: exports, immediate callers,
`EngineContext`, and the spec section the module implements.

## Agent team

| Task | Agent |
|---|---|
| Implement / refactor / debug `src/`, `test/`, hooks, build, plugin wiring | `skilletor-worker` (default) |
| Judge quality or strength of a skill, agent, rule, source or eval result | `skilletor-skill-auditor` |
| Write, rework, shrink or merge a SKILL.md, agent, rule or `.njk` item | `skilletor-skill-author` |
| Commits, `Changes`, card → done, pre-release audit | `skilletor-release-manager` |
| Read-only research, audit, gap analysis | `skilletor-worker` ("read-only, change nothing") |

Behavior-relevant = anything under `src/`, `test/`, `hooks/`, `bin/`, `bootstrap/`, `dist/`,
`scripts/`, `hermes/`, `.cicd/`, `.github/workflows/`, `install.sh`, `package.json`, `bun.lock`, the
plugin manifests, and the text of any skill, agent or rule file (this repo's `.claude/` set and
`skills/`). `README.md`, `docs/` and ticket notes are not.

## Release

`bun run test`, `bun run build`, `bun run check-dist` are fine anytime. Any edit to
`Getty/marketplace` is under the publish gate too, like `git tag`, a push and `gh release`.
CI: SimpiCI runs `.cicd/` (suite and `check-starters`, image `oven/bun:<pin>`) on every push;
`.github/` changes are pushed from the maintainer's side, never with the deploy key.

## Hazards

- **`bun run test` is the check that counts** — `tsc` checks types only. A mocked builtin
  reaches only code that calls it through the module object (`import fs from "node:fs"`,
  `fs.readFileSync(…)`): Bun ignores `syncBuiltinESMExports`, named imports keep the original.
- **`dist/` is committed and CI diffs it** — every `src/` change ships with a rebuilt
  `dist/skilletor.js` in the same commit; `check-dist` refuses a Bun other than the pin.
- **`bootstrap/` and `skills/getty-bun-install/` are rendered, never hand-edited** — a starter
  bug is a ticket on agent-bun-runtime's board. Re-render (`skilletor trust agent-bun-runtime`,
  then `skilletor sync --scope project`), copy
  `skills/getty-bun-install/bootstrap/*` to `bootstrap/`, then `bun run check-starters` must pass. It writes the project's `.claude/`: run it in a fresh
  clone or let SimpiCI run it, never in a working checkout.
- **A Bun bump is one commit:** `.claude/skilletor.json` `vars.bun_version`, `package.json`
  `gettyBun.bunVersion`, the version in `README.md`, renamed `.cicd/` job files (the image tag is
  in the name), re-render, copy, rebuilt `dist/`. A Bun missing from the version table of the
  pinned agent-bun-runtime release also moves that source's `ref` in `.claude/skilletor.json` —
  else the render fails with `vars_bun_version_is_missing_or_not_in_the_getty_bun_install_version_table`.
- **The starter exits 1** (one `getty-bun:` line) when the pinned Bun is missing and cannot be
  fetched; the hook's "always exit 0" holds only once skilletor runs. A changed hook line makes
  Codex users re-approve the hook.
- **The CLI writes to the real home and this repo** — hand tests use a temp cwd with temp `HOME`,
  `CODEX_HOME` and `GETTY_HOME`.
- **Agent files: `tools:`, not `allowed-tools`** — Claude Code ignores unknown agent fields
  silently, so a misnamed key hands an auditor write access.
- **Eval runs are billed** (`claude plugin eval` spawns full sessions) — start one only when the
  ticket or the user asks.
