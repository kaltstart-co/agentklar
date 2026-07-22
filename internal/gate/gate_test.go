package gate

import "testing"

func diffAdding(file string, lines ...string) string {
	out := "+++ b/" + file + "\n"
	for _, l := range lines {
		out += "+" + l + "\n"
	}
	return out
}

// Objective rules block; there is no subjective simplicity rule here.
func TestSlopGuardBlocksObjectiveViolations(t *testing.T) {
	cases := []struct {
		name string
		file string
		line string
		rule string
	}{
		{"placeholder", "src/a.go", "// TODO: implement this properly", "placeholder-code"},
		{"swallow js", "src/a.ts", "catch (e) {}", "silent-error-swallow"},
		{"swallow py", "src/a.py", "except: pass", "silent-error-swallow"},
		{"swallow go", "src/a.go", "_ = err", "silent-error-swallow"},
		{"unconditional pytest skip", "test_a.py", "@pytest.mark.skip", "disabled-test"},
		{"focused test", "a.test.ts", "it.only('works', () => {})", "focused-test"},
		{"bypassed hook", "ci/deploy.sh", "git commit --no-verify", "weakened-check"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			findings := SlopGuard(diffAdding(c.file, c.line))
			if len(findings) == 0 {
				t.Fatalf("expected a finding for %q", c.line)
			}
			if findings[0].Rule != c.rule {
				t.Fatalf("expected rule %q, got %q", c.rule, findings[0].Rule)
			}
			if !findings[0].Blocking {
				t.Fatalf("rule %q must block", c.rule)
			}
		})
	}
}

// Ordinary code must not trip the guard: false positives are what make
// developers bypass the gate.
func TestSlopGuardIgnoresOrdinaryCode(t *testing.T) {
	diff := diffAdding("internal/a.go",
		"func Add(a, b int) int {",
		"    return a + b",
		"}",
		"// Handle returns an error when the input is invalid.",
		"if err != nil {",
		"    return fmt.Errorf(\"parse: %w\", err)",
		"}",
	)
	if f := SlopGuard(diff); len(f) != 0 {
		t.Fatalf("false positive on ordinary code: %+v", f)
	}
}

// Legitimate conditional skips must not be flagged — this is the
// false-positive class that drives developers to bypass the gate.
func TestSlopGuardAllowsConditionalSkips(t *testing.T) {
	ok := []struct{ file, line string }{
		{"a_test.go", `t.Skip("set AGENTKLAR_VIKUNJA_URL to run integration tests")`},
		{"a_test.go", `if testing.Short() { t.Skip("skipping in short mode") }`},
		{"test_a.py", `@pytest.mark.skipif(sys.platform == "win32", reason="posix only")`},
		// A JS focused-test pattern quoted inside a Go rule literal or fixture.
		{"gate.go", `hasCode(low, "it.only(") || hasCode(low, "describe.only(")`},
		{"gate_test.go", `{"focused test", "a.test.ts", "it.only('works')", "focused-test"},`},
	}
	for _, c := range ok {
		if f := SlopGuard(diffAdding(c.file, c.line)); len(f) != 0 {
			t.Fatalf("legitimate line wrongly flagged: %s %q → %+v", c.file, c.line, f)
		}
	}
}

// Removed lines are not inspected — only what the change adds.
func TestSlopGuardIgnoresRemovedLines(t *testing.T) {
	diff := "+++ b/a.go\n-// TODO: implement this properly\n-catch (e) {}\n"
	if f := SlopGuard(diff); len(f) != 0 {
		t.Fatalf("removed lines flagged: %+v", f)
	}
}
