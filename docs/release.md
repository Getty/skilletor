# skilletor – release checklist

Every outward-facing step (push, tag, GitHub release, `Getty/marketplace`) needs Getty's
explicit go-ahead. Everything before step 4 is local and can run anytime.

## Per release

1. **Version** — bump `package.json`, `package-lock.json` (root and `packages[""]`),
   `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` to the same version;
   `npm run build` (the CLI version is injected from `package.json` at build time).
   In `Changes`, turn the `{{$NEXT}}` line into the version line
   (`printf '%-9s %s\n' X.Y.Z "$(date -u '+%F %TZ')"`) and put a fresh `{{$NEXT}}` and a
   blank line above it — all in the commit that bumps the version.
2. **Verify** — `npm run typecheck && npm test && npm run build && npm run check-dist`;
   `HOME=$(mktemp -d) bin/skilletor --version` prints the new version.
3. **Audit** — run the `skilletor-release-manager` agent: versions, dist, CLI reference in
   README and the bundled skill, marketplace entries, release notes.
4. **Push and tag** — `git push origin main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
   CI (`.github/workflows/ci.yml`: Linux + macOS, `npm ci`, typecheck, test, check-dist)
   must be green on the pushed commit.
5. **GitHub release** — `gh release create vX.Y.Z --title "skilletor vX.Y.Z" --notes-file <notes>`;
   the notes are that version's entries in `Changes`, grouped by area.
6. **Marketplace** — only when the descriptions below changed or a harness listing is new:
   edit `Getty/marketplace`, then `python3 scripts/check-manifests.py`. Entries carry no
   version, so a plain release needs no marketplace change.

`refs/karr/*` (the board) is never pushed: `git push origin main` does not include it.

## Marketplace entries (Getty/marketplace)

Each entry's description is its harness's plugin manifest description, verbatim: the
Claude entry `.claude-plugin/plugin.json`'s, the Codex entry `.codex-plugin/plugin.json`'s.

Claude (`.claude-plugin/marketplace.json`, `plugins`):

```json
{
  "name": "skilletor",
  "source": { "source": "github", "repo": "Getty/skilletor" },
  "description": "Remote skills, agents and rules for Claude Code and Codex — declared once in skilletor.json, synced on every session, templated per project. Adds sources like marketplaces and puts the skilletor CLI on PATH.",
  "license": "MIT",
  "homepage": "https://github.com/Getty/skilletor",
  "category": "productivity",
  "tags": ["skills", "agents", "rules", "sync", "templates", "nunjucks"]
}
```

Codex (`.agents/plugins/marketplace.json`, `plugins`):

```json
{
  "name": "skilletor",
  "description": "Remote skills, agents and rules for Codex and Claude Code — declared once in skilletor.json, synced on every session, templated per project. For Codex: skills in .agents/skills, agents as agent-role TOML, rules injected at session start by the hook.",
  "source": { "source": "url", "url": "https://github.com/Getty/skilletor.git", "ref": "main" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
  "category": "Productivity"
}
```

## Social preview

`assets/github.png` is both the README banner and the GitHub social preview (1280×640,
under 1 MB). Upload it at Settings → General → Social preview when it changes.
