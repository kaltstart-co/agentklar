package main

import (
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
