---
name: agentklar
description: Coordinate explicitly tracked AgentKlar work through its CLI, MCP tools, local native-worker supervisor, and support interface. Use when the user names AgentKlar or asks to manage work already tracked in AgentKlar.
license: MIT
---

# Agentklar — agents that know what done means

Agentklar is a local control plane layered over your coding agent (you keep
OpenCode / Codex / Claude / Cursor). It adds durable task tracking,
machine-attested evidence, and a **human-only completion boundary**. You
(the human) are the only thing that can move a task to Done.

## The workflow (opted-in AgentKlar tasks)

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

Ordinary native conversations and work can continue without AgentKlar tracking. This skill applies to the opted-in tasks described below.

## How to drive it

Prefer the **CLI** (`agentklar …`) for one-shot actions from a shell, and the
**MCP server** for live agent integration. Use whichever is available in this installation.

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

### Delegating to a native worker
Read `get_team_policy`, `list_harnesses`, and `get_model_catalog` before choosing
an adapter. Discovery proves a version probe; a model catalog does not prove
account access. Native credentials and permissions stay with the native tool.
Only Codex app-server runs workers in this slice.

For opted-in tracked delegation, call `recommend_worker` with `task_id`, the
saved `role_id` when applicable, `required_capabilities`, and the current
`{harness,model}` before choosing a worker. Read its `action`, `reason`, sources,
and missing evidence. `keep_current` preserves the choice; `nominate_worker`
uses an explicit task pin or saved role preference/unique allowed fallback as a limited-confidence proposal;
`no_recommendation` means the missing evidence or requirements need attention.
A nomination is not verified entitlement or a quality guarantee. Native launch
still checks access, billing, limits, and permissions. No recommendation launches
work or changes billing. The CLI equivalent is `agentklar team recommend <request.json>`.
`task_kind` (such as `coding`) describes the task, not tested coding quality.
`required_capabilities` names concrete inputs or operations: the current run
adapter accepts `text`; `image` and `audio` cannot currently be delegated.
Other operations have no verified capability observation yet.

For a claimed task, `start_run` needs a stable retry `id`, task ID, claim holder,
fencing token, and bounded instructions. Repeat the exact request on retry;
changing its payload requires a new ID. Read `get_run` for events, output, and
native permission requests. The supervisor keeps the run when a caller MCP
connection closes. `cancel_run` requires current claim ownership.

After `get_run`, read `get_completion_packet {task_id}` (CLI: `agentklar task
packet <id>`) for recorded checks, reviews, native results, and remaining work.
Native completion is separate from task approval. Worker summaries and error
text are reports, not verification evidence. The packet does not run checks.

Editing currently requires a quick/auto task with an exclusive primary claim.
A dedicated isolation label does not create a real worktree. Review runs must
set `read_only=true`. Native command/file permission decisions require a human
in `agentklar serve --open`; no agent tool answers them. Unsupported native
input requests stop with an explicit error. A completed run has not approved
the task: verify and submit through the existing task workflow.

`get_usage` returns sourced quota/token snapshots, registered-thread usage, and
estimated or unknown spend. Shared account usage is not project consumption.
Interrupted supervisor runs do not automatically reattach or relaunch.

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
- `agentklar serve --open` — the native-worker supervisor and Work/Team/Usage/Settings interface. Keep it running. `agentklar runs discover` probes installed tools. `agentklar runs open` opens the same trusted interface later.
- `agentklar ui --open` — the standalone **local web UI**: Board, Knowledge, Memory, Context, Evidence, Approvals. This is the default; no external service needed. The Approve button there is a trusted human channel.
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
- For AgentKlar verification evidence, run the declared `quality.toml` recipes through the gate. Ordinary native work can use its normal tools and authorized commands.

## Current source setup
The new supervisor/support UI may be newer than the latest released binary.
Follow the source build in the repository README: `npm ci --prefix web`,
`npm run build:local --prefix web`, then `go build -o agentklar ./cmd/agentklar`.
Use its absolute executable path for `serve`, `runs`, and MCP wiring. Install
skill/MCP assets only when the user requests that setup. Existing native config
and credentials remain authoritative.
