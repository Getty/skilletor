---
name: config-question
description: A user asks how to declare a project-scoped item and quiet the in-session check; the bundled skill must fire and the answer must come from it.
tags: [skill, routing]
max_turns: 4
timeout_seconds: 120
allowed_tools: [Skill]
expected_outcome: The skilletor skill is invoked; the answer names .claude/skilletor.json for project scope, the install entry as go-lint@platform under install.skills, and checkInterval 0 in the user config to disable the in-session check.
---

I use skilletor. I want the `go-lint` skill from my `platform` source installed only in
this project (not for my whole user), and I want skilletor to stop checking sources in
the background while I work — it should only sync when the session starts. Which files
do I edit and what exactly goes in them? Answer directly with the file contents.
