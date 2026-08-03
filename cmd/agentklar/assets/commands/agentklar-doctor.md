---
description: Run Agentklar doctor — workspace health, declared recipes, missing commands.
---

Run `agentklar doctor` and summarise:
- the workspace and repository paths,
- the declared quality recipes and any GAPs (commands declared in
  `.agentklar/quality.toml` but not found on PATH),
- the task counts by state.

If there are GAPs, tell the user exactly which commands are missing and suggest
installing them or removing the recipe. Remind them: Agentklar only ever runs
recipes declared in `quality.toml` — never inferred commands — and that
`task import` writes draft proposals to `quality.proposed.toml`, which the gate
does NOT load.
