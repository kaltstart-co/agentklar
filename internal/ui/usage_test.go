package ui

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/runs"
)

func TestUsageRequiresHumanAndNativeConnection(t *testing.T) {
	c, alpha, _ := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	path := "/api/projects/" + alpha.ID + "/usage"
	if got := apiRequest(t, s.Handler(), http.MethodGet, path, ""); got.Code != http.StatusForbidden {
		t.Fatalf("private usage readable without session: %d", got.Code)
	}
	cookie := bootstrapHuman(t, s)
	missing := humanRequest(t, s, cookie, http.MethodGet, path, "")
	if missing.Code != http.StatusServiceUnavailable || missing.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing connection: %d cache=%q", missing.Code, missing.Header().Get("Cache-Control"))
	}
}

func TestUsageCallbackIsProjectScopedAndErrorsAreRedacted(t *testing.T) {
	c, alpha, beta := seedProjects(t)
	s, err := NewControlCenter(c, alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	called := 0
	s.NativeUsage = func(repo, runID string) (runs.UsageSnapshot, error) {
		called++
		if repo != alpha.RepoPath {
			return runs.UsageSnapshot{}, errors.New("private-account-id secret-token native failure")
		}
		if runID != "run-fixture" {
			t.Fatalf("wrong run selector %q", runID)
		}
		return runs.UsageSnapshot{Harness: "codex", Version: "unit fixture", Source: "unit fixture only", ObservedAt: "2026-10-01T00:00:00Z", Quota: runs.QuotaUsage{Status: "unknown", Buckets: []runs.UsageBucket{}}, AccountTokens: runs.AccountTokens{Status: "unknown", Daily: []runs.DailyUsage{}}, RegisteredThreads: []runs.RegisteredThreadUsage{}, SpendStatus: "unknown", Warnings: []string{}}, nil
	}
	path := "/api/projects/" + alpha.ID + "/usage?run=run-fixture"
	if got := apiRequest(t, s.Handler(), http.MethodGet, path, ""); got.Code != http.StatusForbidden || called != 0 {
		t.Fatal("unauthenticated request reached native usage")
	}
	cookie := bootstrapHuman(t, s)
	got := humanRequest(t, s, cookie, http.MethodGet, path, "")
	if got.Code != http.StatusOK || got.Header().Get("Cache-Control") != "no-store" || !strings.Contains(got.Body.String(), `"spend_status":"unknown"`) || !strings.Contains(got.Body.String(), `"source":"unit fixture only"`) {
		t.Fatalf("usage response: %d %s", got.Code, got.Body.String())
	}
	other := humanRequest(t, s, cookie, http.MethodGet, "/api/projects/"+beta.ID+"/usage", "")
	if other.Code != http.StatusServiceUnavailable || strings.Contains(other.Body.String(), "private-account-id") || strings.Contains(other.Body.String(), "secret-token") {
		t.Fatal("cross-project native error escaped redaction")
	}
	before := called
	unknown := humanRequest(t, s, cookie, http.MethodGet, "/api/projects/not-registered/usage", "")
	if unknown.Code != http.StatusNotFound || called != before {
		t.Fatal("unregistered project reached native usage")
	}
}
