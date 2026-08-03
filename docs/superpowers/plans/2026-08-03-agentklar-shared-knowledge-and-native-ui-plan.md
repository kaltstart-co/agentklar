# Agentklar Shared Knowledge, Memory & Native UI — Design Plan

**Status:** Proposed. Extends the master delivery plan; supersedes the
"Vikunja as the UI" assumption in the Phase 0/1 slice.
**Date:** 2026-08-03

## Goal

When several agents work the same project in parallel — each claiming tickets
out of a shared backlog — they need a **shared, durable, human-visible** record
of decisions, facts, and context. Today Agentklar shares *state* (atomic claims,
fencing, evidence) but not *knowledge*. This plan adds the knowledge layer and,
with it, replaces the external Vikunja dependency with a **native, unified,
AI-usable UI**.

## New design principle: Transparency

> Everything an agent knows, the human can see. There is no hidden agent memory.

This sits beside the existing defining property (human-only completion). It
means: every memory, decision, and context row has **provenance** (task,
holder, timestamp), is inspectable via CLI/UI, and can be **deleted only by a
human**. Agents cannot hide their own tracks.

## Decision: native UI replaces Vikunja

Vikunja was the Phase 0/1 UI shortcut. To make Agentklar zero-dependency and
fully own its surface, the tracker becomes **pluggable and optional**, and a
native local UI becomes the default. Work phases:

1. Build the native UI against Agentklar's own stores (this plan).
2. Make the Vikunja adapter one optional backend behind a tracker interface.
3. Move task-content authority (title, comments, attachments) in-house.
4. Replace the Vikunja-comment approval channel with a **nonce-bound click in
   the native UI** — still a trusted human channel, still no agent path to Done.

Field authority stays split: `control.sqlite` owns protected workflow state;
the new stores own knowledge/memory/context; the repo owns versioned docs.

## The knowledge model

| Layer | What | Lives in | Writes | Human sees it via |
|---|---|---|---|---|
| 1. Project knowledge | decisions (ADRs), conventions, glossary, runbook | **repo**: `.agentklar/knowledge/*.md` | agents append; human reviews in git + gate | `agentklar open knowledge`; renders anywhere |
| 2. Shared memory | cross-session facts, gotchas | **workspace**: `memory.sqlite` (FTS5) | agents `remember`; **human-only `forget`** | `agentklar memory` CLI; UI Memory view |
| 3. Context index | ranked search over knowledge+memory+code+tickets | **workspace**: `context.sqlite` (FTS5) | Agentklar indexes | work packet on claim; UI Context view |
| 4. Docs | per-epic docs (interrogator-mandated) | **repo**: `docs/` | agents | `agentklar open docs` |

## Storage & authority (each subsystem owns its storage — no shared-schema conflicts)

| Package | DB | Opened by | Notes |
|---|---|---|---|
| `internal/store` (exists) | `control.sqlite` | `store.Open(path)` | unchanged protected state |
| `internal/knowledge` (new) | none — files | `knowledge.New(repoRoot)` | manages `.agentklar/knowledge/` |
| `internal/memory` (new) | `memory.sqlite` | `memory.New(workspaceDir)` | owns its schema; provenance per row |
| `internal/context` (new) | `context.sqlite` | `context.New(workspaceDir)` | FTS5; indexes layers 1/2 + repo + tickets |
| `internal/ui` (new) | none — reads | `ui.New(...)` | local HTTP server; embeds templates |

Each new package is dependency-free apart from stdlib + `modernc.org/sqlite`.
This keeps the packages **independently buildable and parallelizable**.

## MCP surface additions (agent-callable; none touches Done)

- `get_context { task_id? , query }` — returns a focused work packet (ticket +
  top decisions + top memory + code pointers). Replaces "agent re-reads repo".
- `remember { namespace, key, value }` — write a memory row (provenance stamped
  from the active claim).
- `recall { query }` — FTS5 search over memory + knowledge.

**Human-only** (never on MCP): `memory forget`, and the approval click in the
native UI. `contracts.ForbiddenMCPMethods` is unchanged; `MCPMethods` grows by
the three above.

## Multi-agent coordination

Already guaranteed: atomic claims (exactly one winner), fencing tokens, and
worktree isolation (`TestConcurrentClaimsExactlyOneWinner`). The gap this plan
closes is **knowledge**, not coordination:

- On claim, the agent receives a work packet from the context index.
- During work it appends decisions (ADRs) and memory, namespaced by task.
- ADRs are append-only files → git merges never conflict; memory rows are keyed
  by `(namespace, key)` with task-scoped namespaces → no write races.
- The human reviews new knowledge via git diffs (repo) and the UI (memory).

## UI design

- **Local-first**: `agentklar ui` starts a read-mostly HTTP server on localhost;
  `agentklar open ui` opens it. Templates embedded in the binary (`embed`).
- **One place, all views**: Board (tasks/states), Knowledge, Memory, Context
  search, Evidence, Approvals. Only what's needed — no bloat.
- **AI-usable**: every view is a projection of data equally reachable via CLI
  and MCP. The UI never becomes the only path to anything.
- **Approval = trusted channel**: a click in the local UI submits the task's
  live nonce over localhost. This preserves the human-only-Done boundary
  (agents have no MCP method, and the nonce is bound to the review snapshot).

## Phasing

- **A — Project knowledge:** `.agentklar/knowledge/` + ADRs + `open knowledge`.
- **B — Shared memory:** `internal/memory` + MCP `remember`/`recall` + `memory` CLI.
- **C — Context index:** `internal/context` + `get_context` work packets.
- **D — Native UI:** `internal/ui` + `agentklar ui`/`open ui`, all views.
- **E — Vikunja decoupling:** tracker interface, adapter optional, native approval.

## Parallelization (execution note)

Phases A/B/C are **disjoint greenfield packages** with their own storage — safe
to build concurrently. D depends on A/B/C's APIs (sequenced after). E is a
cross-cutting refactor over existing files — sequential, never parallelized,
and must not weaken the approval-boundary tests.
