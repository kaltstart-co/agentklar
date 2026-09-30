package ui

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestNativePermissionRequiresTrustedSessionAndProject(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	called := 0
	s.NativePermission = func(repo, run string, id json.RawMessage, decision string) error {
		called++
		if repo != alpha.RepoPath || run != "run-1" || string(id) != "0" || decision != "accept" {
			t.Fatalf("bad permission scope: %s %s %s %s", repo, run, id, decision)
		}
		return nil
	}
	path := "/api/projects/" + alpha.ID + "/runs/run-1/permission"
	body := `{"request_id":0,"decision":"accept"}`
	if w := apiRequest(t, s.Handler(), http.MethodPost, path, body); w.Code != http.StatusForbidden {
		t.Fatalf("untrusted permission: %d", w.Code)
	}
	if called != 0 {
		t.Fatal("untrusted request reached native process")
	}
	cookie := bootstrapHuman(t, s)
	if w := humanRequest(t, s, cookie, http.MethodPost, path, body); w.Code != http.StatusOK {
		t.Fatalf("trusted permission: %d %s", w.Code, w.Body.String())
	}
	if called != 1 {
		t.Fatal("trusted decision did not reach callback")
	}
	other := "/api/projects/" + beta.ID + "/runs/run-1"
	if w := apiRequest(t, s.Handler(), http.MethodGet, other, ""); w.Code != http.StatusNotFound {
		t.Fatalf("another project saw run: %d", w.Code)
	}
	s.NativePermission = nil
	if w := humanRequest(t, s, cookie, http.MethodPost, path, body); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("detached UI permission: %d", w.Code)
	}
}
