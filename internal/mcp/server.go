// Package mcp exposes the agent-facing MCP surface over stdio.
//
// CRITICAL CONTRACT: this surface exposes no approve, reject, or done
// operation. A model may ask Agentklar to PRESENT a pending approval, but
// it cannot supply the decision. The human-only Done boundary is enforced
// here by omission and asserted by tests against contracts.MCPMethods.
package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/kaltstart-co/agentklar/internal/completion"
	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/notify"
	"github.com/kaltstart-co/agentklar/internal/runs"
	"github.com/kaltstart-co/agentklar/internal/team"
	"github.com/kaltstart-co/agentklar/internal/tracker"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Server struct {
	Runs       func(runs.Request) (json.RawMessage, error)
	Repository string
	Engine     *workflow.Engine
	Workspace  string
	Policy     tracker.ApprovalPolicy
	// Memory and Context are optional shared-knowledge stores. When nil,
	// the corresponding methods return "unavailable" — they never affect the
	// workflow state machine or the human-only Done boundary.
	Memory  *memory.Store
	Context *akctx.Store
	// Notify is the optional human-alert store. When nil, notify_human returns
	// "unavailable". It only records alerts — never an approval path.
	Notify *notify.Store
}

// Serve runs a line-delimited JSON-RPC loop over stdio.
func (s *Server) Serve(in io.Reader, out io.Writer) error {
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	enc := json.NewEncoder(out)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			enc.Encode(Response{JSONRPC: "2.0", Error: &RPCError{-32700, "parse error"}})
			continue
		}
		resp := s.Dispatch(req)
		if req.ID != nil {
			enc.Encode(resp)
		}
	}
	return sc.Err()
}

// Dispatch routes one request. Forbidden methods are rejected explicitly
// rather than falling through to "unknown method", so an attempt to
// approve via MCP is visible in logs.
func (s *Server) Dispatch(req Request) Response {
	resp := Response{JSONRPC: "2.0", ID: req.ID}

	for _, forbidden := range contracts.ForbiddenMCPMethods {
		if req.Method == forbidden {
			resp.Error = &RPCError{-32601,
				"approval and completion are not agent-callable; a human must approve through a trusted channel"}
			return resp
		}
	}

	fail := func(err error) Response {
		resp.Error = &RPCError{-32000, err.Error()}
		return resp
	}
	invalid := func(err error) Response {
		resp.Error = &RPCError{-32602, err.Error()}
		return resp
	}
	decode := func(dst interface{}) *Response {
		raw := req.Params
		if len(raw) == 0 {
			raw = json.RawMessage(`{}`)
		}
		if err := json.Unmarshal(raw, dst); err != nil {
			r := invalid(fmt.Errorf("invalid params: %w", err))
			return &r
		}
		return nil
	}
	require := func(fields ...string) *Response {
		for i := 0; i < len(fields); i += 2 {
			if strings.TrimSpace(fields[i+1]) == "" {
				r := invalid(fmt.Errorf("missing required parameter %s", fields[i]))
				return &r
			}
		}
		return nil
	}
	positive := func(name string, value int64) *Response {
		if value <= 0 {
			r := invalid(fmt.Errorf("missing or invalid required parameter %s", name))
			return &r
		}
		return nil
	}

	switch req.Method {
	case "get_completion_packet":
		var p struct {
			TaskID string `json:"task_id"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		packet, err := completion.Build(s.Engine, s.Context, p.TaskID)
		if err != nil {
			return fail(err)
		}
		resp.Result = packet
	case "recommend_worker":
		var p runs.RecommendationRequest
		decoder := json.NewDecoder(bytes.NewReader(req.Params))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&p); err != nil {
			return invalid(fmt.Errorf("invalid recommendation params: %w", err))
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			return invalid(fmt.Errorf("recommendation params must contain one JSON object"))
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		if len(p.RequiredCapabilities) == 0 {
			return invalid(fmt.Errorf("required_capabilities must contain concrete capability requirements"))
		}
		if s.Repository == "" || s.Engine == nil {
			return fail(fmt.Errorf("repository unavailable"))
		}
		task, err := s.Engine.GetTask(p.TaskID)
		if err != nil {
			return fail(err)
		}
		if task.RepoPath != s.Repository {
			return fail(fmt.Errorf("recommendation task is outside this repository"))
		}
		if s.Runs == nil {
			return fail(fmt.Errorf("native supervisor unavailable; start agentklar serve in this repository"))
		}
		value, err := s.Runs(runs.Request{Method: "recommend", Recommend: p})
		if err != nil {
			return fail(err)
		}
		resp.Result = value
	case "get_team_policy":
		if bad := decode(&struct{}{}); bad != nil {
			return *bad
		}
		if s.Repository == "" {
			return fail(fmt.Errorf("repository unavailable"))
		}
		policy, err := team.Load(s.Repository)
		if err != nil {
			return fail(err)
		}
		resp.Result = policy
	case "list_harnesses", "get_model_catalog", "get_usage", "list_runs", "get_run", "start_run", "cancel_run":
		if bad := decode(&struct{}{}); bad != nil {
			return *bad
		}
		request := runs.Request{}
		switch req.Method {
		case "get_usage":
			if bad := decode(&request); bad != nil {
				return *bad
			}
			request.Method = "usage"
		case "list_harnesses":
			request.Method = "harnesses"
		case "get_model_catalog":
			request.Method = "models"
		case "list_runs":
			request.Method = "list"
		case "start_run":
			request.Method = "start"
			if bad := decode(&request.Start); bad != nil {
				return *bad
			}
			if bad := require("id", request.Start.ID, "task_id", request.Start.TaskID, "holder", request.Start.Holder, "prompt", request.Start.Prompt); bad != nil {
				return *bad
			}
			if bad := positive("fencing_token", request.Start.FencingToken); bad != nil {
				return *bad
			}
			if request.Start.Harness == "" {
				request.Start.Harness = "codex"
			}
			if request.Start.Purpose == "" {
				request.Start.Purpose = "implement"
			}
		case "get_run", "cancel_run":
			if bad := decode(&request); bad != nil {
				return *bad
			}
			if bad := require("id", request.ID); bad != nil {
				return *bad
			}
			request.Method = "get"
			if request.After < 0 {
				return invalid(fmt.Errorf("after must be nonnegative"))
			}
			if req.Method == "cancel_run" {
				request.Method = "cancel"
				if bad := require("holder", request.Holder); bad != nil {
					return *bad
				}
				if bad := positive("fencing_token", request.FencingToken); bad != nil {
					return *bad
				}
			}
		}
		if s.Runs == nil {
			return fail(fmt.Errorf("native supervisor unavailable"))
		}
		value, err := s.Runs(request)
		if err != nil {
			return fail(err)
		}
		resp.Result = value
	case "initialize":
		resp.Result = map[string]interface{}{
			"protocolVersion": "2025-06-18",
			"serverInfo":      map[string]string{"name": "agentklar", "version": "0.1.0-dev"},
			"capabilities": map[string]interface{}{
				"tools":   map[string]interface{}{},
				"prompts": map[string]interface{}{},
			},
		}

	case "prompts/list":
		resp.Result = map[string]interface{}{"prompts": PromptDefs}

	case "prompts/get":
		var p struct {
			Name string `json:"name"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("name", p.Name); bad != nil {
			return *bad
		}
		text, ok := PromptText[p.Name]
		if !ok {
			resp.Error = &RPCError{-32602, fmt.Sprintf("unknown prompt %q", p.Name)}
			return resp
		}
		resp.Result = map[string]interface{}{
			"messages": []map[string]interface{}{{
				"role":    "user",
				"content": map[string]string{"type": "text", "text": text},
			}},
		}

	case "tools/list":
		// MCP spec shape: a `tools` array with schemas. (list_methods kept
		// below for the legacy flat protocol.)
		resp.Result = map[string]interface{}{"tools": ToolDefs}

	case "list_methods":
		resp.Result = map[string]interface{}{"methods": contracts.MCPMethods}

	case "tools/call":
		// Spec-compliant wrapper: unwrap {name, arguments} and dispatch to
		// the flat method, then wrap the result as tool content.
		var call struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if bad := decode(&call); bad != nil {
			return *bad
		}
		if bad := require("name", call.Name); bad != nil {
			return *bad
		}
		inner := s.Dispatch(Request{JSONRPC: req.JSONRPC, ID: req.ID, Method: call.Name, Params: call.Arguments})
		if inner.Error != nil {
			// Tool-level failure: surface to the model, not the transport.
			resp.Result = map[string]interface{}{
				"content": []map[string]interface{}{{"type": "text", "text": inner.Error.Message}},
				"isError": true,
			}
			return resp
		}
		body, err := json.Marshal(inner.Result)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]interface{}{
			"content": []map[string]interface{}{{"type": "text", "text": string(body)}},
		}

	case "bind_workspace":
		var p struct{}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		resp.Result = map[string]string{"workspace": s.Workspace}

	case "list_ready_tasks":
		var p struct {
			ExecutionTarget string `json:"execution_target"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		target := contracts.ExecutionTarget(p.ExecutionTarget)
		if target == "" {
			target = contracts.TargetAny
		}
		tasks, err := s.Engine.ListReady(target)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]interface{}{"tasks": tasks}

	case "get_task":
		var p struct {
			TaskID string `json:"task_id"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		t, err := s.Engine.GetTask(p.TaskID)
		if err != nil {
			return fail(err)
		}
		resp.Result = t

	case "claim_task":
		var p struct {
			TaskID        string `json:"task_id"`
			ExpectedState string `json:"expected_state"`
			Holder        string `json:"holder"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		if p.Holder == "" {
			p.Holder = "agent"
		}
		expected := contracts.State(p.ExpectedState)
		if expected == "" {
			expected = contracts.StateReady
		}
		claim, err := s.Engine.ClaimTask(p.TaskID, p.Holder, expected)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]interface{}{
			"task_id":       claim.TaskID,
			"fencing_token": claim.FencingToken,
			"expires_at":    claim.ExpiresAt,
			"worktree":      claim.Worktree,
		}

	case "heartbeat_task":
		var p struct {
			TaskID       string `json:"task_id"`
			FencingToken int64  `json:"fencing_token"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		if bad := positive("fencing_token", p.FencingToken); bad != nil {
			return *bad
		}
		if err := s.Engine.Heartbeat(p.TaskID, p.FencingToken); err != nil {
			return fail(err)
		}
		resp.Result = map[string]string{"status": "ok"}

	case "submit_for_review":
		var p struct {
			TaskID       string `json:"task_id"`
			FencingToken int64  `json:"fencing_token"`
			BaseCommit   string `json:"base_commit"`
			HeadCommit   string `json:"head_commit"`
			Summary      string `json:"summary"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID, "base_commit", p.BaseCommit, "head_commit", p.HeadCommit, "summary", p.Summary); bad != nil {
			return *bad
		}
		if bad := positive("fencing_token", p.FencingToken); bad != nil {
			return *bad
		}
		subID, err := s.Engine.SubmitForReview(p.TaskID, p.FencingToken, p.BaseCommit, p.HeadCommit, p.Summary)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]interface{}{"submission_id": subID}

	case "record_review", "record_qa":
		var p struct {
			TaskID       string `json:"task_id"`
			SubmissionID int64  `json:"submission_id"`
			Result       string `json:"result"`
			Provider     string `json:"provider"`
			Findings     string `json:"findings"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID, "result", p.Result, "provider", p.Provider, "findings", p.Findings); bad != nil {
			return *bad
		}
		if bad := positive("submission_id", p.SubmissionID); bad != nil {
			return *bad
		}
		switch contracts.ReviewResult(p.Result) {
		case contracts.ResultPass, contracts.ResultFail, contracts.ResultEvidenceInsufficient, contracts.ResultClarificationNeeded:
		default:
			return invalid(fmt.Errorf("invalid result %q", p.Result))
		}
		kind := "completion"
		if req.Method == "record_qa" {
			kind = "qa"
		}
		err := s.Engine.RecordReview(p.TaskID, p.SubmissionID, kind,
			contracts.ReviewResult(p.Result), p.Provider, p.Findings)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]string{"status": "recorded"}

	case "release_task":
		var p struct {
			TaskID       string `json:"task_id"`
			FencingToken int64  `json:"fencing_token"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		if bad := positive("fencing_token", p.FencingToken); bad != nil {
			return *bad
		}
		if err := s.Engine.ReleaseTask(p.TaskID, p.FencingToken); err != nil {
			return fail(err)
		}
		resp.Result = map[string]string{"status": "released"}

	case "add_comment":
		var p struct {
			TaskID string `json:"task_id"`
			Type   string `json:"type"`
			Body   string `json:"body"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID, "type", p.Type, "body", p.Body); bad != nil {
			return *bad
		}
		// Agent-authored comments are always attributed to the agent actor;
		// a model cannot post as a human.
		if err := s.Engine.AddComment(p.TaskID, string(contracts.ActorAgent), p.Type, p.Body); err != nil {
			return fail(err)
		}
		resp.Result = map[string]string{"status": "added"}

	case "request_approval_presentation":
		// Returns the human-facing instruction WITHOUT the decision power.
		// The nonce is deliberately NOT returned to the model: it is
		// delivered to the human through the tracker comment.
		var p struct {
			TaskID string `json:"task_id"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("task_id", p.TaskID); bad != nil {
			return *bad
		}
		if _, _, err := s.Engine.PendingApproval(p.TaskID); err != nil {
			return fail(err)
		}
		resp.Result = map[string]string{
			"status": "pending_human_approval",
			"instruction": "Ask the user to open the task in the tracker and reply with the " +
				"approve/reject directive posted there. Agentklar accepts the decision only " +
				"from their own tracker account; you cannot approve on their behalf.",
		}

	case "get_context":
		var p struct {
			TaskID string `json:"task_id"`
			Query  string `json:"query"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if s.Context == nil {
			return unavailable("get_context")
		}
		query := p.Query
		if query == "" && p.TaskID != "" {
			query = p.TaskID
		}
		packet, err := s.Context.Packet(query, 25)
		if err != nil {
			return fail(err)
		}
		resp.Result = packet

	case "remember":
		var p struct {
			Namespace string `json:"namespace"`
			Key       string `json:"key"`
			Value     string `json:"value"`
			TaskID    string `json:"task_id"`
			Holder    string `json:"holder"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("key", p.Key, "value", p.Value); bad != nil {
			return *bad
		}
		if s.Memory == nil {
			return unavailable("remember")
		}
		if p.Holder == "" {
			p.Holder = "agent"
		}
		id, err := s.Memory.Remember(p.Namespace, p.Key, p.Value, p.TaskID, p.Holder)
		if err != nil {
			return fail(err)
		}
		result := map[string]interface{}{"id": id, "status": "remembered", "context_indexed": false}
		if s.Context != nil {
			_, err := s.Context.Index([]akctx.Doc{{
				Source: akctx.SourceMemory,
				Ref:    akctx.MemoryRef(id),
				Title:  p.Namespace + "/" + p.Key,
				Body:   p.Value,
				TaskID: p.TaskID,
			}})
			if err != nil {
				result["warning"] = fmt.Sprintf("memory saved, but context indexing failed: %v", err)
				resp.Result = result
				return resp
			}
			result["context_indexed"] = true
		}
		resp.Result = result

	case "recall":
		var p struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("query", p.Query); bad != nil {
			return *bad
		}
		if s.Memory == nil {
			return unavailable("recall")
		}
		entries, err := s.Memory.Recall(p.Query, p.Limit)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]interface{}{"results": entries}

	case "notify_human":
		var p struct {
			TaskID   string `json:"task_id"`
			Holder   string `json:"holder"`
			Severity string `json:"severity"`
			Message  string `json:"message"`
			Speak    *bool  `json:"speak"`
		}
		if bad := decode(&p); bad != nil {
			return *bad
		}
		if bad := require("severity", p.Severity, "message", p.Message); bad != nil {
			return *bad
		}
		if s.Notify == nil {
			return unavailable("notify_human")
		}
		sev := notify.Severity(strings.ToLower(p.Severity))
		switch sev {
		case notify.Info, notify.Warn, notify.Error, notify.Block:
		default:
			return invalid(fmt.Errorf("invalid severity %q", p.Severity))
		}
		if p.Holder == "" {
			p.Holder = "agent"
		}
		speak := defaultSpeak(sev)
		if p.Speak != nil {
			speak = *p.Speak
		}
		id, err := s.Notify.Record(p.TaskID, p.Holder, sev, p.Message, speak)
		if err != nil {
			return fail(err)
		}
		resp.Result = map[string]interface{}{"id": id, "logged": true, "speak": speak}

	default:
		resp.Error = &RPCError{-32601, fmt.Sprintf("unknown method %q", req.Method)}
	}
	return resp
}

func defaultSpeak(sev notify.Severity) bool { return sev != notify.Info }

// unavailable returns a standard error response for an optional store that the
// server was not configured with.
func unavailable(name string) Response {
	return Response{JSONRPC: "2.0", Error: &RPCError{-32601,
		fmt.Sprintf("%s unavailable: the %s store is not enabled in this workspace", name, name)}}
}
