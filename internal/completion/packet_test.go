package completion

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/runs"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func fixture(t *testing.T) (*workflow.Engine, *workflow.Claim, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := workflow.New(db)
	err = e.CreateTask(workflow.Task{ID: "T", Title: "numeric addition", RepoPath: dir, Lane: contracts.LaneQuick,
		Criteria: []string{"numbers add"}, Verification: "declared recipe"})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.MarkReady("T", contracts.ActorHuman); err != nil {
		t.Fatal(err)
	}
	claim, err := e.ClaimTask("T", "host", contracts.StateReady)
	if err != nil {
		t.Fatal(err)
	}
	return e, claim, dir
}

func TestCompletedWorkerIsNotApprovedDelivery(t *testing.T) {
	e, claim, repo := fixture(t)
	st, err := runs.NewStore(e.DB())
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = st.Insert(runs.Start{ID: "native", TaskID: "T", Holder: "host", FencingToken: claim.FencingToken,
		Harness: "codex", Model: "fixture", Purpose: "implement", Prompt: "tiny task"}, repo)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.Update("native", "completed", "thread", "turn", "ALL TESTS PASS; changed invented.js; commit fake123", ""); err != nil {
		t.Fatal(err)
	}
	p, err := Build(e, nil, "T")
	if err != nil {
		t.Fatal(err)
	}
	if p.Task.State != contracts.StateInProgress || p.Task.HumanApproved || p.Submission != nil || len(p.Checks) != 0 || len(p.Reviews) != 0 {
		t.Fatalf("worker prose became delivery evidence: %#v", p)
	}
	if len(p.NativeRuns) != 1 || p.NativeRuns[0].Status != "completed" {
		t.Fatalf("run missing: %#v", p.NativeRuns)
	}
	if p.NativeRuns[0].WorkerReport != "ALL TESTS PASS; changed invented.js; commit fake123" || p.NativeRuns[0].ReportProvenance != "native_worker_report" {
		t.Fatal("unverified handoff report missing")
	}
	b, _ := json.Marshal(p)
	for _, invented := range []string{"tiny task", "fencing_token", "pending_request"} {
		if strings.Contains(string(b), invented) {
			t.Fatalf("packet leaked or inferred %q", invented)
		}
	}
	if _, err = Build(e, nil, "missing"); !errors.Is(err, workflow.ErrNotFound) {
		t.Fatalf("missing task: %v", err)
	}
}

func TestRecordedEvidenceRevisionAndHumanBoundary(t *testing.T) {
	e, claim, _ := fixture(t)
	first, err := e.SubmitForReview("T", claim.FencingToken, "base-old", "head-old", "old report")
	if err != nil {
		t.Fatal(err)
	}
	zero := 0
	if err = e.AddEvidence("T", first, contracts.MachineAttested, "old-check", "old-command", "old-dir", &zero, "old-log", "old-hash", "head-old", ""); err != nil {
		t.Fatal(err)
	}
	if err = e.RecordReview("T", first, "completion", contracts.ResultFail, "reviewer", `["fix numbers"]`); err != nil {
		t.Fatal(err)
	}
	claim, err = e.ClaimTask("T", "host", contracts.StateChangesRequested)
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.SubmitForReview("T", claim.FencingToken, "base-current", "head-current", "recorded current summary")
	if err != nil {
		t.Fatal(err)
	}
	if err = e.AddEvidence("T", second, contracts.AgentReported, "reported-check", "claimed-command", "workdir", &zero, "recorded-log", "recorded-hash", "wrong-head", "claimed exit zero"); err != nil {
		t.Fatal(err)
	}
	if err = e.AddEvidence("T", second, contracts.MachineAttested, "actual-check", "actual-command", "workdir", &zero, "actual-log", "actual-hash", "head-current", ""); err != nil {
		t.Fatal(err)
	}
	if err = e.AddComment("T", "human", "open_question", "confirm browser behavior"); err != nil {
		t.Fatal(err)
	}
	if err = e.AddComment("T", "agent", "note", "all finished"); err != nil {
		t.Fatal(err)
	}
	if err = e.RecordReview("T", second, "completion", contracts.ResultPass, "reviewer", `["recorded finding"]`); err != nil {
		t.Fatal(err)
	}
	if err = e.RecordReview("T", second, "qa", contracts.ResultPass, "qa-provider", `[]`); err != nil {
		t.Fatal(err)
	}
	p, err := Build(e, nil, "T")
	if err != nil {
		t.Fatal(err)
	}
	if p.Task.State != contracts.StateUserApproval || p.Task.HumanApproved || p.Submission.ID != second || p.Submission.RecordedHeadCommit != "head-current" {
		t.Fatalf("incorrect approval/revision: %#v", p)
	}
	if p.OmittedHistoricalEvidence != 1 || len(p.Checks) != 2 || p.Checks[0].RevisionScope != "submission_head" || p.Checks[1].RevisionScope != "different_recorded_commit" || p.Checks[1].Provenance != string(contracts.AgentReported) {
		t.Fatalf("evidence provenance/revision lost: %#v", p.Checks)
	}
	if len(p.Reviews) != 2 || p.Reviews[1].RecordedFindings != `["recorded finding"]` || len(p.RecordedRemainingWork) != 1 {
		t.Fatalf("source records missing: %#v", p)
	}
	nonce, _, err := e.PendingApproval("T")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), nonce) || strings.Contains(string(b), "nonce") || strings.Contains(string(b), "old-check") {
		t.Fatal("capability or old revision leaked")
	}
	if err = e.ResolveApproval("T", nonce, true, "human", "local_ui"); err != nil {
		t.Fatal(err)
	}
	p, err = Build(e, nil, "T")
	if err != nil || !p.Task.HumanApproved || p.Task.State != contracts.StateDone {
		t.Fatalf("human decision missing: %#v %v", p.Task, err)
	}
}

func TestTaskScopeTruncationAndUnavailableNativeStore(t *testing.T) {
	e, _, dir := fixture(t)
	p, err := Build(e, nil, "T")
	if err != nil || p.NativeRunsStatus != "unavailable" {
		t.Fatalf("absent native store claimed verified zero: %#v %v", p, err)
	}
	var count int
	if err = e.DB().QueryRow(`SELECT count(*) FROM sqlite_master WHERE name='native_runs'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("read created native schema")
	}
	if err = e.CreateTask(workflow.Task{ID: "other", Title: "other"}); err != nil {
		t.Fatal(err)
	}
	_, err = runs.NewStore(e.DB())
	if err != nil {
		t.Fatal(err)
	}
	// More than the global List limit exist after T's sole run.
	_, err = e.DB().Exec(`INSERT INTO native_runs(id,task_id,holder,fencing_token,request_hash,harness,model,purpose,read_only,prompt,status,created_at,updated_at) VALUES('older','T','host',1,'hash','codex','fixture','review',1,'prose','completed','2000','2000')`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 125; i++ {
		_, err = e.DB().Exec(`INSERT INTO native_runs(id,task_id,holder,fencing_token,request_hash,harness,model,purpose,read_only,prompt,status,created_at,updated_at) VALUES(?, 'other','host',1,'hash','codex','fixture','review',1,'prose','completed','2099','2099')`, i)
		if err != nil {
			t.Fatal(err)
		}
	}
	c, err := akctx.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	docs := []akctx.Doc{{Source: akctx.SourceMemory, Ref: "wrong-task", Title: "numeric addition", Body: "other task secret", TaskID: "other"}}
	for i := 0; i < 7; i++ {
		docs = append(docs, akctx.Doc{Source: akctx.SourceMemory, Ref: strings.Repeat("x", i+1), Body: strings.Repeat("é", 400), TaskID: "T"})
	}
	if _, err = c.Index(docs); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25; i++ {
		if err = e.AddComment("T", "human", "remaining_work", strings.Repeat("z", 2000)); err != nil {
			t.Fatal(err)
		}
	}
	p, err = Build(e, c, "T")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.NativeRuns) != 1 || p.NativeRuns[0].ID != "older" {
		t.Fatalf("task run hidden by global limit: %#v", p.NativeRuns)
	}
	if p.Context.Status != "derived_index" || p.Context.LastReindexedAt != "" || len(p.Context.Items) != 5 || !slices.Contains(p.Truncated, "context") || len(p.RecordedRemainingWork) != sectionLimit || !slices.Contains(p.Truncated, "recorded_remaining_work") {
		t.Fatalf("limits/freshness missing: %#v", p)
	}
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), "other task secret") {
		t.Fatal("cross-task context leaked")
	}
	if !utf8.ValidString(p.Context.Items[0].Excerpt) {
		t.Fatal("truncation split a UTF-8 character")
	}
	readContext, err := akctx.OpenReadOnly(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer readContext.Close()
	if _, err = Build(e, readContext, "T"); err != nil {
		t.Fatal(err)
	}
	if _, err = readContext.Index([]akctx.Doc{{Source: akctx.SourceMemory, Ref: "must-not-write", Body: "blocked"}}); err == nil {
		t.Fatal("read-only context permits writes")
	}
}

func TestRoutinePacketHasSharedTextBudget(t *testing.T) {
	e, claim, dir := fixture(t)
	sub, err := e.SubmitForReview("T", claim.FencingToken, "base", "head", "recorded summary")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = runs.NewStore(e.DB()); err != nil {
		t.Fatal(err)
	}
	c, err := akctx.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	large := strings.Repeat("recorded source text ", 500)
	zero := 0
	for i := 0; i < 7; i++ {
		if err = e.AddEvidence("T", sub, contracts.MachineAttested, large, large, "dir", &zero, "log", "hash", "head", large); err != nil {
			t.Fatal(err)
		}
		if _, err = e.DB().Exec(`INSERT INTO reviews(task_id,submission_id,kind,result,provider,findings,created_at) VALUES('T',?,'completion','pass','fixture',?,'recorded')`, sub, large); err != nil {
			t.Fatal(err)
		}
		if err = e.AddComment("T", "human", "remaining_work", large); err != nil {
			t.Fatal(err)
		}
		if _, err = e.DB().Exec(`INSERT INTO native_runs(id,task_id,holder,fencing_token,request_hash,harness,model,purpose,read_only,prompt,status,result,error,created_at,updated_at) VALUES(?,'T','host',1,'hash','codex','fixture','review',1,'prompt','completed',?,?,'recorded','recorded')`, i, large, large); err != nil {
			t.Fatal(err)
		}
		if _, err = c.Index([]akctx.Doc{{Source: akctx.SourceMemory, Ref: strings.Repeat("x", i+1), Body: large, TaskID: "T"}}); err != nil {
			t.Fatal(err)
		}
	}
	p, err := Build(e, c, "T")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > 12000 || p.textRemaining != 0 {
		t.Fatalf("packet not compact: %d bytes, remaining budget %d", len(b), p.textRemaining)
	}
	for _, section := range []string{"checks", "reviews", "recorded_remaining_work", "native_runs", "native_runs.worker_report", "native_runs.execution_error", "context"} {
		if !slices.Contains(p.Truncated, section) {
			t.Fatalf("missing truncation notice for %s", section)
		}
	}
	if len(p.Checks) != sectionLimit || p.Checks[0].ID == 0 || len(p.NativeRuns) != sectionLimit || p.NativeRuns[0].ID == "" || len(p.Reviews) != sectionLimit {
		t.Fatal("bounded sections lost stable drill-down IDs")
	}
}
