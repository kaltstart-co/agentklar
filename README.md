# AgentKlar

Keep your native coding harness. AgentKlar gives registered projects a shared local work record, saved project context, team roles, and durable worker runs. Start from Codex, Claude Code, Gemini CLI, Cursor, or OpenCode and connect its MCP client to AgentKlar. Codex and Claude Code have worker adapters. Other installed CLIs are discovered as hosts; their worker adapters are planned.

This is a fresh TypeScript rewrite. The old Go application is preserved in Git at `archive/pre-rewrite-2026-10-01`. Old databases and configuration are never imported. A run marked **completed** means the worker finished. Review the changes in your normal editor and harness.

## Run locally

Requires Node 24 and npm. For workers, install Codex or Claude Code and sign in through its native setup first. Use the discovered executable path if the command is not on your shell PATH. For Claude Code, run that executable with `auth login`. No new model API key is required. An installed executable does not prove that you are signed in.

```sh
npm ci
npm run build
npm start
```

Keep that terminal running. Open the one-time setup URL it prints. It creates a private local browser session and opens the support UI. After setup, the UI lives at `http://127.0.0.1:4317`. For frontend development, run `npm run dev` in another terminal and open `http://127.0.0.1:5173`.

Register an existing project folder. Add roles with a harness, optional model, and responsibility. Start a task from your native harness through MCP or from the local UI. Only registered projects can run workers. Each project allows one worker at a time; a busy request returns an error. Repeating the same task with the same idempotency key returns its original run.

Project cost preference is saved as economical, balanced, or best. This first version uses your explicit model pin or native default. It does not infer the best model from benchmarks. Role responsibility is sent with the task, and the role snapshot, worker harness, and actual native model stay in its history. Choose an installed worker harness in the local UI. A selected role chooses its harness. Changing the harness clears the model pin so a model name from another harness is not carried over.

## Native models and account allowance

Open **Models**, choose a project, and select **Refresh models and allowance**. AgentKlar reads the native Codex and Claude model lists. New task and Team let you choose a listed model or type a custom name. Loading the list never changes your model pin. A listed model does not prove that your account can use it or that you are signed in. Prices in native vendor descriptions describe API usage, not your subscription bill.

**Usage** shows native Codex account allowance when available: used and remaining percentages, window duration, and reset time in your local time zone. These limits are shared across the native account; project task tokens do not calculate them. A native included-usage block remains visible even when a percentage window has reset. Claude account allowance is unavailable through the current SDK. Missing information stays unknown. Native reads occur only when you request a refresh; the normal task polling reads no model or quota data. Catalog snapshots are cached per project and refreshes within 30 seconds reuse that cache.

## Shared project context

Open **Context** to save a project brief, decisions and lessons, and next steps. This is a shared local record that your native harnesses can read and update through MCP. Memory is saved explicitly; AgentKlar does not collect it automatically from chats or project files. The fields allow 2,000, 4,000, and 2,000 characters respectively.

Each save creates a revision. If another harness saves first, the UI keeps your draft and shows a conflict. **Load latest (replaces draft)** loads that newer revision. New tasks use saved project context by default; turn off **Use project context** to skip it. Each task retains the exact context used at launch. Open its **Project context** disclosure to inspect that snapshot. Unsaved edits apply after you save them.

## Connect MCP

Use your harness's normal MCP setup. Replace the folder below with the checkout path:

```json
{
  "mcpServers": {
    "agentklar": {
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/to/Agentklar",
        "run",
        "--silent",
        "mcp"
      ]
    }
  }
}
```

Start the local service before the MCP connection. The stdio bridge talks to the independent service. Closing the MCP caller leaves its worker running. Ask the tools for registered projects, discovered harnesses, run status, compact events, result, or stop. No MCP tool can approve a native permission request. The API and tool list are in [docs/API.md](docs/API.md).

## Native permissions and data

Codex workers use `codex app-server` with your existing authentication and settings. AgentKlar leaves native approval and sandbox settings in place. Selecting read only adds Codex’s read-only filesystem restriction. Claude Code workers reuse the [official Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and the installed native CLI with its own authentication and settings. Claude read only permits only the model tools Read, Glob, and Grep; user-configured hooks may still run. It does not add an operating system sandbox. Supported concrete native approvals appear in the authenticated local UI. Allow once, decline, or cancel there. Broader permission changes and unsupported native input requests need attention; stop that run and continue in your native harness.

Private records live in `~/.agentklar/local-v1/`: SQLite state, a private MCP bearer token, and a separate SQLite service ownership lock. `AGENTKLAR_HOME` can choose a different isolated folder. `AGENTKLAR_PORT` changes the loopback port. Browser writes require an exact allowed local Origin and session cookie. The server binds only to `127.0.0.1`. A hosted static preview has no local connection and shows no invented work.

On a service restart, unfinished runs become interrupted. Native sessions are recorded, but AgentKlar does not claim to recover a live worker. A possibly surviving owned process group keeps its project blocked until it exits; the service never kills an unverified or reused process ID. Cancellation interrupts the owned turn and terminates its owned subprocess group. Keep the service running for active work.

Results and event tails have character limits and explicit truncation flags. Native token counts are shown when available. Dollar cost and model quality scores remain unknown. Account allowance is shown only when the native harness provides it.

## Check the code

```sh
npm run check
npm test
npm run build
```

Tests use a fake native protocol process and the official MCP SDK on real stdio. They verify persistence, project isolation, idempotency, cancellation, restart state, exclusive service ownership, native event identity, role context, and approval boundaries. The verified Codex smoke tests use separate temporary projects and explicitly pinned Sol models. Claude Code integration is in progress. The installed CLI was found, but native authentication was not active; a successful live Claude worker run has not been verified.

See [docs/VALIDATION.md](docs/VALIDATION.md) for local and real native evidence. See [BUILD_PLAN.md](BUILD_PLAN.md) for the staged roadmap and [FEATURE_CHECKLIST.md](FEATURE_CHECKLIST.md) for verified scope. MIT license.
