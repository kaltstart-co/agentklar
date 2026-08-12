package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUIAccessNoticeExplainsReadOnlySession(t *testing.T) {
	notice := uiAccessNotice(false)
	for _, want := range []string{"Read-only", "agentklar ui --open"} {
		if !strings.Contains(notice, want) {
			t.Fatalf("notice %q does not contain %q", notice, want)
		}
	}
}

func TestCanonicalUILaunchCommand(t *testing.T) {
	paths := []string{
		"open.go",
		"assets/commands/agentklar.md",
		"assets/commands/agentklar-alerts.md",
		"assets/commands/agentklar-board.md",
		"assets/skill/agentklar/SKILL.md",
		filepath.Join("..", "..", "install.sh"),
	}
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), "agentklar open ui") {
			t.Errorf("%s still publishes the legacy UI command", path)
		}
		if !strings.Contains(string(body), "agentklar ui --open") {
			t.Errorf("%s does not publish the canonical UI command", path)
		}
	}
}
