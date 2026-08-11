package ui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/catalog"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func seedProjects(t *testing.T) (*catalog.Catalog, catalog.Project, catalog.Project) {
	t.Helper()
	root := t.TempDir()
	c, err := catalog.Open(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	register := func(name string) catalog.Project {
		repo := filepath.Join(root, "repos", name)
		if err := os.MkdirAll(repo, 0o755); err != nil {
			t.Fatal(err)
		}
		p, err := c.Register(repo, filepath.Join(root, "data", "workspaces", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(p.WorkspacePath, 0o755); err != nil {
			t.Fatal(err)
		}
		db, err := store.Open(filepath.Join(p.WorkspacePath, "control.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		if err := workflow.New(db).CreateTask(workflow.Task{ID: "SHARED", Project: name, RepoPath: repo, Title: name + " task"}); err != nil {
			t.Fatal(err)
		}
		db.Close()
		return p
	}
	return c, register("alpha"), register("beta")
}

func apiRequest(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestProjectsAndOverviewAreCatalogAware(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	projects := apiRequest(t, s.Handler(), "GET", "/api/projects", "")
	if projects.Code != http.StatusOK || !strings.Contains(projects.Body.String(), alpha.ID) || !strings.Contains(projects.Body.String(), beta.ID) {
		t.Fatalf("projects: status=%d body=%s", projects.Code, projects.Body.String())
	}
	overview := apiRequest(t, s.Handler(), "GET", "/api/overview", "")
	if overview.Code != http.StatusOK || strings.Count(overview.Body.String(), `"draft":1`) != 2 {
		t.Fatalf("overview: status=%d body=%s", overview.Code, overview.Body.String())
	}
}

func TestTaskMutationsStayInsideProject(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	h := s.Handler()
	cookie := bootstrapHuman(t, s)

	create := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks", `{"id":"A-2","title":"new task","priority":"high","lane":"standard","isolation":"auto","target":"any","criteria":["works"],"verification":"go test ./..."}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", create.Code, create.Body.String())
	}
	edit := humanRequest(t, s, cookie, "PATCH", "/api/projects/"+alpha.ID+"/tasks/A-2", `{"assignee":"D","labels":["api"]}`)
	if edit.Code != http.StatusOK {
		t.Fatalf("edit: status=%d body=%s", edit.Code, edit.Body.String())
	}
	comment := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks/A-2/comments", `{"body":"ship it"}`)
	if comment.Code != http.StatusCreated {
		t.Fatalf("comment: status=%d body=%s", comment.Code, comment.Body.String())
	}
	ready := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks/A-2/transition", `{"state":"ready"}`)
	if ready.Code != http.StatusOK {
		t.Fatalf("transition: status=%d body=%s", ready.Code, ready.Body.String())
	}
	reorder := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks/A-2/position", `{"state":"ready","ordered_ids":["A-2"]}`)
	if reorder.Code != http.StatusOK {
		t.Fatalf("reorder: status=%d body=%s", reorder.Code, reorder.Body.String())
	}
	detail := apiRequest(t, h, "GET", "/api/projects/"+alpha.ID+"/tasks/A-2", "")
	for _, want := range []string{"D", "api", "ship it", "ready"} {
		if !strings.Contains(detail.Body.String(), want) {
			t.Fatalf("detail missing %q: %s", want, detail.Body.String())
		}
	}

	wrongProject := apiRequest(t, h, "GET", "/api/projects/"+beta.ID+"/tasks/A-2", "")
	if wrongProject.Code != http.StatusNotFound {
		t.Fatalf("cross-project lookup status=%d body=%s", wrongProject.Code, wrongProject.Body.String())
	}
	alphaList := apiRequest(t, h, "GET", "/api/projects/"+alpha.ID+"/tasks", "")
	betaList := apiRequest(t, h, "GET", "/api/projects/"+beta.ID+"/tasks", "")
	if !strings.Contains(alphaList.Body.String(), "alpha task") || strings.Contains(alphaList.Body.String(), "beta task") || !strings.Contains(betaList.Body.String(), "beta task") {
		t.Fatalf("scoping failed: alpha=%s beta=%s", alphaList.Body.String(), betaList.Body.String())
	}
}

func TestTaskAPIValidatesInputAndKeepsTerminalStatesVisible(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	e := workflow.New(db)
	for _, state := range []contracts.State{contracts.StateWaiting, contracts.StateBlocked, contracts.StateCancelled} {
		id := strings.ToUpper(string(state))
		if err := e.CreateTask(workflow.Task{ID: id, Project: "alpha", Title: id}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE tasks SET state = ? WHERE id = ?`, state, id); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	cookie := bootstrapHuman(t, s)

	list := apiRequest(t, s.Handler(), "GET", "/api/projects/"+alpha.ID+"/tasks", "")
	for _, want := range []string{"waiting", "blocked", "cancelled"} {
		if !strings.Contains(list.Body.String(), want) {
			t.Fatalf("list omitted %s: %s", want, list.Body.String())
		}
	}
	badEnum := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks", `{"id":"bad","title":"bad","priority":"extreme"}`)
	if badEnum.Code != http.StatusBadRequest || !strings.Contains(badEnum.Body.String(), `"code":"invalid_input"`) {
		t.Fatalf("bad enum: status=%d body=%s", badEnum.Code, badEnum.Body.String())
	}
	large := append([]byte(`{"id":"large","title":"`), bytes.Repeat([]byte("x"), 1<<20+1)...)
	large = append(large, []byte(`"}`)...)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", testOrigin+"/api/projects/"+alpha.ID+"/tasks", bytes.NewReader(large))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", testOrigin)
	r.AddCookie(cookie)
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("large body status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestApprovalNonceRedactedAndApprovalRequiresFormToken(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	seedApproval(t, alpha.WorkspacePath)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })

	apps := apiRequest(t, s.Handler(), "GET", "/api/approvals", "")
	if apps.Code != http.StatusOK || strings.Contains(strings.ToLower(apps.Body.String()), "nonce") {
		t.Fatalf("approval JSON leaked nonce: status=%d body=%s", apps.Code, apps.Body.String())
	}
	without := apiRequest(t, s.Handler(), "POST", "/projects/"+alpha.ID+"/approvals/T-1", "")
	if without.Code != http.StatusForbidden {
		t.Fatalf("approval without token status=%d", without.Code)
	}
}

func TestOriginAndDoneTransitionBoundaries(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	cookie := bootstrapHuman(t, s)

	r := httptest.NewRequest("POST", "/api/projects/"+alpha.ID+"/tasks", strings.NewReader(`{"id":"evil","title":"evil"}`))
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin mutation status=%d body=%s", w.Code, w.Body.String())
	}
	done := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks/SHARED/transition", `{"state":"done"}`)
	if done.Code != http.StatusConflict || !strings.Contains(done.Body.String(), `"code":"invalid_transition"`) {
		t.Fatalf("done transition: status=%d body=%s", done.Code, done.Body.String())
	}
}

func TestRequestChangesRecordsReason(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	seedApproval(t, alpha.WorkspacePath)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	cookie := bootstrapHuman(t, s)

	res := humanRequest(t, s, cookie, "POST", "/api/projects/"+alpha.ID+"/tasks/T-1/request-changes", `{"reason":"add the missing test"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("request changes: status=%d body=%s", res.Code, res.Body.String())
	}
	detail := apiRequest(t, s.Handler(), "GET", "/api/projects/"+alpha.ID+"/tasks/T-1", "")
	if !strings.Contains(detail.Body.String(), "changes_requested") || !strings.Contains(detail.Body.String(), "add the missing test") {
		t.Fatalf("request changes not recorded: %s", detail.Body.String())
	}
}

func TestAPIErrorShape(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	res := apiRequest(t, s.Handler(), "GET", "/api/projects/"+alpha.ID+"/tasks/missing", "")
	var payload struct {
		Error struct {
			Code, Message string
		}
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil || payload.Error.Code != "not_found" || payload.Error.Message == "" {
		t.Fatalf("error response = %s, decode err=%v", res.Body.String(), err)
	}
}

func TestListenRefusesNonLoopback(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if _, err := s.Listen("0.0.0.0:0"); err == nil {
		t.Fatal("non-loopback listen unexpectedly allowed")
	}
}

func TestProjectDependenciesRejectCrossProjectIDs(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	if err := workflow.New(db).CreateTask(workflow.Task{ID: "ALPHA-2", Project: "alpha", Title: "alpha dependency"}); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, _ = store.Open(filepath.Join(beta.WorkspacePath, "control.sqlite"))
	if err := workflow.New(db).CreateTask(workflow.Task{ID: "BETA-ONLY", Project: "beta", Title: "beta dependency"}); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	cookie := bootstrapHuman(t, s)

	set := humanRequest(t, s, cookie, http.MethodPut, "/api/projects/"+alpha.ID+"/tasks/SHARED/dependencies", `{"dependencies":["ALPHA-2"]}`)
	if set.Code != http.StatusOK {
		t.Fatalf("set dependencies status=%d body=%s", set.Code, set.Body.String())
	}
	get := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/tasks/SHARED/dependencies", "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), "ALPHA-2") {
		t.Fatalf("get dependencies status=%d body=%s", get.Code, get.Body.String())
	}
	cross := humanRequest(t, s, cookie, http.MethodPut, "/api/projects/"+alpha.ID+"/tasks/SHARED/dependencies", `{"dependencies":["BETA-ONLY"]}`)
	if cross.Code != http.StatusConflict || !strings.Contains(cross.Body.String(), `"code":"invalid_dependency"`) {
		t.Fatalf("cross-project dependency status=%d body=%s", cross.Code, cross.Body.String())
	}
	bare := apiRequest(t, s.Handler(), http.MethodGet, "/api/tasks/SHARED/dependencies", "")
	if bare.Code != http.StatusNotFound {
		t.Fatalf("bare dependency route status=%d", bare.Code)
	}
}

func TestArchiveActionKeepsTaskInScopedHistory(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	cookie := bootstrapHuman(t, s)

	archived := humanRequest(t, s, cookie, http.MethodPost, "/api/projects/"+alpha.ID+"/tasks/SHARED/archive", "")
	if archived.Code != http.StatusOK {
		t.Fatalf("archive status=%d body=%s", archived.Code, archived.Body.String())
	}
	active := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/tasks", "")
	if strings.Contains(active.Body.String(), "SHARED") {
		t.Fatalf("active list retained archived task: %s", active.Body.String())
	}
	history := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/tasks?archived=true", "")
	if history.Code != http.StatusOK || !strings.Contains(history.Body.String(), "SHARED") {
		t.Fatalf("archived history status=%d body=%s", history.Code, history.Body.String())
	}
	detail := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/tasks/SHARED", "")
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "ArchivedAt") {
		t.Fatalf("archived detail status=%d body=%s", detail.Code, detail.Body.String())
	}
	betaList := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+beta.ID+"/tasks?archived=true", "")
	if strings.Contains(betaList.Body.String(), "SHARED") {
		t.Fatalf("archive history crossed projects: %s", betaList.Body.String())
	}
}

func TestCreateDistinguishesDuplicateStorageAndReadFailures(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	db, _ := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	if _, err := db.Exec(`CREATE TRIGGER fail_create BEFORE INSERT ON tasks WHEN NEW.id = 'FAIL'
		BEGIN SELECT RAISE(FAIL, 'storage failed'); END;
		CREATE TRIGGER vanish_create AFTER INSERT ON tasks WHEN NEW.id = 'VANISH'
		BEGIN DELETE FROM tasks WHERE id = NEW.id; END;`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	cookie := bootstrapHuman(t, s)
	create := func(id string) *httptest.ResponseRecorder {
		return humanRequest(t, s, cookie, http.MethodPost, "/api/projects/"+alpha.ID+"/tasks", `{"id":"`+id+`","title":"task"}`)
	}
	if got := create("SHARED"); got.Code != http.StatusConflict || !strings.Contains(got.Body.String(), `"code":"task_exists"`) {
		t.Fatalf("duplicate status=%d body=%s", got.Code, got.Body.String())
	}
	if got := create("FAIL"); got.Code != http.StatusInternalServerError || !strings.Contains(got.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("storage failure status=%d body=%s", got.Code, got.Body.String())
	}
	if got := create("VANISH"); got.Code != http.StatusInternalServerError || !strings.Contains(got.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("follow-up read status=%d body=%s", got.Code, got.Body.String())
	}
}
