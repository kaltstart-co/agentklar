# AGENTS.md

Guidance for AI coding agents (and humans) working **in this repository** — the
Agentklar source itself. If you are an agent trying to *use* Agentklar on your
own project, see [`docs/USAGE.md`](docs/USAGE.md) and run `agentklar --help`.

## What Agentklar is

A local-first, agent-neutral control plane that adds durable work tracking,
machine-attested evidence, and a **human-only completion boundary** to AI
coding. You keep your own agent (Codex, OpenCode, Gemini CLI, Cursor);
Agentklar supplies the workflow contracts those agents lack. One Go binary,
one SQLite file per repo for protected state, an optional Vikunja board for UI.

Workflow every task follows:

```
Draft → Ready → In Progress → Completion Review → Auto QA → User Approval → Done
```

The defining property: **an agent can never mark a task Done.** The MCP surface
exposes no approve/reject/done method. Only a nonce-bound human approval moves
a task to Done.

## Build, test, run

Requires Go 1.25+.

```bash
go build ./...                       # compile everything
go test ./...                        # run the full suite (every guarantee is a test)
go build -o agentklar ./cmd/agentklar
./agentklar init                     # create a workspace for this repo
./agentklar doctor                   # workspace health, declared recipes, task counts
```

Install the dev binary on your PATH:

```bash
go build -o ~/.local/bin/agentklar ./cmd/agentklar
```

There are no lint/test scripts beyond `go build`/`go test`. Run both before
claiming work is complete.

## Architecture

One control-plane binary that composes existing tools rather than replacing
them. Field authority is split, never duplicated.

| Package | Responsibility |
|---|---|
| `internal/contracts` | Frozen state machine, transition table, MCP method list, evidence provenance. Dependency-free; the authority every other layer conforms to. |
| `internal/store` | `control.sqlite` — protected workflow state only. |
| `internal/workflow` | Claims, leases, fencing tokens, idempotency, stale-commit invalidation, approvals. |
| `internal/quality` | Recipe parsing + execution with attestation. Only declared recipes run; prose is never translated to shell. |
| `internal/gate` | Completion Review + Auto QA pipeline, Slop Guard. |
| `internal/tracker` | Field authority, nonce-bound approval parsing, echo suppression. |
| `internal/tracker/vikunja` | Live Vikunja REST adapter + approval reconciliation. |
| `internal/ticket` | Parses interrogator-style ticket Markdown for `task import`. |
| `internal/mcp` | Agent-facing JSON-RPC surface (no approval method). |
| `cmd/agentklar` | The CLI. `cmd/agentklar-bar` is the macOS menu-bar widget. |

The tracker (Vikunja) owns task content, assignees, comments, attachments.
`control.sqlite` owns protected workflow state, leases, evidence attestations,
review snapshots, approvals. Tracker buckets are a *projection* of protected
state — moving a card is a transition *request*, never an approval.

## Contracts you must not break

These are enforced by executable tests. Changing them is a contract violation:

- **No agent transition into Done.** `contracts.Transitions` has no edge into
  `StateDone` with `ActorAgent`. `contracts.ForbiddenMCPMethods` lists the
  names that must never appear on the MCP surface.
- **Definition of Ready.** `workflow.MarkReady` rejects a task without both
  acceptance criteria and a verification method.
- **Only declared recipes run.** `internal/quality` never infers an absent
  command. `task import` writes proposed recipes to `quality.proposed.toml`
  (a sidecar the gate does **not** load) — never auto-enables them.
- **Atomic claims with fencing.** Concurrent claims produce exactly one
  winner; a stale fencing token can never mutate protected state.

## MCP methods an agent may call

`bind_workspace`, `list_ready_tasks`, `claim_task`, `heartbeat_task`,
`submit_for_review`, `record_review`, `record_qa`, `release_task`, `get_task`,
`add_comment`, `request_approval_presentation`. There is intentionally no
`approve` / `reject` / `done`.

## Conventions

- **Tests are the spec.** Every guarantee above has an executable test
  (e.g. `TestNoAgentTransitionIntoDone`, `TestConcurrentClaimsExactlyOneWinner`,
  `TestDefinitionOfReadyBlocksIncompleteTask`). Add a test for any new
  contract; do not weaken an existing one silently.
- **Minimal dependencies.** The tree depends on `BurntSushi/toml`, `menuet`,
  and `modernc.org/sqlite` only. Do not add a dependency for something stdlib
  + 50 lines can do (see `internal/ticket`'s hand-rolled frontmatter parser).
- **No commented-out code, no chatty comments.** Comments explain *why*.
- **Field authority is split.** Don't duplicate workflow state into the
  tracker or vice versa.

## Design & roadmap documents

- Design spec: `docs/superpowers/specs/2026-07-15-agentic-sdlc-quality-toolkit-design.md`
- Master delivery plan: `docs/superpowers/plans/2026-07-17-agentklar-master-delivery-plan.md`
- Community library plan (packs — the interrogator is the example
  `project-skill`): `docs/superpowers/plans/2026-07-21-agentklar-community-library-plan.md`

## License

MIT. See `LICENSE`.
