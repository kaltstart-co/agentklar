package runs

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// This subprocess speaks the native protocol; it never contacts a model provider.
func TestNativeFixture(t *testing.T) {
	if os.Getenv("AGENTKLAR_NATIVE_FIXTURE") != "1" {
		return
	}
	enc := json.NewEncoder(os.Stdout)
	reply := func(id json.RawMessage, result any) { _ = enc.Encode(map[string]any{"id": id, "result": result}) }
	event := func(method string, params any) { _ = enc.Encode(map[string]any{"method": method, "params": params}) }
	completed := func(status string) {
		event("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"type": "agentMessage", "text": "fixture evidence", "phase": "final_answer"}})
		event("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": status}})
	}
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var m message
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			os.Exit(2)
		}
		if m.Method == "" && string(m.ID) == "99" && os.Getenv("AGENTKLAR_FIXTURE_MODE") == "permission-twice" {
			_ = enc.Encode(map[string]any{"id": 100, "method": "item/fileChange/requestApproval", "params": map[string]string{"threadId": "thread-1", "turnId": "turn-1", "itemId": "file-1", "reason": "fixture file change"}})
			continue
		}
		if m.Method == "" && (string(m.ID) == "99" || string(m.ID) == "100") {
			completed("completed")
			os.Exit(0)
		}
		switch m.Method {
		case "initialize":
			reply(m.ID, map[string]string{"userAgent": "fixture"})
		case "model/list":
			reply(m.ID, map[string]any{"data": []map[string]string{{"id": "fixture-sol", "model": "fixture-sol"}}, "nextCursor": nil})
		case "thread/start":
			var p map[string]any
			_ = json.Unmarshal(m.Params, &p)
			if _, exists := p["approvalPolicy"]; exists {
				os.Exit(3)
			}
			reply(m.ID, map[string]any{"thread": map[string]string{"id": "thread-1"}, "model": "fixture-sol"})
		case "turn/start":
			reply(m.ID, map[string]any{"turn": map[string]string{"id": "turn-1", "status": "inProgress"}})
			event("account/updated", map[string]string{"token": "must-not-be-retained"})
			event("turn/completed", map[string]any{"threadId": "child-thread", "turn": map[string]string{"id": "child-turn", "status": "completed"}})
			event("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "other-turn", "status": "completed"}})
			mode := os.Getenv("AGENTKLAR_FIXTURE_MODE")
			if mode == "permission" || mode == "permission-twice" {
				_ = enc.Encode(map[string]any{"id": 99, "method": "item/commandExecution/requestApproval", "params": map[string]string{"threadId": "thread-1", "turnId": "turn-1", "itemId": "cmd-1", "command": "echo fixture", "cwd": "/fixture"}})
			} else if mode == "unsupported" {
				_ = enc.Encode(map[string]any{"id": 99, "method": "account/chatgptAuthTokens/refresh", "params": map[string]string{"token": "must-not-be-retained"}})
			} else if mode != "slow" {
				completed("completed")
				os.Exit(0)
			}
		case "turn/interrupt":
			reply(m.ID, map[string]any{})
			completed("interrupted")
			os.Exit(0)
		}
	}
	os.Exit(0)
}

func TestBufferedNativeRPCReplyWinsOverEOF(t *testing.T) {
	done := make(chan struct{})
	close(done)
	for i := 0; i < 1000; i++ {
		ch := make(chan message, 1)
		ch <- message{Result: json.RawMessage(`{"ok":true}`)}
		m, err := awaitReply(context.Background(), ch, done)
		if err != nil || string(m.Result) != `{"ok":true}` {
			t.Fatalf("lost buffered RPC result: %s %v", m.Result, err)
		}
	}
}

func TestOrphanParentFixture(t *testing.T) {
	if os.Getenv("AGENTKLAR_ORPHAN_PARENT") != "1" {
		return
	}
	_ = os.Setenv("AGENTKLAR_ORPHAN_PARENT", "0")
	_ = os.Setenv("AGENTKLAR_ORPHAN_CHILD", "1")
	cmd := exec.Command(os.Args[0], "-test.run=TestOrphanChildFixture", "--")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		os.Exit(2)
	}
	for i := 0; i < 1000; i++ {
		if _, err := os.Stat(os.Getenv("AGENTKLAR_ORPHAN_PIDFILE")); err == nil {
			os.Exit(0)
		}
		time.Sleep(time.Millisecond)
	}
	os.Exit(3)
}

func TestOrphanChildFixture(t *testing.T) {
	if os.Getenv("AGENTKLAR_ORPHAN_CHILD") != "1" {
		return
	}
	if err := os.WriteFile(os.Getenv("AGENTKLAR_ORPHAN_PIDFILE"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		os.Exit(2)
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestRestartBlocksSurvivingNativeProcessGroup(t *testing.T) {
	s, in, _ := testSupervisor(t)
	t.Setenv("AGENTKLAR_ORPHAN_PARENT", "1")
	t.Setenv("AGENTKLAR_ORPHAN_PIDFILE", filepath.Join(t.TempDir(), "child.pid"))
	cmd := exec.Command(os.Args[0], "-test.run=TestOrphanParentFixture", "--")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatal("fixture native leader still exists")
	}
	if err := syscall.Kill(-pid, 0); err != nil {
		t.Fatal("fixture child group missing:", err)
	}
	if _, _, err := s.Store.Insert(in, s.Repo); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`UPDATE native_runs SET status='interrupted',process_pid=? WHERE id=?`, pid, in.ID); err != nil {
		t.Fatal(err)
	}
	next := in
	next.ID = "new-run"
	if _, err := s.start(next); err == nil {
		t.Fatal("surviving native child allowed another edit")
	}
}

func testSupervisor(t *testing.T) (*Supervisor, Start, string) {
	t.Helper()
	t.Setenv("AGENTKLAR_NATIVE_FIXTURE", "1")
	repo := t.TempDir()
	db, err := store.Open(filepath.Join(repo, "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	eng := workflow.New(db)
	if err = eng.CreateTask(workflow.Task{ID: "TASK-1", RepoPath: repo, Project: "fixture", Title: "Fixture", Lane: contracts.LaneQuick, Criteria: []string{"fixture passes"}, Verification: "fixture", Target: contracts.TargetCodex}); err != nil {
		t.Fatal(err)
	}
	if err = eng.MarkReady("TASK-1", contracts.ActorAgent); err != nil {
		t.Fatal(err)
	}
	claim, err := eng.ClaimTask("TASK-1", "host", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	st, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SaveHarness(Harness{Name: "codex", Executable: exe, Args: []string{"-test.run=TestNativeFixture", "--"}, Version: "fixture", Capabilities: []string{"fixture"}, CheckedAt: now()}); err != nil {
		t.Fatal(err)
	}
	s := NewSupervisor(st, eng, repo)
	t.Cleanup(func() {
		s.mu.Lock()
		s.closing = true
		for _, w := range s.workers {
			w.cancel()
		}
		s.mu.Unlock()
		s.wg.Wait()
	})
	return s, Start{ID: "run-1", TaskID: "TASK-1", Holder: "host", FencingToken: claim.FencingToken, Harness: "codex", Model: "fixture-sol", Purpose: "implement", Prompt: "small fixture work"}, repo
}

func waitStatus(t *testing.T, s *Supervisor, id, status string) Run {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		r, err := s.Store.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if r.Status == status {
			return r
		}
		if r.Status == "failed" && status != "failed" {
			t.Fatalf("run failed: %s", r.Error)
		}
		time.Sleep(10 * time.Millisecond)
	}
	r, _ := s.Store.Get(id)
	t.Fatalf("waiting for %s, got %+v", status, r)
	return Run{}
}

func TestNativeRunFinalEventRetryAndTaskBoundary(t *testing.T) {
	s, in, _ := testSupervisor(t)
	if _, err := s.start(in); err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, s, in.ID, "completed")
	if r.Result != "fixture evidence" || r.ThreadID != "thread-1" || r.TurnID != "turn-1" {
		t.Fatalf("lost final native evidence: %+v", r)
	}
	if _, err := s.start(in); err != nil {
		t.Fatal(err)
	}
	conflict := in
	conflict.Prompt = "different work"
	if _, err := s.start(conflict); err == nil {
		t.Fatal("conflicting retry accepted")
	}
	task, err := s.Engine.GetTask(in.TaskID)
	if err != nil || task.State != contracts.StateInProgress {
		t.Fatalf("native completion changed task completion: %+v %v", task, err)
	}
	events, err := s.Store.Events(in.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if strings.Contains(string(e.Payload), "must-not-be-retained") {
			t.Fatal("account credentials retained")
		}
	}
}

func TestNativePermissionHumanActionExactlyOnce(t *testing.T) {
	s, in, _ := testSupervisor(t)
	t.Setenv("AGENTKLAR_FIXTURE_MODE", "permission")
	if _, err := s.start(in); err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, s, in.ID, "attention_required")
	if len(r.PendingRequest) == 0 {
		t.Fatal("missing concrete pending permission")
	}
	other := in
	other.ID = "other-run"
	if _, err := s.start(other); err == nil {
		t.Fatal("pending permission allowed parallel edit")
	}
	if _, err := s.Dispatch(Request{Method: "permission", ID: in.ID}); err == nil {
		t.Fatal("socket exposed permission response")
	}
	if err := s.Permission(in.ID, json.RawMessage(`98`), "accept"); err == nil {
		t.Fatal("stale request accepted")
	}
	if err := s.Permission(in.ID, json.RawMessage(`99`), "acceptForSession"); err == nil {
		t.Fatal("broader native grant accepted")
	}
	if err := s.Permission(in.ID, json.RawMessage(`99`), "accept"); err != nil {
		t.Fatal(err)
	}
	if err := s.Permission(in.ID, json.RawMessage(`99`), "accept"); err == nil {
		t.Fatal("duplicate permission accepted")
	}
	waitStatus(t, s, in.ID, "completed")
}

func TestRapidSequentialNativePermissions(t *testing.T) {
	s, in, _ := testSupervisor(t)
	t.Setenv("AGENTKLAR_FIXTURE_MODE", "permission-twice")
	if _, err := s.start(in); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, s, in.ID, "attention_required")
	if err := s.Permission(in.ID, json.RawMessage(`99`), "accept"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		r, err := s.Store.Get(in.ID)
		if err != nil {
			t.Fatal(err)
		}
		var p struct {
			ID int `json:"request_id"`
		}
		_ = json.Unmarshal(r.PendingRequest, &p)
		if p.ID == 100 && r.Status == "attention_required" {
			if err := s.Permission(in.ID, json.RawMessage(`100`), "accept"); err != nil {
				t.Fatal(err)
			}
			waitStatus(t, s, in.ID, "completed")
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("second native permission lost or overwritten by earlier resolution")
}

func TestCancellationOwnershipAndChildExit(t *testing.T) {
	s, in, _ := testSupervisor(t)
	t.Setenv("AGENTKLAR_FIXTURE_MODE", "slow")
	if _, err := s.start(in); err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, s, in.ID, "running")
	if _, err := s.Dispatch(Request{Method: "cancel", ID: in.ID, Holder: "other", FencingToken: in.FencingToken}); err == nil {
		t.Fatal("different holder cancelled run")
	}
	if _, err := s.Dispatch(Request{Method: "cancel", ID: in.ID, Holder: in.Holder, FencingToken: in.FencingToken}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, s, in.ID, "cancelled")
	if err := syscall.Kill(r.ProcessPID, 0); err == nil {
		t.Fatal("native child still running after terminal cancellation")
	}
}

func TestUnsupportedNativeRequestDoesNotRetainAuth(t *testing.T) {
	s, in, _ := testSupervisor(t)
	t.Setenv("AGENTKLAR_FIXTURE_MODE", "unsupported")
	if _, err := s.start(in); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, s, in.ID, "failed")
	events, err := s.Store.Events(in.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if strings.Contains(string(e.Payload), "must-not-be-retained") {
			t.Fatal("unsupported authentication request payload retained")
		}
	}
}

func TestSupervisorSocketLifetimeAndRestart(t *testing.T) {
	s, in, workspace := testSupervisor(t)
	t.Setenv("AGENTKLAR_FIXTURE_MODE", "slow")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, workspace) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(SocketPath(workspace)); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	info, err := os.Stat(SocketPath(workspace))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("socket permission: %v %v", info, err)
	}
	if _, err = runsCall(workspace, Request{Method: "start", Start: in}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, s, in.ID, "running")
	// Every Call closes its own client socket. The native worker remains supervised.
	if _, err = runsCall(workspace, Request{Method: "get", ID: in.ID}); err != nil {
		t.Fatal(err)
	}
	second := NewSupervisor(s.Store, s.Engine, s.Repo)
	if err = second.Serve(context.Background(), workspace); err == nil {
		t.Fatal("second supervisor unlinked live peer")
	}
	if _, err = runsCall(workspace, Request{Method: "get", ID: in.ID}); err != nil {
		t.Fatal("second supervisor damaged socket:", err)
	}
	cancel()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if _, err = s.start(Start{ID: "after-shutdown"}); err == nil {
		t.Fatal("shutdown accepted a new worker")
	}
	if _, err = s.Store.DB.Exec(`UPDATE native_runs SET status='running',process_pid=0 WHERE id=?`, in.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.InterruptActive(); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, s, in.ID, "interrupted")
}

func runsCall(workspace string, request Request) (json.RawMessage, error) {
	return Call(workspace, request)
}

func TestClaimScopeAndReadOnlyReview(t *testing.T) {
	s, in, _ := testSupervisor(t)
	stale := in
	stale.FencingToken++
	if _, _, err := s.Store.Insert(stale, s.Repo); err == nil {
		t.Fatal("stale claim launched")
	}
	if _, _, err := s.Store.Insert(in, t.TempDir()); err == nil {
		t.Fatal("other project launched")
	}
	review := in
	review.Purpose = "review"
	if _, _, err := s.Store.Insert(review, s.Repo); err == nil {
		t.Fatal("review could edit")
	}
	if _, err := s.Store.DB.Exec(`DELETE FROM repo_leases`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Store.Insert(in, s.Repo); err == nil {
		t.Fatal("edit without real isolation")
	}
	review.ReadOnly = true
	if _, _, err := s.Store.Insert(review, s.Repo); err != nil {
		t.Fatal(err)
	}
}
