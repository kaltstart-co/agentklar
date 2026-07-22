# Agentklar

**Agents that know what done means.**

A local-first, agent-neutral toolkit that adds durable work tracking, machine-attested
evidence, and a human-controlled completion boundary to AI-assisted development. You keep
your own coding agent — Codex, Claude Code, OpenCode, Gemini CLI. Agentklar supplies the
workflow contracts those agents lack.

> **Status: Phase 0/1 development slice.** Not installable yet. There is no signed release,
> no installer, and no Vikunja integration wired to a live server. Per the delivery plan,
> distribution work begins only after the workflow survives a dogfood pilot.

## What works today

The complete Quick-lane workflow, end to end:

```
Draft → Ready → In Progress → Completion Review → Auto QA → User Approval → Done
```

- **Definition of Ready** — a task without acceptance criteria and a verification method
  cannot become Ready, so an agent can never claim underspecified work.
- **Atomic claims with fencing** — concurrent claims produce exactly one winner. A
  superseded worker cannot mutate protected state after another has claimed.
- **Repository isolation** — Quick tasks may use the primary worktree under an *exclusive*
  repository lease; a second concurrent code claim is rejected. Standard/Major tasks get
  dedicated worktrees.
- **Machine-attested evidence** — Agentklar itself executes declared recipes and records
  command, working directory, exit code, timestamps, and a SHA-256 of the retained log.
  Model claims are never mistaken for verified results.
- **Deterministic completion gate** — project recipes plus objective Slop Guard rules
  (placeholder code, silenced errors, skipped tests, bypassed checks). Quick work uses one
  runner invocation for both Completion Review and Auto QA — zero extra model calls.
- **Human-only Done** — the agent-facing MCP surface exposes no approve, reject, or done
  method. Approval requires a nonce bound to the exact review snapshot, and the nonce is
  never returned to the model.

## The completion boundary

This is the property the whole design exists to protect. An agent asking to approve gets:

```json
{"error":{"code":-32601,"message":"approval and completion are not agent-callable;
  a human must approve through a trusted channel"}}
```

An agent may ask Agentklar to *surface* a pending approval, but receives only an
instruction to ask the user — never the nonce.

The shipped trusted channel is a nonce-bound comment written by a human tracker account
whose credentials Agentklar never stores and never exposes to agent processes. The dev CLI
`approve` command is **not** agent-proof (an agent with shell access could invoke it) and
prints that warning on every use.

## Quick start (development)

```bash
go build -o agentklar ./cmd/agentklar
./agentklar init                 # creates the workspace and proposes quality.toml

./agentklar task new AK-1 Fix the parser \
    --lane quick \
    --criteria "parser handles empty input;tests pass" \
    --verify "go test ./..."
./agentklar task ready AK-1

# An agent claims and submits over MCP stdio:
echo '{"jsonrpc":"2.0","id":1,"method":"claim_task",
       "params":{"task_id":"AK-1","expected_state":"ready","holder":"claude-code"}}' \
  | ./agentklar mcp

./agentklar gate AK-1             # runs recipes, records evidence, advances state
./agentklar approve AK-1          # human channel (dev only)
./agentklar doctor                # health, declared recipes, missing commands
```

### With a live Vikunja board (optional)

Connect a local [Vikunja](https://vikunja.io) instance so tasks project onto a real
Kanban board and approval happens as a comment from your own account — the shipped
trusted channel, not the dev `approve` shortcut.

```bash
# one dedicated service account writes the board; you approve as yourself
./agentklar tracker connect \
    --url http://localhost:3456/api/v1 \
    --svc-user agentklar-svc --svc-pass '******' \
    --human you

# after the gate posts its prompt, comment "approve <nonce>" in Vikunja as yourself,
# then apply the decision:
./agentklar reconcile             # reads comments, applies a valid human approval → done
```

Agentklar writes projections through the service account and can **never** approve with
it. Only a comment authored by your human account, carrying the task's live nonce, moves a
task to `done`. This path is covered by live integration tests
(`internal/tracker/vikunja/integration_test.go`) that run against a real Vikunja server.

Quality recipes are declared by the project in `.agentklar/quality.toml`. Agentklar runs
only what is declared — it never infers that an absent command exists, and never turns
acceptance-criteria prose into shell commands.

```toml
[[recipe]]
name = "unit"
level = "L1"                 # L0 inspect, L1 unit, L2 integration, L3 system
command = "go"
args = ["test", "./..."]
timeout_seconds = 300
scopes = ["internal/"]       # changed-path prefixes this recipe covers
```

## Architecture

One Go control-plane binary. It composes existing tools rather than replacing them.

| Package | Responsibility |
|---|---|
| `internal/contracts` | Frozen state machine, transition table, MCP method list, evidence provenance |
| `internal/store` | `control.sqlite` — protected workflow state only |
| `internal/workflow` | Claims, leases, fencing, idempotency, stale-commit invalidation, approvals |
| `internal/quality` | Recipe parsing and execution with attestation |
| `internal/gate` | Completion Review + Auto QA pipeline, Slop Guard |
| `internal/tracker` | Field authority, nonce-bound approval parsing, echo suppression |
| `internal/tracker/vikunja` | Live Vikunja REST adapter + approval reconciliation |
| `internal/mcp` | Agent-facing JSON-RPC surface (no approval method) |

**Field authority is split, never duplicated.** The tracker owns task content, assignees,
comments, and attachments. `control.sqlite` owns protected workflow state, leases,
evidence attestations, review snapshots, and approvals. Tracker buckets are a *projection*
of protected state — moving a card is a transition *request*, never an approval.

## Tests

Every guarantee above is an executable test, not a claim in a document:

```bash
go test ./...
```

Notable cases: `TestConcurrentClaimsExactlyOneWinner`, `TestStaleFencingTokenRejected`,
`TestQuickAutoExclusiveRepositoryLease`, `TestStaleSubmissionCannotBeReviewed`,
`TestHumanOnlyDoneRequiresValidNonce`, `TestNoAgentTransitionIntoDone`,
`TestNoApprovalMethodOnAgentSurface`, `TestApprovalPresentationWithholdsNonce`,
`TestServiceAccountCannotApprove`, `TestSlopGuardIgnoresOrdinaryCode`.

## Not yet built

Webhook push reconciliation (polling + `reconcile` works today); cross-provider reviewer
adapters and disposable review snapshots; FTS5 context indexing and work packets;
established-project onboarding; mdBook catalogue; the community pack library; installer,
signed releases, and staged updates.

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the phased
delivery plan.

## Design documents

- [Design spec](docs/superpowers/specs/2026-07-15-agentic-sdlc-quality-toolkit-design.md)
- [Master delivery plan](docs/superpowers/plans/2026-07-17-agentklar-master-delivery-plan.md)
- [Community library plan](docs/superpowers/plans/2026-07-21-agentklar-community-library-plan.md)

Published by Kaltstart.
