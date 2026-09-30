package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/kaltstart-co/agentklar/internal/completion"
	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func cmdTaskPacket(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: agentklar task packet <id>")
	}
	engine, workspace, err := openPacketEngine()
	if err != nil {
		return err
	}
	defer engine.DB().Close()
	contextStore, err := akctx.OpenReadOnly(workspace)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if contextStore != nil {
		defer contextStore.Close()
	}
	packet, err := completion.Build(engine, contextStore, args[0])
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(packet)
}

func openPacketEngine() (*workflow.Engine, string, error) {
	root, err := agentklarDataRoot()
	if err != nil {
		return nil, "", err
	}
	repo := repoRoot()
	if resolved, err := filepath.EvalSymlinks(repo); err == nil {
		repo = resolved
	}
	catalogDB, err := readOnlyDB(filepath.Join(root, "catalog.sqlite"))
	if err != nil {
		return nil, "", err
	}
	defer catalogDB.Close()
	var workspace string
	if err := catalogDB.QueryRow(`SELECT workspace_path FROM projects WHERE repo_path=?`, filepath.Clean(repo)).Scan(&workspace); err != nil {
		return nil, "", fmt.Errorf("read registered workspace: %w", err)
	}
	db, err := readOnlyDB(filepath.Join(workspace, "control.sqlite"))
	if err != nil {
		return nil, "", err
	}
	return workflow.New(db), workspace, nil
}

func readOnlyDB(path string) (*sql.DB, error) {
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
