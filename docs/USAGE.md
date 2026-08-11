# Setup & Usage

Agentklar is one local binary with two deliberately different surfaces:

- Coding agents use a project-bound MCP server.
- A human uses one native, multi-project control center.

Vikunja is an optional legacy integration, not a requirement.

## 1. Install or update

Run this exact command on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s --
```

Rerun it whenever you want to update. The installer:

1. Selects the newest GitHub Release archive for the current OS and CPU.
2. Requires and verifies the matching SHA-256 entry in `checksums.txt`.
3. Rejects unexpected archive members and checks the staged binary.
4. Atomically replaces the installed executable only after those checks pass.
5. Attempts best-effort agent integration unless `--no-agents` is passed. It
   copies supported skill and command assets and registers MCP where the host
   CLI supports it; other clients still use `agentklar mcp install`. An
   integration failure does not roll back the installed binary.

It does not replace the catalog or project SQLite stores under
`~/.local/share/agentklar`.

Options:

```bash
# Binary only
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s -- --no-agents

# Use the Go toolchain path instead of a release archive
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash -s -- --with-go

# Use the same custom directory for installs and future updates
curl -fsSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | AGENTKLAR_INSTALL_DIR=/path/to/bin bash -s --
```

Make sure the install directory, normally `~/.local/bin`, is on `PATH`.

To build a development binary from source:

```bash
git clone https://github.com/kaltstart-co/agentklar
cd agentklar
go build -o agentklar ./cmd/agentklar
```

Use `./agentklar` in place of `agentklar` in the examples below.

## 2. Register a project

Run Agentklar inside each repository you want in the control center:

```bash
cd /path/to/repository
agentklar init
```

The first command for a repository registers it in the global project catalog
and creates or reuses its isolated workspace. `init` also proposes
`.agentklar/quality.toml` when the project does not have one.

Review that file before running a gate. Agentklar runs only declared recipes;
it never invents a command from prose.

```toml
[[recipe]]
name = "unit"
level = "L1"
command = "go"
args = ["test", "./..."]
timeout_seconds = 300
```

Repeat `agentklar init` in other repositories. The next control-center session
will list all of them.

## 3. Connect a coding agent

Print the MCP configuration for your client:

```bash
agentklar mcp install                 # Codex, OpenCode, and generic snippets
agentklar mcp install --client codex  # one client only
```

Add the printed snippet to the client and restart it. The MCP process resolves
the project from the repository where it is launched, so agent task operations,
memory, and context remain project-scoped.

The agent can call methods such as `list_ready_tasks`, `claim_task`,
`heartbeat_task`, `submit_for_review`, `get_context`, `remember`, `recall`, and
`notify_human`. It cannot approve, reject, acknowledge an alert, forget memory,
or mark work Done.

## 4. Start the control center

For a human session that can create tasks and make decisions:

```bash
agentklar ui --open
```

This starts the loopback-only server and passes a one-use bootstrap capability
directly to the default browser. The capability is not printed. The browser
receives an HttpOnly, SameSite=Strict session cookie; mutation requests must
also come from the exact UI origin.

For a read-only server:

```bash
agentklar ui
```

The printed URL is safe to use for viewing, but its mutation controls remain
disabled. Restart with `agentklar ui --open` when a human decision is needed.

Both commands default to `127.0.0.1:7681` and fall back to a free loopback port
when that port is busy. A fixed loopback address is also accepted:

```bash
agentklar ui --addr 127.0.0.1:8765 --open
```

The server refuses non-loopback listeners. It is a single-user local control
plane, not a remotely hosted team service. Stop it with Ctrl-C.

### What the UI provides

- **Overview:** every registered project with attention, approval, and alert
  counts.
- **Project switcher:** move between repositories without starting another
  board server.
- **Board:** create, edit, search, filter, move, reorder, and archive tasks.
- **Task details:** objective, criteria, verification, planning fields,
  dependencies, comments, evidence, reviews, and timeline.
- **Approvals:** one cross-project decision queue. Approve or request changes.
- **Intelligence:** project knowledge, searchable memory, and context packets.
- **Alerts:** inspect and acknowledge project alerts.

State changes do not require drag-and-drop: a keyboard-accessible **Move to**
selector provides the same permitted column transitions. Same-column ordering
currently uses drag-and-drop. Neither path bypasses workflow rules.

### Approval security

The MCP surface has no approval method and never receives an approval nonce.
The local UI creates an approval form token from the browser session and binds
it to the selected project, task, live submission, and stored nonce. A stale,
replayed, cross-project, or wrong-task token is rejected.

Terminal `agentklar approve` and `agentklar reject` commands exist for
development. They print a warning because a shell-capable agent could invoke
them. Use the `agentklar ui --open` browser session for the protected local
human channel.

## 5. Run a task

You can create and edit richer planning metadata in the control center. The
CLI covers the minimum shape needed to make work Ready:

```bash
agentklar task new AK-1 "Fix the parser" \
  --lane standard \
  --target codex \
  --criteria "handles empty input;tests pass" \
  --verify "go test ./..."

agentklar task ready AK-1
```

`task ready` is rejected unless acceptance criteria and a verification method
are present.

An agent uses the project-bound MCP server:

```text
list_ready_tasks
  → claim_task
  → heartbeat_task while working
  → submit_for_review with the commit range
```

Run the gate from the project repository:

```bash
agentklar gate AK-1
```

The gate runs applicable `.agentklar/quality.toml` recipes and records the
command, working directory, exit code, timestamps, retained log, artifact hash,
and reviewed commit. Passing review and Auto QA moves the task to User
Approval; it does not mark the task Done.

Open the Approvals view in the running human UI. Approve to move the live
submission to Done, or request changes with a reason.

The happy path is:

```text
Draft → Ready → In Progress → Completion Review → Auto QA
      → User Approval → Done
```

Side states are also protected:

- In Progress may enter Waiting or Blocked and later return to In Progress.
- Failed review, failed QA, or human rejection enters Changes Requested; an
  agent reclaims the task into In Progress for another submission.
- A human may cancel a task from Draft, Ready, In Progress, Blocked, or Changes
  Requested.

## 6. Plan and inspect work

The board supports these project-scoped planning fields:

- ID, title, objective, acceptance criteria, and verification method
- priority, assignee, labels, and due date
- quick, standard, or major lane
- execution target and isolation strategy
- task dependencies

Dependency cycles are rejected. Protected execution fields cannot be rewritten
after submission. Archive is limited to safe terminal or inactive states, and
archived tasks stay available in **Archived history**.

Useful CLI views:

```bash
agentklar status
agentklar task list
agentklar task list --json
agentklar task show AK-1
agentklar doctor
```

The CLI is always scoped to the current repository. The UI is the cross-project
view.

## 7. Knowledge, memory, and context

Each project has three transparent intelligence layers:

### Knowledge

Knowledge is Markdown under `.agentklar/knowledge/`, so humans can review it in
git:

```bash
agentklar knowledge decide "Use SQLite" \
  --context "The control plane is local-first" \
  --decision "Keep one portable database per project"
agentklar knowledge add convention "Error format" --body "Return typed API errors."
agentklar knowledge list
```

### Memory

Memory is stored with its namespace, source task, author, and timestamp in the
project workspace:

```bash
agentklar memory remember flaky-auth \
  --value "TestLogin flakes on a cold cache" \
  --namespace AK-7 --task AK-7
agentklar memory search "cold cache"
agentklar memory list --namespace AK-7
```

The MCP surface cannot forget a memory row. UI deletion requires the local
human session. `agentklar memory forget` is a designated human CLI convenience,
but it is not agent-proof when an agent can execute shell commands. MCP
`remember` writes also update the memory projection used by context search.

### Context

Context is a rebuildable FTS5 search index over project knowledge, memory, and
repository code:

```bash
agentklar context index
agentklar context search "authentication cache"
```

The control center exposes project-scoped search and manual reindexing. A
context packet returns focused matches rather than copying an entire project
into an agent prompt.

## 8. Alerts

Agents use `notify_human` for actionable information. Alerts retain their
project, task, severity, author, and timestamp.

```bash
agentklar alerts pending
agentklar alerts list
agentklar alerts ack 12
```

The MCP surface cannot acknowledge an alert. UI acknowledgement requires the
local human session. `agentklar alerts ack` is a designated human CLI
convenience, but it is not agent-proof when an agent can execute shell commands.

## 9. Optional Vikunja projection

The native control center requires no external tracker. If an existing setup
still uses Vikunja, connect it as an optional projection:

```bash
agentklar tracker connect \
  --url https://vikunja.example.com/api/v1 \
  --svc-user agentklar-bot --svc-pass '******' \
  --human you

agentklar tracker sync
```

Use `--svc-token <token>` instead of `--svc-user` and `--svc-pass` when
preferred. `connect` creates the project and workflow buckets when needed.

Agentklar projects cards and workflow buckets outward to Vikunja;
`control.sqlite` remains the authority for states, leases, evidence,
submissions, and approvals. Vikunja card moves are not imported as workflow
transitions. Existing nonce-bound human approval or rejection comments can be
reconciled with:

```bash
agentklar reconcile
```

## 10. Storage and backup

The global catalog maps repositories to isolated workspaces:

```text
~/.local/share/agentklar/
  catalog.sqlite
  workspaces/
    <project>/control.sqlite
    <project>/memory.sqlite
    <project>/context.sqlite
    <project>/evidence/
```

Project task IDs are not global; `AK-1` may exist in several repositories
without collision. Existing compatible workspaces are reused during catalog
registration.

Back up `~/.local/share/agentklar` for local state and commit
`.agentklar/knowledge/` plus `.agentklar/quality.toml` with each repository.

## Command reference

| Command | Purpose |
|---|---|
| `agentklar init` | Register the current repo, open its workspace, and propose quality recipes |
| `agentklar ui --open` | Start the control center with a local human browser session |
| `agentklar ui` | Start the control center read-only |
| `agentklar status` | Show current-project workflow counts and pending decisions |
| `agentklar doctor` | Check current-project recipes, commands, task counts, and MCP surface |
| `agentklar task new <id> <title> ...` | Create a Draft task |
| `agentklar task ready <id>` | Enforce Definition of Ready and make a task claimable |
| `agentklar task list [--json]` | List active tasks in the current project |
| `agentklar task show <id>` | Show one task with evidence and reviews |
| `agentklar gate <id>` | Run declared Completion Review and Auto QA recipes |
| `agentklar mcp` | Run the project-bound MCP server on stdio |
| `agentklar mcp install [--client ...]` | Print MCP configuration snippets |
| `agentklar knowledge ...` | Manage in-repo decisions and reference material |
| `agentklar memory ...` | List, search, write, or human-delete project memory |
| `agentklar context index` | Rebuild focused project context |
| `agentklar context search <query>` | Query focused project context |
| `agentklar alerts list` / `pending` / `ack` | Inspect or human-acknowledge alerts |
| `agentklar tracker connect ...` | Connect optional Vikunja projection |
| `agentklar tracker sync` | Re-project task cards into workflow buckets |
| `agentklar reconcile` | Apply valid human decisions from Vikunja comments |
| `agentklar version` | Print version, commit, and build date |

Run `agentklar` without arguments for the built-in command summary.
