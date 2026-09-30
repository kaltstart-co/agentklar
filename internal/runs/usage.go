package runs

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"
)

type UsageWindow struct {
	UsedPercent           *float64 `json:"used_percent"`
	RemainingPercent      *float64 `json:"remaining_percent"`
	WindowDurationMinutes *int64   `json:"window_duration_minutes"`
	ResetsAt              *int64   `json:"resets_at"`
}

type UsageBucket struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Primary   *UsageWindow `json:"primary"`
	Secondary *UsageWindow `json:"secondary"`
}

type QuotaUsage struct {
	Status               string        `json:"status"`
	OrdinaryUsageAllowed *bool         `json:"ordinary_usage_allowed"`
	Buckets              []UsageBucket `json:"buckets"`
}

type DailyUsage struct {
	StartDate string `json:"start_date"`
	Tokens    int64  `json:"tokens"`
}

type AccountTokens struct {
	Status         string       `json:"status"`
	LifetimeTokens *int64       `json:"lifetime_tokens"`
	Daily          []DailyUsage `json:"daily"`
}

type RegisteredThreadUsage struct {
	ThreadKey   string   `json:"thread_key"`
	RunIDs      []string `json:"run_ids"`
	Status      string   `json:"status"`
	TotalTokens *int64   `json:"total_tokens"`
	ObservedAt  string   `json:"observed_at"`
	Source      string   `json:"source"`
}

type ThreadEstimate struct {
	RunID        string   `json:"run_id"`
	Status       string   `json:"status"`
	EstimatedUSD *float64 `json:"estimated_usd"`
	ObservedAt   string   `json:"observed_at"`
	Source       string   `json:"source"`
}

type UsageSnapshot struct {
	Harness           string                  `json:"harness"`
	Version           string                  `json:"version"`
	Source            string                  `json:"source"`
	ObservedAt        string                  `json:"observed_at"`
	AccountPoolKey    *string                 `json:"account_pool_key"`
	Quota             QuotaUsage              `json:"quota"`
	AccountTokens     AccountTokens           `json:"account_tokens"`
	RegisteredThreads []RegisteredThreadUsage `json:"registered_threads"`
	ThreadEstimate    *ThreadEstimate         `json:"thread_estimate"`
	SpendStatus       string                  `json:"spend_status"`
	Warnings          []string                `json:"warnings"`
	Cached            bool                    `json:"cached"`
}

func unknownUsage(h Harness, runID string) UsageSnapshot {
	s := UsageSnapshot{Harness: "codex", Version: h.Version, Source: "codex:account/rateLimits/read + account/usage/read", ObservedAt: now(), Quota: QuotaUsage{Status: "unknown", Buckets: []UsageBucket{}}, AccountTokens: AccountTokens{Status: "unknown", Daily: []DailyUsage{}}, RegisteredThreads: []RegisteredThreadUsage{}, SpendStatus: "unknown", Warnings: []string{"Account limits and token activity are shared with native tool use; they are not project consumption or an invoice"}}
	if runID != "" {
		s.ThreadEstimate = &ThreadEstimate{RunID: runID, Status: "unknown", Source: "codex:account/usage/read"}
	}
	return s
}

// usageRead accepts a fixed read-only protocol allowlist; no client can pass an
// auth, billing, credit redemption, experiment opt-in, or inference method.
func usageRead(ctx context.Context, call func(context.Context, string, any) (json.RawMessage, error), method, threadID string) (json.RawMessage, error) {
	switch method {
	case "account/rateLimits/read":
		if threadID != "" {
			return nil, errors.New("quota read does not accept a thread")
		}
		return call(ctx, method, map[string]any{"excludeResetCreditDetails": true})
	case "account/usage/read":
		params := map[string]any{}
		if threadID != "" {
			params["threadId"] = threadID
		}
		return call(ctx, method, params)
	default:
		return nil, errors.New("unsupported native usage method")
	}
}

func localUsageKey(kind, id string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte("agentklar-local-usage:"+kind+":"+id)))
}

type nativeWindow struct {
	UsedPercent        *float64 `json:"usedPercent"`
	WindowDurationMins *int64   `json:"windowDurationMins"`
	ResetsAt           *int64   `json:"resetsAt"`
}
type nativeLimits struct {
	LimitID   string        `json:"limitId"`
	Primary   *nativeWindow `json:"primary"`
	Secondary *nativeWindow `json:"secondary"`
}

var safeBucketID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

func usageWindow(w *nativeWindow) *UsageWindow {
	if w == nil {
		return nil
	}
	out := &UsageWindow{WindowDurationMinutes: w.WindowDurationMins, ResetsAt: w.ResetsAt}
	if w.UsedPercent != nil && *w.UsedPercent >= 0 {
		out.UsedPercent = w.UsedPercent
		remaining := max(0, min(100, 100-*w.UsedPercent))
		out.RemainingPercent = &remaining
	}
	if out.WindowDurationMinutes != nil && *out.WindowDurationMinutes <= 0 {
		out.WindowDurationMinutes = nil
	}
	if out.ResetsAt != nil && *out.ResetsAt <= 0 {
		out.ResetsAt = nil
	}
	return out
}

func applyQuota(s *UsageSnapshot, raw json.RawMessage) error {
	// Raw responses are decoded into an allowlist and never stored or returned.
	var in struct {
		AccountID            *string                 `json:"accountId"`
		OrdinaryUsageAllowed *bool                   `json:"ordinaryUsageAllowed"`
		RateLimits           *nativeLimits           `json:"rateLimits"`
		ByID                 map[string]nativeLimits `json:"rateLimitsByLimitId"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return err
	}
	if in.AccountID != nil && *in.AccountID != "" {
		key := localUsageKey("codex-account", *in.AccountID)
		s.AccountPoolKey = &key
	}
	s.Quota.OrdinaryUsageAllowed = in.OrdinaryUsageAllowed
	buckets := in.ByID
	if len(buckets) == 0 && in.RateLimits != nil {
		id := in.RateLimits.LimitID
		if !safeBucketID.MatchString(id) {
			id = "codex"
		}
		buckets = map[string]nativeLimits{id: *in.RateLimits}
	}
	keys := []string{}
	for id := range buckets {
		if safeBucketID.MatchString(id) {
			keys = append(keys, id)
		}
	}
	sort.Strings(keys)
	for _, id := range keys {
		v := buckets[id]
		s.Quota.Buckets = append(s.Quota.Buckets, UsageBucket{ID: id, Name: id, Primary: usageWindow(v.Primary), Secondary: usageWindow(v.Secondary)})
	}
	usable := in.OrdinaryUsageAllowed != nil
	for _, bucket := range s.Quota.Buckets {
		for _, window := range []*UsageWindow{bucket.Primary, bucket.Secondary} {
			if window != nil && window.UsedPercent != nil {
				usable = true
			}
		}
	}
	if usable {
		s.Quota.Status = "actual"
	}
	return nil
}

type nativeAccountUsage struct {
	Summary struct {
		LifetimeTokens *int64 `json:"lifetimeTokens"`
	} `json:"summary"`
	Daily []struct {
		StartDate string `json:"startDate"`
		Tokens    *int64 `json:"tokens"`
	} `json:"dailyUsageBuckets"`
	Thread *struct {
		ThreadID     string `json:"threadId"`
		EstimatedUSD *int64 `json:"estimatedUsageUsdMicros"`
	} `json:"threadUsage"`
}

func applyAccountTokens(s *UsageSnapshot, raw json.RawMessage) error {
	var in nativeAccountUsage
	if err := json.Unmarshal(raw, &in); err != nil {
		return err
	}
	if in.Summary.LifetimeTokens != nil && *in.Summary.LifetimeTokens >= 0 {
		s.AccountTokens.LifetimeTokens = in.Summary.LifetimeTokens
		s.AccountTokens.Status = "actual"
	}
	for _, d := range in.Daily {
		if _, err := time.Parse("2006-01-02", d.StartDate); err == nil && d.Tokens != nil && *d.Tokens >= 0 {
			s.AccountTokens.Daily = append(s.AccountTokens.Daily, DailyUsage{d.StartDate, *d.Tokens})
			s.AccountTokens.Status = "actual"
		}
	}
	if in.Daily != nil && len(in.Daily) == 0 {
		s.AccountTokens.Status = "actual"
	}
	return nil
}

func applyThreadEstimate(s *UsageSnapshot, raw json.RawMessage, threadID string) error {
	var in nativeAccountUsage
	if err := json.Unmarshal(raw, &in); err != nil {
		return err
	}
	if s.ThreadEstimate != nil && in.Thread != nil && in.Thread.ThreadID == threadID && in.Thread.EstimatedUSD != nil && *in.Thread.EstimatedUSD >= 0 {
		usd := float64(*in.Thread.EstimatedUSD) / 1e6
		s.ThreadEstimate.EstimatedUSD = &usd
		s.ThreadEstimate.Status = "estimated"
		s.ThreadEstimate.ObservedAt = s.ObservedAt
	}
	return nil
}

func (s *Store) usageCache(key string) (UsageSnapshot, error) {
	if _, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS native_usage_snapshots (key TEXT PRIMARY KEY, snapshot TEXT NOT NULL)`); err != nil {
		return UsageSnapshot{}, err
	}
	var raw string
	if err := s.DB.QueryRow(`SELECT snapshot FROM native_usage_snapshots WHERE key=?`, key).Scan(&raw); err != nil {
		return UsageSnapshot{}, err
	}
	var out UsageSnapshot
	err := json.Unmarshal([]byte(raw), &out)
	return out, err
}

func (s *Store) cacheUsage(key string, snapshot UsageSnapshot) error {
	if _, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS native_usage_snapshots (key TEXT PRIMARY KEY, snapshot TEXT NOT NULL)`); err != nil {
		return err
	}
	// This marshals our redacted type, never the native response.
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(`INSERT INTO native_usage_snapshots(key,snapshot) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET snapshot=excluded.snapshot`, key, string(raw))
	return err
}

// RegisteredThreadTokens uses the latest cumulative observation per thread.
// A thread total is not attributed to a run or summed across its notifications.
func (s *Store) RegisteredThreadTokens() ([]RegisteredThreadUsage, error) {
	rows, err := s.DB.Query(`SELECT r.id,r.thread_id,e.payload,e.created_at FROM native_runs r LEFT JOIN native_run_events e ON e.run_id=r.id AND e.method='thread/tokenUsage/updated' WHERE r.thread_id!='' ORDER BY e.seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	threads := map[string]*RegisteredThreadUsage{}
	for rows.Next() {
		var runID, threadID string
		var raw, date sql.NullString
		if err := rows.Scan(&runID, &threadID, &raw, &date); err != nil {
			return nil, err
		}
		entry := threads[threadID]
		if entry == nil {
			entry = &RegisteredThreadUsage{ThreadKey: localUsageKey("thread", threadID), RunIDs: []string{}, Status: "unknown", Source: "codex:thread/tokenUsage/updated"}
			threads[threadID] = entry
		}
		found := false
		for _, id := range entry.RunIDs {
			if id == runID {
				found = true
			}
		}
		if !found {
			entry.RunIDs = append(entry.RunIDs, runID)
		}
		if !raw.Valid {
			continue
		}
		var in struct {
			ThreadID   string `json:"threadId"`
			TokenUsage struct {
				Total struct {
					TotalTokens *int64 `json:"totalTokens"`
				} `json:"total"`
			} `json:"tokenUsage"`
		}
		if json.Unmarshal([]byte(raw.String), &in) != nil || in.ThreadID != threadID || in.TokenUsage.Total.TotalTokens == nil || *in.TokenUsage.Total.TotalTokens < 0 {
			continue
		}
		entry.TotalTokens = in.TokenUsage.Total.TotalTokens
		entry.ObservedAt = date.String
		entry.Status = "actual"
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	keys := []string{}
	for id := range threads {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	out := []RegisteredThreadUsage{}
	for _, id := range keys {
		sort.Strings(threads[id].RunIDs)
		out = append(out, *threads[id])
	}
	return out, nil
}

// Usage reads existing native account metadata without starting a model turn.
// Optional estimates are limited to threads belonging to registered runs.
func (s *Supervisor) Usage(runID string) (UsageSnapshot, error) {
	threadID := ""
	if runID != "" {
		r, err := s.Store.Get(runID)
		if err != nil {
			return UsageSnapshot{}, err
		}
		threadID = r.ThreadID
	}
	h, err := s.codexHarness()
	if err != nil {
		return UsageSnapshot{}, err
	}
	key := "codex:" + runID
	cached, cacheErr := s.Store.usageCache(key)
	if cacheErr != nil && !errors.Is(cacheErr, sql.ErrNoRows) {
		return UsageSnapshot{}, cacheErr
	}
	if cacheErr == nil {
		at, err := time.Parse(time.RFC3339Nano, cached.ObservedAt)
		if err == nil && time.Since(at) >= 0 && time.Since(at) < time.Minute && cached.Version == h.Version {
			cached.Cached = true
			cached.RegisteredThreads, err = s.Store.RegisteredThreadTokens()
			return cached, err
		}
	}
	out := unknownUsage(h, runID)
	c, err := openCodex(h, s.Repo)
	if err != nil {
		out.Warnings = append(out.Warnings, "Native usage connection unavailable; no account values are assumed")
	} else {
		defer c.close()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		raw, readErr := usageRead(ctx, c.call, "account/rateLimits/read", "")
		if readErr != nil || applyQuota(&out, raw) != nil {
			out.Warnings = append(out.Warnings, "Native account limits are unavailable or invalid")
		}
		raw, readErr = usageRead(ctx, c.call, "account/usage/read", "")
		if readErr != nil || applyAccountTokens(&out, raw) != nil {
			out.Warnings = append(out.Warnings, "Native account token activity is unavailable or invalid")
		}
		if threadID != "" {
			raw, readErr = usageRead(ctx, c.call, "account/usage/read", threadID)
			if readErr != nil || applyThreadEstimate(&out, raw, threadID) != nil {
				out.Warnings = append(out.Warnings, "Registered thread estimate is unavailable or invalid")
			}
		}
	}
	if err := s.Store.cacheUsage(key, out); err != nil {
		return UsageSnapshot{}, err
	}
	out.RegisteredThreads, err = s.Store.RegisteredThreadTokens()
	return out, err
}
