package team

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"time"
)

// Facts describe observations, not inferred account entitlements.
type Observation struct {
	Source     string    `json:"source"`
	Version    string    `json:"version,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
}

type Capabilities struct {
	Values []string `json:"values"`
	Observation
}

type Availability struct {
	Status string `json:"status"` // available, unavailable, exhausted, or unknown
	Observation
}

type Cost struct {
	Known             bool    `json:"known"`
	IncrementalUSD    float64 `json:"incremental_usd"`
	DelegationSeconds int     `json:"delegation_seconds"`
	Observation
}

type Candidate struct {
	Selection
	Billing             string       `json:"billing"` // subscription, local, or api
	ModelCapabilities   Capabilities `json:"model_capabilities"`
	HarnessCapabilities Capabilities `json:"harness_capabilities"`
	AdapterCapabilities Capabilities `json:"adapter_capabilities"`
	Access              Availability `json:"access"`
	Quota               Availability `json:"quota"`
	Cost                Cost         `json:"cost"`
}

// Comparison must come from dated evidence for a similar task. It is an
// ordering from that source, never a predicted probability of success.
type Comparison struct {
	Preferred Selection `json:"preferred"`
	Other     Selection `json:"other"`
	TaskKind  string    `json:"task_kind"`
	Observation
}

type Request struct {
	TaskID               string       `json:"task_id"`
	RoleID               string       `json:"role_id,omitempty"`
	TaskKind             string       `json:"task_kind,omitempty"`
	RequiredCapabilities []string     `json:"required_capabilities"`
	Current              *Selection   `json:"current,omitempty"`
	Pin                  *Selection   `json:"pin,omitempty"`
	AllowPaidAPI         bool         `json:"allow_paid_api"`
	AsOf                 time.Time    `json:"as_of"`
	Candidates           []Candidate  `json:"candidates"`
	QualityEvidence      []Comparison `json:"quality_evidence"`
}

type Rejection struct {
	Selection
	Reason string `json:"reason"`
}

type Decision struct {
	InputAuthority string        `json:"input_authority"`
	Selection      *Selection    `json:"selection"`
	KeepCurrent    bool          `json:"keep_current"`
	Reason         string        `json:"reason"`
	Confidence     string        `json:"confidence"` // observed, limited, or none; not a probability
	Missing        []string      `json:"missing"`
	Sources        []Observation `json:"sources"`
	Rejected       []Rejection   `json:"rejected"`
}

func (o Observation) known(asOf time.Time) bool {
	return o.Source != "" && !o.ObservedAt.IsZero() && !o.ObservedAt.After(asOf)
}
func (o Observation) fresh(asOf time.Time) bool {
	return o.known(asOf) && asOf.Sub(o.ObservedAt) <= 24*time.Hour
}
func matches(s Selection, c Candidate) bool {
	return (s.Harness == "auto" || s.Harness == c.Harness) && (s.Model == "auto" || s.Model == c.Model)
}

// Validate checks the shared trust boundary before readers make native calls.
func (r Request) Validate(config Config) error {
	if err := config.Validate(); err != nil {
		return err
	}
	if r.AsOf.IsZero() || !identifier.MatchString(r.TaskID) || len(r.RequiredCapabilities) == 0 {
		return errors.New("Task id, observation time, and required capabilities are needed")
	}
	if len(r.RequiredCapabilities) > 64 || len(r.TaskKind) > 128 {
		return errors.New("Too many capability requirements or task kind exceeds 128 bytes")
	}
	for _, capability := range r.RequiredCapabilities {
		if !identifier.MatchString(capability) {
			return errors.New("Invalid required capability")
		}
	}
	if r.RoleID != "" {
		found := false
		for _, role := range config.Roles {
			if role.ID == r.RoleID {
				found = true
				break
			}
		}
		if !found {
			return errors.New("Role is not configured")
		}
	}
	if r.Pin != nil && (!validSelection(r.Pin.Harness, r.Pin.Model, true) || r.Pin.Harness == "auto") {
		return errors.New("Invalid task pin")
	}
	if r.Current != nil && !validSelection(r.Current.Harness, r.Current.Model, false) {
		return errors.New("Invalid current selection")
	}
	return nil
}

// Recommend is advisory. Starting a run must still validate ownership and the
// native harness's own access and permission policy.
func Recommend(config Config, r Request) Decision {
	d := Decision{InputAuthority: "Caller-supplied observations; advisory only, not a native access check", Confidence: "none", Missing: []string{}, Sources: []Observation{}, Rejected: []Rejection{}}
	if err := r.Validate(config); err != nil {
		d.Reason = err.Error()
		return d
	}
	var role *Role
	if r.RoleID != "" {
		for i := range config.Roles {
			if config.Roles[i].ID == r.RoleID {
				role = &config.Roles[i]
				break
			}
		}
	}
	pin := r.Pin
	if pin == nil {
		for _, p := range config.Pins {
			if p.TaskID == r.TaskID {
				pin = &Selection{Harness: p.Harness, Model: p.Model}
				break
			}
		}
	}
	eligible := []Candidate{}
	seen := map[Selection]bool{}
	for _, c := range r.Candidates {
		if seen[c.Selection] {
			d.Reason = "Duplicate catalog candidate"
			return d
		}
		seen[c.Selection] = true
		problem := candidateProblem(c, r, pin != nil && matches(*pin, c))
		if problem != "" {
			d.Rejected = append(d.Rejected, Rejection{c.Selection, problem})
			continue
		}
		if pin != nil && !matches(*pin, c) {
			continue
		}
		eligible = append(eligible, c)
	}
	if pin == nil && role != nil {
		preferred := []Candidate{}
		for _, c := range eligible {
			if matches(Selection{role.Harness, role.Model}, c) {
				preferred = append(preferred, c)
			}
		}
		if len(preferred) > 0 {
			eligible = preferred
		} else {
			fallback := []Candidate{}
			for _, c := range eligible {
				for _, f := range role.AllowedFallback {
					if matches(f, c) {
						fallback = append(fallback, c)
						break
					}
				}
			}
			eligible = fallback
		}
	}
	if len(eligible) == 0 {
		d.Reason = "No eligible candidate matches the task, pin, or allowed role fallback"
		return d
	}
	choose := func(c Candidate, reason string) Decision {
		d.Selection = &c.Selection
		d.Reason = reason
		d.Confidence = "observed"
		if len(d.Missing) > 0 {
			d.Confidence = "limited"
		}
		d.KeepCurrent = r.Current != nil && matches(*r.Current, c)
		d.Sources = []Observation{c.Access.Observation, c.ModelCapabilities.Observation, c.HarnessCapabilities.Observation, c.AdapterCapabilities.Observation}
		if c.Quota.Status == "unknown" || !c.Quota.Observation.fresh(r.AsOf) {
			d.Confidence = "limited"
			d.Missing = append(d.Missing, "Current account quota is unknown; no available balance is assumed")
		} else {
			d.Sources = append(d.Sources, c.Quota.Observation)
		}
		return d
	}
	if pin != nil && len(eligible) == 1 {
		return choose(eligible[0], "Preserve the explicit task pin after capability and access checks")
	}
	var current *Candidate
	for i := range eligible {
		if r.Current != nil && matches(*r.Current, eligible[i]) {
			current = &eligible[i]
			break
		}
	}
	if len(eligible) == 1 {
		return choose(eligible[0], "Only one eligible candidate; no comparative quality claim is made")
	}
	if config.Preference == "quality" {
		winners := []Candidate{}
		for _, candidate := range eligible {
			beatsAll := true
			for _, other := range eligible {
				if candidate.Selection == other.Selection {
					continue
				}
				beats := false
				for _, ev := range r.QualityEvidence {
					if ev.TaskKind != "" && ev.TaskKind == r.TaskKind && ev.Observation.known(r.AsOf) && ev.Preferred == candidate.Selection && ev.Other == other.Selection {
						beats = true
					}
				}
				if !beats {
					beatsAll = false
					break
				}
			}
			if beatsAll {
				winners = append(winners, candidate)
			}
		}
		if len(winners) == 1 {
			out := choose(winners[0], "Dated evidence for this task kind favors this candidate; it does not predict success")
			for _, ev := range r.QualityEvidence {
				if ev.TaskKind == r.TaskKind && ev.Preferred == winners[0].Selection && ev.Observation.known(r.AsOf) {
					out.Sources = append(out.Sources, ev.Observation)
				}
			}
			return out
		}
		d.Missing = append(d.Missing, "Comparable dated quality evidence for this task kind")
	} else if config.Preference == "cost" {
		allKnown := true
		for _, c := range eligible {
			if !c.Cost.Known || !c.Cost.Observation.fresh(r.AsOf) {
				allKnown = false
			}
		}
		if allKnown {
			best := eligible[0]
			for _, c := range eligible[1:] {
				if c.Cost.IncrementalUSD < best.Cost.IncrementalUSD || (c.Cost.IncrementalUSD == best.Cost.IncrementalUSD && c.Cost.DelegationSeconds < best.Cost.DelegationSeconds) {
					best = c
				}
			}
			if current != nil && current.Cost.IncrementalUSD <= best.Cost.IncrementalUSD && current.Cost.DelegationSeconds <= best.Cost.DelegationSeconds {
				return choose(*current, "Keep the capable current agent; delegation has no observed cost or setup advantage")
			}
			ties := 0
			for _, c := range eligible {
				if c.Cost.IncrementalUSD == best.Cost.IncrementalUSD && c.Cost.DelegationSeconds == best.Cost.DelegationSeconds {
					ties++
				}
			}
			if ties == 1 {
				out := choose(best, "Lowest observed incremental cost, then lowest observed delegation overhead")
				for _, c := range eligible {
					out.Sources = append(out.Sources, c.Cost.Observation)
				}
				return out
			}
		}
		d.Missing = append(d.Missing, "Comparable incremental cost and delegation overhead observations")
	}
	if current != nil {
		return choose(*current, "Keep the capable current agent; available evidence does not justify delegation")
	}
	d.Reason = "Available evidence does not establish a unique recommendation; choose or pin a candidate"
	return d
}

func candidateProblem(c Candidate, r Request, explicitPin bool) string {
	if !validSelection(c.Harness, c.Model, false) {
		return "Invalid catalog harness or model"
	}
	if c.Billing != "local" && c.Billing != "subscription" && c.Billing != "api" {
		return "Billing route is unknown"
	}
	if c.Billing == "api" && !r.AllowPaidAPI {
		return "Paid API use requires an explicit choice"
	}
	if c.Access.Status != "available" || !c.Access.Observation.fresh(r.AsOf) {
		return "Account access is unavailable, unknown, or older than 24 hours"
	}
	for _, layer := range []struct {
		name  string
		facts Capabilities
	}{{"model", c.ModelCapabilities}, {"harness", c.HarnessCapabilities}, {"adapter", c.AdapterCapabilities}} {
		if !layer.facts.Observation.known(r.AsOf) || layer.facts.Version == "" {
			return "Missing sourced and versioned " + layer.name + " capabilities"
		}
		for _, cap := range r.RequiredCapabilities {
			if !slices.Contains(layer.facts.Values, cap) {
				return fmt.Sprintf("Required capability %s is absent from %s", cap, layer.name)
			}
		}
	}
	if c.Cost.Known && (math.IsNaN(c.Cost.IncrementalUSD) || math.IsInf(c.Cost.IncrementalUSD, 0) || c.Cost.IncrementalUSD < 0 || c.Cost.DelegationSeconds < 0) {
		return "Invalid observed cost or delegation overhead"
	}
	current := r.Current != nil && matches(*r.Current, c)
	if c.Quota.Status != "available" && c.Quota.Status != "unavailable" && c.Quota.Status != "exhausted" && c.Quota.Status != "unknown" {
		return "Invalid quota observation status"
	}
	if c.Quota.Status == "exhausted" || c.Quota.Status == "unavailable" {
		return "Observed quota is exhausted or unavailable"
	}
	if c.Quota.Status != "available" || !c.Quota.Observation.fresh(r.AsOf) {
		if !current && !explicitPin {
			return "Quota is unknown or older than 24 hours; cannot assume capacity for a new delegation"
		}
	}
	return ""
}
