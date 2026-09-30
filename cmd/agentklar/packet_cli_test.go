package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/completion"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func TestPacketCLIInspectsExistingWorkspaceWithoutWrites(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTKLAR_DATA_ROOT", root)
	t.Chdir(t.TempDir())
	e, workspace, err := openEngine()
	if err != nil {
		t.Fatal(err)
	}
	if err = e.CreateTask(workflow.Task{ID: "T", Title: "recorded task"}); err != nil {
		t.Fatal(err)
	}
	e.DB().Close()
	catalogDB, err := readOnlyDB(filepath.Join(root, "catalog.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer catalogDB.Close()
	var before, after string
	if err = catalogDB.QueryRow(`SELECT last_opened_at FROM projects`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	err = run([]string{"task", "packet", "T"})
	os.Stdout = stdout
	w.Close()
	output, readErr := io.ReadAll(r)
	r.Close()
	if err != nil || readErr != nil {
		t.Fatalf("packet CLI: %v %v", err, readErr)
	}
	var p completion.Packet
	if err = json.Unmarshal(output, &p); err != nil || p.Task.ID != "T" || p.Task.HumanApproved {
		t.Fatalf("packet output %s: %v", output, err)
	}
	if err = catalogDB.QueryRow(`SELECT last_opened_at FROM projects`).Scan(&after); err != nil || before != after {
		t.Fatalf("retrieval updated registry: %q -> %q %v", before, after, err)
	}
	if _, err = os.Stat(filepath.Join(workspace, "context.sqlite")); !os.IsNotExist(err) {
		t.Fatalf("retrieval created context: %v", err)
	}
	readEngine, _, err := openPacketEngine()
	if err != nil {
		t.Fatal(err)
	}
	defer readEngine.DB().Close()
	if err = readEngine.AddComment("T", "agent", "note", "must fail"); err == nil {
		t.Fatal("CLI database handle permits writes")
	}
}

func TestPacketDoesNotInitializeMissingWorkspace(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("AGENTKLAR_DATA_ROOT", root)
	t.Chdir(t.TempDir())
	if err := run([]string{"task", "packet", "T"}); err == nil {
		t.Fatal("missing workspace must fail")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("read initialized workspace: %v", err)
	}
}
