# Sources — adding, naming, links, layouts, `path`, entry fields

## `skilletor add` — name and address

`add` without a name takes the repo's for a git repo other than `skills` (`Getty/karr`,
`https://github.com/Getty/karr.git` → `karr`), else the owner's (`Getty` → `getty`), the
host's or the directory's.

A GitHub tree link (`github.com/o/r/tree/<ref>`, also as `o/r/tree/<ref>`,
`…/releases/tag/<tag>`, `…/commit/<sha>`) adds the repo pinned to `<ref>`, one into a
directory (`…/tree/<ref>/<dir>`) with `path: <dir>` as well; GitLab (`/-/tree/`), Codeberg
(`/src/branch/`) and Hugging Face (`/tree/`) links alike. `?query`/`#anchor` are dropped,
`%`-escapes decoded; the segment after `tree` is always the ref (a ref with `/`: `%2F`, or
set `ref` by hand); a file link or any other page (`/issues`) is refused.

`add` never replaces a source: the same address again keeps the entry as written (`ref`,
`path`, `local` stay) and syncs. Exit 1, nothing changed or trusted, when config load
refuses that entry (a hand-written `"ref": ""`: fix it by hand), a tree link pins a ref or
path the entry lacks (set it by hand or use another name) or the name has another address
(use another name); `source remove <name>` first gets past all three. `source remove` also
drops an entry config load refuses (an `http://` url) unless load refuses more (then exit 1,
config untouched).

## Layouts a source can have

Sources use `skills/<name>/`, `agents/<name>.md`, `rules/<name>.md`. Claude plugin repos
work too, the skills their `.claude-plugin/plugin.json` lists installed as `skills/<name>/`:
`skilletor add obra/superpowers`, `skilletor add anthropics` (→ anthropics/skills). A repo's
own `.claude/skills/<name>/`, `.claude/agents/<name>.md[.njk]` and
`.claude/rules/<name>.md[.njk]` install like published ones (`skilletor add Getty/karr`),
read last, best effort: a name found above wins; a symlink and skilletor's installed copies
(`.local.` files, a skill carrying skilletor's `.gitignore`) are skipped. Names differing
only in case (`Foo`, `foo`) are one name everywhere — in a source an error of each, in two
install entries or two sources' offers the same-name conflict — as macOS and Windows install
both into one place.

## Skills elsewhere — `path`

A repo with its skills elsewhere (by category, no `plugin.json`) offers nothing that way: set
`path` on its source entry — a directory or a list, relative to the repo root —

```json
"hermes": { "git": "https://github.com/NousResearch/hermes-agent", "path": ["skills", "optional-skills"] }
```

and every directory beneath it holding a `SKILL.md[.njk]`, at any depth, is one skill named
after that directory (a category `skills/research` or one skill `skills/research/arxiv` works
too; skilletor's installed copies are skipped). `path` replaces the layout above: that
source then offers those skills only — no agents, rules, bundles, `plugin.json` or `.claude/`
items. The same name in two directories (case ignored) is an error of that skill alone (as
`f` beside `f.njk` in one item is). `add` has no option for it: a link
into a directory sets it, anything else is edited into the entry. (That example source is
for Claude Code and Codex: under target `hermes` its skills collide with Hermes' own copies
and none loads.)

## Source entry fields

- A source name (its key) is ASCII letters, digits, `.`, `_`, `-`, starting with a letter or
  digit; `git`/`local` are non-empty strings; `url` is `https://`; `ref` (git) is a plain
  branch, tag or commit name (no leading `-`, whitespace, `~ ^ : ? * [ \`, `..`, `@{`) —
  omit it, never `""`, for the remote's HEAD; `path` is a non-empty string or list of them,
  relative, without `..`, not the root (`.`). Anything else is a config error; `add` refuses
  such a name or address (an `http://…`/`file://…` tarball too) before writing: exit 1.
- A `path` that is missing, no directory or a symlink leaves the source unresolved for that
  sync: a warning, installed items stay.
- `ref` and `path` are not part of a source's identity (cache, trust) and merge
  project < user < local, replaced whole.
- An entry may omit `git`/`url`/`local` when another file gives the source one
  (`{ "ref": "v2" }` in `skilletor.local.json` pins the project's source); none in any file
  is a config error. A user entry without one is no user-scope source.
