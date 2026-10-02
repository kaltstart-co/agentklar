# Native Mac app direction

The current beta.33 source app is a SwiftUI preview for macOS 14 and newer on Apple Silicon. SwiftPM builds it; Sparkle 2.10.0 supplies the signed app update path. The Electron prototype is retired and is not part of the shipped architecture.

## One local service

The terminal menu, native Mac app and browser support dashboard use the same TypeScript service and saved work. Native harnesses keep their usual accounts, tools and permissions. Each computer owns its project folders and worker processes. The hosted website supplies downloads and setup guidance; it has no project database or native credentials.

The app discovers the existing standalone Node 24 launcher, uses its managed-service commands and obtains a private local session. Missing installations use the hash-checked bundled CLI installer with `AGENTKLAR_INSTALL_NO_OPEN=1`. It does not replace an unrelated service or launch workers through an arbitrary shell. Closing the app leaves background work running.

## Current native scope

Work, Context, Instructions, Team, Models, Usage and Settings use standard macOS controls backed by existing APIs. Controls inherit the host system’s appearance; the current development host runs macOS 27. Work has a native toolbar and responsive list/detail layout. Action rows adapt to narrow space. Project photos are cached per Mac as normalized PNG files.

The source includes remote work and concrete approvals, linked review/fix, skills/plugins, benchmark advice, native defaults, Git handoff review/apply/recovery, coordinated control and native task navigation. Supported approvals still require review and allow-once. Context keeps revision checks; instruction edits keep preview/apply and owned undo. Explicit harness/model pins remain visible.

Muse catalog discovery independently calls the documented native [`usage/read`](https://dev.meta.ai/docs/muse-code/changelog); missing observations remain unknown. This is last-seen subscription data, not a live balance. Complete account quotas remain unfinished. Source implementation does not establish full native GUI acceptance or feature parity.

## Release gates

- [x] Native view build
- [x] Local boundary checks
- [ ] Native GUI acceptance
- [ ] Developer ID signing
- [ ] Notarized distribution
- [ ] Signed update proof

The beta.33 source package builds on Apple Silicon, and the latest backend/foundation run passed 309 checks. The new project-photo XCTest addition has not run yet; CI is pending.

The development build is ad-hoc signed. Public app updates stay disabled without the signed-release configuration and valid Developer ID signature. Service updates keep the existing guarded CLI path. App update installation must preserve background work and require an explicit restart decision.

The next step is actual native GUI acceptance, followed by a signed package and signed Sparkle update proof when a signing identity is available. The current desktop scope is macOS; other desktop platforms have no verified package. Build and packaging details are in [MACOS_APP.md](MACOS_APP.md).
