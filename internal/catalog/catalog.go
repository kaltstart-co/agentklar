// Package catalog owns the global project-to-workspace registry.
package catalog

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    repo_path      TEXT NOT NULL UNIQUE,
    workspace_path TEXT NOT NULL UNIQUE,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
);
`

// Project identifies one repository and its isolated Agentklar workspace.
type Project struct {
	ID, Name, RepoPath, WorkspacePath, CreatedAt, UpdatedAt, LastOpenedAt string
}

// Catalog is the global project registry.
type Catalog struct {
	db *sql.DB
}

// Open opens (creating if needed) catalog.sqlite under dataRoot.
func Open(dataRoot string) (*Catalog, error) {
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		return nil, fmt.Errorf("create catalog directory: %w", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dataRoot, "catalog.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("open catalog: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate catalog: %w", err)
	}
	return &Catalog{db: db}, nil
}

// Close releases the catalog database handle.
func (c *Catalog) Close() error { return c.db.Close() }

// Register returns the current repository's project, preserving a compatible
// legacy basename workspace or choosing a collision-safe hashed sibling.
func (c *Catalog) Register(repoPath, legacyWorkspace string) (Project, error) {
	repo, err := canonicalPath(repoPath)
	if err != nil {
		return Project{}, err
	}
	legacy, err := canonicalPath(legacyWorkspace)
	if err != nil {
		return Project{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)

	tx, err := c.db.Begin()
	if err != nil {
		return Project{}, err
	}
	defer tx.Rollback()

	p, err := get(tx, repo)
	if err == nil {
		p.Name = filepath.Base(repo)
		p.UpdatedAt, p.LastOpenedAt = now, now
		if _, err := tx.Exec(`UPDATE projects SET name = ?, updated_at = ?, last_opened_at = ? WHERE id = ?`, p.Name, now, now, p.ID); err != nil {
			return Project{}, fmt.Errorf("refresh project: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return Project{}, err
		}
		return p, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Project{}, err
	}

	workspace := legacy
	compatible, err := legacyCompatible(legacy, repo)
	if err != nil {
		return Project{}, err
	}
	inUse, err := workspaceInUse(tx, workspace)
	if err != nil {
		return Project{}, err
	}
	if !compatible || inUse {
		id := projectID(repo)
		workspace = filepath.Join(filepath.Dir(legacy), sanitize(filepath.Base(repo))+"-"+id)
		inUse, err = workspaceInUse(tx, workspace)
		if err != nil {
			return Project{}, err
		}
		if inUse {
			return Project{}, fmt.Errorf("workspace %q is already registered", workspace)
		}
	}
	p = Project{
		ID:            projectID(repo),
		Name:          filepath.Base(repo),
		RepoPath:      repo,
		WorkspacePath: workspace,
		CreatedAt:     now,
		UpdatedAt:     now,
		LastOpenedAt:  now,
	}
	if _, err := tx.Exec(`INSERT INTO projects (id, name, repo_path, workspace_path, created_at, updated_at, last_opened_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, p.ID, p.Name, p.RepoPath, p.WorkspacePath, p.CreatedAt, p.UpdatedAt, p.LastOpenedAt); err != nil {
		return Project{}, fmt.Errorf("register project: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Project{}, err
	}
	return p, nil
}

// Get returns a project by its stable ID.
func (c *Catalog) Get(id string) (Project, error) {
	return get(c.db, id)
}

// List returns most recently opened projects first.
func (c *Catalog) List() ([]Project, error) {
	rows, err := c.db.Query(`SELECT id, name, repo_path, workspace_path, created_at, updated_at, last_opened_at
		FROM projects ORDER BY last_opened_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	var projects []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.RepoPath, &p.WorkspacePath, &p.CreatedAt, &p.UpdatedAt, &p.LastOpenedAt); err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func get(q queryer, value string) (Project, error) {
	var p Project
	err := q.QueryRow(`SELECT id, name, repo_path, workspace_path, created_at, updated_at, last_opened_at
		FROM projects WHERE repo_path = ? OR id = ?`, value, value).
		Scan(&p.ID, &p.Name, &p.RepoPath, &p.WorkspacePath, &p.CreatedAt, &p.UpdatedAt, &p.LastOpenedAt)
	return p, err
}

func workspaceInUse(tx *sql.Tx, workspace string) (bool, error) {
	var exists bool
	err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM projects WHERE workspace_path = ?)`, workspace).Scan(&exists)
	return exists, err
}

func legacyCompatible(workspace, repo string) (bool, error) {
	control := filepath.Join(workspace, "control.sqlite")
	if _, err := os.Stat(control); errors.Is(err, os.ErrNotExist) {
		return true, nil
	} else if err != nil {
		return false, fmt.Errorf("stat legacy workspace: %w", err)
	}
	db, err := sql.Open("sqlite", control)
	if err != nil {
		return false, fmt.Errorf("open legacy workspace: %w", err)
	}
	defer db.Close()
	var conflict int
	err = db.QueryRow(`SELECT 1 FROM tasks WHERE repo_path <> '' AND repo_path <> ? LIMIT 1`, repo).Scan(&conflict)
	if errors.Is(err, sql.ErrNoRows) || missingTasks(err) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect legacy workspace: %w", err)
	}
	return false, nil
}

func missingTasks(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "no such table") || strings.Contains(err.Error(), "no such column"))
}

func canonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("canonicalize path: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}
	return filepath.Clean(abs), nil
}

func projectID(repo string) string {
	sum := sha256.Sum256([]byte(repo))
	return fmt.Sprintf("%x", sum)[:12]
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, s)
}
