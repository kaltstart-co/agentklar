---
description: Show Agentklar alerts — what agents have flagged (blocked / needs input / error / done).
---

Run `agentklar alerts list` and show every alert with its severity, the task it
relates to, and the agent that raised it. Highlight any that are still
**pending** (not yet acknowledged).

Then explain:
- These are logged automatically when an agent calls `notify_human` (e.g. it is
  blocked, needs a decision, hit an error like a network outage, or finished and
  wants more work).
- Every alert has provenance (task + agent + time). Agents can record alerts but
  cannot acknowledge or delete them — that is human-only.
- To acknowledge one: `agentklar alerts ack <id>` (or click Acknowledge in the
  UI at `agentklar open ui` → Alerts).
- To see them graphically: `agentklar open ui` and open the Alerts tab.

If there are pending **block/error** alerts, surface them prominently and ask
the user how they want to proceed.
