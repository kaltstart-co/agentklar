# Multi-device AgentKlar: first contract

Accepted staged contract. The first workflow milestone is implemented and checked with isolated services and browser fixtures. Real two-computer setup remains unverified. Each device runs its own AgentKlar service and native workers. A user's main harness keeps its normal workflow and delegates to saved roles on either device through the same local MCP bridge.

## Transport and setup

Use existing SSH for the first slice: the coordinator starts a narrow `agentklar peer --stdio` command on the owner device. That command calls only its local loopback service. SSH handles encryption, host identity and user login. AgentKlar does not install SSH, change its settings, copy native credentials, open a public listener, or create a relay. Existing SSH aliases can cover LAN addresses or a separately configured private network. Tailscale is optional network setup, not a dependency.

Pairing is an explicit trusted UI action on both services. Save a generated device ID, label, peer ID and allowed project mapping; hostname is only an address. A scoped peer grant permits identity checks, catalog, dispatch, status and explicit cancellation for its mapped project. Event tails and full results remain on the owner computer. It cannot approve, pair another device, change native configuration, or call arbitrary HTTP routes. Grant secrets remain private and outside prompts, events and MCP output. Revocation blocks new peer calls; it does not stop owned workers. SSH access itself still grants that OS account's normal permissions; peer scopes are application checks, not an OS sandbox.

Tradeoff: SSH is already available and avoids a new network service, but requires a reachable host and existing user SSH access. First setup tests connectivity and reports an actionable failure. It does not silently install or repair network/auth settings. Apple documents Remote Login under System Settings → General → Sharing: [Remote Login](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac).

## Durable records and routing

- Local service identity: persisted UUID, computer name and platform; peer envelopes carry their protocol version. Show selected native executable/version from the service's actual worker configuration, rather than rediscovering a different command in the dashboard.
- Coordinator project: saved roles, preference and shared context; each role adds optional `peerId` pointing to a saved device/project mapping (missing means local). Remote project mapping records owner device ID and its independently registered project ID. Never accept an arbitrary remote path supplied by MCP.
- Owner run: owner device ID, local project ID, coordinator request ID, input digest, native workspace, model and existing usage/state. The owner service alone changes this record and manages the worker.
- Coordinator dispatch: durable request ID, owner device ID, local/remote run link, input digest, last observed owner state and observation time. Connection status is separate from worker state. A disconnected running run displays its last known state and status unknown now.

Persist dispatch before sending. Owner acceptance atomically saves the idempotency key and input digest with the run, then starts it. Repeating the same request ID and digest returns that run; changed inputs conflict. If acknowledgement is lost, reconnect and query the same request ID. Never retry on another device, generate a replacement ID automatically, or stop a worker because a transport process exits. Reconnect only retries the same durable request. Owner restart follows the existing interrupted-run rule; it does not recover or resume native workers automatically.

A role's device, harness and model pins remain authoritative. Advice reads that device's native catalog and allowance with source device and observation time. An unreachable pinned device returns an explicit unavailable result. Cross-device automatic selection is deferred; do not add percentages from different subscriptions or assume two devices use different accounts. Existing advisory lead presence remains advisory and grants no ownership transfer.

## Files, context and handoff

Mapping two project IDs does not share files. First remote launch requires a Git project mapping, an explicit commit SHA available on both devices and a separate owner worktree at that SHA. Verify the mapped root and commit immediately before starting. Missing commit or a wrong mapping blocks launch. Dirty roots are allowed: this is an explicit committed snapshot, and uncommitted or untracked files are not copied. Requests requiring an unsaved snapshot are unsupported and must be changed explicitly. Do not silently push, fetch credentials, copy untracked files or replace an existing checkout.

The launch saves a bounded coordinator context revision and task snapshot. Owner native AGENTS.md, skills, trust and configuration still apply. Context edits remain coordinator-owned in this slice; there is no concurrent context merge.

Linked remote review/fix is not implemented; perform those steps on the owner computer. Cross-device continuation is a separate explicit handoff: export a bounded Git patch with base commit, source run/device and digest; show it in the trusted UI; verify base and apply with Git's conflict checks in a new recipient worktree. Reject unsupported binary/untracked/submodule changes with a clear report. Do not claim that a text result or native session ID transfers the checkout. Native session continuation stays on its owner device.

## Approvals and minimal UI

Settings adds Devices: connection test, pair/revoke, mapped projects and last connection status. Roles add Device. Work shows owner device, last sync and pending native approval notice. MCP keeps existing task tools with optional device selection through the role; device setup remains UI-only.

For the first slice, a native approval must be answered in the owner's trusted local dashboard. Peer and MCP requests cannot answer it. Shared remote approval UI needs its own concrete human-session contract later; forwarding the MCP bearer would violate current guards. This approval location is an explicit first-slice limit, not a claim of full remote operation.

## Build and verify one workflow

1. Add persisted identities, role device pins, mappings and a narrow peer protocol with strict input bounds and version handshake. Default local behavior stays compatible.
2. Add owner-scoped grants and SSH transport; then durable remote dispatch/status reads. Pairing cannot be called by MCP.
3. Test two isolated service homes with a fake transport and workers: local role and remote role run simultaneously; remote status/usage appear in coordinator; native approval remains pending until owner UI answers.
4. Drop transport after owner acceptance but before acknowledgement. Reconnect using the same ID: exactly one worker exists. Test stale status, revoked grants, changed-input replay, wrong peer identity, unsupported version, owner restart and cancellation scope.
5. Test identical Git base, missing commit, wrong mapping and dirty/untracked differences. Test patch digest/base mismatch, rejected unsupported files, clean application and conflicts without modifying the original checkout.
6. Run TypeScript, tests, build and package smoke. A real MacBook/Mac mini SSH and native worker check is a later setup step. Two services on one machine cannot prove real network or setup behavior; this does not block the isolated milestone release.

First verified outcome: a native lead delegates one local task and one task to another service; each uses its own selected harness/model and checkout, both statuses are visible, a connection loss does not duplicate or stop work, and review stays with the owning checkout.

Current package targets macOS/Linux with Node 24; background startup uses macOS launchd. Windows installation, worker lifecycle, SSH paths and background startup are unverified and excluded from the first supported slice. Real SSH and native inference remain unverified; this does not block development or isolated service tests here.


## Current implementation milestone

Implemented core: private per-device identity, scoped owner grants, explicit saved project/device mappings, narrow `agentklar peer --stdio`, existing SSH transport, durable request IDs, same-ID replay after lost acknowledgement, owner status/cancel, exact local and remote Git HEAD checks, separate owner worktrees, and stale connection observation. The peer command uses the owner's default AgentKlar service profile unless its normal environment selects another profile. Native login and configuration stay on the owner. Core fixtures use two isolated service homes, real temporary Git repositories and fake native workers/transport; they cover acknowledgement loss, disconnect, coordinator restart, replay conflicts, wrong identity/version, revoked grants, cross-scope cancellation and MCP pairing denial. They also cover owner restart without worker recovery and committed snapshots that leave dirty roots untouched. They do not establish a real SSH installation or native model access.

Implemented workflow: ordinary task/MCP delegation through saved role device pins, one Work list with distinct owner and connection state, remote catalog advice, and guided pairing with one private connection code. Remote history has an independent bounded cursor. Native approvals require the owner computer dashboard. Antigravity CLI is discovered; worker support remains unavailable.

Full product target still requires:

- Automatic cross-device candidates beyond saved role pins. Current remote role advice uses the owner catalog and allowance; unreachable pins do not switch computers.
- One trusted human dashboard that displays and answers a concrete remote native approval. MCP and peer automation must remain unable to approve. Owner-only dashboard approval is temporary.
- Explicit review/fix ownership and Git patch handoff with source/base/digest verification and conflict-safe application. A native session ID does not move a checkout.
- Real two-device SSH lifecycle, permissions and native worker validation on supported platforms. Windows remains unverified.
