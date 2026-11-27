# skilletor

Claude Code plugin + CLI that installs skills, agents and rules from remote
sources. Design: `docs/superpowers/specs/2026-09-22-skilletor-design.md`.
Build/test: `npm run typecheck && npm test && npm run build && npm run check-dist`.

`conformance/` holds cases that `test/conformance.test.ts` runs. A change to sync or resolve
behaviour updates the cases (`SKILLETOR_CONFORMANCE_UPDATE=1`, then hand-review them).

## Delegation

The main agent delegates behavior-relevant code and skill text to the right agent instead of
touching it itself (the `skilletor-*` agents work their own lane) — the principle is a
shared house rule (skilletor bundle `getty-house@getty`); lanes and hazards are in
`.claude/rules/skilletor-rules.md`.

| Task | Agent |
|---|---|
| Implement / refactor / debug the engine, tests, hooks, build | `skilletor-worker` (default) |
| Judge quality or strength of a skill, agent, rule, source, eval | `skilletor-skill-auditor` |
| Write, rework, shrink or merge a skill, agent, rule, `.njk` item | `skilletor-skill-author` |
| Commits, `Changes`, card → done, pre-release audit | `skilletor-release-manager` |

The agents carry their skills via `skills:` (see `.claude/agents/`);
the main agent delegates rather than loading them. Project skills live under
`.claude/skills/`: `skilletor-core` and `skill-assessment` are this repo's own;
the shared ones (authoring, commit style, karr) are installed by skilletor from
`.claude/skilletor.json` and not tracked. Tickets: `karr board`.
