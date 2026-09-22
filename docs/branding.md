# skilletor – Branding-Notizen

## Idee

Anspielung auf Skeletor, aber als eigene Figur (keine Kopie der Mattel-Figur: nicht die
Kombination lila Kapuze + blauer Körper + gelber Schädel + Widderkopf-Stab). Die
Verbindung zu „Skill": Der Bösewicht hortet keine Macht, sondern **Skills** – er
sammelt SKILL.md-Schriftrollen und sein Stab ist ein Skill-Tree.

## Prompt für das Social Preview (1280×640)

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

Titel und Tagline danach selbst setzen (Bildgeneratoren verhunzen Text):
**skilletor** – *„MYAAH! Your skills are mine… to sync."*

Varianten für Tagline/README:
- „By the power of `git pull`!"
- „I have the power… to keep your skills up to date."
- „Masters of the Skill-iverse."

Kleines Logo/Avatar: nur der grinsende Schädel in der Kapuze, ein Auge als leuchtender
Skill-Tree-Knoten.

## README-Gliederung (englisch, da öffentliches Repo)

1. Banner + Tagline + ein Satz: *Remote skills, agents and rules for Claude Code –
   declared once, synced on every session, templated per project.*
2. **30-second start** – drei Zeilen:
   `/plugin marketplace add Getty/marketplace` · `/plugin install skilletor@getty` ·
   `skilletor add shared Getty && skilletor install perl-moo@shared`
3. **How it works** – Mini-Diagramm Source → render → `.claude/` + Hook-Timeline
   (SessionStart, throttled in-session check).
4. **Sources** – Shorthand-Tabelle (`Getty`, `owner/repo`, `hf.co/user`, `host.tld/`,
   Tarball, lokaler Pfad) und das Source-Layout.
5. **Declaring what you want** – `skilletor.json` für User und Projekt, Scopes.
6. **Templates** – `.njk`-Opt-in, Kontextvariablen, Beispiel mit `{% if vars.kubernetes %}`.
7. **Authoring mode** – lokaler Checkout als Override.
8. **Git & your own skills** – gitignore-Block, Koexistenz, `"gitignore": false`.
9. **Security & trust** – Trust = Code-Ausführung, `skilletor trust`, was nie
   synchronisiert wird.
10. **Coming from manage-skills** – Unterschiede (Artefakte statt Hardlinks), Migration.
11. CLI-Referenz · Requirements (node ≥ 18, git) · License.
