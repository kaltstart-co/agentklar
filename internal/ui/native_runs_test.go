package ui

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/runs"
	"github.com/kaltstart-co/agentklar/internal/store"
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

func TestNativeAttentionReadStaysProjectScoped(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	db, err := store.Open(filepath.Join(alpha.WorkspacePath, "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = runs.NewStore(db); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO native_runs(id,task_id,holder,fencing_token,request_hash,harness,model,purpose,read_only,prompt,status,created_at,updated_at) VALUES('failure','SHARED','fixture',1,'hash','codex','fixture','implement',0,'fixture','failed','2020','2020')`)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, project := range []string{alpha.ID, beta.ID} {
		w := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+project+"/runs", "")
		if w.Code != 200 {
			t.Fatalf("attention read: %d %s", w.Code, w.Body.String())
		}
		var data struct {
			Attention []runs.Run `json:"attention_runs"`
		}
		if err = json.Unmarshal(w.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if (project == alpha.ID && len(data.Attention) != 1) || (project == beta.ID && len(data.Attention) != 0) {
			t.Fatalf("attention scope: %s %+v", project, data)
		}
	}
	// A broken run source must produce a visible read error, never an empty success.
	if _, err = db.Exec(`ALTER TABLE native_runs RENAME COLUMN pending_request TO broken_request`); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(t, s.Handler(), http.MethodGet, "/api/projects/"+alpha.ID+"/runs", "")
	if w.Code != 500 || !strings.Contains(w.Body.String(), "runs_unavailable") {
		t.Fatalf("source failure: %d %s", w.Code, w.Body.String())
	}
}
