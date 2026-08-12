package ui

import (
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// errNotPending signals that a task is not awaiting human approval; the approve
// endpoint maps it to 409 and changes nothing.
var errNotPending = errors.New("task is not pending user approval")

// --- HTML pages ---

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	if s.catalog == nil {
		s.handleBoard(w, r)
		return
	}
	overview, err := s.overview()
	attention := make([]projectOverview, 0, len(overview))
	for _, project := range overview {
		if project.Attention > 0 || project.Alerts > 0 {
			attention = append(attention, project)
		}
	}
	d := viewData{Title: "Overview", Section: "overview", Overview: overview, Attention: attention}
	if err != nil {
		d.Error = err.Error()
	}
	s.renderRequest(w, r, "overview", d)
}

func (s *Server) handleBoard(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project")
	engine, closeFn, err := s.engineForProject(projectID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer closeFn()
	archived := r.URL.Query().Get("archived") == "true"
	var tasks []workflow.Task
	if archived {
		tasks, err = engine.ListArchived()
	} else {
		tasks, err = engine.ListAll()
	}
	if err != nil {
		s.renderRequest(w, r, "board", viewData{Title: "Board", Section: "board", Error: err.Error(), ProjectID: projectID})
		return
	}
	buckets := make(map[contracts.State][]workflow.Task)
	for _, t := range tasks {
		buckets[t.State] = append(buckets[t.State], t)
	}
	columns := make([]columnView, 0, len(boardOrder()))
	for _, st := range boardOrder() {
		columns = append(columns, columnView{State: st, Label: stateLabel(st), Tasks: buckets[st]})
	}
	prefix := ""
	if s.catalog != nil {
		if projectID == "" {
			projectID = s.currentProjectID
		}
		prefix = "/projects/" + url.PathEscape(projectID)
	}
	s.renderRequest(w, r, "board", viewData{Title: "Board", Section: "board", Columns: columns, ProjectID: projectID, TaskPrefix: prefix, Archived: archived, AllTasks: tasks})
}

func (s *Server) handleTask(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project")
	engine, closeFn, err := s.engineForProject(projectID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer closeFn()
	id := r.PathValue("id")
	if id == "" {
		id = r.PathValue("task")
	}
	t, err := engine.GetTask(id)
	if err != nil {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}
	ev, err := engine.ListEvidence(id)
	if err != nil {
		http.Error(w, "evidence unavailable: "+err.Error(), http.StatusInternalServerError)
		return
	}
	comments, err := listEngineComments(engine, id)
	if err != nil {
		http.Error(w, "timeline unavailable: "+err.Error(), http.StatusInternalServerError)
		return
	}
	reviews, err := listEngineReviews(engine, id)
	if err != nil {
		http.Error(w, "reviews unavailable: "+err.Error(), http.StatusInternalServerError)
		return
	}
	deps, err := engine.Dependencies(id)
	if err != nil {
		http.Error(w, "dependencies unavailable: "+err.Error(), http.StatusInternalServerError)
		return
	}
	allTasks, err := engine.ListAll()
	if err != nil {
		http.Error(w, "tasks unavailable: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.renderRequest(w, r, "task", viewData{
		Title:        t.Title,
		Section:      "board",
		StateLabel:   stateLabel(t.State),
		Task:         t,
		Evidence:     ev,
		Comments:     comments,
		Reviews:      reviews,
		ProjectID:    projectID,
		Dependencies: deps,
		AllTasks:     allTasks,
	})
}

func (s *Server) handleKnowledge(w http.ResponseWriter, r *http.Request) {
	d := viewData{Title: "Knowledge", Section: "intelligence"}
	store, err := s.knowledgeForProject(r.PathValue("project"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if store == nil {
		d.KnowOK = false
		s.renderRequest(w, r, "knowledge", d)
		return
	}
	d.KnowOK = true
	entries, err := store.List()
	if err != nil {
		d.Error = err.Error()
		s.renderRequest(w, r, "knowledge", d)
		return
	}
	// Stable, kind-grouped ordering: decisions, then conventions, glossary, runbook.
	sort.SliceStable(entries, func(i, j int) bool {
		ki, kj := string(entries[i].Kind), string(entries[j].Kind)
		if ki != kj {
			return kindOrder(ki) < kindOrder(kj)
		}
		return entries[i].Slug < entries[j].Slug
	})
	d.Knowledge = entries
	s.renderRequest(w, r, "knowledge", d)
}

func (s *Server) handleMemory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	namespace := strings.TrimSpace(r.URL.Query().Get("namespace"))
	taskScope := strings.TrimSpace(r.URL.Query().Get("task"))
	d := viewData{Title: "Memory", Section: "intelligence", Q: q, Namespace: namespace, TaskScope: taskScope}
	store, closeFn, err := s.memoryForProject(r.PathValue("project"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer closeFn()
	if store == nil {
		d.MemOK = false
		s.renderRequest(w, r, "memory", d)
		return
	}
	d.MemOK = true
	all, err := store.List("")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	seen := make(map[string]bool)
	for _, entry := range all {
		if entry.Namespace != "" && !seen[entry.Namespace] {
			seen[entry.Namespace] = true
			d.MemoryNamespaces = append(d.MemoryNamespaces, entry.Namespace)
		}
	}
	sort.Strings(d.MemoryNamespaces)
	if q != "" {
		d.Memory, err = store.RecallScoped(q, namespace, taskScope, 50)
	} else {
		d.Memory, err = store.ListScoped(namespace, taskScope)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.renderRequest(w, r, "memory", d)
}

func (s *Server) handleContext(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	taskScope := strings.TrimSpace(r.URL.Query().Get("task"))
	d := viewData{Title: "Context", Section: "intelligence", Q: q, TaskScope: taskScope}
	store, closeFn, err := s.contextForProject(r.PathValue("project"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer closeFn()
	if store == nil {
		d.CtxOK = false
		s.renderRequest(w, r, "context", d)
		return
	}
	d.CtxOK = true
	d.ContextPkt, err = store.PacketScoped(q, taskScope, 50)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	d.ContextIndexedAt, err = store.LastReindexedAt()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.renderRequest(w, r, "context", d)
}

func (s *Server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	human := s.isHuman(r)
	if human {
		w.Header().Set("Cache-Control", "no-store")
	}
	apps, err := s.allPendingApprovals(human)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.renderRequest(w, r, "approvals", viewData{Title: "Approvals", Section: "approvals", Approvals: apps})
}

// handleApproveHTML is the trusted local approval channel: the human clicks.
// It resolves the pending nonce via the engine and advances the task to Done.
// On any error the protected state is unchanged and a 409 is returned.
func (s *Server) handleApproveHTML(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	if err := s.approve(r.PathValue("project"), id, r.PostForm.Get("csrf_token")); err != nil {
		if errors.Is(err, errInvalidFormToken) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, err.Error(), approvalErrorStatus(err))
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// handleAlerts renders the alert log. Agents raise alerts (notify_human);
// only the human acknowledges them here.
func (s *Server) handleAlerts(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project")
	alerts, ok, err := s.allAlerts(projectID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.renderRequest(w, r, "alerts", viewData{Title: "Alerts", Section: "alerts", Alerts: alerts, AlertOK: ok, AlertGlobal: s.catalog != nil && projectID == ""})
}

func (s *Server) allAlerts(projectID string) ([]alertView, bool, error) {
	if s.catalog == nil {
		if s.alerts == nil {
			return nil, false, nil
		}
		rows, err := s.alerts.List("")
		out := make([]alertView, 0, len(rows))
		for _, row := range rows {
			out = append(out, alertView{Alert: row, Action: "/alerts/" + strconv.FormatInt(row.ID, 10) + "/ack"})
		}
		sortAlertViews(out)
		return out, true, err
	}
	projects, err := s.catalog.List()
	if err != nil {
		return nil, false, err
	}
	var out []alertView
	for _, project := range projects {
		if projectID != "" && project.ID != projectID {
			continue
		}
		store, closeFn, err := s.alertsForProject(project.ID)
		if err != nil {
			return nil, false, err
		}
		rows, listErr := store.List("")
		closeFn()
		if listErr != nil {
			return nil, false, listErr
		}
		for _, row := range rows {
			out = append(out, alertView{Alert: row, ProjectID: project.ID, ProjectName: project.Name,
				Action: "/projects/" + url.PathEscape(project.ID) + "/alerts/" + strconv.FormatInt(row.ID, 10) + "/ack"})
		}
	}
	sortAlertViews(out)
	return out, true, nil
}

func sortAlertViews(out []alertView) {
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Acknowledged != out[j].Acknowledged {
			return !out[i].Acknowledged
		}
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		if out[i].ProjectID != out[j].ProjectID {
			return out[i].ProjectID < out[j].ProjectID
		}
		return out[i].ID > out[j].ID
	})
}

// handleAckAlertHTML acknowledges an alert from a human click, then refreshes.
func (s *Server) handleAckAlertHTML(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	store, closeFn, err := s.alertsForProject(r.PathValue("project"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer closeFn()
	if store == nil {
		http.Error(w, "alerts unavailable", http.StatusServiceUnavailable)
		return
	}
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := store.Ack(n); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	redirect := "/alerts"
	if projectID := r.PathValue("project"); projectID != "" {
		redirect = "/projects/" + url.PathEscape(projectID) + "/alerts"
	}
	http.Redirect(w, r, redirect, http.StatusSeeOther)
}

func (s *Server) handleAPIAlerts(w http.ResponseWriter, r *http.Request) {
	alerts, ok, err := s.allAlerts("")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "alerts unavailable"})
		return
	}
	if alerts == nil {
		alerts = []alertView{}
	}
	writeJSON(w, http.StatusOK, alerts)
}

func (s *Server) handleAPIAckAlert(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project")
	if s.catalog != nil && projectID == "" {
		writeAPIError(w, http.StatusBadRequest, "project_scope_required", "project scope is required to acknowledge an aggregated alert")
		return
	}
	store, closeFn, err := s.alertsForProject(projectID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer closeFn()
	if store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "alerts unavailable"})
		return
	}
	n, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if err := store.Ack(n); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "acknowledged"})
}

// --- JSON API ---

func (s *Server) handleAPITasks(w http.ResponseWriter, r *http.Request) {
	engine, closeFn, err := s.currentEngine()
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer closeFn()
	tasks, err := engine.ListAll()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if tasks == nil {
		tasks = []workflow.Task{}
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) handleAPITask(w http.ResponseWriter, r *http.Request) {
	engine, closeFn, err := s.currentEngine()
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer closeFn()
	id := r.PathValue("id")
	t, err := engine.GetTask(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	ev, err := engine.ListEvidence(id)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ev == nil {
		ev = []workflow.Evidence{}
	}
	comments, err := listEngineComments(engine, id)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if comments == nil {
		comments = []comment{}
	}
	writeJSON(w, http.StatusOK, taskDetail{Task: *t, Evidence: ev, Comments: comments})
}

func (s *Server) handleAPIMemory(w http.ResponseWriter, r *http.Request) {
	store, closeFn, err := s.currentMemory()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer closeFn()
	if store == nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": "memory store not available"})
		return
	}
	q := r.URL.Query().Get("q")
	var entries interface{}
	var queryErr error
	if q != "" {
		entries, queryErr = store.Recall(q, 50)
	} else {
		entries, queryErr = store.List("")
	}
	if queryErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": queryErr.Error()})
		return
	}
	if entries == nil {
		entries = []struct{}{}
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleAPIContext(w http.ResponseWriter, r *http.Request) {
	store, closeFn, err := s.currentContext()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer closeFn()
	if store == nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": "context store not available"})
		return
	}
	q := r.URL.Query().Get("q")
	pkt, err := store.Packet(q, 50)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, pkt)
}

func (s *Server) handleAPIApprovals(w http.ResponseWriter, r *http.Request) {
	apps, err := s.allPendingApprovals(false)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	out := make([]approvalJSON, 0, len(apps))
	for _, a := range apps {
		out = append(out, approvalJSON{Task: a.Task, SubmissionID: a.SubmissionID, ProjectID: a.ProjectID})
	}
	writeJSON(w, http.StatusOK, out)
}

// --- shared internals ---

// taskDetail is the JSON shape for GET /api/tasks/{id}: one task plus its
// evidence and comments.
type taskDetail struct {
	Task     workflow.Task       `json:"Task"`
	Evidence []workflow.Evidence `json:"Evidence"`
	Comments []comment           `json:"Comments"`
}

type approvalJSON struct {
	Task         workflow.Task `json:"Task"`
	SubmissionID int64         `json:"SubmissionID"`
	ProjectID    string        `json:"ProjectID,omitempty"`
}

// pendingApprovals lists tasks currently awaiting a human decision. The
// approval nonce stays server-side and only contributes to the action token.
func (s *Server) pendingApprovals(engine *workflow.Engine, projectID string, human bool) ([]approvalView, error) {
	tasks, err := engine.ListAll()
	if err != nil {
		return nil, err
	}
	var out []approvalView
	for _, t := range tasks {
		if t.State != contracts.StateUserApproval {
			continue
		}
		nonce, subID, err := engine.PendingApproval(t.ID)
		if err != nil {
			return nil, err
		}
		action := "/approvals/" + url.PathEscape(t.ID)
		if projectID != "" {
			action = "/projects/" + url.PathEscape(projectID) + action
		}
		taskURL := "/tasks/" + url.PathEscape(t.ID)
		if projectID != "" {
			taskURL = "/projects/" + url.PathEscape(projectID) + taskURL
		}
		token := ""
		if human {
			token = s.approvalToken(projectID, t.ID, subID, nonce)
		}
		evidence, err := engine.ListEvidence(t.ID)
		if err != nil {
			return nil, err
		}
		currentEvidence := evidence[:0]
		for _, item := range evidence {
			if item.SubmissionID != nil && *item.SubmissionID == subID {
				currentEvidence = append(currentEvidence, item)
			}
		}
		reviews, err := listEngineReviews(engine, t.ID)
		if err != nil {
			return nil, err
		}
		currentReviews := reviews[:0]
		for _, item := range reviews {
			if item.SubmissionID == subID {
				currentReviews = append(currentReviews, item)
			}
		}
		out = append(out, approvalView{Task: t, Evidence: currentEvidence, Reviews: currentReviews, SubmissionID: subID, ProjectID: projectID, Action: action, TaskURL: taskURL, CSRFToken: token})
	}
	return out, nil
}

// approve resolves a pending human approval only when its form token matches
// the selected project, task, submission, and current stored nonce.
var errInvalidFormToken = errors.New("invalid approval form token")

func (s *Server) approve(projectID, taskID, formToken string) error {
	engine := s.engine
	closeFn := func() {}
	if s.catalog != nil {
		if projectID == "" {
			projectID = s.currentProjectID
		}
		rt, err := s.openProject(projectID)
		if err != nil {
			return err
		}
		engine = rt.engine
		closeFn = func() { _ = rt.Close() }
	}
	defer closeFn()
	t, err := engine.GetTask(taskID)
	if err != nil {
		return fmt.Errorf("load task: %w", err)
	}
	if t.State != contracts.StateUserApproval {
		return fmt.Errorf("%w: state=%s", errNotPending, t.State)
	}
	nonce, submissionID, err := engine.PendingApproval(taskID)
	if err != nil {
		return fmt.Errorf("load pending approval: %w", err)
	}
	expected := s.approvalToken(projectID, taskID, submissionID, nonce)
	if !hmac.Equal([]byte(formToken), []byte(expected)) {
		return errInvalidFormToken
	}
	return engine.ResolveApproval(taskID, nonce, true, "local-ui", "ui")
}

func (s *Server) currentEngine() (*workflow.Engine, func(), error) {
	return s.engineForProject("")
}

func (s *Server) engineForProject(projectID string) (*workflow.Engine, func(), error) {
	if s.catalog == nil {
		return s.engine, func() {}, nil
	}
	if projectID == "" {
		projectID = s.currentProjectID
	}
	rt, err := s.openProject(projectID)
	if err != nil {
		return nil, func() {}, err
	}
	return rt.engine, func() { _ = rt.Close() }, nil
}

func (s *Server) allPendingApprovals(human bool) ([]approvalView, error) {
	if s.catalog == nil {
		return s.pendingApprovals(s.engine, "", human)
	}
	projects, err := s.catalog.List()
	if err != nil {
		return nil, err
	}
	var out []approvalView
	for _, project := range projects {
		rt, err := s.openProject(project.ID)
		if err != nil {
			return nil, err
		}
		apps, err := s.pendingApprovals(rt.engine, project.ID, human)
		rt.Close()
		if err != nil {
			return nil, err
		}
		out = append(out, apps...)
	}
	return out, nil
}

// approvalErrorStatus maps an approve error to an HTTP status: a missing task
// is 404, a wrong-state/nonce/transition error is 409 (the boundary holds,
// nothing changed), anything else is 500.
func approvalErrorStatus(err error) int {
	switch {
	case errors.Is(err, workflow.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, errNotPending),
		errors.Is(err, workflow.ErrWrongState),
		errors.Is(err, workflow.ErrNonceInvalid),
		errors.Is(err, workflow.ErrTransition):
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}

// kindOrder ranks knowledge kinds for a stable, kind-grouped listing:
// decisions first, then conventions, glossary, runbook.
func kindOrder(k string) int {
	switch k {
	case "decision":
		return 0
	case "convention":
		return 1
	case "glossary":
		return 2
	case "runbook":
		return 3
	}
	return 99
}

// writeJSON encodes v with a status. Failures to encode are silent beyond the
// header because the status is already written.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
