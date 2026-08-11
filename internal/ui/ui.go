// Package ui is Agentklar's native, local-first web UI: the single surface a
// human uses to see the task board, project knowledge, shared memory, the
// context index, recorded evidence, and to approve work. It replaces the
// external Vikunja dependency; the human clicks "approve" here, on a server
// bound to 127.0.0.1 — a trusted channel.
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
	"crypto/rand"
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
	"board", "task", "knowledge", "memory", "context", "approvals", "alerts",
}

// Server is the local UI server. It holds read/write handles to the protected
// control database (for listing tasks and for the trusted approval path) and
// best-effort handles to the optional knowledge/memory/context layers. A nil
// optional store degrades its view to "not available" rather than panicking.
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
	csrfToken        string

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
	// Validate that every template parses. This is the registration call from
	// the spec; it is not used for rendering (per-page sets below are).
	if _, err := template.New("").ParseFS(assetsFS, "assets/*.html"); err != nil {
		return nil, fmt.Errorf("ui: parse templates: %w", err)
	}

	// Build one render set per page: the shared layout plus that single page.
	// Parsing only one page per set means each page's {{define "content"}}
	// cleanly overrides the layout's {{block "content"}} with no collisions.
	pages := make(map[string]*template.Template, len(pageFiles))
	for _, name := range pageFiles {
		t, err := template.New("").ParseFS(assetsFS, "assets/layout.html", "assets/"+name+".html")
		if err != nil {
			return nil, fmt.Errorf("ui: parse template %q: %w", name, err)
		}
		pages[name] = t
	}

	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, fmt.Errorf("ui: csrf token: %w", err)
	}
	return &Server{pages: pages, csrfToken: hex.EncodeToString(token)}, nil
}

// Handler returns the routed http.Handler (a *http.ServeMux). Exported so the
// CLI can serve it however it likes (httptest, http.Serve, etc.).
func (s *Server) Handler() http.Handler { return s.router }

// Listen starts a local TCP listener. An empty addr defaults to 127.0.0.1:0 so
// the OS picks a free port; the returned listener lets the CLI print the URL.
// The UI is a trusted channel only because it is local: an agent has no MCP
// method to approve, and binding to loopback keeps the surface physical.
func (s *Server) Listen(addr string) (net.Listener, error) {
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("%w: %s", ErrNonLoopback, addr)
		}
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
	mux.HandleFunc("GET /{$}", s.handleBoard)
	mux.HandleFunc("GET /tasks/{id}", s.handleTask)
	mux.HandleFunc("GET /knowledge", s.handleKnowledge)
	mux.HandleFunc("GET /memory", s.handleMemory)
	mux.HandleFunc("GET /context", s.handleContext)
	mux.HandleFunc("GET /approvals", s.handleApprovals)
	mux.HandleFunc("POST /approvals/{id}", s.handleApproveHTML)
	mux.HandleFunc("GET /alerts", s.handleAlerts)
	mux.HandleFunc("POST /alerts/{id}/ack", s.handleAckAlertHTML)
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
	}

	return s.rejectCrossOrigin(mux)
}

func (s *Server) rejectCrossOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" || !sameOrigin(r) {
				if strings.HasPrefix(r.URL.Path, "/api/") {
					writeAPIError(w, http.StatusForbidden, "cross_origin", "cross-origin mutation rejected")
				} else {
					http.Error(w, "cross-origin mutation rejected", http.StatusForbidden)
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
		return true
	}
	u, err := url.Parse(origin)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return err == nil && u.Scheme == scheme && strings.EqualFold(u.Host, r.Host)
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
	d.CSRFToken = s.csrfToken
	if err := t.ExecuteTemplate(w, "layout", d); err != nil {
		// The header is already written on a successful Execute; fall back to a
		// plain error only if execution failed before any bytes were flushed.
		http.Error(w, "template error: "+err.Error(), http.StatusInternalServerError)
	}
}

// --- view models ---

// viewData is the bag every page renders against. Pages read only the fields
// they need; the layout reads Title and Section (for nav highlighting).
type viewData struct {
	Title      string
	Section    string
	StateLabel string // human-readable task state, for the detail page badge
	Q          string // current search query (memory/context)
	Error      string
	CSRFToken  string

	// Board
	Columns []columnView

	// Task detail
	Task     *workflow.Task
	Evidence []workflow.Evidence
	Comments []comment

	// Knowledge
	Knowledge []knowledge.Entry
	KnowOK    bool

	// Memory
	Memory []memory.Entry
	MemOK  bool

	// Context
	ContextPkt akctx.Packet
	CtxOK      bool

	// Approvals
	Approvals []approvalView

	// Alerts
	Alerts  []notify.Alert
	AlertOK bool
}

type columnView struct {
	State contracts.State
	Label string
	Tasks []workflow.Task
}

type approvalView struct {
	Task         workflow.Task
	SubmissionID int64
	ProjectID    string
	Action       string
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
