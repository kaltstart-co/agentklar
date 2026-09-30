package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/runs"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func TestRecommendationMCPRejectsCallerFactsAndOtherProjects(t *testing.T) {
	s, engine := newServer(t)
	s.Repository = t.TempDir()
	if err := engine.CreateTask(workflow.Task{ID: "TASK-1", Title: "local", RepoPath: s.Repository}); err != nil {
		t.Fatal(err)
	}
	if err := engine.CreateTask(workflow.Task{ID: "OTHER", Title: "other", RepoPath: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	called := false
	s.Runs = func(r runs.Request) (json.RawMessage, error) {
		called = true
		if r.Method != "recommend" || r.Recommend.TaskID != "TASK-1" || r.Recommend.RoleID != "builder" {
			t.Fatalf("bad bridge: %+v", r)
		}
		return json.RawMessage(`{"action":"nominate_worker","confidence":"limited","missing":["native access"]}`), nil
	}
	for _, params := range []string{
		`{"task_id":"OTHER","required_capabilities":["text"]}`,
		`{"task_id":"TASK-1","required_capabilities":["text"],"candidates":[]}`,
		`{"task_id":"TASK-1","required_capabilities":["text"],"access":"available"}`,
		`{"task_id":"TASK-1","required_capabilities":["text"],"quota":"available"}`,
		`{"task_id":"TASK-1","required_capabilities":["text"],"current":{"harness":"codex","model":"x","billing":"free"}}`,
		`{"task_id":"TASK-1"}`,
	} {
		response := s.Dispatch(Request{ID: json.RawMessage(`1`), Method: "recommend_worker", Params: json.RawMessage(params)})
		if response.Error == nil || called {
			t.Fatalf("untrusted/project-scoped facts reached supervisor: %+v", response)
		}
	}
	response := s.Dispatch(Request{ID: json.RawMessage(`2`), Method: "tools/call", Params: json.RawMessage(`{"name":"recommend_worker","arguments":{"task_id":"TASK-1","role_id":"builder","task_kind":"coding","required_capabilities":["text"],"current":{"harness":"codex","model":"native"}}}`)})
	if response.Error != nil || !called {
		t.Fatalf("valid recommendation failed: %+v", response)
	}
	raw, _ := json.Marshal(response.Result)
	if !strings.Contains(string(raw), "nominate_worker") || !strings.Contains(string(raw), "limited") {
		t.Fatalf("advice lost: %s", raw)
	}
}
