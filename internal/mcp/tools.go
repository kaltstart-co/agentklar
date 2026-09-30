package mcp

// MCP tool definitions (spec-compliant tools/list payload). Every entry
// mirrors a method in contracts.MCPMethods; approval stays off this
// surface by design.

type ToolDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

func obj(props map[string]interface{}, required ...string) map[string]interface{} {
	s := map[string]interface{}{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func str(desc string) map[string]interface{} {
	return map[string]interface{}{"type": "string", "description": desc}
}

func integer(desc string) map[string]interface{} {
	return map[string]interface{}{"type": "integer", "description": desc}
}

func boolean(desc string) map[string]interface{} {
	return map[string]interface{}{"type": "boolean", "description": desc}
}

var taskID = str("Task identifier, e.g. KS-1")

var workerSelection = obj(map[string]interface{}{
	"harness": str("Named native harness. A pin can name codex; current may name the main harness."),
	"model":   str("Named native model. A pin may use auto only when a unique compatible catalog candidate exists."),
}, "harness", "model")

var ToolDefs = []ToolDef{
	{"get_completion_packet", "Read this workspace's recorded task evidence, reviews, native results, and remaining checks. This neither runs verification nor approves completion.", obj(map[string]interface{}{"task_id": taskID}, "task_id")},
	{"recommend_worker", "Read saved project team policy and service-observed native catalog/usage. Returns keep_current, nominate_worker, or no_recommendation with sources and missing evidence. A nomination is not verified entitlement, a quality guarantee, or permission to launch or change billing.", obj(map[string]interface{}{
		"task_id":               taskID,
		"role_id":               str("Optional saved team role id; preferred selection and allowed fallback constrain advice."),
		"task_kind":             str("Optional task category such as coding; this is not a capability or measured quality."),
		"required_capabilities": map[string]interface{}{"type": "array", "items": str("Concrete input/operation requirement. text is supported by the run adapter; image and audio are checked against model, harness, and adapter facts and currently cannot be delegated. Other operations have no verified support yet."), "minItems": 1, "maxItems": 64},
		"current":               workerSelection,
		"pin":                   workerSelection,
	}, "task_id", "required_capabilities")},
	{"get_usage", "Read sourced native quota and token snapshots, with unknown spend. Optional id selects a registered run's estimate.", obj(map[string]interface{}{"id": str("Optional registered run id.")})},
	{"list_harnesses", "List saved native executable probes; discovery does not prove login or model access.", obj(map[string]interface{}{})},
	{"get_model_catalog", "Read Codex native model catalog without inference. Catalog membership does not prove access.", obj(map[string]interface{}{})},
	{"get_team_policy", "Read the project's saved roles and cost/quality preference.", obj(map[string]interface{}{})},
	{"list_runs", "List this project's registered native runs; run completion does not approve the task.", obj(map[string]interface{}{})},
	{"get_run", "Read a durable native run and events after a cursor.", obj(map[string]interface{}{"id": str("Stable run id."), "after": integer("Event sequence cursor; defaults to zero.")}, "id")},
	{"start_run", "Delegate one task to native Codex through the local supervisor using the current claim. Same id and request retries return the existing run. Reviews must be read-only; editing needs an exclusive primary claim.", obj(map[string]interface{}{"id": str("Stable retry id."), "task_id": taskID, "holder": str("Current task claim holder."), "fencing_token": integer("Current claim token."), "harness": str("codex; default codex."), "model": str("Optional native model; empty keeps native default."), "purpose": str("implement, review, or fix; default implement."), "read_only": boolean("Narrow native sandbox to read-only."), "prompt": str("Bounded instructions for this task.")}, "id", "task_id", "holder", "fencing_token", "prompt")},
	{"cancel_run", "Request native interruption for a run owned by the current task claim.", obj(map[string]interface{}{"id": str("Run id."), "holder": str("Current claim holder."), "fencing_token": integer("Current claim token.")}, "id", "holder", "fencing_token")},
	{"bind_workspace", "Return the workspace this server is bound to.", obj(map[string]interface{}{})},
	{"list_ready_tasks", "List tasks in Ready state that an agent may claim.", obj(map[string]interface{}{
		"execution_target": str("Optional target filter; empty for any."),
	})},
	{"claim_task", "Claim a Ready task before starting work.", obj(map[string]interface{}{
		"task_id":        taskID,
		"expected_state": str("State the task is expected to be in (optimistic check)."),
		"holder":         str("Who is claiming; defaults to 'agent'."),
	}, "task_id")},
	{"heartbeat_task", "Signal that work on a claimed task is still alive.", obj(map[string]interface{}{
		"task_id":       taskID,
		"fencing_token": integer("Fencing token returned by claim_task."),
	}, "task_id", "fencing_token")},
	{"submit_for_review", "Submit completed work for review with a summary of what was done.", obj(map[string]interface{}{
		"task_id":       taskID,
		"fencing_token": integer("Fencing token returned by claim_task."),
		"base_commit":   str("Commit before the submitted work."),
		"head_commit":   str("Commit containing the submitted work."),
		"summary":       str("What was changed and why the criteria are met."),
	}, "task_id", "fencing_token", "base_commit", "head_commit", "summary")},
	{"record_review", "Record a completion-review result for a submission.", obj(map[string]interface{}{
		"task_id":       taskID,
		"submission_id": integer("Submission identifier returned by submit_for_review."),
		"result":        str("pass, fail, evidence_insufficient, or clarification_needed."),
		"provider":      str("Review provider or agent name."),
		"findings":      str("Review findings, as text or JSON."),
	}, "task_id", "submission_id", "result", "provider", "findings")},
	{"record_qa", "Record an automated QA result with evidence.", obj(map[string]interface{}{
		"task_id":       taskID,
		"submission_id": integer("Submission identifier returned by submit_for_review."),
		"result":        str("pass, fail, evidence_insufficient, or clarification_needed."),
		"provider":      str("QA provider or agent name."),
		"findings":      str("QA findings, as text or JSON."),
	}, "task_id", "submission_id", "result", "provider", "findings")},
	{"release_task", "Release a claimed task back to Ready (work abandoned or blocked).", obj(map[string]interface{}{
		"task_id":       taskID,
		"fencing_token": integer("Fencing token returned by claim_task."),
	}, "task_id", "fencing_token")},
	{"get_task", "Fetch one task with its criteria, state, evidence, and reviews.", obj(map[string]interface{}{
		"task_id": taskID,
	}, "task_id")},
	{"add_comment", "Attach a comment to a task's thread.", obj(map[string]interface{}{
		"task_id": taskID,
		"type":    str("Comment type, such as progress or blocker."),
		"body":    str("Comment text."),
	}, "task_id", "type", "body")},
	{"request_approval_presentation", "Ask agentklar to surface a pending approval to the human. Carries no decision.", obj(map[string]interface{}{
		"task_id": taskID,
	}, "task_id")},
	{"get_context", "Get a focused work packet (knowledge + memory + code + ticket pointers) for a task or query, so you don't re-read the whole repo.", obj(map[string]interface{}{
		"task_id": str("Optional task id to build the packet around."),
		"query":   str("Optional free-text query for the context index."),
	})},
	{"remember", "Write a shared memory row (cross-session, cross-agent) with visible task and holder provenance. You cannot delete memory.", obj(map[string]interface{}{
		"namespace": str("Scope, usually the task id. Empty for global."),
		"key":       str("Stable key within the namespace."),
		"value":     str("The fact or note to remember."),
		"task_id":   str("Optional source task id for provenance."),
		"holder":    str("Agent holder writing the memory; defaults to 'agent'."),
	}, "key", "value")},
	{"recall", "Full-text search over shared memory.", obj(map[string]interface{}{
		"query": str("What to search for."),
		"limit": integer("Maximum results; defaults to 20."),
	}, "query")},
	{"notify_human", "Alert the human that you are blocked, need a decision, hit an error (e.g. network down), or finished and want more work. Always logged with provenance; never an approval.", obj(map[string]interface{}{
		"task_id":  str("Optional related task id."),
		"holder":   str("Agent holder raising the alert; defaults to 'agent'."),
		"severity": str("info | warn | error | block"),
		"message":  str("What to tell the human."),
		"speak":    boolean("Defaults to false for info and true for warn/error/block; high-severity alerts always deliver."),
	}, "severity", "message")},
}

// Prompt surface: the workflows a human reaches for from the client's
// slash menu. Approval stays human-only — no prompt drives a decision.

type PromptDef struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

var PromptDefs = []PromptDef{
	{"next", "Claim the next Ready task and work it to submission."},
	{"status", "Show the board: every task, its state, and what is blocked on a human."},
	{"ship", "Run local verification and submit the task for independent review."},
}

var PromptText = map[string]string{
	"next": "For explicitly tracked AgentKlar work, read get_team_policy, list_harnesses, and get_model_catalog; a model catalog does not prove access. Call list_ready_tasks, pick a suitable task, " +
		"claim it with claim_task, then read it fully with get_task. Implement the work so every " +
		"acceptance criterion is met. For opted-in delegation, call recommend_worker with the task, saved role when applicable, concrete capability requirements, and current selection before choosing a worker. Follow its action, reason, and limits; a nomination is not verified entitlement or a guarantee. Delegate only when useful: start_run needs a stable retry id and current claim holder/token; native launch validates access and permissions, edits currently require a quick/auto exclusive claim, reviews read_only=true. Read get_run until terminal, then get_completion_packet for recorded evidence and remaining checks; completed means worker execution, not task approval, and worker prose is not verification. Native permission requests need the trusted human interface. Run the declared local verification, then stop at submit_for_review " +
		"with an honest summary. The gate and reviewer record review and QA evidence; the agent must not " +
		"fabricate those results or attempt to approve. Tell the human what is awaiting review.",
	"status": "For AgentKlar work, bind_workspace for context and list_runs for native worker state; get_run shows results and pending native requests. get_completion_packet combines recorded checks, reviews, worker reports, and remaining work without running verification; worker prose and completed execution do not prove passing checks or human approval. get_usage reports sourced account snapshots, estimates, or unknowns. Then " +
		"get_task for each known task (start from list_ready_tasks and any tasks mentioned in this " +
		"conversation). Summarize as a short table: id, title, state, holder, and what action is " +
		"needed next — flagging anything waiting on human approval.",
	"ship": "For the task currently being worked in this conversation: re-read its acceptance " +
		"criteria with get_task, run the declared local verification, then stop at submit_for_review " +
		"with an honest summary. If any criterion is unmet, say so instead of submitting. The gate and " +
		"reviewer record review and QA evidence; the agent must not fabricate those results.",
}
