package ctx

import (
	"sort"
	"testing"
)

func TestNewIdempotent(t *testing.T) {
	dir := t.TempDir()

	s1, err := New(dir)
	if err != nil {
		t.Fatalf("first New: %v", err)
	}
	defer s1.Close()

	// Re-opening the same workspace must succeed: the schema is IF NOT EXISTS
	// and the file already exists.
	s2, err := New(dir)
	if err != nil {
		t.Fatalf("second New: %v", err)
	}
	defer s2.Close()

	if _, err := s1.Index([]Doc{{Source: SourceKnowledge, Ref: "k1", Title: "idempotent", Body: "first"}}); err != nil {
		t.Fatalf("index after reopen: %v", err)
	}
}

func TestDeleteRemovesDocumentAndFTSProjection(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := s.Index([]Doc{{Source: SourceMemory, Ref: "memory/7", Title: "key", Body: "forget-me-needle"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(SourceMemory, "memory/7"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Search("forget-me-needle", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("deleted document remained searchable: %#v", got)
	}
}

func TestIndexInsertAndUpsert(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	docs := []Doc{
		{Source: SourceKnowledge, Ref: "design", Title: "router architecture", Body: "edge routing"},
		{Source: SourceCode, Ref: "main.go", Title: "main", Body: "package main"},
	}

	if n, err := s.Index(docs); err != nil {
		t.Fatalf("first Index: %v", err)
	} else if n != len(docs) {
		t.Fatalf("first Index wrote %d, want %d", n, len(docs))
	}

	// Re-indexing the same docs must not duplicate: search should return each
	// ref at most once.
	if n, err := s.Index(docs); err != nil {
		t.Fatalf("second Index: %v", err)
	} else if n != len(docs) {
		t.Fatalf("second Index wrote %d, want %d", n, len(docs))
	}

	got, err := s.Search("router", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	var designHits int
	for _, d := range got {
		if d.Ref == "design" {
			designHits++
		}
	}
	if designHits != 1 {
		t.Fatalf("design ref appeared %d times after re-index, want 1", designHits)
	}
}

func TestSearchRanksTitleAboveBodyAndSpansSources(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	docs := []Doc{
		// Title-only match: the term lives in the title, body is unrelated.
		{Source: SourceKnowledge, Ref: "title-hit", Title: "router architecture overview", Body: "an unrelated body with no term here"},
		// Body-only match: the term lives in the body, title is unrelated.
		{Source: SourceCode, Ref: "body-hit", Title: "misc unrelated title", Body: "the router dispatches requests"},
	}
	if _, err := s.Index(docs); err != nil {
		t.Fatalf("Index: %v", err)
	}

	got, err := s.Search("router", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d results, want 2", len(got))
	}
	if got[0].Ref != "title-hit" {
		t.Fatalf("expected title-hit ranked first, got %q", got[0].Ref)
	}
	if got[1].Ref != "body-hit" {
		t.Fatalf("expected body-hit ranked second, got %q", got[1].Ref)
	}

	// Results must span both sources.
	sources := map[Source]bool{}
	for _, d := range got {
		sources[d.Source] = true
	}
	if len(sources) != 2 {
		t.Fatalf("expected results from 2 sources, got %v", sources)
	}
}

func TestPacketWrapsSearchWithQuery(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	if _, err := s.Index([]Doc{
		{Source: SourceMemory, Ref: "m1", Title: "auth flow", Body: "how tokens are issued"},
		{Source: SourceTicket, Ref: "t9", Title: "fix auth bug", Body: "token expiry"},
	}); err != nil {
		t.Fatalf("Index: %v", err)
	}

	pkt, err := s.Packet("auth", 5)
	if err != nil {
		t.Fatalf("Packet: %v", err)
	}
	if pkt.Query != "auth" {
		t.Fatalf("pkt.Query = %q, want %q", pkt.Query, "auth")
	}
	if len(pkt.Items) == 0 {
		t.Fatal("packet has no items")
	}

	// limit bounds the result set.
	pktLimited, err := s.Packet("auth", 1)
	if err != nil {
		t.Fatalf("Packet limited: %v", err)
	}
	if len(pktLimited.Items) != 1 {
		t.Fatalf("limited packet has %d items, want 1", len(pktLimited.Items))
	}
}

func TestEmptyAndGarbageQueriesReturnNoResults(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	if _, err := s.Index([]Doc{{Source: SourceCode, Ref: "x", Title: "router", Body: "body"}}); err != nil {
		t.Fatalf("Index: %v", err)
	}

	cases := []string{"", "   ", "!!!", "@#$", "  ***  "}
	for _, q := range cases {
		got, err := s.Search(q, 10)
		if err != nil {
			t.Fatalf("Search(%q) error: %v", q, err)
		}
		if len(got) != 0 {
			t.Fatalf("Search(%q) = %v results, want 0", q, got)
		}
	}

	// Sanity: a real word still resolves once the corpus is in place.
	if got, err := s.Search("router", 10); err != nil || len(got) != 1 {
		t.Fatalf("Search(router) = %v, err=%v, want 1 result", got, err)
	}
}

func TestSearchReturnsDocsAcrossAllSources(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	// Same term in every source — search should surface each source.
	docs := []Doc{
		{Source: SourceKnowledge, Ref: "k", Title: "indexing", Body: "term"},
		{Source: SourceMemory, Ref: "m", Title: "indexing", Body: "term"},
		{Source: SourceCode, Ref: "c", Title: "indexing", Body: "term"},
		{Source: SourceTicket, Ref: "t", Title: "indexing", Body: "term"},
	}
	if _, err := s.Index(docs); err != nil {
		t.Fatalf("Index: %v", err)
	}

	got, err := s.Search("indexing", 50)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	seen := map[Source]bool{}
	for _, d := range got {
		seen[d.Source] = true
	}
	for _, want := range []Source{SourceKnowledge, SourceMemory, SourceCode, SourceTicket} {
		if !seen[want] {
			t.Errorf("source %q missing from results; got sources %v", want, sortedKeys(seen))
		}
	}
}

func sortedKeys(m map[Source]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, string(k))
	}
	sort.Strings(out)
	return out
}
