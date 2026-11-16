# Stability and Windows CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository's lane rules override generic agent types and commit instructions: only the release-manager commits; the coordinator serializes board writes.

**Goal:** Complete the five identified stability fixes and add native Windows CI for the currently shipped Node launcher, without claiming Windows success before an observed native run.

**Architecture:** Preserve existing public interfaces and the TypeScript reference/Perl parity model. Reproduce each failure before a minimal fix; divide implementation into four non-overlapping file lanes, then independently review and verify their combined state. Keep release activation and unrelated backlog work outside this batch.

**Tech Stack:** Erasable TypeScript, Node's native test runner, Perl 5.40, Nunjucks/Text::Nunjucks, GitHub Actions and the existing Windows launcher.

**Spec:** `docs/superpowers/specs/2026-09-22-skilletor-design.md`, especially rendering, CLI failures and §8 hooks; acceptance contracts on k151, k160, k192, k193, k194 and k237. The user selected this scope and Sol workers on 2026-11-16.

## Global Constraints

- Scope is exactly k151, k160, k192, k193, k194 and k237. No binary activation, package/version change, push, tag, release or public tracker operation.
- Use the existing team agents with the configured `opus` alias mapping to `gpt-5.6-sol`.
- Main checkout: `fix/stability-windows-ci-2026-11-16`, starting at `6ea1931`. Preserve the unrelated `nytprof.out` and old worktrees/backups.
- Tests and manual CLI probes use temporary working directories, homes and harness paths; never the user's real configuration or credentials.
- Node test execution uses Node 24; the committed bundle retains its existing Node 18 target. Source Perl retains its existing minimum of 5.40.
- Behavioral changes keep TypeScript, Perl and shared expectations aligned. Add shared cases where the fixture model represents the behavior; explicitly record any coverage limitation on the card instead of silently claiming parity.
- Workers do not edit skill/agent/rule text, commit, mutate karr concurrently, or rebuild shared `dist/`. Main coordinates documentation, final build and board handoffs; the release-manager commits only after independent green checks.
- Do not broaden file ownership silently. Report a required cross-lane edit before making it.
- A configured Windows job is not a passed Windows job. k237 needs an observed native run for completion; any required push/run awaits explicit permission.

## Review Focus

1. An included malformed template must not cause a delayed uncaught exception after the original call returns; test the complete subprocess lifetime in Task 1.
2. A removed cwd must neither break an explicit project path nor produce a raw stack trace without one; test both paths in Task 1, including a skill rather than only a rule.
3. A slow source must not leave files without lock ownership when SessionStart exhausts its budget; test files and lock state in Task 2.
4. Reserved object keys must remain ordinary data without inherited-key collisions or prototype mutation; test parser, converter and state round-trips in Task 3.
5. A Windows executable must really run under native Windows with spaces/non-ASCII paths and disposable user/harness roots; test the shipped executable in Task 4, not a substituted POSIX wrapper.

## Task 1: Rendering and removed-cwd recovery — k160, k192, k193

**Owner:** `skilletor-worker`, render/CLI lane.

**Files:** `src/render.ts`, `src/cli.ts`, `test/render.test.ts`, `test/cli.test.ts`; relevant Perl counterparts in `perl/lib/Skilletor/Render.pm`, `perl/lib/Skilletor/CLI.pm`, `perl/t/53-parity-render.t`, `perl/t/68-cli.t`. New focused tests may be added within this lane. Reserve `conformance/cases/241-include-syntax-error/` and `242-removed-cwd/` if representable and not already present.

**Interfaces:** Preserve `build()` and `run(argv: string[]): Promise<number>` and the existing RenderError/CLI error contract. No public API redesign. Other workers own hooks, engine, conversion and state modules.

- [ ] Reproduce the include-syntax crash in a child process; assert a clean warning/error outcome with no delayed uncaught exception and that unaffected work continues.
- [ ] Reproduce a skill installation from a removed cwd with an explicit valid project directory; assert installed contents and lock state, not merely exit status.
- [ ] Reproduce a non-hook CLI invocation without an explicit project directory from a removed cwd; assert exit 1, actionable stderr and no internal stack trace. Use the existing CLI diagnostic convention; report the chosen wording as an implementation choice, not a user requirement.
- [ ] Diagnose the actual render callback/path/context failure boundaries and implement minimal fixes without suppressing unrelated errors.
- [ ] Update Perl behavior where necessary, replace the k160 TODO only after actual parity is demonstrated, and review generated expectations rather than blindly accepting them.
- [ ] Run focused Node and Perl tests; report red/green evidence, changed paths, proposed conformance-index/spec notes and any remaining divergence. Leave commit and shared build to the coordinator/release-manager.

## Task 2: SessionStart write safety — k151

**Owner:** `skilletor-worker`, hook/deadline lane.

**Files:** `src/hooks.ts`, `test/hooks.test.ts`; if required, `src/engine.ts` and `test/engine.test.ts`; Perl `Hooks.pm`/`Engine.pm` and `perl/t/69-hooks.t`/`perl/t/62-engine.t`. Reserve `conformance/cases/240-session-start-deadline/` if the shared model can express it. Do not change `src/cli.ts` or render/CLI tests concurrently.

**Interfaces:** Preserve `runHook(event, givenInput, hookCtx): Promise<HookOutput>` and the existing `EngineContext.deadline` pre-write check. The configured SessionStart hard timeout is 30 seconds; the existing move deadline budget is 20 seconds. Reuse the established budget where suitable rather than introducing a new timing policy without evidence.

- [ ] Trace SessionStart resolution, lock waiting and the existing move deadline to identify the missing budget propagation.
- [ ] Add a failing deterministic regression with a slow/stalled source and an expired or controlled budget; assert that the affected scope has neither partially installed files nor an incomplete ownership lock.
- [ ] Apply a SessionStart deadline safely below the configured hard timeout, preserve a stricter caller-provided budget, and keep existing hook failure-open behavior.
- [ ] Mirror the reference behavior in Perl; add shared coverage where representable or explicitly record why deterministic timing is tested outside the fixture format.
- [ ] Run focused hook/engine tests in both implementations and report the exact deadline semantics plus the required §8 documentation change.

## Task 3: Reserved object keys — k194

**Owner:** `skilletor-worker`, parser/converter/state lane.

**Files:** `src/frontmatter.ts`, `src/convert.ts`, `src/state.ts`, their corresponding `test/*.test.ts`; relevant Perl `Frontmatter.pm`, `Convert.pm`, state counterparts and `perl/t/15-convert.t`, `23-state.t`, `26-state-hooks.t`; `perl/maint/oracle-convert.mjs` and `perl/t/data/convert-oracle.json` if expectations change. Reserve `conformance/cases/243-prototype-key-data/` if useful. Do not edit engine, hooks, CLI or rendering modules owned by other lanes.

**Interfaces:** Preserve `splitFrontmatter`, `parseYamlDocument`, `codexAgentToml` and State's public methods. Own-key semantics are the contract; special keys are data, not inherited members.

- [ ] Add failing tests for YAML `__proto__`, conversion tables named `constructor`/`toString`, and hook-state keys that collide with inherited properties.
- [ ] Assert both the preserved output/round-trip data and the absence of prototype mutation or inherited-key matches.
- [ ] Replace unsafe assignment/membership only at the demonstrated boundaries using established own-key/null-prototype conventions; avoid a whole-repository sweep.
- [ ] Remove the Perl inherited-key compatibility workaround only with corresponding reference behavior and freshly reviewed oracle/shared-case updates.
- [ ] Run focused Node and Perl tests and report red/green evidence plus the exact expected-output changes.

## Task 4: Native Windows CI — k237

**Owner:** `skilletor-worker`, Windows CI lane.

**Files:** `.github/workflows/ci.yml`; new focused tests such as `test/windows-launcher.test.ts` and `test/windows-ci-contract.test.ts`. Existing helper changes require coordination before editing because other lanes use them.

**Interfaces:** Exercise the shipped `bin/skilletor.exe` and the same public `--version`/hook CLI interface users run. Do not replace it with a mocked launcher, activate the prepared Perl starter or silently skip the whole suite.

- [ ] Add an executable contract test that fails while native Windows CI is absent and checks that typecheck, tests and check-dist remain required.
- [ ] Add native-only black-box launcher probes under temporary HOME/USERPROFILE and harness directories, including spaces and non-ASCII path components. Assert --version and a real hook invocation; report the native-only skip explicitly on other hosts.
- [ ] Extend the ordinary PR/push CI with a native Windows job using the existing Node 24 test runtime. Keep existing Ubuntu/macOS jobs and required checks intact.
- [ ] Run local static/contracts and relevant portable tests. Do not invent Windows success or weaken tests based on guessed failures.
- [ ] Report exact remaining native execution requirements. If native CI exposes pre-existing OS defects, report them for scoped triage rather than expanding the batch silently.

## Integration, review and completion

- [ ] Coordinator serially promotes/claims the six selected backlog cards and records progress/handoffs; workers report instead of competing over the board.
- [ ] Merge only necessary prose updates to the spec and conformance index after worker reports. Route any required skill text through `skilletor-skill-author`.
- [ ] Freeze the combined implementation, run an independent focused review and resolve only confirmed blockers in this scope.
- [ ] Coordinator independently runs `npm run typecheck && npm test && npm run build && npm run check-dist`, plus `cd perl && PERL5LIB=/home/getty/dev/p5-text-nunjucks/lib:/home/getty/dev/langertha/lib:$PERL5LIB prove -lrv -j4 t` and `git diff --check`. Record every skip/TODO and any unrun native job.
- [ ] Release-manager commits the reviewed source changes together with the matching dist and appropriate Changes entries. Close only cards with their required evidence; keep k237 explicitly pending if native Windows verification is unavailable.
- [ ] Report local commits, completed cards, remaining blockers and publication boundaries. Do not promote unrelated backlog work.
