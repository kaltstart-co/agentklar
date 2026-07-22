// Package store owns control.sqlite: Agentklar-authoritative protected
// workflow state. Tracker-owned content (titles, comments, attachments)
// is never authoritative here — only projected identifiers are kept.
package store

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    project       TEXT NOT NULL,
    repo_path     TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL,
    lane          TEXT NOT NULL,
    isolation     TEXT NOT NULL DEFAULT 'auto',
    target        TEXT NOT NULL DEFAULT 'any',
    state         TEXT NOT NULL,
    objective     TEXT NOT NULL DEFAULT '',
    criteria      TEXT NOT NULL DEFAULT '[]',   -- JSON array of acceptance criteria
    verification  TEXT NOT NULL DEFAULT '',     -- expected verification method
    tracker_id    TEXT NOT NULL DEFAULT '',     -- projected tracker task id
    review_cycles INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- One active lease per task; fencing_token increases monotonically per task.
CREATE TABLE IF NOT EXISTS leases (
    task_id       TEXT PRIMARY KEY REFERENCES tasks(id),
    holder        TEXT NOT NULL,
    fencing_token INTEGER NOT NULL,
    expires_at    TEXT NOT NULL,
    heartbeat_at  TEXT NOT NULL
);

-- Monotonic fencing counter per task (survives lease release).
CREATE TABLE IF NOT EXISTS fencing (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    counter INTEGER NOT NULL
);

-- Exclusive primary-worktree lease per repository (Quick 'auto' isolation).
CREATE TABLE IF NOT EXISTS repo_leases (
    repo_path  TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    exclusive  INTEGER NOT NULL,            -- 1 = primary-worktree exclusive
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES tasks(id),
    base_commit TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    summary     TEXT NOT NULL,
    criteria_snapshot TEXT NOT NULL,        -- acceptance criteria frozen at submit
    stale       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

-- Append-only: reviews are never updated or deleted.
CREATE TABLE IF NOT EXISTS reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL REFERENCES tasks(id),
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    kind          TEXT NOT NULL,            -- completion | qa
    result        TEXT NOT NULL,
    provider      TEXT NOT NULL DEFAULT '',
    findings      TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL
);

-- Append-only evidence with provenance.
CREATE TABLE IF NOT EXISTS evidence (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL REFERENCES tasks(id),
    submission_id INTEGER REFERENCES submissions(id),
    provenance    TEXT NOT NULL,
    criterion     TEXT NOT NULL DEFAULT '',
    command       TEXT NOT NULL DEFAULT '',
    workdir       TEXT NOT NULL DEFAULT '',
    exit_code     INTEGER,
    log_path      TEXT NOT NULL DEFAULT '',
    artifact_hash TEXT NOT NULL DEFAULT '',
    commit_hash   TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);

-- Pending human approvals; nonce-bound, expiring, single decision.
CREATE TABLE IF NOT EXISTS approvals (
    task_id       TEXT PRIMARY KEY REFERENCES tasks(id),
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    nonce         TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    decided       INTEGER NOT NULL DEFAULT 0,
    decision      TEXT NOT NULL DEFAULT '',
    decided_by    TEXT NOT NULL DEFAULT '',
    channel       TEXT NOT NULL DEFAULT '', -- tracker_comment | elicitation
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
    key        TEXT PRIMARY KEY,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    actor      TEXT NOT NULL,               -- human | agent | system
    ctype      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Outbox of tracker projection writes for webhook echo suppression.
CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    acked       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_fp ON outbox(fingerprint, acked);
`

// Open opens (creating if needed) a control database at path.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open control.sqlite: %w", err)
	}
	// modernc/sqlite serializes writes; a single connection avoids
	// SQLITE_BUSY between our own transactions.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate control.sqlite: %w", err)
	}
	return db, nil
}
