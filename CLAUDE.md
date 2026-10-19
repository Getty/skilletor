# skilletor

Claude Code plugin + CLI that installs skills, agents and rules from remote
sources. Design: `docs/superpowers/specs/2026-09-22-skilletor-design.md`.
Build/test: `npm run typecheck && npm test && npm run build && npm run check-dist`.

`perl/` is the Perl port (dist `Skilletor`, design notes in `docs/perl.md`). Test it with
`cd perl && PERL5LIB=/home/getty/dev/langertha/lib:$PERL5LIB prove -lr -j4 t`.
TypeScript is the reference. `conformance/` holds cases that both
`test/conformance.test.ts` and `perl/t/60-conformance.t` run. A change to sync or
resolve behaviour updates the cases (`SKILLETOR_CONFORMANCE_UPDATE=1`, then
hand-review them) and the Perl port together, or notes the divergence on the card.
`perl/` counts as behaviour-relevant code, so it is the `skilletor-worker`'s lane.

## Delegation

The main agent delegates behavior-relevant code and skill text to the right agent instead of
touching it itself (the `skilletor-*` agents work their own lane) — principle and
lane are in `.claude/rules/skilletor-rules.md`.

| Task | Agent |
|---|---|
| Implement / refactor / debug the engine, tests, hooks, build | `skilletor-worker` (default) |
| Judge quality or strength of a skill, agent, rule, source, eval | `skilletor-skill-auditor` |
| Write, rework, shrink or merge a skill, agent, rule, `.njk` item | `skilletor-skill-author` |
| Commits, `Changes`, card → done, pre-release audit | `skilletor-release-manager` |

The agents carry their skills via `briefing.skills` (see `.claude/agents/`);
the main agent delegates rather than loading them. Project skills live under
`.claude/skills/`: `skilletor-core` and `skill-assessment` are this repo's own;
the shared ones (authoring, commit style, karr) are installed by skilletor from
`.claude/skilletor.json` and not tracked. Tickets: `karr board`.
