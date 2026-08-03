// Package ticket parses interrogator-produced Jira-style ticket markdown into
// a structured form the Agentklar bridge can turn into workflow tasks.
//
// The contract is the one documented in the interrogator skill's "Markdown
// Ticket Template": a YAML-like frontmatter block between --- fences, followed
// by numbered ## sections (Objective, Scope, Design Decisions, Algorithm,
// Definition of Done, Verification Steps, Tests, Documentation, Dev Agent
// Instructions, Dev Comments).
//
// The parser is intentionally dependency-free and understands only the flat
// key set the template emits. It does not evaluate arbitrary YAML; unknown
// frontmatter keys are ignored. Section detection matches on the heading
// title text (case-insensitive) and tolerates the leading "N." index, so it
// keeps working if the template renumbers sections.
package ticket

import (
	"bufio"
	"os"
	"sort"
	"strings"
)

// Ticket is the parsed, agentklar-relevant subset of one interrogator ticket.
type Ticket struct {
	SourceFile string // file this was parsed from (empty when parsed from a string)

	// Frontmatter.
	ID           string
	Type         string // Epic | Story | Task
	Title        string
	Summary      string
	Epic         string
	Parent       string
	Dependencies []string
	Parallel     bool
	Branch       string // suggested_branch
	Priority     string

	// Body sections.
	Objective    string
	ScopeIn      []string
	ScopeOut     []string
	Criteria     []string // §5 Definition of Done, checkbox/bullet text with the AC-n: prefix stripped
	Verification []string // §6 Verification Steps, raw lines (may contain `commands`)
	Tests        []string // §7 Tests Required

	// RawLines is the full body (without frontmatter), for debugging/display.
	RawBody string
}

// ParseFile reads and parses a ticket file.
func ParseFile(path string) (*Ticket, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	t, err := Parse(string(data))
	if err != nil {
		return nil, err
	}
	t.SourceFile = path
	return t, nil
}

// Parse parses ticket markdown from a string.
func Parse(src string) (*Ticket, error) {
	front, body, ok := splitFrontmatter(src)
	t := &Ticket{RawBody: body}
	if ok {
		applyFrontmatter(t, front)
	}
	parseBody(t, body)
	return t, nil
}

// splitFrontmatter separates a leading "---\n...\n---" block from the body.
// Returns (frontmatter, body, true) when present, else ("", src, false).
func splitFrontmatter(src string) (front, body string, ok bool) {
	s := src
	// A leading fence may follow a UTF-8 BOM or leading newlines.
	s = strings.TrimLeft(s, "\n\r")
	if !strings.HasPrefix(s, "---") {
		return "", src, false
	}
	// Walk past the opening fence line.
	rest := s[3:]
	if !strings.HasPrefix(rest, "\n") && !strings.HasPrefix(rest, "\r") {
		return "", src, false
	}
	rest = strings.TrimLeft(rest, "\n\r")
	// Find the closing fence on its own line.
	lines := strings.Split(rest, "\n")
	closeIdx := -1
	for i, ln := range lines {
		if strings.TrimSpace(ln) == "---" || strings.TrimSpace(ln) == "..." {
			closeIdx = i
			break
		}
	}
	if closeIdx < 0 {
		return "", src, false
	}
	front = strings.Join(lines[:closeIdx], "\n")
	body = strings.Join(lines[closeIdx+1:], "\n")
	return front, body, true
}

// applyFrontmatter parses the flat key: value set the template emits. It
// understands scalar values and one inline array form (key: [a, b, c]).
func applyFrontmatter(t *Ticket, front string) {
	sc := bufio.NewScanner(strings.NewReader(front))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		ln := sc.Text()
		// Skip blank lines and section markers (frontmatter is flat here).
		trimmed := strings.TrimSpace(ln)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, val, ok := strings.Cut(ln, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		val = unquote(val)
		switch key {
		case "id":
			t.ID = val
		case "type":
			t.Type = val
		case "title":
			t.Title = val
		case "summary":
			t.Summary = val
		case "epic":
			t.Epic = noneToEmpty(val)
		case "parent":
			t.Parent = noneToEmpty(val)
		case "dependencies":
			t.Dependencies = parseList(val)
		case "parallel":
			t.Parallel = parseBool(val)
		case "suggested_branch":
			t.Branch = noneToEmpty(val)
		case "priority":
			t.Priority = val
		}
	}
}

// parseBody walks the ## headings and routes each section's lines.
func parseBody(t *Ticket, body string) {
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var section string      // normalized current section key
	var pendingScope string // "in" | "out" within a scope section
	for sc.Scan() {
		raw := sc.Text()
		ln := raw

		// Detect a level-2 heading: "## 5. Definition of Done (Acceptance Criteria)".
		if h, ok := headingTitle(ln); ok {
			section = classifySection(h)
			pendingScope = ""
			continue
		}
		// Level-3+ headings end the current section's special handling.
		if strings.HasPrefix(strings.TrimSpace(ln), "#") {
			section = ""
			continue
		}

		switch section {
		case "objective":
			// First non-blank paragraph only.
			if strings.TrimSpace(ln) == "" {
				if t.Objective != "" {
					section = "" // first paragraph captured
				}
				continue
			}
			if t.Objective == "" {
				t.Objective = strings.TrimSpace(ln)
			} else {
				t.Objective += " " + strings.TrimSpace(ln)
			}

		case "scope":
			trimmed := strings.TrimSpace(ln)
			switch {
			case strings.HasPrefix(strings.ToLower(trimmed), "**in scope"):
				pendingScope = "in"
				continue
			case strings.HasPrefix(strings.ToLower(trimmed), "**out of scope"):
				pendingScope = "out"
				continue
			case strings.HasPrefix(trimmed, "**In:**"), strings.HasPrefix(trimmed, "**Out:**"):
				pendingScope = map[bool]string{true: "in", false: "out"}[strings.HasPrefix(trimmed, "**In:**")]
				continue
			}
			if item, ok := bulletItem(trimmed); ok {
				switch pendingScope {
				case "in":
					t.ScopeIn = append(t.ScopeIn, item)
				case "out":
					t.ScopeOut = append(t.ScopeOut, item)
				}
			}

		case "criteria":
			if item, ok := checkboxItem(strings.TrimSpace(ln)); ok {
				// Acceptance criteria are human-readable prose; strip any
				// inline backticks the author used for emphasis. (Commands
				// are kept verbatim in the Verification section instead.)
				t.Criteria = append(t.Criteria, stripBackticks(item))
			}

		case "verification":
			if item, ok := numberedOrBulletItem(strings.TrimSpace(ln)); ok {
				t.Verification = append(t.Verification, item)
			}

		case "tests":
			if item, ok := bulletItem(strings.TrimSpace(ln)); ok {
				t.Tests = append(t.Tests, item)
			}
		}
	}
}

// headingTitle returns the title text of a "## ..." heading (with any leading
// "N." index stripped) and whether the line was a level-2 heading.
func headingTitle(line string) (string, bool) {
	s := strings.TrimSpace(line)
	if !strings.HasPrefix(s, "## ") || strings.HasPrefix(s, "### ") {
		return "", false
	}
	s = strings.TrimPrefix(s, "## ")
	s = strings.TrimSpace(s)
	// Strip a leading index like "5. " or "5.1 ".
	if dot := strings.Index(s, ". "); dot > 0 && dot < 4 {
		s = strings.TrimSpace(s[dot+1:])
	}
	return s, true
}

// classifySection maps a heading title to an internal section key.
func classifySection(title string) string {
	t := strings.ToLower(title)
	switch {
	case strings.HasPrefix(t, "objective"):
		return "objective"
	case strings.HasPrefix(t, "scope"):
		return "scope"
	case strings.Contains(t, "definition of done") || strings.Contains(t, "acceptance criteria"):
		return "criteria"
	case strings.HasPrefix(t, "verification"):
		return "verification"
	case strings.Contains(t, "test"):
		return "tests"
	}
	return ""
}

// checkboxItem parses a "- [ ] AC-3: foo" line into "foo". Returns ok=false
// for blank lines, headings, or non-checkbox lines.
func checkboxItem(line string) (string, bool) {
	s := line
	for _, pre := range []string{"- [ ]", "- [x]", "- [X]", "- [ ]"} {
		if strings.HasPrefix(s, pre) {
			s = strings.TrimSpace(s[len(pre):])
			break
		}
	}
	if s == line { // no checkbox prefix consumed
		// Also accept plain bullets used inside a DoD.
		if item, ok := bulletItem(line); ok {
			return stripACPrefix(item), true
		}
		return "", false
	}
	return stripACPrefix(s), true
}

// stripBackticks removes inline `code` backticks. Used for human-readable
// acceptance-criteria text where backticks are only emphasis.
func stripBackticks(s string) string {
	return strings.ReplaceAll(s, "`", "")
}

// stripACPrefix removes a leading "AC-12:" marker the template emits.
func stripACPrefix(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "AC-") {
		if c := strings.Index(s, ":"); c > 0 {
			s = strings.TrimSpace(s[c+1:])
		}
	}
	return s
}

// bulletItem parses a "- foo" or "* foo" line into "foo".
func bulletItem(line string) (string, bool) {
	s := strings.TrimSpace(line)
	if strings.HasPrefix(s, "- ") {
		return strings.TrimSpace(s[2:]), true
	}
	if strings.HasPrefix(s, "* ") {
		return strings.TrimSpace(s[2:]), true
	}
	return "", false
}

// numberedOrBulletItem parses "1. foo" or "- foo" into "foo".
func numberedOrBulletItem(line string) (string, bool) {
	s := strings.TrimSpace(line)
	if item, ok := bulletItem(s); ok {
		return item, true
	}
	// "12. foo"
	if len(s) > 0 && s[0] >= '0' && s[0] <= '9' {
		if dot := strings.Index(s, ". "); dot > 0 {
			return strings.TrimSpace(s[dot+2:]), true
		}
	}
	return "", false
}

// parseList accepts "[a, b, c]", "a, b", "none", or "[]" and returns the
// trimmed, non-empty items with "none" dropped.
func parseList(val string) []string {
	val = strings.TrimSpace(val)
	val = strings.TrimPrefix(val, "[")
	val = strings.TrimSuffix(val, "]")
	if val == "" || strings.EqualFold(val, "none") {
		return nil
	}
	var out []string
	for _, part := range strings.Split(val, ",") {
		part = unquote(strings.TrimSpace(part))
		if part != "" && !strings.EqualFold(part, "none") {
			out = append(out, part)
		}
	}
	return out
}

func parseBool(val string) bool {
	v := strings.ToLower(strings.TrimSpace(val))
	return v == "true" || v == "yes" || v == "1"
}

func noneToEmpty(val string) string {
	if strings.EqualFold(strings.TrimSpace(val), "none") {
		return ""
	}
	return val
}

func unquote(val string) string {
	v := strings.TrimSpace(val)
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}

// ComputeWaves returns execution waves (topological layers) from each ticket's
// dependencies. Wave 1 = tickets with no dependencies; each later wave's
// tickets depend only on tickets in earlier waves. Unresolved dependencies
// (deps not present in the set) are ignored so an import still produces a
// usable plan. On a dependency cycle the walk stops and returns the layers
// resolved so far.
func ComputeWaves(tks []Ticket) [][]string {
	idSet := map[string]bool{}
	for _, t := range tks {
		idSet[t.ID] = true
	}
	deps := map[string][]string{}
	for _, t := range tks {
		for _, d := range t.Dependencies {
			if idSet[d] {
				deps[t.ID] = append(deps[t.ID], d)
			}
		}
	}
	done := map[string]bool{}
	var waves [][]string
	for len(done) < len(tks) {
		var wave []string
		for _, t := range tks {
			if done[t.ID] {
				continue
			}
			ready := true
			for _, d := range deps[t.ID] {
				if !done[d] {
					ready = false
					break
				}
			}
			if ready {
				wave = append(wave, t.ID)
			}
		}
		if len(wave) == 0 {
			break // cycle / unresolved; stop to avoid infinite loop
		}
		sort.Strings(wave)
		for _, id := range wave {
			done[id] = true
		}
		waves = append(waves, wave)
	}
	return waves
}
