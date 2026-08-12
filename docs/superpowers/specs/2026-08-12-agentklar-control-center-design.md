# Agentklar Control Center Design

**Date:** 2026-08-12
**Status:** Approved from the user's supplied product brief
**Owner:** Kaltstart

## Product decision

Agentklar becomes one professional control center for people and coding agents.
It owns its project catalog, board, task workflow, evidence, approvals, memory,
and context. Vikunja remains a legacy optional adapter, not a setup requirement
or primary user experience.

The first release stays a single Go binary with embedded HTML, CSS, and vanilla
JavaScript. It works locally without a service dependency and binds only to
loopback. Shared-network deployment and team identity are outside this release.
We will not add React, a frontend build chain, or a new runtime dependency.

## Alternatives considered

### 1. Merge every project into one global workflow database

This makes aggregate queries easy, but existing task IDs are only unique within
a project. Evidence, leases, approvals, reviews, and comments all reference
those IDs. A merge introduces collision and audit-migration risk.

### 2. Keep one isolated UI per repository

This preserves the current storage model but fails the core requirement: a
company cannot see or switch between all projects from one application.

### 3. Global catalog with federated project workspaces — selected

A small global catalog records projects and their workspace paths. Each
project's existing `control.sqlite`, `memory.sqlite`, and `context.sqlite`
remain authoritative. The UI aggregates scoped references as
`project_id/task_id`. Existing workspaces are registered in place, so upgrades
do not rewrite protected history.

## Information architecture

The application shell has a permanent project switcher and five primary areas:

- **Overview:** all-project counts, attention queue, and recent projects.
- **Board:** one selected project's tasks, filters, create/edit, drag/reorder,
  and keyboard-accessible movement.
- **Approvals:** evidence-first human review across projects.
- **Intelligence:** project knowledge, agent memory, and context search with
  explicit project/task scope and provenance.
- **Alerts:** pending-first operational messages across projects.

Desktop uses a left navigation rail and wide horizontal board. Mobile uses a
compact top bar, a project selector, and a horizontally scrollable board. State
is communicated by text and color. All interactive controls have focus rings,
44-pixel touch targets, reduced-motion support, and non-drag alternatives.

## Project catalog and compatibility

The catalog lives at `~/.local/share/agentklar/catalog.sqlite`:

```sql
projects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
)
```

Project IDs are a stable short SHA-256 of the canonical repository path. On the
first run after upgrade, Agentklar checks the old basename workspace. If its
tasks belong to the current repository, the catalog registers it in place. A
new repository or a basename collision gets a hashed workspace directory.

`agentklar init`, `status`, `ui`, and `mcp` register or refresh the current
project. The UI opens the global catalog. MCP remains bound to the repository
where the agent started, preventing accidental cross-project claims.

## Task model and board behavior

Existing protected state remains authoritative. Versioned SQLite migrations
add only the planning fields required for a usable company board:

- priority: `low`, `medium`, `high`, `urgent`
- assignee: free text for a person or agent identity
- labels: JSON string array
- due date: optional ISO date
- position: stable numeric ordering within a workflow state
- archived timestamp
- dependencies: project-local task-to-task edges

The workflow engine owns create, update, reorder, comment, ready, reject, and
cancel operations. The UI never writes SQLite directly.

Drag-and-drop reorders freely inside a state. Cross-state drops invoke a real
allowed transition; they never assign `state` directly. Locked system states
explain why a drop is not allowed. Done is never a valid drop target; approval
review remains a separate human-only action. A “Move to” menu offers the same
actions by keyboard and on touch devices.

All workflow states remain visible. Waiting, Blocked, and Cancelled can be
collapsed into an “Exceptions” planning column while retaining their exact
machine-state badge.

## HTTP surface

The local server exposes scoped JSON endpoints used by the embedded UI:

- `GET /api/projects`
- `GET /api/overview`
- `GET /api/projects/{project}/tasks`
- `POST /api/projects/{project}/tasks`
- `PATCH /api/projects/{project}/tasks/{task}`
- `POST /api/projects/{project}/tasks/{task}/transition`
- `POST /api/projects/{project}/tasks/{task}/position`
- `POST /api/projects/{project}/tasks/{task}/comments`
- `GET /api/projects/{project}/memory`
- `GET /api/projects/{project}/context`
- `POST /api/projects/{project}/context/reindex`
- human review endpoints for approve and request-changes

Task mutation endpoints accept bounded JSON, validate enum fields, and return
structured errors. Browser mutations require the one-use-bootstrapped human
session plus an exact Origin; approval forms additionally use an HMAC token
bound to the project, task, submission, and nonce. Approval nonces are never
returned by JSON. The server rejects non-loopback listeners and is not a
network service in this release.

## Agent integration

The MCP tool list remains intentionally project-bound. Its published schemas
must exactly match dispatch inputs, including fencing tokens, commit ranges,
submission IDs, providers, findings, comment type, recall limits, and alert
options. A contract test will compare schema properties with a successful
round trip for each state-changing tool.

The agent surface still exposes no approve, reject, or Done operation.

## Knowledge, memory, and context

Agentklar follows the same useful split documented by Codex and Claude Code:

- checked-in project knowledge holds rules, decisions, architecture, and
  conventions that humans expect every agent to see;
- generated memory holds learnings and patterns with project, task, holder,
  source, and timestamp provenance;
- the derived context index retrieves only relevant excerpts on demand.

Memory is always scoped through the selected project and may be narrowed by
source task. The project switcher is explicit human control; agents never merge
context across projects. Remembering a fact immediately updates its context
document. Humans can inspect and forget memory; agents can remember and recall
but cannot delete. The UI shows when the code/context index was rebuilt and
provides a reindex action.

## Installation, upgrades, and releases

The compatibility update path is re-running the one-line installer. The
installer downloads a release and checksum to a temporary directory, verifies
the archive, validates the staged binary with `version`, then replaces the
installed binary. Workspace databases are outside the install directory and
remain in place.

The release documentation must show:

```bash
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s --
```

The first control-center release is `v0.0.1-beta.8`. A tag triggers GoReleaser;
changes under `docs/site` trigger GitHub Pages. Release verification covers all
four archives, checksums, a clean install, an upgrade over a legacy workspace,
and the live site.

## Landing page

The site leads with the product rather than a terminal demo: one workspace,
every project, agents and people sharing a workflow, evidence before approval.
It includes an embedded product board visual, core capabilities, loopback-only
local positioning, install/update commands, and a clear note that Vikunja is
optional legacy integration.

## Verification

- migration test from the pre-control-center schema
- catalog collision and legacy-registration tests
- workflow tests for CRUD, dependencies, reorder, and allowed transitions
- MCP schema/dispatch contract tests
- HTTP tests for project scoping, validation, CSRF/origin behavior, nonce
  redaction, create/edit/reorder, request changes, memory, and context reindex
- rendered desktop and mobile browser checks
- `gofmt`, `go vet ./...`, `go build ./...`, `go test ./...`
- Agentklar gate evidence for the release task before human approval

## Explicit non-goals for this release

- replacing SQLite with a network database
- building team accounts, billing, or organization administration
- shared-network deployment or team identity
- arbitrary human bypasses of agent/system workflow states
- deleting protected task history
