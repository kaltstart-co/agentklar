package team

import (
	"strings"
	"testing"
	"time"
)

func routingFixture() (Config, Request) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	o := Observation{Source: "unit fixture; no native integration claim", Version: "fixture-v1", ObservedAt: now.Add(-time.Hour)}
	caps := Capabilities{Values: []string{"text"}, Observation: o}
	a := Candidate{Selection: Selection{"codex", "large"}, Billing: "subscription", ModelCapabilities: caps, HarnessCapabilities: caps, AdapterCapabilities: caps, Access: Availability{"available", o}, Quota: Availability{"available", o}, Cost: Cost{Known: true, IncrementalUSD: 2, DelegationSeconds: 0, Observation: o}}
	b := a
	b.Selection = Selection{"claude", "small"}
	b.Cost.IncrementalUSD = .2
	b.Cost.DelegationSeconds = 3
	return Default(), Request{TaskID: "task-1", TaskKind: "code", RequiredCapabilities: []string{"text"}, AsOf: now, Candidates: []Candidate{a, b}}
}

func TestRoutingContracts(t *testing.T) {
	for _, tc := range []struct {
		name    string
		edit    func(*Config, *Request)
		want    Selection
		reason  string
		limited bool
	}{
		{"task pin wins over cost", func(c *Config, r *Request) { c.Preference = "cost"; c.Pins = []Pin{{"task-1", "codex", "large"}} }, Selection{"codex", "large"}, "pin", false},
		{"pin model not substituted", func(c *Config, r *Request) { r.Pin = &Selection{"codex", "absent"} }, Selection{}, "No eligible", false},
		{"request pin overrides saved pin", func(c *Config, r *Request) {
			c.Pins = []Pin{{"task-1", "codex", "large"}}
			r.Pin = &Selection{"claude", "small"}
		}, Selection{"claude", "small"}, "pin", false},
		{"capability mismatch", func(c *Config, r *Request) {
			r.RequiredCapabilities = []string{"image"}
			for i := range r.Candidates {
				r.Candidates[i].ModelCapabilities.Values = []string{"text", "image"}
				r.Candidates[i].HarnessCapabilities.Values = []string{"text", "image"}
			}
		}, Selection{}, "No eligible", false},
		{"unavailable harness", func(c *Config, r *Request) {
			r.Candidates = r.Candidates[:1]
			r.Candidates[0].Access.Status = "unavailable"
		}, Selection{}, "No eligible", false},
		{"unknown quota prevents new delegation", func(c *Config, r *Request) {
			for i := range r.Candidates {
				r.Candidates[i].Quota.Status = "unknown"
			}
		}, Selection{}, "No eligible", false},
		{"unknown quota keeps current", func(c *Config, r *Request) {
			r.Current = &r.Candidates[0].Selection
			r.Candidates[0].Quota.Status = "unknown"
		}, Selection{"codex", "large"}, "Keep", true},
		{"explicit pin with unknown quota", func(c *Config, r *Request) {
			r.Pin = &Selection{"codex", "large"}
			r.Candidates[0].Quota.Status = "unknown"
		}, Selection{"codex", "large"}, "pin", true},
		{"exhausted current rejected", func(c *Config, r *Request) {
			r.Current = &r.Candidates[0].Selection
			r.Candidates = r.Candidates[:1]
			r.Candidates[0].Quota.Status = "exhausted"
		}, Selection{}, "No eligible", false},
		{"cost preference", func(c *Config, r *Request) { c.Preference = "cost" }, Selection{"claude", "small"}, "cost", false},
		{"unknown costs retain current", func(c *Config, r *Request) {
			c.Preference = "cost"
			r.Current = &r.Candidates[0].Selection
			for i := range r.Candidates {
				r.Candidates[i].Cost.Known = false
			}
		}, Selection{"codex", "large"}, "Keep", true},
		{"balanced retains current", func(c *Config, r *Request) { r.Current = &r.Candidates[0].Selection }, Selection{"codex", "large"}, "Keep", false},
		{"missing quality no invented ranking", func(c *Config, r *Request) { c.Preference = "quality" }, Selection{}, "unique recommendation", false},
		{"dated quality comparison", func(c *Config, r *Request) {
			c.Preference = "quality"
			r.QualityEvidence = []Comparison{{Preferred: r.Candidates[0].Selection, Other: r.Candidates[1].Selection, TaskKind: "code", Observation: r.Candidates[0].Access.Observation}}
		}, Selection{"codex", "large"}, "Dated evidence", false},
		{"unrelated quality evidence ignored", func(c *Config, r *Request) {
			c.Preference = "quality"
			r.QualityEvidence = []Comparison{{Preferred: r.Candidates[0].Selection, Other: r.Candidates[1].Selection, TaskKind: "poetry", Observation: r.Candidates[0].Access.Observation}}
		}, Selection{}, "unique recommendation", false},
		{"paid API fallback blocked", func(c *Config, r *Request) { r.Candidates = r.Candidates[:1]; r.Candidates[0].Billing = "api" }, Selection{}, "No eligible", false},
		{"explicit paid API permitted", func(c *Config, r *Request) {
			r.Candidates = r.Candidates[:1]
			r.Candidates[0].Billing = "api"
			r.AllowPaidAPI = true
		}, Selection{"codex", "large"}, "Only one", false},
		{"unsourced access rejected", func(c *Config, r *Request) { r.Candidates = r.Candidates[:1]; r.Candidates[0].Access.Source = "" }, Selection{}, "No eligible", false},
		{"stale access rejected", func(c *Config, r *Request) {
			r.Candidates = r.Candidates[:1]
			r.Candidates[0].Access.ObservedAt = r.AsOf.Add(-25 * time.Hour)
		}, Selection{}, "No eligible", false},
		{"role allowed fallback", func(c *Config, r *Request) {
			c.Roles = []Role{{ID: "build", Responsibility: "Build", Harness: "missing", Model: "auto", AllowedFallback: []Selection{{"claude", "small"}}}}
			r.RoleID = "build"
		}, Selection{"claude", "small"}, "Only one", false},
		{"role fallback not granted", func(c *Config, r *Request) {
			c.Roles = []Role{{ID: "build", Responsibility: "Build", Harness: "missing", Model: "auto"}}
			r.RoleID = "build"
		}, Selection{}, "No eligible", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, r := routingFixture()
			tc.edit(&c, &r)
			d := Recommend(c, r)
			if tc.want == (Selection{}) {
				if d.Selection != nil {
					t.Fatalf("unexpected selection: %+v", d)
				}
			} else if d.Selection == nil || *d.Selection != tc.want {
				t.Fatalf("selection: %+v", d)
			}
			if !strings.Contains(d.Reason, tc.reason) {
				t.Fatalf("reason: %+v", d)
			}
			if tc.limited && d.Confidence != "limited" {
				t.Fatalf("missing evidence must limit confidence: %+v", d)
			}
		})
	}
}

func TestNoDelegationWithoutAllCapabilitySources(t *testing.T) {
	for _, layer := range []string{"model", "harness", "adapter"} {
		t.Run(layer, func(t *testing.T) {
			c, r := routingFixture()
			r.Candidates = r.Candidates[:1]
			switch layer {
			case "model":
				r.Candidates[0].ModelCapabilities.Source = ""
			case "harness":
				r.Candidates[0].HarnessCapabilities.Version = ""
			case "adapter":
				r.Candidates[0].AdapterCapabilities.Values = nil
			}
			d := Recommend(c, r)
			if d.Selection != nil || len(d.Rejected) != 1 {
				t.Fatalf("missing capability accepted: %+v", d)
			}
		})
	}
}
