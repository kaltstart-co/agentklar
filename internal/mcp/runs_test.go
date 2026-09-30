package mcp

import (
	"encoding/json"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/runs"
)

func TestNativeRunBridgeAndNoPermissionResponse(t *testing.T) {
	var called runs.Request
	s := &Server{Runs: func(r runs.Request) (json.RawMessage, error) {
		called = r
		return json.RawMessage(`{"id":"run-1","status":"starting"}`), nil
	}}
	r := s.Dispatch(Request{ID: json.RawMessage(`1`), Method: "start_run", Params: json.RawMessage(`{"id":"run-1","task_id":"TASK-1","holder":"host","fencing_token":1,"prompt":"bounded work"}`)})
	if r.Error != nil || called.Method != "start" || called.Start.Harness != "codex" || called.Start.Purpose != "implement" {
		t.Fatalf("bridge result %+v request %+v", r, called)
	}
	r = s.Dispatch(Request{ID: json.RawMessage(`1`), Method: "respond_native_permission", Params: json.RawMessage(`{"decision":"accept"}`)})
	if r.Error == nil || r.Error.Code != -32601 {
		t.Fatalf("agent native permission method accepted: %+v", r)
	}
}
