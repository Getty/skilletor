# Project-local target defaults

## Intent and decisions

Maintainer request, 2026-11-15 (k229): do not install every machine-detected framework into every project. Use the framework already used by the project, while retaining explicit `targets`. The maintainer selected **project decides**: user `targets` describes the machine's available/allowed harnesses, not an instruction to install every one into every project. They subsequently requested continued autonomous work without further questions.

This changes the target default, not runtime selection. TypeScript remains the behavior reference and the Perl implementation changes together with it. Perl-first provisioning is a separate strand (k166).

## Approaches

1. Keep inheriting explicit user targets and filter only implicit machine detection: smaller compatibility change, but still contaminates Claude projects on machines explicitly configured for both harnesses. Not selected.
2. Project-local evidence inside the machine allowlist, overridden by explicit project targets: selected by the maintainer.
3. Select whichever harness invoked a hook: rejected. Alternating Claude and Codex hooks must not remove one another's installations.

## Target contract

- Machine targets remain user `targets`, otherwise existing machine detection. No detected machine harness remains the existing actionable configuration error.
- User scope remains unchanged.
- Project selection is `local project targets > committed project targets > project-local evidence`; intersect with machine targets. Explicit project targets retain their existing validation and empty-intersection warning.
- A global explicit list does not bypass project-local selection.
- No configuration schema or target names are added.
- Claude evidence selects Claude; Codex evidence selects Codex; both select both, in the existing stable harness order.
- Project evidence cannot enable a machine-disallowed harness. Hermes still requires machine-level explicit opt-in; `.agents` alone never means Hermes.
- The same inputs yield the same project targets regardless of hook event, invoking harness or engine implementation.

## Evidence and self-generated files

These details are conservative implementation choices, not additional maintainer requirements:

- Own Claude instructions/configuration or own files in `.claude` count as Claude usage. Own `.agents` skills and own `.codex` configuration/agents/instructions count as Codex usage. Own `.hermes` files can select Hermes only after machine-level explicit opt-in.
- `CLAUDE.md` is Claude evidence. Generic `AGENTS.md` alone is not Codex-exclusive evidence; its skilletor pointer certainly is not.
- Skilletor's configuration, lock, state, local override and generated ignore/pointer blocks never count as harness evidence.
- Files owned by the current lock, generated `.local.*` agents/rules, and installed skill directories identified by skilletor's existing ownership conventions do not create an opt-in.
- An empty settings object, or a settings file containing only skilletor-generated plugin/marketplace declarations, is insufficient. Other genuine harness settings count. This conservative classification must remain unchanged when sync adds its plugin declarations; it does not introduce provenance state. Reuse the existing block/settings readers where applicable.
- Empty leftover roots do not count. Do not traverse arbitrary symlink trees just to detect usage; an explicit user-owned linked harness root may count without recursive inspection.
- Detection is read-only. Never execute project files, inspect credentials or fetch sources to choose targets.

## Ambiguous projects and migration

Coordinator choices to avoid destructive inference:

- With no reliable project evidence and exactly one machine target, use that sole target; this preserves single-harness bootstrap without creating cross-framework copies.
- With multiple machine targets and no reliable evidence, leave the project scope untouched and issue one actionable warning asking for explicit project `targets`. Do not silently remove all existing project items. User-scope work may continue.
- A missing or malformed lock must never turn known skilletor artifacts into positive evidence. Preserve existing lock-error behavior; do not add broad lock-repair work to k229.
- When unambiguous evidence or explicit project targets deselects a harness, use existing ownership-based reconciliation: remove only locked/generated outputs, never unrelated user files, credentials or whole framework roots. Unknown lock prefixes stay untouched.
- Do not hand-clean the maintainer's real checkout during development. Migration behavior is proved in disposable fixtures. Any later real cleanup must remain recoverable and clearly reported.

## Evidence-preserving settings writes (k234)

The final review demonstrated an information-loss boundary: a genuine marketplace-only
settings file can become byte-for-byte indistinguishable from generated-only settings
when skilletor adds its plugin requirement. Classifier-only fixes cannot recover its origin.

Coordinator ruling under the maintainer's autonomous-work instruction: keep inference
read-only and introduce no provenance file or implicit `targets` edit. Instead, a project
settings plan must be evaluated virtually before it is applied. If an implicitly selected
project target set would change because of that settings write, leave the settings file
byte-identical and warn to set explicit project `targets`, then sync. Only that settings
write is skipped: item reconciliation continues for the stable selected targets. Do not write
and roll back to test this. Use current/new lock ownership, so freshly installed managed skills do
not appear to be independent evidence during the check.

Explicit project targets, sole-machine bootstrap and other stable genuine evidence continue
to permit the usual add-only settings update. A deliberately skipped settings plan is not
perpetual layout drift for `check`. The cost of this conservative choice is that a
marketplace-only project may need an explicit target declaration before skilletor can add
its plugin requirement automatically; it must not lose installed files instead.

## Acceptance

Shared TS/Perl cases cover Claude-only, Codex-only, both, global explicit both plus Claude-only project, explicit project override, local override, no-evidence multi-harness, single-harness bootstrap, generated-only roots, and cleanup preserving foreign files. Include check/status behavior and repeated/alternating hooks so own writes never change inferred targets.

Existing tests that intentionally require a target should declare it explicitly in their fixture rather than accidentally depending on machine-wide inheritance. Do not blindly regenerate expectations. Record intentional behavior changes; retain unrelated assertions. No live user-home sync, no release and no paid harness eval are part of this change.
