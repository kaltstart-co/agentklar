package ui

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/kaltstart-co/agentklar/internal/runs"
)

func (s *Server) RegisterNativeRunRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects/{project}/runs", s.handleNativeRuns)
	mux.HandleFunc("GET /api/projects/{project}/runs/{run}", s.handleNativeRun)
	mux.HandleFunc("POST /api/projects/{project}/runs/{run}/permission", s.handleNativePermission)
	mux.HandleFunc("GET /api/projects/{project}/usage", s.handleNativeUsage)
}

func (s *Server) handleNativeUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.isHuman(r) {
		writeAPIError(w, 403, "human_session_required", "open the local support interface to view account usage")
		return
	}
	if s.NativeUsage == nil {
		writeAPIError(w, 503, "native_usage_unavailable", "connect this project's native supervisor to view available usage")
		return
	}
	p, err := s.projectByID(r.PathValue("project"))
	if err != nil {
		writeAPIError(w, 404, "project_not_found", "registered project not found")
		return
	}
	snapshot, err := s.NativeUsage(p.RepoPath, r.URL.Query().Get("run"))
	if err != nil {
		writeAPIError(w, 503, "native_usage_unavailable", "native usage is unavailable for this project or run")
		return
	}
	writeJSON(w, 200, snapshot)
}

func (s *Server) handleNativeRuns(w http.ResponseWriter, r *http.Request) {
	p, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeAPIError(w, 404, "project_not_found", err.Error())
		return
	}
	defer p.Close()
	store, err := runs.NewStore(p.engine.DB())
	if err != nil {
		writeAPIError(w, 500, "runs_unavailable", err.Error())
		return
	}
	items, err := store.List()
	if err != nil {
		writeAPIError(w, 500, "runs_unavailable", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"runs": items})
}

func (s *Server) handleNativeRun(w http.ResponseWriter, r *http.Request) {
	after := int64(0)
	if raw := r.URL.Query().Get("after"); raw != "" {
		var err error
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 {
			writeAPIError(w, 400, "invalid_cursor", "after must be a nonnegative event number")
			return
		}
	}
	p, err := s.openProject(r.PathValue("project"))
	if err != nil {
		writeAPIError(w, 404, "project_not_found", err.Error())
		return
	}
	defer p.Close()
	store, err := runs.NewStore(p.engine.DB())
	if err != nil {
		writeAPIError(w, 500, "runs_unavailable", err.Error())
		return
	}
	item, err := store.Get(r.PathValue("run"))
	if err != nil {
		writeAPIError(w, 404, "run_not_found", "run is not registered in this project")
		return
	}
	events, err := store.Events(item.ID, after)
	if err != nil {
		writeAPIError(w, 500, "events_unavailable", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"run": item, "events": events})
}

func (s *Server) handleNativePermission(w http.ResponseWriter, r *http.Request) {
	if s.NativePermission == nil {
		writeAPIError(w, 503, "native_permission_unavailable", "open this project's supervisor with agentklar serve --open to answer native permissions")
		return
	}
	p, err := s.projectByID(r.PathValue("project"))
	if err != nil {
		writeAPIError(w, 404, "project_not_found", err.Error())
		return
	}
	var in struct {
		RequestID json.RawMessage `json:"request_id"`
		Decision  string          `json:"decision"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.RequestID) == 0 || !json.Valid(in.RequestID) {
		writeAPIError(w, 400, "invalid_request", "native request_id required")
		return
	}
	if err = s.NativePermission(p.RepoPath, r.PathValue("run"), in.RequestID, in.Decision); err != nil {
		writeAPIError(w, 409, "permission_conflict", err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"status": "responded"})
}
