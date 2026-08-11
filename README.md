# Agentklar

**One control center for AI-assisted software delivery.**

[![CI](https://github.com/kaltstart-co/agentklar/actions/workflows/ci.yml/badge.svg)](https://github.com/kaltstart-co/agentklar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Site](https://img.shields.io/badge/site-agentklar.kaltstart.co-2A55D8.svg)](https://agentklar.kaltstart.co)

Agentklar is a local-first control plane for Codex, Claude Code, OpenCode,
Gemini CLI, Cursor, and other MCP clients. It gives a human one native,
multi-project view of work while keeping each project's workflow state,
evidence, memory, and context isolated.

Agents can plan, claim, implement, review, and run declared checks. Only a
human can move work to Done.

Website: **[agentklar.kaltstart.co](https://agentklar.kaltstart.co)** · a
[Kaltstart](https://kaltstart.co) project.

## Install or update

Run the same command for a first install or an update on macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s --
```

The installer downloads the newest GitHub Release for your platform, verifies
its SHA-256 checksum, checks the binary, stages it, and atomically replaces the
installed executable. Existing project data under `~/.local/share/agentklar`
is not modified.

Useful options:

```bash
# Install the binary without wiring agent skills or MCP instructions
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s -- --no-agents

# Use the Go toolchain path instead of a release archive
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s -- --with-go
```

For a custom binary directory, set `AGENTKLAR_INSTALL_DIR` before `bash`:

```bash
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | AGENTKLAR_INSTALL_DIR=/path/to/bin bash -s --
```

## Five-minute setup

```bash
cd /path/to/your/repository

agentklar init
# Review .agentklar/quality.toml. Agentklar runs only recipes declared there.

agentklar mcp install --client codex
# Add the printed snippet to your MCP client, then restart that client.

agentklar ui --open
```

`agentklar ui --open` opens a human browser session for the control center.
Keep that terminal running and press Ctrl-C to stop it.

Create and shape work in the UI, or use the CLI:

```bash
agentklar task new AK-1 "Fix the parser" \
  --lane standard \
  --criteria "handles empty input;tests pass" \
  --verify "go test ./..."
agentklar task ready AK-1
```

The agent then follows the MCP workflow:

```text
list_ready_tasks → claim_task → work → submit_for_review
```

Run the declared gate and make the final decision in the local UI:

```bash
agentklar gate AK-1
```

See the complete [Setup & Usage guide](docs/USAGE.md).

## The control center

One server shows every repository registered by `agentklar init`:

- **Overview** — project-level attention, approval, and alert counts.
- **Board** — create, edit, filter, move, reorder, and archive tasks. Planning
  fields include priority, assignee, labels, due date, lane, isolation target,
  acceptance criteria, verification, and dependencies.
- **Task record** — objective, evidence, reviews, timeline, dependencies, and
  human comments.
- **Approvals** — one cross-project queue for approving or requesting changes.
- **Intelligence** — project knowledge, shared memory, and focused context
  search, with provenance kept visible.
- **Alerts** — agent-raised events that only a human can acknowledge.

Drag-and-drop is optional: every permitted move also has a keyboard-accessible
**Move to** control. The server always validates the workflow transition; the
browser cannot bypass protected state.

### Local trust boundary

The UI listens on loopback only. Starting it without `--open` creates a
read-only server:

```bash
agentklar ui
```

`agentklar ui --open` sends an unprinted, one-use bootstrap capability directly
to the browser. The server exchanges it for an HttpOnly, SameSite=Strict human
session cookie. Mutations also require an exact-origin request. An approval
form token is bound to the project, task, live submission, and current approval
nonce.

Agentklar does not promise a remotely hosted or multi-user trust boundary. Do
not expose the local UI through a tunnel or public listener.

## Workflow guarantees

```text
Draft → Ready → In Progress → Completion Review → Auto QA
      → User Approval → Done
             ↘ Changes Requested
```

- **Definition of Ready** — Ready requires acceptance criteria and a
  verification method.
- **Atomic claims with fencing** — one worker wins a claim; a stale worker
  cannot mutate protected state.
- **Machine-attested evidence** — Agentklar records the command, working
  directory, exit code, timestamps, retained log, and artifact hash for each
  declared recipe it runs.
- **Human-only Done** — the agent MCP surface has no approve, reject, or done
  method. A valid human decision is bound to the current review snapshot.
- **Declared checks only** — acceptance-criteria prose is never translated into
  shell commands. The gate runs only `.agentklar/quality.toml` recipes.

The terminal commands `agentklar approve` and `agentklar reject` remain
development conveniences. They warn that a shell-capable agent could invoke
them; use the `agentklar ui --open` browser session for the protected local
human channel.

## Data model

Agentklar uses a small global catalog and federated project stores:

```text
~/.local/share/agentklar/catalog.sqlite
  ├── project A → workspace A/control.sqlite, memory.sqlite, context.sqlite
  ├── project B → workspace B/control.sqlite, memory.sqlite, context.sqlite
  └── project C → workspace C/control.sqlite, memory.sqlite, context.sqlite
```

The catalog maps a stable project ID to its repository and workspace. It does
not merge task databases, so task IDs may repeat safely across projects.
Agents remain project-bound: each MCP server resolves the repository from the
working directory in which it was launched. The human control center can read
all registered projects.

In-repo knowledge lives at `.agentklar/knowledge/` so it can be reviewed and
versioned with the code. Protected workflow state stays in `control.sqlite`;
memory and context are separate project-scoped stores.

## Architecture

One Go binary, the standard library, and SQLite provide the product surface.

| Package | Responsibility |
|---|---|
| `internal/catalog` | Global project registry and collision-safe workspace lookup |
| `internal/contracts` | State machine, transition table, MCP method allowlist, evidence provenance |
| `internal/store` | Per-project `control.sqlite` protected workflow state |
| `internal/workflow` | Tasks, planning metadata, dependencies, claims, leases, fencing, submissions, approvals |
| `internal/quality` | Declared recipe parsing and machine-attested execution |
| `internal/gate` | Completion Review, Auto QA, and Slop Guard |
| `internal/ui` | Embedded multi-project control center, local human session, HTML and JSON APIs |
| `internal/knowledge` | Git-versioned project decisions, conventions, glossary, and runbook |
| `internal/memory` | Project-scoped, provenance-bearing FTS5 memory |
| `internal/context` | Rebuildable FTS5 projection of knowledge, memory, tickets, and code |
| `internal/notify` | Project alert log and best-effort local delivery |
| `internal/mcp` | Project-bound agent JSON-RPC surface with no approval method |
| `internal/tracker/vikunja` | Optional legacy Vikunja projection and comment reconciliation |

## Optional Vikunja integration

The native control center needs no external service. Existing Vikunja users may
keep a board as an optional projection:

```bash
agentklar tracker connect \
  --url http://localhost:3456/api/v1 \
  --svc-user agentklar-bot --svc-pass '******' \
  --human you
agentklar tracker sync
```

Vikunja does not own protected workflow state. Moving a projected card is only
a transition request, and human comment approvals are checked against the live
submission and nonce before they take effect.

## Verify and contribute

Tests are the executable specification for the completion boundary:

```bash
go build ./...
go test ./...
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities through
[SECURITY.md](SECURITY.md).

Design records live under [`docs/superpowers/specs/`](docs/superpowers/specs/)
and implementation plans under
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## License

[MIT](LICENSE) © 2026 Kaltstart · [kaltstart.co](https://kaltstart.co)
