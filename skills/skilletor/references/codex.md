# skilletor for Codex — targets, agents, rules, hook trust

## Which harnesses (`targets`)

Without `targets`, skilletor installs for every harness it detects, by files the harness
itself creates (never `~/.claude/` alone — skilletor's config lives there):

| Harness | Detected when any exists |
|---|---|
| `claude` | `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/projects/` |
| `codex` | in `$CODEX_HOME` (default `~/.codex`): `config.toml`, `auth.json`, `sessions/`, `installation_id` |

- Machine set = user `targets` if set, else detected. Empty → `sync`/`check`/`status` fail
  with a config error naming the markers; nothing is touched. Fix: set `targets` in
  `~/.claude/skilletor.json`.
- User scope installs for the machine set. Project scope: the machine set narrowed by
  `skilletor.local.json` `targets`, else `skilletor.json` `targets`. A project never adds
  a harness; an empty intersection installs nothing for the project and warns.
- Detection re-runs every sync: a harness that disappears has its items removed. Pin
  `targets` to prevent that. Config, lock and state stay under `.claude/` for both harnesses.

## Agents → Codex agent-role TOML

The agent Markdown is rendered with `harness` = `codex` and converted: `name` and
`description` from the frontmatter, the body becomes `developer_instructions`. An optional
`codex:` mapping passes through as top-level TOML keys and overrides those:

```yaml
---
name: reviewer
description: Reviews diffs for correctness.
model: sonnet            # Claude only
codex:
  model_reasoning_effort: high
  sandbox_mode: read-only
---
```

- Claude-only keys (`model`, `tools`, `allowed-tools`, `color`, …) are not carried over and
  not reported. Put Codex values under `codex:`.
- `codex:` values: strings, numbers, booleans, string arrays, one level of tables. Anything
  else is dropped with a warning. Codex validates the values and ignores the whole role on
  a bad one.
- `briefing.skills` becomes the comment line `# briefing: skills = ["a", "b"]` before
  `developer_instructions` (read by briefing 0.3.1+; Codex drops a role with unknown keys,
  so never a `[briefing]` table). `briefing` under `codex:`, or a skill name that is empty
  or holds `"`, `\`, `]` or a line break, is a conversion error for the Codex copy.
- No `description` → not written for Codex, warning. Blank body → skipped for Codex.
- Project agents in `<repo>/.codex/agents/` load only in a project Codex trusts.

## Rules → rules file, hook, `AGENTS.md` pointer

All Codex rules of a scope go into one rules file, wholly skilletor's:
`$CODEX_HOME/skilletor-rules.md` (user) or `<repo>/.codex/skilletor-rules.md` (project),
one section per rule, sorted by name. A `paths:` frontmatter becomes a leading "Applies when
working with files matching: …" line. The file exists exactly while the scope has a Codex
rule; a section edited or deleted by hand is restored and reported as overwritten
(`.codex/skilletor-rules.md#rules/<name>`).

- **Delivery:** the Codex `SessionStart` hook puts the user, then the project rules file at
  the start of the context on `startup` and `clear` — from disk, so also after a failed
  sync. Not on `resume` (the first copy is still in the history). Rules missing from your
  context → read the rules file named in `AGENTS.md`.
- **Pointer:** `$CODEX_HOME/AGENTS.md` / `<repo>/AGENTS.md` hold only a fixed block
  between `<!-- skilletor:begin -->` and `<!-- skilletor:end -->` pointing at the rules
  file; text outside it is never modified. It changes only when the scope's first Codex
  rule appears or its last goes.
- Pointer refused (warning, `AGENTS.md` untouched, `--force` does not help; the rules file
  and hook delivery still work): malformed markers (`begin` without `end`, `end` first,
  either twice), or `AGENTS.md` is a symlink (e.g. to `CLAUDE.md`), a directory or
  unreadable, or — with Claude also a target — a `CLAUDE.md` Claude reads is that same file
  (`CLAUDE.md`/`.claude/CLAUDE.md` in the project, `~/.claude/CLAUDE.md` for the user file).
- Pointer warnings: an `AGENTS.override.md` beside it (Codex reads that instead); a project
  `AGENTS.md` over Codex's `project_doc_max_bytes` (default 32768 — the pointer is cut).
- Git: `.codex/.gitignore` holds the fixed block `agents/**/.local.*`, `skilletor-rules.md`
  while `.codex` has managed agents or the rules file (unless `"gitignore": false`); only
  the pointer shows in the diff. Codex skills carry their own `.gitignore`, so `.agents`
  gets no block (an older one is removed). An older skilletor's rule
  sections in `AGENTS.md` are replaced by the pointer on the next sync (rules reported as
  updated, not overwritten).

## Hook trust

Codex runs plugin hooks only after the user trusts them in `/hooks`, and skips them
silently until then — no syncs, no rules. While Codex is a machine target and
`$CODEX_HOME/config.toml` has no trust entry for skilletor's `SessionStart` hook, `sync`
and `status` warn once per run; with `--json` that is the top-level `warnings` array
(absent when empty). A plugin update that changes the hook needs trusting again in
`/hooks` — skilletor cannot see that case.
