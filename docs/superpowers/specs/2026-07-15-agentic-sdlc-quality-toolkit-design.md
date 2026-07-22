# Agentklar — Agentic SDLC Quality Toolkit Design

**Status:** Consolidated approved design, ready for phased implementation planning

**Created:** 2026-07-15

**Updated:** 2026-07-17
**Product:** Agentklar

**Publisher:** Kaltstart

**CLI:** `agentklar`

**Tagline:** Agents that know what done means.

## 1. Goal

Build a local-first, agent-neutral toolkit that improves the quality and productivity of AI-assisted software development across sessions and projects. Developers continue using their preferred coding model and harness—Codex, Claude Code, OpenCode, Cursor, Gemini CLI, Copilot, or another compatible client. The toolkit supplies durable work tracking, focused context, evidence-based verification, documentation discipline, reusable methods, and human approval without becoming a replacement IDE or agent runtime.

The primary outcomes are:

- Less repeated setup and re-explanation.
- Less context dilution and token waste.
- Fewer unfinished, falsely completed, or regressed tasks.
- Clear division of work between humans and agent roles.
- Durable project and workspace knowledge across sessions.
- Consistent documentation and architectural records.
- Reusable SDLC-quality methods that improve through experience.
- A setup that works natively or with Docker on macOS and Linux.

## 2. Non-goals

The toolkit will not:

- Provide its own coding model, model router, or coding harness.
- Replace the native UI of Codex, Claude, OpenCode, Cursor, or another agent.
- Become a general MCP, cloud SDK, framework-skill, or deployment marketplace.
- Install Azure, Vercel, Sentry, database, or framework packages by default.
- Build a custom Kanban board, general-purpose tracker database, documentation renderer, or package manager. The narrow coordination ledger is not a task database.
- Use local embedding models or require a local LLM.
- Automatically turn raw conversations into durable memory.
- Load every project, document, skill, or MCP schema into every prompt.
- Make Docker mandatory.
- Expose task approval or Done as an agent-callable operation.

Users may attach domain-specific packages as custom integrations. The toolkit may track, scope, update, and record approved usage methods for those packages, but it will not curate or recommend them as part of the standard SDLC-quality installation.

## 3. Design principles

1. **Compose before building.** Reuse mature products and native platform features before adding custom code.
2. **The developer keeps their agent.** The chosen model remains the brain and the chosen coding client remains the harness.
3. **Repository and tracker state outlive chat.** Conversation history is never the only source of truth.
4. **Retrieve just enough context.** Use normal indexes, metadata, and exact search to create focused work packets.
5. **Evidence before completion.** Agents submit evidence; reviewers pass or fail it; humans control final acceptance.
6. **Process scales with risk.** Tiny fixes use a fast lane; architectural changes require stronger planning and documentation.
7. **Workspaces isolate.** Nothing crosses workspace boundaries without explicit export or import.
8. **Propose by default.** Changes to packages, configuration, durable knowledge, or workflow are proposed for approval.
9. **No permanent daemon unless selected.** Components start on demand or through optional user-level services.
10. **Failure degrades gracefully.** If the toolkit is unavailable, the developer's coding agent and repository still work.

## 4. Approaches considered

### 4.1 Bundle independent existing tools

Package Plane or Vikunja, a memory product, code-navigation MCPs, documentation tools, and agent configurations together. This ships quickly but creates many daemons, fragmented permissions, overlapping memory systems, and large MCP surfaces.

### 4.2 Thin local control plane — selected

Build one small cross-platform binary that performs installation, workspace selection, health checks, updates, and a normalized MCP interface. Reuse Vikunja or Plane for tracking and mdBook for documentation. Core Review Packs ship with Agentklar; APM may later install or compile optional external packages. This supplies the missing coordination while keeping original code and maintenance small.

### 4.3 Full local agent operating system

Build the tracker, memory, orchestration, review UI, worktrees, model runner, and documentation system as one product. This offers maximum control but duplicates native agent clients and mature open-source products. It is explicitly rejected.

## 5. System hierarchy

```text
Installation
└── Workspace
    ├── Workspace policies and enabled quality packs
    ├── Workspace knowledge and full-text index
    ├── Tracker backend and documentation catalogue
    ├── Project A
    │   ├── Tickets and evidence
    │   ├── Documentation and decisions
    │   └── Project knowledge
    └── Project B
        └── ...
```

The installation shares only binaries, trusted built-in assets, the component catalogue, and a local workspace registry. User data, indexes, tracker mappings, credentials, evidence, and custom methods are workspace-scoped.

A project belongs to exactly one workspace on a machine. Moving it is explicit. Knowledge crosses workspaces only through an approved export/import operation.

## 6. Component architecture

### 6.1 The `agentklar` binary

One Go binary provides:

```text
agentklar install
agentklar init
agentklar mcp
agentklar doctor
agentklar reconcile
agentklar update
agentklar workspace
agentklar enable
agentklar disable
agentklar uninstall
```

Its responsibilities are deliberately narrow:

- Bootstrap and configure existing components.
- Maintain the workspace registry and session binding.
- Build and query SQLite FTS5 indexes.
- Expose a small MCP interface to coding agents.
- Normalize task workflow across tracker backends.
- Reconcile tracker projections with protected workflow state on demand.
- Coordinate evidence submission and human approval.
- Install the small bundled set of Agentklar Review Packs into selected clients.
- Check, stage, validate, activate, and roll back updates.

It does not contain a tracker UI, docs UI, model runner, browser automation engine, or general package registry.

### 6.2 Review Packs and optional APM

The few core Review Packs ship inside the signed Agentklar release and use simple workspace/project enablement. Agentklar does not implement external dependency resolution, marketplaces, or a general package lifecycle.

Microsoft APM is an optional post-MVP adapter for users who want portable external skills, prompts, agents, hooks, plugins, or MCP configuration. When enabled, `apm.yml` and `apm.lock.yaml` remain authoritative for APM-managed content, and Agentklar delegates installation, target compilation, integrity auditing, and drift detection to APM.

### 6.3 Tracker backends

The available tracker choices are:

- **Vikunja:** recommended lightweight local option; native binary or Docker; SQLite for personal use.
- **Plane:** optional full Jira-like option; Docker; native workspaces, cycles, and richer project management.
- **External:** user-managed tracker connected through a user-installed custom adapter. No external tracker adapter is part of the initial built-in roadmap.
- **None:** documentation and context features without ticket integration.

Authority is divided by field, never duplicated. Vikunja or Plane remains authoritative for task content, assignees, comments, and attachments. Agentklar's `control.sqlite` is authoritative only for protected workflow state, leases, fencing tokens, evidence attestations, review snapshots, and approvals. Tracker buckets are a projection of protected workflow state, not an approval boundary.

Human edits made in the tracker are accepted for tracker-owned fields. A direct bucket move or completion toggle is treated as a transition request: Agentklar validates it, accepts it when allowed, or reverts it with an explanatory comment. Webhooks provide fast notification, while reconciliation on MCP connection and task operations handles missed deliveries. Acceptance-criteria changes after submission invalidate the active review snapshot.

Agentklar writes tracker projections through a dedicated service account. Human users approve through separate tracker accounts whose credentials are never stored in Agentklar configuration or exposed to agent processes. Tracker webhook actor identity distinguishes human requests from Agentklar projection writes when the listener is online. Durable human-authored approval comments preserve actor identity when webhook delivery is missed.

### 6.4 Documentation renderer

mdBook is the default local documentation reader. It renders repository Markdown into searchable, navigable static HTML and provides a loopback preview server. Source Markdown remains authoritative. The toolkit generates temporary catalogue and navigation files without relocating project documentation.

### 6.5 Native agent clients

The agent client owns model choice, file editing, shell execution, permissions, conversation UI, and any client-native approvals. The toolkit registers one MCP server and selected skills/agents with each chosen client. Optional external MCPs remain user-managed custom integrations.

## 7. Two-stage installation

### 7.1 Bootstrap stage

The documented one-line installation command downloads a small `install.sh`. The script:

1. Detects macOS or Linux and CPU architecture.
2. Downloads the matching signed `agentklar` release to a temporary path.
3. Verifies its checksum and release signature using a public key embedded in the reviewed bootstrap release.
4. Runs `agentklar install` with access to the controlling terminal.
5. Removes the temporary file.

The bootstrap contains no product configuration logic and does not require `sudo`.

### 7.2 Interactive CLI stage

The CLI detects and displays:

- Operating system and architecture.
- CPU, RAM, free disk, and available ports.
- Docker or Podman availability.
- Installed coding agents.
- Existing APM, Vikunja, Plane, and mdBook installations.
- Existing workspaces and project mappings.
- Expected resource, disk, network, permission, and context cost of each proposed component.

The wizard asks for:

1. Install location and stable, beta, or pinned channel.
2. Initial workspace selection or creation.
3. Native, Docker, or mixed deployment.
4. Tracker choice.
5. Documentation reader choice.
6. Minimal, Standard, or Custom SDLC-quality pack.
7. Coding agents to configure.
8. Locked, Ask, Propose, or Auto update policy.
9. Optional user-level background services.
10. Approval of the final bill of materials.

The installer is idempotent, backs up configuration before changes, and supports equivalent non-interactive flags for automated environments.

### 7.3 Install locations

The default native layout is:

```text
~/.local/bin/agentklar
~/.local/share/agentklar/versions/
~/.local/share/agentklar/components/
~/.local/share/agentklar/workspaces/
~/.config/agentklar/config.toml
```

Only the current and immediately previous toolkit versions are retained. The launcher is a symlink to the active version.

## 8. Workspace and session isolation

Each workspace has:

```text
~/.local/share/agentklar/workspaces/{workspace-id}/
├── workspace.toml
├── tracker.toml
├── control.sqlite
├── index.sqlite
├── knowledge/
├── evidence/
├── cache/
└── logs/
```

`control.sqlite` stores only Agentklar-owned workflow state, leases, fencing tokens, evidence attestations, review snapshots, approvals, and queued reconciliation work. Vikunja or Plane remains authoritative for tracker-owned content. The FTS index is disposable and rebuildable. Integration credentials are stored in namespace-specific OS keychain entries rather than configuration files.

Workspace selection is session-scoped:

1. On MCP connection, inspect the current working directory and Git repository identity.
2. Auto-bind when one registered project matches.
3. If unregistered or ambiguous, return a structured `workspace_required` result with candidates.
4. The native agent asks the user to select, create, or temporarily skip, then calls `bind_workspace`.
5. When the client advertises MCP elicitation, it may replace steps 3–4 with an in-band choice.
6. Keep the MCP connection bound until the user explicitly switches.

There is no process-wide “current workspace,” so concurrent agent sessions can use different workspaces safely.

Native isolation prevents the toolkit from retrieving another workspace's data. It cannot sandbox an unrestricted coding agent from the rest of the filesystem. Strong isolation requires the optional container/devcontainer recipe or a separate OS account.

## 9. Context and token management

The toolkit uses no local embeddings. Retrieval uses:

- SQLite FTS5 with BM25 ranking.
- Exact and prefix matching.
- Project, ticket, path, tag, author, timestamp, and document-type filters.
- Git and filesystem search through existing command-line tools.
- Recent and explicitly linked records.

Every agent session receives a focused work packet containing:

- Workspace and project identity.
- Active ticket and assignee role.
- Objective, scope, acceptance criteria, and required evidence.
- Unresolved questions, QA failures, comments, and dependencies.
- Relevant project conventions and decisions.
- Relevant documentation excerpts with source paths.
- Known failed attempts and current risks.
- Exact test and validation commands.

The packet excludes unrelated tickets, raw conversation history, entire documentation libraries, and general workspace knowledge without a relevance match. Search results record source workspace and project to prevent accidental rule transfer.

The toolkit measures enabled skill metadata, MCP tool schemas where visible, work-packet size, and retrieved document size. It warns when a proposed package exceeds the workspace's context budget.

## 10. Task and assignment model

### 10.1 Persistent roles

Tasks can be assigned to humans or persistent agent roles such as:

```text
agent:implementation
agent:verification
agent:documentation
agent:research
```

Roles are not bound to a specific model. Codex may execute `agent:implementation` in one session and Claude Code in another. Tracker adapters map these roles to native assignees where practical and to visible labels where the lightweight backend lacks a suitable native identity.

Each task has one primary assignee, optional collaborators, an execution target, and required review and approval roles. Execution targets identify the harness expected to claim the task, for example `codex`, `claude`, `gemini`, `opencode`, or `any`. Agentklar roles remain stable even when the selected harness or model changes.

Every claim is atomic within `control.sqlite` and carries an expiring lease, heartbeat, lease generation, and fencing token. State-changing calls include the expected task state and fencing token. A stale or duplicate worker cannot update protected workflow state after another worker has acquired a newer lease. Repeated submissions use idempotency keys so retries cannot create duplicate comments, evidence, or reviews.

Leases protect coordination, not repository files. Repository isolation therefore defaults to `auto`:

- Standard and Major code tasks create or register a dedicated Git branch and worktree. Platform-native worktree support may satisfy this requirement.
- A Quick code task may use the clean primary worktree under an exclusive repository lease when no other code claim is active. While that lease exists, Agentklar rejects other code claims for the repository. Otherwise it creates a dedicated worktree.
- Documentation-only or research tasks may explicitly use `repository_isolation = "none"`.

Projects may define an optional worktree-preparation recipe for dependency links, generated files, or environment setup. Agentklar does not invent hydration logic or reinstall dependencies automatically. Lease expiry never deletes a worktree or discards changes—it prevents submission until the work is reclaimed or handed off.

### 10.2 Workflow

```text
Draft → Ready → In Progress → Completion Review → Auto QA → User Approval → Done
                         ↑          ↘              ↘
                         └─ Changes Requested ←─────────┘
```

Exceptional states are Waiting, Blocked, and Cancelled. “My” shows tasks assigned to the current user. “Agent Tasks” shows tasks assigned to agent roles. Waiting uses a structured `waiting_on` reason rather than separate user/agent waiting states.

### 10.3 Definition of Ready

An agent cannot claim a Draft ticket. Ready requires:

- Clear objective and background.
- In-scope and out-of-scope boundaries.
- Testable acceptance criteria.
- Dependencies and unresolved risks.
- Required evidence and expected verification method.
- Documentation impact.
- Rollback requirements for risky changes.
- Assigned reviewer or approver.

Standard and Major work requires user approval of readiness. Quick work uses a smaller template but still needs an expected result and verification method.

### 10.4 Submission and evidence

An implementation agent cannot move a task directly to Auto QA or Done. Once it believes implementation is complete, it explicitly calls `submit_for_review`. Agentklar snapshots the base and head commits, releases or freezes the implementation lease, and opens a numbered Completion Review. Submission includes:

- Completion summary.
- Changed files and commit references.
- Acceptance-criterion-to-evidence matrix.
- Commands, exit codes, timestamps, and retained logs.
- Relevant screenshots, traces, or generated artifacts.
- Documentation changes or an explicit not-affected decision.
- Known gaps, risks, reproduction steps, and rollback instructions.

Self-reported success without underlying evidence is insufficient. Any new commit makes the current Completion Review stale and requires resubmission.

### 10.5 Completion Review

Completion Review is a required change-quality gate before Auto QA. It operates on a local commit range and does not require a hosted pull request.

The gate runs, in order:

1. Project-configured deterministic checks for the changed scope.
2. Objective Slop Guard rules against the completed diff.
3. An independent Change Reviewer when required by the task lane or project policy.

Slop Guard runs only when the implementer submits completed work. It does not consume context or interrupt work continuously. Objective failures such as weakened checks, unapproved dependencies, placeholder code, silent error swallowing, or violated invariants may block. Subjective simplicity findings remain warnings unless workspace policy explicitly promotes a rule. Quick work runs only deterministic Completion Review by default; it does not spend an additional reviewer-model call.

Change Review examines correctness risk, regression risk, architecture, security, maintainability, error handling, dependency use, test integrity, unnecessary code, duplicate helpers, and opportunities to reuse existing project code, standard-library features, native platform capabilities, or already-installed packages. It does not repeat Auto QA's behavioral acceptance testing.

The default reviewer policy is:

1. Prefer a provider different from the implementation provider.
2. If unavailable, use the same provider in a fresh isolated session.
3. Never pass the implementation conversation to the reviewer.
4. Mark every review with provider, model when known, harness, prompt-pack version, base commit, head commit, and whether it was cross-provider or same-brain.

Reviewer adapters invoke already-installed and authenticated native clients such as Codex, Claude Code, Gemini CLI, or OpenCode. Agentklar does not embed provider SDKs or become a model router. OpenCode may be enabled as an optional BYOK multi-provider reviewer harness. A hosted PR adapter may publish the same findings to GitHub, GitLab, or another provider, but hosted PR creation and Qodo PR-Agent integration remain optional.

Each adapter declares tested client-version ranges and probes capabilities at runtime. Unknown versions, missing sandbox capabilities, malformed structured output, authentication failures, or rate limits fail the review closed and return an actionable diagnostic; they never count as approval.

Agentklar runs the reviewer against a disposable review snapshot, never the authoritative implementation worktree. The default snapshot contains the exact head files, submitted diff, relevant base versions, and precomputed history/blame excerpts without a writable `.git` directory or remote. Large repositories may use a changed-scope sparse snapshot. A full remote-free clone is a policy-controlled fallback when broader history is required; partial clone is used only when the Git server supports it. Task 5 must measure snapshot time and disk use before choosing defaults.

Adapter-specific read-only sandboxes and tool-deny rules add defense in depth; mutation sentinels test adapter behavior but are not the safety boundary. Review-snapshot mutations are discarded.

The reviewer receives the task and acceptance criteria, exact diff, relevant source and project rules, previous unresolved findings, and quality evidence—not the full repository or conversation by default. Blocking findings must identify severity, confidence, file and line, concrete evidence, violated criterion or rule, and the smallest reasonable correction. Generic praise and speculative concerns are excluded.

Automatic implementation/review cycles stop after the configured limit, default three, and request user intervention. Review records are append-only; a later pass never overwrites an earlier failure.

### 10.6 Reviewer prompt packs and tools

Reviewer behavior is packaged as small, versioned Review Packs rather than one universal prompt:

- A universal completion-review contract.
- A task packet containing acceptance criteria, diff, project rules, evidence, and unresolved findings.
- Dynamically selected specialist skills based on changed paths and risk.
- A strict machine-readable findings schema.

The core review always includes the Ponytail simplicity and reuse lens. Security, accessibility/UI, database migration, concurrency, dependency, and test-integrity skills load only when the changed scope requires them. Project-specific review rules may be added at project scope without entering other workspaces.

Reviewers may search the snapshot, inspect the supplied diff and precomputed Git evidence, use symbol navigation when installed, run project quality recipes, inspect manifests and lockfiles, and consult official package registries or documentation. A new package may be recommended only after verifying compatibility, maintenance, license, provenance, and a concrete reduction in project code or risk.

Prompt packs are versioned and evaluated against a small corpus of known good changes, seeded defects, accepted findings, and rejected false positives before promotion. Workspace policy pins the active version and upgrades it through the normal Propose flow.

### 10.7 Auto QA and user acceptance

Every task records an Auto QA result, including Quick tasks. Quick work reuses the same deterministic runner invocation for Completion Review and Auto QA, then moves directly to User Approval; it does not create another model session by default. Standard and Major work may assign semantic QA to a different provider or a fresh same-provider session when project policy requires it.

Auto QA executes only pre-approved project recipes from `.agentklar/quality.toml` inside the task's isolated worktree. Agentklar does not translate arbitrary acceptance-criteria prose into unrestricted shell commands. A recipe declares its scope, working directory, command, timeout, permitted environment references, network policy, required services, writable paths, and cleanup command. Semantic QA may select and interpret these recipes and inspect their outputs; it may not silently expand their permissions. Automated UI evidence begins only when a project enables the later Playwright quality adapter.

Evidence has explicit provenance:

- **Machine-attested:** Agentklar executed the recipe and recorded commit, command, working directory, execution profile, timestamps, exit code, log reference, and artifact hashes. This can satisfy required automated evidence.
- **Agent-reported:** A model supplied a claim, log, screenshot, or manual observation. This remains untrusted supporting material unless independently reproduced or accepted by the user.
- **Human-observed:** The user records a manual check against a stated acceptance criterion.

Auto QA may Pass, Fail, request clarification, or mark evidence insufficient. Failure moves the task to Changes Requested and requires a comment with:

- Failed criterion.
- Expected and observed behavior.
- Reproduction steps.
- Evidence reference.
- Severity and requested correction.

After Auto QA passes, Agentklar creates a pending human-approval request. The agent-facing MCP surface exposes no `approve`, `reject`, or direct `Done` operation. A model may request that Agentklar present approval, but it cannot supply the decision.

Trusted approval channels are:

- A durable approval or rejection comment written by an allowed human account in Vikunja or Plane and containing the pending request's short-lived nonce. Agentklar validates the author, task, head commit, review snapshot, nonce, and expiry before performing the transition. A card move alone is not approval.
- An MCP elicitation response supplied by a trusted client UI that explicitly advertised elicitation support. The response is bound to task ID, review snapshot, head commit, approver identity when available, and expiry.

When neither channel is configured, the task remains in User Approval. A plain `agentklar task approve` command is not considered a trusted channel because an agent with shell access could invoke it. A future CLI fallback would require OS-level user-presence authentication and is outside the MVP.

Human rejection returns the task to Changes Requested with comments. Human acceptance preserves the Completion Review and Auto QA evidence as the final audit trail.

### 10.8 Verification levels

Projects declare existing, allowlisted quality recipes in `.agentklar/quality.toml`; Agentklar does not choose or replace language-specific frameworks. Commands are grouped into reusable levels:

```text
L0 Inspect: formatting, lint, type/schema/static checks
L1 Unit: focused unit and component tests
L2 Integration: service, database, contract, and migration checks
L3 System: end-to-end, UI, performance, deployment, or manual evidence
```

A task records the required levels and changed-path scopes. Quick work normally uses L0 plus the smallest relevant test. Standard work normally uses L0–L2 as applicable. Major work explicitly selects all required levels, rollback checks, and retained artifacts. Missing commands are visible gaps, not silently generated dummy tests.

### 10.9 Comments and revisions

Comments are append-only timeline entries attributed to human, agent, or system actors. Types include Question, Answer, Progress, Decision, Completion Review, Auto QA Review, Change Request, Evidence, Risk, and Handoff. New evidence revisions do not overwrite failed evidence.

### 10.10 Lightweight Vikunja conventions

Vikunja provides the UI, task database, projects, identifiers, assignees, comments, attachments, relations, Kanban, and webhooks. The toolkit configures:

```text
Buckets:
Draft, Ready, In Progress, Completion Review, Auto QA,
Changes Requested, User Approval, Done

Labels:
sprint:{name}
agent:{role}
evidence:required
risk:{quick|standard|major}
```

Acceptance criteria and evidence requirements use a generated task-description template. QA and evidence use comments and attachments. Sprints and agent roles are labels in the lightweight profile; Plane supplies native cycles and richer fields in the full profile.

Vikunja remains freely writable for task text, assignments, comments, and attachments. Protected bucket moves are requests, not authoritative transitions. Agentklar validates them against `control.sqlite`; disallowed moves are reverted with a system comment.

User Approval to Done is never inferred from bucket position alone. Agentklar requires the matching durable human-authored approval comment or trusted elicitation response, then writes the Done projection itself.

Agentklar records every outbound tracker write in an outbox with task ID, expected projection, service-account actor, and operation fingerprint. Matching webhook echoes acknowledge the outbox record and do not trigger another write, preventing reconciliation loops. Human-account events are evaluated as new requests.

Signed webhooks reduce delay, but delivery is not retried. Without the optional background service, the board projection may remain visibly stale until the next MCP connection, task read, state change, or manual `agentklar reconcile`. Protected state in `control.sqlite` remains authoritative during that window. Users who require near-real-time board correction must enable the background service.

### 10.11 Agent routines and task claiming

Agentklar exposes small MCP operations for native agent routines:

```text
list_ready_tasks(execution_target)
claim_task(task_id, expected_state)
heartbeat_task(task_id, fencing_token)
submit_for_review(task_id, fencing_token, base_commit, head_commit)
record_review(task_id, review_id, result)
record_qa(task_id, qa_id, result)
release_task(task_id, fencing_token)
```

There is intentionally no agent-callable approval, rejection, or Done method. Human decisions arrive through a trusted tracker actor or protocol-level elicitation response.

A Codex, Claude, Gemini, or OpenCode routine may periodically request matching Ready tasks and atomically claim one. Agentklar does not run an autonomous coding loop or wake paid models itself. When a platform cannot reach the local MCP service, it can still use generated skills and a handoff packet, but automatic claiming is unavailable and must not be advertised as full compatibility.

### 10.12 Existing-project onboarding

`agentklar init` supports both new and established repositories. It detects languages, manifests, existing test and documentation commands, agent instruction files, repository remotes, current worktree state, and likely documentation entry points. It then proposes, for approval:

- Workspace and project registration.
- Tracker project and initial task templates.
- `.agentklar/quality.toml` populated from commands that already exist.
- Documentation catalogue entries.
- Context sources and exclusion rules.
- Conflicting or oversized agent instructions.
- Missing verification or documentation as explicit backlog items.

It does not rewrite the application, generate speculative tests, install language dependencies, or declare undocumented commands valid. The first useful outcome is a resumable project packet and board, even when the repository has substantial existing debt.

## 11. Risk-scaled development flow

### Quick

Used for a typo, small refactor, or obvious low-risk bug. Requires a short ticket, expected outcome, one relevant deterministic recipe, and user approval. One runner invocation records both Completion Review and Auto QA results; no reviewer or QA model session runs by default. It does not require a sprint, design document, or architecture review unless the change affects them.

### Standard

Used for normal features and meaningful bugs. Requires approved acceptance criteria, a scoped plan, tests, machine-attested evidence, documentation-impact review, independent Change Review, Auto QA, and user approval.

### Major

Used for architecture, authentication, persistent data, migrations, infrastructure, or broad behavior changes. Requires a specification, architecture diagram or ADR, risk analysis, rollback plan, approved implementation plan, expanded verification, QA, and user approval.

The toolkit recommends a lane but never silently escalates it. The user can explicitly choose another lane.

## 12. Documentation system

Repository Markdown remains the source of truth. The documentation contract is risk- and project-sensitive.

Always expected:

- README with purpose and setup.
- Development and test commands.
- Product purpose, users, and major non-goals.
- Important conventions and constraints.

Conditionally expected:

- Architecture overview and Mermaid diagram for multi-component systems.
- ADR for durable technical decisions.
- API and schema documentation for public or persistent contracts.
- Testing strategy for non-trivial verification.
- Operations runbook for deployed systems.
- Security/trust-boundary notes for sensitive systems.
- Migration and rollback guide for irreversible changes.
- Release notes for user-visible changes.

Each ticket records documentation impact as Updated, Not affected, or Deferred with a linked follow-up. The documentation quality skill can propose files, diagrams, and link fixes, but cannot silently rewrite durable decisions.

mdBook serves one workspace-bound, loopback-only reading view. The generated catalogue groups shared workspace knowledge and project documentation. Source files are read-only through the viewer; edits occur through the repository or coding agent.

## 13. SDLC-quality packs

The toolkit is not a general package marketplace. Its curated set contains only methods that improve the whole development lifecycle:

- Ponytail for minimal, non-reinvented implementations.
- Task shaping and requirements clarification.
- Systematic debugging.
- Verification before completion.
- Test-driven development.
- Planning and code review.
- Regression review.
- Documentation and ADR maintenance.
- Evidence collection and task closure.
- Skill creation and improvement.

The Standard profile preselects Ponytail, systematic debugging, and verification before completion. TDD, planning, and other heavier methods activate according to project policy and task lane rather than globally.

Bundled packs can be Enabled or Disabled at workspace, project, or session scope. Session overrides project, which overrides workspace; user and project instructions override pack instructions. Disabled packs are not deployed to agent discovery paths and consume no agent context.

Agentklar records only the metadata it needs for bundled or explicitly adopted packs: identifier, version, integrity hash, supported agents, permissions, context size, and enabled scopes. External dependency resolution, transitive packages, source provenance, and lockfiles remain APM's responsibility when the optional adapter is enabled.

Users may register custom integrations and save approved methods as private workspace skills. Custom integrations appear only under Custom, never in recommended installation. Publishing or moving a skill across workspaces is explicit.

## 14. Update and rollback

The updater inventories every toolkit-owned component:

- `agentklar` binary and bootstrap.
- APM binary and APM-managed content only when the user explicitly adopts them.
- Bundled Review Packs and generated agent configurations.
- Vikunja, Plane, and mdBook.
- Isolated npm or Python dependencies owned by the toolkit.
- Docker image digests and compose definitions.
- Workspace database schemas and generated agent configurations.

Update flow:

```text
Check → Resolve → Show changes → Download → Verify
      → Snapshot → Stage → Health check → Activate
      → Automatic rollback on failure
```

Policies are Locked, Ask, Propose, and Auto. Propose is the default: checks and downloads may occur automatically, but activation and repository lockfile changes require approval in the native agent UI. Policies can be overridden per workspace and project.

The toolkit updates only components it installed or explicitly adopted. It never performs broad Homebrew, npm, pip, Docker, or operating-system upgrades. Offline failure leaves the active version unchanged.

## 15. Web interfaces and local security

The toolkit does not build web interfaces. It opens the selected tracker's existing UI and mdBook's generated documentation UI.

Native services:

- Bind to `127.0.0.1` by default.
- Use one workspace per service process in strict mode.
- Use random session tokens or native application authentication.
- Store secrets in OS keychains or protected environment files.
- Use separate Agentklar service-account and human tracker identities; never expose human tracker credentials through MCP, work packets, logs, or agent environments.
- Use bundled local assets where practical.
- Reject cross-workspace identifiers in the control adapter.

The user can ask an agent to open the current workspace board, ticket, evidence, or documentation page. The agent may request a trusted client elicitation prompt but cannot relay the approval decision itself. Tracker-based approval occurs in the tracker's human-authenticated UI.

The human-only approval guarantee assumes the coding agent cannot control the user's authenticated tracker browser session. Granting browser automation access to that session weakens the approval boundary and must produce a visible warning.

## 16. Error handling and recovery

The core follows these rules:

- Partial install failure rolls back configuration and leaves a resumable journal.
- Tracker unavailability preserves queued proposals locally and never reports them as applied.
- Tracker reconciliation reverts invalid protected-state edits and invalidates reviews when acceptance criteria changed after submission.
- Tracker echo events acknowledge matching outbox writes and cannot trigger reconciliation loops.
- MCP failure returns actionable diagnostics without blocking the coding agent.
- Corrupt FTS indexes are deleted and rebuilt from authoritative sources.
- Database migration begins only after a verified snapshot.
- Component health failure retains the previous active version.
- Conflicting package capabilities require a user choice.
- Ambiguous workspace selection never falls back to another workspace silently.
- Evidence upload failure keeps the task out of Completion Review.
- Reviewer cleanup failure leaves only a disposable snapshot or isolated clone with no remote; it never exposes the implementation worktree.
- Update checks time out quickly and never delay normal agent startup materially.

`agentklar doctor` reports agent configuration, component versions, services, ports, permissions, indexes, tracker connectivity, documentation builds, update drift, and estimated context cost. `doctor --fix` previews repairs and uses the workspace's approval policy.

## 17. Verification strategy

Implementation will use the smallest relevant checks at each boundary:

- Bootstrap tests for OS/architecture selection, checksum rejection, and interrupted download cleanup.
- Installer tests for idempotency, dry-run output, config backup, and rollback.
- Workspace tests for concurrent session binding and cross-workspace denial.
- FTS tests for project scoping, ranking, source attribution, and deterministic rebuild.
- Tracker contract tests shared across Vikunja and Plane adapters, including direct UI edits, missed webhooks, periodic reconciliation, and acceptance-criteria changes during review.
- Workflow tests for Definition of Ready, atomic leases, stale fencing tokens, idempotent retries, Completion Review, stale commit rejection, QA failure, evidence revisions, absence of an agent-callable approval method, trusted-human approval, and human rejection.
- Repository-isolation tests proving Quick `auto` uses the clean primary worktree only under an exclusive repository lease, concurrent code tasks never share a writable worktree, optional preparation recipes are explicit, and lease expiry never deletes unsubmitted work.
- Reviewer contract tests for cross-provider selection, fresh same-brain fallback, archive/sparse snapshots, remote-free clone fallback, snapshot time/disk budgets, adapter restrictions, strict findings output, prompt-pack pinning, and review-loop limits.
- Quality tests proving changed-path recipe selection, permission enforcement, machine-attested evidence, cleanup, and L0–L3 aggregation across representative JavaScript/TypeScript, Python, Go, and mixed repositories without embedding language-specific test frameworks.
- Optional APM-adapter tests for lockfile replay, audit failure, and target compilation.
- Update tests for staging, health failure, atomic activation, and rollback.
- End-to-end smoke tests for Codex, Claude Code, OpenCode, Cursor, Gemini CLI, and Copilot configurations where automatable.
- Native and Docker matrix tests on macOS arm64/x64 and Linux arm64/x64.

Tests must retain real commands, exit codes, and artifacts where the product itself promises evidence. Mock-only adapter tests are insufficient; each supported tracker gets a disposable integration environment in CI or a documented release qualification run.

## 18. Success measures

The toolkit records local, transparent operational metrics without sending project content externally:

- Time to initialize a machine and project.
- Time from Ready to user-approved Done.
- Model calls, estimated tokens, and estimated model cost per completed task.
- Repository-isolation and preparation time/disk cost by task lane.
- Reopened and QA-failed tasks.
- Quick-lane usage, bypassed Agentklar work, abandoned tasks, and manual overrides.
- Accepted and rejected reviewer findings.
- Repeated clarification caused by missing durable context.
- Work-packet and enabled-package context size.
- Completed acceptance criteria with linked evidence.
- Stale or broken setup, test, and documentation commands.
- Installed components that are rarely used.

Metrics guide recommendations and do not score developers or block work.

## 19. Delivery decomposition

The system is too broad for one implementation plan. Delivery uses thin end-to-end increments rather than building every subsystem horizontally before anything is useful.

### Phase 0: Contracts and proof harness

Freeze field authority, trusted human approval, the task state machine, tracker reconciliation and echo suppression, evidence provenance, QA execution profiles, reviewer findings, quality-recipe format, repository-isolation rules, compatibility tiers, and local threat boundaries. Build disposable proofs against Vikunja plus one Codex or Claude adapter. Use a development binary and manual configuration; no public installer is released.

### Phase 1: Dogfood the workflow vertical slice

Implement one local workspace, separate human/service tracker identities, Vikunja projection and reconciliation, `control.sqlite`, atomic claims, Quick `auto` isolation, dedicated Standard/Major worktrees, Definition of Ready, explicit submission, machine-attested deterministic evidence, Quick-lane Completion Review and Auto QA, and trusted human-only Done. Dogfood the complete workflow for at least two weeks on a new project and an established project. Measure model cost, time-to-done, review failures, bypass, and abandonment before approving distribution work. This pilot can fail to falsify the workflow; it cannot validate broad adoption.

### Phase 2: Distribution foundation and useful alpha

After the pilot reveals no unresolved workflow or trust-boundary failure and the user explicitly approves continuing, ship the signed native binary and interactive installer for macOS and Linux, production workspace/project registration, one MCP server, health checks, safe configuration backup, and a minimal staged update/rollback path. Support Codex, Claude Code, and OpenCode configuration first. The same flow must work without Docker; Vikunja may run natively or in Docker.

### Phase 3: Independent multi-brain review

Add native reviewer adapters for Codex, Claude Code, Gemini CLI, and OpenCode; cross-provider selection; fresh same-brain fallback; prompt-pack versioning; dynamic reviewer skills; review-loop limits; optional hosted PR comment publishing; and strict stale-commit protection. Agentklar still does not own provider keys or model routing.

### Phase 4: Context, established projects, and documentation

Add SQLite FTS5 indexing, focused work packets, context audits, `agentklar init` discovery for established repositories, workspace knowledge promotion, mdBook catalogue, documentation-impact workflow, ADR/diagram guidance, and private workspace skills. Retrieval remains text and metadata based.

### Phase 5: Quality depth and compatibility

Add changed-path quality profiles, L0–L3 verification evidence, optional jscpd/ast-grep/OSV/Gitleaks/Testcontainers/Playwright or mutation adapters when selected, routine-based task claiming, more native-agent configuration targets, and the compatibility qualification matrix. Tools remain opt-in and project-owned commands remain authoritative.

### Phase 6: Operations and optional full profile

Add optional APM integration, Plane as the richer tracker option, Docker parity for every supported service, backup/restore, advanced component update policy, offline behavior, resource/context budgets, migration tooling, and release qualification. Plane and APM are not allowed to delay the lightweight Vikunja path.

Each phase gets its own implementation specification and must ship or demonstrate independently useful, testable behavior. A feature moves forward only after its benefit and context/resource cost are measured in the previous phase.

## 20. Acceptance criteria for the overall design

The completed toolkit must demonstrate that:

1. One verified command installs the interactive CLI on supported macOS and Linux architectures without requiring Docker or `sudo`.
2. The same installation can configure at least Codex, Claude Code, and OpenCode while leaving their native UIs and model choices intact.
3. Two concurrent agent sessions can bind to different workspaces without cross-workspace retrieval.
4. A new session can resume a ticket from durable state without receiving the earlier raw conversation.
5. The lightweight profile runs with Vikunja, SQLite, bundled core Review Packs, project-native quality recipes, and no APM, Docker, mdBook daemon, or embedding model.
6. A task cannot enter Ready without success criteria and a verification method.
7. The agent-facing MCP exposes no approval or Done operation; Done requires a nonce-bound durable comment from a separate human tracker actor or a trusted client elicitation response.
8. Completion Review runs only after explicit submission, is bound to an exact commit, and cannot pass after that commit becomes stale.
9. When policy requires an independent Change Review, a different provider is preferred; otherwise a fresh isolated same-brain session is recorded visibly.
10. Slop Guard and the reviewer can block only with evidence-backed findings under the configured policy; subjective simplicity advice remains a warning by default.
11. Auto QA can fail a submission with comments, evidence, and requested corrections; the next agent session receives that history.
12. Human rejection after Auto QA returns the task to Changes Requested; without a configured trusted approval channel, the task remains in User Approval.
13. Evidence links every acceptance criterion to machine-attested validation, explicitly identified agent-reported material, or a human-observed check.
14. A stale or duplicate agent cannot mutate protected workflow state after its lease has been superseded. Quick `auto` isolation uses the primary worktree only under an exclusive repository lease; concurrent code tasks never share a writable worktree.
15. An established repository can be registered without rewriting its code or installing its language dependencies.
16. Documentation impact is recorded for Standard and Major tasks.
17. Bundled Review Packs can be enabled, disabled, updated, pinned, and rolled back by workspace, project, or session scope without implementing a general package manager.
18. The updater can fail validation and return to the previous working version without losing workspace data.
19. Direct tracker edits cannot bypass protected transitions; missed webhooks are repaired by reconciliation, Agentklar-originated webhook echoes cannot loop, and no-daemon projection staleness is documented.
20. Quick work reaches User Approval with one deterministic runner invocation and no additional model-review session by default.
21. Dogfood metrics include model cost, bypass, abandonment reasons, and qualitative findings before installer work begins; a pilot can show the workflow was not falsified but cannot establish broad validation.
22. Review snapshot time and disk use are measured, with archive/sparse modes preferred over full clones.
23. The system continues to permit ordinary coding-agent use when optional components are stopped.

## 21. Research basis

The design composes existing standards and products instead of treating them as implementation requirements to recreate:

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/)
- [Thoughtworks: Context engineering for coding agents](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)
- [Microsoft APM](https://github.com/microsoft/apm) and [APM update behavior](https://microsoft.github.io/apm/reference/cli/update/)
- [Agent Skills specification](https://agentskills.io/specification)
- [Model Context Protocol elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) and [client context best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
- [Vikunja installation](https://vikunja.io/docs/installing/), [task API](https://try.vikunja.io/api/v1/docs), and [one-shot webhook delivery](https://vikunja.io/docs/webhooks/)
- [Plane self-hosting](https://developers.plane.so/self-hosting/methods/docker-compose)
- [mdBook documentation](https://rust-lang.github.io/mdBook/)
- [Superpowers](https://github.com/obra/superpowers)
- [Ponytail](https://github.com/DietrichGebert/ponytail)
- [OpenCode providers](https://opencode.ai/docs/providers), [agents](https://opencode.ai/docs/agents/), and [CLI](https://opencode.ai/docs/cli/)
- [Qodo PR-Agent](https://github.com/qodo-ai/pr-agent) as an optional hosted-PR adapter, not a core runtime
- [SWE-PRBench](https://arxiv.org/abs/2603.26130) on evaluating review with diff, file, and repository context
- [Sphinx](https://arxiv.org/abs/2601.04252) on context-rich, checklist-based code review
