# skilletor

Claude Code plugin + CLI that installs skills, agents and rules from remote
sources. Design: `docs/superpowers/specs/2026-09-22-skilletor-design.md`.
Build/test: `npm run typecheck && npm test && npm run build && npm run check-dist`.

## Delegation

Delegate behavior-relevant code and skill text to the right agent instead of
touching it yourself — principle and lane are in `.claude/rules/skilletor-rules.md`.

| Task | Agent |
|---|---|
| Implement / refactor / debug the engine, tests, hooks, build | `skilletor-worker` (default) |
| Judge quality or strength of a skill, agent, rule, source, eval | `skilletor-skill-auditor` |
| Write, rework, shrink or merge a skill, agent, rule, `.njk` item | `skilletor-skill-author` |
| Pre-release audit | `skilletor-release-checker` |

The agents carry their skills via `briefing.skills` (see `.claude/agents/`);
the main agent delegates rather than loading them. Project skills live under
`.claude/skills/` (`skilletor-core`, `skill-assessment`,
`kanban-issues-karr-cli`); the shared authoring
skills come from `~/.claude/skills/`. Tickets: `karr board`.
