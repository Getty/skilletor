# skilletor – branding notes

## Idea

A play on Skeletor, but as its own character (not a copy of the Mattel figure: not the
combination of purple hood + blue body + yellow skull + ram-head staff). The tie to
"skill": the villain hoards not power but **skills** – he collects SKILL.md scrolls and
his staff is a skill tree.

## Prompt for the social preview (1280×640)

> Wide 2:1 banner illustration, bold flat cartoon style with thick outlines, 80s
> Saturday-morning-cartoon energy. A goofy, over-the-top villainous skeleton sorcerer
> with a big grinning cartoon skull, wearing a teal hooded cloak, laughing maniacally
> with one bony fist raised. In his other hand a wizard staff whose top is a glowing
> branching skill tree with small unlockable nodes, like an RPG talent tree. Around
> him floats a swirling vortex of glowing parchment scrolls and cards, each marked
> with a tiny markdown hash symbol, being sucked toward him from small distant
> servers and clouds at the edges of the image. Dark purple-to-midnight-blue
> background with lightning and halftone dots, neon green and magenta accent glow.
> Left third kept calm for a title. Funny, not scary; mischievous, not evil. No text,
> no logos, original character design.

Set the title and tagline yourself afterward (image generators mangle text):
**skilletor** – *"MYAAH! Your skills are mine… to sync."*

Tagline/README variants:
- "By the power of `git pull`!"
- "I have the power… to keep your skills up to date."
- "Masters of the Skill-iverse."

Small logo/avatar: just the grinning skull in the hood, one eye as a glowing skill-tree
node.

## README outline

1. Banner + tagline + one sentence: *Remote skills, agents and rules for Claude Code –
   declared once, synced on every session, templated per project.*
2. **30-second start** – three lines:
   `/plugin marketplace add Getty/marketplace` · `/plugin install skilletor@getty` ·
   `skilletor add shared Getty && skilletor install perl-moo@shared`
3. **How it works** – mini diagram source → render → `.claude/` + hook timeline
   (SessionStart, throttled in-session check).
4. **Sources** – shorthand table (`Getty`, `owner/repo`, `hf.co/user`, `host.tld/`,
   tarball, local path) and the source layout.
5. **Declaring what you want** – `skilletor.json` for user and project, scopes.
6. **Templates** – `.njk` opt-in, context variables, example with `{% if vars.kubernetes %}`.
7. **Authoring mode** – local checkout as an override.
8. **Git & your own skills** – gitignore block, coexistence, `"gitignore": false`.
9. **Security & trust** – trust = code execution, `skilletor trust`, what is never
   synced.
10. **Coming from manage-skills** – differences (artifacts instead of hardlinks),
    migration.
11. CLI reference · requirements (node ≥ 18, git) · license.
