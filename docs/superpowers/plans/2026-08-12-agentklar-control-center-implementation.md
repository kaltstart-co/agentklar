# Agentklar Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Agentklar into one professional, in-house control center for every registered project, with a usable task board, reliable agent memory, and a safe upgrade path.

**Architecture:** Add a global catalog that points at existing per-project workspaces; do not merge protected workflow databases. Extend each workspace with versioned planning fields, expose project-scoped APIs through the embedded Go web server, and build the application with Go templates, vanilla JavaScript, and CSS. Keep MCP project-bound and Vikunja optional.

**Tech Stack:** Go 1.25, `net/http`, `html/template`, vanilla JavaScript, CSS, modernc SQLite, GitHub Actions, GoReleaser.

---

### Task 1: Global project catalog and collision-safe workspaces

**Files:**
- Create: `internal/catalog/catalog.go`
- Create: `internal/catalog/catalog_test.go`
- Modify: `cmd/agentklar/main.go`
- Modify: `cmd/agentklar/ui_cli.go`

- [ ] **Step 1: Write failing catalog tests**

Cover stable path-derived IDs, idempotent registration, two repositories with
the same basename, listing by `last_opened_at`, and registration of a compatible
legacy basename workspace without moving its database.

```go
func TestRegisterKeepsCompatibleLegacyWorkspace(t *testing.T) {
    c := newTestCatalog(t)
    legacy := seedLegacyWorkspace(t, "/src/acme/app")
    p, err := c.Register("/src/acme/app", legacy)
    if err != nil { t.Fatal(err) }
    if p.WorkspacePath != legacy { t.Fatalf("workspace = %q", p.WorkspacePath) }
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `go test ./internal/catalog -run TestRegister -v`  
Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement the catalog**

Define:

```go
type Project struct {
    ID, Name, RepoPath, WorkspacePath, CreatedAt, UpdatedAt, LastOpenedAt string
}
func Open(dataRoot string) (*Catalog, error)
func (c *Catalog) Register(repoPath, legacyWorkspace string) (Project, error)
func (c *Catalog) Get(id string) (Project, error)
func (c *Catalog) List() ([]Project, error)
```

Use `sha256.Sum256([]byte(canonicalRepoPath))` for a stable 12-character ID.
Create `catalog.sqlite` under the Agentklar data root. Register a legacy path
only when its `control.sqlite` task rows have no conflicting `repo_path`.

- [ ] **Step 4: Route workspace lookup through the catalog**

Replace basename-only `workspaceDir()` with catalog registration. `init`,
`status`, `ui`, and `mcp` must refresh the project entry. Keep existing
workspaces in place.

- [ ] **Step 5: Verify and commit**

Run: `gofmt -w internal/catalog cmd/agentklar/main.go cmd/agentklar/ui_cli.go && go test ./internal/catalog ./cmd/agentklar`  
Expected: PASS.  
Commit: `feat: add the global project catalog`

### Task 2: Versioned task planning schema

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/store/store_test.go`
- Modify: `internal/workflow/engine.go`
- Modify: `internal/workflow/queries.go`
- Modify: `internal/workflow/engine_test.go`

- [ ] **Step 1: Write migration tests**

Create a database using the old schema, open it with `store.Open`, and assert
that existing rows remain while these fields exist with safe defaults:
`priority`, `assignee`, `labels`, `due_date`, `position`, `archived_at`.
Assert `task_dependencies(task_id, depends_on_task_id)` exists and rejects a
self-dependency.

- [ ] **Step 2: Confirm RED**

Run: `go test ./internal/store -run 'TestOpenMigrates|TestDependencies' -v`  
Expected: FAIL because no versioned migration adds the columns.

- [ ] **Step 3: Add ordered migrations**

Use `PRAGMA user_version`. Apply the base schema as version 1 and planning
columns/dependencies as version 2 inside transactions. Reopening version 2 must
be idempotent.

- [ ] **Step 4: Extend the task model and queries**

```go
type Priority string
const (
    PriorityLow Priority = "low"
    PriorityMedium Priority = "medium"
    PriorityHigh Priority = "high"
    PriorityUrgent Priority = "urgent"
)
```

Add `Priority`, `Assignee`, `Labels`, `DueDate`, `Position`, `ArchivedAt`,
`CreatedAt`, and `UpdatedAt` to `workflow.Task`. Preserve existing JSON output
field names for compatibility. List active tasks by state and position and omit
archived rows by default.

- [ ] **Step 5: Verify and commit**

Run: `gofmt -w internal/store internal/workflow && go test ./internal/store ./internal/workflow`  
Expected: PASS.  
Commit: `feat: migrate tasks for planning metadata`

### Task 3: Safe task editing, dependencies, and board ordering

**Files:**
- Modify: `internal/workflow/engine.go`
- Modify: `internal/workflow/queries.go`
- Modify: `internal/workflow/engine_test.go`

- [ ] **Step 1: Write failing behavior tests**

Test Draft task editing, validation of priority/date/labels, dependency cycle
rejection, stable reorder inside one state, Ready transition only with criteria
and verification, human request-changes from approval, cancellation without
physical deletion, and inability to drag directly into Done.

- [ ] **Step 2: Confirm RED**

Run: `go test ./internal/workflow -run 'TestUpdateTask|TestSetDependencies|TestReorder|TestHumanBoardTransition' -v`  
Expected: FAIL because the methods do not exist.

- [ ] **Step 3: Implement the minimum engine API**

```go
type TaskUpdate struct {
    Title, Objective, Verification, Assignee, DueDate string
    Lane contracts.Lane
    Isolation contracts.Isolation
    Target contracts.ExecutionTarget
    Priority Priority
    Criteria, Labels []string
}
func (e *Engine) UpdateTask(id string, u TaskUpdate) error
func (e *Engine) SetDependencies(id string, deps []string) error
func (e *Engine) Dependencies(id string) ([]string, error)
func (e *Engine) Reorder(state contracts.State, orderedIDs []string) error
func (e *Engine) HumanTransition(id string, to contracts.State, reason string) error
func (e *Engine) ArchiveTask(id string) error
```

Allow edits before submission; after submission, restrict edits to planning
metadata so frozen acceptance criteria remain meaningful. Every mutation uses
one transaction.

- [ ] **Step 4: Verify and commit**

Run: `gofmt -w internal/workflow && go test ./internal/workflow`  
Expected: PASS.  
Commit: `feat: add safe board task operations`

### Task 4: Catalog-aware HTTP application and API

**Files:**
- Create: `internal/ui/projects.go`
- Modify: `internal/ui/ui.go`
- Modify: `internal/ui/handlers.go`
- Modify: `internal/ui/ui_test.go`
- Modify: `cmd/agentklar/ui_cli.go`

- [ ] **Step 1: Write failing project/API tests**

Seed two catalog projects and assert `GET /api/projects`, `GET /api/overview`,
project-scoped task lists, task create/edit/comment/reorder/transition, invalid
cross-project IDs, body-size limits, enum validation, and structured errors.
Assert waiting, blocked, and cancelled tasks remain visible.

- [ ] **Step 2: Write approval-boundary tests**

Assert `/api/approvals` never contains `Nonce`; cross-origin mutations fail;
approve requires a same-origin form token; request-changes records the reason;
and a normal board transition to Done returns `409`.

- [ ] **Step 3: Confirm RED**

Run: `go test ./internal/ui -run 'TestProjects|TestTaskMutation|TestApprovalNonceRedacted|TestOrigin' -v`  
Expected: FAIL on missing routes and leaked nonce.

- [ ] **Step 4: Implement catalog-backed project runtimes**

Open each project workspace on demand and close it after the request. Use a
scoped identifier from URL path values; never search every database for a bare
task ID. Build Overview from catalog projects and their task counts.

- [ ] **Step 5: Implement JSON and HTML mutations**

All task state changes call workflow methods. Limit bodies to 1 MiB. Return
`{"error":{"code":"invalid_transition","message":"..."}}` for JSON errors.
Remove nonce fields from approval JSON and remove any generic JSON endpoint
that can approve without browser-origin protection.

- [ ] **Step 6: Verify and commit**

Run: `gofmt -w internal/ui cmd/agentklar/ui_cli.go && go test ./internal/ui ./cmd/agentklar`  
Expected: PASS.  
Commit: `feat: expose the multi-project control center API`

### Task 5: Professional application shell and interactive board

**Files:**
- Create: `internal/ui/assets/overview.html`
- Create: `internal/ui/assets/task-form.html`
- Create: `internal/ui/assets/static/app.js`
- Modify: `internal/ui/assets/layout.html`
- Modify: `internal/ui/assets/board.html`
- Modify: `internal/ui/assets/task.html`
- Modify: `internal/ui/assets/approvals.html`
- Modify: `internal/ui/assets/alerts.html`
- Modify: `internal/ui/assets/knowledge.html`
- Modify: `internal/ui/assets/memory.html`
- Modify: `internal/ui/assets/context.html`
- Modify: `internal/ui/assets/static/app.css`
- Modify: `internal/ui/ui_test.go`

- [ ] **Step 1: Add failing rendered-contract tests**

Assert the project switcher, overview attention counts, create-task form,
filters, task metadata, dependency controls, evidence tabs, request-changes
action, draggable cards, and keyboard “Move to” controls render. Assert inputs
have labels and the mobile menu has accessible names.

- [ ] **Step 2: Confirm RED**

Run: `go test ./internal/ui -run 'TestControlCenterShell|TestBoardActions|TestTaskFormAccessibility' -v`  
Expected: FAIL because the new application elements do not exist.

- [ ] **Step 3: Build the shell and screens**

Use a warm off-white canvas, deep navy typography, cobalt accent, restrained
state colors, Fraunces for sparse display moments, and IBM Plex Sans/Mono with
local fallbacks. Avoid gradients and generic dashboard cards. Use one left rail,
a dense action bar, subtle rules, and compact evidence-first task cards.

- [ ] **Step 4: Add interaction without a framework**

`app.js` handles project selection, search/filter, HTML5 drag/drop with rollback,
keyboard move menus, create/edit dialogs, request changes, toast messages, and
mobile navigation. Every action calls the scoped API and reloads authoritative
state after success.

- [ ] **Step 5: Add accessibility and responsive behavior**

Keep focus outlines, reduced-motion support, 44-pixel targets, live-region
toasts, labels, escape-to-close, and horizontal mobile board scrolling.

- [ ] **Step 6: Verify and commit**

Run: `go test ./internal/ui && go build ./...`  
Expected: PASS.  
Commit: `feat: build the interactive Agentklar control center`

### Task 6: Reliable memory/context and exact MCP contracts

**Files:**
- Modify: `internal/mcp/tools.go`
- Modify: `internal/mcp/server.go`
- Modify: `internal/mcp/server_test.go`
- Modify: `internal/context/context.go`
- Modify: `internal/context/context_test.go`
- Modify: `internal/ui/handlers.go`
- Modify: `internal/ui/ui_test.go`

- [ ] **Step 1: Write MCP schema contract tests**

For every state-changing tool, assert its schema contains every field read by
dispatch and marks required fields correctly. Cover fencing tokens, commit
ranges, submission IDs, provider/findings, comment type, recall limit, task and
holder provenance, and boolean alert speech.

- [ ] **Step 2: Confirm RED**

Run: `go test ./internal/mcp -run TestToolSchemasMatchDispatch -v`  
Expected: FAIL on the current schema/handler mismatches.

- [ ] **Step 3: Repair tool definitions and remember indexing**

Make `speak` a JSON boolean. After `remember`, upsert a `context.SourceMemory`
document using a stable `namespace/key` ref. Make `recall` return memory results
and matching knowledge/context documents without claiming unsupported scope.

- [ ] **Step 4: Add human memory controls**

Expose project-scoped search, provenance, forget, and reindex endpoints in the
UI. Keep forget absent from MCP. Show reindex time/status in the page response.

- [ ] **Step 5: Verify and commit**

Run: `gofmt -w internal/mcp internal/context internal/ui && go test ./internal/mcp ./internal/context ./internal/memory ./internal/ui`  
Expected: PASS.  
Commit: `fix: make agent memory and MCP contracts reliable`

### Task 7: Atomic installer and documented update path

**Files:**
- Modify: `install.sh`
- Create: `scripts/install_test.sh`
- Modify: `README.md`
- Modify: `docs/USAGE.md`
- Modify: `cmd/agentklar/assets/skill/agentklar/SKILL.md`

- [ ] **Step 1: Add a failing installer self-test**

Use a temporary fake release directory and fake `curl` to assert checksum
failure preserves the old binary, a valid staged binary replaces it, missing
SHA tools fail closed, `--no-agents` parses through `bash -s --`, and workspace
files are untouched.

- [ ] **Step 2: Confirm RED**

Run: `bash scripts/install_test.sh`  
Expected: FAIL because installation is not staged/atomic and SHA absence is
handled incorrectly.

- [ ] **Step 3: Stage, validate, and replace**

Download and extract under `mktemp -d`, require checksum verification for
release archives, run the staged binary's `version`, then atomically rename it
into `AGENTKLAR_INSTALL_DIR`. Keep `go install` as the explicit `--with-go`
fallback.

- [ ] **Step 4: Document updates**

Explain that rerunning the installer updates the binary and embedded UI while
catalog/workspace SQLite files remain in the data directory. Include the exact
fresh-install/update command and custom install-directory example.

- [ ] **Step 5: Verify and commit**

Run: `bash -n install.sh scripts/install_test.sh && bash scripts/install_test.sh`  
Expected: PASS.  
Commit: `fix: make Agentklar updates atomic`

### Task 8: Reposition the GitHub Pages product site

**Files:**
- Modify: `docs/site/index.html`
- Modify: `docs/site/features.html`
- Modify: `docs/site/usage.html`
- Modify: `docs/site/og.png` only if a new social preview is generated

- [ ] **Step 1: Replace the product narrative**

Lead with “One control center for every project.” Show a realistic embedded
board visual with project switcher, approval queue, agent holder, priority,
and evidence status. Explain people + agents, multi-project scope, local-first
storage, memory/context, and the protected Done boundary.

- [ ] **Step 2: Replace Vikunja-first setup**

Move Vikunja to optional legacy integration. Document `agentklar init`,
`agentklar open ui`, agent wiring, task creation, and the update command.

- [ ] **Step 3: Verify static pages**

Run a local HTTP server, request all pages/assets, validate internal links, and
inspect desktop plus mobile screenshots. Check reduced-motion and keyboard
focus behavior.

- [ ] **Step 4: Commit**

Commit: `docs: launch the Agentklar control center site`

### Task 9: Full release verification and GitHub publication

**Files:**
- Modify only files required by verification findings

- [ ] **Step 1: Run source verification**

Run:

```bash
gofmt -w cmd internal
go vet ./...
go build ./...
go test ./...
git diff --check
bash -n install.sh scripts/install_test.sh
bash scripts/install_test.sh
```

Expected: every command exits 0.

- [ ] **Step 2: Run migration and browser smoke checks**

Copy a legacy workspace into a temporary data root, start the new UI, confirm
the old tasks/evidence remain, register a second same-basename project, create
and reorder a task, search/reindex memory, and verify approval nonce redaction.
Capture desktop and mobile screenshots.

- [ ] **Step 3: Run the declared Agentklar gate**

Create or use the release task with acceptance criteria and the declared build
and test recipes. Submit the exact commit range and run `agentklar gate <id>`.
Report the machine-attested evidence; do not approve the task.

- [ ] **Step 4: Review and publish**

Review the complete diff, commit any final fixes, push `agent/control-center`,
and open a draft PR against `main`. After merge, tag `v0.0.1-beta.8`, push the
tag, wait for the Release and Pages workflows, verify four archives plus
checksums, test the one-line update over `v0.0.1-beta.7`, and verify the live
site.
