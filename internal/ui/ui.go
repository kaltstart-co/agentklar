// Package ui is Agentklar's native, local-first web UI: the single surface a
// human uses to see the task board, project knowledge, shared memory, the
// context index, recorded evidence, and to approve work. It replaces the
// external Vikunja dependency; the human clicks "approve" here, on a server
// bound to 127.0.0.1 and authenticated by a one-time browser launch.
//
// Every view is backed by the same data path as a JSON API exposed at /api/...;
// the HTML pages are simply one client of that data. Handlers stay thin: they
// fetch from the existing internal packages (store/workflow/contracts for
// protected state, knowledge/memory/context for the derived layers) and either
// render JSON or render an embedded html/template.
//
// Zero new runtime dependencies: stdlib + existing internal packages only.
// Templates and CSS are embedded so the binary stays self-contained.
package ui

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kaltstart-co/agentklar/internal/catalog"
	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/knowledge"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/notify"
	"github.com/kaltstart-co/agentklar/internal/store"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

//go:embed assets/*
var assetsFS embed.FS

// pageFiles is the set of rendered page templates. Each is paired at init with
// the shared layout by parsing layout.html + that one page into its own
// template set; the page fills the layout's {{block "content"}} via its own
// {{define "content"}}. (Per-set parsing sidesteps the html/template Clone
// namespace quirk and keeps each page's "content" isolated.)
var pageFiles = []string{
	"overview", "board", "task", "knowledge", "memory", "context", "approvals", "alerts",
}

// Server is the local UI server. The legacy single-project constructor keeps
// stores open; the control-center constructor opens project stores per request.
type Server struct {
	workspaceDir string
	repoRoot     string

	engine           *workflow.Engine // protected workflow state (control.sqlite)
	knowledge        *knowledge.Store // optional; nil if open failed
	memory           *memory.Store    // optional; nil if open failed
	context          *akctx.Store     // optional; nil if open failed
	alerts           *notify.Store    // optional; nil if open failed
	catalog          *catalog.Catalog
	currentProjectID string
	bootToken        string
	sessionToken     string
	bootMu           sync.Mutex
	bootUsed         bool

	pages  map[string]*template.Template // file basename -> layout+page set
	router http.Handler
}

// New opens the workspace's read handles. The control database (control.sqlite
// via store.Open + workflow.New) is required: a failure to open it is fatal.
// The knowledge, memory, and context stores are optional: a failure to open
// any of them is logged into the zero value (nil) and the corresponding view
// renders "not available". No external dependency is fetched.
func New(workspaceDir, repoRoot string) (*Server, error) {
	db, err := store.Open(filepath.Join(workspaceDir, "control.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("ui: open control.sqlite: %w", err)
	}
	engine := workflow.New(db)

	// Optional layers — degrade, never fatal.
	kStore, _ := knowledge.New(repoRoot)
	mStore, _ := memory.New(workspaceDir)
	cStore, _ := akctx.New(workspaceDir)
	aStore, _ := notify.New(workspaceDir)

	s, err := newServer()
	if err != nil {
		db.Close()
		return nil, err
	}
	s.workspaceDir = workspaceDir
	s.repoRoot = repoRoot
	s.engine = engine
	s.knowledge = kStore
	s.memory = mStore
	s.context = cStore
	s.alerts = aStore
	s.router = s.routes()
	return s, nil
}

// NewControlCenter serves every catalog project while keeping each protected
// database isolated. Project databases are opened only for the request using
// them and closed before the response handler returns.
func NewControlCenter(c *catalog.Catalog, currentProjectID string) (*Server, error) {
	if c == nil {
		return nil, errors.New("ui: project catalog is required")
	}
	if _, err := c.Get(currentProjectID); err != nil {
		return nil, fmt.Errorf("ui: current project: %w", err)
	}
	s, err := newServer()
	if err != nil {
		return nil, err
	}
	s.catalog = c
	s.currentProjectID = currentProjectID
	s.router = s.routes()
	return s, nil
}

func newServer() (*Server, error) {
	funcs := template.FuncMap{
		"allowedHumanStates": func(from contracts.State) []contracts.State {
			var states []contracts.State
			for _, to := range boardOrder() {
				if contracts.Allowed(from, to, contracts.ActorHuman) && to != contracts.StateDone {
					states = append(states, to)
				}
			}
			return states
		},
		"stateLabel": stateLabel,
		"evidenceOutcome": func(ev workflow.Evidence) string {
			if ev.ExitCode == nil {
				return "No machine result"
			}
			if *ev.ExitCode == 0 {
				return "Passed · exit 0"
			}
			return fmt.Sprintf("Failed · exit %d", *ev.ExitCode)
		},
		"evidenceOutcomeClass": func(ev workflow.Evidence) string {
			if ev.ExitCode == nil {
				return "unverified"
			}
			if *ev.ExitCode == 0 {
				return "pass"
			}
			return "fail"
		},
		"containsString": func(values []string, value string) bool {
			for _, candidate := range values {
				if candidate == value {
					return true
				}
			}
			return false
		},
		"canArchive": func(state contracts.State) bool {
			switch state {
			case contracts.StateDraft, contracts.StateReady, contracts.StateChangesRequested, contracts.StateDone, contracts.StateCancelled:
				return true
			}
			return false
		},
	}
	// Validate that every template parses. This is the registration call from
	// the spec; it is not used for rendering (per-page sets below are).
	if _, err := template.New("").Funcs(funcs).ParseFS(assetsFS, "assets/*.html"); err != nil {
		return nil, fmt.Errorf("ui: parse templates: %w", err)
	}

	// Build one render set per page: the shared layout plus that single page.
	// Parsing only one page per set means each page's {{define "content"}}
	// cleanly overrides the layout's {{block "content"}} with no collisions.
	pages := make(map[string]*template.Template, len(pageFiles))
	for _, name := range pageFiles {
		t, err := template.New("").Funcs(funcs).ParseFS(assetsFS, "assets/layout.html", "assets/"+name+".html")
		if err != nil {
			return nil, fmt.Errorf("ui: parse template %q: %w", name, err)
		}
		pages[name] = t
	}

	tokens := make([]byte, 64)
	if _, err := rand.Read(tokens); err != nil {
		return nil, fmt.Errorf("ui: session tokens: %w", err)
	}
	return &Server{
		pages:        pages,
		bootToken:    hex.EncodeToString(tokens[:32]),
		sessionToken: hex.EncodeToString(tokens[32:]),
	}, nil
}

// Handler returns the routed http.Handler (a *http.ServeMux). Exported so the
// CLI can serve it however it likes (httptest, http.Serve, etc.).
func (s *Server) Handler() http.Handler { return s.router }

// LaunchURL returns the one-time browser bootstrap URL. Callers must pass it
// directly to the browser and must never print or log it.
func (s *Server) LaunchURL(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || !isLoopbackHost(u.Hostname()) {
		return "", errors.New("ui: invalid launch URL")
	}
	u.Path = "/_agentklar/bootstrap"
	u.RawPath = ""
	u.RawQuery = url.Values{"token": {s.bootToken}}.Encode()
	u.Fragment = ""
	return u.String(), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Listen starts a local TCP listener. An empty addr defaults to 127.0.0.1:0 so
// the OS picks a free port; the returned listener lets the CLI print the URL.
// The UI stays on loopback; mutations additionally require the browser session
// established by LaunchURL's one-time capability.
func (s *Server) Listen(addr string) (net.Listener, error) {
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if !isLoopbackHost(host) {
		return nil, fmt.Errorf("%w: %s", ErrNonLoopback, addr)
	}
	return net.Listen("tcp", addr)
}

// ErrNonLoopback protects the browser approval channel from remote binding.
var ErrNonLoopback = errors.New("agentklar UI only listens on loopback")

// Close releases the underlying database handles. Optional; useful for tests.
func (s *Server) Close() error {
	if s.engine != nil && s.engine.DB() != nil {
		if err := s.engine.DB().Close(); err != nil {
			return err
		}
	}
	if s.memory != nil {
		s.memory.Close()
	}
	if s.context != nil {
		s.context.Close()
	}
	if s.alerts != nil {
		s.alerts.Close()
	}
	return nil
}

// routes wires the HTML pages, the JSON API, and the embedded static assets.
// Static assets are served from a sub-tree so the HTML templates themselves
// are never exposed over HTTP.
func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	staticSub, err := fs.Sub(assetsFS, "assets/static")
	if err != nil {
		// assets/static exists in the embedded tree at compile time; this is
		// unreachable but keep a safe fallback rather than panicking.
		mux.HandleFunc("/static/", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	} else {
		mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(staticSub)))
	}

	// HTML pages (the layout nav: Board / Knowledge / Memory / Context / Approvals).
	mux.HandleFunc("GET /_agentklar/bootstrap", s.handleBootstrap)
	mux.HandleFunc("GET /{$}", s.handleHome)
	mux.HandleFunc("GET /board", s.handleBoard)
	mux.HandleFunc("GET /projects/{project}/board", s.handleBoard)
	mux.HandleFunc("GET /tasks/{id}", s.handleTask)
	mux.HandleFunc("GET /projects/{project}/tasks/{task}", s.handleTask)
	mux.HandleFunc("GET /knowledge", s.handleKnowledge)
	mux.HandleFunc("GET /projects/{project}/knowledge", s.handleKnowledge)
	mux.HandleFunc("GET /memory", s.handleMemory)
	mux.HandleFunc("GET /projects/{project}/memory", s.handleMemory)
	mux.HandleFunc("GET /context", s.handleContext)
	mux.HandleFunc("GET /projects/{project}/context", s.handleContext)
	mux.HandleFunc("GET /approvals", s.handleApprovals)
	mux.HandleFunc("POST /approvals/{id}", s.handleApproveHTML)
	mux.HandleFunc("GET /alerts", s.handleAlerts)
	mux.HandleFunc("GET /projects/{project}/alerts", s.handleAlerts)
	mux.HandleFunc("POST /alerts/{id}/ack", s.handleAckAlertHTML)
	mux.HandleFunc("POST /projects/{project}/alerts/{id}/ack", s.handleAckAlertHTML)
	mux.HandleFunc("POST /projects/{project}/approvals/{id}", s.handleApproveHTML)

	// JSON API (same data; the stable contract for future clients).
	mux.HandleFunc("GET /api/tasks", s.handleAPITasks)
	mux.HandleFunc("GET /api/tasks/{id}", s.handleAPITask)
	mux.HandleFunc("GET /api/memory", s.handleAPIMemory)
	mux.HandleFunc("GET /api/context", s.handleAPIContext)
	mux.HandleFunc("GET /api/approvals", s.handleAPIApprovals)
	mux.HandleFunc("GET /api/alerts", s.handleAPIAlerts)
	mux.HandleFunc("POST /api/alerts/{id}/ack", s.handleAPIAckAlert)
	if s.catalog != nil {
		mux.HandleFunc("GET /api/projects", s.handleAPIProjects)
		mux.HandleFunc("GET /api/overview", s.handleAPIOverview)
		mux.HandleFunc("GET /api/projects/{project}/tasks", s.handleProjectTasks)
		mux.HandleFunc("POST /api/projects/{project}/tasks", s.handleProjectTasks)
		mux.HandleFunc("GET /api/projects/{project}/tasks/{task}", s.handleProjectTask)
		mux.HandleFunc("PATCH /api/projects/{project}/tasks/{task}", s.handleProjectTask)
		mux.HandleFunc("POST /api/projects/{project}/tasks/{task}/comments", s.handleProjectComment)
		mux.HandleFunc("POST /api/projects/{project}/tasks/{task}/transition", s.handleProjectTransition)
		mux.HandleFunc("POST /api/projects/{project}/tasks/{task}/request-changes", s.handleProjectRequestChanges)
		mux.HandleFunc("POST /api/projects/{project}/tasks/{task}/position", s.handleProjectPosition)
		mux.HandleFunc("GET /api/projects/{project}/tasks/{task}/dependencies", s.handleProjectDependencies)
		mux.HandleFunc("PUT /api/projects/{project}/tasks/{task}/dependencies", s.handleProjectDependencies)
		mux.HandleFunc("POST /api/projects/{project}/tasks/{task}/archive", s.handleProjectArchive)
		mux.HandleFunc("GET /api/projects/{project}/memory", s.handleProjectMemory)
		mux.HandleFunc("DELETE /api/projects/{project}/memory/{id}", s.handleProjectMemoryForget)
		mux.HandleFunc("GET /api/projects/{project}/context", s.handleProjectContext)
		mux.HandleFunc("POST /api/projects/{project}/context/reindex", s.handleProjectContextReindex)
		mux.HandleFunc("POST /api/projects/{project}/alerts/{id}/ack", s.handleAPIAckAlert)
	}

	return s.protectHumanMutations(mux)
}

func (s *Server) protectHumanMutations(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			if !s.isHuman(r) || r.Header.Get("Sec-Fetch-Site") == "cross-site" || !sameOrigin(r) {
				if strings.HasPrefix(r.URL.Path, "/api/") {
					writeAPIError(w, http.StatusForbidden, "human_session_required", "authenticated human session and exact origin required")
				} else {
					http.Error(w, "authenticated human session and exact origin required", http.StatusForbidden)
				}
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return err == nil && u.Scheme == scheme && strings.EqualFold(u.Host, r.Host) && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

const humanSessionCookie = "agentklar_human"

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token := r.URL.Query().Get("token")
	s.bootMu.Lock()
	valid := !s.bootUsed && hmac.Equal([]byte(token), []byte(s.bootToken))
	if valid {
		s.bootUsed = true
	}
	s.bootMu.Unlock()
	if !valid {
		http.Error(w, "invalid or consumed launch capability", http.StatusForbidden)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     humanSessionCookie,
		Value:    s.sessionToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) isHuman(r *http.Request) bool {
	cookie, err := r.Cookie(humanSessionCookie)
	return err == nil && hmac.Equal([]byte(cookie.Value), []byte(s.sessionToken))
}

func (s *Server) approvalToken(projectID, taskID string, submissionID int64, nonce string) string {
	mac := hmac.New(sha256.New, []byte(s.sessionToken))
	fmt.Fprintf(mac, "%s\x00%s\x00%d\x00%s", projectID, taskID, submissionID, nonce)
	return hex.EncodeToString(mac.Sum(nil))
}

// render executes the named page inside the shared layout. The layout receives
// the view bag; its {{block "content" .}} is filled by the page's own
// {{define "content"}} in its layout+page render set.
func (s *Server) render(w http.ResponseWriter, page string, d viewData) {
	t, ok := s.pages[page]
	if !ok {
		http.Error(w, "unknown page template", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := t.ExecuteTemplate(w, "layout", d); err != nil {
		// The header is already written on a successful Execute; fall back to a
		// plain error only if execution failed before any bytes were flushed.
		http.Error(w, "template error: "+err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) renderRequest(w http.ResponseWriter, r *http.Request, page string, d viewData) {
	d.Human = s.isHuman(r)
	if d.ProjectID == "" {
		d.ProjectID = r.PathValue("project")
	}
	if d.ProjectID == "" {
		d.ProjectID = s.currentProjectID
	}
	if s.catalog != nil {
		d.Projects, _ = s.catalog.List()
		for _, p := range d.Projects {
			if p.ID == d.ProjectID {
				d.ProjectName = p.Name
				d.ProjectRepo = p.RepoPath
				break
			}
		}
		d.BasePath = "/projects/" + url.PathEscape(d.ProjectID)
	}
	s.render(w, page, d)
}

// --- view models ---

// viewData is the bag every page renders against. Pages read only the fields
// they need; the layout reads Title and Section (for nav highlighting).
type viewData struct {
	Title            string
	Section          string
	StateLabel       string // human-readable task state, for the detail page badge
	Q                string // current search query (memory/context)
	Error            string
	ProjectID        string
	TaskPrefix       string
	BasePath         string
	Human            bool
	Projects         []catalog.Project
	ProjectName      string
	ProjectRepo      string
	Overview         []projectOverview
	Attention        []projectOverview
	Archived         bool
	Dependencies     []string
	AllTasks         []workflow.Task
	ContextIndexedAt string

	// Board
	Columns []columnView

	// Task detail
	Task     *workflow.Task
	Evidence []workflow.Evidence
	Comments []comment
	Reviews  []review

	// Knowledge
	Knowledge []knowledge.Entry
	KnowOK    bool

	// Memory
	Memory           []memory.Entry
	MemOK            bool
	Namespace        string
	TaskScope        string
	MemoryNamespaces []string

	// Context
	ContextPkt akctx.Packet
	CtxOK      bool

	// Approvals
	Approvals []approvalView

	// Alerts
	Alerts      []alertView
	AlertOK     bool
	AlertGlobal bool
}

type alertView struct {
	notify.Alert
	ProjectID   string `json:"project_id,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
	Action      string `json:"-"`
}

type columnView struct {
	State contracts.State
	Label string
	Tasks []workflow.Task
}

type approvalView struct {
	Task         workflow.Task
	Evidence     []workflow.Evidence
	Reviews      []review
	SubmissionID int64
	ProjectID    string
	Action       string
	TaskURL      string
	CSRFToken    string
}

// comment mirrors the append-only comments table. There is no public
// ListComments on the engine, so the view layer reads the stable control.sqlite
// schema directly via the DB handle exposed for diagnostics.
type comment struct {
	ID        int64  `json:"ID"`
	Actor     string `json:"Actor"`
	CType     string `json:"CType"`
	Body      string `json:"Body"`
	CreatedAt string `json:"CreatedAt"`
}

type review struct {
	SubmissionID                                int64
	Kind, Result, Provider, Findings, CreatedAt string
}

// listComments returns the timeline comments for a task in append order.
func (s *Server) listComments(taskID string) ([]comment, error) {
	return listEngineComments(s.engine, taskID)
}

func listEngineComments(engine *workflow.Engine, taskID string) ([]comment, error) {
	rows, err := engine.DB().Query(
		`SELECT id, actor, ctype, body, created_at FROM comments WHERE task_id = ? ORDER BY id`,
		taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []comment
	for rows.Next() {
		var c comment
		if err := rows.Scan(&c.ID, &c.Actor, &c.CType, &c.Body, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func listEngineReviews(engine *workflow.Engine, taskID string) ([]review, error) {
	rows, err := engine.DB().Query(`SELECT submission_id, kind, result, provider, findings, created_at FROM reviews WHERE task_id = ? ORDER BY id DESC`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []review
	for rows.Next() {
		var item review
		if err := rows.Scan(&item.SubmissionID, &item.Kind, &item.Result, &item.Provider, &item.Findings, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// boardOrder is the left-to-right column order for the board view.
func boardOrder() []contracts.State {
	return []contracts.State{
		contracts.StateDraft,
		contracts.StateReady,
		contracts.StateInProgress,
		contracts.StateWaiting,
		contracts.StateBlocked,
		contracts.StateCompletionReview,
		contracts.StateAutoQA,
		contracts.StateChangesRequested,
		contracts.StateUserApproval,
		contracts.StateDone,
		contracts.StateCancelled,
	}
}

// stateLabel renders a state as a human label.
func stateLabel(s contracts.State) string {
	switch s {
	case contracts.StateDraft:
		return "Draft"
	case contracts.StateReady:
		return "Ready"
	case contracts.StateInProgress:
		return "In Progress"
	case contracts.StateCompletionReview:
		return "Completion Review"
	case contracts.StateAutoQA:
		return "Auto QA"
	case contracts.StateChangesRequested:
		return "Changes Requested"
	case contracts.StateUserApproval:
		return "User Approval"
	case contracts.StateDone:
		return "Done"
	case contracts.StateWaiting:
		return "Waiting"
	case contracts.StateBlocked:
		return "Blocked"
	case contracts.StateCancelled:
		return "Cancelled"
	}
	return strings.Title(string(s))
}
