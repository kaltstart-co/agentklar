# Desktop app direction

The working product runs locally. Each computer owns its project folders, native accounts, worker processes, approvals and saved work. The deployed website provides installation guides, release links and updates. It has no project database or native account credentials.

## One product, two entry points

- Terminal menu for keyboard users.
- Desktop GUI for setup and visibility.
- One shared local service and database.
- Existing harnesses keep their normal UI, tools, accounts and permissions.
- Remote computers run their own service and harnesses.

Reuse the current React/Mantine GUI and TypeScript service. The desktop app should connect to an existing owned service or start its own verified install. A busy or unrelated service must be explained without replacement. Closing the window should leave background work running. Quitting the service must use the existing active-work and approval guards.

## Packaging test

Tauri can bundle a service executable alongside the GUI. Electron provides Node.js in its main process. Test one signed macOS package before choosing a wrapper; retain the service's Node 24 requirement, native subprocess behavior and trusted approval boundary. Do not add a browser tool or change model providers as part of desktop packaging.

Primary references checked on 2026-10-02: [Tauri external binaries](https://v2.tauri.app/develop/sidecar/), [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/).

## Build order

- [ ] macOS packaging proof
- [ ] Native folder picker
- [ ] Background status
- [ ] Open native harness
- [ ] Signed app updates
- [ ] Windows worker proof
- [ ] Windows installer

Start with macOS. Windows requires actual checks for executable discovery, native account homes, startup ownership, process cleanup, permissions, Git worktrees and remote paths. The current release supports macOS and Linux; no Windows or desktop binary is shipped yet.
