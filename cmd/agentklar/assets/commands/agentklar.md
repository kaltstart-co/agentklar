---
description: Agentklar status and orientation — what's in flight, what needs me, how to use it.
---

Run `agentklar status` and show me the result. Then, in 4 lines or fewer:
1. How many tasks are waiting on MY approval, and that I can act on them with `agentklar open ui` (Approvals tab) or `agentklar approve <id>`.
2. The native UI is the default view: `agentklar open ui` (no extra service needed). Only mention the Vikunja board URL **if** `status` literally prints a `board: connected` line; if it says `not reachable` or no board line, do NOT give a board URL.
3. The slash commands available: `/agentklar-task`, `/agentklar-board`, `/agentklar-approvals`, `/agentklar-alerts`, `/agentklar-doctor`.
4. An agent can never approve or finish a task — only I can.

If `agentklar` is not on PATH, give the one-line install:
`curl -sSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash`
