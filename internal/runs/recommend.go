package runs

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"time"

	"github.com/kaltstart-co/agentklar/internal/team"
)

// RecommendationRequest contains choices and requirements, never caller facts
// about credentials, prices, capacity, or tested model quality.
type RecommendationRequest struct {
	TaskID               string          `json:"task_id"`
	RoleID               string          `json:"role_id,omitempty"`
	TaskKind             string          `json:"task_kind,omitempty"`
	RequiredCapabilities []string        `json:"required_capabilities"`
	Current              *team.Selection `json:"current,omitempty"`
	Pin                  *team.Selection `json:"pin,omitempty"`
}

type Recommendation struct {
	team.Decision
	Action            string                    `json:"action"` // keep_current, nominate_worker, no_recommendation
	TaskID            string                    `json:"task_id"`
	Preference        string                    `json:"preference"`
	PolicyRevision    string                    `json:"policy_revision"`
	Candidates        []RecommendationCandidate `json:"candidates"`
	OmittedCandidates int                       `json:"omitted_candidates"`
	AccountQuota      *RecommendationQuota      `json:"account_quota,omitempty"`
}

type RecommendationCandidate struct {
	team.Selection
	AdvertisedInputs []string `json:"advertised_inputs"`
	EffectiveInputs  []string `json:"effective_adapter_inputs"`
	Access           string   `json:"access"`
	ModelQuota       string   `json:"model_quota"`
	Billing          string   `json:"billing"`
	Cost             string   `json:"cost"`
}

type RecommendationQuota struct {
	QuotaUsage
	OmittedBuckets int `json:"omitted_buckets"`
	team.Observation
}

// The native tools already expose full catalogs and usage histories. Advice
// keeps at most six candidates and four shared quota buckets, without ranking
// catalog order or attributing account history to this task.
func projectRecommendation(config team.Config, request RecommendationRequest, candidates []team.Candidate, usage *UsageSnapshot) ([]RecommendationCandidate, int, *RecommendationQuota) {
	preferred := []team.Selection{}
	if request.Pin != nil {
		preferred = append(preferred, *request.Pin)
	}
	for _, pin := range config.Pins {
		if pin.TaskID == request.TaskID {
			preferred = append(preferred, team.Selection{Harness: pin.Harness, Model: pin.Model})
		}
	}
	if request.Current != nil {
		preferred = append(preferred, *request.Current)
	}
	for _, role := range config.Roles {
		if role.ID == request.RoleID {
			preferred = append(preferred, team.Selection{Harness: role.Harness, Model: role.Model})
			preferred = append(preferred, role.AllowedFallback...)
		}
	}
	view := []RecommendationCandidate{}
	seen := map[team.Selection]bool{}
	add := func(c team.Candidate) {
		if seen[c.Selection] || len(view) == 6 {
			return
		}
		seen[c.Selection] = true
		effective := []string{}
		for _, input := range c.ModelCapabilities.Values {
			if slices.Contains(c.HarnessCapabilities.Values, input) && slices.Contains(c.AdapterCapabilities.Values, input) {
				effective = append(effective, input)
			}
		}
		view = append(view, RecommendationCandidate{Selection: c.Selection, AdvertisedInputs: c.ModelCapabilities.Values, EffectiveInputs: effective, Access: c.Access.Status, ModelQuota: c.Quota.Status, Billing: c.Billing, Cost: "unknown"})
	}
	for _, selection := range preferred {
		for _, candidate := range candidates {
			if selection.Harness != "auto" && selection.Model != "auto" && candidate.Selection == selection {
				add(candidate)
			}
		}
	}
	for _, candidate := range candidates {
		add(candidate)
	}
	var quota *RecommendationQuota
	if usage != nil {
		quota = &RecommendationQuota{QuotaUsage: usage.Quota, Observation: team.Observation{Source: "codex:account/rateLimits/read (shared account, not per-model capacity)", Version: usage.Version}}
		quota.ObservedAt, _ = time.Parse(time.RFC3339Nano, usage.ObservedAt)
		if len(quota.Buckets) > 4 {
			quota.OmittedBuckets = len(quota.Buckets) - 4
			quota.Buckets = quota.Buckets[:4]
		}
	}
	return view, len(candidates) - len(view), quota
}

var catalogModelID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$`)

func selectionsMatch(preference, selection team.Selection) bool {
	return (preference.Harness == "auto" || preference.Harness == selection.Harness) && (preference.Model == "auto" || preference.Model == selection.Model)
}

func advertisedCandidates(h Harness, raw json.RawMessage, at time.Time, quota *UsageSnapshot) ([]team.Candidate, error) {
	var catalog struct {
		Data []struct {
			Model           string   `json:"model"`
			InputModalities []string `json:"inputModalities"`
			Hidden          bool     `json:"hidden"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil || catalog.Data == nil {
		return nil, errors.New("native model catalog is unavailable or invalid")
	}
	models := map[string]bool{}
	out := []team.Candidate{}
	for _, model := range catalog.Data {
		if model.Hidden || !catalogModelID.MatchString(model.Model) || models[model.Model] {
			continue
		}
		models[model.Model] = true
		modalities := []string{}
		for _, modality := range model.InputModalities {
			if (modality == "text" || modality == "image" || modality == "audio") && !slices.Contains(modalities, modality) {
				modalities = append(modalities, modality)
			}
		}
		c := team.Candidate{
			Selection: team.Selection{Harness: "codex", Model: model.Model}, Billing: "unknown",
			ModelCapabilities:   team.Capabilities{Values: modalities, Observation: team.Observation{Source: "codex:model/list.inputModalities (advertised, not tested quality or entitlement)", Version: h.Version, ObservedAt: at}},
			HarnessCapabilities: team.Capabilities{Values: []string{"text"}, Observation: team.Observation{Source: "agentklar:codex-app-server/turn-start-text-contract", Version: h.Version, ObservedAt: at}},
			AdapterCapabilities: team.Capabilities{Values: []string{"text"}, Observation: team.Observation{Source: "agentklar:registered-run/text-input", Version: "1", ObservedAt: at}},
			Access:              team.Availability{Status: "unknown"}, Quota: team.Availability{Status: "unknown"},
		}
		if quotaBlocks(quota, at) {
			observed, _ := time.Parse(time.RFC3339Nano, quota.ObservedAt)
			c.Quota = team.Availability{Status: "unavailable", Observation: team.Observation{Source: "codex:account/rateLimits/read.ordinaryUsageAllowed (shared account)", Version: quota.Version, ObservedAt: observed}}
		}
		out = append(out, c)
	}
	return out, nil
}

func quotaBlocks(quota *UsageSnapshot, at time.Time) bool {
	if quota == nil || quota.Quota.OrdinaryUsageAllowed == nil || *quota.Quota.OrdinaryUsageAllowed {
		return false
	}
	observed, err := time.Parse(time.RFC3339Nano, quota.ObservedAt)
	return err == nil && !observed.After(at) && at.Sub(observed) <= 24*time.Hour
}

func advertisedFit(c team.Candidate, requirements []string) bool {
	for _, facts := range []team.Capabilities{c.ModelCapabilities, c.HarnessCapabilities, c.AdapterCapabilities} {
		if facts.Source == "" || facts.Version == "" {
			return false
		}
		for _, requirement := range requirements {
			if !slices.Contains(facts.Values, requirement) {
				return false
			}
		}
	}
	return c.Quota.Status != "unavailable"
}

// roleAllows preserves the ranker's preference-then-explicit-fallback rule.
// Pins take precedence in Recommend and are handled before this check.
func roleAllows(config team.Config, request RecommendationRequest, selection team.Selection, candidates []team.Candidate) bool {
	if request.RoleID == "" {
		return true
	}
	for _, role := range config.Roles {
		if role.ID != request.RoleID {
			continue
		}
		preferred := team.Selection{Harness: role.Harness, Model: role.Model}
		for _, c := range candidates {
			if selectionsMatch(preferred, c.Selection) && advertisedFit(c, request.RequiredCapabilities) {
				return selectionsMatch(preferred, selection)
			}
		}
		if selectionsMatch(preferred, selection) {
			return true
		}
		for _, fallback := range role.AllowedFallback {
			if selectionsMatch(fallback, selection) {
				return true
			}
		}
	}
	return false
}

func recommendation(config team.Config, revision string, request RecommendationRequest, candidates []team.Candidate, usage *UsageSnapshot, at time.Time) Recommendation {
	r := team.Request{TaskID: request.TaskID, RoleID: request.RoleID, TaskKind: request.TaskKind, RequiredCapabilities: request.RequiredCapabilities, Current: request.Current, Pin: request.Pin, AsOf: at, Candidates: candidates}
	view, omitted, quota := projectRecommendation(config, request, candidates, usage)
	out := Recommendation{Decision: team.Recommend(config, r), Action: "no_recommendation", TaskID: request.TaskID, Preference: config.Preference, PolicyRevision: revision, Candidates: view, OmittedCandidates: omitted, AccountQuota: quota}
	visible := map[team.Selection]bool{}
	for _, candidate := range view {
		visible[candidate.Selection] = true
	}
	rejected := []team.Rejection{}
	for _, rejection := range out.Rejected {
		if visible[rejection.Selection] {
			rejected = append(rejected, rejection)
		}
	}
	out.Rejected = rejected
	out.InputAuthority = "Service-read native observations and saved project policy; nominations do not verify access or authorize a launch"
	out.Missing = append(out.Missing, "Native launch must verify selected model access and the effective billing route; catalog membership is not entitlement", "Per-model quota is unknown; account windows and ordinary usage permission are shared observations")
	if config.Preference == "cost" {
		out.Missing = append(out.Missing, "Comparable incremental costs and delegation overhead; subscription usage does not imply zero cost")
	}
	if config.Preference == "quality" {
		out.Missing = append(out.Missing, "Comparable dated quality evidence for this task kind; input modalities do not measure coding quality")
	}
	if quota != nil && !quota.ObservedAt.IsZero() {
		out.Sources = append(out.Sources, quota.Observation)
	}
	if len(candidates) > 0 {
		out.Sources = append(out.Sources, candidates[0].ModelCapabilities.Observation, candidates[0].HarnessCapabilities.Observation, candidates[0].AdapterCapabilities.Observation)
	}
	if omitted > 0 {
		out.Missing = append(out.Missing, "Additional candidates are omitted from this short advice response; use get_model_catalog for browsing. Catalog order is not a quality or cost ranking")
	}
	pin := request.Pin
	if pin == nil {
		for _, saved := range config.Pins {
			if saved.TaskID == request.TaskID {
				pin = &team.Selection{Harness: saved.Harness, Model: saved.Model}
				break
			}
		}
	}
	if quotaBlocks(usage, at) && (pin != nil && pin.Harness == "codex" || pin == nil && (request.Current == nil || request.Current.Harness == "codex")) {
		out.Reason = "Native ordinary account usage is disallowed; no worker is nominated and no billing fallback is assumed"
		return out
	}
	setChoice := func(selection team.Selection, candidate *team.Candidate, action, reason string) {
		out.Selection = &selection
		out.Action = action
		out.KeepCurrent = action == "keep_current"
		out.Confidence = "limited"
		out.Reason = reason
		if candidate == nil {
			out.Confidence = "none"
			out.Missing = append(out.Missing, "Current harness/model capabilities have no supported service observation; confirm the task requirements in its native tool")
		}
	}
	if pin != nil {
		matching := []team.Candidate{}
		for _, c := range candidates {
			if selectionsMatch(*pin, c.Selection) && advertisedFit(c, request.RequiredCapabilities) {
				matching = append(matching, c)
			}
		}
		if len(matching) == 1 {
			candidate := matching[0]
			action := "nominate_worker"
			if request.Current != nil && *request.Current == candidate.Selection {
				action = "keep_current"
			}
			setChoice(candidate.Selection, &candidate, action, "Preserve the explicit task pin as a nomination; input support is advertised and native launch must verify access, billing, and limits")
		} else {
			out.Reason = "The explicit task pin has no unique advertised candidate that fits the adapter and task requirements; it was not substituted"
			out.Missing = append(out.Missing, "Check the pinned model in the native catalog and use a named model when an auto pin matches several models")
		}
		return out
	}
	if request.RoleID != "" {
		for _, role := range config.Roles {
			if role.ID != request.RoleID {
				continue
			}
			preferred := []team.Candidate{}
			fallback := []team.Candidate{}
			for _, candidate := range candidates {
				if !advertisedFit(candidate, request.RequiredCapabilities) {
					continue
				}
				if selectionsMatch(team.Selection{Harness: role.Harness, Model: role.Model}, candidate.Selection) {
					preferred = append(preferred, candidate)
				}
				for _, selection := range role.AllowedFallback {
					if selectionsMatch(selection, candidate.Selection) {
						fallback = append(fallback, candidate)
						break
					}
				}
			}
			choices := preferred
			if len(choices) == 0 {
				choices = fallback
			}
			if len(choices) == 1 && (len(preferred) == 0 || role.Harness != "auto" && role.Model != "auto") {
				candidate := choices[0]
				action := "nominate_worker"
				if request.Current != nil && *request.Current == candidate.Selection {
					action = "keep_current"
				}
				setChoice(candidate.Selection, &candidate, action, "Preserve the saved role preference or unique allowed fallback as a nomination; native launch must verify access, billing, and limits")
				return out
			}
		}
	}
	if request.Current != nil && roleAllows(config, request, *request.Current, candidates) {
		for _, candidate := range candidates {
			if candidate.Selection != *request.Current {
				continue
			}
			if advertisedFit(candidate, request.RequiredCapabilities) {
				setChoice(candidate.Selection, &candidate, "keep_current", "Keep the current choice; no observed cost or quality advantage justifies switching. Advertised input support does not verify model access or task quality")
			} else {
				out.Reason = "The current candidate lacks advertised input support or adapter support for a required capability"
			}
			return out
		}
		setChoice(*request.Current, nil, "keep_current", "Preserve the current choice because no supported evidence justifies a switch; its capabilities and access remain unverified")
		return out
	}
	out.Reason = "No explicit task pin or compatible current choice is available; select a native candidate or save a task pin after checking the missing evidence"
	return out
}

// RecommendTask reads metadata only. It never starts a thread/turn, changes
// native settings, or treats account percentages as per-model permission.
func (s *Supervisor) RecommendTask(request RecommendationRequest) (Recommendation, error) {
	task, err := s.Engine.GetTask(request.TaskID)
	if err != nil {
		return Recommendation{}, err
	}
	if task.RepoPath != s.Repo {
		return Recommendation{}, errors.New("recommendation task is outside this repository")
	}
	config, revision, err := team.LoadRevision(s.Repo)
	if err != nil {
		return Recommendation{}, err
	}
	at := time.Now().UTC()
	validation := team.Request{TaskID: request.TaskID, RoleID: request.RoleID, TaskKind: request.TaskKind, RequiredCapabilities: request.RequiredCapabilities, Current: request.Current, Pin: request.Pin, AsOf: at}
	if err := validation.Validate(config); err != nil {
		return Recommendation{}, err
	}
	h, err := s.codexHarness()
	if err != nil {
		out := recommendation(config, revision, request, []team.Candidate{}, nil, at)
		out.Missing = append(out.Missing, "Discover and register a supported native harness before nominating a worker")
		return out, nil
	}
	// Independent readers avoid adding their native read timeouts together.
	type catalogResult struct {
		raw json.RawMessage
		err error
		at  time.Time
	}
	models := make(chan catalogResult, 1)
	go func() {
		raw, err := Catalog(h, s.Repo)
		models <- catalogResult{raw: raw, err: err, at: time.Now().UTC()}
	}()
	usage, usageErr := s.Usage("")
	modelResult := <-models
	var snapshot *UsageSnapshot
	if usageErr == nil {
		snapshot = &usage
	}
	at = time.Now().UTC()
	candidates := []team.Candidate{}
	if modelResult.err == nil {
		candidates, modelResult.err = advertisedCandidates(h, modelResult.raw, modelResult.at, snapshot)
	}
	out := recommendation(config, revision, request, candidates, snapshot, at)
	var pagination struct {
		NextCursor *string `json:"nextCursor"`
	}
	if json.Unmarshal(modelResult.raw, &pagination) == nil && pagination.NextCursor != nil && *pagination.NextCursor != "" {
		out.Missing = append(out.Missing, "Native catalog has more pages; an unlisted selection has not been proven unavailable")
	}
	if modelResult.err != nil {
		out.Missing = append(out.Missing, "Native model catalog could not be read; model names and modalities were not inferred")
	}
	if usageErr != nil || snapshot == nil || snapshot.Quota.Status == "unknown" {
		out.Missing = append(out.Missing, "Native account quota or usage could not be established; check it in the native tool")
	}
	return out, nil
}
