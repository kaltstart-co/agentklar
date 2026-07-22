// Package contracts freezes the Agentklar workflow contracts from the
// 2026-07-15 design spec §10 and the master delivery plan Task 1.
//
// Everything here is deliberately dependency-free: these types are the
// authority that store, workflow, tracker, and MCP layers must conform to.
package contracts

import "time"

// State is a protected workflow state owned by control.sqlite.
type State string

const (
	StateDraft            State = "draft"
	StateReady            State = "ready"
	StateInProgress       State = "in_progress"
	StateCompletionReview State = "completion_review"
	StateAutoQA           State = "auto_qa"
	StateUserApproval     State = "user_approval"
	StateDone             State = "done"
	StateChangesRequested State = "changes_requested"
	StateWaiting          State = "waiting"
	StateBlocked          State = "blocked"
	StateCancelled        State = "cancelled"
)

// Actor identifies who may request a transition. The distinction between
// ActorAgent and ActorHuman is enforced by channel, not by claim: agent
// requests arrive via MCP, human requests arrive only via a trusted
// approval channel (nonce-bound tracker comment or client elicitation).
type Actor string

const (
	ActorAgent  Actor = "agent"  // any model session via MCP
	ActorHuman  Actor = "human"  // trusted human channel only — never MCP
	ActorSystem Actor = "system" // agentklar itself (gates, reconciliation)
)

// Transition is one allowed edge in the task state machine.
type Transition struct {
	From  State
	To    State
	Actor Actor
	// Reason documents the operation that performs this transition.
	Reason string
}

// Transitions is the complete frozen transition table. Any transition not
// listed here is rejected. There is intentionally NO edge into StateDone
// with ActorAgent: Done is reachable only by ActorHuman.
var Transitions = []Transition{
	{StateDraft, StateReady, ActorHuman, "definition of ready approved"},
	{StateDraft, StateReady, ActorAgent, "quick-lane ready (DoR template satisfied)"},
	{StateDraft, StateCancelled, ActorHuman, "cancelled"},

	{StateReady, StateInProgress, ActorAgent, "claim_task"},
	{StateReady, StateDraft, ActorHuman, "readiness withdrawn"},
	{StateReady, StateCancelled, ActorHuman, "cancelled"},

	{StateInProgress, StateCompletionReview, ActorAgent, "submit_for_review"},
	{StateInProgress, StateReady, ActorSystem, "lease expired and released"},
	{StateInProgress, StateReady, ActorAgent, "release_task"},
	{StateInProgress, StateWaiting, ActorAgent, "waiting_on recorded"},
	{StateInProgress, StateBlocked, ActorAgent, "blocked"},
	{StateInProgress, StateCancelled, ActorHuman, "cancelled"},

	{StateWaiting, StateInProgress, ActorAgent, "waiting resolved"},
	{StateBlocked, StateInProgress, ActorAgent, "unblocked"},
	{StateBlocked, StateCancelled, ActorHuman, "cancelled"},

	{StateCompletionReview, StateAutoQA, ActorSystem, "completion gate passed"},
	{StateCompletionReview, StateChangesRequested, ActorSystem, "completion gate failed"},
	{StateCompletionReview, StateChangesRequested, ActorSystem, "stale head commit"},

	{StateAutoQA, StateUserApproval, ActorSystem, "auto qa passed"},
	{StateAutoQA, StateChangesRequested, ActorSystem, "auto qa failed"},

	{StateUserApproval, StateDone, ActorHuman, "trusted human approval"},
	{StateUserApproval, StateChangesRequested, ActorHuman, "human rejection"},
	{StateUserApproval, StateChangesRequested, ActorSystem, "stale head commit"},

	{StateChangesRequested, StateInProgress, ActorAgent, "revision claimed"},
	{StateChangesRequested, StateCancelled, ActorHuman, "cancelled"},
}

// Allowed reports whether actor may move a task from one state to another.
func Allowed(from, to State, actor Actor) bool {
	for _, t := range Transitions {
		if t.From == from && t.To == to && t.Actor == actor {
			return true
		}
	}
	return false
}

// Lane is the risk lane of a task (spec §11).
type Lane string

const (
	LaneQuick    Lane = "quick"
	LaneStandard Lane = "standard"
	LaneMajor    Lane = "major"
)

// Isolation is the repository-isolation mode for a claim (spec §10.1).
type Isolation string

const (
	// IsolationAuto: Quick tasks may use the clean primary worktree under an
	// exclusive repository lease; otherwise a dedicated worktree is created.
	IsolationAuto Isolation = "auto"
	// IsolationWorktree: dedicated branch + worktree (Standard/Major default).
	IsolationWorktree Isolation = "worktree"
	// IsolationNone: docs/research tasks that change no code.
	IsolationNone Isolation = "none"
)

// Provenance classifies evidence trust (spec §10.7).
type Provenance string

const (
	// MachineAttested: agentklar itself executed the recipe and recorded the result.
	MachineAttested Provenance = "machine_attested"
	// AgentReported: a model supplied the claim; untrusted supporting material.
	AgentReported Provenance = "agent_reported"
	// HumanObserved: the user recorded a manual check.
	HumanObserved Provenance = "human_observed"
)

// ExecutionTarget identifies the harness expected to claim a task.
type ExecutionTarget string

const (
	TargetAny      ExecutionTarget = "any"
	TargetCodex    ExecutionTarget = "codex"
	TargetClaude   ExecutionTarget = "claude"
	TargetGemini   ExecutionTarget = "gemini"
	TargetOpenCode ExecutionTarget = "opencode"
)

// Lease durations. Heartbeats extend the lease; expiry never deletes work,
// it only prevents submission until reclaimed.
const (
	DefaultLeaseTTL       = 30 * time.Minute
	DefaultHeartbeatEvery = 5 * time.Minute
	// ApprovalNonceTTL bounds how long a pending human-approval nonce is valid.
	ApprovalNonceTTL = 72 * time.Hour
)

// MCPMethods is the complete agent-facing MCP surface (spec §10.11).
// There is intentionally no approve, reject, or done method. Adding one is
// a contract violation; tests assert this list is closed.
var MCPMethods = []string{
	"bind_workspace",
	"list_ready_tasks",
	"claim_task",
	"heartbeat_task",
	"submit_for_review",
	"record_review",
	"record_qa",
	"release_task",
	"get_task",
	"add_comment",
	"request_approval_presentation", // asks agentklar to surface a pending approval; carries no decision
}

// ForbiddenMCPMethods are operations that must never appear on the agent
// surface. Kept as an explicit list so tests can assert the boundary.
var ForbiddenMCPMethods = []string{"approve_task", "reject_task", "mark_done", "approve", "done"}

// ReviewResult is the outcome of a completion-review or QA stage.
type ReviewResult string

const (
	ResultPass                 ReviewResult = "pass"
	ResultFail                 ReviewResult = "fail"
	ResultEvidenceInsufficient ReviewResult = "evidence_insufficient"
	ResultClarificationNeeded  ReviewResult = "clarification_needed"
)

// MaxAutoReviewCycles stops automated implement/review loops (spec §10.5).
const MaxAutoReviewCycles = 3
