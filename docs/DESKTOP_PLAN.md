# Native Mac app direction

The current beta.40 source app is a SwiftUI preview for macOS 14 and newer on Apple Silicon. SwiftPM builds it; Sparkle 2.10.0 supplies the signed app update path. The Electron prototype is retired and is not part of the shipped architecture.

## One local service

The terminal menu, native Mac app and browser support dashboard use the same TypeScript service and saved work. Native harnesses keep their usual accounts, tools and permissions. Each computer owns its project folders and worker processes. The hosted website supplies downloads and setup guidance; it has no project database or native credentials.

The app bundles Node 24 and the local service. It can also connect to an existing standalone CLI service and review adoption of the bundled runtime. Runtime updates verify bundled files, wait for active work to finish and keep recovery information. The CLI remains available alongside the app. Closing the app leaves background work running. Clean Mac startup and full GUI acceptance remain release gates.

## Current native scope

Work, Context, Instructions, Team, Models, Usage and Settings use standard macOS controls backed by existing APIs. Controls inherit the host system’s appearance; the current development host runs macOS 27. Work has a native toolbar and responsive list/detail layout. Action rows adapt to narrow space. Project photos are cached per Mac as normalized PNG files.

The source includes remote work and concrete approvals, linked review/fix, skills/plugins, benchmark advice, native defaults, Git handoff review/apply/recovery, coordinated control and native task navigation. Supported approvals still require review and allow-once. Context keeps revision checks; instruction edits keep preview/apply and owned undo. Explicit harness/model pins remain visible.

Muse catalog discovery independently calls the documented native [`usage/read`](https://dev.meta.ai/docs/muse-code/changelog); missing observations remain unknown. This is last-seen subscription data, not a live balance. Complete account quotas remain unfinished. Source implementation does not establish full native GUI acceptance or feature parity.

Claude session signals are optional, reviewed plugin hooks. The source can show responding, permission waiting, idle and ended states without saving prompts or transcripts. Real hook proof covers SessionStart, UserPromptSubmit and SessionEnd in a private profile; permission waiting, Stop and StopFailure still lack real hook proof. Automatic observation across all harnesses remains unfinished. OpenCode 2 has a bounded real worker proof and a separate native MCP connection proof; those checks do not establish native GUI acceptance.

The installed MacBook app and its service are beta.39. Public downloads and the normal Mac mini service remain beta.33. Beta.40 is packaged locally; it has not been installed or accepted in the GUI.

## Release gates

- [x] Native view build
- [x] Local boundary checks
- [ ] Native GUI acceptance
- [ ] Clean Mac setup
- [ ] Full native parity
- [ ] Signed distribution
- [ ] Signed app updates

The beta.40 source passed TypeScript checks, all 353 service tests, the production build, Foundation checks, the Swift release build and seven offline release checks. These results do not prove beta.40 installation, clean Mac startup, native GUI acceptance, notarization or a signed update round trip.

The development build is ad-hoc signed. Public app updates stay disabled without the signed-release configuration and valid Developer ID signature. Service updates keep the existing guarded CLI path. App update installation must preserve background work and require an explicit restart decision.

The next step is actual native GUI acceptance, followed by a signed package and signed Sparkle update proof when a signing identity is available. The current desktop scope is macOS; other desktop platforms have no verified package. Build and packaging details are in [MACOS_APP.md](MACOS_APP.md).
