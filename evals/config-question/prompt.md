---
name: config-question
description: A user asks how to declare a project-scoped item and quiet the in-session check; the bundled skill must fire and the answer must come from it.
tags: [skill, routing]
max_turns: 6
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The skilletor skill is invoked; the answer names .claude/skilletor.json for project scope, install entries as name@source, and checkInterval 0 in the user config to disable the in-session check.
---

I use skilletor. I want the `perl-moo` skill from my `shared` source installed only in
this project (not for my whole user), and I want skilletor to stop checking sources in
the background while I work — it should only sync when the session starts. Which files
do I edit and what exactly goes in them?
