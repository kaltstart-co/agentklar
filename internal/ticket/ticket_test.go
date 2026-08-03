package ticket

import (
	"strings"
	"testing"
)

// A ticket that mirrors the interrogator "Markdown Ticket Template".
const sampleTicket = `---
id: TASK-001-001-001
type: Task
title: Parser handles empty input
summary: Return a zero value instead of crashing on empty input.
epic: EPIC-001
parent: STORY-001-001
dependencies: [TASK-001-001-002, TASK-001-001-003]
parallel: true
suggested_branch: feat/epic-001/parser-empty
priority: High
---

# TASK-001-001-001 — Parser handles empty input

| Field | Value |
|---|---|
| Type | Task |

## 1. Objective
Make the parser robust to empty input so callers never see a panic. This
matters because downstream services forward blank payloads on health pings.

## 2. Scope
**In scope:**
- empty string input
- nil byte slice

**Out of scope:**
- malformed input (covered by TASK-001-001-002)

## 3. Design Decisions
- Return zero value — simplest; alternative was an error.

## 4. Algorithm / Pseudocode
` + "```" + `text
if len(in) == 0 { return zero }
` + "```" + `

## 5. Definition of Done (Acceptance Criteria)
Each item must be verifiable by the implementing agent:
- [ ] AC-1: Parse("") returns a zero Document with no error
- [ ] AC-2: ` + "`go test ./...`" + ` passes
- [ ] AC-3: linter passes with ` + "`golangci-lint run`" + `

## 6. Verification Steps
How the agent proves the DoD (commands, test names, expected output):
1. Run ` + "`go test ./...`" + ` and confirm all suites pass
2. Run ` + "`golangci-lint run`" + ` and confirm zero findings

## 7. Tests Required
- Unit: parser_empty_test.go

## 9. Dev Agent Instructions (MANDATORY)
Implement per sections 1-4.

## 10. Dev Comments
<!-- Agents append implementation traces here. -->
- ...
`

func TestParse_Frontmatter(t *testing.T) {
	tk, err := Parse(sampleTicket)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if tk.ID != "TASK-001-001-001" {
		t.Errorf("ID = %q", tk.ID)
	}
	if tk.Title != "Parser handles empty input" {
		t.Errorf("Title = %q", tk.Title)
	}
	if tk.Epic != "EPIC-001" || tk.Parent != "STORY-001-001" {
		t.Errorf("Epic=%q Parent=%q", tk.Epic, tk.Parent)
	}
	if !tk.Parallel {
		t.Error("Parallel = false, want true")
	}
	if tk.Branch != "feat/epic-001/parser-empty" {
		t.Errorf("Branch = %q", tk.Branch)
	}
	if tk.Priority != "High" {
		t.Errorf("Priority = %q", tk.Priority)
	}
	wantDeps := []string{"TASK-001-001-002", "TASK-001-001-003"}
	if len(tk.Dependencies) != 2 {
		t.Fatalf("Dependencies = %v, want %v", tk.Dependencies, wantDeps)
	}
	for i := range wantDeps {
		if tk.Dependencies[i] != wantDeps[i] {
			t.Errorf("Dependencies[%d] = %q, want %q", i, tk.Dependencies[i], wantDeps[i])
		}
	}
}

func TestParse_Sections(t *testing.T) {
	tk, err := Parse(sampleTicket)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !strings.Contains(tk.Objective, "robust to empty input") {
		t.Errorf("Objective = %q", tk.Objective)
	}
	wantIn := []string{"empty string input", "nil byte slice"}
	if len(tk.ScopeIn) != len(wantIn) {
		t.Fatalf("ScopeIn = %v, want %v", tk.ScopeIn, wantIn)
	}
	for i := range wantIn {
		if tk.ScopeIn[i] != wantIn[i] {
			t.Errorf("ScopeIn[%d] = %q, want %q", i, tk.ScopeIn[i], wantIn[i])
		}
	}
	if len(tk.ScopeOut) != 1 || !strings.Contains(tk.ScopeOut[0], "malformed input") {
		t.Errorf("ScopeOut = %v", tk.ScopeOut)
	}

	wantAC := []string{
		"Parse(\"\") returns a zero Document with no error",
		"go test ./... passes",
		"linter passes with golangci-lint run",
	}
	if len(tk.Criteria) != len(wantAC) {
		t.Fatalf("Criteria = %#v, want %#v", tk.Criteria, wantAC)
	}
	for i := range wantAC {
		if tk.Criteria[i] != wantAC[i] {
			t.Errorf("Criteria[%d] = %q, want %q", i, tk.Criteria[i], wantAC[i])
		}
	}

	// Verification lines preserve the backticked commands the recipe proposer relies on.
	joined := strings.Join(tk.Verification, " ")
	if !strings.Contains(joined, "`go test ./...`") {
		t.Errorf("Verification lost backticked command: %v", tk.Verification)
	}
	if !strings.Contains(joined, "`golangci-lint run`") {
		t.Errorf("Verification lost backticked command: %v", tk.Verification)
	}
}

func TestParse_NoFrontmatter(t *testing.T) {
	// A ticket without frontmatter must still parse sections without error.
	src := `# X — Y

## 1. Objective
Do a thing.

## 5. Definition of Done (Acceptance Criteria)
- [ ] AC-1: thing works
`
	tk, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if tk.ID != "" {
		t.Errorf("ID = %q, want empty", tk.ID)
	}
	if len(tk.Criteria) != 1 || tk.Criteria[0] != "thing works" {
		t.Errorf("Criteria = %v", tk.Criteria)
	}
}

func TestParseList(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"[a, b, c]", []string{"a", "b", "c"}},
		{"none", nil},
		{"[none]", nil},
		{"", nil},
		{"single", []string{"single"}},
		{`["quoted", plain]`, []string{"quoted", "plain"}},
	}
	for _, c := range cases {
		got := parseList(c.in)
		if len(got) != len(c.want) {
			t.Errorf("parseList(%q) = %v, want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("parseList(%q)[%d] = %q, want %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestComputeWaves(t *testing.T) {
	tks := []Ticket{
		{ID: "A"},
		{ID: "B", Dependencies: []string{"A"}},
		{ID: "C", Dependencies: []string{"A"}},
		{ID: "D", Dependencies: []string{"B", "C"}},
		{ID: "E", Dependencies: []string{"EXTERNAL"}}, // external dep ignored
	}
	waves := ComputeWaves(tks)
	if len(waves) < 3 {
		t.Fatalf("waves = %v, want at least 3 layers", waves)
	}
	// Wave 1 must be the no-dep set A and E (E's only dep is external/ignored).
	want := map[string]bool{"A": true, "E": true}
	for _, id := range waves[0] {
		if !want[id] {
			t.Errorf("wave1 has %q, want only A/E", id)
		}
	}
	for _, id := range waves[0] {
		delete(want, id)
	}
	if len(want) != 0 {
		t.Errorf("wave1 missing %v", want)
	}

	// D must be in a strictly later wave than both B and C.
	waveOf := func(id string) int {
		for i, w := range waves {
			for _, x := range w {
				if x == id {
					return i
				}
			}
		}
		return -1
	}
	if waveOf("D") <= waveOf("B") || waveOf("D") <= waveOf("C") {
		t.Errorf("D not after B and C: D=%d B=%d C=%d", waveOf("D"), waveOf("B"), waveOf("C"))
	}
}
