package store

import (
	"database/sql"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

func TestOpen(t *testing.T) {
	t.Run("creates database and tables", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "test.db")
		db, err := Open(dbPath)
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		defer db.Close()

		for _, table := range []string{"tasks", "leases", "approvals", "task_dependencies"} {
			var name string
			err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
			if err == sql.ErrNoRows {
				t.Errorf("table %q does not exist", table)
			} else if err != nil {
				t.Errorf("error checking table %q: %v", table, err)
			}
		}
		var version int
		if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
			t.Fatal(err)
		}
		if version != 2 {
			t.Fatalf("user_version = %d, want 2", version)
		}
	})

	t.Run("idempotent on same path", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "test.db")
		db1, err := Open(dbPath)
		if err != nil {
			t.Fatalf("first Open failed: %v", err)
		}
		defer db1.Close()

		db2, err := Open(dbPath)
		if err != nil {
			t.Fatalf("second Open failed: %v", err)
		}
		defer db2.Close()

		if db1 == nil || db2 == nil {
			t.Fatal("database connections should not be nil")
		}
	})

	t.Run("serializes concurrent migrations", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "concurrent.db")
		start := make(chan struct{})
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Go(func() {
				<-start
				db, err := Open(dbPath)
				if err == nil {
					err = db.Close()
				}
				errs <- err
			})
		}
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("concurrent Open failed: %v", err)
			}
		}
		db, err := Open(dbPath)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var version int
		if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
			t.Fatal(err)
		}
		if version != 2 {
			t.Fatalf("user_version = %d, want 2", version)
		}
	})

	t.Run("records every migration version in sequence", func(t *testing.T) {
		got := make([]int, len(migrations))
		for i, migration := range migrations {
			got[i] = migration.version
		}
		if want := []int{1, 2}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("migration versions = %v, want %v", got, want)
		}
	})

	t.Run("upgrades a legacy database without losing tasks", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "legacy.db")
		legacy, err := sql.Open("sqlite", dbPath)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(`CREATE TABLE tasks (
			id TEXT PRIMARY KEY, project TEXT NOT NULL, repo_path TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL, lane TEXT NOT NULL, isolation TEXT NOT NULL DEFAULT 'auto',
			target TEXT NOT NULL DEFAULT 'any', state TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '',
			criteria TEXT NOT NULL DEFAULT '[]', verification TEXT NOT NULL DEFAULT '',
			tracker_id TEXT NOT NULL DEFAULT '', review_cycles INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)`); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(`INSERT INTO tasks (id, project, title, lane, state, created_at, updated_at)
			VALUES ('legacy', 'project', 'existing task', 'standard', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
			t.Fatal(err)
		}
		if err := legacy.Close(); err != nil {
			t.Fatal(err)
		}

		db, err := Open(dbPath)
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		defer db.Close()

		var version int
		if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
			t.Fatal(err)
		}
		if version != 2 {
			t.Fatalf("user_version = %d, want 2", version)
		}

		var priority, assignee, labels, dueDate, archivedAt string
		var position int64
		if err := db.QueryRow(`SELECT priority, assignee, labels, due_date, position, archived_at
			FROM tasks WHERE id = 'legacy'`).Scan(&priority, &assignee, &labels, &dueDate, &position, &archivedAt); err != nil {
			t.Fatalf("legacy task was not preserved with planning defaults: %v", err)
		}
		if priority != "medium" || assignee != "" || labels != "[]" || dueDate != "" || position != 0 || archivedAt != "" {
			t.Fatalf("unexpected planning defaults: %q %q %q %q %d %q", priority, assignee, labels, dueDate, position, archivedAt)
		}

		var name string
		if err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependencies'").Scan(&name); err != nil {
			t.Fatalf("task_dependencies was not created: %v", err)
		}
		if _, err := db.Exec("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('legacy', 'legacy')"); err == nil {
			t.Fatal("self-dependency was accepted")
		}
		if _, err := db.Exec("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('legacy', 'missing')"); err == nil {
			t.Fatal("missing dependency was accepted")
		}
		if _, err := db.Exec(`INSERT INTO tasks (id, project, title, lane, state, created_at, updated_at)
			VALUES ('other', 'project', 'other task', 'standard', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('legacy', 'other')"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('legacy', 'other')"); err == nil {
			t.Fatal("duplicate dependency was accepted")
		}
	})
}
