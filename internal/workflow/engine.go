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
	"reflect"
	"strings"
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
	ErrInvalidTask      = errors.New("invalid task update")
	ErrFrozenTask       = errors.New("submitted task fields are frozen")
	ErrDependency       = errors.New("invalid task dependency")
	ErrReorder          = errors.New("invalid task order")
)

type Engine struct {
	db  *sql.DB
	now func() time.Time
}

func New(db *sql.DB) *Engine { return &Engine{db: db, now: time.Now} }

// SetClock overrides time for tests.
func (e *Engine) SetClock(now func() time.Time) { e.now = now }

func (e *Engine) ts() string { return e.now().UTC().Format(time.RFC3339Nano) }

type Priority string

const (
	PriorityLow    Priority = "low"
	PriorityMedium Priority = "medium"
	PriorityHigh   Priority = "high"
	PriorityUrgent Priority = "urgent"
)

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
	Priority                     Priority
	Assignee                     string
	Labels                       []string
	DueDate                      string
	Position                     int64
	ArchivedAt                   string
	CreatedAt                    string
	UpdatedAt                    string
}

// TaskUpdate is the editable task content. Submitted tasks keep their
// protected execution fields frozen; only planning metadata may change.
type TaskUpdate struct {
	Title, Objective, Verification, Assignee, DueDate string
	Lane                                              contracts.Lane
	Isolation                                         contracts.Isolation
	Target                                            contracts.ExecutionTarget
	Priority                                          Priority
	Criteria, Labels                                  []string
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
	return e.CreateTaskWithDependencies(t, nil)
}

// CreateTaskWithDependencies inserts a Draft task and its prerequisites atomically.
func (e *Engine) CreateTaskWithDependencies(t Task, deps []string) error {
	if t.ID == "." || t.ID == ".." || strings.Contains(t.ID, "/") {
		return ErrInvalidTask
	}
	if t.Lane == "" {
		t.Lane = contracts.LaneStandard
	}
	if t.Isolation == "" {
		t.Isolation = contracts.IsolationAuto
	}
	if t.Target == "" {
		t.Target = contracts.TargetAny
	}
	if t.Priority == "" {
		t.Priority = PriorityMedium
	}
	t.Criteria = normalizeStrings(t.Criteria)
	t.Labels = normalizeStrings(t.Labels)
	crit, _ := json.Marshal(t.Criteria)
	labels, _ := json.Marshal(t.Labels)
	now := e.ts()
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO tasks
		(id, project, repo_path, title, lane, isolation, target, state, objective, criteria, verification, tracker_id,
		 priority, assignee, labels, due_date, position, archived_at, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.Project, t.RepoPath, t.Title, t.Lane, t.Isolation, t.Target,
		contracts.StateDraft, t.Objective, string(crit), t.Verification, t.TrackerID,
		t.Priority, t.Assignee, string(labels), t.DueDate, t.Position, t.ArchivedAt, now, now); err != nil {
		return err
	}
	if err := e.setDependenciesTx(tx, t.ID, deps); err != nil {
		return err
	}
	return tx.Commit()
}

func (e *Engine) GetTask(id string) (*Task, error) {
	row := e.db.QueryRow(`SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return t, nil
}

// MarkReady enforces Definition of Ready: no criteria, no Ready.
func (e *Engine) MarkReady(taskID string, actor contracts.Actor) error {
	return e.transition(taskID, contracts.StateDraft, contracts.StateReady, actor, func(tx *sql.Tx, t *Task) error {
		if len(t.Criteria) == 0 || strings.TrimSpace(t.Verification) == "" {
			return ErrNotReadyCriteria
		}
		return nil
	})
}

// ListReady returns Ready tasks matching the execution target.
func (e *Engine) ListReady(target contracts.ExecutionTarget) ([]Task, error) {
	rows, err := e.db.Query(`SELECT `+taskColumns+` FROM tasks
		WHERE state = ? AND archived_at = '' AND (target = ? OR target = 'any' OR ? = 'any')
		ORDER BY position, created_at, id`,
		contracts.StateReady, target, target)
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
	if err := e.transitionInTx(tx, t, contracts.StateInProgress, contracts.ActorAgent); err != nil {
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
	if _, err := e.getForUpdate(tx, taskID); err != nil {
		return err
	}
	if err := e.checkFencing(tx, taskID, token); err != nil {
		return err
	}
	expiry := e.now().Add(contracts.DefaultLeaseTTL).UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(`UPDATE leases SET expires_at = ?, heartbeat_at = ? WHERE task_id = ?`,
		expiry, e.ts(), taskID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE repo_leases SET expires_at = ? WHERE task_id = ?`, expiry, taskID); err != nil {
		return err
	}
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

	if err := e.transitionInTx(tx, t, contracts.StateCompletionReview, contracts.ActorAgent); err != nil {
		return 0, err
	}
	// Free the exclusive repo lease; keep the task lease frozen for provenance.
	if _, err := tx.Exec(`DELETE FROM repo_leases WHERE task_id = ?`, taskID); err != nil {
		return 0, err
	}

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
	if err := e.transitionInTx(tx, t, to, contracts.ActorSystem); err != nil {
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
	return e.resolveApproval(taskID, nonce, approve, approvedBy, channel, "", false)
}

// ResolveApprovalWithReason records a human rejection reason before moving the
// task to Changes Requested. ResolveApproval remains for existing callers.
func (e *Engine) ResolveApprovalWithReason(taskID, nonce string, approve bool, approvedBy, channel, reason string) error {
	return e.resolveApproval(taskID, nonce, approve, approvedBy, channel, reason, true)
}

func (e *Engine) resolveApproval(taskID, nonce string, approve bool, approvedBy, channel, reason string, requireReason bool) error {
	if !approve && requireReason && strings.TrimSpace(reason) == "" {
		return ErrInvalidTask
	}
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
	if _, err := tx.Exec(`UPDATE approvals SET decided = 1, decision = ?, decided_by = ?, channel = ? WHERE task_id = ?`,
		decision, approvedBy, channel, taskID); err != nil {
		return err
	}
	if !approve && strings.TrimSpace(reason) != "" {
		if _, err := tx.Exec(`INSERT INTO comments (task_id, actor, ctype, body, created_at) VALUES (?,?,?,?,?)`,
			taskID, contracts.ActorHuman, "request_changes", reason, e.ts()); err != nil {
			return err
		}
	}
	if err := e.transitionInTx(tx, t, to, contracts.ActorHuman); err != nil {
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
	if err := e.dropLeases(tx, taskID); err != nil {
		return err
	}
	if err := e.transitionInTx(tx, t, contracts.StateReady, contracts.ActorAgent); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateTask edits pre-submission content. Once submitted, execution fields remain
// frozen so the submitted criteria snapshot stays meaningful.
func (e *Engine) UpdateTask(id string, u TaskUpdate) error {
	if err := validateTaskUpdate(&u); err != nil {
		return err
	}
	criteria, err := json.Marshal(u.Criteria)
	if err != nil {
		return err
	}
	labels, err := json.Marshal(u.Labels)
	if err != nil {
		return err
	}
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := e.updateTaskTx(tx, id, u, string(criteria), string(labels)); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateTaskWithDependencies changes task metadata and prerequisites in one transaction.
func (e *Engine) UpdateTaskWithDependencies(id string, u TaskUpdate, deps []string) error {
	if err := validateTaskUpdate(&u); err != nil {
		return err
	}
	criteria, err := json.Marshal(u.Criteria)
	if err != nil {
		return err
	}
	labels, err := json.Marshal(u.Labels)
	if err != nil {
		return err
	}
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := e.updateTaskTx(tx, id, u, string(criteria), string(labels)); err != nil {
		return err
	}
	if err := e.setDependenciesTx(tx, id, deps); err != nil {
		return err
	}
	return tx.Commit()
}

func (e *Engine) updateTaskTx(tx *sql.Tx, id string, u TaskUpdate, criteria, labels string) error {
	t, err := e.getForUpdate(tx, id)
	if err != nil {
		return err
	}
	if !sameProtectedFields(t, u) {
		var submitted int
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM submissions WHERE task_id = ?)`, id).Scan(&submitted); err != nil {
			return err
		}
		if submitted == 1 {
			return ErrFrozenTask
		}
	}
	_, err = tx.Exec(`UPDATE tasks SET title=?, lane=?, isolation=?, target=?, objective=?, criteria=?, verification=?,
		priority=?, assignee=?, labels=?, due_date=?, updated_at=? WHERE id=?`,
		u.Title, u.Lane, u.Isolation, u.Target, u.Objective, criteria, u.Verification,
		u.Priority, u.Assignee, labels, u.DueDate, e.ts(), id)
	return err
}

// SetDependencies replaces a task's prerequisites after rejecting missing,
// duplicate, self-referential, and cyclic dependencies.
func (e *Engine) SetDependencies(id string, deps []string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := e.setDependenciesTx(tx, id, deps); err != nil {
		return err
	}
	return tx.Commit()
}

func (e *Engine) setDependenciesTx(tx *sql.Tx, id string, deps []string) error {
	if _, err := e.getForUpdate(tx, id); err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(deps))
	for _, dep := range deps {
		if dep == "" || dep == id {
			return ErrDependency
		}
		if _, ok := seen[dep]; ok {
			return ErrDependency
		}
		seen[dep] = struct{}{}
		var exists int
		if err := tx.QueryRow(`SELECT 1 FROM tasks WHERE id = ? AND archived_at = ''`, dep).Scan(&exists); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrDependency
			}
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM task_dependencies WHERE task_id = ?`, id); err != nil {
		return err
	}
	for _, dep := range deps {
		if _, err := tx.Exec(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?,?)`, id, dep); err != nil {
			return err
		}
	}
	var cycle int
	err := tx.QueryRow(`WITH RECURSIVE reachable(task_id) AS (
		SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
		UNION
		SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id = r.task_id
	) SELECT 1 FROM reachable WHERE task_id = ? LIMIT 1`, id, id).Scan(&cycle)
	if err == nil {
		return ErrDependency
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

// Reorder assigns stable positions to exactly the active tasks in one state.
func (e *Engine) Reorder(state contracts.State, orderedIDs []string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT id FROM tasks WHERE state = ? AND archived_at = ''`, state)
	if err != nil {
		return err
	}
	defer rows.Close()
	expected := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		expected[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(expected) != len(orderedIDs) {
		return ErrReorder
	}
	for _, id := range orderedIDs {
		if _, ok := expected[id]; !ok {
			return ErrReorder
		}
		delete(expected, id)
	}
	if len(expected) != 0 {
		return ErrReorder
	}
	for position, id := range orderedIDs {
		if _, err := tx.Exec(`UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?`, position, e.ts(), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// HumanTransition accepts only an allowed human state-machine edge. Done is
// deliberately excluded: it requires ResolveApproval's nonce-bound channel.
func (e *Engine) HumanTransition(id string, to contracts.State, reason string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := e.getForUpdate(tx, id)
	if err != nil {
		return err
	}
	if to == contracts.StateDone || !contracts.Allowed(t.State, to, contracts.ActorHuman) {
		return ErrTransition
	}
	if to == contracts.StateReady && (len(t.Criteria) == 0 || strings.TrimSpace(t.Verification) == "") {
		return ErrNotReadyCriteria
	}
	if t.State == contracts.StateUserApproval && to == contracts.StateChangesRequested {
		if strings.TrimSpace(reason) == "" {
			return ErrInvalidTask
		}
		result, err := tx.Exec(`UPDATE approvals SET decided = 1, decision = 'rejected', decided_by = 'human', channel = 'board' WHERE task_id = ? AND decided = 0`, id)
		if err != nil {
			return err
		}
		updated, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if updated != 1 {
			return ErrNonceInvalid
		}
		if _, err := tx.Exec(`INSERT INTO comments (task_id, actor, ctype, body, created_at) VALUES (?,?,?,?,?)`,
			id, contracts.ActorHuman, "request_changes", reason, e.ts()); err != nil {
			return err
		}
	}
	if t.State == contracts.StateInProgress && to == contracts.StateCancelled {
		if err := e.dropLeases(tx, id); err != nil {
			return err
		}
	}
	if err := e.transitionInTx(tx, t, to, contracts.ActorHuman); err != nil {
		return err
	}
	return tx.Commit()
}

// ArchiveTask hides a task from board listings without deleting history.
func (e *Engine) ArchiveTask(id string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := e.getForUpdate(tx, id)
	if err != nil {
		return err
	}
	switch t.State {
	case contracts.StateDraft, contracts.StateReady, contracts.StateChangesRequested, contracts.StateDone, contracts.StateCancelled:
	default:
		return fmt.Errorf("%w: cannot archive state=%s", ErrWrongState, t.State)
	}
	if _, err := tx.Exec(`UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`, e.ts(), e.ts(), id); err != nil {
		return err
	}
	return tx.Commit()
}

// AddEvidence appends evidence with explicit provenance.
func (e *Engine) AddEvidence(taskID string, submissionID int64, prov contracts.Provenance,
	criterion, command, workdir string, exitCode *int, logPath, artifactHash, commitHash, note string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := e.getForUpdate(tx, taskID); err != nil {
		return err
	}
	var sub interface{}
	if submissionID > 0 {
		sub = submissionID
	}
	_, err = tx.Exec(`INSERT INTO evidence
		(task_id, submission_id, provenance, criterion, command, workdir, exit_code, log_path, artifact_hash, commit_hash, note, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		taskID, sub, prov, criterion, command, workdir, exitCode, logPath, artifactHash, commitHash, note, e.ts())
	if err != nil {
		return err
	}
	return tx.Commit()
}

// AddComment appends a timeline comment.
func (e *Engine) AddComment(taskID, actor, ctype, body string) error {
	tx, err := e.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := e.getForUpdate(tx, taskID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO comments (task_id, actor, ctype, body, created_at) VALUES (?,?,?,?,?)`,
		taskID, actor, ctype, body, e.ts()); err != nil {
		return err
	}
	return tx.Commit()
}

// --- internals ---

func (e *Engine) getForUpdate(tx *sql.Tx, id string) (*Task, error) {
	row := tx.QueryRow(`SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if t.ArchivedAt != "" {
		return nil, fmt.Errorf("%w: task is archived", ErrWrongState)
	}
	return t, nil
}

const taskColumns = `id, project, repo_path, title, lane, isolation, target, state,
	objective, criteria, verification, tracker_id, review_cycles,
	priority, assignee, labels, due_date, position, archived_at, created_at, updated_at`

type taskScanner interface {
	Scan(...any) error
}

func scanTask(row taskScanner) (*Task, error) {
	var t Task
	var criteria, labels string
	err := row.Scan(&t.ID, &t.Project, &t.RepoPath, &t.Title, &t.Lane, &t.Isolation, &t.Target,
		&t.State, &t.Objective, &criteria, &t.Verification, &t.TrackerID, &t.ReviewCycles,
		&t.Priority, &t.Assignee, &labels, &t.DueDate, &t.Position, &t.ArchivedAt, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(criteria), &t.Criteria)
	json.Unmarshal([]byte(labels), &t.Labels)
	t.Criteria = normalizeStrings(t.Criteria)
	t.Labels = normalizeStrings(t.Labels)
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
	if guard != nil {
		if err := guard(tx, t); err != nil {
			return err
		}
	}
	if err := e.transitionInTx(tx, t, to, actor); err != nil {
		return err
	}
	return tx.Commit()
}

func (e *Engine) transitionInTx(tx *sql.Tx, t *Task, to contracts.State, actor contracts.Actor) error {
	if !contracts.Allowed(t.State, to, actor) {
		return ErrTransition
	}
	if _, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`, to, e.ts(), t.ID); err != nil {
		return err
	}
	t.State = to
	return nil
}

func (e *Engine) dropLeases(tx *sql.Tx, taskID string) error {
	if _, err := tx.Exec(`DELETE FROM leases WHERE task_id = ?`, taskID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM repo_leases WHERE task_id = ?`, taskID); err != nil {
		return err
	}
	return nil
}

func validateTaskUpdate(u *TaskUpdate) error {
	u.Criteria = normalizeStrings(u.Criteria)
	u.Labels = normalizeStrings(u.Labels)
	if strings.TrimSpace(u.Title) == "" {
		return ErrInvalidTask
	}
	switch u.Priority {
	case PriorityLow, PriorityMedium, PriorityHigh, PriorityUrgent:
	default:
		return ErrInvalidTask
	}
	if u.DueDate != "" {
		if _, err := time.Parse("2006-01-02", u.DueDate); err != nil {
			return ErrInvalidTask
		}
	}
	seen := make(map[string]struct{}, len(u.Labels))
	for _, label := range u.Labels {
		label = strings.TrimSpace(label)
		if label == "" {
			return ErrInvalidTask
		}
		if _, ok := seen[label]; ok {
			return ErrInvalidTask
		}
		seen[label] = struct{}{}
	}
	return nil
}

func sameProtectedFields(t *Task, u TaskUpdate) bool {
	return t.Title == u.Title && t.Objective == u.Objective && t.Verification == u.Verification &&
		t.Lane == u.Lane && t.Isolation == u.Isolation && t.Target == u.Target &&
		reflect.DeepEqual(normalizeStrings(t.Criteria), normalizeStrings(u.Criteria))
}

func normalizeStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func newNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
