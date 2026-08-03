package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/quality"
	"github.com/kaltstart-co/agentklar/internal/ticket"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// cmdTaskImport turns one interrogator ticket (Markdown, Definition-of-Done
// + Verification Steps) into an Agentklar task. The ticket's acceptance
// criteria become --criteria and its verification steps become --verify, so a
// well-specified ticket satisfies the Definition of Ready by construction.
//
// Verification commands wrapped in backticks inside §6 are proposed as
// quality recipes, but only ever to quality.proposed.toml — a sidecar the
// gate does NOT load. Nothing is auto-enabled; the human reviews and copies
// any they accept into quality.toml. (Quality package: "only declared
// recipes run; never translate prose into shell commands.")
func cmdTaskImport(args []string) error {
	fs := flag.NewFlagSet("task import", flag.ContinueOnError)
	lane := fs.String("lane", string(contracts.LaneStandard), "quick|standard|major")
	target := fs.String("target", string(contracts.TargetAny), "execution target")
	ready := fs.Bool("ready", false, "mark the task Ready after import (Definition of Ready enforced)")
	if err := fs.Parse(reorderFlags(args, map[string]bool{"ready": true})); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return fmt.Errorf("usage: agentklar task import <ticket.md> [--lane standard] [--ready]")
	}

	eng, _, err := openEngine()
	if err != nil {
		return err
	}
	tk, err := ticket.ParseFile(fs.Arg(0))
	if err != nil {
		return err
	}
	if tk.ID == "" {
		return fmt.Errorf("ticket has no id frontmatter: %s", fs.Arg(0))
	}
	if existing, err := eng.GetTask(tk.ID); err == nil && existing != nil {
		return fmt.Errorf("task %s already exists (state %s)", tk.ID, existing.State)
	}

	t := buildTask(tk, contracts.Lane(*lane), contracts.ExecutionTarget(*target))
	if err := eng.CreateTask(t); err != nil {
		return err
	}
	fmt.Printf("imported %s — %q [%s] with %d criterion(a)\n", tk.ID, tk.Title, t.Lane, len(t.Criteria))
	if len(t.Criteria) == 0 || t.Verification == "" {
		fmt.Printf("note: Definition of Ready not satisfied (criteria/verify missing); 'task ready' will be blocked\n")
	}

	if *ready {
		if err := eng.MarkReady(tk.ID, contracts.ActorHuman); err != nil {
			return fmt.Errorf("created %s but could not mark Ready: %w", tk.ID, err)
		}
		fmt.Printf("%s is Ready\n", tk.ID)
	}

	n, err := proposeRecipes(repoRoot(), []ticket.Ticket{*tk})
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not write recipe proposals: %v\n", err)
	} else if n > 0 {
		fmt.Printf("proposed %d recipe(s) to .agentklar/quality.proposed.toml — review and copy into quality.toml to enable\n", n)
	}
	fmt.Println("run 'agentklar tracker sync' to project new tasks onto the board")
	return nil
}

// cmdTaskImportPlan imports every Dev Task (tickets/TASK-*.md) under an
// interrogator project directory, computes execution waves from each ticket's
// dependencies, and — with --ready — marks Wave 1 (no-dep) tasks Ready so
// parallel agents can claim them. Dependent tasks stay Draft until their
// predecessors are Done.
func cmdTaskImportPlan(args []string) error {
	fs := flag.NewFlagSet("task import-plan", flag.ContinueOnError)
	lane := fs.String("lane", string(contracts.LaneStandard), "quick|standard|major")
	target := fs.String("target", string(contracts.TargetAny), "execution target")
	ready := fs.Bool("ready", false, "mark Wave-1 (no-dependency) tasks Ready")
	if err := fs.Parse(reorderFlags(args, map[string]bool{"ready": true})); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return fmt.Errorf("usage: agentklar task import-plan <project-dir> [--lane standard] [--ready]")
	}
	root := fs.Arg(0)

	ticketsDir := filepath.Join(root, "tickets")
	if _, err := os.Stat(ticketsDir); err != nil {
		return fmt.Errorf("no tickets/ directory under %s: %w", root, err)
	}
	entries, err := os.ReadDir(ticketsDir)
	if err != nil {
		return err
	}
	var tks []ticket.Ticket
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "TASK-") || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		tk, err := ticket.ParseFile(filepath.Join(ticketsDir, e.Name()))
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: skipping %s: %v\n", e.Name(), err)
			continue
		}
		if tk.ID == "" {
			fmt.Fprintf(os.Stderr, "warning: skipping %s (no id)\n", e.Name())
			continue
		}
		tks = append(tks, *tk)
	}
	if len(tks) == 0 {
		return fmt.Errorf("no TASK-*.md dev-task tickets under %s", ticketsDir)
	}
	// Stable order by ID for repeatable output.
	sort.Slice(tks, func(i, j int) bool { return tks[i].ID < tks[j].ID })

	eng, _, err := openEngine()
	if err != nil {
		return err
	}
	repo := repoRoot()
	created, skipped := 0, 0
	for i := range tks {
		tk := &tks[i]
		if existing, err := eng.GetTask(tk.ID); err == nil && existing != nil {
			skipped++
			continue
		}
		t := buildTask(tk, contracts.Lane(*lane), contracts.ExecutionTarget(*target))
		if err := eng.CreateTask(t); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not create %s: %v\n", tk.ID, err)
			skipped++
			continue
		}
		created++
	}
	fmt.Printf("imported %d task(s) from %s (%d skipped)\n", created, root, skipped)

	waves := ticket.ComputeWaves(tks)
	for i, w := range waves {
		if i == 0 {
			fmt.Printf("Wave %d (parallel-safe, no deps): %s\n", i+1, strings.Join(w, ", "))
		} else {
			fmt.Printf("Wave %d (after Wave %d): %s\n", i+1, i, strings.Join(w, ", "))
		}
	}
	if len(waves) > 0 {
		fmt.Println("branches per ticket (suggested_branch):")
		for i := range tks {
			if tks[i].Branch != "" {
				fmt.Printf("  %s → %s\n", tks[i].ID, tks[i].Branch)
			}
		}
	}

	if *ready && len(waves) > 0 {
		for _, id := range waves[0] {
			if err := eng.MarkReady(id, contracts.ActorHuman); err != nil {
				fmt.Fprintf(os.Stderr, "warning: %s not marked Ready: %v\n", id, err)
				continue
			}
			fmt.Printf("%s is Ready (Wave 1)\n", id)
		}
	}

	n, err := proposeRecipes(repo, tks)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not write recipe proposals: %v\n", err)
	} else if n > 0 {
		fmt.Printf("proposed %d recipe(s) to .agentklar/quality.proposed.toml — review and copy into quality.toml to enable\n", n)
	}
	fmt.Println("run 'agentklar tracker sync' to project new tasks onto the board")
	return nil
}

// buildTask maps an interrogator ticket onto a workflow.Task.
func buildTask(t *ticket.Ticket, lane contracts.Lane, target contracts.ExecutionTarget) workflow.Task {
	tt := workflow.Task{
		ID:           t.ID,
		Title:        t.Title,
		Project:      filepath.Base(repoRoot()),
		RepoPath:     repoRoot(),
		Lane:         lane,
		Target:       target,
		Verification: joinVerification(t),
		Criteria:     append([]string(nil), t.Criteria...),
	}
	if t.Objective != "" {
		tt.Objective = t.Objective
	} else if t.Summary != "" {
		tt.Objective = t.Summary
	}
	return tt
}

// joinVerification condenses §6 lines into the single Verification string
// Agentklar stores. We keep them human-readable; commands stay inline in
// backticks so both the model and the recipe proposer can find them.
func joinVerification(t *ticket.Ticket) string {
	if len(t.Verification) == 0 {
		return ""
	}
	return strings.Join(t.Verification, "; ")
}

var (
	backtickRe = regexp.MustCompile("`([^`]+)`")
	cmdGoodRe  = regexp.MustCompile(`^[A-Za-z0-9._/:-]+$`)
)

// proposeRecipes extracts commands the author explicitly wrapped in backticks
// inside each ticket's Verification section and appends them as [[recipe]]
// blocks to .agentklar/quality.proposed.toml. That sidecar is NOT loaded by
// the gate (quality.Load reads quality.toml only), so this never enables a
// command — it only drafts proposals for human review.
func proposeRecipes(repoRoot string, tks []ticket.Ticket) (int, error) {
	// Load anything already proposed so re-runs accumulate, not clobber.
	qpath := filepath.Join(repoRoot, ".agentklar", "quality.proposed.toml")
	var existing quality.Config
	_, _ = toml.DecodeFile(qpath, &existing) // best-effort; ignore missing/empty

	byName := map[string]quality.Recipe{}
	for _, r := range existing.Recipes {
		byName[r.Name] = r
	}
	seenCmd := map[string]bool{}
	for _, r := range existing.Recipes {
		seenCmd[r.Command+" "+strings.Join(r.Args, " ")] = true
	}

	added := 0
	for _, tk := range tks {
		for _, line := range tk.Verification {
			for _, m := range backtickRe.FindAllStringSubmatch(line, -1) {
				cmd := strings.TrimSpace(m[1])
				fields := strings.Fields(cmd)
				if len(fields) == 0 || !cmdGoodRe.MatchString(fields[0]) {
					continue
				}
				full := strings.Join(fields, " ")
				if seenCmd[full] {
					continue
				}
				seenCmd[full] = true
				name := recipeName(tk.ID, fields[0])
				byName[name] = quality.Recipe{
					Name: name, Level: "L1",
					Command: fields[0], Args: fields[1:],
					TimeoutSecs: 300,
				}
				added++
			}
		}
	}
	if added == 0 && len(existing.Recipes) > 0 {
		return 0, nil // nothing new; leave the file as-is
	}

	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)

	if err := os.MkdirAll(filepath.Dir(qpath), 0o755); err != nil {
		return 0, err
	}
	var b strings.Builder
	b.WriteString("# Proposed quality recipes — DRAFT ONLY. The gate loads quality.toml, not this file.\n")
	b.WriteString("# Review each command, then copy the ones you accept into .agentklar/quality.toml.\n\n")
	for _, n := range names {
		r := byName[n]
		b.WriteString("[[recipe]]\n")
		fmt.Fprintf(&b, "name = %q\n", r.Name)
		fmt.Fprintf(&b, "level = %q\n", valueOr(r.Level, "L1"))
		fmt.Fprintf(&b, "command = %q\n", r.Command)
		if len(r.Args) > 0 {
			b.WriteString("args = [")
			for i, a := range r.Args {
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%q", a)
			}
			b.WriteString("]\n")
		}
		if r.TimeoutSecs > 0 {
			fmt.Fprintf(&b, "timeout_seconds = %d\n", r.TimeoutSecs)
		}
		b.WriteString("\n")
	}
	if err := os.WriteFile(qpath, []byte(b.String()), 0o644); err != nil {
		return 0, err
	}
	return added, nil
}

func recipeName(taskID, command string) string {
	slug := func(s string) string {
		return strings.Map(func(r rune) rune {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
				return r
			}
			return '-'
		}, s)
	}
	return slug(taskID) + "-" + slug(filepath.Base(command))
}

func valueOr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// reorderFlags reorders args so every flag (and its value) precedes the
// positional arguments. Go's flag package stops parsing at the first
// non-flag, so "import ticket.md --ready" would otherwise drop --ready.
// boolFlags is the set of flag names that do NOT consume the next token.
func reorderFlags(args []string, boolFlags map[string]bool) []string {
	var flags, positionals []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if len(a) > 1 && a[0] == '-' {
			flags = append(flags, a)
			name := strings.TrimLeft(a, "-")
			hasEq := strings.IndexByte(name, '=') >= 0
			if !hasEq && !boolFlags[name] {
				if i+1 < len(args) {
					i++
					flags = append(flags, args[i])
				}
			}
			continue
		}
		positionals = append(positionals, a)
	}
	return append(flags, positionals...)
}
