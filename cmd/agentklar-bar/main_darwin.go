//go:build darwin

// Command agentklar-bar is a macOS menu-bar widget. It shows how many tasks
// are awaiting your approval across all workspaces, lists them (click opens the
// tracker card), and carries links to your boards and other UIs.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/caseymrm/menuet"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/tracker/vikunja"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

type pending struct{ id, title, url string }
type link struct{ name, url string }

func workspacesDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "agentklar", "workspaces")
}

// scan reads every workspace and returns the tasks awaiting approval plus the
// board links for connected trackers.
func scan() (items []pending, boards []link) {
	entries, err := os.ReadDir(workspacesDir())
	if err != nil {
		return nil, nil
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		wdir := filepath.Join(workspacesDir(), e.Name())
		dbPath := filepath.Join(wdir, "control.sqlite")
		if _, err := os.Stat(dbPath); err != nil {
			continue
		}
		db, err := store.Open(dbPath)
		if err != nil {
			continue
		}
		tasks, err := workflow.New(db).ListAll()
		db.Close()
		if err != nil {
			continue
		}
		front := ""
		if cfg, _ := vikunja.LoadConfig(wdir); cfg != nil {
			front = strings.TrimSuffix(cfg.URL, "/api/v1")
			boards = append(boards, link{name: e.Name(), url: fmt.Sprintf("%s/projects/%d", front, cfg.ProjectID)})
		}
		for _, t := range tasks {
			if t.State != contracts.StateUserApproval {
				continue
			}
			url := ""
			if front != "" && t.TrackerID != "" {
				url = fmt.Sprintf("%s/tasks/%s", front, t.TrackerID)
			}
			items = append(items, pending{id: t.ID, title: t.Title, url: url})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].id < items[j].id })
	return items, boards
}

// extraLinks reads optional user-defined links (Jira, docs, etc.) from
// ~/.config/agentklar/links.toml so the menu can grow without a rebuild.
func extraLinks() []link {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".config", "agentklar", "links.toml")
	var cfg struct {
		Link []struct{ Name, URL string } `toml:"link"`
	}
	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		return nil
	}
	var out []link
	for _, l := range cfg.Link {
		if l.Name != "" && l.URL != "" {
			out = append(out, link{name: l.Name, url: l.URL})
		}
	}
	return out
}

func open(u string) {
	if u != "" {
		_ = exec.Command("open", u).Start()
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func menu() []menuet.MenuItem {
	items, boards := scan()
	var m []menuet.MenuItem

	if len(items) == 0 {
		m = append(m, menuet.MenuItem{Text: "Up to date — nothing to review", FontWeight: menuet.WeightSemibold})
	} else {
		m = append(m, menuet.MenuItem{Text: fmt.Sprintf("%d awaiting your approval", len(items)), FontWeight: menuet.WeightBold})
		for _, it := range items {
			it := it
			m = append(m, menuet.MenuItem{
				Text:    "   " + it.id + " · " + truncate(it.title, 42),
				Clicked: func() { open(it.url) },
			})
		}
	}

	m = append(m, menuet.MenuItem{Type: menuet.Separator})
	if len(boards) > 0 {
		m = append(m, menuet.MenuItem{Text: "Boards", FontWeight: menuet.WeightSemibold})
		for _, b := range boards {
			b := b
			m = append(m, menuet.MenuItem{Text: "   Open " + b.name, Clicked: func() { open(b.url) }})
		}
	}
	for _, l := range extraLinks() {
		l := l
		m = append(m, menuet.MenuItem{Text: l.name, Clicked: func() { open(l.url) }})
	}
	m = append(m, menuet.MenuItem{Text: "Website", Clicked: func() { open("https://agentklar.kaltstart.co") }})

	m = append(m, menuet.MenuItem{Type: menuet.Separator})
	m = append(m, menuet.MenuItem{Text: "Refresh now", Clicked: func() { refresh() }})
	m = append(m, menuet.MenuItem{Text: "Quit", Clicked: func() { os.Exit(0) }})
	return m
}

// refresh recomputes the menu-bar badge from the current state.
func refresh() {
	items, _ := scan()
	title := "✓" // check mark = Agentklar, idle
	if len(items) > 0 {
		title = fmt.Sprintf("✓ %d", len(items))
	}
	menuet.App().SetMenuState(&menuet.MenuState{Title: title})
	menuet.App().MenuChanged()
}

func main() {
	app := menuet.App()
	app.Name = "Agentklar"
	app.Label = "co.kaltstart.agentklar-bar"
	app.Children = menu
	go func() {
		for {
			refresh()
			time.Sleep(30 * time.Second)
		}
	}()
	app.RunApplication()
}
