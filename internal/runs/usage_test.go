package runs

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

func TestUsageReadsFixedAllowlist(t *testing.T) {
	for _, tc := range []struct {
		method, thread string
		allowed        bool
	}{
		{"account/rateLimits/read", "", true},
		{"account/usage/read", "", true},
		{"account/usage/read", "registered-thread", true},
		{"account/rateLimits/read", "thread", false},
		{"turn/start", "", false},
		{"account/login/start", "", false},
		{"account/rateLimits/consumeResetCredit", "", false},
		{"account/tokenUsage/read", "", false},
	} {
		t.Run(tc.method+tc.thread, func(t *testing.T) {
			called := false
			call := func(_ context.Context, method string, params any) (json.RawMessage, error) {
				called = true
				if method != tc.method {
					t.Fatal("changed method")
				}
				p := params.(map[string]any)
				if _, exists := p["supportsLunaReserve"]; exists {
					t.Fatal("experiment opt-in sent")
				}
				if method == "account/rateLimits/read" && p["excludeResetCreditDetails"] != true {
					t.Fatal("reset credit details not excluded")
				}
				if tc.thread != "" && p["threadId"] != tc.thread {
					t.Fatal("wrong registered thread")
				}
				return json.RawMessage(`{}`), nil
			}
			_, err := usageRead(context.Background(), call, tc.method, tc.thread)
			if called != tc.allowed || (err == nil) != tc.allowed {
				t.Fatalf("called=%v err=%v", called, err)
			}
		})
	}
}

func TestQuotaRedactsAndDeduplicatesNativeViews(t *testing.T) {
	s := unknownUsage(Harness{Version: "fixture"}, "")
	raw := json.RawMessage(`{"accountId":"private-account-id","ordinaryUsageAllowed":false,"rateLimits":{"limitId":"codex","primary":{"usedPercent":2}},"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":1900000000},"secondary":null},"other":{"primary":null,"secondary":{"usedPercent":0}}},"accessToken":"secret-token","credits":{"balance":"SECRET BALANCE"},"rateLimitUpsell":{"email":"private@example.com"}}`)
	if err := applyQuota(&s, raw); err != nil {
		t.Fatal(err)
	}
	if s.Quota.Status != "actual" || len(s.Quota.Buckets) != 2 || *s.Quota.Buckets[0].Primary.UsedPercent != 20 {
		t.Fatalf("duplicated or wrong view: %+v", s)
	}
	if s.Quota.OrdinaryUsageAllowed == nil || *s.Quota.OrdinaryUsageAllowed {
		t.Fatal("permission inferred from remaining percentages")
	}
	encoded, _ := json.Marshal(s)
	for _, private := range []string{"private-account-id", "secret-token", "SECRET BALANCE", "private@example.com"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("private field leaked: %s", private)
		}
	}
	if s.AccountPoolKey == nil || *s.AccountPoolKey == "private-account-id" {
		t.Fatal("missing local pool hash")
	}
	second := unknownUsage(Harness{}, "")
	_ = applyQuota(&second, raw)
	if *second.AccountPoolKey != *s.AccountPoolKey {
		t.Fatal("pool key not stable")
	}
}

func TestQuotaUnknownAndPermissionNotInvented(t *testing.T) {
	for _, raw := range []string{`{}`, `{"rateLimits":{}}`, `{"rateLimits":{"primary":{"usedPercent":null}}}`} {
		s := unknownUsage(Harness{}, "")
		if err := applyQuota(&s, json.RawMessage(raw)); err != nil {
			t.Fatal(err)
		}
		if s.Quota.Status != "unknown" || s.Quota.OrdinaryUsageAllowed != nil {
			t.Fatalf("unknown became known: %+v", s)
		}
	}
	s := unknownUsage(Harness{}, "")
	_ = applyQuota(&s, json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":0,"resetsAt":1}}}`))
	if s.Quota.OrdinaryUsageAllowed != nil {
		t.Fatal("recovery inferred from percentages or reset time")
	}
	over := unknownUsage(Harness{}, "")
	_ = applyQuota(&over, json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":120}}}`))
	if over.Quota.Status != "actual" || *over.Quota.Buckets[0].Primary.UsedPercent != 120 || *over.Quota.Buckets[0].Primary.RemainingPercent != 0 {
		t.Fatal("over-limit observation lost or remaining not clamped")
	}
}

func TestAccountTokensAndEstimateKeepTheirMeaning(t *testing.T) {
	s := unknownUsage(Harness{}, "run-1")
	if err := applyAccountTokens(&s, json.RawMessage(`{"summary":{"lifetimeTokens":0},"dailyUsageBuckets":[{"startDate":"2026-10-01","tokens":10},{"startDate":"bad","tokens":999}],"accountId":"PRIVATE"}`)); err != nil {
		t.Fatal(err)
	}
	if s.AccountTokens.Status != "actual" || s.AccountTokens.LifetimeTokens == nil || *s.AccountTokens.LifetimeTokens != 0 || len(s.AccountTokens.Daily) != 1 {
		t.Fatalf("tokens: %+v", s)
	}
	if err := applyThreadEstimate(&s, json.RawMessage(`{"summary":{},"threadUsage":{"threadId":"registered","estimatedUsageUsdMicros":2500000,"estimatedUsageCreditsMicros":123,"groups":[]}}`), "registered"); err != nil {
		t.Fatal(err)
	}
	if s.ThreadEstimate.Status != "estimated" || *s.ThreadEstimate.EstimatedUSD != 2.5 || s.SpendStatus != "unknown" {
		t.Fatal("estimate became invoice", s)
	}
	wrong := unknownUsage(Harness{}, "run-1")
	_ = applyThreadEstimate(&wrong, json.RawMessage(`{"threadUsage":{"threadId":"other","estimatedUsageUsdMicros":100}}`), "registered")
	if wrong.ThreadEstimate.EstimatedUSD != nil {
		t.Fatal("unregistered thread estimate exposed")
	}
	missing := unknownUsage(Harness{}, "")
	_ = applyAccountTokens(&missing, json.RawMessage(`{"summary":{}}`))
	if missing.AccountTokens.Status != "unknown" || missing.AccountTokens.LifetimeTokens != nil {
		t.Fatal("missing usage became zero")
	}
	for _, tokenField := range []string{"", `,"tokens":null`} {
		missing = unknownUsage(Harness{}, "")
		_ = applyAccountTokens(&missing, json.RawMessage(`{"summary":{},"dailyUsageBuckets":[{"startDate":"2026-10-01"`+tokenField+`}]}`))
		if len(missing.AccountTokens.Daily) != 0 || missing.AccountTokens.Status != "unknown" {
			t.Fatal("missing or null daily tokens became measured zero")
		}
	}
	zero := unknownUsage(Harness{}, "")
	_ = applyAccountTokens(&zero, json.RawMessage(`{"summary":{},"dailyUsageBuckets":[{"startDate":"2026-10-01","tokens":0}]}`))
	if len(zero.AccountTokens.Daily) != 1 || zero.AccountTokens.Status != "actual" || zero.AccountTokens.Daily[0].Tokens != 0 {
		t.Fatal("measured zero lost")
	}
}

func usageTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "control.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := workflow.New(db).CreateTask(workflow.Task{ID: "task", Title: "test", RepoPath: "/fixture"}); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRedactedUsageCacheRoundtrip(t *testing.T) {
	s := usageTestStore(t)
	snapshot := unknownUsage(Harness{Version: "fixture"}, "")
	_ = applyQuota(&snapshot, json.RawMessage(`{"accountId":"secret-account","rateLimits":{"primary":{"usedPercent":50}},"auth":{"token":"secret-token"}}`))
	if err := s.cacheUsage("fixture", snapshot); err != nil {
		t.Fatal(err)
	}
	got, err := s.usageCache("fixture")
	if err != nil || got.AccountPoolKey == nil || *got.AccountPoolKey != *snapshot.AccountPoolKey || got.ObservedAt != snapshot.ObservedAt {
		t.Fatalf("cache: %+v %v", got, err)
	}
	var raw string
	if err := s.DB.QueryRow(`SELECT snapshot FROM native_usage_snapshots WHERE key='fixture'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "secret-account") || strings.Contains(raw, "secret-token") {
		t.Fatal("raw account fields persisted")
	}
}

func TestRegisteredThreadUsageDoesNotSumCumulativeEvents(t *testing.T) {
	s := usageTestStore(t)
	for _, id := range []string{"run-a", "run-b", "run-unknown"} {
		thread := "shared-thread"
		if id == "run-unknown" {
			thread = "unobserved-thread"
		}
		_, err := s.DB.Exec(`INSERT INTO native_runs(id,task_id,holder,fencing_token,request_hash,harness,model,purpose,read_only,prompt,status,thread_id,created_at,updated_at) VALUES(?,'task','fixture',1,?,'codex','fixture','review',1,'fixture','completed',?,'2026-10-01','2026-10-01')`, id, id, thread)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []int{10, 20, 20} {
		raw := json.RawMessage([]byte(strings.ReplaceAll(`{"threadId":"shared-thread","tokenUsage":{"total":{"totalTokens":TOKENCOUNT}}}`, "TOKENCOUNT", strconv.Itoa(n))))
		if err := s.Append("run-a", "thread/tokenUsage/updated", raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Append("run-b", "thread/tokenUsage/updated", json.RawMessage(`{"threadId":"shared-thread","tokenUsage":{"total":{"totalTokens":25}}}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Append("run-b", "thread/tokenUsage/updated", json.RawMessage(`{"threadId":"other-thread","tokenUsage":{"total":{"totalTokens":9999}}}`)); err != nil {
		t.Fatal(err)
	}
	threads, err := s.RegisteredThreadTokens()
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 2 {
		t.Fatalf("threads: %+v", threads)
	}
	for _, thread := range threads {
		if len(thread.RunIDs) == 2 {
			if thread.TotalTokens == nil || *thread.TotalTokens != 25 {
				t.Fatalf("cumulative tokens added: %+v", thread)
			}
		} else if thread.Status != "unknown" || thread.TotalTokens != nil {
			t.Fatal("unknown thread became zero")
		}
	}
}

// Opt-in test reads existing account metadata only; it creates no native turn.
func TestLiveUsageRead(t *testing.T) {
	executable := os.Getenv("AGENTKLAR_TEST_LIVE_USAGE_EXECUTABLE")
	if executable == "" {
		t.Skip("requires explicit local native-read opt-in")
	}
	s := usageTestStore(t)
	version, err := exec.Command(executable, "--version").Output()
	if err != nil {
		t.Fatal("cannot read installed native version")
	}
	if err := s.SaveHarness(Harness{Name: "codex", Executable: executable, Version: strings.TrimSpace(string(version))}); err != nil {
		t.Fatal(err)
	}
	supervisor := NewSupervisor(s, workflow.New(s.DB), t.TempDir())
	snapshot, err := supervisor.Usage("")
	if err != nil {
		t.Fatal("local usage read failed")
	}
	// Keep account identifiers, quota amounts, and usage totals out of logs.
	t.Logf("native_read quota_status=%s token_status=%s pool_key_known=%t source_recorded=%t time_recorded=%t warnings=%d", snapshot.Quota.Status, snapshot.AccountTokens.Status, snapshot.AccountPoolKey != nil, snapshot.Source != "", snapshot.ObservedAt != "", len(snapshot.Warnings))
	cached, err := supervisor.Usage("")
	if err != nil || !cached.Cached {
		t.Fatal("second local read did not use the redacted cache")
	}
	if snapshot.Quota.Status != "actual" && snapshot.AccountTokens.Status != "actual" {
		t.Fatal("native server returned no usable account usage metadata")
	}
}
