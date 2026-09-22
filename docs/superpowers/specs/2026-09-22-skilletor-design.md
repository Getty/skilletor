# skilletor – Design

Stand: 2026-09-22 · Status: Entwurf zum Review

## 1. Ziel

skilletor ist ein Claude-Code-Plugin plus eigenständiges CLI, das **Skills, Agents und
Rules** aus konfigurierten Remote-Quellen installiert und aktuell hält:

- beim Session-Start wird abgeglichen, während der Session gedrosselt nachgeprüft,
  Neues wird sofort heruntergezogen und dem Modell gemeldet;
- was installiert wird, deklariert die User- oder Projekt-Config;
- Items können Templates sein, die mit Instanz-/Projektvariablen gerendert werden;
- Quellen werden wie Plugin-Marketplaces hinzugefügt (`skilletor add shared Getty`),
  Items daraus installiert (`skilletor install perl-moo@shared`).

skilletor lebt in einem eigenen Repo, wird über `Getty/marketplace` verteilt und ist
der bevorzugte Nachfolger von manage-skills (das bestehen bleibt).

Der Name ist eine Anspielung auf Skeletor; „Skills" ist der Aufhänger, Agents und Rules
sind weitere Item-Typen unter demselben Dach.

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Source** | Benannte Quelle: Git-Repo, HTTPS-Tarball oder lokales Verzeichnis |
| **Item** | Ein installierbares Ding aus einer Source, adressiert als `name@source` |
| **Typ** | `skill`, `agent`, `rule` – feste Tabelle im Code, nicht per Config erweiterbar |
| **Scope** | `user` (`~/.claude/`) oder `project` (`<projekt>/.claude/`) |
| **Lock** | Pro Scope: was skilletor installiert hat, mit Output-Hashes |

## 3. Config

JSON, drei Ebenen:

| Datei | Zweck | Installiert nach |
|---|---|---|
| `~/.claude/skilletor.json` | User-Ebene | `~/.claude/{skills,agents,rules}` |
| `<projekt>/.claude/skilletor.json` | Projekt-Ebene, committed | `<projekt>/.claude/{skills,agents,rules}` |
| `<projekt>/.claude/skilletor.local.json` | maschinenlokale Overrides, nicht committed | wie Projekt |

Der Scope ergibt sich daraus, welche Datei ein Item deklariert.

```json
{
  "sources": {
    "shared": { "git": "https://github.com/Getty/skills", "ref": "main" },
    "team":   { "url": "https://skills.example.com/skills.tar.gz" },
    "mine":   { "local": "~/dev/my-skills" }
  },
  "install": {
    "skills": ["perl-moo@shared", "container-kubernetes@shared"],
    "agents": ["karr@shared"],
    "rules":  ["commit-style@team"]
  },
  "vars": { "kubernetes": true, "k8s_namespace": "prod" },
  "gitignore": true,
  "checkInterval": 600
}
```

- `ref` ist optional (Default: HEAD des Remotes); Tag oder Commit pinnt.
- `gitignore` (nur Projekt, Default `true`): siehe 6.4.
- `checkInterval` (nur User, Sekunden, Default 600): Drossel für den In-Session-Check.
- Doppelte Zielnamen innerhalb eines Typs und Scopes (`foo@shared` + `foo@team`) sind
  ein Config-Fehler.

**Merging der Sources:** User-Sources sind in Projekt-Configs nutzbar. Gleicher Name:
Felder aus User- bzw. Local-Config mergen *über* die Projekt-Definition.

**Autoren-Modus:** Hat eine Source ein `local`-Feld und das Verzeichnis existiert, wird
direkt daraus gelesen (kein Fetch, kein Cache); sonst greift `git`/`url`. Typisch:
Projekt-Config definiert `shared` per `git`, die User-Config des Autors ergänzt
`"shared": { "local": "~/dev/skills" }`. Editiert wird im Checkout, gepusht per git;
alle Projekte der Maschine ziehen beim nächsten Check nach. Hardlinks gibt es nicht –
installierte Dateien sind Build-Artefakte.

## 4. Sources

### 4.1 Layout einer Source (Konvention, kein Manifest nötig)

```
skills/<name>/SKILL.md[.njk] + beliebige Begleitdateien
agents/<name>.md[.njk]
rules/<name>.md[.njk]
snippets/…                 # nur für Includes, nicht installierbar
skilletor.json             # optional: { "description": "…", "vars": { Defaults } }
```

Der Katalog (`skilletor available`) entsteht durch Scannen dieses Layouts; Name und
Beschreibung kommen aus dem Frontmatter der Items.

### 4.2 Shorthand-Auflösung bei `skilletor add [name] <spec>`

Aufgelöst wird **einmalig beim Hinzufügen**; in der Config steht immer die explizite
Form. Hooks raten und proben nie.

| `<spec>` | wird zu |
|---|---|
| `/pfad`, `./pfad`, `~/pfad` | `local` |
| `https://…`, `git@…`, `ssh://…` | unverändert; `.tar.gz`/`.tgz` → `url`, sonst `git` |
| `Getty` (ein Wort) | `git: https://github.com/Getty/skills` |
| `Getty/repo` (erstes Segment ohne Punkt) | `git: https://github.com/Getty/repo` |
| `github:Getty/repo` | wie oben (Kompatibilität zu manage-skills) |
| `github.com/u`, `gitlab.com/u`, `codeberg.org/u`, `hf.co/u`, `huggingface.co/u` | `git: https://<host>/u/skills` |
| dieselben Hosts mit `u/repo` | `git: https://<host>/u/repo` |
| `host.tld` oder `host.tld/` | `https://host.tld/skills` – Probe s. u. |
| `host.tld/pfad` | `https://host.tld/pfad` – Probe s. u. |

**Probe für generische Hosts:** erst `git ls-remote <url>`; antwortet das nicht,
`HEAD <url>.tar.gz`. Der erste Treffer bestimmt `git` bzw. `url`; kein Treffer →
Fehler mit beiden versuchten Adressen.

Fehlt `[name]`, wird er abgeleitet (Owner bzw. Hostname, kleingeschrieben). Der
Default-Repo-Name ist überall `skills`.

### 4.3 Trust

- Sources, die der User selbst hinzufügt (`skilletor add`, eigene User-Config), sind
  vertraut – `add` ist der Trust-Akt.
- Sources, die nur in einer Projekt-Config stehen (geklontes Repo), werden **nicht**
  automatisch gezogen. Der Hook meldet „Projekt will Source X (<url>) –
  `skilletor trust X`". Die Bestätigung (Name + aufgelöste URL) liegt in
  `~/.claude/skilletor/trust.json`; ändert das Projekt die URL, verfällt sie.
- Trust bedeutet Code-Ausführung: Nunjucks ist keine Sandbox. Das ist dasselbe
  Vertrauensniveau wie eine Plugin-Installation und steht so in der README.

### 4.4 Abruf und Check

| Art | `resolve` | `check` (billig) |
|---|---|---|
| `git` | Shallow-Clone/Fetch in den Cache; Auth = git-Setup des Users | `git ls-remote <url> <ref>` vs. gecachter Commit |
| `url` | HTTPS-only, `.tar.gz`, Conditional GET mit ETag | `HEAD` + ETag-Vergleich |
| `local` | direkt lesen | entfällt – es wird immer neu gerendert |

## 5. Templating

- **Opt-in per Endung:** `X.njk` wird durch Nunjucks gerendert und als `X` installiert.
  Alles andere wird byteweise kopiert (Skills mit eigenem `{{ }}`/`{% %}` bleiben heil).
- Autoescape aus (Markdown). Undefinierte Variablen sind ein Fehler
  (`throwOnUndefined`), damit Tippfehler nicht still leere Skills erzeugen.
- Includes/Imports/Makros lösen relativ zur Wurzel der jeweiligen Source auf und dürfen
  sie nicht verlassen.

**Kontext:**

| Variable | Inhalt |
|---|---|
| `vars.*` | gemerged: Source-Defaults < User < Projekt < Local |
| `project.dir`, `project.name`, `project.git_remote` | nur im Projekt-Scope |
| `scope`, `target.dir` | `user`/`project`, Zielwurzel |
| `host.name`, `host.os`, `user.name`, `user.home` | Instanz |
| `item.name`, `item.type`, `item.source` | das Item selbst |

Bewusst nicht enthalten: `env.*` (Secrets landen sonst in Dateien) und der Git-Branch
(Re-Render bei jedem Wechsel).

## 6. Engine

### 6.1 Pipeline von `sync` (pro Scope, User vor Projekt)

1. Config laden, mergen, validieren.
2. Sources auflösen (parallel) → lokales Verzeichnis + Version je Source.
3. Jedes deklarierte Item **im Speicher bauen** (rendern bzw. kopieren).
4. Output mit Platte und Lock vergleichen; nur Unterschiede schreiben (atomar:
   Temp-Datei + Rename); Dateien, die das Item nicht mehr enthält, entfernen.
5. Nicht mehr deklarierte Items laut Lock löschen.
6. Lock und (im Projekt) gitignore-Block schreiben, Report ausgeben.

**Render-and-Compare:** Es gibt keine Invalidierungslogik. Jeder Lauf rendert alles und
difft den Output; geänderte Variablen, Snippets und lokale Checkout-Edits wirken
dadurch automatisch.

### 6.2 Lock

`~/.claude/skilletor.lock.json` bzw. `<projekt>/.claude/skilletor.lock.json`:

```json
{ "skills/perl-moo": {
    "source": "shared", "version": "git:ab12cd3",
    "files": { "SKILL.md": "sha256:…", "reference.md": "sha256:…" } } }
```

### 6.3 Ownership und Koexistenz mit eigenen Dateien

- Existiert ein Zielpfad, der **nicht** im Lock steht (handgeschriebener Skill,
  manage-skills-Link), wird er nie überschrieben → Konflikt im Report; `--force`
  übernimmt ihn.
- Eigene Skills/Agents/Rules des Users liegen unbehelligt neben den verwalteten.
- Weicht eine verwaltete Datei vom Lock-Hash ab (lokal editiert), gewinnt die Source;
  der Report nennt die überschriebene Datei.
- Gelöscht wird ausschließlich, was im Lock steht.

### 6.4 Git-Hygiene im Projekt

Bei `"gitignore": true` (Default) pflegt skilletor einen markierten Block in
`<projekt>/.claude/.gitignore` mit den **exakten** verwalteten Pfaden, dem Lock und
`skilletor.local.json`. Committed wird nur `skilletor.json`; eigene Skills daneben
bleiben normal versioniert. Bei `"gitignore": false` wird der Block entfernt und alles
ist committbar (Teammates ohne Plugin bekommen die Dateien per Clone) – sinnvoll nur
für Items ohne maschinenspezifische Variablen.

### 6.5 State

`~/.claude/skilletor/`: `cache/` (löschbar), `trust.json`, `last-check.json`,
`pending-report.json`, `sync.lock/` (mkdir-Mutex mit Stale-Timeout gegen parallele
Sessions). `CLAUDE_PLUGIN_DATA` wird nicht benutzt, damit das CLI ohne Claude Code
identisch läuft.

### 6.6 Fehlerverhalten

Ein Sync-Fehler bricht nie eine Session ab. Fetch-Fehler/offline → weiter mit Cache,
eine Warnzeile. Template-Fehler → dieses Item bleibt auf altem Stand, Fehler mit Datei
und Zeile. Config-Fehler → nichts wird angefasst, klare Meldung.

## 7. CLI

```
skilletor add [name] <spec> [--project]   # Source hinzufügen (= source add), löst Shorthand auf
skilletor source list | remove <name>
skilletor available [source]              # Katalog: Typ, Name, Beschreibung, installiert?
skilletor install <item>… [--project]     # name@source, bei Mehrdeutigkeit typ:name@source
skilletor uninstall <item>…
skilletor sync | check | status           # --scope user|project|all, --json, --force
skilletor trust <source>
skilletor hook <event>                    # nur für hooks.json
```

`add`/`install`/`uninstall` editieren ausschließlich die Config (Default: User-Config)
und fahren danach `sync`. Die deklarative Config bleibt die einzige Wahrheit.

## 8. Hooks und Meldungen

| Event | Verhalten |
|---|---|
| `SessionStart` (`startup`, `resume`) | synchron: `check` aller Sources parallel (5 s Netz-Timeout je Source), bei Änderung `sync` |
| `UserPromptSubmit` | nicht fällig → sofort Ende. Fällig → detachten Hintergrund-`sync` starten, sofort zurück. Liegt ein `pending-report.json` vor → als `additionalContext` ausgeben und löschen |

- Ohne Änderung ist das Plugin still.
- Mit Änderung: eine `systemMessage`-Zeile für den User, ein knapper
  `additionalContext` fürs Modell, pro Item mit Aktivierungshinweis („sofort aktiv" /
  „nach /reload-plugins oder Neustart" / „ab nächster Session") gemäß Spike (Abschnitt 12).
- Warnungen (unvertraute Source, überschriebene Änderung, Konflikt, Template-Fehler,
  offline) laufen einzeilig über denselben Kanal.
- Das Plugin liefert außerdem das CLI im `PATH` des Bash-Tools und einen Skill
  `skilletor`, der dem Modell Config-Format und CLI erklärt.

## 9. Sicherheit

- Feste Typ-Tabelle mit festen Zielverzeichnissen; Hooks, `settings.json`, MCP-Configs
  werden nie synchronisiert.
- Pfad-Härtung: Item-Namen, Tar-Einträge und Includes dürfen Source- bzw. Zielwurzel
  nicht verlassen; Symlinks in Sources werden abgelehnt; `url` nur HTTPS.
- Trust-Modell nach 4.3; kein `env.*` im Kontext; Pinning über `ref`.

## 10. Repo, Build, Verteilung

```
.claude-plugin/plugin.json      hooks/hooks.json
bin/skilletor                   # Shim → node dist/skilletor.js, prüft Node ≥ 18 mit klarer Meldung
dist/skilletor.js               # esbuild-Bundle inkl. Nunjucks, committed
skills/skilletor/SKILL.md
src/cli.ts                      # Argumente, Dispatch
src/config.ts                   # laden/mergen/validieren + Edit-Operationen
src/spec.ts                     # Shorthand-Auflösung (4.2), Probe injizierbar
src/sources/{git,url,local}.ts  # resolve(), check()
src/catalog.ts                  # Source scannen → Items
src/render.ts                   # Item im Speicher bauen
src/apply.ts                    # Diff, atomar schreiben, aufräumen, gitignore-Block
src/lock.ts  src/state.ts       # Lock; Trust, last-check, pending-report, Mutex
src/hooks.ts  src/report.ts
test/
```

Grenzen: `sources/*` kennt kein Templating, `render` kein Ziel-Dateisystem, `apply`
keine Sources. TypeScript, einzige Laufzeit-Dependency ist Nunjucks (gebündelt);
Requirements beim User: `node ≥ 18`, `git`. Eigenes Repo `Getty/skilletor`, Eintrag in
`Getty/marketplace`; lokal entwickeln mit `claude --plugin-dir .`.

## 11. Tests

TDD mit `node:test`. Unit-Tests pro Modul gegen Temp-Verzeichnisse; `spec.ts` als
Tabellentest über alle Shorthand-Zeilen; Git-Sources gegen lokale Bare-Repos
(`file://`), URL-Sources gegen lokalen HTTP-Server mit ETag; Hooks als Blackbox
(stdin-JSON → stdout-JSON). End-to-End: Fixture-Source → `sync` → Baum + Lock prüfen,
dann zweite Runde mit geänderter Source bzw. geänderten Variablen. Security-Fälle:
Traversal, Symlink, unvertraute Source, fremder Zielpfad. CI prüft, dass `dist/` zum
Source passt.

## 12. Spike vor der Implementierung

Manuell gegen das echte Claude Code, Ergebnis wird hier nachgetragen und bestimmt die
Meldungstexte:

1. Neues Skill-Verzeichnis mitten in der Session → ohne Reload nutzbar?
2. Neue Agent-Datei mitten in der Session → ohne Reload nutzbar?
3. Neue Rule-Datei (mit und ohne `paths`) mitten in der Session → geladen?
4. Skills, die der `SessionStart`-Hook selbst schreibt → in derselben Session sichtbar?

## 13. Nicht-Ziele (vorerst)

Monitor-basierter Timer statt Prompt-Hook · Checksummen-Pins für Tarballs · Aliase
(`as`) für Items · weitere Typen (`commands`, `output-styles`) · automatischer Import
einer manage-skills-Konfiguration · Codex-Target.
