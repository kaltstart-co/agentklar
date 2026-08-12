package main

import (
	"os"
	"path/filepath"
	"testing"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/knowledge"
	"github.com/kaltstart-co/agentklar/internal/memory"
)

func TestRebuildContextReplacesAllDerivedSources(t *testing.T) {
	repo, workspace := t.TempDir(), t.TempDir()
	ks, err := knowledge.New(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ks.Add(knowledge.KindConvention, "Current", "current knowledge needle"); err != nil {
		t.Fatal(err)
	}
	ms, err := memory.New(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ms.Remember("build", "current", "current memory needle", "TASK-1", "codex"); err != nil {
		t.Fatal(err)
	}
	_ = ms.Close()
	if err := os.WriteFile(filepath.Join(repo, "main.go"), []byte("package main\n// current code needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := akctx.New(workspace)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Index([]akctx.Doc{
		{Source: akctx.SourceKnowledge, Ref: "stale", Body: "stale knowledge needle"},
		{Source: akctx.SourceMemory, Ref: "stale", Body: "stale memory needle"},
		{Source: akctx.SourceCode, Ref: "stale", Body: "stale code needle"},
		{Source: akctx.SourceTicket, Ref: "keep", Body: "ticket preserved needle"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := rebuildContext(repo, workspace, store); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"stale knowledge", "stale memory", "stale code"} {
		if got, _ := store.Search(query, 10); len(got) != 0 {
			t.Fatalf("stale result remained for %q: %#v", query, got)
		}
	}
	for _, query := range []string{"current knowledge", "current memory", "current code", "ticket preserved"} {
		if got, _ := store.Search(query, 10); len(got) == 0 {
			t.Fatalf("current result missing for %q", query)
		}
	}
	if rebuilt, err := store.LastReindexedAt(); err != nil || rebuilt == "" {
		t.Fatalf("rebuild time=%q err=%v", rebuilt, err)
	}
	badWorkspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(badWorkspace, "memory.sqlite"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := rebuildContext(repo, badWorkspace, store); err == nil {
		t.Fatal("rebuild unexpectedly accepted unreadable memory")
	}
	if got, _ := store.Search("current memory", 10); len(got) == 0 {
		t.Fatal("failed collection changed the prior context generation")
	}
}
