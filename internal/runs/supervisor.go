package runs

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kaltstart-co/agentklar/internal/workflow"
)

type Supervisor struct {
	OpenUI  func() error
	Store   *Store
	Engine  *workflow.Engine
	Repo    string
	mu      sync.Mutex
	workers map[string]*worker
	wg      sync.WaitGroup
	closing bool
}

type worker struct {
	cancel   context.CancelFunc
	client   *codex
	pending  *message
	resolved chan struct{}
}

// SocketPath uses a short, private path to fit the macOS Unix socket limit.
func SocketPath(workspace string) string {
	hash := sha256.Sum256([]byte(workspace))
	return filepath.Join(os.TempDir(), fmt.Sprintf("agentklar-%d", os.Getuid()), fmt.Sprintf("%x.sock", hash[:12]))
}

type Request struct {
	Method       string                `json:"method"`
	Start        Start                 `json:"start,omitempty"`
	Recommend    RecommendationRequest `json:"recommend,omitempty"`
	ID           string                `json:"id,omitempty"`
	Holder       string                `json:"holder,omitempty"`
	FencingToken int64                 `json:"fencing_token,omitempty"`
	After        int64                 `json:"after,omitempty"`
}

type Response struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

var ErrNoSupervisor = errors.New("native supervisor is not running")

func Call(workspace string, req Request) (json.RawMessage, error) {
	conn, err := net.DialTimeout("unix", SocketPath(workspace), time.Second)
	if err != nil {
		return nil, fmt.Errorf("%w; start `agentklar serve` in this repository: %v", ErrNoSupervisor, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(40 * time.Second))
	if err = json.NewEncoder(conn).Encode(req); err != nil {
		return nil, err
	}
	var resp Response
	if err = json.NewDecoder(conn).Decode(&resp); err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, errors.New(resp.Error)
	}
	return resp.Result, nil
}

func NewSupervisor(dbStore *Store, engine *workflow.Engine, repo string) *Supervisor {
	return &Supervisor{Store: dbStore, Engine: engine, Repo: repo, workers: map[string]*worker{}}
}

func (s *Supervisor) Serve(ctx context.Context, workspace string) error {
	path := SocketPath(workspace)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("supervisor socket directory must be private (0700)")
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("a supervisor already owns this workspace")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	// The OS lock proves that an old socket is stale before we remove it.
	if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	defer ln.Close()
	defer os.Remove(path)
	if err = os.Chmod(path, 0600); err != nil {
		return err
	}
	if err = s.Store.InterruptActive(); err != nil {
		return err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	defer func() {
		s.mu.Lock()
		s.closing = true
		for _, worker := range s.workers {
			worker.cancel()
		}
		s.mu.Unlock()
		s.wg.Wait()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(40 * time.Second))
			var req Request
			resp := Response{}
			if err := json.NewDecoder(io.LimitReader(conn, 200000)).Decode(&req); err != nil {
				resp.Error = "invalid supervisor request"
			} else {
				v, err := s.Dispatch(req)
				if err != nil {
					resp.Error = err.Error()
				} else {
					resp.Result, _ = json.Marshal(v)
				}
			}
			_ = json.NewEncoder(conn).Encode(resp)
		}()
	}
}

func (s *Supervisor) codexHarness() (Harness, error) {
	hs, err := s.Store.Harnesses()
	if err != nil {
		return Harness{}, err
	}
	for _, h := range hs {
		if h.Name == "codex" {
			return h, nil
		}
	}
	return Harness{}, errors.New("run harness discovery first; Codex is not registered")
}

func (s *Supervisor) Dispatch(req Request) (any, error) {
	switch req.Method {
	case "open-ui":
		if s.OpenUI == nil {
			return nil, errors.New("supervisor has no local support interface")
		}
		if err := s.OpenUI(); err != nil {
			return nil, err
		}
		return map[string]string{"status": "opened"}, nil
	case "usage":
		return s.Usage(req.ID)
	case "recommend":
		return s.RecommendTask(req.Recommend)
	case "discover":
		hs := Discover()
		for _, h := range hs {
			if err := s.Store.SaveHarness(h); err != nil {
				return nil, err
			}
		}
		return map[string]any{"harnesses": hs}, nil
	case "harnesses":
		hs, err := s.Store.Harnesses()
		return map[string]any{"harnesses": hs}, err
	case "models":
		h, err := s.codexHarness()
		if err != nil {
			return nil, err
		}
		v, err := Catalog(h, s.Repo)
		return map[string]any{"catalog": v, "access": "unknown", "source": "codex:model/list"}, err
	case "list":
		rs, err := s.Store.List()
		return map[string]any{"runs": rs}, err
	case "get":
		r, err := s.Store.Get(req.ID)
		if err != nil {
			return nil, err
		}
		events, err := s.Store.Events(req.ID, req.After)
		return map[string]any{"run": r, "events": events}, err
	case "start":
		return s.start(req.Start)
	case "cancel":
		r, err := s.Store.Get(req.ID)
		if err != nil {
			return nil, err
		}
		if err = s.owns(r, req.Holder, req.FencingToken); err != nil {
			return nil, err
		}
		s.mu.Lock()
		worker := s.workers[req.ID]
		s.mu.Unlock()
		if worker == nil {
			return nil, errors.New("run has no live worker")
		}
		worker.cancel()
		return map[string]string{"status": "cancellation_requested"}, nil
	default:
		return nil, errors.New("unknown supervisor method")
	}
}

// Permission is called only by the in-process authenticated human UI.
// It is deliberately absent from the socket and MCP dispatch surfaces.
func (s *Supervisor) Permission(runID string, requestID json.RawMessage, decision string) error {
	if decision != "accept" && decision != "decline" && decision != "cancel" {
		return errors.New("unsupported native permission decision")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workers[runID]
	if w == nil || w.pending == nil || w.client == nil || string(requestID) != string(w.pending.ID) {
		return errors.New("native permission request is no longer pending")
	}
	r, err := s.Store.Get(runID)
	if err != nil {
		return err
	}
	if err = s.owns(r, r.Holder, r.FencingToken); err != nil {
		return err
	}
	if r.Status != "attention_required" {
		return errors.New("run is no longer awaiting permission")
	}
	if err = w.client.send(map[string]any{"id": w.pending.ID, "result": map[string]string{"decision": decision}}); err != nil {
		return err
	}
	w.pending = nil
	if _, err = s.Store.DB.Exec(`UPDATE native_runs SET pending_request='' WHERE id=?`, runID); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"request_id": requestID, "decision": decision})
	if err = s.Store.Append(runID, "agentklar/permission-resolved", payload); err != nil {
		return err
	}
	select {
	case w.resolved <- struct{}{}:
	default:
	}
	return nil
}

func (s *Supervisor) owns(r Run, holder string, token int64) error {
	if holder != r.Holder || token != r.FencingToken {
		return errors.New("run ownership mismatch")
	}
	var liveHolder, state, path, expiry string
	var liveToken int64
	err := s.Store.DB.QueryRow(`SELECT l.holder,l.fencing_token,l.expires_at,t.state,t.repo_path FROM leases l JOIN tasks t ON t.id=l.task_id WHERE l.task_id=?`, r.TaskID).Scan(&liveHolder, &liveToken, &expiry, &state, &path)
	expires, parseErr := time.Parse(time.RFC3339Nano, expiry)
	if err != nil || parseErr != nil || !time.Now().Before(expires) || liveHolder != holder || liveToken != token || state != "in_progress" || path != s.Repo {
		return errors.New("task ownership is no longer current")
	}
	return nil
}

func (s *Supervisor) start(in Start) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return Run{}, errors.New("supervisor is shutting down")
	}
	h, err := s.codexHarness()
	if err != nil {
		return Run{}, err
	}
	// An interrupted native process may outlive a killed supervisor. Never start another edit until it exits.
	old, err := s.Store.DB.Query(`SELECT process_pid FROM native_runs WHERE status='interrupted' AND process_pid>0`)
	if err != nil {
		return Run{}, err
	}
	for old.Next() {
		var pid int
		if err = old.Scan(&pid); err != nil {
			old.Close()
			return Run{}, err
		}
		// Probe the whole process group, including children after the native leader exits.
		if err = syscall.Kill(-pid, 0); !errors.Is(err, syscall.ESRCH) {
			old.Close()
			return Run{}, errors.New("interrupted native process group still exists or cannot be checked; inspect it in the native tool before starting work")
		}
	}
	err = old.Err()
	old.Close()
	if err != nil {
		return Run{}, err
	}
	r, inserted, err := s.Store.Insert(in, s.Repo)
	if err != nil || !inserted {
		return r, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	w := &worker{cancel: cancel, resolved: make(chan struct{}, 1)}
	s.workers[r.ID] = w
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		defer func() { s.mu.Lock(); delete(s.workers, r.ID); s.mu.Unlock() }()
		s.execute(ctx, h, r, w)
	}()
	return r, nil
}

func (s *Supervisor) execute(ctx context.Context, h Harness, r Run, w *worker) {
	var c *codex
	finish := func(status, problem string) {
		if c != nil {
			c.close()
		}
		r.Status = status
		r.Error = problem
		_ = s.Store.Update(r.ID, r.Status, r.ThreadID, r.TurnID, r.Result, r.Error)
		_, _ = s.Store.DB.Exec(`UPDATE native_runs SET pending_request='' WHERE id=?`, r.ID)
	}
	var err error
	c, err = openCodex(h, s.Repo)
	if err != nil {
		finish("failed", err.Error())
		return
	}
	defer c.close()
	s.mu.Lock()
	w.client = c
	s.mu.Unlock()
	if _, err = s.Store.DB.Exec(`UPDATE native_runs SET process_pid=? WHERE id=?`, c.cmd.Process.Pid, r.ID); err != nil {
		finish("failed", "cannot retain native process identity")
		return
	}
	type setupResult struct {
		thread, turn string
		err          error
		settings     json.RawMessage
	}
	setup := make(chan setupResult, 2)
	go func() {
		params := map[string]any{"cwd": s.Repo}
		if r.Model != "" {
			params["model"] = r.Model
		}
		if r.ReadOnly {
			params["sandbox"] = "read-only"
		}
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		b, err := c.call(callCtx, "thread/start", params)
		if err != nil {
			setup <- setupResult{err: err}
			return
		}
		var v struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
			Model          string          `json:"model"`
			ModelProvider  string          `json:"modelProvider"`
			ApprovalPolicy json.RawMessage `json:"approvalPolicy"`
			Sandbox        json.RawMessage `json:"sandbox"`
		}
		if err = json.Unmarshal(b, &v); err != nil || v.Thread.ID == "" {
			setup <- setupResult{err: errors.New("native thread/start omitted thread id")}
			return
		}
		settings, _ := json.Marshal(map[string]any{"model": v.Model, "model_provider": v.ModelProvider, "approval_policy": v.ApprovalPolicy, "sandbox": v.Sandbox})
		setup <- setupResult{thread: v.Thread.ID, settings: settings}
		task, err := s.Engine.GetTask(r.TaskID)
		if err != nil {
			setup <- setupResult{err: err}
			return
		}
		prompt := fmt.Sprintf("AgentKlar registered %s task %s. Work only in the provided repository. Keep native permissions. Return an honest summary and verification evidence; task completion remains human-approved.\nObjective: %s\nAcceptance: %s\nVerification: %s\nInstructions:\n%s", r.Purpose, r.TaskID, task.Objective, strings.Join(task.Criteria, "; "), task.Verification, r.Prompt)
		if r.ReadOnly {
			prompt = "Read-only review: do not edit files.\n" + prompt
		}
		b, err = c.call(callCtx, "turn/start", map[string]any{"threadId": v.Thread.ID, "input": []map[string]any{{"type": "text", "text": prompt}}})
		if err != nil {
			setup <- setupResult{err: err}
			return
		}
		var turn struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if err = json.Unmarshal(b, &turn); err != nil || turn.Turn.ID == "" {
			setup <- setupResult{err: errors.New("native turn/start omitted turn id")}
			return
		}
		setup <- setupResult{thread: v.Thread.ID, turn: turn.Turn.ID}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastHeartbeat := time.Now()
	for {
		// Root identities come from RPC responses, never from child-thread notifications.
		var nativeEvents <-chan message
		if r.ThreadID != "" && r.TurnID != "" {
			nativeEvents = c.events
		}
		select {
		case v := <-setup:
			if v.err != nil {
				finish("failed", v.err.Error())
				return
			}
			if v.thread != "" {
				r.ThreadID = v.thread
			}
			if len(v.settings) > 0 {
				if err = s.Store.Append(r.ID, "agentklar/native-settings", v.settings); err != nil {
					finish("failed", "cannot persist native settings")
					return
				}
			}
			if v.turn != "" {
				r.TurnID = v.turn
				if r.Status != "attention_required" {
					r.Status = "running"
				}
			}
			if err = s.Store.Update(r.ID, r.Status, r.ThreadID, r.TurnID, r.Result, ""); err != nil {
				finish("failed", "cannot persist native run state")
				return
			}
		case <-w.resolved:
			s.mu.Lock()
			pending := w.pending != nil
			s.mu.Unlock()
			if pending {
				r.Status = "attention_required"
			} else {
				r.Status = "running"
			}
			if err = s.Store.Update(r.ID, r.Status, r.ThreadID, r.TurnID, r.Result, ""); err != nil {
				finish("failed", "cannot persist permission response")
				return
			}
		case m, open := <-nativeEvents:
			if !open {
				finish("failed", "native app-server disconnected before turn completion: "+c.diagnostic.summary())
				return
			}
			if m.Method == "" {
				continue
			}
			if len(m.ID) > 0 {
				if m.Method != "item/commandExecution/requestApproval" && m.Method != "item/fileChange/requestApproval" {
					_ = s.Store.Append(r.ID, "agentklar/unsupported-native-request", json.RawMessage(fmt.Sprintf(`{"method":%q}`, m.Method)))
					finish("failed", "Unsupported native request "+m.Method+"; continue in the native tool. Worker stopped.")
					return
				}
				var scope struct {
					ThreadID string `json:"threadId"`
					TurnID   string `json:"turnId"`
					ItemID   string `json:"itemId"`
				}
				if json.Unmarshal(m.Params, &scope) != nil || scope.ThreadID == "" || scope.TurnID == "" || (r.ThreadID != "" && r.ThreadID != scope.ThreadID) || (r.TurnID != "" && r.TurnID != scope.TurnID) {
					finish("failed", "native permission request scope mismatch")
					return
				}
				r.ThreadID = scope.ThreadID
				r.TurnID = scope.TurnID
				var itemPayload string
				var contextItem json.RawMessage
				if err = s.Store.DB.QueryRow(`SELECT payload FROM native_run_events WHERE run_id=? AND method IN ('item/started','item/completed') AND json_extract(payload,'$.item.id')=? ORDER BY seq DESC LIMIT 1`, r.ID, scope.ItemID).Scan(&itemPayload); err == nil {
					var prior struct {
						Item json.RawMessage `json:"item"`
					}
					if json.Unmarshal([]byte(itemPayload), &prior) == nil {
						contextItem = prior.Item
					}
				}
				payload, _ := json.Marshal(map[string]any{"request_id": m.ID, "method": m.Method, "params": m.Params, "context": contextItem})
				if err = s.Store.Append(r.ID, m.Method, payload); err != nil {
					finish("failed", "cannot retain native permission request")
					return
				}
				if _, err = s.Store.DB.Exec(`UPDATE native_runs SET pending_request=? WHERE id=?`, string(payload), r.ID); err != nil {
					finish("failed", "cannot retain pending permission")
					return
				}
				s.mu.Lock()
				if w.pending != nil {
					s.mu.Unlock()
					finish("failed", "overlapping native permission requests unsupported")
					return
				}
				copy := m
				w.pending = &copy
				s.mu.Unlock()
				r.Status = "attention_required"
				if err = s.Store.Update(r.ID, r.Status, r.ThreadID, r.TurnID, r.Result, "Native permission required in agentklar serve --open"); err != nil {
					finish("failed", "cannot persist permission state")
					return
				}
				continue
			}
			// Account/auth events can contain credentials; retain only work events.
			if !strings.HasPrefix(m.Method, "thread/") && !strings.HasPrefix(m.Method, "turn/") && !strings.HasPrefix(m.Method, "item/") {
				continue
			}
			if err = s.Store.Append(r.ID, m.Method, m.Params); err != nil {
				finish("failed", "cannot persist native work event")
				return
			}
			var p struct {
				ThreadID string `json:"threadId"`
				TurnID   string `json:"turnId"`
				Delta    string `json:"delta"`
				Item     struct {
					Type  string `json:"type"`
					Text  string `json:"text"`
					Phase string `json:"phase"`
				} `json:"item"`
				Turn struct {
					ID     string          `json:"id"`
					Status string          `json:"status"`
					Error  json.RawMessage `json:"error"`
				} `json:"turn"`
			}
			if json.Unmarshal(m.Params, &p) != nil {
				finish("failed", "invalid native event payload")
				return
			}
			eventTurn := p.TurnID
			if eventTurn == "" {
				eventTurn = p.Turn.ID
			}
			if (p.ThreadID != "" && p.ThreadID != r.ThreadID) || (eventTurn != "" && eventTurn != r.TurnID) {
				continue
			}
			if m.Method == "item/agentMessage/delta" {
				if len(r.Result)+len(p.Delta) <= 1000000 {
					r.Result += p.Delta
				}
			}
			if m.Method == "item/completed" && p.Item.Type == "agentMessage" && (p.Item.Phase == "final_answer" || p.Item.Phase == "") {
				r.Result = p.Item.Text
			}
			if m.Method == "turn/completed" {
				if p.ThreadID != r.ThreadID || p.Turn.ID != r.TurnID {
					continue
				}
				switch p.Turn.Status {
				case "completed":
					finish("completed", "")
				case "interrupted":
					finish("cancelled", "native turn interrupted")
				default:
					var nativeError struct {
						Message string `json:"message"`
					}
					_ = json.Unmarshal(p.Turn.Error, &nativeError)
					detail := &diagnostic{}
					_, _ = detail.Write([]byte("error: " + nativeError.Message))
					finish("failed", "native turn status: "+p.Turn.Status+"; "+detail.summary())
				}
				return
			}
			if err = s.Store.Update(r.ID, r.Status, r.ThreadID, r.TurnID, r.Result, ""); err != nil {
				finish("failed", "cannot persist native output")
				return
			}
		case <-ticker.C:
			if err = s.owns(r, r.Holder, r.FencingToken); err != nil {
				finish("interrupted", err.Error())
				return
			}
			if time.Since(lastHeartbeat) >= time.Minute {
				if err = s.Engine.Heartbeat(r.TaskID, r.FencingToken); err != nil {
					finish("interrupted", err.Error())
					return
				}
				lastHeartbeat = time.Now()
			}
		case <-ctx.Done():
			if r.ThreadID != "" && r.TurnID != "" {
				interruptCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_, _ = c.call(interruptCtx, "turn/interrupt", map[string]string{"threadId": r.ThreadID, "turnId": r.TurnID})
				cancel()
			}
			finish("cancelled", "worker cancellation or time limit; native interrupt requested and owned process group stopped; detached descendants are not verified")
			return
		}
	}
}
