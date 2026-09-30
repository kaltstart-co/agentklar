// Package completion composes recorded task evidence without judging delivery.
package completion

import (
	"database/sql"
	"errors"
	"time"
	"unicode/utf8"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/runs"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

const sectionLimit = 5
const excerptBudget = 3500

type Packet struct {
	textRemaining             int
	ObservedAt                string      `json:"observed_at"`
	Task                      Task        `json:"task"`
	Submission                *Submission `json:"submission"`
	Checks                    []Check     `json:"checks"`
	Reviews                   []Review    `json:"reviews"`
	RecordedRemainingWork     []Note      `json:"recorded_remaining_work"`
	NativeRunsStatus          string      `json:"native_runs_status"`
	NativeRuns                []NativeRun `json:"native_runs"`
	Context                   Context     `json:"context"`
	OmittedHistoricalEvidence int         `json:"omitted_historical_evidence"`
	Truncated                 []string    `json:"truncated"`
	Limits                    []string    `json:"limits"`
}

type Task struct {
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	State         contracts.State `json:"state"`
	HumanApproved bool            `json:"human_approved"`
	Objective     string          `json:"objective"`
	Criteria      []string        `json:"criteria"`
	Verification  string          `json:"verification"`
	UpdatedAt     string          `json:"updated_at"`
}

type Submission struct {
	ID                 int64  `json:"id"`
	RecordedBaseCommit string `json:"recorded_base_commit"`
	RecordedHeadCommit string `json:"recorded_head_commit"`
	Summary            string `json:"recorded_summary"`
}

type Check struct {
	ID               int64  `json:"id"`
	SubmissionID     *int64 `json:"submission_id"`
	Provenance       string `json:"provenance"`
	RevisionScope    string `json:"revision_scope"`
	Criterion        string `json:"criterion"`
	Command          string `json:"command"`
	WorkDir          string `json:"workdir"`
	RecordedExitCode *int   `json:"recorded_exit_code"`
	LogPath          string `json:"log_path"`
	ArtifactHash     string `json:"artifact_hash"`
	RecordedCommit   string `json:"recorded_commit"`
	Note             string `json:"note"`
	RecordedAt       string `json:"recorded_at"`
}

type Review struct {
	ID               int64  `json:"id"`
	SubmissionID     int64  `json:"submission_id"`
	Kind             string `json:"kind"`
	RecordedResult   string `json:"recorded_result"`
	Provider         string `json:"provider"`
	RecordedFindings string `json:"recorded_findings"`
	RecordedAt       string `json:"recorded_at"`
}

type Note struct {
	ID         int64  `json:"id"`
	Actor      string `json:"actor"`
	Type       string `json:"type"`
	Body       string `json:"body"`
	RecordedAt string `json:"recorded_at"`
}

type NativeRun struct {
	ID               string `json:"id"`
	Harness          string `json:"harness"`
	Model            string `json:"model"`
	Purpose          string `json:"purpose"`
	Status           string `json:"execution_status"`
	ThreadID         string `json:"thread_id"`
	TurnID           string `json:"turn_id"`
	UpdatedAt        string `json:"updated_at"`
	WorkerReport     string `json:"worker_report"`
	ExecutionError   string `json:"execution_error"`
	ReportProvenance string `json:"report_provenance"`
}

type Context struct {
	Status          string        `json:"status"`
	LastReindexedAt string        `json:"last_reindexed_at"`
	Items           []ContextItem `json:"items"`
}

type ContextItem struct {
	Source  akctx.Source `json:"source"`
	Ref     string       `json:"ref"`
	Title   string       `json:"title"`
	Excerpt string       `json:"excerpt"`
}

// Build reads existing records. It does not launch workers, run checks, inspect
// git, reindex context, or acquire approval capabilities.
func Build(engine *workflow.Engine, contextStore *akctx.Store, taskID string) (Packet, error) {
	task, err := engine.GetTask(taskID)
	if err != nil {
		return Packet{}, err
	}
	p := Packet{
		textRemaining: excerptBudget,
		ObservedAt:    time.Now().UTC().Format(time.RFC3339Nano),
		Checks:        []Check{}, Reviews: []Review{}, RecordedRemainingWork: []Note{}, NativeRuns: []NativeRun{}, Truncated: []string{},
		Context: Context{Status: "unavailable", Items: []ContextItem{}},
		Limits: []string{
			"Worker completion is execution status; only the protected task state records human-approved Done.",
			"Commit references, review findings and notes are recorded claims. No git diff, log hash or check is reverified here.",
			"Worker reports are unverified prose, not check, finding or commit evidence. Exit codes retain recorded provenance; no overall passing result is inferred.",
			"Reviews and submission-linked checks cover the newest non-stale submission. Unsubmitted evidence is labeled separately.",
			"Remaining-work notes and review findings may already be resolved; resolution is unknown.",
			"Sources are read separately and may change during retrieval. Context is a derived index, not current code authority.",
			"Each section keeps at most five records; excerpts share a 3500-byte budget. Use record IDs with task show/get_task/get_run for details.",
		},
	}
	p.Task = Task{ID: task.ID, Title: p.text("task", task.Title, 200), State: task.State,
		HumanApproved: task.State == contracts.StateDone, Objective: p.text("task", task.Objective, 400),
		Criteria: []string{}, Verification: p.text("task", task.Verification, 300), UpdatedAt: task.UpdatedAt}
	for i, criterion := range task.Criteria {
		if i == sectionLimit {
			p.truncate("task.criteria")
			break
		}
		p.Task.Criteria = append(p.Task.Criteria, p.text("task.criteria", criterion, 200))
	}
	sub, err := engine.LatestSubmission(taskID)
	if err != nil && !errors.Is(err, workflow.ErrNotFound) {
		return Packet{}, err
	}
	if sub != nil {
		p.Submission = &Submission{sub.ID, p.text("submission", sub.BaseCommit, 100), p.text("submission", sub.HeadCommit, 100), p.text("submission", sub.Summary, 400)}
	}
	evidence, err := engine.ListEvidence(taskID)
	if err != nil {
		return Packet{}, err
	}
	for i := len(evidence) - 1; i >= 0; i-- {
		ev := evidence[i]
		if ev.SubmissionID != nil && (sub == nil || *ev.SubmissionID != sub.ID) {
			p.OmittedHistoricalEvidence++
			continue
		}
		if len(p.Checks) == sectionLimit {
			p.truncate("checks")
			continue
		}
		scope := "unsubmitted"
		if ev.SubmissionID != nil {
			scope = "submission_linked_revision_unknown"
			if ev.CommitHash != "" {
				scope = "different_recorded_commit"
				if ev.CommitHash == sub.HeadCommit {
					scope = "submission_head"
				}
			}
		}
		p.Checks = append(p.Checks, Check{
			ID: ev.ID, SubmissionID: ev.SubmissionID, Provenance: ev.Provenance, RevisionScope: scope,
			Criterion: p.text("checks", ev.Criterion, 200), Command: p.text("checks", ev.Command, 200),
			WorkDir: p.text("checks", ev.WorkDir, 200), RecordedExitCode: ev.ExitCode,
			LogPath: p.text("checks", ev.LogPath, 200), ArtifactHash: p.text("checks", ev.Hash, 100),
			RecordedCommit: p.text("checks", ev.CommitHash, 100), Note: p.text("checks", ev.Note, 200), RecordedAt: ev.CreatedAt,
		})
	}
	if sub != nil {
		if err := p.readReviews(engine.DB(), taskID, sub.ID); err != nil {
			return Packet{}, err
		}
	}
	if err := p.readNotes(engine.DB(), taskID); err != nil {
		return Packet{}, err
	}
	var nativeTable int
	if err := engine.DB().QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_runs'`).Scan(&nativeTable); err != nil {
		return Packet{}, err
	}
	p.NativeRunsStatus = "unavailable"
	if nativeTable == 1 {
		registered, err := (&runs.Store{DB: engine.DB()}).ListTask(taskID, sectionLimit+1)
		if err != nil {
			return Packet{}, err
		}
		p.NativeRunsStatus = "recorded"
		for i, r := range registered {
			if i == sectionLimit {
				p.truncate("native_runs")
				break
			}
			p.NativeRuns = append(p.NativeRuns, NativeRun{
				ID: r.ID, Harness: r.Harness, Model: p.text("native_runs", r.Model, 100), Purpose: r.Purpose,
				Status: r.Status, ThreadID: r.ThreadID, TurnID: r.TurnID, UpdatedAt: r.UpdatedAt,
				WorkerReport: p.text("native_runs.worker_report", r.Result, 500), ExecutionError: p.text("native_runs.execution_error", r.Error, 240),
				ReportProvenance: "native_worker_report",
			})
		}
	}
	if contextStore != nil {
		docs, err := contextStore.TaskDocs(taskID, 6)
		if err != nil {
			return Packet{}, err
		}
		p.Context.LastReindexedAt, err = contextStore.LastReindexedAt()
		if err != nil {
			return Packet{}, err
		}
		p.Context.Status = "derived_index"
		for i, d := range docs {
			if i == 5 {
				p.truncate("context")
				break
			}
			p.Context.Items = append(p.Context.Items, ContextItem{d.Source, p.text("context", d.Ref, 200), p.text("context", d.Title, 200), p.text("context", d.Body, 320)})
		}
	}
	return p, nil
}

func (p *Packet) readReviews(db *sql.DB, taskID string, submissionID int64) error {
	rows, err := db.Query(`SELECT id,submission_id,kind,result,provider,findings,created_at FROM reviews WHERE task_id=? AND submission_id=? ORDER BY id DESC LIMIT ?`, taskID, submissionID, sectionLimit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if len(p.Reviews) == sectionLimit {
			p.truncate("reviews")
			break
		}
		var r Review
		if err := rows.Scan(&r.ID, &r.SubmissionID, &r.Kind, &r.RecordedResult, &r.Provider, &r.RecordedFindings, &r.RecordedAt); err != nil {
			return err
		}
		r.RecordedFindings = p.text("reviews", r.RecordedFindings, 400)
		r.Provider = p.text("reviews", r.Provider, 100)
		p.Reviews = append(p.Reviews, r)
	}
	return rows.Err()
}

func (p *Packet) readNotes(db *sql.DB, taskID string) error {
	rows, err := db.Query(`SELECT id,actor,ctype,body,created_at FROM comments WHERE task_id=? AND ctype IN ('request_changes','Change Request','handoff','open_question','remaining_work') ORDER BY id DESC LIMIT ?`, taskID, sectionLimit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if len(p.RecordedRemainingWork) == sectionLimit {
			p.truncate("recorded_remaining_work")
			break
		}
		var n Note
		if err := rows.Scan(&n.ID, &n.Actor, &n.Type, &n.Body, &n.RecordedAt); err != nil {
			return err
		}
		n.Body = p.text("recorded_remaining_work", n.Body, 400)
		n.Actor = p.text("recorded_remaining_work", n.Actor, 40)
		p.RecordedRemainingWork = append(p.RecordedRemainingWork, n)
	}
	return rows.Err()
}

func (p *Packet) truncate(section string) {
	for _, existing := range p.Truncated {
		if existing == section {
			return
		}
	}
	p.Truncated = append(p.Truncated, section)
}

func (p *Packet) text(section, text string, limit int) string {
	if limit > p.textRemaining {
		limit = p.textRemaining
	}
	if len(text) > limit {
		p.truncate(section)
		for limit > 0 && !utf8.RuneStart(text[limit]) {
			limit--
		}
		text = text[:limit]
	}
	p.textRemaining -= len(text)
	return text
}
