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

var ToolDefs = []ToolDef{
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
	"next": "Use the agentklar tools: call list_ready_tasks, pick the highest-priority task, " +
		"claim it with claim_task, then read it fully with get_task. Implement the work so every " +
		"acceptance criterion is met, run the declared local verification, then stop at submit_for_review " +
		"with an honest summary. The gate and reviewer record review and QA evidence; the agent must not " +
		"fabricate those results or attempt to approve. Tell the human what is awaiting review.",
	"status": "Use the agentklar tools to report the board: bind_workspace for context, then " +
		"get_task for each known task (start from list_ready_tasks and any tasks mentioned in this " +
		"conversation). Summarize as a short table: id, title, state, holder, and what action is " +
		"needed next — flagging anything waiting on human approval.",
	"ship": "For the task currently being worked in this conversation: re-read its acceptance " +
		"criteria with get_task, run the declared local verification, then stop at submit_for_review " +
		"with an honest summary. If any criterion is unmet, say so instead of submitting. The gate and " +
		"reviewer record review and QA evidence; the agent must not fabricate those results.",
}
