package catalog

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kaltstart-co/agentklar/internal/store"
)

func TestRegisterUsesStableCanonicalPathID(t *testing.T) {
	c := newTestCatalog(t)
	repo := filepath.Join(t.TempDir(), "repo")

	p, err := c.Register(repo, filepath.Join(t.TempDir(), "legacy"))
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.Abs(repo)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%x", sha256.Sum256([]byte(filepath.Clean(canonical))))[:12]
	if p.ID != want {
		t.Fatalf("ID = %q, want %q", p.ID, want)
	}
	if p.RepoPath != filepath.Clean(canonical) {
		t.Fatalf("RepoPath = %q, want %q", p.RepoPath, filepath.Clean(canonical))
	}
}

func TestRegisterIsIdempotent(t *testing.T) {
	c := newTestCatalog(t)
	repo := filepath.Join(t.TempDir(), "repo")
	legacy := filepath.Join(t.TempDir(), "legacy")

	first, err := c.Register(repo, legacy)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Register(repo, filepath.Join(t.TempDir(), "other"))
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || second.WorkspacePath != first.WorkspacePath {
		t.Fatalf("second registration = %+v, want existing project %+v", second, first)
	}
	projects, err := c.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 {
		t.Fatalf("projects = %d, want 1", len(projects))
	}
}

func TestRegisterUsesHashedWorkspaceForBasenameCollision(t *testing.T) {
	c := newTestCatalog(t)
	root := t.TempDir()
	repoA := filepath.Join(root, "one", "app")
	repoB := filepath.Join(root, "two", "app")
	legacy := filepath.Join(root, "workspaces", "app")
	seedLegacyWorkspace(t, legacy, repoA)

	first, err := c.Register(repoA, legacy)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Register(repoB, legacy)
	if err != nil {
		t.Fatal(err)
	}
	canonicalLegacy, err := canonicalPath(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if first.WorkspacePath != canonicalLegacy {
		t.Fatalf("first workspace = %q, want legacy %q", first.WorkspacePath, canonicalLegacy)
	}
	want := filepath.Join(filepath.Dir(canonicalLegacy), "app-"+second.ID)
	if second.WorkspacePath != want {
		t.Fatalf("second workspace = %q, want %q", second.WorkspacePath, want)
	}
}

func TestRegisterKeepsCompatibleLegacyWorkspace(t *testing.T) {
	c := newTestCatalog(t)
	legacy := filepath.Join(t.TempDir(), "app")
	repo := filepath.Join(t.TempDir(), "acme", "app")
	seedLegacyWorkspace(t, legacy, repo)

	p, err := c.Register(repo, legacy)
	if err != nil {
		t.Fatal(err)
	}
	canonicalLegacy, err := canonicalPath(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if p.WorkspacePath != canonicalLegacy {
		t.Fatalf("workspace = %q, want %q", p.WorkspacePath, canonicalLegacy)
	}
}

func TestRegisterUsesHashedWorkspaceWithoutLegacyDatabase(t *testing.T) {
	c := newTestCatalog(t)
	root := t.TempDir()
	legacy := filepath.Join(root, "workspaces", "app")

	p, err := c.Register(filepath.Join(root, "acme", "app"), legacy)
	if err != nil {
		t.Fatal(err)
	}
	assertHashedWorkspace(t, p, legacy)
}

func TestRegisterUsesHashedWorkspaceWithoutLegacyTasksTable(t *testing.T) {
	c := newTestCatalog(t)
	root := t.TempDir()
	legacy := filepath.Join(root, "workspaces", "app")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(legacy, "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE malformed (id TEXT)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	p, err := c.Register(filepath.Join(root, "acme", "app"), legacy)
	if err != nil {
		t.Fatal(err)
	}
	assertHashedWorkspace(t, p, legacy)
}

func TestListOrdersByLastOpenedAt(t *testing.T) {
	c := newTestCatalog(t)
	root := t.TempDir()
	first, err := c.Register(filepath.Join(root, "first"), filepath.Join(root, "workspaces", "first"))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	second, err := c.Register(filepath.Join(root, "second"), filepath.Join(root, "workspaces", "second"))
	if err != nil {
		t.Fatal(err)
	}

	projects, err := c.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 || projects[0].ID != second.ID || projects[1].ID != first.ID {
		t.Fatalf("projects = %+v, want [%s %s]", projects, second.ID, first.ID)
	}
}

func newTestCatalog(t *testing.T) *Catalog {
	t.Helper()
	c, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func seedLegacyWorkspace(t *testing.T, workspace, repo string) {
	t.Helper()
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(filepath.Join(workspace, "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`INSERT INTO tasks (id, project, repo_path, title, lane, state, created_at, updated_at)
		VALUES ('legacy', 'app', ?, 'legacy', 'quick', 'Draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, repo)
	if err != nil {
		t.Fatal(err)
	}
}

func assertHashedWorkspace(t *testing.T, p Project, legacy string) {
	t.Helper()
	canonicalLegacy, err := canonicalPath(legacy)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(filepath.Dir(canonicalLegacy), "app-"+p.ID)
	if p.WorkspacePath != want {
		t.Fatalf("workspace = %q, want %q", p.WorkspacePath, want)
	}
}
