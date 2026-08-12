package workflow

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// Submission is a frozen commit range awaiting or undergoing review.
type Submission struct {
	ID         int64
	TaskID     string
	BaseCommit string
	HeadCommit string
	Summary    string
	Criteria   []string
	Stale      bool
}

// Evidence is one append-only evidence row with explicit provenance.
type Evidence struct {
	ID           int64
	SubmissionID *int64
	Provenance   string
	Criterion    string
	Command      string
	ExitCode     *int
	LogPath      string
	Hash         string
	Note         string
	CreatedAt    string
}

// ListAll returns every task in the workspace.
func (e *Engine) ListAll() ([]Task, error) {
	rows, err := e.db.Query(`SELECT ` + taskColumns + ` FROM tasks
		WHERE archived_at = '' ORDER BY state, position, created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// ListArchived returns hidden task history without changing active board
// listings. Archived rows remain fully addressable through GetTask.
func (e *Engine) ListArchived() ([]Task, error) {
	rows, err := e.db.Query(`SELECT ` + taskColumns + ` FROM tasks
		WHERE archived_at <> '' ORDER BY archived_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// Dependencies returns prerequisite task IDs in stable lexical order.
func (e *Engine) Dependencies(taskID string) ([]string, error) {
	var exists int
	if err := e.db.QueryRow(`SELECT 1 FROM tasks WHERE id = ?`, taskID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	rows, err := e.db.Query(`SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// LatestSubmission returns the newest non-stale submission for a task.
func (e *Engine) LatestSubmission(taskID string) (*Submission, error) {
	row := e.db.QueryRow(`SELECT id, task_id, base_commit, head_commit, summary, criteria_snapshot, stale
		FROM submissions WHERE task_id = ? AND stale = 0 ORDER BY id DESC LIMIT 1`, taskID)
	var s Submission
	var crit string
	var stale int
	err := row.Scan(&s.ID, &s.TaskID, &s.BaseCommit, &s.HeadCommit, &s.Summary, &crit, &stale)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(crit), &s.Criteria)
	s.Stale = stale == 1
	return &s, nil
}

// ListEvidence returns append-only evidence for a task, newest last.
func (e *Engine) ListEvidence(taskID string) ([]Evidence, error) {
	rows, err := e.db.Query(`SELECT id, submission_id, provenance, criterion, command, exit_code, log_path,
		artifact_hash, note, created_at FROM evidence WHERE task_id = ? ORDER BY id`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Evidence
	for rows.Next() {
		var ev Evidence
		if err := rows.Scan(&ev.ID, &ev.SubmissionID, &ev.Provenance, &ev.Criterion, &ev.Command, &ev.ExitCode,
			&ev.LogPath, &ev.Hash, &ev.Note, &ev.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

// DB exposes the underlying control database for diagnostics and tests.
func (e *Engine) DB() *sql.DB { return e.db }
