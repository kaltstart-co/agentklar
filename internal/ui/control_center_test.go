package ui

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/knowledge"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/notify"
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

func TestTaskFormUsesScopedDetailResponseID(t *testing.T) {
	js, err := assetsFS.ReadFile("assets/static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(js), "task.task?.ID") {
		t.Fatal("task form does not read the scoped detail response id")
	}
}

func TestArchivedBoardHasNoMutationOrDragTargets(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	page := apiRequestWithCookie(t, s, bootstrapHuman(t, s), http.MethodGet, "/projects/"+alpha.ID+"/board?archived=true")
	for _, forbidden := range []string{"id=\"task-dialog\"", "data-dropzone", "draggable=\"true\"", ">New task<"} {
		if strings.Contains(page.Body.String(), forbidden) {
			t.Fatalf("archived board retained %q: %s", forbidden, page.Body.String())
		}
	}
	if !strings.Contains(page.Body.String(), "Active board") {
		t.Fatalf("archived board missing active-board return: %s", page.Body.String())
	}
}

func TestClientContractsKeepDragMutationsSingleAndNavigationAccessible(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	js := apiRequest(t, s.Handler(), http.MethodGet, "/static/app.js", "").Body.String()
	for _, want := range []string{"rail.inert", `case "ArrowRight"`, `case "ArrowLeft"`, `case "Home"`, `case "End"`, "transitionTask", "reorderTask", "scheduleReload"} {
		if !strings.Contains(js, want) {
			t.Fatalf("app.js missing %q: %s", want, js)
		}
	}
	if strings.Contains(js, "if (dragged.dataset.state !== state) await api") {
		t.Fatalf("drag handler retained transition-plus-reorder path: %s", js)
	}
}

func TestOverviewSeparatesAttentionQueueFromRecentProjects(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	if _, err := db.Exec(`UPDATE tasks SET state = ? WHERE id = ?`, contracts.StateBlocked, "SHARED"); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	page := apiRequest(t, s.Handler(), http.MethodGet, "/", "")
	for _, want := range []string{"Needs attention", "Recent projects", "Ordered by last opened", alpha.Name, beta.Name} {
		if !strings.Contains(page.Body.String(), want) {
			t.Fatalf("overview missing %q: %s", want, page.Body.String())
		}
	}
}

func TestMemoryNamespaceFilterScopesHTMLAndAPI(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	ms, _ := memory.New(alpha.WorkspacePath)
	if _, err := ms.Remember("build", "compiler", "build-only-needle", "SHARED", "codex"); err != nil {
		t.Fatal(err)
	}
	if _, err := ms.Remember("release", "channel", "release-only-needle", "SHARED", "codex"); err != nil {
		t.Fatal(err)
	}
	_ = ms.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	path := "/api/projects/" + alpha.ID + "/memory?namespace=build"
	api := apiRequest(t, s.Handler(), http.MethodGet, path, "")
	if api.Code != http.StatusOK || !strings.Contains(api.Body.String(), "build-only-needle") || strings.Contains(api.Body.String(), "release-only-needle") {
		t.Fatalf("namespace API was not scoped: status=%d body=%s", api.Code, api.Body.String())
	}
	page := apiRequest(t, s.Handler(), http.MethodGet, "/projects/"+alpha.ID+"/memory?namespace=build", "")
	for _, want := range []string{`name="namespace"`, `<option value="build" selected>`, "build-only-needle"} {
		if !strings.Contains(page.Body.String(), want) {
			t.Fatalf("memory HTML missing %q: %s", want, page.Body.String())
		}
	}
	if strings.Contains(page.Body.String(), "release-only-needle") {
		t.Fatalf("memory HTML crossed namespace: %s", page.Body.String())
	}
}

func TestSelectedProjectAlertsAreExplicitScopedAndPropagateErrors(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	alerts, err := notify.New(alpha.WorkspacePath)
	if err != nil {
		t.Fatal(err)
	}
	alerts.SetDeliver(nil)
	id, err := alerts.Record("SHARED", "codex", notify.Info, "scoped alert", false)
	if err != nil {
		t.Fatal(err)
	}
	_ = alerts.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	page := apiRequestWithCookie(t, s, cookie, http.MethodGet, "/projects/"+alpha.ID+"/alerts")
	for _, want := range []string{"Selected project", "pending and acknowledged", "scoped alert"} {
		if !strings.Contains(page.Body.String(), want) {
			t.Fatalf("alerts page missing %q: %s", want, page.Body.String())
		}
	}
	ack := humanRequest(t, s, cookie, http.MethodPost, "/projects/"+alpha.ID+"/alerts/"+itoa(id)+"/ack", "")
	if ack.Code != http.StatusSeeOther || ack.Header().Get("Location") != "/projects/"+alpha.ID+"/alerts" {
		t.Fatalf("scoped ack redirect status=%d location=%q", ack.Code, ack.Header().Get("Location"))
	}

	db, err := sql.Open("sqlite", filepath.Join(alpha.WorkspacePath, "alerts.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE alerts; CREATE TABLE alerts (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	broken := apiRequest(t, s.Handler(), http.MethodGet, "/projects/"+alpha.ID+"/alerts", "")
	if broken.Code != http.StatusInternalServerError {
		t.Fatalf("alerts read error status=%d body=%s", broken.Code, broken.Body.String())
	}
	overview := apiRequest(t, s.Handler(), http.MethodGet, "/api/overview", "")
	if overview.Code != http.StatusInternalServerError {
		t.Fatalf("overview swallowed alert error status=%d body=%s", overview.Code, overview.Body.String())
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
		exit := 0
		if err := workflow.New(db).AddEvidence("T-1", 0, contracts.MachineAttested, "quality", "go test ./...", "", &exit, "evidence/quality.log", "sha256:approval", "", item.note); err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
	}
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	res := apiRequestWithCookie(t, s, bootstrapHuman(t, s), http.MethodGet, "/approvals")
	for _, want := range []string{"Recorded evidence", "alpha approval evidence", "beta approval evidence", "go test ./...", "Passed · exit 0", "evidence/quality.log", "sha256:approval"} {
		if !strings.Contains(res.Body.String(), want) {
			t.Fatalf("approvals missing %q: %s", want, res.Body.String())
		}
	}
}

func TestEvidenceViewsShowDecisionFieldsAndPropagateReadErrors(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	exit := 0
	if err := workflow.New(db).AddEvidence("SHARED", 0, contracts.MachineAttested, "tests", "go test ./...", ".", &exit, "evidence/test.log", "sha256:abc123", "commit", "all checks complete"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	page := apiRequest(t, s.Handler(), http.MethodGet, "/projects/"+alpha.ID+"/tasks/SHARED", "")
	for _, want := range []string{"Passed · exit 0", "machine_attested", "go test ./...", "evidence/test.log", "sha256:abc123", "all checks complete", "Recorded"} {
		if !strings.Contains(page.Body.String(), want) {
			t.Fatalf("evidence view missing %q: %s", want, page.Body.String())
		}
	}

	db, _ = store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	if _, err := db.Exec(`DROP TABLE evidence; CREATE TABLE evidence (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	broken := apiRequest(t, s.Handler(), http.MethodGet, "/projects/"+alpha.ID+"/tasks/SHARED", "")
	if broken.Code != http.StatusInternalServerError {
		t.Fatalf("evidence read error status=%d body=%s", broken.Code, broken.Body.String())
	}
}

func TestApprovalsPropagateEvidenceAndReviewReadErrors(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	seedApproval(t, alpha.WorkspacePath)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	if _, err := db.Exec(`DROP TABLE reviews; CREATE TABLE reviews (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	res := apiRequest(t, s.Handler(), http.MethodGet, "/approvals", "")
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("approval read error status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestTaskDetailShowsEvidenceFirstControls(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	e := workflow.New(db)
	if err := e.CreateTask(workflow.Task{ID: "DEP", Project: "alpha", Title: "dependency"}); err != nil {
		t.Fatal(err)
	}
	if err := e.SetDependencies("SHARED", []string{"DEP"}); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	res := apiRequestWithCookie(t, s, cookie, http.MethodGet, "/projects/"+alpha.ID+"/tasks/SHARED")
	for _, want := range []string{"Objective", "Acceptance criteria", "Verification", "Dependencies", "Evidence", "Reviews", "Timeline", "Edit task", "Archive", "Add comment", `<option value="DEP" selected>`} {
		if !strings.Contains(res.Body.String(), want) {
			t.Fatalf("detail missing %q: %s", want, res.Body.String())
		}
	}
}

func TestTaskFormsUseOneAtomicRequest(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	page := apiRequestWithCookie(t, s, bootstrapHuman(t, s), http.MethodGet, "/projects/"+alpha.ID+"/tasks/SHARED")
	if strings.Contains(page.Body.String(), "data-deps-api") {
		t.Fatalf("edit form retained split dependency request: %s", page.Body.String())
	}
	js := apiRequest(t, s.Handler(), http.MethodGet, "/static/app.js", "")
	if strings.Contains(js.Body.String(), "dataset.depsApi") {
		t.Fatalf("app.js retained split dependency request: %s", js.Body.String())
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

func TestContextReindexAtomicallyRemovesDeletedDerivedDocuments(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	codePath := filepath.Join(alpha.RepoPath, "stale.go")
	if err := os.WriteFile(codePath, []byte("package stale\n// stale-code-needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ks, err := knowledge.New(alpha.RepoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ks.AddDecision("Stale Knowledge Needle", "stale-knowledge-needle", "remove this decision"); err != nil {
		t.Fatal(err)
	}
	entries, err := ks.List()
	if err != nil {
		t.Fatal(err)
	}
	var decisionPath string
	for _, entry := range entries {
		if strings.Contains(entry.Body, "stale-knowledge-needle") {
			decisionPath = entry.Path
			break
		}
	}
	if decisionPath == "" {
		t.Fatal("seeded knowledge decision not found")
	}
	ms, err := memory.New(alpha.WorkspacePath)
	if err != nil {
		t.Fatal(err)
	}
	memoryID, err := ms.Remember("release", "stale", "stale-memory-needle", "SHARED", "codex")
	if err != nil {
		t.Fatal(err)
	}
	_ = ms.Close()

	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	reindexPath := "/api/projects/" + alpha.ID + "/context/reindex"
	if got := humanRequest(t, s, cookie, http.MethodPost, reindexPath, ""); got.Code != http.StatusOK {
		t.Fatalf("initial reindex status=%d body=%s", got.Code, got.Body.String())
	}

	if err := os.Remove(codePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(decisionPath); err != nil {
		t.Fatal(err)
	}
	ms, _ = memory.New(alpha.WorkspacePath)
	if err := ms.Forget(memoryID); err != nil {
		t.Fatal(err)
	}
	_ = ms.Close()
	if got := humanRequest(t, s, cookie, http.MethodPost, reindexPath, ""); got.Code != http.StatusOK {
		t.Fatalf("replacement reindex status=%d body=%s", got.Code, got.Body.String())
	}

	ctx, err := akctx.New(alpha.WorkspacePath)
	if err != nil {
		t.Fatal(err)
	}
	defer ctx.Close()
	for _, needle := range []string{"stale-code-needle", "stale-knowledge-needle", "stale-memory-needle"} {
		got, err := ctx.Search(needle, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Fatalf("deleted %s remained searchable: %#v", needle, got)
		}
	}
}

func TestContextReindexCollectionFailurePreservesPreviousIndex(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	if err := os.WriteFile(filepath.Join(alpha.RepoPath, "stable.go"), []byte("package stable\n// stable-index-needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { _ = s.Close() })
	cookie := bootstrapHuman(t, s)
	path := "/api/projects/" + alpha.ID + "/context/reindex"
	if got := humanRequest(t, s, cookie, http.MethodPost, path, ""); got.Code != http.StatusOK {
		t.Fatalf("initial reindex status=%d body=%s", got.Code, got.Body.String())
	}
	moved := alpha.RepoPath + "-unavailable"
	if err := os.Rename(alpha.RepoPath, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(moved, alpha.RepoPath) })
	if got := humanRequest(t, s, cookie, http.MethodPost, path, ""); got.Code != http.StatusInternalServerError {
		t.Fatalf("failed collection status=%d body=%s", got.Code, got.Body.String())
	}
	ctx, err := akctx.New(alpha.WorkspacePath)
	if err != nil {
		t.Fatal(err)
	}
	defer ctx.Close()
	got, err := ctx.Search("stable-index-needle", 10)
	if err != nil || len(got) != 1 {
		t.Fatalf("previous index was not preserved: docs=%#v err=%v", got, err)
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
