package store

import (
	"database/sql"
	"path/filepath"
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

		for _, table := range []string{"tasks", "leases", "approvals"} {
			var name string
			err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
			if err == sql.ErrNoRows {
				t.Errorf("table %q does not exist", table)
			} else if err != nil {
				t.Errorf("error checking table %q: %v", table, err)
			}
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
}
