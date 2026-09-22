---
type: llm
focus: last_message
weight: 2
---

PASS only if the answer (1) puts the install entry in the project file
`.claude/skilletor.json` (or says to run `skilletor install perl-moo@shared --project`),
(2) writes the entry as `perl-moo@shared` under `install.skills`, and (3) sets
`checkInterval` to `0` in the **user** config `~/.claude/skilletor.json`, explaining that
the session-start sync still happens.
FAIL if it invents a flag or file that does not exist, puts `checkInterval` in the project
file as the fix, or suggests editing installed files under `.claude/skills` directly.
