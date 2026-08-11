package ui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/notify"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// seedApproval drives one task through the full machine to user_approval and
// creates a second task that stays in Draft, so the non-pending approve path
// can be exercised without disturbing the pending one. It returns the task IDs.
func seedApproval(t *testing.T, dir string) (pending, other string) {
	t.Helper()
	db, err := store.Open(filepath.Join(dir, "control.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	e := workflow.New(db)

	pending = "T-1"
	if err := e.CreateTask(workflow.Task{
		ID:           pending,
		Project:      "agentklar",
		Title:        "Build the native UI",
		Criteria:     []string{"board renders", "approval works"},
		Verification: "go test ./internal/ui/...",
		Lane:         contracts.LaneStandard,
	}); err != nil {
		t.Fatalf("create pending: %v", err)
	}
	if err := e.MarkReady(pending, contracts.ActorHuman); err != nil {
		t.Fatalf("ready: %v", err)
	}
	claim, err := e.ClaimTask(pending, "agent-a", contracts.StateReady)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	sub, err := e.SubmitForReview(pending, claim.FencingToken, "base", "head1", "implemented")
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := e.RecordReview(pending, sub, "completion", contracts.ResultPass, "det", "[]"); err != nil {
		t.Fatalf("completion review: %v", err)
	}
	if err := e.RecordReview(pending, sub, "qa", contracts.ResultPass, "det", "[]"); err != nil {
		t.Fatalf("qa review: %v", err)
	}
	got, _ := e.GetTask(pending)
	if got.State != contracts.StateUserApproval {
		t.Fatalf("seed: expected user_approval, got %s", got.State)
	}

	other = "T-2"
	if err := e.CreateTask(workflow.Task{
		ID: pending + "-sibling", Project: "agentklar", Title: "Sibling draft task",
	}); err != nil {
		t.Fatalf("create other: %v", err)
	}
	// rename to match returned id
	other = pending + "-sibling"
	return pending, other
}

func do(t *testing.T, h http.Handler, method, target string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, body)
	h.ServeHTTP(rec, req)
	return rec
}

func approveDo(t *testing.T, s *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader("csrf_token="+s.csrfToken))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// GET / renders the board and lists the seeded task.
func TestBoardHTMLListsTask(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, err := New(dir, dir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	rec := do(t, s.Handler(), "GET", "/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Build the native UI") {
		t.Fatalf("GET / body does not contain task title; body:\n%s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "User Approval") {
		t.Fatalf("GET / body does not contain the User Approval column label")
	}
}

// GET /api/tasks returns JSON containing the seeded task id.
func TestAPITasksJSON(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	rec := do(t, s.Handler(), "GET", "/api/tasks", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "T-1") {
		t.Fatalf("api/tasks missing T-1; body:\n%s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "user_approval") {
		t.Fatalf("api/tasks missing user_approval state; body:\n%s", rec.Body.String())
	}
}

// GET /approvals shows the pending task; GET /api/approvals returns the nonce.
func TestApprovalsListPendingBeforeDecision(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	rec := do(t, s.Handler(), "GET", "/approvals", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /approvals status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Build the native UI") {
		t.Fatalf("approvals page missing pending task title")
	}

	api := do(t, s.Handler(), "GET", "/api/approvals", nil)
	if api.Code != http.StatusOK {
		t.Fatalf("GET /api/approvals status = %d", api.Code)
	}
	var apps []approvalJSON
	if err := json.Unmarshal(api.Body.Bytes(), &apps); err != nil {
		t.Fatalf("unmarshal approvals: %v; body: %s", err, api.Body.String())
	}
	if len(apps) != 1 || apps[0].Task.ID != "T-1" {
		t.Fatalf("want 1 pending approval for T-1, got %+v", apps)
	}
	if strings.Contains(strings.ToLower(api.Body.String()), "nonce") {
		t.Fatal("approval JSON leaked nonce")
	}
}

// POST /approvals/{id} approves the pending task; follow-up API shows done.
func TestApprovePendingHTML(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	rec := approveDo(t, s, "/approvals/T-1")
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("POST /approvals/T-1 status = %d, want 303 (SeeOther)", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Fatalf("redirect location = %q, want %q", loc, "/")
	}

	// The task must now be Done via the JSON API.
	api := do(t, s.Handler(), "GET", "/api/tasks/T-1", nil)
	if api.Code != http.StatusOK {
		t.Fatalf("GET /api/tasks/T-1 status = %d", api.Code)
	}
	var detail struct {
		Task struct {
			State string `json:"State"`
		} `json:"Task"`
	}
	if err := json.Unmarshal(api.Body.Bytes(), &detail); err != nil {
		t.Fatalf("unmarshal task detail: %v; body: %s", err, api.Body.String())
	}
	if detail.Task.State != string(contracts.StateDone) {
		t.Fatalf("state after approve = %q, want %q", detail.Task.State, contracts.StateDone)
	}

	// And via the engine directly (protected state authority).
	tk, _ := s.engine.GetTask("T-1")
	if tk.State != contracts.StateDone {
		t.Fatalf("engine state = %s, want done", tk.State)
	}
}

// Approving a task that is not in user_approval yields 409 and changes nothing.
func TestApproveNonPendingIs409AndIdempotent(t *testing.T) {
	dir := t.TempDir()
	pending, other := seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	// (1) A Draft task: 409, stays draft.
	rec := approveDo(t, s, "/approvals/"+other)
	if rec.Code != http.StatusConflict {
		t.Fatalf("approve draft status = %d, want 409", rec.Code)
	}
	tk, _ := s.engine.GetTask(other)
	if tk.State != contracts.StateDraft {
		t.Fatalf("draft task state changed to %s", tk.State)
	}

	// (2) There is no generic JSON approval endpoint.
	rec = do(t, s.Handler(), "POST", "/api/approvals/"+other, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("api approve status = %d, want 404", rec.Code)
	}

	// (3) Approve the pending one, then approve AGAIN: second attempt 409,
	//     state stays Done (nonce single-use boundary holds).
	if rec := approveDo(t, s, "/approvals/"+pending); rec.Code != http.StatusSeeOther {
		t.Fatalf("first approve status = %d, want 303", rec.Code)
	}
	again := approveDo(t, s, "/approvals/"+pending)
	if again.Code != http.StatusConflict {
		t.Fatalf("second approve status = %d, want 409", again.Code)
	}
	tk, _ = s.engine.GetTask(pending)
	if tk.State != contracts.StateDone {
		t.Fatalf("state after double-approve = %s, want done", tk.State)
	}
}

// GET /tasks/{id} renders task detail with metadata + criteria.
func TestTaskDetailHTML(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	rec := do(t, s.Handler(), "GET", "/tasks/T-1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"Build the native UI", "board renders", "go test ./internal/ui/...", "User Approval"} {
		if !strings.Contains(body, want) {
			t.Errorf("task detail missing %q", want)
		}
	}
}

// GET /tasks/{unknown} is 404.
func TestTaskDetailNotFound(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	rec := do(t, s.Handler(), "GET", "/tasks/does-not-exist", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// A nil memory store degrades gracefully: GET /memory returns 200, not a panic.
func TestMemoryDegradedStore(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	s.memory = nil // simulate an optional store that failed to open
	rec := do(t, s.Handler(), "GET", "/memory", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /memory status = %d, want 200 (degraded)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "not available") {
		t.Fatalf("degraded memory page missing notice; body:\n%s", rec.Body.String())
	}

	// JSON API likewise must not panic.
	api := do(t, s.Handler(), "GET", "/api/memory?q=anything", nil)
	if api.Code != http.StatusOK {
		t.Fatalf("GET /api/memory status = %d, want 200", api.Code)
	}
}

// Knowledge and context views render 200 with the optional stores present.
func TestKnowledgeAndContextPagesRender(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	for _, tt := range []struct {
		path string
	}{
		{"/knowledge"}, {"/context"}, {"/context?q=agentklar"},
	} {
		rec := do(t, s.Handler(), "GET", tt.path, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s status = %d, want 200; body: %s", tt.path, rec.Code, rec.Body.String())
		}
	}
}

// Static CSS is served and templates are NOT exposed under /static/.
func TestStaticCSSServedTemplatesNotExposed(t *testing.T) {
	dir := t.TempDir()
	seedApproval(t, dir)
	s, _ := New(dir, dir)
	t.Cleanup(func() { s.Close() })

	css := do(t, s.Handler(), "GET", "/static/app.css", nil)
	if css.Code != http.StatusOK {
		t.Fatalf("GET /static/app.css status = %d, want 200", css.Code)
	}
	if ct := css.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/css") {
		t.Fatalf("css content-type = %q, want text/css*", ct)
	}
	if !strings.Contains(css.Body.String(), "--bg") {
		t.Fatalf("app.css body unexpected; got:\n%s", css.Body.String())
	}

	// A template file must not be reachable via the static file server.
	leak := do(t, s.Handler(), "GET", "/static/layout.html", nil)
	if leak.Code != http.StatusNotFound {
		t.Fatalf("GET /static/layout.html status = %d, want 404 (templates must not leak)", leak.Code)
	}
}

// Alerts: an agent-raised alert is logged and visible; the human acknowledges
// it (agents cannot). Cover the HTML page, the JSON list, and the ack path.
func TestAlertsLogAck(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir, dir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	if s.alerts == nil {
		t.Fatal("alerts store not initialized")
	}
	// Silence real speech/banner delivery during the test.
	s.alerts.SetDeliver(nil)

	id, err := s.alerts.Record("T-1", "agent-a", notify.Block, "network down; cannot reach registry", false)
	if err != nil {
		t.Fatalf("record: %v", err)
	}

	// HTML page lists the alert.
	html := do(t, s.Handler(), "GET", "/alerts", nil)
	if html.Code != http.StatusOK {
		t.Fatalf("GET /alerts status = %d", html.Code)
	}
	if !strings.Contains(html.Body.String(), "network down") {
		t.Fatalf("GET /alerts body missing alert message:\n%s", html.Body.String())
	}

	// JSON list contains it.
	rec := do(t, s.Handler(), "GET", "/api/alerts", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/alerts status = %d", rec.Code)
	}
	var got []notify.Alert
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal alerts: %v", err)
	}
	if len(got) != 1 || got[0].Message != "network down; cannot reach registry" {
		t.Fatalf("alerts = %#v", got)
	}
	if got[0].Acknowledged {
		t.Fatal("alert should start unacknowledged")
	}

	// Human acknowledges via the API; agents have no such method.
	ack := do(t, s.Handler(), "POST", "/api/alerts/"+strconvI(id)+"/ack", nil)
	if ack.Code != http.StatusOK {
		t.Fatalf("POST ack status = %d, want 200", ack.Code)
	}
	rec2 := do(t, s.Handler(), "GET", "/api/alerts", nil)
	var after []notify.Alert
	json.Unmarshal(rec2.Body.Bytes(), &after)
	if !after[0].Acknowledged {
		t.Fatal("alert should be acknowledged after ack")
	}
}

// strconvI keeps the test free of an extra import line for a single use.
func strconvI(i int64) string { return strconv.FormatInt(i, 10) }
