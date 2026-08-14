# Precision Ops Visual Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Precision Ops visual system across Agentklar's native control center and three-page product website without changing product behavior.

**Architecture:** Keep the existing Go templates, embedded assets, static website, and vanilla JavaScript. Replace the shared control-center stylesheet and each static page's inline theme with the approved tokens and component styling; add narrow source-contract tests that prevent the old editorial palette and serif typography from returning.

**Tech Stack:** Go 1.25 templates and tests, embedded HTML/CSS/JavaScript, static HTML/CSS, headless Chrome for rendered verification.

---

### Task 1: Visual Contract Tests

**Files:**
- Create: `internal/ui/visual_contract_test.go`
- Test: `internal/ui/visual_contract_test.go`

- [ ] **Step 1: Write the failing control-center contract test**

Read `assets/static/app.css` from `assetsFS`. Require `#f5f7fb`, `#101828`, `#315efb`, and `border-radius: 8px`; reject `#f5f1e8`, `#fffdf8`, `Iowan Old Style`, and `var(--display)`.

- [ ] **Step 2: Write the failing website contract test**

Resolve the repository root from `runtime.Caller`, read `docs/site/index.html`, `docs/site/features.html`, and `docs/site/usage.html`, require `#f5f7fb`, `#101828`, and `#315efb` in each, and reject the old cream and serif tokens in each.

- [ ] **Step 3: Run the tests and verify RED**

Run: `go test ./internal/ui -run 'TestPrecisionOps' -count=1`

Expected: FAIL because the current UI and website still use the editorial tokens.

- [ ] **Step 4: Commit the failing tests**

```bash
git add internal/ui/visual_contract_test.go
git commit -m "test: define the Precision Ops visual contract"
```

### Task 2: Native Control Center

**Files:**
- Modify: `internal/ui/assets/static/app.css`
- Test: `internal/ui/visual_contract_test.go`
- Test: `internal/ui/control_center_test.go`

- [ ] **Step 1: Replace shared tokens and typography**

Set the canvas to `#f5f7fb`, surfaces to white, ink to `#172033`, navigation to `#101828`, active navigation to `#24324a`, and primary blue to `#315efb`. Remove the display-serif variable and route headings, metrics, and project names through the sans stack.

- [ ] **Step 2: Restyle the shared shell**

Make the fixed rail dark navy, the logo blue, navigation high contrast, the project picker dark, the project utility bar white, and the content canvas cool gray. Preserve existing rail dimensions, mobile inert behavior, and DOM structure.

- [ ] **Step 3: Restyle operational components**

Apply consistent 6–10px radii, white surfaces, neutral borders, and restrained shadows to buttons, filters, board columns, task cards, overview rows, attention items, approvals, intelligence records, task details, dialogs, status badges, and alerts. Keep the current semantic state colors and 44px control minimums.

- [ ] **Step 4: Restyle responsive states**

Keep the board as the only horizontally scrolling surface at 390px, retain full-width mobile forms and approval actions, and use a navy mobile rail with a soft overlay shadow.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `go test ./internal/ui -run 'TestPrecisionOps|TestControlCenterShellAndBoardContracts|TestMobileOverviewKeepsApprovalMetricVisible' -count=1`

Expected: PASS.

- [ ] **Step 6: Commit the native UI revamp**

```bash
git add internal/ui/assets/static/app.css
git commit -m "feat: revamp the control center with Precision Ops"
```

### Task 3: Product Website

**Files:**
- Modify: `docs/site/index.html`
- Modify: `docs/site/features.html`
- Modify: `docs/site/usage.html`
- Modify: `docs/site/og.png`
- Test: `internal/ui/visual_contract_test.go`

- [ ] **Step 1: Restyle shared website chrome**

Replace paper and serif tokens on all pages with the Precision Ops canvas, surface, navy, blue, border, radius, shadow, sans, and mono tokens. Align navigation, brand mark, buttons, skip links, and footer across all three pages.

- [ ] **Step 2: Restyle the home page**

Use a compact product-led hero, rounded SaaS cards, and a Precision Ops control-center preview with dark rail, cool-gray board, white task cards, and semantic queue states. Remove rotated marks, hard offset shadows, editorial borders, and oversized serif headings.

- [ ] **Step 3: Restyle features and usage**

Convert feature grids, workflow states, setup steps, notes, checks, and command lists into the same rounded white-card system. Keep terminal blocks dark and preserve every current command and product claim.

- [ ] **Step 4: Regenerate the social preview**

Capture the finished home product composition at 1200x630 and write it to `docs/site/og.png`; verify it is a true 1200x630 PNG and visually matches the shipped page.

- [ ] **Step 5: Run the visual contract and link checks**

Run: `go test ./internal/ui -run 'TestPrecisionOps' -count=1`

Run a local HTTP server and verify `/`, `/features.html`, `/usage.html`, `/logo.svg`, `/og.png`, and every local `href` return successfully.

Expected: tests PASS and all local targets return HTTP 200.

- [ ] **Step 6: Commit the website revamp**

```bash
git add docs/site/index.html docs/site/features.html docs/site/usage.html docs/site/og.png
git commit -m "feat: bring Precision Ops to the product site"
```

### Task 4: Runtime and Release Verification

**Files:**
- Verify: `internal/ui/assets/static/app.css`
- Verify: `docs/site/index.html`
- Verify: `docs/site/features.html`
- Verify: `docs/site/usage.html`

- [ ] **Step 1: Run the repository checks**

Run: `go test ./...`

Run: `go build ./...`

Run: `git diff --check`

Expected: all exit 0.

- [ ] **Step 2: Render the native UI on desktop and mobile**

Build a temporary `agentklar` binary, initialize isolated temporary project data, launch the control center, and inspect Overview, Board, Task, Approvals, Knowledge, Context, Memory, and Alerts at desktop width and 390x844.

Expected: Precision Ops tokens render throughout; no serif or paper styling remains; desktop hierarchy is compact; mobile document width is 390px and the closed rail is inert.

- [ ] **Step 3: Render the website on desktop and mobile**

Serve `docs/site` locally and inspect home, features, and usage at desktop width and 390x844.

Expected: all three pages share one visual system, show no document overflow, preserve focus and reduced-motion rules, and render without console errors.

- [ ] **Step 4: Audit against the design spec**

Check every requirement in `docs/superpowers/specs/2026-08-14-precision-ops-visual-revamp-design.md` against source, automated tests, and rendered evidence. Fix any missing or contradictory item before completion.

- [ ] **Step 5: Commit verification-only corrections if required**

Stage only the exact corrected paths and use a narrowly scoped commit message. Do not amend or rewrite the earlier commits.
