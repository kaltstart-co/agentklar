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
		"task_id": taskID,
	}, "task_id")},
	{"submit_for_review", "Submit completed work for review with a summary of what was done.", obj(map[string]interface{}{
		"task_id": taskID,
		"summary": str("What was changed and why the criteria are met."),
	}, "task_id")},
	{"record_review", "Record a completion-review result for a submission.", obj(map[string]interface{}{
		"task_id": taskID,
		"result":  str("pass or fail"),
		"notes":   str("Reviewer notes."),
	}, "task_id", "result")},
	{"record_qa", "Record an automated QA result with evidence.", obj(map[string]interface{}{
		"task_id":  taskID,
		"result":   str("pass or fail"),
		"command":  str("Command that was run."),
		"exit_code": map[string]interface{}{"type": "integer", "description": "Exit code of the command."},
		"log":      str("Trimmed output as evidence."),
	}, "task_id", "result")},
	{"release_task", "Release a claimed task back to Ready (work abandoned or blocked).", obj(map[string]interface{}{
		"task_id": taskID,
		"reason":  str("Why the task is being released."),
	}, "task_id")},
	{"get_task", "Fetch one task with its criteria, state, evidence, and reviews.", obj(map[string]interface{}{
		"task_id": taskID,
	}, "task_id")},
	{"add_comment", "Attach a comment to a task's thread.", obj(map[string]interface{}{
		"task_id": taskID,
		"body":    str("Comment text."),
	}, "task_id", "body")},
	{"request_approval_presentation", "Ask agentklar to surface a pending approval to the human. Carries no decision.", obj(map[string]interface{}{
		"task_id": taskID,
	}, "task_id")},
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
	{"ship", "Submit the task you are working on for review with QA evidence."},
}

var PromptText = map[string]string{
	"next": "Use the agentklar tools: call list_ready_tasks, pick the highest-priority task, " +
		"claim it with claim_task, then read it fully with get_task. Implement the work so every " +
		"acceptance criterion is met, run the task's verify command, then submit_for_review with a " +
		"summary and record_qa with the command output as evidence. Do not attempt to approve — " +
		"tell the human what is awaiting their approval.",
	"status": "Use the agentklar tools to report the board: bind_workspace for context, then " +
		"get_task for each known task (start from list_ready_tasks and any tasks mentioned in this " +
		"conversation). Summarize as a short table: id, title, state, holder, and what action is " +
		"needed next — flagging anything waiting on human approval.",
	"ship": "For the task currently being worked in this conversation: re-read its acceptance " +
		"criteria with get_task, run its verify command, record_qa with the real command output, " +
		"then submit_for_review with an honest summary of what changed. If any criterion is unmet, " +
		"say so instead of submitting.",
}
