# skilletor – release prep (k19)

Everything here is **offline preparation**. Each outward-facing step below needs Getty's
explicit go-ahead and is done by a human — nothing in this file has been pushed anywhere.

## Release checklist (human-run)

1. **Create the GitHub repo `Getty/skilletor`** and push `main`.
   ```bash
   git remote add origin git@github.com:Getty/skilletor.git
   git push -u origin main
   ```
   See the `refs/karr/*` decision below before pushing.
2. **CI** — `.github/workflows/ci.yml` is committed (Linux + macOS, Node 24: `npm ci`,
   `typecheck`, `test`, `check-dist`). Confirm it's green on the first push.
   - Windows is intentionally omitted for now: several tests create symlinks, which need
     elevated privileges on Windows. Add a Windows job later behind a symlink-capable
     runner or by skipping the symlink cases there.
3. **Marketplace** — add the entry below to `Getty/marketplace`'s
   `.claude-plugin/marketplace.json` `plugins` array, then verify a clean install on a
   fresh machine/home:
   ```
   /plugin marketplace add Getty/marketplace
   /plugin install skilletor@getty
   ```
4. **Tag the release** — `git tag v0.1.0 && git push origin v0.1.0` (match
   `package.json` / `plugin.json`).
5. **manage-skills note** — add the paragraph below to the manage-skills README pointing
   at skilletor as the preferred successor.

## Decision: should `refs/karr/*` go to the public remote?

The karr board lives in `refs/karr/*`, not in the work tree. A plain `git push origin main`
**does not** push it — the board stays local unless you explicitly push those refs.

**Recommendation: keep the board private** (don't push `refs/karr/*`). It's internal task
tracking. If you want the history public for transparency, push it deliberately:
`git push origin 'refs/karr/*:refs/karr/*'`.

## Marketplace entry (add to Getty/marketplace)

```json
{
  "name": "skilletor",
  "source": { "source": "github", "repo": "Getty/skilletor" },
  "description": "Remote skills, agents and rules for Claude Code — declared once, synced on every session, templated per project.",
  "license": "MIT",
  "homepage": "https://github.com/Getty/skilletor",
  "category": "productivity",
  "tags": ["skills", "agents", "rules", "sync", "templates", "nunjucks"]
}
```

## manage-skills README note (draft)

> ### Successor: skilletor
>
> [skilletor](https://github.com/Getty/skilletor) is the preferred successor to
> manage-skills. Where manage-skills hardlinks a single source-of-truth file into each
> project, skilletor installs **build artifacts** — skills, agents and rules rendered per
> instance from remote sources — and keeps them up to date every session. Reach for
> skilletor when you want templated, auto-updating items from a shared remote;
> manage-skills remains for hardlinked local sharing.

## Social preview

`assets/github.png` is the banner (used at the top of the README). For GitHub's repo
**social preview** (Settings → General → Social preview), the recommended size is
1280×640 and under ~1 MB; the current image is 1774×887 / ~2.8 MB, so consider exporting a
1280×640 version for that specific slot. The in-README banner is fine as is.
