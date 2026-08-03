package knowledge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNew_Idempotent(t *testing.T) {
	root := t.TempDir()

	s1, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Default section files and the decisions/ subdir must exist.
	for _, fn := range []string{"conventions.md", "glossary.md", "runbook.md"} {
		if _, err := os.Stat(filepath.Join(s1.Dir(), fn)); err != nil {
			t.Errorf("missing stub %s: %v", fn, err)
		}
	}
	if _, err := os.Stat(filepath.Join(s1.Dir(), "decisions")); err != nil {
		t.Errorf("missing decisions/ dir: %v", err)
	}

	// Corrupt a stub: a second New must NOT overwrite it.
	stubPath := filepath.Join(s1.Dir(), "conventions.md")
	if err := os.WriteFile(stubPath, []byte("# My Custom Conventions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root); err != nil {
		t.Fatalf("second New: %v", err)
	}
	got, err := os.ReadFile(stubPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "# My Custom Conventions\n" {
		t.Errorf("New overwrote existing stub: %q", got)
	}
}

func TestAddDecision_IncrementingAndStableSlug(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	slug1, err := s.AddDecision("Use SQLite for State", "We need durability.", "Use modernc sqlite.")
	if err != nil {
		t.Fatalf("AddDecision #1: %v", err)
	}
	if slug1 != "use-sqlite-for-state" {
		t.Errorf("slug1 = %q", slug1)
	}
	if _, err := os.Stat(filepath.Join(s.Dir(), "decisions", "0001-use-sqlite-for-state.md")); err != nil {
		t.Errorf("0001 file missing: %v", err)
	}

	slug2, err := s.AddDecision("Use SQLite for State", "repeat title", "same slug, next id")
	if err != nil {
		t.Fatalf("AddDecision #2: %v", err)
	}
	// Same title -> same slug; numbering still advances.
	if slug2 != "use-sqlite-for-state" {
		t.Errorf("slug2 = %q, want %q", slug2, "use-sqlite-for-state")
	}
	if _, err := os.Stat(filepath.Join(s.Dir(), "decisions", "0002-use-sqlite-for-state.md")); err != nil {
		t.Errorf("0002 file missing: %v", err)
	}

	slug3, err := s.AddDecision("Adopt Worktrees", "x", "y")
	if err != nil {
		t.Fatalf("AddDecision #3: %v", err)
	}
	if slug3 != "adopt-worktrees" {
		t.Errorf("slug3 = %q", slug3)
	}
	if _, err := os.Stat(filepath.Join(s.Dir(), "decisions", "0003-adopt-worktrees.md")); err != nil {
		t.Errorf("0003 file missing: %v", err)
	}
}

func TestAddDecision_FormatsHeader(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddDecision("Drop Mongo", "ctx", "dec"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(s.Dir(), "decisions", "0001-drop-mongo.md"))
	if err != nil {
		t.Fatal(err)
	}
	doc := string(data)
	// Header provenance fields a reviewer expects.
	for _, want := range []string{"# Drop Mongo", "| id | 0001 |", "| title | Drop Mongo |", "| status | Decided |", "## Context", "## Decision"} {
		if !strings.Contains(doc, want) {
			t.Errorf("decision missing %q in:\n%s", want, doc)
		}
	}
	if !strings.Contains(doc, "20") || !strings.Contains(doc, "T") {
		t.Errorf("decision missing RFC3339 date in:\n%s", doc)
	}
}

func TestAdd_AppendsSection(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	slug, err := s.Add(KindConvention, "Branch Naming", "Always use `feat/` prefixes.")
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if slug != "branch-naming" {
		t.Errorf("slug = %q", slug)
	}

	e, err := s.Read(KindConvention, slug)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if e.Title != "Branch Naming" {
		t.Errorf("Title = %q", e.Title)
	}
	if !strings.Contains(e.Body, "`feat/` prefixes.") {
		t.Errorf("Body = %q", e.Body)
	}

	// A second append must not clobber the first.
	if _, err := s.Add(KindConvention, "Commit Style", "Conventional commits."); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(KindConvention, "branch-naming"); err != nil {
		t.Errorf("first section lost after second Add: %v", err)
	}
}

func TestList_BothKinds(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddDecision("Pick Go", "ctx", "dec"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(KindGlossary, "ADR", "Architecture Decision Record."); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(KindRunbook, "Restore DB", "Run the backup."); err != nil {
		t.Fatal(err)
	}

	entries, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := map[Kind]string{
		KindDecision: "pick-go",
		KindGlossary: "adr",
		KindRunbook:  "restore-db",
	}
	seen := map[Kind]string{}
	for _, e := range entries {
		if w, ok := want[e.Kind]; ok {
			if e.Slug == w {
				seen[e.Kind] = e.Slug
			}
		}
	}
	for kind, w := range want {
		if seen[kind] != w {
			t.Errorf("List missing %s/%s (got %q)", kind, w, seen[kind])
		}
	}

	// Decisions must come back sorted by id.
	var decSlugs []string
	for _, e := range entries {
		if e.Kind == KindDecision {
			decSlugs = append(decSlugs, e.Slug)
		}
	}
	if len(decSlugs) != 1 || decSlugs[0] != "pick-go" {
		t.Errorf("decision slugs = %v", decSlugs)
	}
}

func TestRead_FullBody(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	body := "First line.\n\nSecond paragraph with `code`."
	if _, err := s.Add(KindRunbook, "Deploy", body); err != nil {
		t.Fatal(err)
	}
	e, err := s.Read(KindRunbook, "deploy")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !strings.Contains(e.Body, "First line.") || !strings.Contains(e.Body, "Second paragraph with `code`") {
		t.Errorf("Body = %q", e.Body)
	}
	if !filepath.IsAbs(e.Path) {
		t.Errorf("Path not absolute: %q", e.Path)
	}

	// Missing slug errors.
	if _, err := s.Read(KindRunbook, "nope"); err == nil {
		t.Error("Read of missing slug returned nil error")
	}
}

func TestRead_Decision(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddDecision("Use Tokens", "ctx", "decide"); err != nil {
		t.Fatal(err)
	}
	e, err := s.Read(KindDecision, "use-tokens")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if e.Title != "Use Tokens" {
		t.Errorf("Title = %q", e.Title)
	}
	if !strings.Contains(e.Body, "## Decision") {
		t.Errorf("Body not the full document: %q", e.Body)
	}
}

func TestUnknownKind_Errors(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		fn   func() error
	}{
		{"add", func() error { _, err := s.Add(Kind("bogus"), "t", "b"); return err }},
		{"add_decision_kind", func() error { _, err := s.Add(KindDecision, "t", "b"); return err }},
		{"read", func() error { _, err := s.Read(Kind("bogus"), "t"); return err }},
	}
	for _, c := range cases {
		if err := c.fn(); err == nil {
			t.Errorf("%s: expected error for unknown kind", c.name)
		}
	}
}

func TestSlugify(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Use SQLite for State", "use-sqlite-for-state"},
		{"  spaced  ", "spaced"},
		{"A, B; C!", "a-b-c"},
		{"multi   space", "multi-space"},
		{"---leading-trailing---", "leading-trailing"},
		{"UPPER_Case", "upper-case"},
		{"café naïve", "caf-na-ve"}, // non-alnum collapses to hyphen
		{"", ""},
		{"!!!", ""},
		{strings.Repeat("a", 80), strings.Repeat("a", 60)},
	}
	for _, c := range cases {
		if got := slugify(c.in); got != c.want {
			t.Errorf("slugify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDecisionSlug(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"0001-use-sqlite.md", "use-sqlite"},
		{"0042-multi-word-slug.md", "multi-word-slug"},
		{"untitled.md", "untitled"}, // no leading number
		{"0007_no-dash.md", "no-dash"},
	}
	for _, c := range cases {
		if got := decisionSlug(c.in); got != c.want {
			t.Errorf("decisionSlug(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
