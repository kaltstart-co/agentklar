---
description: Turn a feature idea into an Agentklar task (interrogate if vague, then create).
---

The user wants to create an Agentklar task. Input: "$ARGUMENTS"

Step 1 — Decide if it is well-specified. An Agentklar task needs **both**:
- acceptance criteria (concrete, checkable), and
- a verification method (a command or check that proves the criteria).

If either is missing or vague, do NOT invent them. Instead, ask clarifying
questions one at a time (functional, inputs/outputs, edge cases, success
criteria, verification) until you can write real criteria and a real verify
command. Offer to write an interrogator-style ticket if the user wants a full
spec, then `agentklar task import <file.md>`.

Step 2 — Create the task. Use a short ID (e.g. AK-N) unless the user gives one:
```
agentklar task new <id> <title> --criteria "a;b;c" --verify "<command>" --lane quick|standard|major
```
`--lane quick` = small, primary-worktree, exclusive. `standard`/`major` =
dedicated worktree. Default `standard` if unsure.

Step 3 — When the criteria and verify are solid, mark it ready:
```
agentklar task ready <id>
```
If `task ready` is rejected, the Definition of Ready is not satisfied — fix
criteria/verify, do not force it.

Step 4 — Confirm to the user: the task ID, its lane, and that an agent can now
claim it over MCP (`claim_task`). Remind them: an agent cannot finish the task;
the human runs `agentklar gate <id>` then approves.
