# Agentklar Master Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a local-first toolkit that lets developers keep their preferred coding agent while gaining durable work tracking, bounded context, independent completion review, Auto QA, evidence, and human-controlled completion.

**Architecture:** One small Go control-plane binary composes existing trackers, agent clients, project-native quality recipes, SQLite FTS5, bundled Review Packs, and mdBook. Agentklar owns protected workflow coordination and adapters, not models, language toolchains, a custom tracker UI, or a universal code analyzer. APM is optional after MVP.

**Tech Stack:** Go, MCP, SQLite FTS5, TOML/JSON schemas, Vikunja, optional Plane/APM/mdBook, native agent CLIs, optional Docker or Podman.

---

## 1. Locked product decisions

- Product name: Agentklar, published by Kaltstart.
- Platforms: macOS and Linux, native and Docker-capable; Docker is optional.
- Brain and harness: the developer's existing Codex, OpenCode, Gemini, Cursor, Copilot, or compatible client.
- UI: native agent UI for prompts and approvals; Vikunja or Plane for the board; mdBook for documentation. Agentklar builds no general web UI.
- Tracker: Vikunja is the lightweight default; Plane is an optional full profile.
- Authority: tracker content stays authoritative in Vikunja; `control.sqlite` owns leases, protected transitions, evidence attestations, review snapshots, and pending approvals. Human and Agentklar tracker identities are separate.
- Retrieval: exact search plus SQLite FTS5/BM25. No embeddings and no local model.
- Installation: one bootstrap command starts an interactive, idempotent installer. No `sudo` by default.
- Updates: Propose is the default; stage, validate, activate, and automatically roll back on failure.
- Isolation: installation contains workspaces; workspaces contain projects; data and credentials never cross workspaces implicitly.
- Task ownership: human or persistent agent role plus an execution target such as Codex or Gemini.
- Repository safety: Standard/Major code tasks use dedicated worktrees. Quick `auto` may use the clean primary worktree under an exclusive repository lease. Reviewers use disposable snapshots.
- Completion: implementation explicitly submits once it believes the change is complete.
- Review: when model review is required, prefer a different provider and fall back to a fresh isolated same-brain session.
- QA: every task records Auto QA; Quick work reuses one deterministic runner invocation and spends no extra model call by default. The agent MCP has no approval operation; Done requires a nonce-bound comment from a separate human tracker actor or a trusted client elicitation response.
- Slop Guard: runs at Completion Review, not continuously.
- Quality: orchestrate project-native commands; do not bundle every language's test framework.
- Customization: skills, reviewer packs, policies, and integrations can be scoped by workspace or project and disabled later.
- Development repository: move the authoritative repo to `/Users/divyansh/Projects/agentklar` before implementation; keep the iCloud Obsidian folder as notes only.

## 2. End-to-end developer flow

```text
Install once
  → create/select workspace
  → initialize new or existing project
  → approve detected commands, context sources, tracker, and agents
  → shape task until Definition of Ready passes
  → matching agent atomically claims task with lane-appropriate repository isolation
  → implementation uses focused work packet
  → agent explicitly submits exact commit range
  → machine-attested checks + Slop Guard + Change Review when required
  → recipe-based Auto QA records evidence
  → user accepts or rejects with comments
  → append-only evidence remains available to later sessions
```

Failure at Completion Review, Auto QA, or User Approval returns the task to Changes Requested. A new implementation revision must be resubmitted and reviewed against its new commit.

## 3. Planned repository structure

```text
cmd/agentklar/                 CLI entry point
internal/install/              bootstrap handoff, detection, manifest application
internal/workspace/            workspace/project registry and session binding
internal/store/                control.sqlite migrations and repositories
internal/index/                FTS5 indexing and bounded retrieval
internal/tracker/              field authority, projection, and reconciliation contract
internal/tracker/vikunja/      lightweight tracker adapter
internal/tracker/plane/        optional later adapter
internal/workflow/             protected state, leases, fencing, idempotency, worktrees
internal/evidence/             immutable evidence and artifact references
internal/quality/              allowlisted recipe execution and evidence attestation
internal/review/               completion gate, disposable snapshots, reviewer selection
internal/review/adapters/      native CLI reviewer adapters
internal/qa/                   Auto QA packet and result handling
internal/mcp/                  small agent-facing MCP surface
internal/update/               inventory, staging, validation, activation, rollback
internal/doctor/               health and context-cost reporting
packages/review-packs/         versioned core and specialist reviewer skills
packages/project-skills/       interrogator, planning, debugging, docs, skill creation
configs/                       schemas and default profiles
scripts/install.sh             minimal signed-release bootstrap
deploy/native/                 user-service templates where selected
deploy/docker/                 optional Compose profiles
docs/                          design, contracts, operations, and compatibility
tests/integration/             disposable real-component tests
tests/e2e/                     supported installation and workflow smoke tests
```

Files are introduced only by the subproject that needs them. Empty adapters and speculative interfaces are prohibited.

## 4. Delivery sequence

### Task 1: Freeze contracts and build disposable proofs

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-contracts-proof-plan.md`

**Owns:** field authority, trusted human approval, task states, transition table, actor identities, tracker reconciliation and echo suppression, lease/fencing rules, Quick `auto` and dedicated-worktree isolation, evidence provenance, review schema, QA execution profiles, `.agentklar/quality.toml`, MCP method schemas, compatibility tiers, and a disposable Vikunja/native-agent proof.

- [ ] Specify every allowed transition and the actor permitted to request it.
- [ ] Specify which fields Vikunja owns and which protected fields `control.sqlite` owns.
- [ ] Exclude approval, rejection, and Done from the agent-facing MCP schema.
- [ ] Bind approval to a nonce-bearing durable comment from a separate human tracker actor or a trusted client elicitation response.
- [ ] Specify atomic claim, heartbeat, expiry, fencing, idempotency, and stale-commit rules.
- [ ] Prove Quick `auto` uses the clean primary worktree only under an exclusive repository lease.
- [ ] Prove concurrent code claims never share a writable worktree.
- [ ] Prove direct Vikunja moves are accepted or reverted, Agentklar echoes do not loop, and missed webhooks reconcile later.
- [ ] Define machine-attested, agent-reported, and human-observed evidence.
- [ ] Specify strict input/output schemas before choosing persistent tables.
- [ ] Prove one task can travel from Ready through Completion Review, Auto QA, User Approval, and Done without any model-callable approval path.
- [ ] Delete proof code that does not belong in the production architecture.
- [ ] Approve the contract only after concurrent-claim and stale-review demonstrations pass.

**Exit:** The schemas and observed proof are sufficient to plan production code without inventing workflow behavior during implementation.

### Task 2: Ship the Vikunja workflow and evidence vertical slice

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-vikunja-workflow-plan.md`

**Owns:** development CLI, one manually configured workspace, separate human/service tracker identities, Vikunja setup/adoption, `control.sqlite`, field authority, projection/reconciliation, project mapping, task templates, roles, execution targets, Quick `auto` isolation, dedicated Standard/Major worktrees, claims, Definition of Ready, and trusted human approval.

- [ ] Configure the lightweight board without forking or replacing Vikunja.
- [ ] Keep task content in Vikunja and protected workflow state in `control.sqlite`.
- [ ] Use separate human and Agentklar service accounts; never expose human tracker credentials to agents.
- [ ] Require a nonce-bound human-authored approval comment; never infer Done from card position alone.
- [ ] Treat direct protected bucket moves as validated requests; revert invalid moves with comments.
- [ ] Mark outbound writes in an outbox and ignore matching service-account webhook echoes.
- [ ] Reconcile on webhooks, MCP connection, task reads, state changes, and `agentklar reconcile`.
- [ ] Document that board projection may remain stale between sessions when no background service runs.
- [ ] Reject Draft claims, stale fencing tokens, duplicate submissions, and non-human Done requests.
- [ ] Let Quick `auto` use the clean primary worktree only when an exclusive repository lease is available.
- [ ] Create or register a dedicated branch/worktree for Standard, Major, or concurrent code claims.
- [ ] Run an optional project-defined preparation recipe only when a dedicated worktree needs hydration.
- [ ] Represent sprints and agent targets with native Vikunja features plus minimal labels.
- [ ] Preserve failed evidence and review revisions as append-only comments or attachments.

**Exit:** Two concurrent code tasks never share a writable tree, direct UI edits cannot bypass protected transitions, Agentklar echoes cannot loop, and the model cannot invoke an approval or Done operation.

### Task 3: Add Completion Review, Slop Guard, and Auto QA

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-completion-quality-plan.md`

**Owns:** explicit submission, acceptance-criteria snapshot, commit snapshot, allowlisted recipe runner, machine-attested evidence, L0–L3 results, initial Ponytail rules, Quick-lane fast path, semantic-QA boundary, user rejection, and review-loop cap.

- [ ] Parse project-owned quality recipes; never infer that an absent command exists.
- [ ] Enforce recipe working directory, timeout, environment references, network, services, writable paths, and cleanup.
- [ ] Store full logs outside model context and return a compact evidence summary.
- [ ] Run Slop Guard only after `submit_for_review`.
- [ ] Hard-fail only objective configured rules; emit subjective simplicity findings as warnings.
- [ ] Let one deterministic invocation record Completion Review and Auto QA for Quick work without a model call.
- [ ] Mark model-submitted logs and screenshots as agent-reported until reproduced or accepted.
- [ ] Invalidate review and QA when the submitted head commit changes.
- [ ] Stop automated review cycles after three failed revisions and request user action.

**Exit:** Quick work reaches User Approval through one attested runner invocation; Standard work cannot pass without its required attested recipes; no agent-reported evidence is mistaken for machine-attested evidence.

### Dogfood gate before distribution work

- [ ] Use the development build for at least two weeks across one new and one established project.
- [ ] Complete at least ten Quick and five Standard tasks through the full workflow.
- [ ] Record model calls/cost, time-to-done, bypass, abandonment, review failures, and reopened tasks.
- [ ] Record the reason for every bypass, abandonment, override, and rejected reviewer finding.
- [ ] Confirm zero shared-worktree incidents and zero accepted protected-transition bypasses.
- [ ] Treat 80% eligible-task use and 10% friction-abandonment as investigation signals, not validation thresholds.
- [ ] Continue only after no unresolved workflow/trust-boundary failure remains and the user explicitly approves distribution work.

Passing this pilot means the workflow was not falsified in the small sample; it does not validate broad adoption.

### Task 4: Build installer, workspace registry, and update skeleton

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-foundation-plan.md`

**Owns:** production CLI, signed bootstrap, platform detection, component manifest, native layout, workspace registry, keychain references, session binding, dry-run, configuration backup, doctor baseline, minimal staged activation, and rollback.

- [ ] Implement native macOS/Linux installation without `sudo`.
- [ ] Make the interactive wizard and equivalent non-interactive flags use the same plan/apply engine.
- [ ] Make structured conversational workspace binding the baseline and MCP elicitation an enhancement.
- [ ] Use trusted client elicitation as an optional human-approval channel without adding an agent-callable approval tool.
- [ ] Back up every modified agent configuration and prove installation is idempotent.
- [ ] Stage releases beside the active version and switch one symlink only after health checks pass.

**Exit:** One verified command installs, diagnoses, updates, rolls back, and removes Agentklar without affecting ordinary agent use.

**Public milestone:** Release the first useful alpha after Tasks 1–4. Do not wait for Plane, every agent platform, or advanced indexing.

### Task 5: Add cross-provider native reviewer adapters

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-reviewer-adapters-plan.md`

**Owns:** Codex, Gemini CLI, and OpenCode detection/invocation, archive/sparse review snapshots, policy-controlled clone fallback, adapter-specific restrictions, provider selection, fresh-session isolation, provenance, timeout/cancellation, and optional hosted PR publishing.

- [ ] Prefer an installed reviewer whose provider differs from the implementer.
- [ ] Use a fresh same-brain session when no different provider is available.
- [ ] Pass the bounded review packet, never the implementation conversation.
- [ ] Materialize exact-head archive or changed-scope sparse snapshots with the submitted diff and relevant base/history evidence.
- [ ] Use a full remote-free clone only when policy requires broader history; use partial clone only when the server supports it.
- [ ] Measure and report snapshot creation time and disk use on representative large repositories.
- [ ] Add each client's strongest available read-only sandbox or tool-deny policy.
- [ ] Use a mutation sentinel to test the adapter, not as the safety boundary.
- [ ] Publish tested client-version ranges and fail closed on unknown capabilities or malformed output.
- [ ] Treat malformed reviewer output as review failure, not as approval.
- [ ] Publish inline hosted-PR findings only when the user enables a Git provider adapter.

**Exit:** The same task can be implemented by Codex and reviewed by Gemini, or reviewed safely by a fresh Codex session when Gemini is unavailable.

### Task 6: Add focused context and established-project onboarding

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-context-onboarding-plan.md`

**Owns:** FTS5 index, source metadata, work-packet builder, context budgets, project discovery, instruction/MCP/skill inventory, context audit, exact exclusions, knowledge promotion, and rebuild behavior.

- [ ] Register an established repository without modifying application code.
- [ ] Detect existing commands, docs, manifests, and instruction files and present a proposal.
- [ ] Measure instruction files, enabled skill metadata, MCP schemas, work packets, and retrieved excerpts separately.
- [ ] Keep raw logs, whole documents, unrelated tickets, and other workspaces out of the packet.
- [ ] Make indexes disposable and deterministically rebuildable from authoritative sources.
- [ ] Turn missing tests/docs into visible backlog proposals rather than autogenerated claims of readiness.

**Exit:** A fresh session can resume an old or new project from a bounded packet without earlier chat history or cross-workspace leakage.

### Task 7: Add documentation, interrogator, and professional skill creation

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-docs-skills-plan.md`

**Owns:** mdBook catalogue, documentation-impact contract, ADR/diagram guidance, project interrogator, agent/skill creation workflow, validation fixtures, bundled-pack deployment, scope controls, private workspace promotion, and optional APM export.

- [ ] Ask only questions needed to make project goals, constraints, acceptance criteria, and evidence actionable.
- [ ] Generate skills and agent profiles from a small reviewed template, not arbitrary giant prompts.
- [ ] Validate created skills against fixtures before enabling them.
- [ ] Keep project skills inside their project unless the user explicitly promotes them.
- [ ] Render existing repository Markdown without moving or duplicating its source.

**Exit:** Developers can create professional project-specific guidance and documentation without loading it globally or leaving the coding-agent UI.

### Task 8: Add opt-in quality depth and agent routines

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-quality-routines-plan.md`

**Owns:** optional jscpd, ast-grep, OSV Scanner, Gitleaks, Playwright, Testcontainers, mutation adapters, changed-scope activation, routine recipes, execution-target queues, and polling/backoff guidance.

- [ ] Enable a tool only when it adds a signal the project does not already have.
- [ ] Pin and inventory enabled tool versions and permissions.
- [ ] Let native agent routines list and atomically claim matching Ready tasks.
- [ ] Never wake a model, spend tokens, or run an endless autonomous loop inside Agentklar.
- [ ] Publish compatibility as Full, Assisted, or Configuration-only based on tested capability.

**Exit:** Multi-language projects gain useful checks and routines without inheriting every supported tool or a false promise of universal agent automation.

### Task 9: Add operations hardening and optional Plane profile

**Plan file:** `docs/superpowers/plans/2026-07-17-agentklar-operations-plane-plan.md`

**Owns:** optional APM adapter, Plane adapter, Docker parity, backup/restore, migration tests, component auto-update inventory, compatibility CI, resource budgets, offline operation, release channels, and support diagnostics.

- [ ] Keep Vikunja as the low-resource default and Plane entirely optional.
- [ ] Update only components installed or explicitly adopted by Agentklar.
- [ ] Prove failed migrations and health checks return to the previous working version.
- [ ] Test native and Docker profiles on the supported macOS/Linux architecture matrix.
- [ ] Publish exact minimum and recommended resources from measured runs.

**Exit:** A stable release can be installed, upgraded, rolled back, diagnosed, and supported without losing workspace data.

## 5. Reviewer Pack contract

Every Completion Reviewer receives only:

- Task objective, scope, acceptance criteria, and required evidence.
- Base/head commits and exact diff.
- Relevant file content, project invariants, and unresolved earlier findings.
- Deterministic quality results and retained-log references.
- The universal reviewer contract, Ponytail lens, and applicable specialist skills.

The reviewer works in a disposable exact-head archive or changed-scope sparse snapshot containing the submitted diff and precomputed base/history evidence. A full remote-free clone is a policy-controlled fallback. It can search the snapshot, run allowlisted checks, inspect manifests/lockfiles, and consult official package documentation. Adapter-specific sandboxing further restricts writes. Any review-copy mutations are discarded; the reviewer cannot access the implementation worktree, push, or approve Done.

Each finding contains severity, confidence, file/line, evidence, violated rule or criterion, and the smallest fix. Critical/high findings block under the default policy; medium/low findings are warnings. Prompt-pack version, provider, harness, and exact commit are always retained.

## 6. Compatibility contract

Agent support is advertised by tested capability, not by name recognition:

- **Full:** workspace binding, MCP task operations, evidence submission, and native reviewer invocation are verified.
- **Assisted:** generated skills/work packets work, but one or more automatic operations require a local companion or manual invocation.
- **Configuration-only:** Agentklar can install guidance/configuration, but cannot claim automated workflow integration.

Initial release qualification targets Codex, OpenCode, and Gemini CLI. Gemini follows in the reviewer-adapter phase. Cursor, Copilot, web-only, and cloud-only surfaces are added only at the capability tier actually demonstrated.

## 7. Default installation profiles

### Lightweight

Agentklar native binary, one workspace, Vikunja native with SQLite, core MCP, core Review Pack, and project-native commands. No Docker, Plane, mdBook daemon, embeddings, or optional scanners.

### Standard

Lightweight plus mdBook, FTS5 context index, context audit, established-project onboarding, and selected reviewer adapters.

### Custom

The user chooses native/Docker per component, Plane, optional quality tools, routines, agents, background services, and update policy. The installer shows resource, disk, network, permission, and context cost before applying changes.

## 8. Release gates and measurable benefit

Every public milestone must pass:

- Fresh install, repeat install, upgrade, rollback, and uninstall checks.
- Concurrent claim, expired lease, stale reviewer, duplicate retry, QA failure, and user rejection checks.
- Trusted-human approval tests proving the agent MCP and card position cannot approve, reject, or mark Done, while a valid nonce-bound human comment can.
- Direct tracker-edit reconciliation, missed-webhook, visible-staleness, and echo-loop checks.
- Quick exclusive-primary isolation, separate writable worktrees for concurrent code tasks, and disposable review snapshots.
- Snapshot time and disk measurements, including full-clone fallback on a representative large repository.
- Machine-attestation checks proving reported commands and artifacts came from Agentklar's runner.
- Cross-workspace denial and index rebuild checks.
- Real tracker integration tests, not mock-only tests.
- A representative multi-language repository using only its existing commands.
- Context comparison showing the bounded packet is smaller than loading all enabled guidance and history.
- Dogfood evidence from at least one established project and one new project.

Track locally and transparently:

- Setup time.
- Time from Ready to user-approved Done.
- Model calls, estimated tokens, and estimated cost per completed task.
- Repository-isolation and preparation time/disk cost by task lane.
- Eligible tasks bypassed or abandoned because of Agentklar friction.
- Completion Review failures, QA failures, and reopened tasks.
- Reviewer false positives accepted or rejected by the user.
- Work-packet and enabled-package context size.
- Acceptance criteria linked to retained evidence.
- Installed components that remain unused.

No telemetry leaves the machine unless a user explicitly exports it.

## 9. Deliberately excluded from the first release

- A custom tracker or documentation web UI.
- A model gateway, direct provider SDK layer, or owned API-key vault.
- Embeddings, vector database, or local LLM.
- Continuous Slop Guard scanning while the agent works.
- Automatic reviewer code edits or unlimited fix/review loops.
- A universal language analyzer or bundled test framework collection.
- General cloud, deployment, Azure, Vercel, database, or observability MCPs.
- Automatic promotion of chat memories or project skills across workspaces.

These exclusions change only after measured user need demonstrates that existing tools and adapters cannot cover the requirement.

## 10. Immediate next step

Move the authoritative Git repository out of iCloud to `/Users/divyansh/Projects/agentklar`, then write and execute Task 1's contracts/proof plan. Do not scaffold the entire product or installer first. The proof must validate trusted human approval with no agent-callable Done path, field authority, reconciliation echo suppression, Quick `auto` isolation, concurrent worktrees, exact-commit review snapshots, machine-attested Auto QA, and Quick-lane cost before the production architecture is fixed.
