# Simple setup and everyday use

Ollama reference checked on 2026-10-02 from official source and docs. Its live app was not tested: neither Mac's current PATH exposed `ollama`.

## What to adapt

- Installed harnesses first; keep the list short.
- Remember the last project and harness.
- Separate connecting, configuring and launching.
- Show one next action for each connection.
- Keep advanced choices behind a disclosure.

Sources: [terminal menu](https://github.com/ollama/ollama/blob/main/cmd/tui/tui.go), [launch commands](https://github.com/ollama/ollama/blob/main/cmd/launch/launch.go), [GUI onboarding](https://github.com/ollama/ollama/blob/main/app/ui/app/src/components/Onboarding.tsx), [connection control](https://github.com/ollama/ollama/blob/main/app/ui/app/src/components/IntegrationConnectButton.tsx).

## First run

Running `agentklar` in a terminal should guide setup:

1. Use the current project folder, or choose another.
2. Show discovered native harnesses and choose connections.
3. Review the exact native setup changes, then connect.
4. Offer Open main harness or Open dashboard.

Use existing installations, accounts and native defaults. A missing harness gets its own setup guidance. Do not silently install another copy or change its model provider. Experimental workers keep their label. A connection does not prove model access, available tools or remaining quota.

## Return visits

Show a compact menu with the saved project and main harness:

```text
AgentKlar · My project

  Open Claude Code
  View work
  Manage team
  Connect a harness
  Add a computer
```

These actions are implemented in beta.31 for a managed macOS service. Linux uses the browser guide with its foreground service. The native harness remains the everyday work interface. Team roles, model pins, cost preference and required tools stay available when needed. Adding another supported harness uses the same connection flow; newly installed CLIs need a service restart after active work finishes.

## GUI

One setup panel presents the same project and harness choices. Each harness row shows its checked MCP status and a next action: Connect, Review setup, Use as main or Manage. Open main harness shows terminal guidance; the terminal menu launches it. Work remains the default page after setup. Native sign-in remains inside each harness. Instruction files, native defaults, plugins and remote approvals remain under advanced settings.

## Build order

- [x] Shared setup state
- [x] Terminal picker (macOS)
- [x] Guided GUI setup
- [x] Saved launch choices
- [x] Additional harness connections

Keep the existing React, Mantine and service. Use a small established terminal prompt library for keyboard selection; do not write another terminal renderer. CLI and GUI should reuse the guarded native setup logic. Keep concrete worker approvals in the trusted local UI; MCP gains no approval tool. Preserve existing explicit commands and noninteractive MCP/peer behavior.

Acceptance: fresh setup, repeat setup, adding a harness, interrupted setup recovery, unknown tools/quotas and an optional second computer. Verify real native behavior separately from discovery and UI fixtures.

## Beta.38 everyday checklist

- [ ] Open a registered project.
- [ ] Add or edit a Memory entry; save the shared context.
- [ ] Check installed skills; use Add skill for a separate review.
- [ ] Ask: “Track this task in AgentKlar; keep working here.”
- [ ] Check the report under Reported by your harness.

The harness reports short notes through MCP without delegating. A report is not
monitored execution or measured usage. Automatic observation of all native work
is not implemented.

## Setup on connected Macs — beta.38

Both Macs need the beta.38-compatible setup service. The normal mini service
and global CLI remain beta.33; this preview does not update them automatically.

1. On the owner Mac, open **Settings → Devices → Remote project setup → Share folder on this Mac**.
2. Enter the other Mac's device ID, choose a parent folder and create a private setup code.
3. On the other Mac, use **Connect Mac** with its existing SSH host and that code. Verify the owner.
4. Choose **New project**, enter a project and folder name, then create it inside the shared folder. An interrupted reply uses **Retry same project request**.
5. Open the owner project tab. Choose an installed owner harness, review its config path, scope and entry, then explicitly apply the connection.
6. Open a native session on the owner to check that its AgentKlar tools load. This last step remains unverified for the new remote setup flow.

Project creation and OpenCode preview/apply/status/undo passed a real isolated
MacBook-to-mini SSH check. The remote tab needs no local project mirror; it
currently presents owner-project and harness setup. Native sign-in and
permissions remain on the owner. This is a locally installed development
preview; signed public release and full GUI acceptance are pending. See the
[remote setup contract](MULTI_DEVICE_PLAN.md#remote-project-and-harness-setup--beta38).
