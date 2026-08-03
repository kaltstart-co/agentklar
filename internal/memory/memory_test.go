package memory

import (
	"strings"
	"testing"
	"time"
)

func TestNewIdempotent(t *testing.T) {
	dir := t.TempDir()

	s1, err := New(dir)
	if err != nil {
		t.Fatalf("first New: %v", err)
	}
	if _, err := s1.Remember("ns", "k", "v", "T1", "codex"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s1.Close()

	s2, err := New(dir)
	if err != nil {
		t.Fatalf("second New on same dir: %v", err)
	}
	defer s2.Close()

	got, err := s2.Get(1)
	if err != nil {
		t.Fatalf("Get after reopen: %v", err)
	}
	if got.Value != "v" {
		t.Fatalf("data not preserved across reopen: got value %q", got.Value)
	}
}

func TestRememberInsertThenUpsert(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	id1, err := s.Remember("ns", "k", "first value", "T1", "codex")
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	e1, err := s.Get(id1)
	if err != nil {
		t.Fatalf("get after insert: %v", err)
	}
	if e1.Value != "first value" || e1.Holder != "codex" || e1.SourceTask != "T1" {
		t.Fatalf("inserted row mismatch: %+v", e1)
	}

	// Sub-second precision makes the created_at bump observable without sleeps.
	time.Sleep(2 * time.Millisecond)

	id2, err := s.Remember("ns", "k", "second value", "T2", "gemini")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if id2 != id1 {
		t.Fatalf("upsert changed id: got %d want %d", id2, id1)
	}

	e2, err := s.Get(id2)
	if err != nil {
		t.Fatalf("get after upsert: %v", err)
	}
	if e2.Value != "second value" {
		t.Fatalf("value not updated: got %q", e2.Value)
	}
	if e2.Holder != "gemini" || e2.SourceTask != "T2" {
		t.Fatalf("provenance not updated: %+v", e2)
	}
	if e2.CreatedAt <= e1.CreatedAt {
		t.Fatalf("created_at not bumped: before %q after %q", e1.CreatedAt, e2.CreatedAt)
	}
}

func TestRecallFindsAndRanks(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	longID, err := s.Remember("research", "notes",
		"The database migration script completed successfully across every shard this morning.",
		"T1", "codex")
	if err != nil {
		t.Fatalf("insert long: %v", err)
	}
	denseID, err := s.Remember("research", "summary",
		"migration migration migration migration",
		"T1", "codex")
	if err != nil {
		t.Fatalf("insert dense: %v", err)
	}

	got, err := s.Recall("migration", 10)
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 matches, got %d", len(got))
	}

	// bm25 ranks the denser, shorter document ahead of the long one.
	if got[0].ID != denseID {
		t.Fatalf("expected dense doc first, got id %d (%q); order=%v", got[0].ID, got[0].Value, ids(got))
	}
	if got[1].ID != longID {
		t.Fatalf("expected long doc second, got id %d", got[1].ID)
	}
}

func TestRecallPrefixMatch(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	if _, err := s.Remember("ns", "k", "configurable token rotation policy", "T1", "codex"); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := s.Recall("config", 5)
	if err != nil {
		t.Fatalf("recall prefix: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("prefix query should match partial word: got %d", len(got))
	}
}

func TestRecallMalformedQueryDoesNotCrash(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	if _, err := s.Remember("ns", "k", "anything", "T1", "codex"); err != nil {
		t.Fatalf("insert: %v", err)
	}

	// Unbalanced quote is invalid FTS5; the contract is empty result, not panic.
	got, err := s.Recall(`"unbalanced`, 5)
	if err != nil {
		t.Fatalf("malformed query returned error %v (want nil)", err)
	}
	if got != nil {
		t.Fatalf("malformed query returned %d results (want nil)", len(got))
	}
}

func TestListFiltersAndOrders(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	if _, err := s.Remember("alpha", "k1", "alpha one", "T1", "codex"); err != nil {
		t.Fatalf("insert a1: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := s.Remember("beta", "k1", "beta one", "T2", "codex"); err != nil {
		t.Fatalf("insert b1: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := s.Remember("alpha", "k2", "alpha two", "T3", "codex"); err != nil {
		t.Fatalf("insert a2: %v", err)
	}

	all, err := s.List("")
	if err != nil {
		t.Fatalf("List all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(all))
	}
	// Newest first: k2 (alpha) written last.
	if all[0].Key != "k2" || all[0].Namespace != "alpha" {
		t.Fatalf("newest-first ordering wrong: %+v", all[0])
	}

	alpha, err := s.List("alpha")
	if err != nil {
		t.Fatalf("List alpha: %v", err)
	}
	if len(alpha) != 2 {
		t.Fatalf("expected 2 alpha entries, got %d", len(alpha))
	}
	for _, e := range alpha {
		if e.Namespace != "alpha" {
			t.Fatalf("namespace filter leaked %q", e.Namespace)
		}
	}
	// Within alpha, k2 was written after k1.
	if alpha[0].Key != "k2" || alpha[1].Key != "k1" {
		t.Fatalf("alpha ordering wrong: %+v", alpha)
	}
}

func TestGet(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	id, err := s.Remember("ns", "k", "fetch me", "T9", "gemini")
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	got, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ID != id || got.Value != "fetch me" || got.Holder != "gemini" || got.SourceTask != "T9" || got.Namespace != "ns" || got.Key != "k" {
		t.Fatalf("Get returned wrong row: %+v", got)
	}
	if got.CreatedAt == "" || !strings.Contains(got.CreatedAt, "T") {
		t.Fatalf("CreatedAt not a timestamp: %q", got.CreatedAt)
	}

	if _, err := s.Get(99999); err == nil {
		t.Fatal("Get on missing id should error")
	}
}

func TestForgetRemovesFromRecallAndList(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	id, err := s.Remember("ns", "k", "uniqueterm forgettable", "T1", "codex")
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	if got, _ := s.Recall("uniqueterm", 5); len(got) != 1 {
		t.Fatalf("precondition: recall should find 1, got %d", len(got))
	}

	if err := s.Forget(id); err != nil {
		t.Fatalf("Forget: %v", err)
	}

	if got, _ := s.Recall("uniqueterm", 5); len(got) != 0 {
		t.Fatalf("after Forget, recall should be empty: got %d", len(got))
	}
	if all, _ := s.List(""); len(all) != 0 {
		t.Fatalf("after Forget, list should be empty: got %d", len(all))
	}
	if _, err := s.Get(id); err == nil {
		t.Fatal("after Forget, Get should error")
	}
}

func ids(es []Entry) []int64 {
	out := make([]int64, len(es))
	for i, e := range es {
		out[i] = e.ID
	}
	return out
}
