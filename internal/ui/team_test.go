package ui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/team"
)

func teamPut(t *testing.T, s *Server, cookie *http.Cookie, path, revision, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, testOrigin+path, strings.NewReader(body))
	r.Header.Set("Origin", testOrigin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", revision)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestTeamSettingsProjectIsolationAndStaleSave(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	path := "/api/projects/" + alpha.ID + "/team"
	initial := apiRequest(t, s.Handler(), "GET", path, "")
	if initial.Code != http.StatusOK || initial.Header().Get("ETag") == "" {
		t.Fatalf("load: %d %s", initial.Code, initial.Body.String())
	}
	config := team.Default()
	config.Preference = "cost"
	config.Roles = []team.Role{{ID: "builder", Responsibility: "Implement changes", Harness: "codex", Model: "auto", Access: []string{"descriptive label only"}}}
	body, _ := json.Marshal(config)
	cookie := bootstrapHuman(t, s)
	save := teamPut(t, s, cookie, path, initial.Header().Get("ETag"), string(body))
	if save.Code != http.StatusOK {
		t.Fatalf("save: %d %s", save.Code, save.Body.String())
	}
	if save.Header().Get("ETag") == initial.Header().Get("ETag") {
		t.Fatal("revision did not change")
	}
	stored, err := team.Load(alpha.RepoPath)
	if err != nil || stored.Preference != "cost" || len(stored.Roles) != 1 {
		t.Fatalf("stored: %+v %v", stored, err)
	}
	other, err := team.Load(beta.RepoPath)
	if err != nil || other.Preference != "balanced" || len(other.Roles) != 0 {
		t.Fatal("save escaped project")
	}
	stale := teamPut(t, s, cookie, path, initial.Header().Get("ETag"), string(body))
	if stale.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale status %d", stale.Code)
	}
	noRevision := teamPut(t, s, cookie, path, "", string(body))
	if noRevision.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing revision status %d", noRevision.Code)
	}
	invalid := teamPut(t, s, cookie, path, save.Header().Get("ETag"), `{"version":1,"preference":"cost","roles":[],"pins":[],"shell":"unsafe"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status %d", invalid.Code)
	}
	invalidRole := teamPut(t, s, cookie, path, save.Header().Get("ETag"), `{"version":1,"preference":"cost","roles":[{"id":"../bad","responsibility":"build","harness":"codex","model":"auto"}],"pins":[]}`)
	if invalidRole.Code != http.StatusBadRequest {
		t.Fatalf("invalid role status %d", invalidRole.Code)
	}
	stored, err = team.Load(alpha.RepoPath)
	if err != nil || len(stored.Roles) != 1 {
		t.Fatal("rejected edit changed config")
	}
	deleted := teamPut(t, s, cookie, path, save.Header().Get("ETag"), `{"version":1,"preference":"balanced","roles":[],"pins":[]}`)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete roles: %d %s", deleted.Code, deleted.Body.String())
	}
	stored, err = team.Load(alpha.RepoPath)
	if err != nil || len(stored.Roles) != 0 {
		t.Fatal("role removal not saved")
	}
}

func TestTeamMutationRequiresHumanAndExactOrigin(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	path := "/api/projects/" + alpha.ID + "/team"
	body := `{"version":1,"preference":"cost","roles":[],"pins":[]}`
	if got := apiRequest(t, s.Handler(), "PUT", path, body); got.Code != http.StatusForbidden {
		t.Fatalf("raw write: %d", got.Code)
	}
	cookie := bootstrapHuman(t, s)
	r := httptest.NewRequest("PUT", testOrigin+path, strings.NewReader(body))
	r.AddCookie(cookie)
	r.Header.Set("Origin", "http://evil.example")
	r.Header.Set("If-Match", `"absent"`)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross origin write: %d", w.Code)
	}
	unknown := apiRequest(t, s.Handler(), "GET", "/api/projects/not-registered/team", "")
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown project: %d", unknown.Code)
	}
}
