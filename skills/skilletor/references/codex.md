# skilletor for Codex — targets, agents, AGENTS.md

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
- `briefing.skills` is not written for Codex (it ignores an agent file with unknown keys);
  the report notes how many agents lost it.
- No `description` → not written for Codex, warning. Blank body → skipped for Codex.
- Project agents in `<repo>/.codex/agents/` load only in a project Codex trusts.

## Rules → the `AGENTS.md` block

All Codex rules of a scope go into one block in `$CODEX_HOME/AGENTS.md` (user) or
`<repo>/AGENTS.md` (project), one section per rule, sorted by name. A `paths:` frontmatter
becomes a leading "Applies when working with files matching: …" line.

- Text outside `<!-- skilletor:begin -->` … `<!-- skilletor:end -->` is never modified.
  A section edited or deleted by hand is restored and reported as overwritten.
- Refused (warning, nothing written for Codex rules in that scope, `--force` does not help):
  malformed markers (`begin` without `end`, `end` first, either twice), or `AGENTS.md` is a
  symlink (e.g. to `CLAUDE.md`), a directory or unreadable, or — with Claude also a target —
  a `CLAUDE.md` Claude reads is that same file (`CLAUDE.md`/`.claude/CLAUDE.md` in the
  project, `~/.claude/CLAUDE.md` for the user file), since Claude would see each rule twice.
- Warnings: an `AGENTS.override.md` beside it (Codex reads that instead); a project
  `AGENTS.md` over Codex's `project_doc_max_bytes` (default 32768 — the block is cut).
- `AGENTS.md` is not gitignored: a project's Codex rules show in its diff. Opt a project
  out with `"targets": ["claude"]`, or use user-scope rules for machine-specific text.
