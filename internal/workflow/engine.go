// Package workflow implements the protected task state machine: atomic
// claims, expiring leases, fencing tokens, idempotent submissions,
// stale-commit invalidation, and the human-only Done boundary.
//
// Every state-changing method runs in a single transaction against
// control.sqlite. Agent-originated calls must present the task's current
// fencing token; a superseded token can never mutate protected state.
package workflow

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/kaltstart-co/agentklar/internal/contracts"
)

var (
	ErrNotFound         = errors.New("task not found")
	ErrWrongState       = errors.New("task not in expected state")
	ErrTransition       = errors.New("transition not allowed for actor")
	ErrLeaseHeld        = errors.New("task already claimed under an active lease")
	ErrStaleFencing     = errors.New("stale fencing token")
	ErrRepoBusy         = errors.New("repository has an active exclusive lease")
	ErrStaleCommit      = errors.New("submitted head commit is stale")
	ErrNonceInvalid     = errors.New("approval nonce invalid, expired, or already decided")
	ErrCycleLimit       = errors.New("automated review cycle limit reached; user action required")
	ErrNotReadyCriteria = errors.New("task lacks acceptance criteria or verification method")
)

type Engine struct {
	db  *sql.DB
	now func() time.Time
}

func New(db *sql.DB) *Engine { return &Engine{db: db, now: time.Now} }

// SetClock overrides time for tests.
func (e *Engine) SetClock(now func() time.Time) { e.now = now }

func (e *Engine) ts() string { return e.now().UTC().Format(time.RFC3339Nano) }

type Task struct {
	ID, Project, RepoPath, Title string
	Lane                         contracts.Lane
	Isolation                    contracts.Isolation
	Target                       contracts.ExecutionTarget
	State                        contracts.State
	Objective, Verification      string
	Criteria                     []string
	TrackerID                    string
	ReviewCycles                 int
}

type Claim struct {
	TaskID       string
	FencingToken int64
	ExpiresAt    time.Time
	// Worktree tells the agent which isolation was granted:
	// "primary" (exclusive repo lease) or "dedicated".
	Worktree string
}

// CreateTask inserts a Draft task.
func (e *Engine) CreateTask(t Task) error {
	if t.Lane == "" {
		t.Lane = contracts.LaneStandard
	}
	if t.Isolation == "" {
		t.Isolation = contracts.IsolationAuto
	}
	if t.Target == "" {
		t.Target = contracts.TargetAny
	}
	crit, _ := json.Marshal(t.Criteria)
	_, err := e.db.Exec(`INSERT INTO tasks
		(id, project, repo_path, title, lane, isolation, target, state, objective, criteria, verification, tracker_id, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.Project, t.RepoPath, t.Title, t.Lane, t.Isolation, t.Target,
		contracts.StateDraft, t.Objective, string(crit), t.Verification, t.TrackerID, e.ts(), e.ts())
	return err
}

func (e *Engine) GetTask(id string) (*Task, error) {
	row := e.db.QueryRow(`SELECT id, project, repo_path, title, lane, isolation, target, state,
		objective, criteria, verification, tracker_id, review_cycles FROM tasks WHERE id = ?`, id)
	var t Task
	var crit string
	err := row.Scan(&t.ID, &t.Project, &t.RepoPath, &t.Title, &t.Lane, &t.Isolation, &t.Target,
		&t.State, &t.Objective, &crit, &t.Verification, &t.TrackerID, &t.ReviewCycles)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(crit), &t.Criteria)
	return &t, nil
}

// MarkReady enforces Definition of Ready: no criteria, no Ready.
func (e *Engine) MarkReady(taskID string, actor contracts.Actor) error {
	return e.transition(taskID, contracts.StateDraft, contracts.StateReady, actor, func(tx *sql.Tx, t *Task) error {
		if len(t.Criteria) == 0 || t.Verification == "" {
			return ErrNotReadyCriteria
		}
		return nil
	})
}

// ListReady returns Ready tasks matching the execution target.
func (e *Engine) ListReady(target contracts.ExecutionTarget) ([]Task, error) {
	rows, err := e.db.Query(`SELECT id, project, repo_path, title, lane, isolation, target, state,
		objective, criteria, verification, tracker_id, review_cycles
		FROM tasks WHERE state = ? AND (target = ? OR target = 'any' OR ? = 'any')`,
		contracts.StateReady, target, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		var t Task
		var crit string
		if err := rows.Scan(&t.ID, &t.Project, &t.RepoPath, &t.Title, &t.Lane, &t.Isolation, &t.Target,
			&t.State, &t.Objective, &crit, &t.Verification, &t.TrackerID, &t.ReviewCycles); err != nil {
			return nil, err
		}
		json.Unmarshal([]byte(crit), &t.Criteria)
		out = append(out, t)
	}
	return out, rows.Err()
}

// ClaimTask atomically claims a Ready (or Changes Requested) task.
// Quick+auto tasks receive the primary worktree only when an exclusive
// repository lease is free; otherwise the claim grants a dedicated worktree.
func (e *Engine) ClaimTask(taskID, holder string, expected contracts.State) (*Claim, error) {
	tx, err := e.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	t, err := e.getForUpdate(tx, taskID)
	if err != nil {
		return nil, err
	}
	if t.State != expected {
		return nil, fmt.Errorf("%w: state=%s expected=%s", ErrWrongState, t.State, expected)
	}
	if !contracts.Allowed(t.State, contracts.StateInProgress, contracts.ActorAgent) {
		return nil, ErrTransition
	}

	now := e.now()
	// A lease only guards work in flight. Once the task has left In Progress
	// (submitted, reviewed, or returned as Changes Requested) any surviving
	// lease row is historical: the fencing counter still advances, so the old
	// holder is fenced out, but the task must be reclaimable.
	var expires string
	err = tx.QueryRow(`SELECT expires_at FROM leases WHERE task_id = ?`, taskID).Scan(&expires)
	if err == nil {
		exp, _ := time.Parse(time.RFC3339Nano, expires)
		if t.State == contracts.StateInProgress && now.Before(exp) {
			return nil, ErrLeaseHeld
		}
		if _, err := tx.Exec(`DELETE FROM leases WHERE task_id = ?`, taskID); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	// Repository isolation.
	worktree := "dedicated"
	if t.RepoPath != "" {
		var busyTask, busyExp string
		var exclusive int
		err = tx.QueryRow(`SELECT task_id, expires_at, exclusive FROM repo_leases WHERE repo_path = ?`, t.RepoPath).
			Scan(&busyTask, &busyExp, &exclusive)
		hasLease := err == nil
		if hasLease {
			exp, _ := time.Parse(time.RFC3339Nano, busyExp)
			if now.After(exp) {
				tx.Exec(`DELETE FROM repo_leases WHERE repo_path = ?`, t.RepoPath)
				hasLease = false
			}
		}
		if t.Lane == contracts.LaneQuick && t.Isolation == contracts.IsolationAuto && !hasLease {
			// Grant exclusive primary-worktree lease; all other code claims
			// on this repo are rejected while it lives.
			if _, err := tx.Exec(`INSERT INTO repo_leases (repo_path, task_id, exclusive, expires_at) VALUES (?,?,1,?)`,
				t.RepoPath, taskID, now.Add(contracts.DefaultLeaseTTL).UTC().Format(time.RFC3339Nano)); err != nil {
				return nil, err
			}
			worktree = "primary"
		} else if hasLease && exclusive == 1 {
			return nil, ErrRepoBusy
		}
		// Non-exclusive claims coexist: each gets a dedicated worktree.
	}
	if t.Isolation == contracts.IsolationNone {
		worktree = "none"
	}

	// Monotonic fencing token.
	if _, err := tx.Exec(`INSERT INTO fencing (task_id, counter) VALUES (?, 0)
		ON CONFLICT(task_id) DO NOTHING`, taskID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE fencing SET counter = counter + 1 WHERE task_id = ?`, taskID); err != nil {
		return nil, err
	}
	var token int64
	if err := tx.QueryRow(`SELECT counter FROM fencing WHERE task_id = ?`, taskID).Scan(&token); err != nil {
		return nil, err
	}

	expiry := now.Add(contracts.DefaultLeaseTTL)
	if _, err := tx.Exec(`INSERT INTO leases (task_id, holder, fencing_token, expires_at, heartbeat_at)
		VALUES (?,?,?,?,?)`, taskID, holder, token, expiry.UTC().Format(time.RFC3339Nano), e.ts()); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`,
		contracts.StateInProgress, e.ts(), taskID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Claim{TaskID: taskID, FencingToken: token, ExpiresAt: expiry, Worktree: worktree}, nil
}

// Heartbeat extends an active lease. A stale token is rejected.
func (e *Engine) Heartbeat(taskID string, token int64) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := e.checkFencing(tx, taskID, token); err != nil {
		return err
	}
	expiry := e.now().Add(contracts.DefaultLeaseTTL).UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(`UPDATE leases SET expires_at = ?, heartbeat_at = ? WHERE task_id = ?`,
		expiry, e.ts(), taskID); err != nil {
		return err
	}
	tx.Exec(`UPDATE repo_leases SET expires_at = ? WHERE task_id = ?`, expiry, taskID)
	return tx.Commit()
}

// SubmitForReview freezes the commit range and acceptance criteria, moves
// the task to Completion Review, and releases the repository lease.
// Idempotent per (taskID, headCommit) via idempotency keys.
func (e *Engine) SubmitForReview(taskID string, token int64, baseCommit, headCommit, summary string) (int64, error) {
	idemKey := fmt.Sprintf("submit:%s:%s", taskID, headCommit)
	tx, err := e.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var prior string
	if err := tx.QueryRow(`SELECT result FROM idempotency WHERE key = ?`, idemKey).Scan(&prior); err == nil {
		var subID int64
		fmt.Sscanf(prior, "%d", &subID)
		return subID, tx.Commit() // duplicate retry: return original submission
	}

	if err := e.checkFencing(tx, taskID, token); err != nil {
		return 0, err
	}
	t, err := e.getForUpdate(tx, taskID)
	if err != nil {
		return 0, err
	}
	if t.State != contracts.StateInProgress {
		return 0, fmt.Errorf("%w: state=%s", ErrWrongState, t.State)
	}
	if t.ReviewCycles >= contracts.MaxAutoReviewCycles {
		return 0, ErrCycleLimit
	}

	// Any earlier submission for this task becomes stale.
	if _, err := tx.Exec(`UPDATE submissions SET stale = 1 WHERE task_id = ?`, taskID); err != nil {
		return 0, err
	}
	crit, _ := json.Marshal(t.Criteria)
	res, err := tx.Exec(`INSERT INTO submissions (task_id, base_commit, head_commit, summary, criteria_snapshot, created_at)
		VALUES (?,?,?,?,?,?)`, taskID, baseCommit, headCommit, summary, string(crit), e.ts())
	if err != nil {
		return 0, err
	}
	subID, _ := res.LastInsertId()

	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`,
		contracts.StateCompletionReview, e.ts(), taskID); err != nil {
		return 0, err
	}
	// Free the exclusive repo lease; keep the task lease frozen for provenance.
	tx.Exec(`DELETE FROM repo_leases WHERE task_id = ?`, taskID)

	if _, err := tx.Exec(`INSERT INTO idempotency (key, result, created_at) VALUES (?,?,?)`,
		idemKey, fmt.Sprintf("%d", subID), e.ts()); err != nil {
		return 0, err
	}
	return subID, tx.Commit()
}

// RecordReview stores an append-only completion-review or QA result and
// advances the state machine as ActorSystem. kind: "completion" or "qa".
func (e *Engine) RecordReview(taskID string, submissionID int64, kind string, result contracts.ReviewResult, provider string, findingsJSON string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	t, err := e.getForUpdate(tx, taskID)
	if err != nil {
		return err
	}
	// Reject reviews against stale submissions.
	var stale int
	var head string
	if err := tx.QueryRow(`SELECT stale, head_commit FROM submissions WHERE id = ? AND task_id = ?`,
		submissionID, taskID).Scan(&stale, &head); err != nil {
		return fmt.Errorf("submission %d: %w", submissionID, ErrNotFound)
	}
	if stale == 1 {
		return ErrStaleCommit
	}
	if findingsJSON == "" {
		findingsJSON = "[]"
	}
	if _, err := tx.Exec(`INSERT INTO reviews (task_id, submission_id, kind, result, provider, findings, created_at)
		VALUES (?,?,?,?,?,?,?)`, taskID, submissionID, kind, result, provider, findingsJSON, e.ts()); err != nil {
		return err
	}

	var from, to contracts.State
	switch kind {
	case "completion":
		from = contracts.StateCompletionReview
		if result == contracts.ResultPass {
			to = contracts.StateAutoQA
		} else {
			to = contracts.StateChangesRequested
		}
	case "qa":
		from = contracts.StateAutoQA
		if result == contracts.ResultPass {
			to = contracts.StateUserApproval
		} else {
			to = contracts.StateChangesRequested
		}
	default:
		return fmt.Errorf("unknown review kind %q", kind)
	}
	if t.State != from {
		return fmt.Errorf("%w: state=%s expected=%s", ErrWrongState, t.State, from)
	}
	if !contracts.Allowed(from, to, contracts.ActorSystem) {
		return ErrTransition
	}
	if to == contracts.StateChangesRequested {
		if _, err := tx.Exec(`UPDATE tasks SET review_cycles = review_cycles + 1 WHERE id = ?`, taskID); err != nil {
			return err
		}
		// Release the frozen implementation lease so the revision can be
		// claimed. The fencing counter is untouched, so the previous holder
		// remains fenced out until it reclaims.
		if _, err := tx.Exec(`DELETE FROM leases WHERE task_id = ?`, taskID); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM repo_leases WHERE task_id = ?`, taskID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`, to, e.ts(), taskID); err != nil {
		return err
	}

	// Entering User Approval creates the pending nonce-bound approval request.
	if to == contracts.StateUserApproval {
		nonce, err := newNonce()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO approvals (task_id, submission_id, nonce, expires_at, created_at)
			VALUES (?,?,?,?,?)
			ON CONFLICT(task_id) DO UPDATE SET submission_id=excluded.submission_id,
				nonce=excluded.nonce, expires_at=excluded.expires_at,
				decided=0, decision='', decided_by='', channel='', created_at=excluded.created_at`,
			taskID, submissionID, nonce,
			e.now().Add(contracts.ApprovalNonceTTL).UTC().Format(time.RFC3339Nano), e.ts()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PendingApproval returns the nonce and submission for a task awaiting
// human approval, for surfacing through a trusted channel.
func (e *Engine) PendingApproval(taskID string) (nonce string, submissionID int64, err error) {
	err = e.db.QueryRow(`SELECT nonce, submission_id FROM approvals
		WHERE task_id = ? AND decided = 0`, taskID).Scan(&nonce, &submissionID)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// ResolveApproval performs the human-only Done / Changes Requested
// transition. It is reachable ONLY from trusted channels (tracker comment
// by a human account, or client elicitation) — never from the MCP surface.
// approvedBy records the human actor identity; channel records which
// trusted channel supplied the decision.
func (e *Engine) ResolveApproval(taskID, nonce string, approve bool, approvedBy, channel string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	t, err := e.getForUpdate(tx, taskID)
	if err != nil {
		return err
	}
	if t.State != contracts.StateUserApproval {
		return fmt.Errorf("%w: state=%s", ErrWrongState, t.State)
	}

	var storedNonce, expires string
	var subID int64
	var decided int
	if err := tx.QueryRow(`SELECT nonce, expires_at, submission_id, decided FROM approvals WHERE task_id = ?`,
		taskID).Scan(&storedNonce, &expires, &subID, &decided); err != nil {
		return ErrNonceInvalid
	}
	exp, _ := time.Parse(time.RFC3339Nano, expires)
	if decided == 1 || storedNonce != nonce || e.now().After(exp) {
		return ErrNonceInvalid
	}
	// The approved submission must still be the live head.
	var stale int
	if err := tx.QueryRow(`SELECT stale FROM submissions WHERE id = ?`, subID).Scan(&stale); err != nil || stale == 1 {
		return ErrStaleCommit
	}

	to := contracts.StateDone
	decision := "approved"
	if !approve {
		to = contracts.StateChangesRequested
		decision = "rejected"
	}
	if !contracts.Allowed(contracts.StateUserApproval, to, contracts.ActorHuman) {
		return ErrTransition
	}
	if _, err := tx.Exec(`UPDATE approvals SET decided = 1, decision = ?, decided_by = ?, channel = ? WHERE task_id = ?`,
		decision, approvedBy, channel, taskID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`, to, e.ts(), taskID); err != nil {
		return err
	}
	return tx.Commit()
}

// ReleaseTask returns an In Progress task to Ready and drops its leases.
func (e *Engine) ReleaseTask(taskID string, token int64) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := e.checkFencing(tx, taskID, token); err != nil {
		return err
	}
	t, err := e.getForUpdate(tx, taskID)
	if err != nil {
		return err
	}
	if t.State != contracts.StateInProgress {
		return fmt.Errorf("%w: state=%s", ErrWrongState, t.State)
	}
	tx.Exec(`DELETE FROM leases WHERE task_id = ?`, taskID)
	tx.Exec(`DELETE FROM repo_leases WHERE task_id = ?`, taskID)
	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`,
		contracts.StateReady, e.ts(), taskID); err != nil {
		return err
	}
	return tx.Commit()
}

// AddEvidence appends evidence with explicit provenance.
func (e *Engine) AddEvidence(taskID string, submissionID int64, prov contracts.Provenance,
	criterion, command, workdir string, exitCode *int, logPath, artifactHash, commitHash, note string) error {
	var sub interface{}
	if submissionID > 0 {
		sub = submissionID
	}
	_, err := e.db.Exec(`INSERT INTO evidence
		(task_id, submission_id, provenance, criterion, command, workdir, exit_code, log_path, artifact_hash, commit_hash, note, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		taskID, sub, prov, criterion, command, workdir, exitCode, logPath, artifactHash, commitHash, note, e.ts())
	return err
}

// AddComment appends a timeline comment.
func (e *Engine) AddComment(taskID, actor, ctype, body string) error {
	_, err := e.db.Exec(`INSERT INTO comments (task_id, actor, ctype, body, created_at) VALUES (?,?,?,?,?)`,
		taskID, actor, ctype, body, e.ts())
	return err
}

// --- internals ---

func (e *Engine) getForUpdate(tx *sql.Tx, id string) (*Task, error) {
	row := tx.QueryRow(`SELECT id, project, repo_path, title, lane, isolation, target, state,
		objective, criteria, verification, tracker_id, review_cycles FROM tasks WHERE id = ?`, id)
	var t Task
	var crit string
	err := row.Scan(&t.ID, &t.Project, &t.RepoPath, &t.Title, &t.Lane, &t.Isolation, &t.Target,
		&t.State, &t.Objective, &crit, &t.Verification, &t.TrackerID, &t.ReviewCycles)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(crit), &t.Criteria)
	return &t, nil
}

// checkFencing verifies the presented token matches the task's newest
// lease generation. A token older than the current counter is stale even
// if its lease row still exists.
func (e *Engine) checkFencing(tx *sql.Tx, taskID string, token int64) error {
	var current int64
	if err := tx.QueryRow(`SELECT counter FROM fencing WHERE task_id = ?`, taskID).Scan(&current); err != nil {
		return ErrStaleFencing
	}
	if token != current {
		return ErrStaleFencing
	}
	var holder string
	if err := tx.QueryRow(`SELECT holder FROM leases WHERE task_id = ? AND fencing_token = ?`,
		taskID, token).Scan(&holder); err != nil {
		return ErrStaleFencing
	}
	return nil
}

func (e *Engine) transition(taskID string, from, to contracts.State, actor contracts.Actor,
	guard func(*sql.Tx, *Task) error) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := e.getForUpdate(tx, taskID)
	if err != nil {
		return err
	}
	if t.State != from {
		return fmt.Errorf("%w: state=%s expected=%s", ErrWrongState, t.State, from)
	}
	if !contracts.Allowed(from, to, actor) {
		return ErrTransition
	}
	if guard != nil {
		if err := guard(tx, t); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`, to, e.ts(), taskID); err != nil {
		return err
	}
	return tx.Commit()
}

func newNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
