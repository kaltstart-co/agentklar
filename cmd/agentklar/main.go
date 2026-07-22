// Command agentklar is the development control-plane CLI for the
// Phase 0/1 vertical slice: workspace init, task shaping, the MCP server,
// the completion gate, and human approval via a trusted channel.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/gate"
	"github.com/kaltstart-co/agentklar/internal/mcp"
	"github.com/kaltstart-co/agentklar/internal/quality"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/tracker"
	"github.com/kaltstart-co/agentklar/internal/tracker/vikunja"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

const usage = `agentklar — agents that know what done means (dev build)

Usage:
  agentklar init                        Initialize a workspace for the current repo
  agentklar task new <id> <title>       Create a Draft task
  agentklar task ready <id>             Mark a task Ready (Definition of Ready enforced)
  agentklar task list                   List tasks
  agentklar task show <id>              Show a task with evidence and reviews
  agentklar gate <id>                   Run Completion Review + Auto QA for the latest submission
  agentklar approve <id>                Approve a task awaiting human approval (human channel)
  agentklar reject <id> <reason>        Reject a task awaiting human approval
  agentklar mcp                         Run the agent-facing MCP server on stdio
  agentklar doctor                      Report workspace health

Flags for 'task new':
  --lane quick|standard|major  --criteria "a;b;c"  --verify "how"  --target codex|gemini|any
`

func main() {
	if len(os.Args) < 2 {
		printBanner(os.Stdout)
		fmt.Print(usage)
		os.Exit(1)
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func workspaceDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	repo := repoRoot()
	id := sanitize(filepath.Base(repo))
	dir := filepath.Join(home, ".local", "share", "agentklar", "workspaces", id)
	return dir, os.MkdirAll(filepath.Join(dir, "evidence"), 0o755)
}

func repoRoot() string {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	return strings.TrimSpace(string(out))
}

func openEngine() (*workflow.Engine, string, error) {
	dir, err := workspaceDir()
	if err != nil {
		return nil, "", err
	}
	db, err := store.Open(filepath.Join(dir, "control.sqlite"))
	if err != nil {
		return nil, "", err
	}
	return workflow.New(db), dir, nil
}

func run(args []string) error {
	switch args[0] {
	case "init":
		return cmdInit()
	case "task":
		if len(args) < 2 {
			return fmt.Errorf("task requires a subcommand")
		}
		return cmdTask(args[1:])
	case "gate":
		if len(args) < 2 {
			return fmt.Errorf("gate requires a task id")
		}
		return cmdGate(args[1])
	case "approve":
		if len(args) < 2 {
			return fmt.Errorf("approve requires a task id")
		}
		return cmdDecide(args[1], true, "")
	case "reject":
		if len(args) < 3 {
			return fmt.Errorf("reject requires a task id and reason")
		}
		return cmdDecide(args[1], false, strings.Join(args[2:], " "))
	case "mcp":
		return cmdMCP()
	case "tracker":
		return cmdTracker(args[1:])
	case "reconcile":
		return cmdReconcile()
	case "doctor":
		return cmdDoctor()
	default:
		fmt.Print(usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func cmdInit() error {
	printBanner(os.Stdout)
	dir, err := workspaceDir()
	if err != nil {
		return err
	}
	if _, _, err := openEngineAt(dir); err != nil {
		return err
	}
	repo := repoRoot()
	qpath := filepath.Join(repo, ".agentklar", "quality.toml")
	if _, err := os.Stat(qpath); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(qpath), 0o755); err != nil {
			return err
		}
		// Propose only commands that plausibly exist; the user approves by
		// keeping them. Agentklar never asserts an undeclared command works.
		sample := `# Agentklar quality recipes — only declared commands ever run.
# Delete anything this project does not actually have.

[[recipe]]
name = "build"
level = "L0"
command = "go"
args = ["build", "./..."]
timeout_seconds = 120

[[recipe]]
name = "unit"
level = "L1"
command = "go"
args = ["test", "./..."]
timeout_seconds = 300
`
		if err := os.WriteFile(qpath, []byte(sample), 0o644); err != nil {
			return err
		}
		fmt.Printf("proposed %s — review and edit before use\n", qpath)
	}
	fmt.Printf("workspace ready: %s\nrepository: %s\n", dir, repo)
	return nil
}

func openEngineAt(dir string) (*workflow.Engine, string, error) {
	db, err := store.Open(filepath.Join(dir, "control.sqlite"))
	if err != nil {
		return nil, "", err
	}
	return workflow.New(db), dir, nil
}

func cmdTask(args []string) error {
	eng, _, err := openEngine()
	if err != nil {
		return err
	}
	switch args[0] {
	case "new":
		if len(args) < 3 {
			return fmt.Errorf("task new <id> <title> [flags]")
		}
		fs := flag.NewFlagSet("task new", flag.ContinueOnError)
		lane := fs.String("lane", string(contracts.LaneStandard), "quick|standard|major")
		criteria := fs.String("criteria", "", "semicolon-separated acceptance criteria")
		verify := fs.String("verify", "", "verification method")
		target := fs.String("target", string(contracts.TargetAny), "execution target")

		// Title words are everything before the first flag.
		var title []string
		rest := args[2:]
		for i, a := range rest {
			if strings.HasPrefix(a, "--") {
				rest = rest[i:]
				break
			}
			title = append(title, a)
			if i == len(rest)-1 {
				rest = nil
			}
		}
		if err := fs.Parse(rest); err != nil {
			return err
		}
		t := workflow.Task{
			ID: args[1], Title: strings.Join(title, " "),
			Project: filepath.Base(repoRoot()), RepoPath: repoRoot(),
			Lane: contracts.Lane(*lane), Target: contracts.ExecutionTarget(*target),
			Verification: *verify,
		}
		for _, c := range strings.Split(*criteria, ";") {
			if c = strings.TrimSpace(c); c != "" {
				t.Criteria = append(t.Criteria, c)
			}
		}
		// Project onto the tracker when one is connected, so the board
		// carries task content while control.sqlite owns workflow state.
		if _, dir, derr := openEngine(); derr == nil {
			if cfg, _ := vikunja.LoadConfig(dir); cfg != nil {
				desc := t.Objective
				if len(t.Criteria) > 0 {
					desc += "\n\nAcceptance criteria:\n- " + strings.Join(t.Criteria, "\n- ")
				}
				if tt, terr := cfg.Client().CreateTask(cfg.ProjectID, t.ID+": "+t.Title, desc); terr == nil {
					t.TrackerID = fmt.Sprintf("%d", tt.ID)
				} else {
					fmt.Fprintf(os.Stderr, "warning: tracker projection failed: %v\n", terr)
				}
			}
		}
		if err := eng.CreateTask(t); err != nil {
			return err
		}
		fmt.Printf("created %s [%s] in Draft with %d criteria", t.ID, t.Lane, len(t.Criteria))
		if t.TrackerID != "" {
			fmt.Printf(" (tracker #%s)", t.TrackerID)
		}
		fmt.Println()
		return nil

	case "ready":
		if len(args) < 2 {
			return fmt.Errorf("task ready <id>")
		}
		// Readiness approval is a human act performed at the terminal.
		if err := eng.MarkReady(args[1], contracts.ActorHuman); err != nil {
			return err
		}
		fmt.Printf("%s is Ready\n", args[1])
		return nil

	case "list":
		tasks, err := eng.ListAll()
		if err != nil {
			return err
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tLANE\tSTATE\tTITLE")
		for _, t := range tasks {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", t.ID, t.Lane, t.State, t.Title)
		}
		return w.Flush()

	case "show":
		if len(args) < 2 {
			return fmt.Errorf("task show <id>")
		}
		t, err := eng.GetTask(args[1])
		if err != nil {
			return err
		}
		b, _ := json.MarshalIndent(t, "", "  ")
		fmt.Println(string(b))
		ev, _ := eng.ListEvidence(args[1])
		if len(ev) > 0 {
			fmt.Println("\nEvidence:")
			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "PROVENANCE\tCRITERION\tEXIT\tLOG")
			for _, e := range ev {
				exit := "-"
				if e.ExitCode != nil {
					exit = fmt.Sprintf("%d", *e.ExitCode)
				}
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", e.Provenance, e.Criterion, exit, e.LogPath)
			}
			w.Flush()
		}
		return nil
	}
	return fmt.Errorf("unknown task subcommand %q", args[0])
}

func cmdGate(taskID string) error {
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	t, err := eng.GetTask(taskID)
	if err != nil {
		return err
	}
	sub, err := eng.LatestSubmission(taskID)
	if err != nil {
		return fmt.Errorf("no live submission for %s: %w", taskID, err)
	}
	cfg, err := quality.Load(t.RepoPath)
	if err != nil {
		return err
	}
	changed := changedPaths(t.RepoPath, sub.BaseCommit, sub.HeadCommit)
	diff := gitDiff(t.RepoPath, sub.BaseCommit, sub.HeadCommit)

	g := &gate.Gate{
		Engine: eng,
		Config: cfg,
		Runner: &quality.Runner{
			RepoRoot: t.RepoPath,
			LogDir:   filepath.Join(dir, "evidence", taskID),
			Commit:   sub.HeadCommit,
		},
	}
	res, err := g.Run(context.Background(), taskID, sub.ID, t.Lane, changed, diff)
	if err != nil {
		return err
	}
	for _, a := range res.Attestations {
		status := "PASS"
		if !a.Passed() {
			status = "FAIL"
		}
		fmt.Printf("%s  %-6s %-12s exit=%d  log=%s\n", status, a.Level, a.Recipe, a.ExitCode, a.LogPath)
	}
	for _, m := range res.Missing {
		fmt.Printf("GAP   %s\n", m)
	}
	for _, f := range res.Slop {
		kind := "warn"
		if f.Blocking {
			kind = "BLOCK"
		}
		fmt.Printf("%-5s slop/%s %s:%d %s\n", kind, f.Rule, f.File, f.Line, f.Evidence)
	}
	after, _ := eng.GetTask(taskID)
	fmt.Printf("\ngate: passed=%v → state=%s\n", res.Passed, after.State)
	if after.State == contracts.StateUserApproval {
		nonce, _, _ := eng.PendingApproval(taskID)
		// Post the approval prompt to the connected tracker as the service
		// account; the nonce reaches the human there, not through any agent.
		if cfg, _ := vikunja.LoadConfig(dir); cfg != nil && after.TrackerID != "" {
			var tid int64
			fmt.Sscanf(after.TrackerID, "%d", &tid)
			body := tracker.PendingApprovalComment(taskID, nonce, sub.HeadCommit, t.Criteria)
			if _, perr := cfg.Client().PostComment(tid, body); perr != nil {
				fmt.Fprintf(os.Stderr, "warning: could not post approval prompt: %v\n", perr)
			} else {
				fmt.Printf("\nposted approval prompt to tracker #%d — approve as %s in Vikunja, then run 'agentklar reconcile'\n",
					tid, cfg.HumanUser)
				return nil
			}
		}
		fmt.Println("\n" + tracker.PendingApprovalComment(taskID, nonce, sub.HeadCommit, t.Criteria))
	}
	return nil
}

// cmdDecide is the terminal human-approval channel for the dev build.
//
// NOTE (design §10.7): a plain CLI approve is NOT a trusted channel in the
// shipped product, because an agent with shell access could invoke it. It
// is available here only for the single-user dev slice, and it prints that
// warning every time so the limitation never becomes invisible.
func cmdDecide(taskID string, approve bool, reason string) error {
	eng, _, err := openEngine()
	if err != nil {
		return err
	}
	nonce, _, err := eng.PendingApproval(taskID)
	if err != nil {
		return fmt.Errorf("%s has no pending approval: %w", taskID, err)
	}
	decision := "rejected"
	if approve {
		decision = "approved"
	}
	if err := eng.ResolveApproval(taskID, nonce, approve, os.Getenv("USER"), "cli_dev"); err != nil {
		return err
	}
	if reason != "" {
		eng.AddComment(taskID, string(contracts.ActorHuman), "Change Request", reason)
	}
	t, _ := eng.GetTask(taskID)
	fmt.Printf("%s %s → %s\n", taskID, decision, t.State)
	fmt.Fprintln(os.Stderr,
		"warning: the dev CLI approval channel is not agent-proof; the shipped product requires "+
			"a nonce-bound tracker comment from your own account or a trusted client elicitation.")
	return nil
}

func cmdMCP() error {
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	srv := &mcp.Server{Engine: eng, Workspace: dir}
	return srv.Serve(os.Stdin, os.Stdout)
}

func cmdDoctor() error {
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	fmt.Printf("workspace:   %s\n", dir)
	fmt.Printf("repository:  %s\n", repoRoot())
	qpath := filepath.Join(repoRoot(), ".agentklar", "quality.toml")
	if cfg, err := quality.Load(repoRoot()); err == nil {
		fmt.Printf("recipes:     %d declared in %s\n", len(cfg.Recipes), qpath)
		for _, r := range cfg.Recipes {
			if _, err := exec.LookPath(r.Command); err != nil {
				fmt.Printf("  GAP  %-10s command %q not found on PATH\n", r.Name, r.Command)
			} else {
				fmt.Printf("  ok   %-10s %s %s\n", r.Name, r.Command, strings.Join(r.Args, " "))
			}
		}
	} else {
		fmt.Printf("recipes:     none (%v)\n", err)
	}
	tasks, err := eng.ListAll()
	if err != nil {
		return err
	}
	counts := map[contracts.State]int{}
	for _, t := range tasks {
		counts[t.State]++
	}
	fmt.Printf("tasks:       %d total\n", len(tasks))
	for st, n := range counts {
		fmt.Printf("  %-18s %d\n", st, n)
	}
	fmt.Printf("mcp methods: %d exposed, approval methods exposed: 0\n", len(contracts.MCPMethods))
	return nil
}

func changedPaths(repo, base, head string) []string {
	out, err := exec.Command("git", "-C", repo, "diff", "--name-only", base, head).Output()
	if err != nil {
		return nil
	}
	var paths []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			paths = append(paths, l)
		}
	}
	return paths
}

func gitDiff(repo, base, head string) string {
	out, err := exec.Command("git", "-C", repo, "diff", base, head).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, s)
}
