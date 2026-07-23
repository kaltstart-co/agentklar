# Setup & Usage

Agentklar is one local binary. You bring your own coding agent and (optionally) your
own Vikunja board. This guide takes you from install to a task moving across the board.

- [1. Install](#1-install)
- [2. Connect your agent (MCP)](#2-connect-your-agent-mcp)
- [3. Set up a board](#3-set-up-a-board-new-or-existing-vikunja)
- [4. Run a task end to end](#4-run-a-task-end-to-end)
- [5. Everyday commands](#5-everyday-commands)

---

## 1. Install

**From a release (recommended)** — download the archive for your OS/arch from the
[Releases page](https://github.com/kaltstart-co/agentklar/releases), verify it against
`checksums.txt`, and put the binary on your `PATH`:

```bash
# example: macOS arm64
tar xzf agentklar_*_darwin_arm64.tar.gz
install -m 0755 agentklar ~/.local/bin/agentklar
agentklar version
```

**From source** (needs Go 1.25+):

```bash
git clone https://github.com/kaltstart-co/agentklar
cd agentklar
go build -o ~/.local/bin/agentklar ./cmd/agentklar
```

Make sure `~/.local/bin` is on your `PATH`.

---

## 2. Connect your agent (MCP)

Your coding agent talks to Agentklar over MCP. Print the config for your client and paste
it in — Agentklar fills in the absolute binary path for you:

```bash
agentklar mcp install                 # prints config for Codex, OpenCode, and generic
agentklar mcp install --client codex  # just one
```

That registers `agentklar mcp` as an MCP server. Your agent can then call
`list_ready_tasks`, `claim_task`, `submit_for_review`, and record results — but **not**
approve or finish a task. Completion stays human-only, by design.

---

## 3. Set up a board (new or existing Vikunja)

The board is your UI: a Kanban of your tasks. Agentklar drives [Vikunja](https://vikunja.io);
it doesn't build its own web app. **You can skip this** and run tracker-less — tasks still
live in a local database — but the board is where the workflow is easiest to see.

### You already run Vikunja

Point Agentklar at it. Use a **separate service account** for the bot (so it can never
approve its own work), and name the account that approves:

```bash
agentklar tracker connect \
  --url https://vikunja.example.com/api/v1 \
  --svc-user agentklar-bot --svc-pass '******' \
  --human you
```

Prefer an API token? Use `--svc-token <token>` instead of `--svc-user/--svc-pass`.

`connect` creates the project if needed, shares it with you, and **creates the eight
workflow columns** (Draft → Ready → In Progress → Completion Review → Auto QA →
Changes Requested → User Approval → Done). Running it against a board that already has
them changes nothing.

### You don't have Vikunja yet

Run it locally — a single container is enough for one person:

```bash
docker run -p 3456:3456 \
  -e VIKUNJA_SERVICE_PUBLICURL=http://localhost:3456/ \
  vikunja/vikunja:latest
```

Then open `http://localhost:3456`, register your user and a second `agentklar-bot` user,
and run the `tracker connect` command above with `--url http://localhost:3456/api/v1`.
(See the [Vikunja install docs](https://vikunja.io/docs/installing/) for native binaries
and persistent config.)

---

## 4. Run a task end to end

```bash
# once per repo
agentklar init

# 1. you shape the task — no criteria, no "ready"
agentklar task new AK-1 Fix the parser \
  --criteria "handles empty input;tests pass" --verify "go test ./..."
agentklar task ready AK-1

# 2. your agent claims and does the work (over MCP), then submits the commit range

# 3. run the gate — your checks, kept as machine-attested evidence
agentklar gate AK-1

# 4. you approve — the agent cannot
#    - dev shortcut:      agentklar approve AK-1
#    - trusted (board):   comment "approve <nonce>" on the card as yourself,
#                         then:  agentklar reconcile
```

As tasks move, their cards move too. If you ever want to force the board to match the
current state (for example after bulk changes), run:

```bash
agentklar tracker sync
```

---

## Menu-bar widget (macOS)

A small menu-bar app shows how many tasks are **awaiting your approval** across all your
workspaces, lists them (click one to open its tracker card), and carries quick links to
your boards and the website.

```bash
scripts/build-bar.sh          # builds dist/Agentklar.app
open dist/Agentklar.app        # launches the menu-bar widget (✓ N when reviews are waiting)
```

The title shows `✓` when everything's clear and `✓ N` when N tasks need you. To start it
automatically, add `Agentklar.app` in **System Settings → General → Login Items**.

**Add your own links** (Jira, docs, anything) — they show up in the menu without a rebuild.
Create `~/.config/agentklar/links.toml`:

```toml
[[link]]
name = "Team Jira"
url  = "https://your-org.atlassian.net/jira/software/projects/ABC/boards/1"
```

## 5. Everyday commands

| Command | What it does |
|---|---|
| `agentklar init` | Create a workspace for the current repo, propose the checks to run |
| `agentklar task new <id> <title> --criteria --verify --lane` | Create a task with acceptance criteria |
| `agentklar task ready <id>` | Move to Ready (blocked without criteria + a verify method) |
| `agentklar task list` / `show <id>` | List tasks / show one with its evidence |
| `agentklar mcp` | Run the agent-facing MCP server (your agent launches this) |
| `agentklar mcp install [--client]` | Print MCP config to connect your agent |
| `agentklar gate <id>` | Run the checks and store machine-attested evidence |
| `agentklar tracker connect …` | Connect a Vikunja board (new or existing) |
| `agentklar tracker sync` | Place every task's card in its state column |
| `agentklar reconcile` | Apply a human approval posted on the board |
| `agentklar approve <id>` / `reject <id> <reason>` | Finish a task (human-only) |
| `agentklar doctor` | Health: declared checks, missing commands, task counts |
| `agentklar version` | Version, commit, build date |

Scoping note: Agentklar resolves your workspace from the **current git repo**, so
`task list` only shows that repo's tasks — one repo, one board.
