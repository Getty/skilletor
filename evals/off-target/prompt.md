---
name: off-target
description: An unrelated Node question; the skilletor skill must not fire.
tags: [skill, routing]
max_turns: 4
timeout_seconds: 90
allowed_tools: [Read, Skill]
expected_outcome: Answered without invoking the skilletor skill.
---

In Node.js, what is the difference between `fs.rename` and writing to a temp file
followed by a rename, when I want an atomic write? Two or three sentences.
