// Package knowledge manages the project's shared, versioned knowledge layer:
// markdown files under <repo>/.agentklar/knowledge/ that multiple AI agents
// append to and a human reviews through git diffs.
//
// The store covers four kinds of knowledge:
//
//   - decisions: Architecture Decision Records, one numbered file per record.
//   - conventions, glossary, runbook: single markdown files, each a list of
//     "## "-prefixed titled sections.
//
// It is intentionally file-based and dependency-free (stdlib only). Protected
// workflow state still lives in control.sqlite; this package owns prose that
// is meant to be read by humans and cited by agents.
package knowledge

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Kind classifies a knowledge entry. Only the four listed values are valid;
// any other value is rejected by every method that takes a Kind.
type Kind string

const (
	KindDecision   Kind = "decision"   // one ADR file under decisions/
	KindConvention Kind = "convention" // a section in conventions.md
	KindGlossary   Kind = "glossary"   // a section in glossary.md
	KindRunbook    Kind = "runbook"    // a section in runbook.md
)

// Entry is one addressable piece of knowledge.
type Entry struct {
	Kind  Kind
	Slug  string // filename stem (decision) or derived from title (section)
	Title string
	Body  string
	Path  string // absolute path to the backing file
}

// Store is the knowledge layer for one repo. It holds only the resolved repo
// root; all state lives on disk under .agentklar/knowledge/.
type Store struct {
	root string
}

// sectionFile maps a section kind to its single backing file. Decisions are
// not section-based and have no entry here; callers must reject them.
func sectionFile(kind Kind) (string, error) {
	switch kind {
	case KindConvention:
		return "conventions.md", nil
	case KindGlossary:
		return "glossary.md", nil
	case KindRunbook:
		return "runbook.md", nil
	default:
		return "", fmt.Errorf("knowledge: kind %q has no section file", kind)
	}
}

func validateKind(kind Kind) error {
	switch kind {
	case KindDecision, KindConvention, KindGlossary, KindRunbook:
		return nil
	default:
		return fmt.Errorf("knowledge: unknown kind %q", kind)
	}
}

// stub content seeded on first init. Each is an h1 title plus a one-line cue
// so appended "## " sections render correctly from the start.
var stubs = map[Kind]string{
	KindConvention: "# Conventions\n\nShared conventions for this project. Each convention is a `## `-prefixed section below.\n",
	KindGlossary:   "# Glossary\n\nShared terms and definitions. Each term is a `## `-prefixed section below.\n",
	KindRunbook:    "# Runbook\n\nOperational procedures and recovery steps. Each entry is a `## `-prefixed section below.\n",
}

// New opens the knowledge store for repoRoot, creating the directory tree and
// default stub files if absent. It is idempotent: existing files are never
// modified, so re-running init on a populated layer is a no-op.
func New(repoRoot string) (*Store, error) {
	abs, err := filepath.Abs(repoRoot)
	if err != nil {
		return nil, err
	}
	s := &Store{root: abs}
	if err := os.MkdirAll(s.Dir(), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(s.Dir(), "decisions"), 0o755); err != nil {
		return nil, err
	}
	for kind, content := range stubs {
		fn, _ := sectionFile(kind) // kind is a stub key; safe
		if err := writeStubIfAbsent(filepath.Join(s.Dir(), fn), content); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Dir returns the absolute knowledge directory path, suitable for an
// `agentklar open knowledge` target.
func (s *Store) Dir() string {
	return filepath.Join(s.root, ".agentklar", "knowledge")
}

// AddDecision writes an Architecture Decision Record as a new numbered file
// under decisions/. Numbering is monotonic across calls and zero-padded to
// four digits (0001-, 0002-, ...). The slug is derived from the title. It
// returns that slug.
func (s *Store) AddDecision(title, context, decision string) (string, error) {
	slug := slugify(title)
	if slug == "" {
		return "", fmt.Errorf("knowledge: decision title produces empty slug: %q", title)
	}
	id, err := s.nextDecisionID()
	if err != nil {
		return "", err
	}
	name := fmt.Sprintf("%04d-%s.md", id, slug)
	path := filepath.Join(s.Dir(), "decisions", name)
	if err := os.WriteFile(path, []byte(renderDecision(id, slug, title, context, decision)), 0o644); err != nil {
		return "", err
	}
	return slug, nil
}

// renderDecision formats an ADR document. The header table records the
// provenance fields a reviewer expects; the two sections carry the body.
func renderDecision(id int, _, title, context, decision string) string {
	date := time.Now().UTC().Format(time.RFC3339)
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", title)
	b.WriteString("| Field | Value |\n")
	b.WriteString("|---|---|\n")
	fmt.Fprintf(&b, "| id | %04d |\n", id)
	fmt.Fprintf(&b, "| title | %s |\n", mdEscapeTable(title))
	fmt.Fprintf(&b, "| date | %s |\n", date)
	b.WriteString("| status | Decided |\n\n")
	fmt.Fprintf(&b, "## Context\n\n%s\n\n", bodyBlock(context))
	fmt.Fprintf(&b, "## Decision\n\n%s\n", bodyBlock(decision))
	return b.String()
}

// Add appends a titled "## " section to the file backing a non-decision kind
// and returns the slug derived from the title. KindDecision is rejected.
func (s *Store) Add(kind Kind, title, body string) (string, error) {
	fn, err := sectionFile(kind)
	if err != nil {
		return "", err
	}
	slug := slugify(title)
	if slug == "" {
		return "", fmt.Errorf("knowledge: %s title produces empty slug: %q", kind, title)
	}
	path := filepath.Join(s.Dir(), fn)
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	trimmed := bytes.TrimRight(existing, "\n")
	var out bytes.Buffer
	if len(trimmed) > 0 {
		out.Write(trimmed)
		out.WriteString("\n\n") // close the last line + blank separator
	}
	fmt.Fprintf(&out, "## %s\n\n%s\n", title, bodyBlock(body))
	if err := os.WriteFile(path, out.Bytes(), 0o644); err != nil {
		return "", err
	}
	return slug, nil
}

// List enumerates every entry across all knowledge files. Decisions come
// first (sorted by filename, i.e. by id), then each section file's sections
// in file order.
func (s *Store) List() ([]Entry, error) {
	var entries []Entry

	decDir := filepath.Join(s.Dir(), "decisions")
	if names, err := os.ReadDir(decDir); err == nil {
		var decs []string
		for _, de := range names {
			if !de.IsDir() && strings.HasSuffix(de.Name(), ".md") {
				decs = append(decs, de.Name())
			}
		}
		sort.Strings(decs)
		for _, name := range decs {
			path := filepath.Join(decDir, name)
			data, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			entries = append(entries, Entry{
				Kind:  KindDecision,
				Slug:  decisionSlug(name),
				Title: parseDecisionTitle(string(data)),
				Body:  string(data),
				Path:  path,
			})
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}

	for _, kind := range []Kind{KindConvention, KindGlossary, KindRunbook} {
		fn, _ := sectionFile(kind)
		data, err := os.ReadFile(filepath.Join(s.Dir(), fn))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, err
		}
		path := filepath.Join(s.Dir(), fn)
		for _, sec := range parseSections(string(data)) {
			entries = append(entries, Entry{
				Kind:  kind,
				Slug:  slugify(sec.title),
				Title: sec.title,
				Body:  sec.body,
				Path:  path,
			})
		}
	}
	return entries, nil
}

// Read returns the full entry (title + body) for a kind+slug pair. Decisions
// are matched by the slug portion of their filename; sections by the slug
// derived from their heading.
func (s *Store) Read(kind Kind, slug string) (Entry, error) {
	if err := validateKind(kind); err != nil {
		return Entry{}, err
	}
	if kind == KindDecision {
		return s.readDecision(slug)
	}
	fn, err := sectionFile(kind)
	if err != nil {
		return Entry{}, err
	}
	path := filepath.Join(s.Dir(), fn)
	data, err := os.ReadFile(path)
	if err != nil {
		return Entry{}, err
	}
	for _, sec := range parseSections(string(data)) {
		if slugify(sec.title) == slug {
			return Entry{
				Kind:  kind,
				Slug:  slug,
				Title: sec.title,
				Body:  sec.body,
				Path:  path,
			}, nil
		}
	}
	return Entry{}, fmt.Errorf("knowledge: no %s section with slug %q", kind, slug)
}

func (s *Store) readDecision(slug string) (Entry, error) {
	decDir := filepath.Join(s.Dir(), "decisions")
	names, err := os.ReadDir(decDir)
	if err != nil {
		return Entry{}, err
	}
	var matched []string
	for _, de := range names {
		if !de.IsDir() && strings.HasSuffix(de.Name(), ".md") && decisionSlug(de.Name()) == slug {
			matched = append(matched, de.Name())
		}
	}
	if len(matched) == 0 {
		return Entry{}, fmt.Errorf("knowledge: no decision with slug %q", slug)
	}
	// Lowest-numbered match wins; ties are pathological (two same-titled ADRs).
	sort.Strings(matched)
	path := filepath.Join(decDir, matched[0])
	data, err := os.ReadFile(path)
	if err != nil {
		return Entry{}, err
	}
	return Entry{
		Kind:  KindDecision,
		Slug:  slug,
		Title: parseDecisionTitle(string(data)),
		Body:  string(data),
		Path:  path,
	}, nil
}

// nextDecisionID scans existing decision files and returns one greater than
// the maximum leading number, so numbering is monotonic even if files were
// removed or added out of order.
func (s *Store) nextDecisionID() (int, error) {
	decDir := filepath.Join(s.Dir(), "decisions")
	names, err := os.ReadDir(decDir)
	if err != nil {
		return 0, err
	}
	max := 0
	for _, de := range names {
		if !strings.HasSuffix(de.Name(), ".md") {
			continue
		}
		if n := leadingNumber(strings.TrimSuffix(de.Name(), ".md")); n > max {
			max = n
		}
	}
	return max + 1, nil
}

// writeStubIfAbsent creates path with content only when it does not already
// exist. This is what makes New idempotent.
func writeStubIfAbsent(path, content string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// section is one "## "-prefixed block parsed out of a section file.
type section struct {
	title string
	body  string
}

// parseSections splits markdown into the h1 document title (ignored) and the
// list of level-2 sections. It is tolerant: level-3+ headings stay in the
// body, and a file with no sections yields nil.
func parseSections(content string) []section {
	lines := strings.Split(content, "\n")
	var sections []section
	var cur *section
	flush := func() {
		if cur == nil {
			return
		}
		cur.body = strings.TrimSpace(cur.body)
		sections = append(sections, *cur)
		cur = nil
	}
	for _, ln := range lines {
		// A level-2 heading is exactly "## " at line start; "### " differs at
		// the third byte, so this single prefix check excludes deeper levels.
		if t := strings.TrimLeft(ln, " \t"); strings.HasPrefix(t, "## ") {
			flush()
			cur = &section{title: strings.TrimSpace(t[len("## "):])}
			continue
		}
		if cur != nil {
			cur.body += ln + "\n"
		}
	}
	flush()
	return sections
}

// parseDecisionTitle extracts a decision's title, preferring the first "# "
// heading and falling back to a "title:" line or table row for files written
// by other tools. A leading "NNNN - " / "NNNN: " index is tolerated.
func parseDecisionTitle(content string) string {
	for _, ln := range strings.Split(content, "\n") {
		t := strings.TrimLeft(ln, " \t")
		if strings.HasPrefix(t, "# ") && !strings.HasPrefix(t, "## ") {
			return stripLeadingIndex(strings.TrimSpace(t[len("# "):]))
		}
	}
	// Frontmatter-style "title: <value>".
	for _, ln := range strings.Split(content, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(strings.ToLower(t), "title:") {
			if v := unquote(strings.TrimSpace(t[len("title:"):])); v != "" {
				return v
			}
		}
	}
	// Table row "| title | <value> |".
	for _, ln := range strings.Split(content, "\n") {
		t := strings.TrimSpace(ln)
		if !strings.HasPrefix(t, "|") {
			continue
		}
		cells := splitTableRow(t)
		if len(cells) >= 2 && strings.EqualFold(cells[0], "title") {
			return cells[1]
		}
	}
	return ""
}

// decisionSlug strips the leading "NNNN-" index from a decision filename to
// recover the slug portion. "0001-use-sqlite.md" -> "use-sqlite".
func decisionSlug(filename string) string {
	stem := strings.TrimSuffix(filename, ".md")
	i := 0
	for i < len(stem) && stem[i] >= '0' && stem[i] <= '9' {
		i++
	}
	if i < len(stem) && (stem[i] == '-' || stem[i] == '_') {
		i++ // drop exactly one separator so the slug's own hyphens survive
	}
	return stem[i:]
}

// leadingNumber parses the integer prefix of a stem, returning 0 when absent.
func leadingNumber(stem string) int {
	n := 0
	for _, r := range stem {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// stripLeadingIndex removes a leading "NNNN", "NNNN - ", or "NNNN: " prefix
// from a heading title.
func stripLeadingIndex(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return s
	}
	rest := strings.TrimLeft(s[i:], " \t")
	if len(rest) > 0 && (rest[0] == '-' || rest[0] == ':') {
		rest = strings.TrimLeft(rest[1:], " \t")
	}
	return rest
}

// slugify produces a deterministic, URL-safe slug: lowercased, non-alphanums
// collapsed to single hyphens, trimmed, capped near 60 chars.
func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	inWord := false
	for _, r := range s {
		isAlnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlnum {
			b.WriteRune(r)
			inWord = true
			continue
		}
		if inWord {
			b.WriteByte('-')
			inWord = false
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 60 {
		out = strings.TrimRight(out[:60], "-")
	}
	return out
}

// bodyBlock normalizes a free-form body to a single trailing newline so
// rendered sections are uniformly separated.
func bodyBlock(s string) string {
	return strings.TrimRight(s, "\n")
}

// mdEscapeTable escapes pipe characters so titles containing "|" do not break
// the header table layout.
func mdEscapeTable(s string) string {
	return strings.ReplaceAll(s, "|", "\\|")
}

func splitTableRow(row string) []string {
	row = strings.Trim(row, "|")
	parts := strings.Split(row, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}
