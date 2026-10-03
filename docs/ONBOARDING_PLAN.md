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

## Planned setup on connected Macs

These are pending product features, added on 3 October 2026.

- **New project:** choose This Mac or a connected Mac, enter a name, choose a location on that Mac and review the destination. Create the folder and register the project on its owner. The resulting workspace opens in a project tab with its computer name; a local checkout is optional.
- **Connect a harness:** choose a computer and project, then show the harnesses installed on that computer. Review the exact MCP configuration change and apply it through the trusted GUI. Show a checked connection state and the next action for any missing installation or sign-in.

Use the selected Mac's installations, accounts, native scope rules and permissions. Remote project creation must work before a project mapping exists. Existing project pairing cannot be its prerequisite. See the [remote setup contract](MULTI_DEVICE_PLAN.md#planned-remote-project-and-harness-setup).
