# Perl-first Readiness Plan

> **For agentic workers:** Work only the assigned karr card through the briefed skilletor team. Main coordinates serial board writes and independent review. The maintainer requested autonomous local work without more questions; no commits, publication or remote CI dispatch are authorized.

**Goal:** Make the primary user runtime the Perl implementation, including machines without Node or system Perl, without activating an unverified bootstrap path.

**Architecture:** The packed Perl executable is primary. Its version matches the plugin, its trusted digest is pinned in the plugin and its cache is shared across harnesses. TypeScript remains a development/reference implementation and optional fallback, not an installation prerequisite. Target selection is independent (k229).

**Tech Stack:** Perl >= 5.40, PAR::Packer, existing POSIX starter, platform-specific release binaries, TypeScript reference/conformance.

**Spec:** Existing Perl design `docs/perl.md` and strand k166, with the maintainer's 2026-11-15 direction recorded on k166/k191. This document is a local readiness sequence, not authorization to release.

## Global Constraints

- Preserve existing unfinished k178 work in the original checkout. Recover/review it in isolation before extending it.
- Do not change what plugin users run until required CLI parity, binary integrity, ABI/TLS and platform startup checks are green.
- No downloading on the per-prompt hook. Provision during explicit setup or bounded session-start provisioning; use a cached verified executable afterwards.
- Keep the current versioned shared cache and plugin-pinned checksum trust anchor; never silently weaken to a checksum fetched beside an untrusted executable.
- Do not claim Windows/macOS/ARM64 support from a Linux-only run.
- Runtime Node independence is distinct from Node used for reference tests or generating expectations.

## Review Focus

- A PATH without node must support installation, CLI operation and hooks on a supported platform.
- Corrupt downloads, mismatched checksums, offline starts and concurrent first starts must not execute partial/untrusted files.
- Cold PAR startup and TLS shared-library requirements must be measured on target-like environments, not assumed from a developer machine.
- CLI install/uninstall/source/trust operations must match the reference's observable streams, exit statuses and state.
- A failed or missing download must not repeat expensive network work on every prompt.

## Sequence

### 1. Source-Perl dependency readiness — k159

- [ ] Align cpanfile minimum with the actual Text::Nunjucks Perl requirement.
- [ ] Reproducibly provision the pinned template dependency in Perl CI; remove unsupported interpreter cells.
- [ ] Add local CI/dependency contract tests and verify. Remote CI execution remains unrun until separately authorized.

### 2. Finish CLI parity — k178, then k179, k219

- [ ] Recover the original checkout's existing k178 edits and reserved cases 130–139 into an isolated integration path; do not overwrite them in place.
- [ ] Independently review/test install behavior and interactions with k229; preserve TTY/non-TTY semantics.
- [ ] Port uninstall using the existing parse helpers and reference behavior; add shared cases and in-process regression tests.
- [ ] Extend packed-binary smoke to every shipped command and compare trust/config state, not only reports.
- [ ] Treat reference parser defects in k170 separately; do not silently redefine CLI behavior inside the port.

### 3. Bootstrap without JavaScript — installer and starter follow-up cards

- [ ] Give install.sh an actual no-Node path; it currently requires Node and uses JS to inspect plugin state.
- [ ] Preserve binary-first order; source Perl/Node may remain optional fallbacks. No path may claim no-JS readiness while unconditionally spawning node.
- [ ] Harden bounded provisioning, failure backoff and stale temporary handling. No download in UserPromptSubmit.
- [ ] Remove Node-bundle presence as a prerequisite in the Hermes checkout adapter only when the replacement launcher contract is proved.

### 4. Binary platform and performance gates — k167/k168/k169/k203

- [ ] Pin dependency input to the selected source/tag so rebuilding an old version cannot silently use a newer workflow dependency.
- [ ] Resolve Linux OpenSSL ABI portability and prove HTTPS with the produced binary in a suitable isolated target environment.
- [ ] Measure warm/cold hook startup on release-like artifacts; existing k203 measurements show a nontrivial PAR cost.
- [ ] Prove each supported platform's asset and launcher. Cross-repo winlaunch changes require a card on that repository's board, never an unannounced edit.
- [ ] Keep unsupported/unverified platform activation blocked rather than route users into a broken binary path.

### 5. Activation and docs — k191 and skill-author

- [ ] Update local wiring only after preceding gates pass, with regressions for fallback, no-JS PATH and hooks' fail-open behavior.
- [ ] Update README, spec, Hermes installation text and bundled skill to actual proved support. Include native library prerequisites.
- [ ] Main independently verifies the combined tree. Release-manager may commit only after explicit commit authorization; no tags, pushes, uploads, marketplace edits or remote release/workflow actions without permission.

## Current progress

- k200/k220: implemented, independently tested, uncommitted; both present in the integration worktree.
- k229: project-target implementation running separately.
- k159: local CI/minimum-version fix running.
- k178: original checkout contains unfinished changes, not yet integrated here.
- k179 and later gates remain open. No binary activation has occurred.
