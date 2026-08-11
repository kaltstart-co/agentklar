package ui

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func TestControlCenterShellAndBoardContracts(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	overview := apiRequest(t, s.Handler(), http.MethodGet, "/", "")
	for _, want := range []string{"Project switcher", "Overview", alpha.Name, beta.Name, "Read-only session", "agentklar ui --open", "aria-label=\"Primary navigation\"", "/static/app.js"} {
		if !strings.Contains(overview.Body.String(), want) {
			t.Fatalf("overview missing %q: %s", want, overview.Body.String())
		}
	}

	cookie := bootstrapHuman(t, s)
	req := apiRequestWithCookie(t, s, cookie, http.MethodGet, "/projects/"+alpha.ID+"/board")
	for _, want := range []string{"New task", "task-dialog", "Task ID", "Acceptance criteria", "Verification", "Dependencies", "data-filter=\"priority\"", "data-filter=\"assignee\"", "data-filter=\"label\"", "draggable=\"true\"", "Move to", "Archived history"} {
		if !strings.Contains(req.Body.String(), want) {
			t.Fatalf("board missing %q: %s", want, req.Body.String())
		}
	}
}

func TestApprovalsRenderEvidenceFromCorrectProject(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	for _, item := range []struct{ project, note string }{{alpha.WorkspacePath, "alpha approval evidence"}, {beta.WorkspacePath, "beta approval evidence"}} {
		seedApproval(t, item.project)
		db, err := store.Open(filepath.Join(item.project, "control.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		if err := workflow.New(db).AddEvidence("T-1", 0, contracts.MachineAttested, "quality", "go test ./...", "", nil, "", "", "", item.note); err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
	}
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	res := apiRequestWithCookie(t, s, bootstrapHuman(t, s), http.MethodGet, "/approvals")
	for _, want := range []string{"Machine-attested evidence", "alpha approval evidence", "beta approval evidence", "go test ./..."} {
		if !strings.Contains(res.Body.String(), want) {
			t.Fatalf("approvals missing %q: %s", want, res.Body.String())
		}
	}
}

func TestTaskDetailShowsEvidenceFirstControls(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	res := apiRequestWithCookie(t, s, cookie, http.MethodGet, "/projects/"+alpha.ID+"/tasks/SHARED")
	for _, want := range []string{"Objective", "Acceptance criteria", "Verification", "Dependencies", "Evidence", "Reviews", "Timeline", "Edit task", "Archive", "Add comment"} {
		if !strings.Contains(res.Body.String(), want) {
			t.Fatalf("detail missing %q: %s", want, res.Body.String())
		}
	}
}

func TestScopedMemoryForgetRemovesContextProjection(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	m, _ := memory.New(alpha.WorkspacePath)
	id, err := m.Remember("build", "compiler", "forgotten-context-needle", "SHARED", "codex")
	if err != nil {
		t.Fatal(err)
	}
	m.Close()
	ctx, _ := akctx.New(alpha.WorkspacePath)
	if _, err := ctx.Index([]akctx.Doc{{Source: akctx.SourceMemory, Ref: "memory/" + itoa(id), Title: "build/compiler", Body: "forgotten-context-needle"}}); err != nil {
		t.Fatal(err)
	}
	ctx.Close()

	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	path := "/api/projects/" + alpha.ID + "/memory/" + itoa(id)
	deleted := humanRequest(t, s, cookie, http.MethodDelete, path, "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("forget status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	ctxRes := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/context?q=forgotten-context-needle", "")
	if !strings.Contains(ctxRes.Body.String(), `"Items":null`) && !strings.Contains(ctxRes.Body.String(), `"Items":[]`) {
		t.Fatalf("forgotten memory remained in context: %s", ctxRes.Body.String())
	}
	betaRes := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+beta.ID+"/memory", "")
	if betaRes.Code != http.StatusOK || strings.Contains(betaRes.Body.String(), "compiler") {
		t.Fatalf("memory crossed project boundary: %s", betaRes.Body.String())
	}
}

func TestContextReindexUsesSameMemoryIdentityAsRemember(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	m, _ := memory.New(alpha.WorkspacePath)
	id, err := m.Remember("build", "compiler", "old-memory-needle", "SHARED", "codex")
	if err != nil {
		t.Fatal(err)
	}
	m.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	indexed := humanRequest(t, s, cookie, http.MethodPost, "/api/projects/"+alpha.ID+"/context/reindex", "")
	if indexed.Code != http.StatusOK {
		t.Fatalf("reindex status=%d body=%s", indexed.Code, indexed.Body.String())
	}
	m, _ = memory.New(alpha.WorkspacePath)
	if gotID, err := m.Remember("build", "compiler", "new-memory-needle", "SHARED", "codex"); err != nil || gotID != id {
		t.Fatalf("remember update id=%d err=%v", gotID, err)
	}
	m.Close()
	ctx, _ := akctx.New(alpha.WorkspacePath)
	if _, err := ctx.Index([]akctx.Doc{{Source: akctx.SourceMemory, Ref: akctx.MemoryRef(id), Title: "build compiler", Body: "new-memory-needle"}}); err != nil {
		t.Fatal(err)
	}
	old, _ := ctx.Search("old-memory-needle", 10)
	current, _ := ctx.Search("new-memory-needle", 10)
	ctx.Close()
	if len(old) != 0 || len(current) != 1 {
		t.Fatalf("memory projection old=%#v current=%#v", old, current)
	}
}

func apiRequestWithCookie(t *testing.T, s *Server, cookie *http.Cookie, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, testOrigin+path, nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }
