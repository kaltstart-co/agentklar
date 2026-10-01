# Local API
The service listens on 127.0.0.1:4317. UI requests use a local session cookie and an exact allowed Origin. Start the service, open its one-time setup URL, then open the UI at http://127.0.0.1:4317 or http://127.0.0.1:5173. Hosted UI has no local connection.

JSON bodies and replies. Errors: `{error: string}`. IDs are UUID strings. All changes require authenticated UI or the private MCP bearer token, except approval decisions require the UI cookie and exact local Origin.

- GET /api/health: `{ok:true}` (public).
- GET /api/snapshot: Snapshot in src/contracts.ts.
- POST /api/projects: `{name,path}` → Project. Path must exist and be absolute.
- PATCH /api/projects/:id: `{preference?,roles?}` → Project.
- POST /api/tasks/start: `{projectId,prompt,idempotencyKey,roleId?,model?,readOnly?}` → Run. Returns promptly. One active worker per project; busy returns 409.
- GET /api/runs/:id: Run.
- GET /api/runs/:id/tail?after=0: `{events:RunEvent[]}`.
- GET /api/runs/:id/result: `{state,result,error,tokens}`.
- POST /api/runs/:id/stop: Run.
- POST /api/approvals/:id: `{decision:string}` → `{ok:true}`. UI only, choices from Approval.decisions.

MCP tools: projects_list, project_register, project_update, harnesses_list, task_start, run_status, run_tail, run_result, run_stop. No approval tool.

Additional compact reads: GET /api/projects and GET /api/harnesses. Snapshot and run status contain a 300-character prompt preview and a 1,000-character result preview with promptTruncated/resultTruncated flags. Result reads hold up to 24,000 characters with resultTruncated. Event tails fit 24,000 text characters and return `{events,nextAfter,hasMore,truncated}`; individual clipped events have textTruncated. MCP responses fit a bounded context budget and report an explicit truncated preview if a large collection exceeds it.

Run history may include roleSnapshot, effectiveModel, threadId and turnId when known. Internal ownership fields are diagnostic data; callers do not own the worker process. Preference does not automatically choose a model. A duplicate idempotency key must match the original validated launch inputs.
