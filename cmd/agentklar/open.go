package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/knowledge"
	"github.com/kaltstart-co/agentklar/internal/notify"
	"github.com/kaltstart-co/agentklar/internal/quality"
	"github.com/kaltstart-co/agentklar/internal/tracker/vikunja"
)

// cmdOpen launches an Agentklar surface in the OS default: the connected
// board in the browser, the menu-bar app, or a workspace/config/recipe path
// in Finder. It is convenience plumbing — it never mutates state.
func cmdOpen(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: agentklar open board|app|workspace|config|quality")
	}
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	switch args[0] {
	case "board":
		cfg, err := vikunja.LoadConfig(dir)
		if err != nil || cfg == nil {
			return fmt.Errorf("no tracker connected; run 'agentklar tracker connect' first")
		}
		return openURL(boardURL(cfg.URL, cfg.ProjectID))
	case "app":
		return openApp()
	case "workspace":
		return openPath(dir)
	case "config":
		home, _ := os.UserHomeDir()
		cdir := filepath.Join(home, ".config", "agentklar")
		if _, err := os.Stat(cdir); err != nil {
			return fmt.Errorf("no agentklar config dir at %s; it is created when you add links.toml or connect a tracker", cdir)
		}
		return openPath(cdir)
	case "quality":
		qpath := filepath.Join(repoRoot(), ".agentklar", "quality.toml")
		if _, err := os.Stat(qpath); err != nil {
			return fmt.Errorf("no quality.toml at %s; run 'agentklar init' to propose one", qpath)
		}
		return openPath(qpath)
	case "knowledge":
		ks, err := knowledge.New(repoRoot())
		if err != nil {
			return err
		}
		return openPath(ks.Dir())
	case "docs":
		d := filepath.Join(repoRoot(), "docs")
		if _, err := os.Stat(d); err != nil {
			return fmt.Errorf("no docs/ at %s", d)
		}
		return openPath(d)
	case "memory", "context":
		// These are sqlite-backed; open the workspace so the human can see the
		// backing files. (The native UI at `agentklar ui` is the rich view.)
		_, d, err := openEngine()
		if err != nil {
			return err
		}
		return openPath(d)
	case "ui":
		// Launch the native UI server and pop the browser. This blocks (Ctrl-C
		// to stop) — `open ui` is the friendly front door to `agentklar ui`.
		return cmdUI([]string{"--open"})
	}
	_ = eng
	return fmt.Errorf("unknown open target %q (want: board|app|workspace|config|quality)", args[0])
}

// boardURL turns an API base URL (.../api/v1) into the human board URL.
func boardURL(apiURL string, projectID int64) string {
	base := strings.TrimSuffix(apiURL, "/")
	base = strings.TrimSuffix(base, "/api/v1")
	base = strings.TrimSuffix(base, "/api")
	return fmt.Sprintf("%s/projects/%d", base, projectID)
}

// trackerReachable does a short HTTP probe of the tracker API so status never
// claims a board is "connected" when its server is down. Any 1.5s-or-less
// response (even an error status) counts as reachable; a timeout/conn-refused
// does not.
func trackerReachable(apiURL string) bool {
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(strings.TrimRight(apiURL, "/") + "/info")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

// openApp launches the macOS menu-bar widget if it has been built.
func openApp() error {
	candidates := []string{
		filepath.Join(repoRoot(), "dist", "Agentklar.app"),
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, "Applications", "Agentklar.app"),
			filepath.Join(home, ".local", "share", "agentklar", "Agentklar.app"),
		)
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return openPath(p)
		}
	}
	return fmt.Errorf("Agentklar.app not found; build it with: scripts/build-bar.sh")
}

// cmdStatus is the friendly, human-readable counterpart to doctor: one glance
// at workspace, workflow counts, pending approvals, and board connection.
func cmdStatus() error {
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	repo := repoRoot()
	fmt.Printf("agentklar — %s\n", strings.TrimSpace(repo))
	fmt.Printf("workspace: %s\n", dir)

	tasks, err := eng.ListAll()
	if err != nil {
		return err
	}
	counts := map[contracts.State]int{}
	var pending int
	for _, t := range tasks {
		counts[t.State]++
		if t.State == contracts.StateUserApproval {
			pending++
		}
	}
	fmt.Printf("tasks:     %d total", len(tasks))
	if len(tasks) > 0 {
		var parts []string
		// Show non-zero states in workflow order.
		order := []contracts.State{
			contracts.StateDraft, contracts.StateReady, contracts.StateInProgress,
			contracts.StateCompletionReview, contracts.StateAutoQA,
			contracts.StateUserApproval, contracts.StateChangesRequested,
			contracts.StateDone,
		}
		for _, s := range order {
			if n := counts[s]; n > 0 {
				parts = append(parts, fmt.Sprintf("%d %s", n, humanState(s)))
			}
		}
		fmt.Printf(" (%s)", strings.Join(parts, ", "))
	}
	fmt.Println()
	if pending > 0 {
		fmt.Printf("⤷ %d task(s) waiting on YOUR approval — run 'agentklar open ui' (Approvals tab) or 'agentklar approve <id>'\n", pending)
	}
	// The native UI is the default view and needs no external service. Mention
	// the optional Vikunja board only when one is actually reachable, so status
	// never points the human at a dead URL.
	fmt.Printf("ui:        agentklar open ui   (native board/approvals/alerts — no extra service needed)\n")
	if cfg, _ := vikunja.LoadConfig(dir); cfg != nil {
		if trackerReachable(cfg.URL) {
			fmt.Printf("board:     connected — approve as %s → %s\n", cfg.HumanUser, boardURL(cfg.URL, cfg.ProjectID))
		} else {
			fmt.Printf("board:     configured but not reachable at %s — start Vikunja or just use the native UI above\n", cfg.URL)
		}
	}

	if ns, _ := notify.New(dir); ns != nil {
		if pending, _ := ns.Pending(); len(pending) > 0 {
			fmt.Printf("alerts:    %d pending — run 'agentklar alerts pending' or open the UI\n", len(pending))
		}
	}

	if cfg, err := quality.Load(repo); err == nil {
		fmt.Printf("recipes:   %d declared in .agentklar/quality.toml\n", len(cfg.Recipes))
	} else {
		fmt.Printf("recipes:   none declared (run 'agentklar init')\n")
	}
	return nil
}

func humanState(s contracts.State) string {
	switch s {
	case contracts.StateDraft:
		return "draft"
	case contracts.StateReady:
		return "ready"
	case contracts.StateInProgress:
		return "in_progress"
	case contracts.StateCompletionReview:
		return "in_review"
	case contracts.StateAutoQA:
		return "qa"
	case contracts.StateUserApproval:
		return "awaiting_you"
	case contracts.StateChangesRequested:
		return "changes"
	case contracts.StateDone:
		return "done"
	}
	return string(s)
}

// openURL opens a URL in the OS default browser.
func openURL(u string) error {
	return launch("open", u)
}

// openPath reveals a file or directory in the OS file manager / default app.
func openPath(p string) error {
	return launch("open", p)
}

// launch runs the platform open command. On macOS that is /usr/bin/open.
func launch(name string, args ...string) error {
	if runtime.GOOS == "linux" {
		name = "xdg-open"
	}
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("open: %w", err)
	}
	return nil
}
