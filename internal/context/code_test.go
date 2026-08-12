package ctx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mustWrite creates all parent dirs and writes content to path, failing the
// test on any error.
func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestIndexCodeIndexesTextAndSkipsNoise(t *testing.T) {
	root := t.TempDir()

	// A .go file with a distinctive searchable token.
	goBody := "package main\n\n// DistinctiveKangaroo routes requests.\nfunc main() {}\n"
	mustWrite(t, filepath.Join(root, "cmd", "app", "main.go"), goBody)

	// A markdown doc — also a legitimate text file to index.
	mustWrite(t, filepath.Join(root, "docs", "guide.md"), "# Guide\n\nUnrelated prose about routing.\n")

	// A binary file: 8000 bytes with a NUL in the leading sniff window.
	bin := make([]byte, 8000)
	bin[100] = 0 // NUL byte
	mustWrite(t, filepath.Join(root, "asset.bin"), string(bin))

	// A file under node_modules/ — must be skipped entirely.
	mustWrite(t, filepath.Join(root, "node_modules", "pkg", "index.js"),
		"module.exports = DistinctiveKangaroo;\n")

	// An oversized (>256 KiB) but otherwise text file — must be skipped.
	mustWrite(t, filepath.Join(root, "big.txt"), strings.Repeat("x", 256*1024+1))

	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	n, err := s.IndexCode(root)
	if err != nil {
		t.Fatalf("IndexCode: %v", err)
	}
	// Only main.go and guide.md survive: the .bin (binary), node_modules/
	// (skipped dir) and big.txt (oversized) must all be excluded.
	if n != 2 {
		t.Fatalf("IndexCode indexed %d files, want 2", n)
	}

	// Searching the distinctive token from the .go file returns exactly one
	// SourceCode doc with a forward-slash Ref. (The node_modules copy of the
	// token must not appear, proving that dir was pruned.)
	got, err := s.Search("DistinctiveKangaroo", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Search returned %d docs, want 1 (node_modules not pruned?)", len(got))
	}
	doc := got[0]
	if doc.Source != SourceCode {
		t.Errorf("doc.Source = %q, want %q", doc.Source, SourceCode)
	}
	if want := "cmd/app/main.go"; doc.Ref != want {
		t.Errorf("doc.Ref = %q, want %q", doc.Ref, want)
	}
	if doc.Title != "main.go" {
		t.Errorf("doc.Title = %q, want %q", doc.Title, "main.go")
	}

	// Re-running must be idempotent: upsert by (source, ref) leaves one copy.
	if _, err := s.IndexCode(root); err != nil {
		t.Fatalf("second IndexCode: %v", err)
	}
	got2, err := s.Search("DistinctiveKangaroo", 10)
	if err != nil {
		t.Fatalf("Search after re-index: %v", err)
	}
	if len(got2) != 1 {
		t.Fatalf("Search after re-index returned %d docs, want 1", len(got2))
	}
}

func TestIndexCodeSkipsAgentklarEvidence(t *testing.T) {
	root := t.TempDir()

	// A normal source file under .agentklar/knowledge is walked like any text
	// file; only .agentklar/evidence must be pruned.
	mustWrite(t, filepath.Join(root, ".agentklar", "knowledge", "adr.md"),
		"# ADR\n\nTraceTokenEvidence decisions.\n")
	// Evidence logs (even text) live under .agentklar/evidence and must skip.
	mustWrite(t, filepath.Join(root, ".agentklar", "evidence", "run-1.log"),
		"TraceTokenEvidence should NOT be indexed from here.\n")

	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	if _, err := s.IndexCode(root); err != nil {
		t.Fatalf("IndexCode: %v", err)
	}

	// The distinctive token appears in both files; only the knowledge copy
	// (not the evidence log) should be indexed.
	got, err := s.Search("TraceTokenEvidence", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Search returned %d docs, want 1 (.agentklar/evidence not pruned?)", len(got))
	}
	if got[0].Ref != ".agentklar/knowledge/adr.md" {
		t.Errorf("doc.Ref = %q, want .agentklar/knowledge/adr.md", got[0].Ref)
	}
}

func TestIndexCodeEmptyRepoReturnsZero(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	n, err := s.IndexCode(t.TempDir())
	if err != nil {
		t.Fatalf("IndexCode empty repo: %v", err)
	}
	if n != 0 {
		t.Fatalf("IndexCode empty repo indexed %d, want 0", n)
	}
}

func TestCollectCodeFailsWhenRepoIsUnavailable(t *testing.T) {
	if _, err := CollectCode(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing repository collection unexpectedly succeeded")
	}
}
