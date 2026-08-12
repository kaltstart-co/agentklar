package ui

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
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

const testOrigin = "http://127.0.0.1"

func bootstrapHuman(t *testing.T, s *Server) *http.Cookie {
	t.Helper()
	launch, err := s.LaunchURL(testOrigin + "/")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, launch, nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" {
		t.Fatalf("bootstrap status=%d location=%q body=%s", w.Code, w.Header().Get("Location"), w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("bootstrap cookies=%v", cookies)
	}
	cookie := cookies[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Value == "" {
		t.Fatalf("unsafe session cookie: %#v", cookie)
	}
	return cookie
}

func humanRequest(t *testing.T, s *Server, cookie *http.Cookie, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, testOrigin+path, strings.NewReader(body))
	req.Header.Set("Origin", testOrigin)
	req.AddCookie(cookie)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}

func TestBootstrapIsOneUseAndCreatesHumanSession(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if _, err := s.LaunchURL("http://evil.example/"); err == nil {
		t.Fatal("non-loopback launch URL accepted")
	}
	launch, err := s.LaunchURL(testOrigin + "/")
	if err != nil {
		t.Fatal(err)
	}
	first := httptest.NewRecorder()
	s.Handler().ServeHTTP(first, httptest.NewRequest(http.MethodGet, launch, nil))
	if first.Code != http.StatusSeeOther || len(first.Result().Cookies()) != 1 {
		t.Fatalf("first bootstrap status=%d cookies=%v", first.Code, first.Result().Cookies())
	}
	second := httptest.NewRecorder()
	s.Handler().ServeHTTP(second, httptest.NewRequest(http.MethodGet, launch, nil))
	if second.Code != http.StatusForbidden || len(second.Result().Cookies()) != 0 {
		t.Fatalf("replayed bootstrap status=%d cookies=%v", second.Code, second.Result().Cookies())
	}
}

func TestMutationsRequireSessionAndExactOrigin(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	path := "/api/projects/" + alpha.ID + "/tasks"
	body := `{"id":"blocked","title":"blocked"}`

	if got := apiRequest(t, s.Handler(), http.MethodPost, path, body); got.Code != http.StatusForbidden {
		t.Fatalf("raw mutation status=%d body=%s", got.Code, got.Body.String())
	}
	spoof := httptest.NewRequest(http.MethodPost, testOrigin+path, strings.NewReader(body))
	spoof.Header.Set("Origin", testOrigin)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, spoof)
	if w.Code != http.StatusForbidden {
		t.Fatalf("spoofed origin without session status=%d", w.Code)
	}

	cookie := bootstrapHuman(t, s)
	missingOrigin := httptest.NewRequest(http.MethodPost, testOrigin+path, strings.NewReader(body))
	missingOrigin.AddCookie(cookie)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, missingOrigin)
	if w.Code != http.StatusForbidden {
		t.Fatalf("session without origin status=%d", w.Code)
	}
	wrongOrigin := httptest.NewRequest(http.MethodPost, testOrigin+path, strings.NewReader(body))
	wrongOrigin.Header.Set("Origin", "http://evil.example")
	wrongOrigin.AddCookie(cookie)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, wrongOrigin)
	if w.Code != http.StatusForbidden {
		t.Fatalf("session with wrong origin status=%d", w.Code)
	}
	allowed := humanRequest(t, s, cookie, http.MethodPost, path, `{"id":"human","title":"human"}`)
	if allowed.Code != http.StatusCreated {
		t.Fatalf("human mutation status=%d body=%s", allowed.Code, allowed.Body.String())
	}
}

func TestApprovalTokenIsHumanOnlyActionBoundAndStale(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	seedApproval(t, alpha.WorkspacePath)
	seedApproval(t, beta.WorkspacePath)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })

	guest := apiRequest(t, s.Handler(), http.MethodGet, "/approvals", "")
	if strings.Contains(guest.Body.String(), "csrf_token") || strings.Contains(guest.Body.String(), "<form") {
		t.Fatalf("guest approval page exposed action: %s", guest.Body.String())
	}
	cookie := bootstrapHuman(t, s)
	req := httptest.NewRequest(http.MethodGet, testOrigin+"/approvals", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	body := w.Body.String()
	pattern := regexp.MustCompile(`<form method="post" action="([^"]+)">\s*<input type="hidden" name="csrf_token" value="([^"]+)">`)
	matches := pattern.FindAllStringSubmatch(body, -1)
	if len(matches) != 2 {
		t.Fatalf("approval forms=%d body=%s", len(matches), body)
	}
	var alphaAction, alphaToken string
	for _, match := range matches {
		if strings.Contains(match[1], alpha.ID) {
			alphaAction, alphaToken = match[1], match[2]
		}
	}
	if alphaToken == "" {
		t.Fatal("alpha approval form missing")
	}

	wrong := postApproval(t, s, cookie, "/projects/"+beta.ID+"/approvals/T-1", alphaToken)
	if wrong.Code != http.StatusForbidden {
		t.Fatalf("cross-project token status=%d body=%s", wrong.Code, wrong.Body.String())
	}
	approved := postApproval(t, s, cookie, alphaAction, alphaToken)
	if approved.Code != http.StatusSeeOther {
		t.Fatalf("approval status=%d body=%s", approved.Code, approved.Body.String())
	}
	replay := postApproval(t, s, cookie, alphaAction, alphaToken)
	if replay.Code != http.StatusConflict {
		t.Fatalf("stale approval token status=%d body=%s", replay.Code, replay.Body.String())
	}
}

func postApproval(t *testing.T, s *Server, cookie *http.Cookie, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	form := url.Values{"csrf_token": {token}}.Encode()
	req := httptest.NewRequest(http.MethodPost, testOrigin+path, strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", testOrigin)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}

func approvalFormFor(t *testing.T, s *Server, cookie *http.Cookie, projectID string) (string, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, testOrigin+"/approvals", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	pattern := regexp.MustCompile(`<form method="post" action="([^"]+)">\s*<input type="hidden" name="csrf_token" value="([^"]+)">`)
	for _, match := range pattern.FindAllStringSubmatch(w.Body.String(), -1) {
		if projectID == "" || strings.Contains(match[1], projectID) {
			return match[1], match[2]
		}
	}
	t.Fatalf("approval form for %q missing: %s", projectID, w.Body.String())
	return "", ""
}

func TestProjectLinksAndTaskEvidenceStayScoped(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	seedApproval(t, alpha.WorkspacePath)
	seedApproval(t, beta.WorkspacePath)
	for _, item := range []struct {
		project string
		note    string
	}{{alpha.WorkspacePath, "alpha evidence"}, {beta.WorkspacePath, "beta evidence"}} {
		db, _ := store.Open(filepath.Join(item.project, "control.sqlite"))
		if err := workflow.New(db).AddEvidence("SHARED", 0, contracts.MachineAttested, "scope", "check", "", nil, "", "", "", item.note); err != nil {
			t.Fatal(err)
		}
		db.Close()
	}
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })

	apps := apiRequest(t, s.Handler(), http.MethodGet, "/approvals", "")
	for _, want := range []string{"/projects/" + alpha.ID + "/tasks/T-1", "/projects/" + beta.ID + "/tasks/T-1"} {
		if !strings.Contains(apps.Body.String(), want) {
			t.Fatalf("approval page missing scoped link %q: %s", want, apps.Body.String())
		}
	}
	detail := apiRequest(t, s.Handler(), http.MethodGet, "/projects/"+beta.ID+"/tasks/SHARED", "")
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "beta evidence") || strings.Contains(detail.Body.String(), "alpha evidence") {
		t.Fatalf("scoped detail status=%d body=%s", detail.Code, detail.Body.String())
	}
}

func TestControlCenterKeepsCurrentProjectIntelligenceAvailable(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	k, _ := knowledge.New(alpha.RepoPath)
	if _, err := k.Add(knowledge.KindConvention, "Scoped knowledge", "current repo only"); err != nil {
		t.Fatal(err)
	}
	m, _ := memory.New(alpha.WorkspacePath)
	if _, err := m.Remember("", "scoped-memory", "memory needle", "", "human"); err != nil {
		t.Fatal(err)
	}
	m.Close()
	ctx, _ := akctx.New(alpha.WorkspacePath)
	if _, err := ctx.Index([]akctx.Doc{{Source: akctx.SourceCode, Ref: "needle", Title: "Context needle", Body: "indexed context"}}); err != nil {
		t.Fatal(err)
	}
	ctx.Close()
	alerts, _ := notify.New(alpha.WorkspacePath)
	alerts.SetDeliver(nil)
	if _, err := alerts.Record("", "human", notify.Info, "alert needle", false); err != nil {
		t.Fatal(err)
	}
	alerts.Close()

	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	checks := map[string]string{
		"/knowledge":         "Scoped knowledge",
		"/memory":            "memory needle",
		"/context?q=context": "Context needle",
		"/alerts":            "alert needle",
	}
	for path, want := range checks {
		res := apiRequest(t, s.Handler(), http.MethodGet, path, "")
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), want) {
			t.Errorf("GET %s status=%d missing %q: %s", path, res.Code, want, res.Body.String())
		}
	}
}

func TestCatalogAndApprovalAggregationErrorsAreNotNotFound(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, _ := NewControlCenter(c, alpha.ID)
	t.Cleanup(func() { s.Close() })
	if err := os.Remove(filepath.Join(beta.WorkspacePath, "control.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(beta.WorkspacePath, "control.sqlite"), 0o755); err != nil {
		t.Fatal(err)
	}
	apps := apiRequest(t, s.Handler(), http.MethodGet, "/api/approvals", "")
	if apps.Code != http.StatusInternalServerError {
		t.Fatalf("approval aggregation status=%d body=%s", apps.Code, apps.Body.String())
	}
	html := apiRequest(t, s.Handler(), http.MethodGet, "/approvals", "")
	if html.Code != http.StatusInternalServerError {
		t.Fatalf("approval HTML status=%d body=%s", html.Code, html.Body.String())
	}

	_ = c.Close()
	project := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/tasks", "")
	if project.Code != http.StatusInternalServerError {
		t.Fatalf("closed catalog status=%d body=%s", project.Code, project.Body.String())
	}
}
