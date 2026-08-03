package ui

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// errNotPending signals that a task is not awaiting human approval; the approve
// endpoint maps it to 409 and changes nothing.
var errNotPending = errors.New("task is not pending user approval")

// --- HTML pages ---

func (s *Server) handleBoard(w http.ResponseWriter, r *http.Request) {
	tasks, err := s.engine.ListAll()
	if err != nil {
		s.render(w, "board", viewData{Title: "Board", Section: "board", Error: err.Error()})
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
	s.render(w, "board", viewData{Title: "Board", Section: "board", Columns: columns})
}

func (s *Server) handleTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	t, err := s.engine.GetTask(id)
	if err != nil {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}
	ev, _ := s.engine.ListEvidence(id)
	comments, _ := s.listComments(id)
	s.render(w, "task", viewData{
		Title:      t.Title,
		Section:    "board",
		StateLabel: stateLabel(t.State),
		Task:       t,
		Evidence:   ev,
		Comments:   comments,
	})
}

func (s *Server) handleKnowledge(w http.ResponseWriter, r *http.Request) {
	d := viewData{Title: "Knowledge", Section: "knowledge"}
	if s.knowledge == nil {
		d.KnowOK = false
		s.render(w, "knowledge", d)
		return
	}
	d.KnowOK = true
	entries, err := s.knowledge.List()
	if err != nil {
		d.Error = err.Error()
		s.render(w, "knowledge", d)
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
	s.render(w, "knowledge", d)
}

func (s *Server) handleMemory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	d := viewData{Title: "Memory", Section: "memory", Q: q}
	if s.memory == nil {
		d.MemOK = false
		s.render(w, "memory", d)
		return
	}
	d.MemOK = true
	if q != "" {
		d.Memory, _ = s.memory.Recall(q, 50)
	} else {
		d.Memory, _ = s.memory.List("")
	}
	s.render(w, "memory", d)
}

func (s *Server) handleContext(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	d := viewData{Title: "Context", Section: "context", Q: q}
	if s.context == nil {
		d.CtxOK = false
		s.render(w, "context", d)
		return
	}
	d.CtxOK = true
	d.ContextPkt, _ = s.context.Packet(q, 50)
	s.render(w, "context", d)
}

func (s *Server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	apps, _ := s.pendingApprovals()
	s.render(w, "approvals", viewData{Title: "Approvals", Section: "approvals", Approvals: apps})
}

// handleApproveHTML is the trusted local approval channel: the human clicks.
// It resolves the pending nonce via the engine and advances the task to Done.
// On any error the protected state is unchanged and a 409 is returned.
func (s *Server) handleApproveHTML(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.approve(id); err != nil {
		http.Error(w, err.Error(), approvalErrorStatus(err))
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// --- JSON API ---

func (s *Server) handleAPITasks(w http.ResponseWriter, r *http.Request) {
	tasks, err := s.engine.ListAll()
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
	id := r.PathValue("id")
	t, err := s.engine.GetTask(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	ev, _ := s.engine.ListEvidence(id)
	if ev == nil {
		ev = []workflow.Evidence{}
	}
	comments, _ := s.listComments(id)
	if comments == nil {
		comments = []comment{}
	}
	writeJSON(w, http.StatusOK, taskDetail{Task: *t, Evidence: ev, Comments: comments})
}

func (s *Server) handleAPIMemory(w http.ResponseWriter, r *http.Request) {
	if s.memory == nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": "memory store not available"})
		return
	}
	q := r.URL.Query().Get("q")
	var entries interface{}
	var err error
	if q != "" {
		entries, err = s.memory.Recall(q, 50)
	} else {
		entries, err = s.memory.List("")
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if entries == nil {
		entries = []struct{}{}
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleAPIContext(w http.ResponseWriter, r *http.Request) {
	if s.context == nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": "context store not available"})
		return
	}
	q := r.URL.Query().Get("q")
	pkt, err := s.context.Packet(q, 50)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, pkt)
}

func (s *Server) handleAPIApprovals(w http.ResponseWriter, r *http.Request) {
	apps, _ := s.pendingApprovals()
	out := make([]approvalJSON, 0, len(apps))
	for _, a := range apps {
		out = append(out, approvalJSON{Task: a.Task, Nonce: a.Nonce, SubmissionID: a.SubmissionID})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAPIApprove is the JSON twin of the trusted approve POST. It performs
// the identical engine path as the HTML form; the boundary is preserved because
// no agent MCP method can call it and the server binds to loopback.
func (s *Server) handleAPIApprove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.approve(id); err != nil {
		writeJSON(w, approvalErrorStatus(err), map[string]string{"ok": "false", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true", "id": id, "state": string(contracts.StateDone)})
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
	Nonce        string        `json:"Nonce"`
	SubmissionID int64         `json:"SubmissionID"`
}

// pendingApprovals lists every task currently in user_approval along with its
// pending nonce. The nonce stays server-side; the HTML form never embeds it —
// the server re-resolves it from its own store at click time.
func (s *Server) pendingApprovals() ([]approvalView, error) {
	tasks, err := s.engine.ListAll()
	if err != nil {
		return nil, err
	}
	var out []approvalView
	for _, t := range tasks {
		if t.State != contracts.StateUserApproval {
			continue
		}
		nonce, subID, err := s.engine.PendingApproval(t.ID)
		if err != nil {
			continue
		}
		out = append(out, approvalView{Task: t, Nonce: nonce, SubmissionID: subID})
	}
	return out, nil
}

// approve resolves a pending human approval to Done using the server's own
// stored nonce. This is the same engine path the dev CLI `approve` uses; it is
// human-only in practice because an agent has no MCP method for it and the UI
// binds to 127.0.0.1. A task not in user_approval yields errNotPending and
// leaves protected state untouched.
func (s *Server) approve(taskID string) error {
	t, err := s.engine.GetTask(taskID)
	if err != nil {
		return fmt.Errorf("load task: %w", err)
	}
	if t.State != contracts.StateUserApproval {
		return fmt.Errorf("%w: state=%s", errNotPending, t.State)
	}
	nonce, _, err := s.engine.PendingApproval(taskID)
	if err != nil {
		return fmt.Errorf("load pending approval: %w", err)
	}
	return s.engine.ResolveApproval(taskID, nonce, true, "local-ui", "ui")
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
