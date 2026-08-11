package main

import (
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kaltstart-co/agentklar/internal/catalog"
	"github.com/kaltstart-co/agentklar/internal/ui"
)

// cmdUI starts the native local web UI: one page for the board, knowledge,
// memory, context, evidence, and approvals. It binds to 127.0.0.1 so the
// "approve" click is a trusted human channel (an agent has no MCP method and
// no network path to localhost from outside). Ctrl-C stops the server.
func cmdUI(args []string) error {
	fs := flag.NewFlagSet("ui", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:7681", "address to serve on (pick a free port if busy)")
	open := fs.Bool("open", false, "open the UI in the default browser once it is up")
	if err := fs.Parse(args); err != nil {
		return err
	}

	dataRoot, err := agentklarDataRoot()
	if err != nil {
		return err
	}
	c, err := catalog.Open(dataRoot)
	if err != nil {
		return err
	}
	defer c.Close()
	repo := repoRoot()
	project, err := c.Register(repo, filepath.Join(dataRoot, "workspaces", sanitize(filepath.Base(repo))))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(project.WorkspacePath, "evidence"), 0o755); err != nil {
		return err
	}
	srv, err := ui.NewControlCenter(c, project.ID)
	if err != nil {
		return err
	}
	defer srv.Close()

	ln, err := srv.Listen(*addr)
	if err != nil {
		if errors.Is(err, ui.ErrNonLoopback) {
			return err
		}
		// Fixed port busy? Fall back to a free one so `ui` always starts.
		ln, err = srv.Listen("")
		if err != nil {
			return err
		}
	}
	url := "http://" + ln.Addr().String() + "/"
	fmt.Printf("agentklar UI → %s\n", url)
	fmt.Printf("Ctrl-C to stop. Approve from this page only — it is your trusted local channel.\n")

	if *open {
		// Give the server a beat to be ready, then pop the browser.
		go func() {
			time.Sleep(150 * time.Millisecond)
			_ = openURL(url)
		}()
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		fmt.Println("\nshutting down.")
		_ = srv.Close()
		os.Exit(0)
	}()
	return http.Serve(ln, srv.Handler())
}
