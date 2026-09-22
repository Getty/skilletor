# skilletor House Rules

Apply to every task in this repository unless explicitly overridden. Bias:
caution over speed on non-trivial work. Loaded automatically at launch (same
priority as `CLAUDE.md`). Subagents get their discipline from the skills
force-loaded via `briefing.skills` — this file is for the orchestrating agent.

## What this repo is

The Claude Code plugin + CLI that installs skills, agents and rules from remote
sources. Its payload is other people's skills, so two kinds of work meet here:
TypeScript on the engine, and authoring/assessing the skill-shaped files it
ships and syncs. Public artifacts — code, comments, docs, skills — are English.

## Engineering discipline

1. **Think before coding** — state assumptions; when uncertain, ask rather
   than guess; push back when a simpler approach exists.
2. **Surgical changes** — touch only what you must; match existing style.
3. **Read before you write** — exports, immediate callers, `EngineContext`,
   and the spec section the module implements.
4. **Tests verify intent** — reproduce a bug before fixing it; leave a
   regression test behind; a test that cannot fail proves nothing.
5. **Fail loud** — "done" is wrong if anything was skipped; "tests pass" is
   wrong if any were skipped.
6. **A red test is a claim before it is a failure** — say what it asserts
   before changing code to satisfy it.

## Delegation

This rule depends on whether the Agent tool is available to you.

- **You can spawn subagents** (orchestrating main agent): do NOT touch
  behavior-relevant code or skill text yourself — delegate. Your lane:
  coordinate, plan, review diffs, run tests, manage git, edit plain prose docs.
  Why: only the `skilletor-*` agents get their skills force-loaded; you get no
  briefing and would edit with too little context.

  | Task | Agent |
  |---|---|
  | Implement / refactor / debug `src/`, `test/`, hooks, build, plugin wiring | `skilletor-worker` (default) |
  | Judge quality or strength of a skill, agent, rule, source or eval result | `skilletor-skill-auditor` |
  | Write, rework, shrink or merge a SKILL.md, agent, rule or `.njk` item | `skilletor-skill-author` |
  | Pre-release audit | `skilletor-release-checker` |

- **You cannot spawn subagents** (you ARE a `skilletor-*` agent): the lock does
  not apply — work per these rules and your briefed skills.

Behavior-relevant = anything under `src/`, `test/`, `hooks/`, `bin/`, `dist/`,
`scripts/`, the plugin manifest, and the text of any skill, agent or rule file
(this repo's `.claude/` set and `skills/skilletor`). `README.md`, `docs/` and
ticket notes are not.

## Coordination — karr board (always in scope)

Git-native kanban in `refs/karr/*`; one board for this repo. `karr board` /
`karr list --compact` for open work, `karr show ID` for detail,
`karr move ID in-progress --claim NAME` to start, `karr handoff` to review.
Serialize board mutations when fanning out: implementation may run in
parallel; collect results, then loop the `karr` writes one after another.

## Release — never without permission

`npm test`, `npm run build`, `npm run check-dist` are fine anytime. `git tag`,
`git push`, `gh release`, and any edit to `Getty/marketplace` are STRICTLY
forbidden without the maintainer's explicit go-ahead — even when a doc lists
release as the next step. Stop and ask.

## Public issues — never act without instruction

GitHub issues on `Getty/skilletor` carry real users' reports under the
maintainer's name. Never list, read, comment, close or create one on your own
initiative; karr is the agent board.

## Hazards

- **A green `tsc` can still crash at runtime.** Tests run `.ts` through Node's
  type-stripping, which rejects non-erasable syntax
  (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`); `npm test` is the check that counts.
- **`dist/` is committed and CI diffs it.** Every `src/` change ships with a
  rebuilt `dist/skilletor.js` in the same commit or CI fails `check-dist`.
- **The CLI writes to the real home.** `bin/skilletor sync` from this checkout
  targets `~/.claude/` via `os.homedir()`; hand tests run with `HOME` pointed
  at a temp directory.
- **Agent files: `tools:`, not `allowed-tools`.** Claude Code ignores unknown
  agent fields silently, so a misnamed key hands an auditor write access.
- **Eval runs are billed** (`claude plugin eval` spawns full sessions). Start
  one only when the ticket or the user asks.
