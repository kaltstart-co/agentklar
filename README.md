# AgentKlar

Keep your native coding harness. AgentKlar gives registered projects a shared local work record, team roles, and durable worker runs. Start from Codex, Claude Code, Gemini CLI, Cursor, or OpenCode and connect its MCP client to AgentKlar. The first worker adapter is Codex. Other installed CLIs are discovered as hosts; their worker adapters are planned.

This is a fresh TypeScript rewrite. The old Go application is preserved in Git at `archive/pre-rewrite-2026-10-01`. Old databases and configuration are never imported. A run marked **completed** means the worker finished. Review the changes in your normal editor and harness.

## Run locally

Requires Node 24 and npm. For workers, install and authenticate Codex using its native setup first. No new model API key is required.

```sh
npm ci
npm run build
npm start
```

Keep that terminal running. Open the one-time setup URL it prints. It creates a private local browser session and opens the support UI. After setup, the UI lives at `http://127.0.0.1:4317`. For frontend development, run `npm run dev` in another terminal and open `http://127.0.0.1:5173`.

Register an existing project folder. Add roles with a harness, optional model, and responsibility. Start a task from your native harness through MCP or from the local UI. Only registered projects can run workers. Each project allows one worker at a time; a busy request returns an error. Repeating the same task with the same idempotency key returns its original run.

Project cost preference is saved as economical, balanced, or best. This first version uses your explicit model pin or native default. It does not infer the best model from benchmarks. Role responsibility is sent with the task, and the role snapshot and actual native model stay in its history.

## Connect MCP

Use your harness's normal MCP setup. Replace the folder below with the checkout path:

```json
{
  "mcpServers": {
    "agentklar": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/Agentklar", "run", "--silent", "mcp"]
    }
  }
}
```

Start the local service before the MCP connection. The stdio bridge talks to the independent service. Closing the MCP caller leaves its worker running. Ask the tools for registered projects, discovered harnesses, run status, compact events, result, or stop. No MCP tool can approve a native permission request. The API and tool list are in [docs/API.md](docs/API.md).

## Native permissions and data

Codex workers use `codex app-server` with your existing authentication and settings. AgentKlar leaves native approval and sandbox settings in place. Selecting read only adds a read-only restriction. Supported concrete command and file approvals appear in the authenticated local UI. Allow once, decline, or cancel there. Broader permission changes and unsupported native input requests need attention; stop that run and continue in your native harness.

Private records live in `~/.agentklar/local-v1/`: SQLite state, a private MCP bearer token, and a separate SQLite service ownership lock. `AGENTKLAR_HOME` can choose a different isolated folder. `AGENTKLAR_PORT` changes the loopback port. Browser writes require an exact allowed local Origin and session cookie. The server binds only to `127.0.0.1`. A hosted static preview has no local connection and shows no invented work.

On a service restart, unfinished runs become interrupted. Native sessions are recorded, but AgentKlar does not claim to recover a live worker. A possibly surviving owned process group keeps its project blocked until it exits; the service never kills an unverified or reused process ID. Cancellation interrupts the owned turn and terminates its owned subprocess group. Keep the service running for active work.

Results and event tails have character limits and explicit truncation flags. Native token counts are shown when available. Dollar cost, remaining quota, and model quality scores are unknown in this release.

## Check the code

```sh
npm run check
npm test
npm run build
```

Tests use a fake native protocol process and the official MCP SDK on real stdio. They verify persistence, project isolation, idempotency, cancellation, restart state, exclusive service ownership, native event identity, role context, and approval boundaries. Real smoke tests use separate temporary projects and explicitly pinned Sol models.

See [docs/VALIDATION.md](docs/VALIDATION.md) for local and real native evidence. See [BUILD_PLAN.md](BUILD_PLAN.md) for the staged roadmap and [FEATURE_CHECKLIST.md](FEATURE_CHECKLIST.md) for verified scope. MIT license.
