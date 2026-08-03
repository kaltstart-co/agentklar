---
name: agentklar
description: Use when the user mentions tracked coding tasks, "what's done", task boards, pending approvals, Definition of Done, or running quality gates. Drives the `agentklar` CLI and its MCP server to shape, claim, submit, and gate work — but never to approve it. Covers the Draft→Ready→In Progress→Review→QA→Approval→Done workflow, the human-only completion boundary, the Vikunja board, and the interrogator→task import bridge. Triggers on "agentklar", "/agentklar", "is this done", "what needs my approval", "open the board".
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

### Board & UI
- `agentklar open board` — open the Vikunja board in your browser.
- `agentklar open app` — launch the macOS menu-bar widget (approval badge).
- `agentklar open workspace|config|quality` — reveal those paths.
- `agentklar tracker connect …` — bind a Vikunja project (creates the 8 workflow columns).
- `agentklar tracker sync` — force every card to match its state.

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
git clone https://github.com/kaltstart-co/agentklar && cd agentklar
go build -o ~/.local/bin/agentklar ./cmd/agentklar
agentklar mcp install --client opencode   # or codex | generic
```
