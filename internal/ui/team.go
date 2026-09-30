package ui

import (
	"errors"
	"net/http"

	"github.com/kaltstart-co/agentklar/internal/team"
)

func (s *Server) RegisterTeamRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects/{project}/team", s.handleProjectTeam)
	mux.HandleFunc("PUT /api/projects/{project}/team", s.handleProjectTeam)
}

func (s *Server) handleProjectTeam(w http.ResponseWriter, r *http.Request) {
	p, err := s.projectByID(r.PathValue("project"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "project_not_found", "Project is not registered")
		return
	}
	if r.Method == http.MethodPut {
		revision := r.Header.Get("If-Match")
		if revision == "" {
			writeAPIError(w, http.StatusPreconditionRequired, "team_revision_required", "Load team settings before saving")
			return
		}
		var c team.Config
		if !decodeJSON(w, r, &c) {
			return
		}
		if err := c.Validate(); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_team", err.Error())
			return
		}
		if err := team.SaveRevision(p.RepoPath, c, revision); err != nil {
			if errors.Is(err, team.ErrConflict) {
				writeAPIError(w, http.StatusPreconditionFailed, "team_conflict", err.Error())
				return
			}
			writeAPIError(w, http.StatusInternalServerError, "team_save_failed", err.Error())
			return
		}
	}
	c, revision, err := team.LoadRevision(p.RepoPath)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "team_load_failed", err.Error())
		return
	}
	w.Header().Set("ETag", revision)
	writeJSON(w, http.StatusOK, c)
}
