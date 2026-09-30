package runs

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kaltstart-co/agentklar/internal/team"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func recommendationFixture(t *testing.T) (team.Config, RecommendationRequest, []team.Candidate, UsageSnapshot, time.Time) {
	t.Helper()
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	usage := unknownUsage(Harness{Version: "fixture"}, "")
	usage.ObservedAt = at.Format(time.RFC3339Nano)
	allowed := true
	usage.Quota.OrdinaryUsageAllowed = &allowed
	usage.Quota.Status = "actual"
	candidates, err := advertisedCandidates(Harness{Version: "fixture"}, json.RawMessage(`{"data":[{"model":"large","inputModalities":["text","image"]},{"model":"small","inputModalities":["text"]}]}`), at, &usage)
	if err != nil {
		t.Fatal(err)
	}
	return team.Default(), RecommendationRequest{TaskID: "TASK-1", TaskKind: "coding", RequiredCapabilities: []string{"text"}}, candidates, usage, at
}

func TestRecommendationAdviceUsesEvidenceWithoutEntitlementClaims(t *testing.T) {
	for _, tc := range []struct {
		name          string
		edit          func(*team.Config, *RecommendationRequest, *[]team.Candidate, *UsageSnapshot)
		action, model string
	}{
		{"no automatic model ranking", func(*team.Config, *RecommendationRequest, *[]team.Candidate, *UsageSnapshot) {}, "no_recommendation", ""},
		{"cost preference retains current without zero subscription cost", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Preference = "cost"
			r.Current = &team.Selection{Harness: "codex", Model: "large"}
		}, "keep_current", "large"},
		{"quality preference has no invented scores", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Preference = "quality"
			r.Current = &team.Selection{Harness: "codex", Model: "small"}
		}, "keep_current", "small"},
		{"saved pin nominates with unknown entitlement", func(c *team.Config, _ *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Pins = []team.Pin{{TaskID: "TASK-1", Harness: "codex", Model: "small"}}
		}, "nominate_worker", "small"},
		{"request pin overrides saved pin", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Pins = []team.Pin{{TaskID: "TASK-1", Harness: "codex", Model: "large"}}
			r.Pin = &team.Selection{Harness: "codex", Model: "small"}
		}, "nominate_worker", "small"},
		{"unknown quota does not invent capacity", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, u *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "small"}
			u.Quota.OrdinaryUsageAllowed = nil
			u.Quota.Status = "unknown"
		}, "nominate_worker", "small"},
		{"ordinary native usage false excludes pin", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, u *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "small"}
			denied := false
			u.Quota.OrdinaryUsageAllowed = &denied
		}, "no_recommendation", ""},
		{"quota denial is not cross harness denial", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, u *UsageSnapshot) {
			r.Current = &team.Selection{Harness: "claude", Model: "native-model"}
			denied := false
			u.Quota.OrdinaryUsageAllowed = &denied
		}, "keep_current", "native-model"},
		{"adapter rejects image even advertised model sees image", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "large"}
			r.RequiredCapabilities = []string{"image"}
		}, "no_recommendation", ""},
		{"unknown capability rejects explicit pin", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "large"}
			r.RequiredCapabilities = []string{"shell"}
		}, "no_recommendation", ""},
		{"unavailable model pin is never substituted", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "absent"}
			r.Current = &team.Selection{Harness: "codex", Model: "large"}
		}, "no_recommendation", ""},
		{"auto pin does not pick arbitrary model", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "auto"}
		}, "no_recommendation", ""},
		{"absent model modalities are not defaulted", func(_ *team.Config, r *RecommendationRequest, cs *[]team.Candidate, _ *UsageSnapshot) {
			r.Pin = &team.Selection{Harness: "codex", Model: "small"}
			(*cs)[1].ModelCapabilities.Values = nil
		}, "no_recommendation", ""},
		{"saved explicit role nominates without task pin", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "small"}}
			r.RoleID = "builder"
		}, "nominate_worker", "small"},
		{"saved explicit role constrains different current", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "small"}}
			r.RoleID = "builder"
			r.Current = &team.Selection{Harness: "codex", Model: "large"}
		}, "nominate_worker", "small"},
		{"task pin takes precedence over role", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "small"}}
			r.RoleID = "builder"
			r.Pin = &team.Selection{Harness: "codex", Model: "large"}
		}, "nominate_worker", "large"},
		{"saved role denied by native quota", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, u *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "small"}}
			r.RoleID = "builder"
			denied := false
			u.Quota.OrdinaryUsageAllowed = &denied
		}, "no_recommendation", ""},
		{"unique allowed fallback nominated", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "missing", AllowedFallback: []team.Selection{{Harness: "codex", Model: "small"}}}}
			r.RoleID = "builder"
		}, "nominate_worker", "small"},
		{"ambiguous allowed fallback is not ranked", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "missing", AllowedFallback: []team.Selection{{Harness: "codex", Model: "small"}, {Harness: "codex", Model: "large"}}}}
			r.RoleID = "builder"
		}, "no_recommendation", ""},
		{"allowed fallback keeps current if preferred absent", func(c *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			c.Roles = []team.Role{{ID: "builder", Responsibility: "build", Harness: "codex", Model: "missing", AllowedFallback: []team.Selection{{Harness: "codex", Model: "small"}}}}
			r.RoleID = "builder"
			r.Current = &team.Selection{Harness: "codex", Model: "small"}
		}, "keep_current", "small"},
		{"unsupported current kept without verification claim", func(_ *team.Config, r *RecommendationRequest, _ *[]team.Candidate, _ *UsageSnapshot) {
			r.Current = &team.Selection{Harness: "claude", Model: "native-model"}
		}, "keep_current", "native-model"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config, request, candidates, usage, at := recommendationFixture(t)
			tc.edit(&config, &request, &candidates, &usage)
			got := recommendation(config, `"revision"`, request, candidates, &usage, at)
			if got.Action != tc.action || got.Confidence == "observed" || len(got.Missing) == 0 || got.PolicyRevision != `"revision"` {
				t.Fatalf("advice=%+v", got)
			}
			if tc.model == "" && got.Selection != nil || tc.model != "" && (got.Selection == nil || got.Selection.Model != tc.model) {
				t.Fatalf("selection=%+v, wanted %q", got.Selection, tc.model)
			}
			for _, candidate := range got.Candidates {
				if candidate.Access != "unknown" || candidate.Cost != "unknown" || candidate.ModelQuota == "available" || candidate.Billing != "unknown" {
					t.Fatalf("unsupported entitlement/cost/model quota inference: %+v", candidate)
				}
			}
			if got.Selection != nil && got.Selection.Harness == "claude" && (got.Confidence != "none" || !strings.Contains(got.Reason, "unverified")) {
				t.Fatal("unsupported current treated as verified")
			}
		})
	}
}

// This process provides catalog/usage metadata only. Any inference or mutation
// RPC fails the fixture. It is not proof of native account/model access.
func TestRecommendationNativeFixture(t *testing.T) {
	if os.Getenv("AGENTKLAR_RECOMMEND_FIXTURE") != "1" {
		return
	}
	enc := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var m message
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			os.Exit(2)
		}
		f, err := os.OpenFile(os.Getenv("AGENTKLAR_RECOMMEND_TRACE"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			os.Exit(2)
		}
		_, _ = f.WriteString(m.Method + "\n")
		_ = f.Close()
		var result any
		switch m.Method {
		case "initialize":
			result = map[string]string{"userAgent": "fixture"}
		case "initialized":
			continue
		case "model/list":
			result = map[string]any{"data": []map[string]any{{"model": "native-model", "inputModalities": []string{"text", "image"}}}}
		case "account/rateLimits/read":
			var p map[string]any
			_ = json.Unmarshal(m.Params, &p)
			if p["excludeResetCreditDetails"] != true || p["supportsLunaReserve"] != nil {
				os.Exit(3)
			}
			result = map[string]any{"accountId": "fixture-private-account", "ordinaryUsageAllowed": true, "rateLimits": map[string]any{"primary": map[string]int{"usedPercent": 80}}}
		case "account/usage/read":
			result = map[string]any{"summary": map[string]int{"lifetimeTokens": 10}}
		default:
			os.Exit(4)
		}
		_ = enc.Encode(map[string]any{"id": m.ID, "result": result})
	}
	os.Exit(0)
}

func TestRecommendTaskLoadsPolicyAndReadsOnlySupportedMetadata(t *testing.T) {
	s, _, repo := testSupervisor(t)
	executable, _ := os.Executable()
	trace := filepath.Join(t.TempDir(), "methods")
	t.Setenv("AGENTKLAR_RECOMMEND_FIXTURE", "1")
	t.Setenv("AGENTKLAR_RECOMMEND_TRACE", trace)
	if err := s.Store.SaveHarness(Harness{Name: "codex", Version: "fixture", Executable: executable, Args: []string{"-test.run=^TestRecommendationNativeFixture$", "--"}}); err != nil {
		t.Fatal(err)
	}
	config := team.Default()
	config.Preference = "cost"
	config.Pins = []team.Pin{{TaskID: "TASK-1", Harness: "codex", Model: "native-model"}}
	if err := team.Save(repo, config); err != nil {
		t.Fatal(err)
	}
	value, err := s.Dispatch(Request{Method: "recommend", Recommend: RecommendationRequest{TaskID: "TASK-1", RequiredCapabilities: []string{"text"}}})
	if err != nil {
		t.Fatal(err)
	}
	got := value.(Recommendation)
	if got.Action != "nominate_worker" || got.Preference != "cost" || got.Selection.Model != "native-model" || got.AccountQuota == nil || got.AccountQuota.Status != "actual" {
		t.Fatalf("advice=%+v", got)
	}
	encoded, _ := json.Marshal(got)
	if strings.Contains(string(encoded), "fixture-private-account") || strings.Contains(string(encoded), "can_attempt") {
		t.Fatal("private account or unsupported launch permission returned")
	}
	methods, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	for _, needed := range []string{"model/list", "account/rateLimits/read", "account/usage/read"} {
		if !strings.Contains(string(methods), needed) {
			t.Fatalf("missing read %s: %s", needed, methods)
		}
	}
	for _, method := range strings.Fields(string(methods)) {
		if !slicesContainsReadMethod(method) {
			t.Fatalf("mutation/inference method: %s", method)
		}
	}
	stored, _ := s.Store.List()
	if len(stored) != 0 {
		t.Fatal("recommendation launched a run")
	}
}

func slicesContainsReadMethod(method string) bool {
	return method == "initialize" || method == "initialized" || method == "model/list" || method == "account/rateLimits/read" || method == "account/usage/read"
}

func TestRecommendTaskRejectsProjectMismatchAndInvalidRequirementsBeforeNativeReads(t *testing.T) {
	s, _, _ := testSupervisor(t)
	if err := s.Engine.CreateTask(workflow.Task{ID: "OTHER", Title: "outside", RepoPath: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	for _, r := range []RecommendationRequest{
		{TaskID: "OTHER", RequiredCapabilities: []string{"text"}},
		{TaskID: "TASK-1"},
		{TaskID: "TASK-1", RoleID: "absent", RequiredCapabilities: []string{"text"}},
		{TaskID: "TASK-1", RequiredCapabilities: []string{"../image"}},
		{TaskID: "TASK-1", RequiredCapabilities: []string{"text"}, Current: &team.Selection{Harness: "codex", Model: "auto"}},
	} {
		if _, err := s.RecommendTask(r); err == nil {
			t.Fatalf("bad request accepted: %+v", r)
		}
	}
}

func TestLiveReadOnlyRecommendation(t *testing.T) {
	executable := os.Getenv("AGENTKLAR_TEST_LIVE_RECOMMEND_EXECUTABLE")
	if executable == "" {
		t.Skip("opt-in native metadata check; no inference")
	}
	s, _, repo := testSupervisor(t)
	version, err := exec.Command(executable, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Store.SaveHarness(Harness{Name: "codex", Version: strings.TrimSpace(string(version)), Executable: executable}); err != nil {
		t.Fatal(err)
	}
	config := team.Default()
	config.Preference = "cost"
	config.Pins = []team.Pin{{TaskID: "TASK-1", Harness: "codex", Model: "gpt-6.1-sol"}}
	if err := team.Save(repo, config); err != nil {
		t.Fatal(err)
	}
	got, err := s.RecommendTask(RecommendationRequest{TaskID: "TASK-1", RequiredCapabilities: []string{"text"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Candidates) == 0 || got.AccountQuota == nil || len(got.Missing) == 0 || got.Confidence == "observed" {
		t.Fatal("missing native metadata or false certainty")
	}
	if got.Action == "nominate_worker" && (got.Selection == nil || got.Selection.Model != "gpt-6.1-sol") {
		t.Fatal("pin substituted")
	}
	stored, err := s.Store.List()
	if err != nil || len(stored) != 0 {
		t.Fatal("metadata recommendation launched a run")
	}
	t.Logf("native catalog observed; quota status=%s; action=%s; missing evidence=%d; no thread/turn started", got.AccountQuota.Status, got.Action, len(got.Missing))
}

func TestRecommendationResponseIsBoundedAndOmitsAccountHistory(t *testing.T) {
	config, request, candidates, usage, at := recommendationFixture(t)
	for i := 0; i < 100; i++ {
		candidate := candidates[0]
		candidate.Model = fmt.Sprintf("model-%d", i)
		candidates = append(candidates, candidate)
	}
	request.Pin = &team.Selection{Harness: "codex", Model: "model-99"}
	usage.AccountTokens.Daily = []DailyUsage{{StartDate: "2026-10-01", Tokens: 123}}
	usage.RegisteredThreads = []RegisteredThreadUsage{{ThreadKey: "PRIVATE_HISTORY"}}
	for i := 0; i < 10; i++ {
		usage.Quota.Buckets = append(usage.Quota.Buckets, UsageBucket{ID: fmt.Sprintf("bucket-%d", i)})
	}
	got := recommendation(config, "revision", request, candidates, &usage, at)
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Candidates) != 6 || got.OmittedCandidates != len(candidates)-6 || len(got.Rejected) > 6 || got.AccountQuota.OmittedBuckets != 6 || got.Candidates[0].Model != "model-99" || len(raw) > 8000 {
		t.Fatalf("unbounded recommendation: candidates=%d omitted=%d bytes=%d", len(got.Candidates), got.OmittedCandidates, len(raw))
	}
	for _, private := range []string{"PRIVATE_HISTORY", "account_tokens", "registered_threads", "lifetime_tokens", "daily"} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("recommendation exposes full history: %s", private)
		}
	}
}
