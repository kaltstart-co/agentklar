// Package ctx is Agentklar's full-text context index. It indexes documents
// sourced from the knowledge and memory layers, repo code files, and ticket
// text, and builds focused work packets handed to an agent when it claims a
// task — so the agent does not re-read the whole repo.
//
// Storage is its own SQLite file (context.sqlite) kept separate from the
// protected control database: this index is a derived, rebuildable
// projection, never an authority on workflow state.
//
// The package is named ctx (not context) to avoid shadowing the stdlib
// "context" everywhere it is imported.
package ctx

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	_ "modernc.org/sqlite"
)

// Source identifies which layer a document was drawn from. The lead passes
// Docs in already typed; ctx never reaches into other internal packages.
type Source string

const (
	SourceKnowledge Source = "knowledge"
	SourceMemory    Source = "memory"
	SourceCode      Source = "code"
	SourceTicket    Source = "ticket"
)

// Doc is one indexable unit. Ref is the stable id the caller uses to upsert
// (file path, memory key, ticket id); (Source, Ref) is the primary key.
type Doc struct {
	Source Source
	Ref    string
	Title  string
	Body   string
}

// Packet is a focused slice of context handed to an agent alongside a task,
// the result of a ranked search bound to the originating query.
type Packet struct {
	Query string
	Items []Doc
}

// Store owns the context.sqlite handle. Unexported: callers operate through
// methods so the schema and PRAGMAs are always applied by New.
type Store struct {
	db *sql.DB
}

// schema is applied verbatim on open. WAL + busy_timeout match the rest of
// Agentklar's SQLite usage; foreign_keys is intentionally off — this index
// has no relational integrity to enforce beyond its own composite key.
//
// docs is the authoritative store keyed by (source, ref). docs_fts is a
// standalone FTS5 index kept in sync from Index; source/ref are UNINDEXED so
// we can scope deletes during upsert without polluting full-text matches.
// A standalone table (rather than external-content) avoids the fragility of
// wiring triggers against a composite primary key.
const schema = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS docs (
    source TEXT NOT NULL,
    ref    TEXT NOT NULL,
    title  TEXT NOT NULL DEFAULT '',
    body   TEXT NOT NULL,
    PRIMARY KEY (source, ref)
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title,
    body,
    source UNINDEXED,
    ref    UNINDEXED
);
`

// New opens (creating if needed) <workspaceDir>/context.sqlite and ensures
// the schema. Idempotent: safe to call repeatedly on the same directory.
func New(workspaceDir string) (*Store, error) {
	db, err := sql.Open("sqlite", filepath.Join(workspaceDir, "context.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("open context.sqlite: %w", err)
	}
	// modernc/sqlite serializes writes; a single connection avoids
	// SQLITE_BUSY between our own transactions.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate context.sqlite: %w", err)
	}
	return &Store{db: db}, nil
}

// Index upserts docs keyed by (source, ref): existing rows for a key are
// replaced, new ones inserted. The FTS index is kept consistent within one
// transaction. Returns the number of docs written. Idempotent — indexing the
// same docs twice leaves exactly one copy of each.
func (s *Store) Index(docs []Doc) (int, error) {
	if len(docs) == 0 {
		return 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin index tx: %w", err)
	}
	defer tx.Rollback() // safe to commit later; a no-op post-commit
	if err := indexDocsTx(tx, docs); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit index tx: %w", err)
	}
	return len(docs), nil
}

func indexDocsTx(tx *sql.Tx, docs []Doc) error {
	for _, d := range docs {
		// Drop any stale FTS rows for this key first so the index never
		// holds duplicates of a (source, ref) across re-indexes.
		if _, err := tx.Exec(`DELETE FROM docs_fts WHERE source = ? AND ref = ?`, d.Source, d.Ref); err != nil {
			return fmt.Errorf("delete docs_fts %s:%s: %w", d.Source, d.Ref, err)
		}
		if _, err := tx.Exec(`INSERT INTO docs (source, ref, title, body) VALUES (?, ?, ?, ?)
			ON CONFLICT(source, ref) DO UPDATE SET title = excluded.title, body = excluded.body`,
			d.Source, d.Ref, d.Title, d.Body); err != nil {
			return fmt.Errorf("upsert docs %s:%s: %w", d.Source, d.Ref, err)
		}
		if _, err := tx.Exec(`INSERT INTO docs_fts (title, body, source, ref) VALUES (?, ?, ?, ?)`,
			d.Title, d.Body, d.Source, d.Ref); err != nil {
			return fmt.Errorf("insert docs_fts %s:%s: %w", d.Source, d.Ref, err)
		}
	}
	return nil
}

// ReplaceSources atomically replaces every indexed document for the named
// derived sources while leaving unrelated sources, such as tickets, intact.
func (s *Store) ReplaceSources(docs []Doc, sources ...Source) (int, error) {
	selected := make(map[Source]bool, len(sources))
	for _, source := range sources {
		selected[source] = true
	}
	for _, doc := range docs {
		if !selected[doc.Source] {
			return 0, fmt.Errorf("context source %q is not selected for replacement", doc.Source)
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin replace tx: %w", err)
	}
	defer tx.Rollback()
	for source := range selected {
		if _, err := tx.Exec(`DELETE FROM docs_fts WHERE source = ?`, source); err != nil {
			return 0, fmt.Errorf("clear docs_fts %s: %w", source, err)
		}
		if _, err := tx.Exec(`DELETE FROM docs WHERE source = ?`, source); err != nil {
			return 0, fmt.Errorf("clear docs %s: %w", source, err)
		}
	}
	if err := indexDocsTx(tx, docs); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit replace tx: %w", err)
	}
	return len(docs), nil
}

// Delete removes one derived document from both the source table and its FTS projection.
func (s *Store) Delete(source Source, ref string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin delete tx: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM docs_fts WHERE source = ? AND ref = ?`, source, ref); err != nil {
		return fmt.Errorf("delete docs_fts %s:%s: %w", source, ref, err)
	}
	if _, err := tx.Exec(`DELETE FROM docs WHERE source = ? AND ref = ?`, source, ref); err != nil {
		return fmt.Errorf("delete docs %s:%s: %w", source, ref, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete tx: %w", err)
	}
	return nil
}

// Search runs an FTS5 ranked search across titles and bodies, returning up to
// limit docs (0 or negative defaults to 25), best match first. Title matches
// are weighted above body-only matches. An empty or non-alphanumeric query
// returns no results without error rather than crashing FTS5 on a bad MATCH.
func (s *Store) Search(query string, limit int) ([]Doc, error) {
	match := sanitizeFTS(query)
	if match == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 25
	}

	rows, err := s.db.Query(`
		SELECT source, ref, title, body
		FROM docs_fts
		WHERE docs_fts MATCH ?
		ORDER BY bm25(docs_fts, 10.0, 1.0, 0.0, 0.0)
		LIMIT ?`, match, limit)
	if err != nil {
		// A robustly-sanitized query should never produce a syntax error
		// here, but if SQLite rejects the MATCH we surface it rather than
		// mask a genuine storage fault.
		return nil, fmt.Errorf("search docs_fts: %w", err)
	}
	defer rows.Close()

	var out []Doc
	for rows.Next() {
		var d Doc
		var source string
		if err := rows.Scan(&source, &d.Ref, &d.Title, &d.Body); err != nil {
			return nil, fmt.Errorf("scan doc: %w", err)
		}
		d.Source = Source(source)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate docs_fts: %w", err)
	}
	return out, nil
}

// Packet is Search wrapped with the originating query, ready to hand to an
// agent as focused context.
func (s *Store) Packet(query string, limit int) (Packet, error) {
	docs, err := s.Search(query, limit)
	if err != nil {
		return Packet{}, err
	}
	return Packet{Query: query, Items: docs}, nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error { return s.db.Close() }

// sanitizeFTS turns free-form input into a safe FTS5 MATCH expression. Each
// whitespace-delimited token that contains at least one alphanumeric char is
// emitted as a quoted prefix phrase ("tok"*), so plain words match by prefix
// and special characters can never break MATCH parsing. Tokens that are pure
// punctuation (e.g. "!!!") are dropped, yielding "" for "garbage" queries —
// which the caller treats as "no results". Internal double quotes are escaped
// per FTS5 string-literal rules (doubled).
func sanitizeFTS(query string) string {
	var b strings.Builder
	written := 0
	for _, field := range strings.Fields(query) {
		if !hasAlnum(field) {
			continue
		}
		if written > 0 {
			b.WriteByte(' ')
		}
		written++
		b.WriteByte('"')
		b.WriteString(strings.ReplaceAll(field, `"`, `""`))
		b.WriteString(`"*`)
	}
	return b.String()
}

// hasAlnum reports whether s contains at least one letter or digit — the test
// for keeping a token in the MATCH expression.
func hasAlnum(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}
