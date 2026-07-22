package mcp

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func newServer(t *testing.T) (*Server, *workflow.Engine) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	eng := workflow.New(db)
	return &Server{Engine: eng, Workspace: "ws-test"}, eng
}

// The agent-facing surface must expose no approval or completion method
// (acceptance criterion #7). This asserts the contract list itself is
// closed and that the dispatcher rejects the forbidden names.
func TestNoApprovalMethodOnAgentSurface(t *testing.T) {
	for _, m := range contracts.MCPMethods {
		low := strings.ToLower(m)
		if strings.Contains(low, "approve") && m != "request_approval_presentation" {
			t.Fatalf("agent surface exposes an approval method: %s", m)
		}
		if strings.Contains(low, "reject") || low == "mark_done" || low == "done" {
			t.Fatalf("agent surface exposes a completion method: %s", m)
		}
	}

	srv, _ := newServer(t)
	for _, forbidden := range contracts.ForbiddenMCPMethods {
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: forbidden})
		if resp.Error == nil {
			t.Fatalf("forbidden method %q was dispatched instead of rejected", forbidden)
		}
		if !strings.Contains(resp.Error.Message, "human") {
			t.Fatalf("rejection for %q should explain the human boundary, got %q", forbidden, resp.Error.Message)
		}
	}
}

// A model asking to surface an approval must not receive the nonce: the
// nonce reaches the human through the tracker, not through the agent.
func TestApprovalPresentationWithholdsNonce(t *testing.T) {
	srv, eng := newServer(t)
	if err := eng.CreateTask(workflow.Task{
		ID: "T1", Project: "p", Title: "t", Lane: contracts.LaneQuick,
		Criteria: []string{"c"}, Verification: "v",
	}); err != nil {
		t.Fatal(err)
	}
	eng.MarkReady("T1", contracts.ActorHuman)
	c, err := eng.ClaimTask("T1", "agent", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	sub, _ := eng.SubmitForReview("T1", c.FencingToken, "b", "h", "s")
	eng.RecordReview("T1", sub, "completion", contracts.ResultPass, "det", "[]")
	eng.RecordReview("T1", sub, "qa", contracts.ResultPass, "det", "[]")

	nonce, _, err := eng.PendingApproval("T1")
	if err != nil {
		t.Fatal(err)
	}
	resp := srv.Dispatch(Request{
		JSONRPC: "2.0", ID: json.RawMessage(`1`),
		Method: "request_approval_presentation",
		Params: json.RawMessage(`{"task_id":"T1"}`),
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	body, _ := json.Marshal(resp.Result)
	if strings.Contains(string(body), nonce) {
		t.Fatal("the approval nonce leaked to the agent surface")
	}
}

// Agent comments are always attributed to the agent actor; a model cannot
// post as a human and thereby forge an approval author.
func TestAgentCommentsCannotImpersonateHuman(t *testing.T) {
	srv, eng := newServer(t)
	eng.CreateTask(workflow.Task{ID: "T1", Project: "p", Title: "t", Criteria: []string{"c"}, Verification: "v"})
	resp := srv.Dispatch(Request{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "add_comment",
		Params: json.RawMessage(`{"task_id":"T1","type":"Progress","body":"approve please","actor":"human"}`),
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	var actor string
	row := srv.Engine.DB().QueryRow(`SELECT actor FROM comments WHERE task_id = 'T1'`)
	if err := row.Scan(&actor); err != nil {
		t.Fatal(err)
	}
	if actor != string(contracts.ActorAgent) {
		t.Fatalf("agent comment recorded as %q; must always be agent", actor)
	}
}

// A full claim → submit round trip works over the JSON-RPC surface.
func TestClaimAndSubmitOverMCP(t *testing.T) {
	srv, eng := newServer(t)
	eng.CreateTask(workflow.Task{
		ID: "T1", Project: "p", Title: "t", Lane: contracts.LaneStandard,
		Criteria: []string{"c"}, Verification: "v",
	})
	eng.MarkReady("T1", contracts.ActorHuman)

	resp := srv.Dispatch(Request{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "claim_task",
		Params: json.RawMessage(`{"task_id":"T1","expected_state":"ready","holder":"codex"}`),
	})
	if resp.Error != nil {
		t.Fatalf("claim failed: %v", resp.Error)
	}
	m := resp.Result.(map[string]interface{})
	token := m["fencing_token"].(int64)

	params, _ := json.Marshal(map[string]interface{}{
		"task_id": "T1", "fencing_token": token,
		"base_commit": "aaa", "head_commit": "bbb", "summary": "done",
	})
	resp = srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`2`), Method: "submit_for_review", Params: params})
	if resp.Error != nil {
		t.Fatalf("submit failed: %v", resp.Error)
	}
	task, _ := eng.GetTask("T1")
	if task.State != contracts.StateCompletionReview {
		t.Fatalf("expected Completion Review, got %s", task.State)
	}
}
