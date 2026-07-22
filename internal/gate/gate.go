// Package gate runs the Completion Review and Auto QA stages.
//
// Quick lane: ONE deterministic runner invocation records both the
// Completion Review and the Auto QA result, then the task moves to User
// Approval. No reviewer or QA model session is spent (spec §11, §10.7).
package gate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/quality"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// SlopFinding is an objective Slop Guard hit. Only objective rules block;
// subjective simplicity findings are warnings (spec §10.5).
type SlopFinding struct {
	Rule     string `json:"rule"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Evidence string `json:"evidence"`
	Blocking bool   `json:"blocking"`
}

// Gate executes the completion pipeline for one submission.
type Gate struct {
	Engine *workflow.Engine
	Runner *quality.Runner
	Config *quality.Config
}

// Result summarizes one gate execution.
type Result struct {
	Passed       bool
	Attestations []*quality.Attestation
	Slop         []SlopFinding
	Missing      []string // required levels with no declared recipe — visible gaps
}

// Run executes deterministic recipes, then objective Slop Guard, records
// machine-attested evidence, and advances the task. For Quick tasks the
// same attestations satisfy both the completion and QA records.
func (g *Gate) Run(ctx context.Context, taskID string, submissionID int64, lane contracts.Lane,
	changedPaths []string, diff string) (*Result, error) {

	maxLevel := "L2"
	if lane == contracts.LaneQuick {
		maxLevel = "L1"
	} else if lane == contracts.LaneMajor {
		maxLevel = "L3"
	}

	recipes := g.Config.Select(changedPaths, maxLevel)
	res := &Result{Passed: true}
	if len(recipes) == 0 {
		// An absent command is a visible gap, never a silent pass.
		res.Passed = false
		res.Missing = append(res.Missing, "no declared quality recipe matches the changed scope")
	}

	for _, rec := range recipes {
		att, err := g.Runner.Run(ctx, rec)
		if err != nil {
			return nil, fmt.Errorf("recipe %q: %w", rec.Name, err)
		}
		res.Attestations = append(res.Attestations, att)
		exit := att.ExitCode
		note := ""
		if att.TimedOut {
			note = "timed out"
		}
		// Machine-attested: agentklar executed this itself.
		if err := g.Engine.AddEvidence(taskID, submissionID, contracts.MachineAttested,
			rec.Level+":"+rec.Name, att.Command, att.WorkDir, &exit,
			att.LogPath, att.LogSHA256, att.Commit, note); err != nil {
			return nil, err
		}
		if !att.Passed() {
			res.Passed = false
		}
	}

	res.Slop = SlopGuard(diff)
	for _, f := range res.Slop {
		if f.Blocking {
			res.Passed = false
		}
	}

	result := contracts.ResultPass
	if !res.Passed {
		result = contracts.ResultFail
	}
	findings, _ := json.Marshal(res.Slop)

	// Completion Review record.
	if err := g.Engine.RecordReview(taskID, submissionID, "completion", result, "agentklar:deterministic", string(findings)); err != nil {
		return nil, err
	}
	if !res.Passed {
		return res, nil // task is now Changes Requested
	}

	// Quick lane reuses the same invocation for Auto QA — no extra model call.
	if err := g.Engine.RecordReview(taskID, submissionID, "qa", result, "agentklar:deterministic", "[]"); err != nil {
		return nil, err
	}
	return res, nil
}

// isUnconditionalPytestSkip flags @pytest.mark.skip but not skipif, which
// is a legitimate conditional skip.
func isUnconditionalPytestSkip(low string) bool {
	return strings.Contains(low, "@pytest.mark.skip") && !strings.Contains(low, "skipif")
}

// SlopGuard applies objective rules to a completed diff. Subjective
// simplicity advice is out of scope here by design.
//
// Language-specific rules are scoped to their file extensions: a
// JavaScript focused-test pattern appearing in a Go source file (for
// example inside this very function's rule literals) is not a focused JS
// test, and flagging it would be exactly the false positive that drives
// developers to bypass the gate. A line whose matched token sits inside a
// string or backtick literal is also skipped.
func SlopGuard(diff string) []SlopFinding {
	var out []SlopFinding
	lines := strings.Split(diff, "\n")
	file := ""
	for i, ln := range lines {
		if strings.HasPrefix(ln, "+++ b/") {
			file = strings.TrimPrefix(ln, "+++ b/")
			continue
		}
		if !strings.HasPrefix(ln, "+") || strings.HasPrefix(ln, "+++") {
			continue
		}
		added := strings.TrimSpace(strings.TrimPrefix(ln, "+"))
		low := strings.ToLower(added)
		ext := fileExt(file)

		flag := func(rule string) { out = append(out, SlopFinding{rule, file, i, added, true}) }

		// Placeholder markers — language-agnostic comment/marker forms.
		switch {
		case hasCode(low, "todo: implement"), hasCode(low, "not implemented"),
			low == "pass  # todo", hasCode(low, "unimplemented!()"):
			flag("placeholder-code")
			continue
		}

		// Silenced errors.
		switch ext {
		case ".py":
			if (hasCode(low, "except:") && !strings.Contains(low, "exception")) ||
				strings.Contains(low, "except exception: pass") {
				flag("silent-error-swallow")
				continue
			}
		case ".js", ".ts", ".jsx", ".tsx":
			if hasCode(low, "catch {}") || hasCode(low, "catch (e) {}") {
				flag("silent-error-swallow")
				continue
			}
		case ".go":
			if strings.HasPrefix(low, "_ = err") {
				flag("silent-error-swallow")
				continue
			}
		}

		// Focused/disabled tests — JS/TS and Python only.
		switch ext {
		case ".js", ".ts", ".jsx", ".tsx":
			if hasCode(low, "it.only(") || hasCode(low, "describe.only(") ||
				hasCode(low, "test.only(") || strings.HasPrefix(low, "fit(") ||
				strings.HasPrefix(low, "fdescribe(") {
				flag("focused-test")
				continue
			}
			if strings.HasPrefix(low, "xit(") || strings.HasPrefix(low, "xdescribe(") {
				flag("disabled-test")
				continue
			}
		case ".py":
			if isUnconditionalPytestSkip(low) {
				flag("disabled-test")
				continue
			}
		}

		// Weakened checks — CI and shell surfaces.
		if hasCode(low, "--no-verify") || hasCode(low, "ignore_errors=true") ||
			(strings.Contains(low, "|| true") && strings.Contains(strings.ToLower(file), "ci")) {
			flag("weakened-check")
		}
	}
	return out
}

func fileExt(path string) string {
	for i := len(path) - 1; i >= 0 && path[i] != '/'; i-- {
		if path[i] == '.' {
			return strings.ToLower(path[i:])
		}
	}
	return ""
}

// hasCode reports whether token appears in the line outside of a quoted or
// backtick string literal — a crude guard against flagging a pattern that
// is itself only data (a rule literal, a test fixture, documentation).
func hasCode(line, token string) bool {
	idx := strings.Index(line, token)
	if idx < 0 {
		return false
	}
	inSingle, inDouble, inBacktick := false, false, false
	for i := 0; i < idx; i++ {
		switch line[i] {
		case '\'':
			if !inDouble && !inBacktick {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle && !inBacktick {
				inDouble = !inDouble
			}
		case '`':
			if !inSingle && !inDouble {
				inBacktick = !inBacktick
			}
		}
	}
	return !inSingle && !inDouble && !inBacktick
}
