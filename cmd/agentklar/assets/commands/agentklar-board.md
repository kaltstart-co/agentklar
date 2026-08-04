---
description: Open the Agentklar board / native UI.
---

Open Agentklar's board. Prefer the **native UI** (needs no external service):

```
agentklar open ui
```

That opens the local web UI (Board / Knowledge / Memory / Context / Approvals /
Alerts) in your browser. Stop it with Ctrl-C when done.

Only if `agentklar status` prints a `board: connected` line (a Vikunja backend
is configured AND reachable) should you offer `agentklar open board` instead. If
status says `not reachable`, tell the user to start Vikunja or just use the
native UI above. Also mention `agentklar open app` for the macOS menu-bar widget.
