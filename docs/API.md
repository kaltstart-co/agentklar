# Local API
The service listens on 127.0.0.1:4317. UI requests use a local session cookie and an exact allowed Origin. Start the service, open its one-time setup URL, then open the UI at http://127.0.0.1:4317 or http://127.0.0.1:5173. Hosted UI has no local connection.

JSON bodies and replies. Errors: `{error: string}`. IDs are UUID strings. All changes require authenticated UI or the private MCP bearer token, except approval decisions require the UI cookie and exact local Origin.

- GET /api/health: `{ok:true}` (public).
- GET /api/snapshot: Snapshot in src/contracts.ts.
- POST /api/projects: `{name,path}` → Project. Path must exist and be absolute.
- PATCH /api/projects/:id: `{preference?,roles?}` → Project.
- GET /api/projects/:id/context: `{projectId,revision,brief,memory,handoff,updatedAt,updatedVia}`. Unsaved context has revision 0, empty text and null update fields. Unknown projects return 404.
- PUT /api/projects/:id/context: `{brief,memory,handoff,expectedRevision}` → ProjectContext. All three text fields are required. Limits are 2,000, 4,000 and 2,000 characters respectively. The revision must be a nonnegative safe integer below the maximum safe integer. SQLite checks and saves the revision atomically. A stale writer gets 409 and must read the latest record and review its edits before retrying. The server records update time and authenticated channel (`ui` or `mcp`); clients cannot set them.
- POST /api/tasks/start: `{projectId,prompt,idempotencyKey,roleId?,harness?,model?,readOnly?,includeProjectContext?}` → Run. Harness is `codex` or `claude`; defaults to the selected role's harness, then Codex. An explicit harness must match the selected role. Returns promptly. One active worker per project; busy returns 409. Saved context is included by default; set includeProjectContext to false to opt out.
- GET /api/runs/:id: Run.
- GET /api/runs/:id/context: `{runId,contextSnapshot:ProjectContext|null}`. Inspect the saved context captured at launch; null means no saved text was included.
- GET /api/runs/:id/tail?after=0: `{events:RunEvent[]}`.
- GET /api/runs/:id/result: `{state,result,error,tokens}`.
- POST /api/runs/:id/stop: Run.
- POST /api/approvals/:id: `{decision:string}` → `{ok:true}`. UI only, choices from Approval.decisions.

MCP tools: projects_list, project_register, project_update, project_context_read, project_context_update, harnesses_list, task_start, run_status, run_context_read, run_tail, run_result, run_stop. Context tools use the same validation as HTTP. No approval tool.

Additional compact reads: GET /api/projects and GET /api/harnesses. Snapshot and run status contain a 300-character prompt preview and a 1,000-character result preview with promptTruncated/resultTruncated flags. Result reads hold up to 24,000 characters with resultTruncated. Event tails fit 24,000 text characters and return `{events,nextAfter,hasMore,truncated}`; individual clipped events have textTruncated. MCP responses fit a bounded context budget and report an explicit truncated preview if a large collection exceeds it.

Each project keeps one latest context record in SQLite. Memory is manually saved text. AgentKlar does not automatically ingest transcripts or files, search vectors, or write native AGENTS.md or CLAUDE.md files. At launch, nonempty context is captured as an immutable run snapshot with its revision and update source. Later context edits affect future launches. A run's prompt remains the original task. Both adapters compose the same delimited JSON block of role and project data in the task prompt; native system instructions and permission rules still apply. Project data cannot grant approval or change harness policy. Saved text is capped at 8,000 characters; labels and metadata add a small fixed prompt overhead.

Task launch, idempotent replay, snapshot, run status, result and stop replies include contextRevision (or null) and omit the stored snapshot body. Use the explicit run context endpoint or run_context_read tool to inspect it. A model's own output may quote the context; AgentKlar does not remove text from worker results. Idempotency binds the context inclusion choice, so repeating the original launch returns its original run and captured revision even if project context has changed. Omitted and true inclusion are equivalent; false is a different launch input.

New runs include `harness`. Older runs without it used Codex. Run history may include roleSnapshot, effectiveModel, threadId and turnId when known. Claude's native session ID is recorded as threadId; no turn ID is invented. Claude tokens sum input, output, cache read and cache creation counts from the latest final native `modelUsage` once. These query pipeline totals include the main loop, subagents, sidechains and compaction. They exclude helpers outside that pipeline, such as permission classifiers and token probes. Missing, empty or invalid totals stay unknown. Native totals are estimates, not a billing statement; subscription spending remains unknown. Internal ownership fields are diagnostic data; callers do not own the worker process. Preference does not automatically choose a model. A duplicate idempotency key must match the original validated launch inputs, including harness.

Claude workers use the official `@anthropic-ai/claude-agent-sdk` with the installed Claude Code executable, native system prompt, settings and plugins. Discovery checks PATH, `~/.local/bin/claude`, then the newest executable desktop install under `~/Library/Application Support/Claude/claude-code`. Finding an executable does not verify sign-in or subscription access. Sign in through the native Claude Code CLI. AgentKlar does not read or copy login credentials, select an API key fallback, or log native auth events/stderr.

Existing native permission rules still apply. Only unresolved concrete Bash, Edit and Write actions can be answered through the trusted local UI, for that one action. Background commands, disabling the sandbox, requests for outside-path access, MCP questions and other unsupported prompts stop with needs_attention. No approval grants future permissions. A final root result and a drained SDK stream are required for completion; child output cannot complete the run.

Claude readOnly restricts model tool calls to Read, Glob and Grep. A PreToolUse hook denies every other tool, including Bash, MCP, Skill and Agent, before native auto-allow rules apply. Native configured hooks and runtime bookkeeping can still run and write files; this is a tool restriction, not an operating-system sandbox. Codex readOnly uses its native read-only sandbox. Both adapters own detached local process groups, retain PID evidence for a possible surviving group, and terminate their group on stop.
