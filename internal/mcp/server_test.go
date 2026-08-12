package mcp

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/notify"
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

func TestRememberImmediatelyUpdatesMemoryAndContext(t *testing.T) {
	dir := t.TempDir()
	mem, err := memory.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mem.Close() })
	contextStore, err := akctx.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { contextStore.Close() })
	srv, _ := newServer(t)
	srv.Memory, srv.Context = mem, contextStore

	remember := func(value string) {
		t.Helper()
		params, _ := json.Marshal(map[string]string{
			"namespace": "T1", "key": "decision", "value": value,
			"task_id": "T1", "holder": "codex",
		})
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "remember", Params: params})
		if resp.Error != nil {
			t.Fatalf("remember %q: %v", value, resp.Error)
		}
	}
	recall := func(query string) []memory.Entry {
		t.Helper()
		params, _ := json.Marshal(map[string]interface{}{"query": query, "limit": 10})
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`2`), Method: "recall", Params: params})
		if resp.Error != nil {
			t.Fatalf("recall %q: %v", query, resp.Error)
		}
		return resp.Result.(map[string]interface{})["results"].([]memory.Entry)
	}
	getContext := func(query string) []akctx.Doc {
		t.Helper()
		params, _ := json.Marshal(map[string]string{"query": query})
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`3`), Method: "get_context", Params: params})
		if resp.Error != nil {
			t.Fatalf("get_context %q: %v", query, resp.Error)
		}
		return resp.Result.(akctx.Packet).Items
	}

	remember("oranges are preferred")
	if got := recall("oranges"); len(got) != 1 || got[0].Value != "oranges are preferred" {
		t.Fatalf("recall after remember = %#v", got)
	}
	rows, err := mem.List("")
	if err != nil {
		t.Fatal(err)
	}
	first := getContext("oranges")
	if len(first) != 1 || first[0].Source != akctx.SourceMemory || first[0].Ref != akctx.MemoryRef(rows[0].ID) {
		t.Fatalf("context after remember = %#v", first)
	}
	if _, err := contextStore.Index([]akctx.Doc{{
		Source: akctx.SourceMemory,
		Ref:    akctx.MemoryRef(rows[0].ID),
		Title:  rows[0].Namespace + "/" + rows[0].Key,
		Body:   rows[0].Value,
	}}); err != nil {
		t.Fatalf("manual full reindex: %v", err)
	}

	remember("bananas are preferred")
	if got := recall("oranges"); len(got) != 0 {
		t.Fatalf("old memory remained searchable after update: %#v", got)
	}
	updated := getContext("bananas")
	if len(updated) != 1 || updated[0].Ref != first[0].Ref {
		t.Fatalf("context update duplicated or changed ref: first=%#v updated=%#v", first, updated)
	}
	if got := getContext("oranges"); len(got) != 0 {
		t.Fatalf("old context remained searchable after update: %#v", got)
	}
}

func TestRememberReportsContextProjectionFailureWithoutLosingMemory(t *testing.T) {
	dir := t.TempDir()
	mem, err := memory.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mem.Close() })
	contextStore, err := akctx.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := contextStore.Close(); err != nil {
		t.Fatal(err)
	}
	srv, _ := newServer(t)
	srv.Memory, srv.Context = mem, contextStore

	resp := srv.Dispatch(Request{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "remember",
		Params: json.RawMessage(`{"key":"decision","value":"keep this"}`),
	})
	if resp.Error != nil {
		t.Fatalf("remember returned an error after durable mutation: %v", resp.Error)
	}
	result := resp.Result.(map[string]interface{})
	if result["status"] != "remembered" || result["context_indexed"] != false || !strings.Contains(result["warning"].(string), "context") {
		t.Fatalf("remember result = %#v", result)
	}
	if got, err := mem.Recall("keep", 10); err != nil || len(got) != 1 {
		t.Fatalf("durable memory missing after projection failure: got=%#v err=%v", got, err)
	}
}

func TestMalformedParamsReturnInvalidParams(t *testing.T) {
	srv, _ := newServer(t)
	for _, method := range contracts.MCPMethods {
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: method, Params: json.RawMessage(`{`)})
		if resp.Error == nil || resp.Error.Code != -32602 {
			t.Errorf("%s malformed params response = %#v, want -32602", method, resp)
		}
	}
}

func TestMissingRequiredParamsReturnInvalidParams(t *testing.T) {
	srv, _ := newServer(t)
	for _, def := range ToolDefs {
		if _, required := def.InputSchema["required"]; !required {
			continue
		}
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: def.Name, Params: json.RawMessage(`{}`)})
		if resp.Error == nil || resp.Error.Code != -32602 {
			t.Errorf("%s missing params response = %#v, want -32602", def.Name, resp)
		}
	}
}

func TestStateChangingToolsRoundTripThroughDispatch(t *testing.T) {
	srv, eng := newServer(t)
	createReady := func(id string) {
		t.Helper()
		if err := eng.CreateTask(workflow.Task{ID: id, Project: "p", Title: id, Lane: contracts.LaneStandard, Criteria: []string{"c"}, Verification: "v"}); err != nil {
			t.Fatal(err)
		}
		if err := eng.MarkReady(id, contracts.ActorHuman); err != nil {
			t.Fatal(err)
		}
	}
	call := func(method string, params interface{}) map[string]interface{} {
		t.Helper()
		raw, _ := json.Marshal(params)
		resp := srv.Dispatch(Request{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: method, Params: raw})
		if resp.Error != nil {
			t.Fatalf("%s: %v", method, resp.Error)
		}
		if result, ok := resp.Result.(map[string]interface{}); ok {
			return result
		}
		return nil
	}

	createReady("release")
	claim := call("claim_task", map[string]interface{}{"task_id": "release", "holder": "codex"})
	token := claim["fencing_token"].(int64)
	call("heartbeat_task", map[string]interface{}{"task_id": "release", "fencing_token": token})
	call("add_comment", map[string]interface{}{"task_id": "release", "type": "progress", "body": "working"})
	call("release_task", map[string]interface{}{"task_id": "release", "fencing_token": token})
	if task, _ := eng.GetTask("release"); task.State != contracts.StateReady {
		t.Fatalf("released task state = %s", task.State)
	}

	createReady("review")
	claim = call("claim_task", map[string]interface{}{"task_id": "review", "holder": "codex"})
	token = claim["fencing_token"].(int64)
	submission := call("submit_for_review", map[string]interface{}{
		"task_id": "review", "fencing_token": token, "base_commit": "a", "head_commit": "b", "summary": "verified",
	})["submission_id"].(int64)
	call("record_review", map[string]interface{}{"task_id": "review", "submission_id": submission, "result": "pass", "provider": "reviewer", "findings": "[]"})
	call("record_qa", map[string]interface{}{"task_id": "review", "submission_id": submission, "result": "pass", "provider": "gate", "findings": "[]"})
	if task, _ := eng.GetTask("review"); task.State != contracts.StateUserApproval {
		t.Fatalf("reviewed task state = %s, want user_approval", task.State)
	}

	dir := t.TempDir()
	mem, err := memory.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mem.Close() })
	alerts, err := notify.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { alerts.Close() })
	srv.Memory, srv.Notify = mem, alerts
	call("remember", map[string]interface{}{"key": "decision", "value": "stdlib", "holder": "codex"})
	notified := call("notify_human", map[string]interface{}{"severity": "info", "message": "review ready", "holder": "codex"})
	if notified["speak"] != false {
		t.Fatalf("info default speak = %#v, want false", notified["speak"])
	}
	if task, _ := eng.GetTask("review"); task.State == contracts.StateDone {
		t.Fatal("agent-facing tools crossed the human-only Done boundary")
	}
}

func TestDefaultSpeakFollowsSeverity(t *testing.T) {
	for _, tc := range []struct {
		severity notify.Severity
		want     bool
	}{
		{notify.Info, false},
		{notify.Warn, true},
		{notify.Error, true},
		{notify.Block, true},
	} {
		if got := defaultSpeak(tc.severity); got != tc.want {
			t.Errorf("defaultSpeak(%s) = %v, want %v", tc.severity, got, tc.want)
		}
	}
}
