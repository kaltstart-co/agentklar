package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/kaltstart-co/agentklar/internal/catalog"
	"github.com/kaltstart-co/agentklar/internal/runs"
	"github.com/kaltstart-co/agentklar/internal/ui"
)

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	open := fs.Bool("open", false, "open the trusted local support interface")
	addr := fs.String("addr", "127.0.0.1:7681", "local UI address")
	if err := fs.Parse(args); err != nil {
		return err
	}
	eng, workspace, err := openEngine()
	if err != nil {
		return err
	}
	defer eng.DB().Close()
	if *open {
		if _, err = runs.Call(workspace, runs.Request{Method: "open-ui"}); err == nil {
			return nil
		} else if !errors.Is(err, runs.ErrNoSupervisor) {
			return err
		}
	}
	store, err := runs.NewStore(eng.DB())
	if err != nil {
		return err
	}
	supervisor := runs.NewSupervisor(store, eng, repoRoot())
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	dataRoot, err := agentklarDataRoot()
	if err != nil {
		return err
	}
	c, err := catalog.Open(dataRoot)
	if err != nil {
		return err
	}
	defer c.Close()
	p, err := c.Register(repoRoot(), workspace)
	if err != nil {
		return err
	}
	web, err := ui.NewControlCenter(c, p.ID)
	if err != nil {
		return err
	}
	defer web.Close()
	web.NativePermission = func(repo, runID string, requestID json.RawMessage, decision string) error {
		if repo != supervisor.Repo {
			return errors.New("this project has a separate supervisor; open its local support interface")
		}
		return supervisor.Permission(runID, requestID, decision)
	}
	web.NativeUsage = func(repo, runID string) (runs.UsageSnapshot, error) {
		if repo != supervisor.Repo {
			return runs.UsageSnapshot{}, errors.New("project has a separate supervisor")
		}
		return supervisor.Usage(runID)
	}
	ln, err := web.Listen(*addr)
	if err != nil {
		if errors.Is(err, ui.ErrNonLoopback) {
			return err
		}
		ln, err = web.Listen("")
		if err != nil {
			return err
		}
	}
	defer ln.Close()
	httpServer := &http.Server{Handler: web.Handler()}
	go func() { <-ctx.Done(); _ = httpServer.Close() }()
	go func() { _ = httpServer.Serve(ln) }()
	url := "http://" + ln.Addr().String() + "/app/"
	var openMu sync.Mutex
	opened := false
	supervisor.OpenUI = func() error {
		openMu.Lock()
		defer openMu.Unlock()
		if opened {
			return openURL(url)
		}
		launch, err := web.LaunchURL(url)
		if err != nil {
			return err
		}
		if err = openURL(launch); err != nil {
			return err
		}
		opened = true
		return nil
	}
	fmt.Println("Local supervisor and support interface:", url)
	if *open {
		if err = supervisor.OpenUI(); err != nil {
			return err
		}
	}
	return supervisor.Serve(ctx, workspace)
}

func cmdRuns(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: agentklar runs discover|harnesses|models|usage|open|list|show|start|cancel")
	}
	workspace, err := workspaceDir()
	if err != nil {
		return err
	}
	req := runs.Request{Method: args[0]}
	switch args[0] {
	case "discover", "harnesses", "models", "list":
	case "open":
		req.Method = "open-ui"
	case "usage":
		if len(args) > 1 {
			req.ID = args[1]
		}
	case "show":
		if len(args) < 2 {
			return errors.New("run id required")
		}
		req.Method = "get"
		req.ID = args[1]
		fs := flag.NewFlagSet("runs show", flag.ContinueOnError)
		after := fs.Int64("after", 0, "event cursor")
		if err = fs.Parse(args[2:]); err != nil {
			return err
		}
		req.After = *after
	case "start":
		fs := flag.NewFlagSet("runs start", flag.ContinueOnError)
		fs.StringVar(&req.Start.ID, "id", "", "stable retry id")
		fs.StringVar(&req.Start.TaskID, "task", "", "claimed task id")
		fs.StringVar(&req.Start.Holder, "holder", "", "current claim holder")
		fs.Int64Var(&req.Start.FencingToken, "token", 0, "current claim token")
		fs.StringVar(&req.Start.Harness, "harness", "codex", "native adapter")
		fs.StringVar(&req.Start.Model, "model", "", "native model override; empty inherits native default")
		fs.StringVar(&req.Start.Purpose, "purpose", "implement", "implement | review | fix")
		fs.BoolVar(&req.Start.ReadOnly, "read-only", false, "narrow native sandbox to read-only")
		promptFile := fs.String("prompt-file", "", "UTF-8 task instructions")
		if err = fs.Parse(args[1:]); err != nil {
			return err
		}
		if *promptFile == "" {
			return errors.New("prompt-file required")
		}
		b, err := os.ReadFile(filepath.Clean(*promptFile))
		if err != nil {
			return err
		}
		req.Start.Prompt = string(b)
	case "cancel":
		if len(args) < 2 {
			return errors.New("run id required")
		}
		req.ID = args[1]
		fs := flag.NewFlagSet("runs cancel", flag.ContinueOnError)
		fs.StringVar(&req.Holder, "holder", "", "claim holder")
		fs.Int64Var(&req.FencingToken, "token", 0, "claim token")
		if err = fs.Parse(args[2:]); err != nil {
			return err
		}
	default:
		return errors.New("unknown runs subcommand")
	}
	result, err := runs.Call(workspace, req)
	if err != nil {
		return err
	}
	var value any
	if err = json.Unmarshal(result, &value); err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}
