package ui

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/kaltstart-co/agentklar/internal/catalog"
	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/knowledge"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/notify"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
	modernsqlite "modernc.org/sqlite"
)

const maxRequestBody = 1 << 20

type projectOverview struct {
	Project catalog.Project         `json:"project"`
	Counts  map[contracts.State]int `json:"counts"`
}

type projectRuntime struct {
	project catalog.Project
	engine  *workflow.Engine
}

func (r *projectRuntime) Close() error { return r.engine.DB().Close() }

func (s *Server) openProject(id string) (*projectRuntime, error) {
	if s.catalog == nil {
		return nil, workflow.ErrNotFound
	}
	p, err := s.catalog.Get(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, workflow.ErrNotFound
		}
		return nil, fmt.Errorf("catalog lookup: %w", err)
	}
	db, err := store.Open(filepath.Join(p.WorkspacePath, "control.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("open project %s: %w", id, err)
	}
	return &projectRuntime{project: p, engine: workflow.New(db)}, nil
}

func (s *Server) currentProject() (catalog.Project, error) {
	if s.catalog == nil {
		return catalog.Project{RepoPath: s.repoRoot, WorkspacePath: s.workspaceDir}, nil
	}
	p, err := s.catalog.Get(s.currentProjectID)
	if err != nil {
		return catalog.Project{}, fmt.Errorf("catalog lookup: %w", err)
	}
	return p, nil
}

func (s *Server) currentKnowledge() (*knowledge.Store, error) {
	if s.catalog == nil {
		return s.knowledge, nil
	}
	p, err := s.currentProject()
	if err != nil {
		return nil, err
	}
	return knowledge.New(p.RepoPath)
}

func (s *Server) currentMemory() (*memory.Store, func(), error) {
	if s.catalog == nil {
		return s.memory, func() {}, nil
	}
	p, err := s.currentProject()
	if err != nil {
		return nil, func() {}, err
	}
	store, err := memory.New(p.WorkspacePath)
	if err != nil {
		return nil, func() {}, err
	}
	return store, func() { _ = store.Close() }, nil
}

func (s *Server) currentContext() (*akctx.Store, func(), error) {
	if s.catalog == nil {
		return s.context, func() {}, nil
	}
	p, err := s.currentProject()
	if err != nil {
		return nil, func() {}, err
	}
	store, err := akctx.New(p.WorkspacePath)
	if err != nil {
		return nil, func() {}, err
	}
	return store, func() { _ = store.Close() }, nil
}

func (s *Server) currentAlerts() (*notify.Store, func(), error) {
	if s.catalog == nil {
		return s.alerts, func() {}, nil
	}
	p, err := s.currentProject()
	if err != nil {
		return nil, func() {}, err
	}
	store, err := notify.New(p.WorkspacePath)
	if err != nil {
		return nil, func() {}, err
	}
	return store, func() { _ = store.Close() }, nil
}

func (s *Server) handleAPIProjects(w http.ResponseWriter, _ *http.Request) {
	projects, err := s.catalog.List()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if projects == nil {
		projects = []catalog.Project{}
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *Server) handleAPIOverview(w http.ResponseWriter, _ *http.Request) {
	projects, err := s.catalog.List()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out := make([]projectOverview, 0, len(projects))
	for _, p := range projects {
		rt, err := s.openProject(p.ID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "project_unavailable", err.Error())
			return
		}
		tasks, err := rt.engine.ListAll()
		rt.Close()
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		counts := make(map[contracts.State]int)
		for _, task := range tasks {
			counts[task.State]++
		}
		out = append(out, projectOverview{Project: p, Counts: counts})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleProjectTasks(w http.ResponseWriter, r *http.Request) {
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	if r.Method == http.MethodGet {
		archived := r.URL.Query().Get("archived")
		if archived != "" && archived != "true" && archived != "false" {
			writeAPIError(w, http.StatusBadRequest, "invalid_input", "archived must be true or false")
			return
		}
		var tasks []workflow.Task
		if archived == "true" {
			tasks, err = rt.engine.ListArchived()
		} else {
			tasks, err = rt.engine.ListAll()
		}
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		if tasks == nil {
			tasks = []workflow.Task{}
		}
		writeJSON(w, http.StatusOK, tasks)
		return
	}
	var in taskCreate
	if !decodeJSON(w, r, &in) {
		return
	}
	task := in.task(rt.project)
	if err := validateTask(task); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	if _, err := rt.engine.GetTask(task.ID); err == nil {
		writeAPIError(w, http.StatusConflict, "task_exists", "task already exists")
		return
	} else if !errors.Is(err, workflow.ErrNotFound) {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := rt.engine.CreateTask(task); err != nil {
		if isUniqueConstraint(err) {
			writeAPIError(w, http.StatusConflict, "task_exists", "task already exists")
		} else {
			writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
		}
		return
	}
	created, err := rt.engine.GetTask(task.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error", "created task could not be reloaded")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func isUniqueConstraint(err error) bool {
	var sqliteErr *modernsqlite.Error
	if !errors.As(err, &sqliteErr) {
		return false
	}
	return sqliteErr.Code() == 1555 || sqliteErr.Code() == 2067
}

func (s *Server) handleProjectDependencies(w http.ResponseWriter, r *http.Request) {
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	id := r.PathValue("task")
	if r.Method == http.MethodGet {
		deps, err := rt.engine.Dependencies(id)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		if deps == nil {
			deps = []string{}
		}
		writeJSON(w, http.StatusOK, map[string][]string{"dependencies": deps})
		return
	}
	var in struct {
		Dependencies []string `json:"dependencies"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := rt.engine.SetDependencies(id, in.Dependencies); err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"dependencies": in.Dependencies})
}

func (s *Server) handleProjectArchive(w http.ResponseWriter, r *http.Request) {
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	if err := rt.engine.ArchiveTask(r.PathValue("task")); err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "archived"})
}

func (s *Server) handleProjectTask(w http.ResponseWriter, r *http.Request) {
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	id := r.PathValue("task")
	if r.Method == http.MethodGet {
		writeProjectTaskDetail(w, rt.engine, id)
		return
	}
	task, err := rt.engine.GetTask(id)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	var patch taskPatch
	if !decodeJSON(w, r, &patch) {
		return
	}
	u := patch.apply(*task)
	if err := validateUpdate(u); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	if err := rt.engine.UpdateTask(id, u); err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeProjectTaskDetail(w, rt.engine, id)
}

func (s *Server) handleProjectComment(w http.ResponseWriter, r *http.Request) {
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	id := r.PathValue("task")
	if _, err := rt.engine.GetTask(id); err != nil {
		writeWorkflowError(w, err)
		return
	}
	var in struct {
		Body string `json:"body"`
		Type string `json:"type"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Body) == "" {
		writeAPIError(w, http.StatusBadRequest, "invalid_input", "comment body is required")
		return
	}
	if in.Type == "" {
		in.Type = "note"
	}
	if err := rt.engine.AddComment(id, string(contracts.ActorHuman), in.Type, in.Body); err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created"})
}

func (s *Server) handleProjectTransition(w http.ResponseWriter, r *http.Request) {
	var in struct {
		State  contracts.State `json:"state"`
		Reason string          `json:"reason"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validState(in.State) {
		writeAPIError(w, http.StatusBadRequest, "invalid_input", "invalid task state")
		return
	}
	s.transitionProjectTask(w, r, in.State, in.Reason)
}

func (s *Server) handleProjectRequestChanges(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Reason string `json:"reason"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	s.transitionProjectTask(w, r, contracts.StateChangesRequested, in.Reason)
}

func (s *Server) transitionProjectTask(w http.ResponseWriter, r *http.Request, state contracts.State, reason string) {
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	if err := rt.engine.HumanTransition(r.PathValue("task"), state, reason); err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeProjectTaskDetail(w, rt.engine, r.PathValue("task"))
}

func (s *Server) handleProjectPosition(w http.ResponseWriter, r *http.Request) {
	var in struct {
		State      contracts.State `json:"state"`
		OrderedIDs []string        `json:"ordered_ids"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validState(in.State) {
		writeAPIError(w, http.StatusBadRequest, "invalid_input", "invalid task state")
		return
	}
	found := false
	for _, id := range in.OrderedIDs {
		found = found || id == r.PathValue("task")
	}
	if !found {
		writeAPIError(w, http.StatusBadRequest, "invalid_input", "ordered_ids must contain the scoped task")
		return
	}
	rt, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	defer rt.Close()
	if err := rt.engine.Reorder(in.State, in.OrderedIDs); err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reordered"})
}

type taskCreate struct {
	ID           string                    `json:"id"`
	Title        string                    `json:"title"`
	Objective    string                    `json:"objective"`
	Verification string                    `json:"verification"`
	Assignee     string                    `json:"assignee"`
	DueDate      string                    `json:"due_date"`
	Lane         contracts.Lane            `json:"lane"`
	Isolation    contracts.Isolation       `json:"isolation"`
	Target       contracts.ExecutionTarget `json:"target"`
	Priority     workflow.Priority         `json:"priority"`
	Criteria     []string                  `json:"criteria"`
	Labels       []string                  `json:"labels"`
}

func (in taskCreate) task(p catalog.Project) workflow.Task {
	if in.Lane == "" {
		in.Lane = contracts.LaneStandard
	}
	if in.Isolation == "" {
		in.Isolation = contracts.IsolationAuto
	}
	if in.Target == "" {
		in.Target = contracts.TargetAny
	}
	if in.Priority == "" {
		in.Priority = workflow.PriorityMedium
	}
	return workflow.Task{ID: in.ID, Project: p.Name, RepoPath: p.RepoPath, Title: in.Title, Objective: in.Objective,
		Verification: in.Verification, Assignee: in.Assignee, DueDate: in.DueDate, Lane: in.Lane,
		Isolation: in.Isolation, Target: in.Target, Priority: in.Priority, Criteria: in.Criteria, Labels: in.Labels}
}

type taskPatch struct {
	Title        *string                    `json:"title"`
	Objective    *string                    `json:"objective"`
	Verification *string                    `json:"verification"`
	Assignee     *string                    `json:"assignee"`
	DueDate      *string                    `json:"due_date"`
	Lane         *contracts.Lane            `json:"lane"`
	Isolation    *contracts.Isolation       `json:"isolation"`
	Target       *contracts.ExecutionTarget `json:"target"`
	Priority     *workflow.Priority         `json:"priority"`
	Criteria     *[]string                  `json:"criteria"`
	Labels       *[]string                  `json:"labels"`
}

func (p taskPatch) apply(t workflow.Task) workflow.TaskUpdate {
	u := workflow.TaskUpdate{Title: t.Title, Objective: t.Objective, Verification: t.Verification, Assignee: t.Assignee,
		DueDate: t.DueDate, Lane: t.Lane, Isolation: t.Isolation, Target: t.Target, Priority: t.Priority,
		Criteria: t.Criteria, Labels: t.Labels}
	if p.Title != nil {
		u.Title = *p.Title
	}
	if p.Objective != nil {
		u.Objective = *p.Objective
	}
	if p.Verification != nil {
		u.Verification = *p.Verification
	}
	if p.Assignee != nil {
		u.Assignee = *p.Assignee
	}
	if p.DueDate != nil {
		u.DueDate = *p.DueDate
	}
	if p.Lane != nil {
		u.Lane = *p.Lane
	}
	if p.Isolation != nil {
		u.Isolation = *p.Isolation
	}
	if p.Target != nil {
		u.Target = *p.Target
	}
	if p.Priority != nil {
		u.Priority = *p.Priority
	}
	if p.Criteria != nil {
		u.Criteria = *p.Criteria
	}
	if p.Labels != nil {
		u.Labels = *p.Labels
	}
	return u
}

func validateTask(t workflow.Task) error {
	if strings.TrimSpace(t.ID) == "" || strings.TrimSpace(t.ID) != t.ID || strings.ContainsAny(t.ID, "/\r\n\t") {
		return errors.New("task id is required")
	}
	return validateUpdate(workflow.TaskUpdate{Title: t.Title, Objective: t.Objective, Verification: t.Verification,
		Assignee: t.Assignee, DueDate: t.DueDate, Lane: t.Lane, Isolation: t.Isolation, Target: t.Target,
		Priority: t.Priority, Criteria: t.Criteria, Labels: t.Labels})
}

func validateUpdate(u workflow.TaskUpdate) error {
	if strings.TrimSpace(u.Title) == "" {
		return errors.New("title is required")
	}
	if u.Lane != contracts.LaneQuick && u.Lane != contracts.LaneStandard && u.Lane != contracts.LaneMajor {
		return errors.New("invalid lane")
	}
	if u.Isolation != contracts.IsolationAuto && u.Isolation != contracts.IsolationWorktree && u.Isolation != contracts.IsolationNone {
		return errors.New("invalid isolation")
	}
	if u.Target != contracts.TargetAny && u.Target != contracts.TargetCodex && u.Target != contracts.TargetGemini && u.Target != contracts.TargetOpenCode {
		return errors.New("invalid target")
	}
	if u.Priority != workflow.PriorityLow && u.Priority != workflow.PriorityMedium && u.Priority != workflow.PriorityHigh && u.Priority != workflow.PriorityUrgent {
		return errors.New("invalid priority")
	}
	if u.DueDate != "" {
		if _, err := time.Parse("2006-01-02", u.DueDate); err != nil {
			return errors.New("invalid due date")
		}
	}
	seen := make(map[string]bool, len(u.Labels))
	for _, label := range u.Labels {
		key := strings.TrimSpace(label)
		if key == "" || seen[key] {
			return errors.New("invalid labels")
		}
		seen[key] = true
	}
	return nil
}

func validState(state contracts.State) bool {
	for _, candidate := range []contracts.State{contracts.StateDraft, contracts.StateReady, contracts.StateInProgress,
		contracts.StateCompletionReview, contracts.StateAutoQA, contracts.StateUserApproval, contracts.StateDone,
		contracts.StateChangesRequested, contracts.StateWaiting, contracts.StateBlocked, contracts.StateCancelled} {
		if state == candidate {
			return true
		}
	}
	return false
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.ContentLength > maxRequestBody {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body exceeds 1 MiB")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body exceeds 1 MiB")
		} else {
			writeAPIError(w, http.StatusBadRequest, "invalid_json", err.Error())
		}
		return false
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON value")
		return false
	}
	return true
}

func writeProjectTaskDetail(w http.ResponseWriter, engine *workflow.Engine, id string) {
	task, err := engine.GetTask(id)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	evidence, _ := engine.ListEvidence(id)
	comments, _ := listEngineComments(engine, id)
	dependencies, _ := engine.Dependencies(id)
	if evidence == nil {
		evidence = []workflow.Evidence{}
	}
	if comments == nil {
		comments = []comment{}
	}
	if dependencies == nil {
		dependencies = []string{}
	}
	writeJSON(w, http.StatusOK, projectTaskDetail{Task: *task, Evidence: evidence, Comments: comments, Dependencies: dependencies})
}

type projectTaskDetail struct {
	Task         workflow.Task       `json:"task"`
	Evidence     []workflow.Evidence `json:"evidence"`
	Comments     []comment           `json:"comments"`
	Dependencies []string            `json:"dependencies"`
}

func writeWorkflowError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, workflow.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "not_found", "task or project not found")
	case errors.Is(err, workflow.ErrTransition), errors.Is(err, workflow.ErrWrongState):
		writeAPIError(w, http.StatusConflict, "invalid_transition", err.Error())
	case errors.Is(err, workflow.ErrNotReadyCriteria):
		writeAPIError(w, http.StatusConflict, "not_ready", err.Error())
	case errors.Is(err, workflow.ErrFrozenTask):
		writeAPIError(w, http.StatusConflict, "frozen_task", err.Error())
	case errors.Is(err, workflow.ErrDependency):
		writeAPIError(w, http.StatusConflict, "invalid_dependency", err.Error())
	case errors.Is(err, workflow.ErrReorder):
		writeAPIError(w, http.StatusConflict, "invalid_order", err.Error())
	case errors.Is(err, workflow.ErrInvalidTask):
		writeAPIError(w, http.StatusBadRequest, "invalid_input", err.Error())
	default:
		writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
	}
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
