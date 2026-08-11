package workflow

import (
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/store"
)

func newEngine(t *testing.T) *Engine {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "control.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db)
}

func readyTask(t *testing.T, e *Engine, id string, lane contracts.Lane, repo string) {
	t.Helper()
	task := Task{
		ID: id, Project: "p", RepoPath: repo, Title: id, Lane: lane,
		Isolation: contracts.IsolationAuto,
		Criteria:  []string{"it works"}, Verification: "go test ./...",
	}
	if err := e.CreateTask(task); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := e.MarkReady(id, contracts.ActorHuman); err != nil {
		t.Fatalf("ready: %v", err)
	}
}

// Definition of Ready: a task without criteria or a verification method
// cannot reach Ready (acceptance criterion #6).
func TestDefinitionOfReadyBlocksIncompleteTask(t *testing.T) {
	e := newEngine(t)
	if err := e.CreateTask(Task{ID: "T1", Project: "p", Title: "bare"}); err != nil {
		t.Fatal(err)
	}
	if err := e.MarkReady("T1", contracts.ActorHuman); err == nil {
		t.Fatal("expected Ready to be rejected without criteria/verification")
	}
}

// An agent cannot claim a Draft task.
func TestDraftCannotBeClaimed(t *testing.T) {
	e := newEngine(t)
	if err := e.CreateTask(Task{ID: "T1", Project: "p", Title: "draft"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.ClaimTask("T1", "agent-a", contracts.StateDraft); err == nil {
		t.Fatal("expected Draft claim to be rejected")
	}
}

// Concurrent claims: exactly one agent wins (acceptance criterion #14).
func TestConcurrentClaimsExactlyOneWinner(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")

	const n = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	var wins []int64
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, err := e.ClaimTask("T1", "agent", contracts.StateReady)
			if err == nil {
				mu.Lock()
				wins = append(wins, c.FencingToken)
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if len(wins) != 1 {
		t.Fatalf("expected exactly 1 successful claim, got %d", len(wins))
	}
}

// A superseded fencing token cannot mutate protected state.
func TestStaleFencingTokenRejected(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")

	first, err := e.ClaimTask("T1", "agent-a", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.ReleaseTask("T1", first.FencingToken); err != nil {
		t.Fatal(err)
	}
	second, err := e.ClaimTask("T1", "agent-b", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	if second.FencingToken <= first.FencingToken {
		t.Fatalf("fencing token must increase: %d -> %d", first.FencingToken, second.FencingToken)
	}
	// The stale holder must not be able to submit.
	if _, err := e.SubmitForReview("T1", first.FencingToken, "base", "head", "stale"); err == nil {
		t.Fatal("stale fencing token was allowed to submit")
	}
	if err := e.Heartbeat("T1", first.FencingToken); err == nil {
		t.Fatal("stale fencing token was allowed to heartbeat")
	}
}

// Quick 'auto' takes the primary worktree under an exclusive repo lease;
// a second code claim on the same repo is rejected (acceptance criterion #14).
func TestQuickAutoExclusiveRepositoryLease(t *testing.T) {
	e := newEngine(t)
	repo := "/tmp/repo-a"
	readyTask(t, e, "Q1", contracts.LaneQuick, repo)
	readyTask(t, e, "Q2", contracts.LaneQuick, repo)

	c1, err := e.ClaimTask("Q1", "agent-a", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	if c1.Worktree != "primary" {
		t.Fatalf("expected primary worktree for quick auto, got %q", c1.Worktree)
	}
	if _, err := e.ClaimTask("Q2", "agent-b", contracts.StateReady); err != ErrRepoBusy {
		t.Fatalf("expected ErrRepoBusy for second code claim, got %v", err)
	}
}

// Standard tasks never take the primary worktree; they get dedicated ones
// and may run concurrently.
func TestStandardTasksGetDedicatedWorktrees(t *testing.T) {
	e := newEngine(t)
	repo := "/tmp/repo-b"
	readyTask(t, e, "S1", contracts.LaneStandard, repo)
	readyTask(t, e, "S2", contracts.LaneStandard, repo)

	c1, err := e.ClaimTask("S1", "agent-a", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	c2, err := e.ClaimTask("S2", "agent-b", contracts.StateReady)
	if err != nil {
		t.Fatalf("concurrent standard claims must both succeed: %v", err)
	}
	if c1.Worktree != "dedicated" || c2.Worktree != "dedicated" {
		t.Fatalf("standard claims must be dedicated, got %q and %q", c1.Worktree, c2.Worktree)
	}
}

// Duplicate submissions are idempotent: retries never create a second
// submission or duplicate evidence.
func TestSubmitIsIdempotent(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")
	c, _ := e.ClaimTask("T1", "agent-a", contracts.StateReady)

	first, err := e.SubmitForReview("T1", c.FencingToken, "base", "head", "done")
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.SubmitForReview("T1", c.FencingToken, "base", "head", "done again")
	if err != nil {
		t.Fatalf("duplicate submit should be idempotent, got %v", err)
	}
	if first != second {
		t.Fatalf("idempotent submit returned different ids: %d vs %d", first, second)
	}
}

// A new commit makes the prior review stale; the stale submission cannot
// be reviewed to a pass (acceptance criterion #8).
func TestStaleSubmissionCannotBeReviewed(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")
	c, _ := e.ClaimTask("T1", "agent-a", contracts.StateReady)
	oldSub, _ := e.SubmitForReview("T1", c.FencingToken, "base", "head1", "v1")

	// Reviewer fails it, agent revises, resubmits at a new head.
	if err := e.RecordReview("T1", oldSub, "completion", contracts.ResultFail, "test", "[]"); err != nil {
		t.Fatal(err)
	}
	c2, err := e.ClaimTask("T1", "agent-a", contracts.StateChangesRequested)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SubmitForReview("T1", c2.FencingToken, "base", "head2", "v2"); err != nil {
		t.Fatal(err)
	}
	// The old submission is now stale and must not pass.
	if err := e.RecordReview("T1", oldSub, "completion", contracts.ResultPass, "test", "[]"); err != ErrStaleCommit {
		t.Fatalf("expected ErrStaleCommit for superseded submission, got %v", err)
	}
}

// The human-only Done boundary: reaching Done requires the pending nonce,
// and the nonce is single-use (acceptance criteria #7, #12).
func TestHumanOnlyDoneRequiresValidNonce(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneQuick, "")
	c, _ := e.ClaimTask("T1", "agent-a", contracts.StateReady)
	sub, _ := e.SubmitForReview("T1", c.FencingToken, "base", "head", "done")
	if err := e.RecordReview("T1", sub, "completion", contracts.ResultPass, "det", "[]"); err != nil {
		t.Fatal(err)
	}
	if err := e.RecordReview("T1", sub, "qa", contracts.ResultPass, "det", "[]"); err != nil {
		t.Fatal(err)
	}
	task, _ := e.GetTask("T1")
	if task.State != contracts.StateUserApproval {
		t.Fatalf("expected User Approval, got %s", task.State)
	}

	// A guessed/absent nonce cannot approve.
	if err := e.ResolveApproval("T1", "00000000000000000000000000000000", true, "mallory", "cli"); err != ErrNonceInvalid {
		t.Fatalf("expected ErrNonceInvalid for wrong nonce, got %v", err)
	}
	task, _ = e.GetTask("T1")
	if task.State == contracts.StateDone {
		t.Fatal("task reached Done without a valid human decision")
	}

	nonce, _, err := e.PendingApproval("T1")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.ResolveApproval("T1", nonce, true, "divyansh", "tracker_comment"); err != nil {
		t.Fatal(err)
	}
	task, _ = e.GetTask("T1")
	if task.State != contracts.StateDone {
		t.Fatalf("expected Done after human approval, got %s", task.State)
	}
	// Nonce is single-use.
	if err := e.ResolveApproval("T1", nonce, true, "divyansh", "tracker_comment"); err == nil {
		t.Fatal("nonce was reusable after a decision")
	}
}

// Human rejection returns the task to Changes Requested, not Done.
func TestHumanRejectionReturnsToChangesRequested(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneQuick, "")
	c, _ := e.ClaimTask("T1", "agent-a", contracts.StateReady)
	sub, _ := e.SubmitForReview("T1", c.FencingToken, "base", "head", "s")
	e.RecordReview("T1", sub, "completion", contracts.ResultPass, "det", "[]")
	e.RecordReview("T1", sub, "qa", contracts.ResultPass, "det", "[]")

	nonce, _, _ := e.PendingApproval("T1")
	if err := e.ResolveApproval("T1", nonce, false, "divyansh", "tracker_comment"); err != nil {
		t.Fatal(err)
	}
	task, _ := e.GetTask("T1")
	if task.State != contracts.StateChangesRequested {
		t.Fatalf("expected Changes Requested after rejection, got %s", task.State)
	}
}

func TestResolveApprovalWithReasonAppendsHumanRequestChangesComment(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneQuick, "")
	c, _ := e.ClaimTask("T1", "agent-a", contracts.StateReady)
	sub, _ := e.SubmitForReview("T1", c.FencingToken, "base", "head", "s")
	e.RecordReview("T1", sub, "completion", contracts.ResultPass, "det", "[]")
	e.RecordReview("T1", sub, "qa", contracts.ResultPass, "det", "[]")

	nonce, _, _ := e.PendingApproval("T1")
	if err := e.ResolveApprovalWithReason("T1", nonce, false, "divyansh", "tracker_comment", "bound the retry loop"); err != nil {
		t.Fatal(err)
	}
	var actor, ctype, body string
	if err := e.DB().QueryRow(`SELECT actor, ctype, body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1`, "T1").Scan(&actor, &ctype, &body); err != nil {
		t.Fatal(err)
	}
	if actor != string(contracts.ActorHuman) || ctype != "request_changes" || body != "bound the retry loop" {
		t.Fatalf("rejection comment = %q %q %q", actor, ctype, body)
	}
}

func TestReadyRejectsWhitespaceOnlyVerification(t *testing.T) {
	e := newEngine(t)
	if err := e.CreateTask(Task{ID: "T1", Project: "p", Title: "task", Criteria: []string{"c"}, Verification: " \t\n "}); err != nil {
		t.Fatal(err)
	}
	if err := e.MarkReady("T1", contracts.ActorHuman); err != ErrNotReadyCriteria {
		t.Fatalf("MarkReady whitespace verification = %v", err)
	}
	if err := e.HumanTransition("T1", contracts.StateReady, ""); err != ErrNotReadyCriteria {
		t.Fatalf("HumanTransition whitespace verification = %v", err)
	}
}

func TestCancellingInProgressTaskDropsLeases(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneQuick, "/tmp/cancel-lease")
	if _, err := e.ClaimTask("T1", "agent", contracts.StateReady); err != nil {
		t.Fatal(err)
	}
	if err := e.HumanTransition("T1", contracts.StateCancelled, "cancelled"); err != nil {
		t.Fatal(err)
	}
	assertNoTaskLeases(t, e, "T1")
}

func TestArchivingInProgressTaskDropsLeases(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneQuick, "/tmp/archive-lease")
	if _, err := e.ClaimTask("T1", "agent", contracts.StateReady); err != nil {
		t.Fatal(err)
	}
	if err := e.ArchiveTask("T1"); err != nil {
		t.Fatal(err)
	}
	assertNoTaskLeases(t, e, "T1")
}

func assertNoTaskLeases(t *testing.T, e *Engine, taskID string) {
	t.Helper()
	for _, table := range []string{"leases", "repo_leases"} {
		var count int
		if err := e.DB().QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE task_id = ?`, taskID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s retained %d lease rows for %s", table, count, taskID)
		}
	}
}

// Auto QA failure routes to Changes Requested and never to User Approval.
func TestQAFailureBlocksApproval(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")
	c, _ := e.ClaimTask("T1", "agent-a", contracts.StateReady)
	sub, _ := e.SubmitForReview("T1", c.FencingToken, "base", "head", "s")
	e.RecordReview("T1", sub, "completion", contracts.ResultPass, "det", "[]")
	if err := e.RecordReview("T1", sub, "qa", contracts.ResultFail, "det", "[]"); err != nil {
		t.Fatal(err)
	}
	task, _ := e.GetTask("T1")
	if task.State != contracts.StateChangesRequested {
		t.Fatalf("expected Changes Requested after QA failure, got %s", task.State)
	}
	if _, _, err := e.PendingApproval("T1"); err == nil {
		t.Fatal("a pending approval was created despite QA failure")
	}
}

// The transition table itself must contain no agent path into Done.
func TestNoAgentTransitionIntoDone(t *testing.T) {
	for _, tr := range contracts.Transitions {
		if tr.To == contracts.StateDone && tr.Actor != contracts.ActorHuman {
			t.Fatalf("non-human transition into Done: %+v", tr)
		}
	}
	if contracts.Allowed(contracts.StateUserApproval, contracts.StateDone, contracts.ActorAgent) {
		t.Fatal("agent is allowed to transition into Done")
	}
	if contracts.Allowed(contracts.StateUserApproval, contracts.StateDone, contracts.ActorSystem) {
		t.Fatal("system is allowed to transition into Done")
	}
}

// The review-cycle cap stops runaway implement/review loops.
func TestReviewCycleCap(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")
	for i := 0; i < contracts.MaxAutoReviewCycles; i++ {
		expected := contracts.StateReady
		if i > 0 {
			expected = contracts.StateChangesRequested
		}
		c, err := e.ClaimTask("T1", "agent-a", expected)
		if err != nil {
			t.Fatalf("cycle %d claim: %v", i, err)
		}
		sub, err := e.SubmitForReview("T1", c.FencingToken, "base", "head"+string(rune('a'+i)), "s")
		if err != nil {
			t.Fatalf("cycle %d submit: %v", i, err)
		}
		if err := e.RecordReview("T1", sub, "completion", contracts.ResultFail, "det", "[]"); err != nil {
			t.Fatalf("cycle %d review: %v", i, err)
		}
	}
	c, err := e.ClaimTask("T1", "agent-a", contracts.StateChangesRequested)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SubmitForReview("T1", c.FencingToken, "base", "headZ", "s"); err != ErrCycleLimit {
		t.Fatalf("expected ErrCycleLimit after %d cycles, got %v", contracts.MaxAutoReviewCycles, err)
	}
}

func TestCreateTaskStoresPlanningMetadata(t *testing.T) {
	e := newEngine(t)
	task := Task{
		ID: "T1", Project: "p", Title: "planned", Priority: PriorityUrgent,
		Assignee: "divyansh", Labels: []string{"control-center", "migration"},
		DueDate: "2026-08-15", Position: 7,
	}

	if err := e.CreateTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := e.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Priority != PriorityUrgent || got.Assignee != "divyansh" || !reflect.DeepEqual(got.Labels, []string{"control-center", "migration"}) || got.DueDate != "2026-08-15" || got.Position != 7 || got.ArchivedAt != "" {
		t.Fatalf("planning metadata = %+v", got)
	}
	if got.CreatedAt == "" || got.UpdatedAt == "" {
		t.Fatalf("timestamps = %q, %q", got.CreatedAt, got.UpdatedAt)
	}
}

func TestListTasksOmitsArchivedAndOrdersPlanningPosition(t *testing.T) {
	e := newEngine(t)
	for _, id := range []string{"draft-late", "ready", "draft-early", "archived"} {
		if err := e.CreateTask(Task{ID: id, Project: "p", Title: id, Criteria: []string{"c"}, Verification: "v"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.DB().Exec(`UPDATE tasks SET state = CASE id
		WHEN 'ready' THEN 'ready' WHEN 'archived' THEN 'ready' ELSE 'draft' END,
		position = CASE id WHEN 'draft-late' THEN 9 WHEN 'draft-early' THEN 1 ELSE 0 END,
		archived_at = CASE WHEN id = 'archived' THEN '2026-08-12T00:00:00Z' ELSE '' END`); err != nil {
		t.Fatal(err)
	}

	all, err := e.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := taskIDs(all), []string{"draft-early", "draft-late", "ready"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ListAll() = %v, want %v", got, want)
	}
	ready, err := e.ListReady(contracts.TargetAny)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := taskIDs(ready), []string{"ready"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ListReady() = %v, want %v", got, want)
	}
}

func TestListTasksBreakOrderingTiesByID(t *testing.T) {
	e := newEngine(t)
	e.SetClock(func() time.Time { return time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC) })
	for _, id := range []string{"z-task", "a-task"} {
		if err := e.CreateTask(Task{ID: id, Project: "p", Title: id, Criteria: []string{"c"}, Verification: "v"}); err != nil {
			t.Fatal(err)
		}
		if err := e.MarkReady(id, contracts.ActorHuman); err != nil {
			t.Fatal(err)
		}
	}

	all, err := e.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := taskIDs(all), []string{"a-task", "z-task"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ListAll() = %v, want %v", got, want)
	}
	ready, err := e.ListReady(contracts.TargetAny)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := taskIDs(ready), []string{"a-task", "z-task"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ListReady() = %v, want %v", got, want)
	}
}

func taskIDs(tasks []Task) []string {
	ids := make([]string, len(tasks))
	for i, task := range tasks {
		ids[i] = task.ID
	}
	return ids
}

func updateFor(t *Task) TaskUpdate {
	return TaskUpdate{
		Title: t.Title, Objective: t.Objective, Verification: t.Verification,
		Lane: t.Lane, Isolation: t.Isolation, Target: t.Target,
		Priority: t.Priority, Assignee: t.Assignee, DueDate: t.DueDate,
		Criteria: t.Criteria, Labels: t.Labels,
	}
}

func TestUpdateTaskAllowsDraftEditsAndValidatesPlanningFields(t *testing.T) {
	e := newEngine(t)
	if err := e.CreateTask(Task{ID: "T1", Project: "p", Title: "draft"}); err != nil {
		t.Fatal(err)
	}
	u := TaskUpdate{
		Title: "edited", Objective: "ship safely", Verification: "go test ./...",
		Lane: contracts.LaneMajor, Isolation: contracts.IsolationWorktree, Target: contracts.TargetCodex,
		Priority: PriorityUrgent, Assignee: "divyansh", DueDate: "2026-08-20",
		Criteria: []string{"covered"}, Labels: []string{"control-center", "urgent"},
	}
	if err := e.UpdateTask("T1", u); err != nil {
		t.Fatalf("update draft: %v", err)
	}
	got, err := e.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != u.Title || got.Objective != u.Objective || got.Verification != u.Verification || got.Lane != u.Lane || got.Isolation != u.Isolation || got.Target != u.Target || got.Priority != u.Priority || got.Assignee != u.Assignee || got.DueDate != u.DueDate || !reflect.DeepEqual(got.Criteria, u.Criteria) || !reflect.DeepEqual(got.Labels, u.Labels) {
		t.Fatalf("updated task = %+v", got)
	}
	for _, bad := range []TaskUpdate{
		{Title: "", Priority: PriorityMedium},
		{Title: "ok", Priority: "now"},
		{Title: "ok", Priority: PriorityMedium, DueDate: "20-08-2026"},
		{Title: "ok", Priority: PriorityMedium, Labels: []string{"same", "same"}},
		{Title: "ok", Priority: PriorityMedium, Labels: []string{""}},
	} {
		if err := e.UpdateTask("T1", bad); err == nil {
			t.Fatalf("invalid update accepted: %+v", bad)
		}
	}
}

func TestUpdateTaskFreezesProtectedFieldsAfterSubmission(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")
	c, err := e.ClaimTask("T1", "agent", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SubmitForReview("T1", c.FencingToken, "base", "head", "summary"); err != nil {
		t.Fatal(err)
	}
	before, err := e.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	frozen := updateFor(before)
	frozen.Title = "rewritten"
	if err := e.UpdateTask("T1", frozen); err == nil {
		t.Fatal("post-submission title edit was accepted")
	}
	planning := updateFor(before)
	planning.Priority = PriorityHigh
	planning.Assignee = "owner"
	planning.DueDate = "2026-08-21"
	planning.Labels = []string{"review"}
	if err := e.UpdateTask("T1", planning); err != nil {
		t.Fatalf("planning update: %v", err)
	}
	got, _ := e.GetTask("T1")
	if got.Priority != PriorityHigh || got.Assignee != "owner" || got.DueDate != "2026-08-21" || !reflect.DeepEqual(got.Labels, []string{"review"}) {
		t.Fatalf("planning metadata not updated: %+v", got)
	}
}

func TestUpdateTaskAllowsProtectedEditsBeforeSubmission(t *testing.T) {
	e := newEngine(t)
	readyTask(t, e, "T1", contracts.LaneStandard, "")
	before, err := e.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	update := updateFor(before)
	update.Title = "renamed before claim"
	update.Criteria = []string{"new criterion"}
	if err := e.UpdateTask("T1", update); err != nil {
		t.Fatalf("pre-submission protected edit: %v", err)
	}
}

func TestSetDependenciesRejectsMissingSelfAndCyclesAndRetrievesStably(t *testing.T) {
	e := newEngine(t)
	for _, id := range []string{"A", "B", "C"} {
		if err := e.CreateTask(Task{ID: id, Project: "p", Title: id}); err != nil {
			t.Fatal(err)
		}
	}
	for _, deps := range [][]string{{"missing"}, {"A"}} {
		if err := e.SetDependencies("A", deps); err == nil {
			t.Fatalf("invalid dependencies accepted: %v", deps)
		}
	}
	if err := e.SetDependencies("A", []string{"C", "B"}); err != nil {
		t.Fatal(err)
	}
	if got, err := e.Dependencies("A"); err != nil || !reflect.DeepEqual(got, []string{"B", "C"}) {
		t.Fatalf("Dependencies() = %v, %v", got, err)
	}
	if err := e.SetDependencies("B", []string{"A"}); err == nil {
		t.Fatal("dependency cycle was accepted")
	}
	if got, err := e.Dependencies("B"); err != nil || len(got) != 0 {
		t.Fatalf("failed dependency update was not atomic: %v, %v", got, err)
	}
}

func TestReorderIsStableAndRequiresExactlyOneStateColumn(t *testing.T) {
	e := newEngine(t)
	for _, id := range []string{"A", "B", "C"} {
		if err := e.CreateTask(Task{ID: id, Project: "p", Title: id}); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.CreateTask(Task{ID: "R", Project: "p", Title: "R", Criteria: []string{"c"}, Verification: "v"}); err != nil {
		t.Fatal(err)
	}
	if err := e.MarkReady("R", contracts.ActorHuman); err != nil {
		t.Fatal(err)
	}
	if err := e.Reorder(contracts.StateDraft, []string{"C", "A", "B"}); err != nil {
		t.Fatal(err)
	}
	all, err := e.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := taskIDs(all)[:3], []string{"C", "A", "B"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("draft order = %v, want %v", got, want)
	}
	for _, ids := range [][]string{{"A", "A", "B"}, {"A", "B"}, {"A", "B", "R"}} {
		if err := e.Reorder(contracts.StateDraft, ids); err == nil {
			t.Fatalf("invalid reorder accepted: %v", ids)
		}
	}
}

func TestHumanBoardTransitionUsesContractsAndRequiresRequestChangesReason(t *testing.T) {
	e := newEngine(t)
	if err := e.CreateTask(Task{ID: "T1", Project: "p", Title: "bare"}); err != nil {
		t.Fatal(err)
	}
	if err := e.HumanTransition("T1", contracts.StateReady, ""); err == nil {
		t.Fatal("ready accepted without criteria and verification")
	}
	draft, err := e.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	update := updateFor(draft)
	update.Title = "ready"
	update.Criteria = []string{"c"}
	update.Verification = "v"
	if err := e.UpdateTask("T1", update); err != nil {
		t.Fatal(err)
	}
	if err := e.HumanTransition("T1", contracts.StateReady, ""); err != nil {
		t.Fatal(err)
	}
	if err := e.HumanTransition("T1", contracts.StateDone, "drag"); err == nil {
		t.Fatal("board move directly to Done was accepted")
	}

	readyTask(t, e, "A", contracts.LaneStandard, "")
	c, err := e.ClaimTask("A", "agent", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := e.SubmitForReview("A", c.FencingToken, "base", "head", "summary")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.RecordReview("A", sub, "completion", contracts.ResultPass, "test", "[]"); err != nil {
		t.Fatal(err)
	}
	if err := e.RecordReview("A", sub, "qa", contracts.ResultPass, "test", "[]"); err != nil {
		t.Fatal(err)
	}
	if err := e.HumanTransition("A", contracts.StateDone, "approve"); err == nil {
		t.Fatal("approval board move directly to Done was accepted")
	}
	if err := e.HumanTransition("A", contracts.StateChangesRequested, ""); err == nil {
		t.Fatal("request changes without reason was accepted")
	}
	if err := e.HumanTransition("A", contracts.StateChangesRequested, "add coverage"); err != nil {
		t.Fatal(err)
	}
	var body string
	if err := e.DB().QueryRow(`SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1`, "A").Scan(&body); err != nil || body != "add coverage" {
		t.Fatalf("request-changes reason = %q, %v", body, err)
	}
}

func TestArchiveTaskKeepsProtectedHistory(t *testing.T) {
	e := newEngine(t)
	if err := e.CreateTask(Task{ID: "T1", Project: "p", Title: "cancel me"}); err != nil {
		t.Fatal(err)
	}
	if err := e.HumanTransition("T1", contracts.StateCancelled, "cancelled"); err != nil {
		t.Fatal(err)
	}
	if err := e.AddComment("T1", "human", "note", "keep this"); err != nil {
		t.Fatal(err)
	}
	if err := e.ArchiveTask("T1"); err != nil {
		t.Fatal(err)
	}
	got, err := e.GetTask("T1")
	if err != nil || got.State != contracts.StateCancelled || got.ArchivedAt == "" {
		t.Fatalf("archived task = %+v, %v", got, err)
	}
	var comments int
	if err := e.DB().QueryRow(`SELECT COUNT(*) FROM comments WHERE task_id = ?`, "T1").Scan(&comments); err != nil || comments != 1 {
		t.Fatalf("protected history was deleted: comments=%d, err=%v", comments, err)
	}
	all, err := e.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Fatalf("archived task listed: %v", taskIDs(all))
	}
}
