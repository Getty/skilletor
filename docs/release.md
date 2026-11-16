# skilletor – release checklist

skilletor is released as the CPAN dist `Skilletor` from the repository root, with
`dzil release` (bundle `[@Author::GETTY]`). One run uploads to CPAN, tags, pushes `main` and
the tag, and publishes the GitHub release, which builds the binaries. All of that is
outward-facing and is Getty's to run. Steps 1 to 3 are local and can run anytime.

The version is one line in two spellings: the dist's `$VERSION` in `lib/` (`0.008`) is the
plugin's `0.8.0` (`package.json`). The tag is the bare dist version (`0.008`); the plugin's
older tags are `v0.1.0` to `v0.7.0`.

## Before the first dist release

- **Text::Nunjucks on CPAN** (k243): Skilletor needs it, and a CPAN install fails without it.
  The house workflow's build also installs the dist's dependencies from CPAN. Then remove the
  pinned checkout from `scripts/binary-prepare.sh` and `.github/workflows/perl.yml` (both
  marked `TEMP (k243)`).
- **The bundle with binary support** on the release machine: `Dist::Zilla::PluginBundle::Author::GETTY`
  0.328 or later (0.327 on CPAN has none), and `PAR::Packer` (`pp`): `dzil build` packs,
  verifies and smokes the binary locally (`DZIL_BINARY_SKIP=1` skips that).
- **No temporary probe triggers**: `.github/workflows/binaries.yml`, `ci.yml`, `perl.yml` and
  `test/windows-ci-contract.test.ts` carry no `TEMP (k242)` lines.

## Per release

1. **Version** — `lib/Skilletor.pm` already holds the version to release (`0.008`; after
   every release the bundle bumps `lib/` to the next one). Set `package.json`,
   `package-lock.json` (root and `packages[""]`), `.codex-plugin/plugin.json` and
   `hermes/skilletor/plugin.yaml` to its plugin spelling (`0.8.0`), and run `npm run build`
   (the Node CLI's version comes from `package.json` at build time).
   `.claude-plugin/plugin.json` carries no `version`: Claude Code takes it from the commit.
   `t/02-version.t` ties the two spellings, and `maint/version-tie.pl` refuses a release
   whose `package.json` is not the version released.
   Later releases only: delete `bin/skilletor-binaries.sha256` in the same commit (see
   [Binaries and the pin](#binaries-and-the-pin)). Don't touch `Changes`: `dzil release` turns
   its `{{$NEXT}}` into the version line.
2. **Verify** — `npm run typecheck && npm test && npm run build && npm run check-dist`;
   `PERL5LIB=… prove -lr -j4 t`; `dzil build`, which packs the binary for this machine, checks
   it and runs `scripts/binary-smoke.sh` on it, the https url source included.
   `HOME=$(mktemp -d) node dist/skilletor.js --version` prints `0.8.0`,
   `perl -Ilib script/skilletor --version` prints `0.008`.
   When the Hermes plugin changed, also run the install case against real Hermes:
   `SKILLETOR_HERMES_INSTALL=1 node --test --import ./test/setup.ts test/hermes-real.test.ts`
   (network; Hermes downloads its plugin runtime, about 100 s).
   A probe of the binaries on all four platforms before the release:
   `gh workflow run binaries.yml` with an empty `tag` (artifacts only, no release touched).
3. **Audit** — run the `skilletor-release-manager` agent: versions, dist, CLI reference in
   README and the bundled skill, marketplace entries, release notes.
4. **`dzil release`** (Getty) — on a clean `main`. It runs the dist's tests and uploads
   `Skilletor-0.008.tar.gz` to CPAN. It stamps `Changes`, commits, and tags `0.008`. It bumps
   `lib/` to `0.009` in a commit of its own, pushes `main` and the tag, and publishes the GitHub
   release with that version's `Changes` entries as its notes. From here `t/02-version.t`
   accepts `lib/` one step ahead of `package.json`. Nothing in it writes the root `bin/`, so
   the starter and its pin are untouched.
5. **Binaries and pin** — the sequence below.
6. **Marketplace** — only when the descriptions below changed or a harness listing is new:
   edit `Getty/marketplace`, then `python3 scripts/check-manifests.py`. Entries carry no
   version, so a plain release needs no marketplace change. Claude Code users get every push
   to `main` with the marketplace's auto-update. For 0.8.0 the Claude entry's `license`
   changes from `MIT` to `Artistic-2.0`.

Hermes users install the plugin from `main` (`hermes plugins install
Getty/skilletor/hermes/skilletor`), not from a tag: a push to `main` reaches them with their
next `hermes plugins update skilletor`, release or not.

`git push origin main` does not include `refs/karr/*` (the board); `karr sync` carries the
board to the remote on its own.

## Binaries and the pin

Plugin users run the release binary first (k203): the starter `bin/skilletor-start` reads
`bin/skilletor-binaries.sha256`, downloads the binary of the version named there from the
GitHub release, checks it against the pinned line and caches it under
`<claudeConfigDir>/skilletor/bin/<version>/` (k168). Without that file it downloads nothing and
runs Node, then Perl. So the file is the switch. It may only reach `main` once the release holds
the bytes it names, and a `main` with a new version must not keep the old file, or it would run
the older binary under the newer plugin. Hence step 1 drops it, and it comes back with the
new release's sums once they exist. In between, users run Node or Perl.

Every step here is outward-facing and needs Getty's go-ahead.

1. **The workflow** — the published release starts `.github/workflows/binaries.yml`
   (`release: types: [published]`; the release plugin publishes it with Getty's own token, so
   the event fires). It calls the bundle's `dzil-binary.yml@binary-v1`, which builds from the
   release's CPAN tarball on linux-x86_64, linux-arm64, macos-arm64 and windows-x86_64. Each
   binary is smoked on clean machines (AlmaLinux 8 and 9, Debian bookworm slim, the macOS and
   Windows runners) with `scripts/binary-smoke.sh`, the https url source included. The
   workflow attaches `skilletor-0.008-<platform>` (`.exe` on Windows), `SHA256SUMS`,
   `install.sh` and `install.ps1` to the release, then marks it latest when it is newer than
   the current latest release (the release plugin leaves that to the workflow). A transient failure:
   `gh run rerun <run-id> --failed`; a rebuild of the same release:
   `gh workflow run binaries.yml -f tag=0.008`. A fix in code is a new version, never a moved
   tag.
2. **Check the sums** — `gh release download 0.008 -p 'skilletor-0.008-*' -p SHA256SUMS -D <tmp>`,
   then `(cd <tmp> && sha256sum -c SHA256SUMS)`: four lines, every one OK, all of version
   0.008. On Linux x86_64, `<tmp>/skilletor-0.008-linux-x86_64 --version` prints `0.008`.
3. **Commit the pin** on `main`: copy `SHA256SUMS` as is to `bin/skilletor-binaries.sha256` and
   commit it alone ("Pin the 0.008 release binaries"). `npm test` stays green; the suite does
   not depend on the file.
4. **Push `main`** — `git push origin main`. From here a user's next SessionStart fetches the
   binary in the background and caches it, and the session after runs it. Until a fetch
   succeeds (offline, no `curl`/`wget`, no `sha256sum`/`shasum`), Node and then Perl keep
   running; a failed fetch is retried after 15 minutes. Windows keeps running Node through
   `bin/skilletor.exe` (winlaunch) until the winlaunch change lands (k169); its line in the
   file is not read there yet.
5. **Marketplace: untouched** for the pin. Entries point at the git repository, so the push to
   `main` reaches Claude Code, Codex and Hermes users alike.

**Rollback**: delete `bin/skilletor-binaries.sha256` on `main` and push. Without the file the
starter ignores any cached binary and runs Node, then Perl, from the next start on.

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
