package mcp

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/contracts"
)

func TestToolDefinitionsMatchDispatchContract(t *testing.T) {
	expected := map[string]struct {
		properties map[string]string
		required   []string
	}{
		"bind_workspace":                {map[string]string{}, nil},
		"list_ready_tasks":              {map[string]string{"execution_target": "string"}, nil},
		"claim_task":                    {map[string]string{"task_id": "string", "expected_state": "string", "holder": "string"}, []string{"task_id"}},
		"heartbeat_task":                {map[string]string{"task_id": "string", "fencing_token": "integer"}, []string{"task_id", "fencing_token"}},
		"submit_for_review":             {map[string]string{"task_id": "string", "fencing_token": "integer", "base_commit": "string", "head_commit": "string", "summary": "string"}, []string{"task_id", "fencing_token", "base_commit", "head_commit", "summary"}},
		"record_review":                 {map[string]string{"task_id": "string", "submission_id": "integer", "result": "string", "provider": "string", "findings": "string"}, []string{"task_id", "submission_id", "result", "provider", "findings"}},
		"record_qa":                     {map[string]string{"task_id": "string", "submission_id": "integer", "result": "string", "provider": "string", "findings": "string"}, []string{"task_id", "submission_id", "result", "provider", "findings"}},
		"release_task":                  {map[string]string{"task_id": "string", "fencing_token": "integer"}, []string{"task_id", "fencing_token"}},
		"get_task":                      {map[string]string{"task_id": "string"}, []string{"task_id"}},
		"add_comment":                   {map[string]string{"task_id": "string", "type": "string", "body": "string"}, []string{"task_id", "type", "body"}},
		"request_approval_presentation": {map[string]string{"task_id": "string"}, []string{"task_id"}},
		"get_context":                   {map[string]string{"task_id": "string", "query": "string"}, nil},
		"remember":                      {map[string]string{"namespace": "string", "key": "string", "value": "string", "task_id": "string", "holder": "string"}, []string{"key", "value"}},
		"recall":                        {map[string]string{"query": "string", "limit": "integer"}, []string{"query"}},
		"notify_human":                  {map[string]string{"task_id": "string", "holder": "string", "severity": "string", "message": "string", "speak": "boolean"}, []string{"severity", "message"}},
	}

	if len(ToolDefs) != len(contracts.MCPMethods) {
		t.Fatalf("got %d tool definitions for %d contract methods", len(ToolDefs), len(contracts.MCPMethods))
	}
	for _, def := range ToolDefs {
		want, ok := expected[def.Name]
		if !ok {
			t.Fatalf("unexpected tool definition %q", def.Name)
		}
		props := def.InputSchema["properties"].(map[string]interface{})
		gotProps := make(map[string]string, len(props))
		for name, raw := range props {
			gotProps[name] = raw.(map[string]interface{})["type"].(string)
		}
		if !reflect.DeepEqual(gotProps, want.properties) {
			t.Errorf("%s properties = %v, want %v", def.Name, gotProps, want.properties)
		}
		var gotRequired []string
		if raw, ok := def.InputSchema["required"]; ok {
			gotRequired = append(gotRequired, raw.([]string)...)
		}
		sort.Strings(gotRequired)
		sort.Strings(want.required)
		if !reflect.DeepEqual(gotRequired, want.required) {
			t.Errorf("%s required = %v, want %v", def.Name, gotRequired, want.required)
		}
		delete(expected, def.Name)
	}
	if len(expected) != 0 {
		t.Fatalf("missing tool definitions: %v", expected)
	}
}

func TestRecallDescriptionMatchesReturnedSources(t *testing.T) {
	for _, def := range ToolDefs {
		if def.Name == "recall" && def.Description != "Full-text search over shared memory." {
			t.Fatalf("recall description overclaims its sources: %q", def.Description)
		}
	}
}

func TestPromptsStopAtSubmissionAndReserveReviewsForTheGate(t *testing.T) {
	for _, name := range []string{"next", "ship"} {
		text := PromptText[name]
		if strings.Contains(text, "record_qa") || strings.Contains(text, "record_review") {
			t.Errorf("%s prompt asks the agent to fabricate a review: %q", name, text)
		}
		for _, required := range []string{"local verification", "submit_for_review", "gate", "review"} {
			if !strings.Contains(strings.ToLower(text), required) {
				t.Errorf("%s prompt does not explain %q: %q", name, required, text)
			}
		}
	}
}
