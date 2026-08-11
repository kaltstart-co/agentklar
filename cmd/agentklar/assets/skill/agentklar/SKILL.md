---
name: agentklar
description: Use when the user mentions tracked coding tasks, "what's done", task boards, pending approvals, Definition of Done, shared memory/knowledge across agents, or running quality gates. Drives the `agentklar` CLI, its MCP server, and the native web UI — but never to approve a task. Covers the Draft→Ready→In Progress→Review→QA→Approval→Done workflow, the human-only completion boundary, shared knowledge/memory/context for multi-agent work, the native UI, the optional Vikunja board, and the interrogator→task import bridge. Triggers on "agentklar", "/agentklar", "is this done", "what needs my approval", "open the board/UI", "remember/recall".
license: MIT
---

# Agentklar — agents that know what done means

Agentklar is a local control plane layered over your coding agent (you keep
OpenCode / Codex / Claude / Cursor). It adds durable task tracking,
machine-attested evidence, and a **human-only completion boundary**. You
(the human) are the only thing that can move a task to Done.

## The workflow (every task)

```
Draft → Ready → In Progress → Completion Review → Auto QA → User Approval → Done
```

- **Draft** — task exists. Not claimable.
- **Ready** — has acceptance criteria AND a verification method (Definition of
  Ready). An agent may now `claim_task`.
- **In Progress** — an agent has claimed it under an atomic lease.
- **Completion Review → Auto QA** — the gate runs the project's declared
  quality recipes (`go test`, lint, …) and records machine-attested evidence
  (command, exit code, log hash). Model claims are never mistaken for results.
- **User Approval** — waiting on a human. **No agent method reaches Done.**
- **Done** — only a nonce-bound human approval gets here.

## The one rule you must never forget

**You (the agent) cannot approve, reject, or mark a task done.** The MCP
surface exposes no such method. If the user asks you to approve or finish a
task, tell them it requires their action, and surface the pending approval
(`agentklar status` shows it, or `request_approval_presentation` over MCP).
The approval nonce is never returned to you.

## How to drive it

Prefer the **CLI** (`agentklar …`) for one-shot actions from a shell, and the
**MCP server** for live agent integration. Both are installed globally.

### Status & discovery
- `agentklar status` — one glance: task counts, what's waiting on the human, board link.
- `agentklar doctor` — technical health: declared recipes, missing commands.
- `agentklar task list` / `task show <id>` — list tasks / show one with evidence.

### Shaping work
- `agentklar task new <id> <title> --criteria "a;b;c" --verify "go test ./..." --lane quick|standard|major`
- `agentklar task ready <id>` — blocked until criteria + verify are present (DoR).
- **From an interrogator spec:** `agentklar task import <ticket.md>` turns a
  Jira-style ticket (with Definition of Done + Verification Steps) into a task
  that satisfies DoR by construction. `task import-plan <project-dir>` imports
  a whole project's dev-task tickets and computes parallel execution waves.

### Doing the work (agent side, over MCP)
`list_ready_tasks` → `claim_task` → work → `heartbeat_task` (keep lease alive)
→ `submit_for_review` with the commit range. Then a human runs the gate.

### The gate (human/system)
`agentklar gate <id>` — runs declared recipes, stores attested evidence,
advances the state machine. Recipes live in `.agentklar/quality.toml` and are
scoped by changed path; **only declared recipes run**. `task import` writes
*draft* proposals to `.agentklar/quality.proposed.toml` — the gate never loads
that file; the human copies accepted ones into `quality.toml`.

### Approving (human only)
- `agentklar approve <id>` — dev CLI shortcut (not agent-proof; prints a warning).
- Trusted channel: comment `approve <nonce>` on the Vikunja card as yourself,
  then `agentklar reconcile`.

### Shared knowledge (multi-agent memory)
When several agents work the same project, they share context through three layers — all human-visible, all with provenance:
- `agentklar knowledge decide "<title>" --decision "..."` — writes an ADR to `.agentklar/knowledge/` (in-repo, git-versioned). `knowledge list|show`.
- `agentklar memory remember <key> --value "..."` — shared `memory.sqlite` (FTS5); `memory search`; **human-only `memory forget`**.
- `agentklar context index` then `context search "<q>"` — focused work packets across knowledge + memory.
- Over MCP: `remember {namespace,key,value}`, `recall {query}`, `get_context {task_id|query}`.

### Alert the human (voice + logged)
When you are **blocked**, need a decision, hit an error (e.g. network down), or
finished and want more work, call `notify_human {severity, message, task_id?}`.
It logs the alert (with provenance) and, by default for warn/error/block, speaks
it aloud and shows a banner. Severity: `info | warn | error | block`.
- The human sees it in `agentklar alerts`, the UI (Alerts tab), and `status`.
- Acknowledging is **human-only** — you cannot silence alerts you raised.
- Use it sparingly and with a clear, actionable message.

Everything an agent knows, the human can see (Transparency). Never claim a fact the gate or memory hasn't recorded.

### Board & UI
- `agentklar open ui` (or `agentklar ui`) — the **native local web UI**: Board, Knowledge, Memory, Context, Evidence, Approvals. This is the default; no external service needed. The Approve button there is a trusted human channel.
- `agentklar open board` — open a connected Vikunja board (optional).
- `agentklar open app` — launch the macOS menu-bar widget (approval badge).
- `agentklar open workspace|config|quality|knowledge|docs` — reveal those paths.
- Vikunja is **optional** (one backend behind the tracker interface). The core loop runs fully without it.
- `agentklar tracker connect …` — optionally bind a Vikunja project; `agentklar tracker sync` to re-project.

## Slash commands (opencode / Claude Code)
`/agentklar` (status + help), `/agentklar-task <idea>`, `/agentklar-board`,
`/agentklar-approvals`, `/agentklar-doctor`.

## When to ask vs act
- If a task lacks criteria or a verify method, **do not** invent them — ask the
  user, or run the interrogator to produce a real spec.
- Never claim a task is "done" or "passing" from your own belief — point at the
  gate's machine-attested evidence (`task show <id>`), or run `agentklar gate`.
- Never call shell commands the project hasn't declared in `quality.toml`.

## Install (if `agentklar` is not on PATH)
```bash
# one line (macOS/Linux):
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s --
# custom install directory:
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | AGENTKLAR_INSTALL_DIR=/path/to/bin bash -s --
# or with Go:
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s -- --with-go
agentklar install --agents opencode,claude,codex   # skill + slash commands + MCP
```

To update Agentklar and its embedded UI, rerun the one-line installer. The
project catalog and workspace SQLite files in `~/.local/share/agentklar` are
preserved. Use `bash -s -- --no-agents` to skip rewiring agent integrations.
