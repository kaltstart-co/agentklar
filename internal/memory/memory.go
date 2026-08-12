// Package memory is Agentklar's shared, cross-session memory store. Each row
// is a fact with provenance (which task, which agent holder, when) and is
// full-text searchable via SQLite FTS5.
//
// Storage is its own file (<workspace>/memory.sqlite), separate from the
// protected control.sqlite workflow state. Deletion of rows is exposed here
// without restriction; the invariant that only a human may forget is enforced
// by the CLI/MCP layer that calls into this package, not by this store.
package memory

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Entry is one memory fact with provenance.
type Entry struct {
	ID         int64
	Namespace  string // e.g. a task id; "" for global
	Key        string // stable key within the namespace
	Value      string
	SourceTask string // task id the memory originated from (may equal Namespace)
	Holder     string // agent holder that wrote it (provenance)
	CreatedAt  string // UTC RFC3339
}

// Store is a handle on memory.sqlite. Methods are safe for concurrent use
// because the underlying connection pool is serialized (SetMaxOpenConns(1)).
type Store struct {
	db *sql.DB
}

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY,
    namespace   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    source_task TEXT NOT NULL DEFAULT '',
    holder      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE(namespace, key)
);

-- External-content FTS5: the index mirrors memory.value and is kept in sync by
-- triggers, so Remember/Forget touch only the base table and the index follows.
-- rowid mapping is memory.id (an INTEGER PRIMARY KEY aliases rowid).
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    value, content='memory', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, value) VALUES (new.id, new.value);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, value) VALUES ('delete', old.id, old.value);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, value) VALUES ('delete', old.id, old.value);
    INSERT INTO memory_fts(rowid, value) VALUES (new.id, new.value);
END;
`

// New opens (creating if needed) <workspaceDir>/memory.sqlite and ensures the
// schema. Idempotent: safe to call repeatedly on the same directory.
func New(workspaceDir string) (*Store, error) {
	db, err := sql.Open("sqlite", filepath.Join(workspaceDir, "memory.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("open memory.sqlite: %w", err)
	}
	// modernc/sqlite serializes writes; a single connection avoids SQLITE_BUSY
	// between our own statements and keeps per-connection PRAGMAs stable.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate memory.sqlite: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// Remember upserts on (namespace, key): if a row exists, its value, provenance
// and created_at are refreshed; otherwise a new row is inserted. The FTS index
// follows via the AFTER INSERT/UPDATE triggers. Returns the row id.
func (s *Store) Remember(namespace, key, value, sourceTask, holder string) (int64, error) {
	// RFC3339Nano is RFC3339-compliant; sub-second precision lets an upsert
	// reliably outrank the prior write in List's newest-first ordering even
	// within the same wall-clock second.
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var id int64
	err := s.db.QueryRow(`
        INSERT INTO memory (namespace, key, value, source_task, holder, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
            value = excluded.value,
            source_task = excluded.source_task,
            holder = excluded.holder,
            created_at = excluded.created_at
        RETURNING id`,
		namespace, key, value, sourceTask, holder, now).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("remember: %w", err)
	}
	return id, nil
}

// Recall runs an FTS5 ranked search over values, returning up to limit entries
// (0 or negative = default 20). A query without FTS syntax is applied as a set
// of prefix terms so partial word matches work; a malformed FTS expression
// yields an empty result rather than an error.
func (s *Store) Recall(query string, limit int) ([]Entry, error) {
	return s.RecallScoped(query, "", "", limit)
}

// RecallScoped searches memory after applying namespace and source-task scope.
func (s *Store) RecallScoped(query, namespace, sourceTask string, limit int) ([]Entry, error) {
	fts := ftsQuery(query)
	if fts == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.Query(`
        SELECT m.id, m.namespace, m.key, m.value, m.source_task, m.holder, m.created_at
        FROM memory_fts
        JOIN memory m ON m.id = memory_fts.rowid
        WHERE memory_fts MATCH ?
		  AND (? = '' OR m.namespace = ?)
		  AND (? = '' OR m.source_task = ?)
        ORDER BY bm25(memory_fts) ASC
        LIMIT ?`,
		fts, namespace, namespace, sourceTask, sourceTask, limit)
	if err != nil {
		if isFTSSyntaxError(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("recall: %w", err)
	}
	defer rows.Close()
	return scanEntries(rows)
}

// List returns all entries, optionally filtered by namespace ("" = all),
// newest first.
func (s *Store) List(namespace string) ([]Entry, error) {
	return s.ListScoped(namespace, "")
}

// ListScoped lists memory after applying namespace and source-task scope.
func (s *Store) ListScoped(namespace, sourceTask string) ([]Entry, error) {
	rows, err := s.db.Query(`
		SELECT id, namespace, key, value, source_task, holder, created_at
		FROM memory
		WHERE (? = '' OR namespace = ?)
		  AND (? = '' OR source_task = ?)
		ORDER BY created_at DESC, id DESC`, namespace, namespace, sourceTask, sourceTask)
	if err != nil {
		return nil, fmt.Errorf("list: %w", err)
	}
	defer rows.Close()
	return scanEntries(rows)
}

// Get returns one entry by id.
func (s *Store) Get(id int64) (Entry, error) {
	var e Entry
	err := s.db.QueryRow(`
        SELECT id, namespace, key, value, source_task, holder, created_at
        FROM memory
        WHERE id = ?`, id).
		Scan(&e.ID, &e.Namespace, &e.Key, &e.Value, &e.SourceTask, &e.Holder, &e.CreatedAt)
	if err != nil {
		return Entry{}, fmt.Errorf("get: %w", err)
	}
	return e, nil
}

// Forget deletes one entry by id. The FTS index follows via the AFTER DELETE
// trigger. Human-only enforcement is at the CLI/MCP layer, not here.
func (s *Store) Forget(id int64) error {
	if _, err := s.db.Exec(`DELETE FROM memory WHERE id = ?`, id); err != nil {
		return fmt.Errorf("forget: %w", err)
	}
	return nil
}

func scanEntries(rows *sql.Rows) ([]Entry, error) {
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.Namespace, &e.Key, &e.Value, &e.SourceTask, &e.Holder, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ftsQuery sanitizes a user query into an FTS5 MATCH expression. A query that
// already looks like FTS5 syntax is passed through unchanged; otherwise each
// whitespace-delimited token is wrapped as a quoted prefix term so partial
// matches work. An empty result means "match nothing".
func ftsQuery(q string) string {
	q = strings.TrimSpace(q)
	if q == "" {
		return ""
	}
	if hasFTSSyntax(q) {
		return q
	}
	fields := strings.Fields(q)
	terms := make([]string, 0, len(fields))
	for _, f := range fields {
		// Double any embedded quote so it stays a literal inside the phrase.
		safe := strings.ReplaceAll(f, `"`, `""`)
		terms = append(terms, `"`+safe+`"*`)
	}
	return strings.Join(terms, " ")
}

// hasFTSSyntax reports whether q already contains FTS5 query operators, in
// which case ftsQuery should hand it through verbatim instead of re-quoting.
func hasFTSSyntax(q string) bool {
	if strings.ContainsAny(q, `"*():^`) {
		return true
	}
	padded := " " + strings.ToUpper(q) + " "
	for _, op := range []string{" AND ", " OR ", " NOT ", " NEAR "} {
		if strings.Contains(padded, op) {
			return true
		}
	}
	return false
}

// isFTSSyntaxError reports whether err is a malformed-FTS-expression error,
// which Recall treats as "no matches" rather than a fatal failure. The rest of
// Recall's statement is static, so any error from the MATCH evaluation is
// attributable to the user-supplied query string.
func isFTSSyntaxError(err error) bool {
	msg := strings.ToLower(err.Error())
	for _, marker := range []string{
		"syntax error",
		"unterminated string",
		"fts5",
		"no such column",
		"malformed",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}
