package vikunja

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/tracker"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// These tests run only against a live Vikunja instance. Set:
//
//	AGENTKLAR_VIKUNJA_URL   e.g. http://localhost:3456/api/v1
//	AGENTKLAR_VIKUNJA_HUMAN e.g. divyansh:devpassword123
//	AGENTKLAR_VIKUNJA_SVC   e.g. agentklar-svc:svcpassword123
//
// Otherwise they skip — mock-only adapter tests are explicitly insufficient.
func liveClients(t *testing.T) (svc, human *Client, url string) {
	t.Helper()
	url = os.Getenv("AGENTKLAR_VIKUNJA_URL")
	hu := os.Getenv("AGENTKLAR_VIKUNJA_HUMAN")
	sv := os.Getenv("AGENTKLAR_VIKUNJA_SVC")
	if url == "" || hu == "" || sv == "" {
		t.Skip("set AGENTKLAR_VIKUNJA_URL/HUMAN/SVC to run live Vikunja integration tests")
	}
	split := func(s string) (string, string) {
		for i := 0; i < len(s); i++ {
			if s[i] == ':' {
				return s[:i], s[i+1:]
			}
		}
		return s, ""
	}
	su, sp := split(sv)
	hu2, hp := split(hu)
	var err error
	svc, err = Login(url, su, sp)
	if err != nil {
		t.Fatalf("service login: %v", err)
	}
	human, err = Login(url, hu2, hp)
	if err != nil {
		t.Fatalf("human login: %v", err)
	}
	return svc, human, url
}

func newEngine(t *testing.T) *workflow.Engine {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return workflow.New(db)
}

// The end-to-end trusted-approval path against a real tracker: a human
// comment carrying the live nonce reaches Done; nothing else does.
func TestLiveHumanApprovalReachesDone(t *testing.T) {
	svc, human, _ := liveClients(t)
	eng := newEngine(t)

	proj, err := svc.EnsureProject("Agentklar Test Board")
	if err != nil {
		t.Fatal(err)
	}
	humanID, _ := human.CurrentUserID()
	svcID, _ := svc.CurrentUserID()
	if err := svc.ShareWithUser(proj.ID, humanUsername(t, human), 2); err != nil {
		t.Fatalf("share: %v", err)
	}

	// Project a task and drive it to User Approval in the engine.
	tt, err := svc.CreateTask(proj.ID, "AK-live approval", "objective")
	if err != nil {
		t.Fatal(err)
	}
	taskID := fmt.Sprintf("AK-live-%d", tt.ID)
	if err := eng.CreateTask(workflow.Task{
		ID: taskID, Project: "test", Title: "live", Lane: contracts.LaneQuick,
		Criteria: []string{"c"}, Verification: "v", TrackerID: fmt.Sprintf("%d", tt.ID),
	}); err != nil {
		t.Fatal(err)
	}
	eng.MarkReady(taskID, contracts.ActorHuman)
	c, _ := eng.ClaimTask(taskID, "agent", contracts.StateReady)
	sub, _ := eng.SubmitForReview(taskID, c.FencingToken, "base", "head", "s")
	eng.RecordReview(taskID, sub, "completion", contracts.ResultPass, "det", "[]")
	eng.RecordReview(taskID, sub, "qa", contracts.ResultPass, "det", "[]")

	rec := &Reconciler{
		Engine: eng, Client: svc, Project: proj.ID,
		Policy: tracker.ApprovalPolicy{ServiceAccountID: fmt.Sprintf("%d", svcID)},
	}
	if err := rec.PostPendingPrompt(taskID, tt.ID, "head", []string{"c"}); err != nil {
		t.Fatalf("post prompt: %v", err)
	}

	// The service account's own prompt must NOT self-approve.
	if d, err := rec.ReconcileTask(taskID, tt.ID); err != nil || d != nil {
		t.Fatalf("service-account prompt was treated as approval: decision=%v err=%v", d, err)
	}
	task, _ := eng.GetTask(taskID)
	if task.State == contracts.StateDone {
		t.Fatal("task reached Done from the service account's own prompt")
	}

	// The nonce reached the human only via the tracker; read it back the
	// same way a human would (from the posted comment) and approve.
	nonce := extractNonce(t, svc, tt.ID)
	if _, err := human.PostComment(tt.ID, "looks good — approve "+nonce); err != nil {
		t.Fatal(err)
	}
	decision, err := rec.ReconcileTask(taskID, tt.ID)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if decision == nil || !decision.Approve {
		t.Fatalf("human approval was not applied: %+v", decision)
	}
	task, _ = eng.GetTask(taskID)
	if task.State != contracts.StateDone {
		t.Fatalf("expected Done after human approval, got %s", task.State)
	}
	_ = humanID
}

// A comment from the service account with a valid-looking directive must
// never approve, even against the live tracker.
func TestLiveServiceAccountCannotSelfApprove(t *testing.T) {
	svc, _, _ := liveClients(t)
	eng := newEngine(t)
	proj, _ := svc.EnsureProject("Agentklar Test Board")
	svcID, _ := svc.CurrentUserID()

	tt, _ := svc.CreateTask(proj.ID, "AK-self approval", "obj")
	taskID := fmt.Sprintf("AK-self-%d", tt.ID)
	eng.CreateTask(workflow.Task{
		ID: taskID, Project: "test", Title: "s", Lane: contracts.LaneQuick,
		Criteria: []string{"c"}, Verification: "v",
	})
	eng.MarkReady(taskID, contracts.ActorHuman)
	c, _ := eng.ClaimTask(taskID, "agent", contracts.StateReady)
	sub, _ := eng.SubmitForReview(taskID, c.FencingToken, "b", "h", "s")
	eng.RecordReview(taskID, sub, "completion", contracts.ResultPass, "det", "[]")
	eng.RecordReview(taskID, sub, "qa", contracts.ResultPass, "det", "[]")

	nonce, _, _ := eng.PendingApproval(taskID)
	// Service account itself posts a perfectly-formed directive.
	svc.PostComment(tt.ID, "approve "+nonce)

	rec := &Reconciler{
		Engine: eng, Client: svc, Project: proj.ID,
		Policy: tracker.ApprovalPolicy{ServiceAccountID: fmt.Sprintf("%d", svcID)},
	}
	d, err := rec.ReconcileTask(taskID, tt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d != nil {
		t.Fatal("service-account directive was accepted as approval")
	}
	task, _ := eng.GetTask(taskID)
	if task.State == contracts.StateDone {
		t.Fatal("service account self-approved to Done")
	}
}

func humanUsername(t *testing.T, human *Client) string {
	t.Helper()
	var u struct {
		Username string `json:"username"`
	}
	if err := human.do("GET", "/user", nil, &u); err != nil {
		t.Fatal(err)
	}
	return u.Username
}

func extractNonce(t *testing.T, svc *Client, trackerTaskID int64) string {
	t.Helper()
	comments, err := svc.ListComments(trackerTaskID)
	if err != nil {
		t.Fatal(err)
	}
	re := tracker.NonceRegexp()
	for _, c := range comments {
		if m := re.FindString(c.Body); m != "" {
			return m
		}
	}
	t.Fatal("no nonce found in tracker comments")
	return ""
}
