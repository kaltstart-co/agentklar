package ui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed frontend
var frontendFS embed.FS

// DefaultPath keeps Go-only installations on the existing interface until a
// build includes the packaged support interface.
func DefaultPath() string { return frontendPath(frontendFS) }

func frontendPath(files fs.FS) string {
	if _, err := fs.Stat(files, "frontend/index.html"); err == nil {
		return "/app/"
	}
	return "/"
}

// The frontend uses only same-origin APIs. Hosted builds need secure pairing
// before they can read or send local work.
func (s *Server) handleFrontend(w http.ResponseWriter, r *http.Request) {
	files, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		http.Error(w, "support interface unavailable", http.StatusServiceUnavailable)
		return
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		http.Error(w, "Build the support interface first: cd web && npm ci && npm run build:local", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.StripPrefix("/app/", http.FileServerFS(files)).ServeHTTP(w, r)
}

func (s *Server) handleFrontendSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"human": s.isHuman(r), "native_permissions": s.NativePermission != nil, "native_project_id": s.currentProjectID})
}
