package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/kaltstart-co/agentklar/internal/runs"
)

func TestServeOpenReusesExistingSupervisor(t *testing.T) {
	t.Setenv("AGENTKLAR_DATA_ROOT", t.TempDir())
	t.Chdir(t.TempDir())
	eng, workspace, err := openEngine()
	if err != nil {
		t.Fatal(err)
	}
	defer eng.DB().Close()
	st, err := runs.NewStore(eng.DB())
	if err != nil {
		t.Fatal(err)
	}
	s := runs.NewSupervisor(st, eng, repoRoot())
	opened := make(chan struct{}, 1)
	s.OpenUI = func() error { opened <- struct{}{}; return nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, workspace) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(runs.SocketPath(workspace)); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err = cmdServe([]string{"--open"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	default:
		t.Fatal("did not reuse live supervisor UI")
	}
	result, err := runs.Call(workspace, runs.Request{Method: "list"})
	if err != nil || string(result) != `{"runs":[]}` {
		t.Fatalf("live peer damaged: %s %v", result, err)
	}
	cancel()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}
