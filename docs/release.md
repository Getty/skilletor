# skilletor – release checklist

skilletor is released as a plugin for Claude Code, Codex and Hermes Agent, straight from this
repository: the marketplace entries point at `main`, so a push to `main` reaches users. Since
the switch to Bun (hub task `agent-developer k5`) there is no CPAN dist, no `dzil` and no
binary any more. Everything outward-facing — merge, push to `main`, tag, GitHub release,
marketplace — is Getty's to run. Steps 1 to 3 are local and can run anytime.

**Not released yet:** the Bun runtime waits for getty-bun on macOS (darwin-x64,
darwin-aarch64) and for its `.cmd` starter for Claude Code on Windows (hub decisions F5, F2).

**Open:** how a release is stamped and tagged without `dzil` (the `{{$NEXT}}` line in
`Changes`, the tag spelling `vX.Y.Z` or bare) is Getty's decision; the steps below assume a
hand-stamped `Changes` and a `vX.Y.Z` tag.

## Per release

1. **Version** — set `package.json`, `.codex-plugin/plugin.json` and
   `hermes/skilletor/plugin.yaml` to the version (`x.y.z`), and run `bun run build` (the CLI's
   version comes from `package.json` at build time). `.claude-plugin/plugin.json` carries no
   `version`: Claude Code takes it from the commit. Stamp `Changes`: `{{$NEXT}}` becomes
   `x.y.z  <date>`.
2. **Verify** — on the pinned Bun (`gettyBun.bunVersion`):
   `bun install --frozen-lockfile && bun run typecheck && bun run test && bun run build && bun run check-dist && bun run check-starters`.
   `HOME=$(mktemp -d) GETTY_HOME=$(mktemp -d) bin/skilletor --version` prints the version
   through the starter (the first run downloads Bun). When the Hermes plugin changed, also run
   the install case against real Hermes:
   `SKILLETOR_HERMES_INSTALL=1 bun test --preload ./test/setup.ts ./test/hermes-real.test.ts`
   (network; Hermes downloads its plugin runtime, about 100 s).
3. **Audit** — run the `skilletor-release-manager` agent: versions, `dist/`, the Bun pin
   (`gettyBun.bunVersion` = `vars.bun_version` in `.claude/skilletor.json`, starters equal to
   the render), CLI reference in README and the bundled skill, marketplace entries, release
   notes.
4. **Merge, tag, release** (Getty) — merge to `main`, tag, push `main` and the tag, create the
   GitHub release with that version's `Changes` entries as its notes.
5. **Marketplace** — only when the descriptions below changed or a harness listing is new:
   edit `Getty/marketplace`, then `python3 scripts/check-manifests.py`. Entries carry no
   version, so a plain release needs no marketplace change.

A release that changes the hook lines (as the switch to Bun does) makes Codex ask every user to
trust the hooks again in `/hooks`; the release notes say so. A Bun bump is a release of its
own: `vars.bun_version` and `gettyBun.bunVersion`, sync, copy the starters to `bootstrap/`,
rebuild `dist/`, one commit.

Hermes users install the plugin from `main` (`hermes plugins install
Getty/skilletor/hermes/skilletor`), not from a tag: a push to `main` reaches them with their
next `hermes plugins update skilletor`, release or not.

`git push origin main` does not include `refs/karr/*` (the board); `karr sync` carries the
board to the remote on its own.

## Marketplace entries (Getty/marketplace)

Each entry's description is its harness's plugin manifest description, verbatim: the
Claude entry `.claude-plugin/plugin.json`'s, the Codex entry `.codex-plugin/plugin.json`'s.

Claude (`.claude-plugin/marketplace.json`, `plugins`):

```json
{
  "name": "skilletor",
  "source": { "source": "url", "url": "https://github.com/Getty/skilletor.git" },
  "description": "Remote skills, agents and rules for Claude Code, Codex and Hermes Agent — declared once in skilletor.json, synced on every session, templated per project. Adds sources like marketplaces and puts the skilletor CLI on PATH.",
  "license": "Artistic-2.0",
  "homepage": "https://github.com/Getty/skilletor",
  "category": "productivity",
  "tags": ["skills", "agents", "rules", "sync", "templates", "nunjucks"]
}
```

Codex (`.agents/plugins/marketplace.json`, `plugins`):

```json
{
  "name": "skilletor",
  "description": "Remote skills, agents and rules for Codex, Claude Code and Hermes Agent — declared once in skilletor.json, synced on every session, templated per project. For Codex: skills in .agents/skills, agents as agent-role TOML, rules injected at session start by the hook.",
  "source": { "source": "url", "url": "https://github.com/Getty/skilletor.git", "ref": "main" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
  "category": "Productivity"
}
```

## Social preview

`assets/github.png` is both the README banner and the GitHub social preview (1280×640,
under 1 MB). Upload it at Settings → General → Social preview when it changes.
