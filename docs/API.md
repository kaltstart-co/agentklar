# Local API
The service listens on 127.0.0.1:4317. UI requests use a local session cookie and an exact allowed Origin. Start the service, open its one-time setup URL, then open the UI at http://127.0.0.1:4317 or http://127.0.0.1:5173. Hosted UI has no local connection.

JSON bodies and replies. Errors: `{error: string}`. IDs are UUID strings. All changes require authenticated UI or the private MCP bearer token, except approval decisions require the UI cookie and exact local Origin.

- GET /api/health: `{ok:true}` (public).
- GET /api/snapshot: Snapshot in src/contracts.ts.
- POST /api/projects: `{name,path}` → Project. Path must exist and be absolute.
- PATCH /api/projects/:id: `{preference?,roles?}` → Project.
- POST /api/tasks/start: `{projectId,prompt,idempotencyKey,roleId?,harness?,model?,readOnly?}` → Run. Harness is `codex` or `claude`; defaults to the selected role's harness, then Codex. An explicit harness must match the selected role. Returns promptly. One active worker per project; busy returns 409.
- GET /api/runs/:id: Run.
- GET /api/runs/:id/tail?after=0: `{events:RunEvent[]}`.
- GET /api/runs/:id/result: `{state,result,error,tokens}`.
- POST /api/runs/:id/stop: Run.
- POST /api/approvals/:id: `{decision:string}` → `{ok:true}`. UI only, choices from Approval.decisions.

MCP tools: projects_list, project_register, project_update, harnesses_list, task_start, run_status, run_tail, run_result, run_stop. No approval tool.

Additional compact reads: GET /api/projects and GET /api/harnesses. Snapshot and run status contain a 300-character prompt preview and a 1,000-character result preview with promptTruncated/resultTruncated flags. Result reads hold up to 24,000 characters with resultTruncated. Event tails fit 24,000 text characters and return `{events,nextAfter,hasMore,truncated}`; individual clipped events have textTruncated. MCP responses fit a bounded context budget and report an explicit truncated preview if a large collection exceeds it.

New runs include `harness`. Older runs without it used Codex. Run history may include roleSnapshot, effectiveModel, threadId and turnId when known. Claude's native session ID is recorded as threadId; no turn ID is invented. Claude tokens sum input, output, cache read and cache creation counts from the latest final native `modelUsage` once. These query pipeline totals include the main loop, subagents, sidechains and compaction. They exclude helpers outside that pipeline, such as permission classifiers and token probes. Missing, empty or invalid totals stay unknown. Native totals are estimates, not a billing statement; subscription spending remains unknown. Internal ownership fields are diagnostic data; callers do not own the worker process. Preference does not automatically choose a model. A duplicate idempotency key must match the original validated launch inputs, including harness.

Claude workers use the official `@anthropic-ai/claude-agent-sdk` with the installed Claude Code executable, native system prompt, settings and plugins. Discovery checks PATH, `~/.local/bin/claude`, then the newest executable desktop install under `~/Library/Application Support/Claude/claude-code`. Finding an executable does not verify sign-in or subscription access. Sign in through the native Claude Code CLI. AgentKlar does not read or copy login credentials, select an API key fallback, or log native auth events/stderr.

Existing native permission rules still apply. Only unresolved concrete Bash, Edit and Write actions can be answered through the trusted local UI, for that one action. Background commands, disabling the sandbox, requests for outside-path access, MCP questions and other unsupported prompts stop with needs_attention. No approval grants future permissions. A final root result and a drained SDK stream are required for completion; child output cannot complete the run.

Claude readOnly restricts model tool calls to Read, Glob and Grep. A PreToolUse hook denies every other tool, including Bash, MCP, Skill and Agent, before native auto-allow rules apply. Native configured hooks and runtime bookkeeping can still run and write files; this is a tool restriction, not an operating-system sandbox. Codex readOnly uses its native read-only sandbox. Both adapters own detached local process groups, retain PID evidence for a possible surviving group, and terminate their group on stop.
