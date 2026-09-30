# AgentKlar build plan

## Product and scope

AgentKlar coordinates work around the coding tools people already use. A person starts in Codex, Claude Code, Cursor, or another supported tool. That tool can call AgentKlar through MCP, the shared tool protocol, to retrieve work, delegate a task, inspect evidence, or get a handoff.

The local service runs user-installed coding tools. It keeps work records after the caller closes. A small interface helps the person see work, manage teams, check usage, and change settings. The first useful result is one real task moving from a host tool to a native worker, through review and a fix, then back to the host with evidence. Opted-in AgentKlar work follows its approval contract. People can continue ordinary native work without extra tracking steps. Observe registered runs and supported opt-in events; MCP does not reveal all activity or tokens.

The [feature checklist](FEATURE_CHECKLIST.md) records existing code and proposed work separately. This plan describes intended behavior; unchecked features are not delivered.

## Reuse the working foundation

Keep the Go binary, SQLite databases, project registry, workflow engine, task claims, leases, and fencing tokens. A fencing token is a claim number that prevents an older worker from changing newer work. Keep project knowledge, memory, context search, declared checks, evidence, and the existing human approval boundary.

The legacy interface uses Go templates and already provides useful JSON APIs. The new support frontend uses React, Vite, and [Mantine components](https://mantine.dev/guides/vite/). Mantine uses the MIT license. Keep the backend in Go and serve the same frontend locally and on Vercel; build the frontend before embedding it in the Go binary.

Use four main views: **Work, Team, Usage, Settings**. Work starts with a searchable list and a detail pane. Include filters, a command palette, and evidence that expands when needed. Keep screens focused on status and decisions. Native tools remain the place for coding conversations, editors, browsing, and terminal work.

## First milestone: one complete work loop

Choose one host and one worker from tools installed on the test machine. Start with a small repository task and declared checks. Use a supported native API or structured command mode. Codex app-server, Claude Code CLI, Muse protocol, ZCode, and OpenCode endpoints are candidates that still require local compatibility checks. [Cursor CLI](https://cursor.com/docs/cli/overview) and [Gemini headless mode](https://geminicli.com/docs/cli/headless/) are later candidates. Begin with sequential edits and read-only review. Before parallel editing, create real worktrees and verify separate working directories; the present claim label provides no filesystem isolation.

The local service owns the worker process and durable run record. The caller's MCP connection may close without losing that record. After a service crash, report interrupted runs truthfully; reattach only when the adapter supports and passes that test. Its bridge exposes caller and project scoped work. A task has one orchestrator owner; transfers advance an ownership fence so an old owner cannot launch duplicate work. New instructions wait for a turn boundary unless that adapter has verified native steering support.

Prioritize a packet of recorded commit references, checks, findings, and open questions; an attention inbox for approvals, blockers, and failed runs; and saved delegation policies. A standalone policy for one subscription is useful.

Acceptance checks:

- Delegate, review, request a fix, and return an evidence packet to the host.
- Close the caller connection; reconnect to the same run without launching another.
- Reject stale claims and instructions from the previous orchestrator owner.
- Show worker failure, cancellation, and pending approval clearly.
- Preserve native permissions and require human completion approval.

## Teams, routing, and usage

A role defines responsibility, preferred harness and model, skills, access, expected evidence, and allowed fallback. People can pin a role to a tool or model. A team is a saved set of roles and a delegation policy, rather than a collection of new chat windows.

Start routing with clear rules, a model capability catalog, and a manually seeded, dated benchmark snapshot with verified usage rights. First exclude tools without the needed capability or access. Then use evidence from similar tasks, available quota, the user's cost and quality preference, and delay or setup cost. Keep the current capable agent when delegation offers no useful gain. Explain each selection briefly. Benchmark scores are comparisons on benchmark tasks; they do not give the probability that this task will succeed. Automate refresh later.

Record usage as **actual, estimated, or unknown**, with its source and time. Deduplicate readings from a shared account pool. A model catalog entry does not prove account access. Use native account authentication, configuration, tools, and permission settings as the authority. Switching to paid API billing requires an explicit user choice.

Later, add a queue after rate limits, native session reopening where supported, and routing improvements from the user's own task outcomes.

## Shared configuration and external reuse

Import selected instructions, skills, and MCP configuration. Preview conflicts, keep ownership hashes for managed files, stage changes, and retain rollback copies. Merge individual fields in shared native files; staging a whole file does not preserve unrelated edits. Track drift and offer restore. Initially leave hooks, permissions, and credentials with native tools. Offer reusable skill and plugin presets. Detect newly installed harnesses and offer easy setup; enable connections through an explicit user choice.

Reuse [Models.dev](https://models.dev) for model metadata with a dated cached snapshot; its [source](https://github.com/anomalyco/models.dev) is MIT licensed. Evaluate the official [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk) when protocol compatibility tests show a need. Its new code is Apache 2.0 and existing code is MIT; inspect included notices when pinning it. Negotiate supported versions and preserve the workflow contracts.

Later, evaluate [Rulesync](https://github.com/dyoshikawa/rulesync), MIT, as an optional pinned helper for configuration generation through its public JavaScript API. The researched baseline is v24.0.0, revision `b222afe08de132f43907b9580be6e0e2a02bd951`. Generate into staging, then apply reviewed managed writes. Evaluate [ACP](https://agentclientprotocol.com/get-started/registry) selectively after proving needed capabilities; add its runtime only if it simplifies the chosen integration.

Avoid a large app fork. Superset's [ELv2 license](https://github.com/superset-sh/superset/blob/deaf622ac275ab2c4503569b63c94a18c3f7d6ad/LICENSE) and broader scope need separate review. Other gateways may own their own approval policy. Agent Relay can be evaluated for remote work later. Public reports of [config loss](https://github.com/farion1231/cc-switch/issues/7472), [file collisions](https://github.com/dyoshikawa/rulesync/issues/3240), and [usage requests](https://github.com/superset-sh/superset/issues/7763) inform checks; they are not market validation.

## Vercel and local pairing

Vercel hosts the shared frontend; `vercel.json` contains its build settings. The local connector runs installed tools and preserves offline use. Cloud authentication, durable storage, and secure pairing need a separate phase. The repository also has a GitHub Pages workflow for its static website.

Start with a hosted status view. Design authenticated account and device pairing, revocation, and explicit project selection. Use outbound HTTPS status updates and a durable command inbox. Commands need expiry, deduplication, and ownership fences. Short polling is enough initially. Verify reconnects cannot duplicate runs and revoked devices cannot accept commands.

The present loopback UI uses a one-use browser session and exact-origin checks. Public access needs its own tested authorization design. Preserve local approval and route native permission decisions through supported native paths. Add hosted actions only after these tests pass.

Before commercial or hosted dispatch, verify the supported authentication route. Current [Codex app-server guidance](https://learn.chatgpt.com/docs/app-server#auth-endpoints) limits its local/open-source auth flow for commercial and hosted services; inspect [Sign in with ChatGPT and plan usage integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). Local tests do not establish hosted authentication permission. An [Artificial Analysis feed](https://artificialanalysis.ai/data-api/docs) also needs a key, attribution, and a redistribution terms check before shipping benchmark snapshots.

## Updates and delivery

Pin new dependencies and adapter versions. Use automated update pull requests, compatibility checks, then merge. Date benchmark snapshots and keep a last-known-good version. Assign implementation to Sol; use Astra for research when needed.

The first local slice is underway: native supervisor, saved team policy, sourced usage, and a small support interface. Complete the real work loop before claiming it delivered. Add pairing, managed configuration, and more adapters after these paths work. Interface checks cover keyboard selection, filters, evidence, and decisions. Cloud checks must cover pairing, revocation, reconnects, and offline use. Configuration upgrades must preserve unrelated user data. Push and deployment each require their own verified status.

## Audit evidence

Baseline: clean `main` at `65da7e6559a79e05a8c20346daca4eb05b0faa3c`, cloned into `/Users/divyansh/Projects/Agentklar` on 2026-09-30. Go 1.25.6 uses TOML, SQLite, and a macOS menu library. Existing sources are `internal/workflow`, `store`, `catalog`, `ui`, `quality`, `gate`, `context`, `memory`, `knowledge`, `mcp`, and `notify`.

Actual Git worktree creation remains proposed. Editing runs require existing quick/auto exclusive claims; read-only reviews use a narrowed native sandbox. Team roles, saved cost/quality preferences, and conservative recommendations now have code and tests. Native run completion is separate from task approval.

Runtime fixtures pass for exact retry identity, claim and project scope, final-event persistence, caller disconnect, cancellation, serial edits, native permission decisions, stale requests, and interrupted restart reporting. The trusted UI has separate session/origin tests; no permission decision exists on MCP or the supervisor socket. Native input and dynamic tool requests remain unsupported. Interrupted runs do not automatically reattach or relaunch.

The live audit found Codex 0.159.2, Claude Code 2.1.280, Muse Code 1.3.0, and ZCode CLI 0.16.9. Only Codex runs workers. ChatGPT login, native handshake, catalog, and read-only usage passed. A real read-only `gpt-6.1-sol` smoke retained its result, native IDs, and tokens while keeping the task In Progress. Replay after caller close returned that record. A Sol write paused at native file approval, then timed out without creating `add.js`; the coding loop is unverified. Its Node check failed. Resume, recovery, detached-child termination, and other adapters remain unverified.

The completion packet uses existing records through CLI and MCP. Fixtures verify provenance, revision scope, task isolation, read-only retrieval, and explicit shortening: five records per section share a 3500-byte excerpt budget. Reading the saved real smoke returned a completed worker with `human_approved=false`, no submission, and no checks. Reports remain unverified prose; no git/log recheck or note-resolution inference occurs.

Commit `64dba52` was pushed; [GitHub CI passed](https://github.com/kaltstart-co/agentklar/actions/runs/36769277620). The new Vercel project is READY at [agentklar-seven.vercel.app](https://agentklar-seven.vercel.app). Automatic GitHub deployments are blocked by a missing [Vercel GitHub App installation](https://github.com/apps/vercel). Pairing and hosted worker control remain planned.

Current `go build ./...`, `go test ./...`, `go vet ./...`, and six affected race suites passed on macOS arm64 with Go 1.25.6; `gofmt -l cmd internal` returned no files. The toolchain was downloaded temporarily from [go.dev](https://go.dev/dl/go1.25.6.darwin-arm64.tar.gz); SHA-256 `984521ae978a5377c7d782fd2dd953291840d7d3d0bd95781a1f32f16d94a006` matched official metadata. No global tool install or harness settings changes were made.
