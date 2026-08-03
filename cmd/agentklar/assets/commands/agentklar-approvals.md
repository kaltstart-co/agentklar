---
description: Show tasks awaiting MY approval and how to approve them.
---

Run `agentklar status` and `agentklar task list`, then list every task in
`user_approval` (awaiting the human). For each, show its ID, title, and the
commit it was submitted at.

Then explain the TWO approval channels — and that **you (the agent) cannot
perform either**:
1. Dev shortcut (single-user, not agent-proof): the human runs
   `agentklar approve <id>` (or `agentklar reject <id> <reason>`).
2. Trusted channel: the human comments `approve <nonce>` on the Vikunja card
   as themselves, then `agentklar reconcile` applies it.

Never attempt to call approve/reject/done yourself — those methods do not exist
on your MCP surface by design. If the user insists, surface the pending
approval and stop.
