package workflow

import (
	"path/filepath"
	"sync"
	"testing"

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
