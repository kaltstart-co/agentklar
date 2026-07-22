// Package mcp exposes the agent-facing MCP surface over stdio.
//
// CRITICAL CONTRACT: this surface exposes no approve, reject, or done
// operation. A model may ask Agentklar to PRESENT a pending approval, but
// it cannot supply the decision. The human-only Done boundary is enforced
// here by omission and asserted by tests against contracts.MCPMethods.
package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/kaltstart-co/agentklar/internal/contracts"
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
	Engine    *workflow.Engine
	Workspace string
	Policy    tracker.ApprovalPolicy
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

	switch req.Method {
	case "initialize":
		resp.Result = map[string]interface{}{
			"protocolVersion": "2025-06-18",
			"serverInfo":      map[string]string{"name": "agentklar", "version": "0.1.0-dev"},
			"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
		}

	case "tools/list", "list_methods":
		resp.Result = map[string]interface{}{"methods": contracts.MCPMethods}

	case "bind_workspace":
		resp.Result = map[string]string{"workspace": s.Workspace}

	case "list_ready_tasks":
		var p struct {
			ExecutionTarget string `json:"execution_target"`
		}
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
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
		json.Unmarshal(req.Params, &p)
		if _, _, err := s.Engine.PendingApproval(p.TaskID); err != nil {
			return fail(err)
		}
		resp.Result = map[string]string{
			"status": "pending_human_approval",
			"instruction": "Ask the user to open the task in the tracker and reply with the " +
				"approve/reject directive posted there. Agentklar accepts the decision only " +
				"from their own tracker account; you cannot approve on their behalf.",
		}

	default:
		resp.Error = &RPCError{-32601, fmt.Sprintf("unknown method %q", req.Method)}
	}
	return resp
}
