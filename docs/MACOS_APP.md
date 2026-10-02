# AgentKlar for macOS

AgentKlar has a native SwiftUI development preview for Apple Silicon Macs running macOS 14 or newer. It uses standard macOS windows, project tabs, lists, document editors, settings controls, folder selection and alerts. These controls inherit the host system’s appearance; the current development host runs macOS 27. Electron is retired and is not shipped. The app does not embed the browser dashboard or a WebView.

The TypeScript service still owns projects, saved work, workers and approvals. The app includes Node 24 and the built service with its production dependencies. No separate AgentKlar CLI, npm or system Node is required. The app connects over the local API through a private session obtained by its fixed internal command bridge. Native harnesses keep their own accounts, settings and permission decisions. Closing the app leaves the managed service and background work running.

## Preview features

- Workspace: compact project tabs with close buttons, a plus button and searchable project chooser; a muted sidebar, compact window chrome and a shared 24-point page inset. Open pages retain project-scoped drafts and selection.
- Work: use labelled actions and a responsive task list/detail layout, create a worker task with automatic model advice or explicit pins, set image/tool requirements, stop it, read results and events, and review supported concrete approvals once. Local and remote linked review/fix actions preserve their source workspace.
- Context: edit Brief, Memory and Next steps in a large document editor with revision checks. Separate views review Git changes, prepare/apply a handoff, recover an interrupted apply and manage coordinated control. Task links open the matching native task view.
- Instructions: read AGENTS.md or CLAUDE.md in a large source editor, preview a change, apply it and undo an unchanged owned change. Native tabs manage project/personal skills and the separate Claude workflow plugin through reviewed receipts.
- Team: use a role roster for responsibilities and local/remote model pins. Choose a routing preset and a separate opt-in delegation policy. Named presets have editable model strengths and allowance thresholds.
- Models and Usage: use flat native lists to read model metadata, cached benchmark evidence, available allowance and reported task usage. Missing values stay unknown.
- Settings: use plain subsection tabs to connect a harness, choose a native installation, save the main harness, preview model/effort defaults, manage paired devices and check updates. Project photos are cached per Mac as normalized PNG files.
- Remote work: choose a saved remote role or include connected computers in automatic selection; read compact owner status/results, request stop and review supported concrete remote approvals. Remote task selection never requests an unsupported local event tail.

These controls are in the beta.35 development source and local preview bundle. This does not establish a published beta.35 release. Pages use shared sizing and padding, full-width headings and labelled actions. Supporting records and exact reviews open separately; no DisclosureGroup controls remain. Full native GUI acceptance and feature parity remain unfinished. Open-main-harness guidance uses the terminal. Unknown approval kinds cannot be accepted in the native app. Worker completion is not human review.

Muse model refresh now also makes an independent native [`usage/read`](https://dev.meta.ai/docs/muse-code/changelog). It returns last-seen subscription windows with their original observation time, not a live balance. An empty observation stays unknown, and quota failure does not hide the model list. Complete account quota coverage remains unfinished.

## Build locally

From the repository root:

```sh
bash macos/Tests/run-foundation.sh
python3 macos/scripts/package.py
```

The package uses SwiftPM and pins Sparkle 2.10.0. Packaging builds the ARM64 release executable, copies the framework, icons and notices, downloads and verifies the pinned official Node 24.21.0 archive, builds the service and installs its locked production dependencies without package scripts, and creates `macos/out/AgentKlar.app`, a versioned ARM64 ZIP and DMG. It does not install the app into Applications. The current script uses the installed macOS 26.5 SDK when available; the app's minimum runtime is macOS 14.

The local build is ad-hoc signed and its signature is checked during packaging. This is a development preview, not a Developer ID signed or notarized public release. Intel packaging is unverified. Do not disable Gatekeeper to treat this preview as a trusted public release.

## First connection and repair

The app checks its bundled file manifest against the identity in Info.plist, verifies every regular runtime file and copies it to a private, immutable folder under `~/Library/Application Support/AgentKlar/runtimes/<manifest-sha256>`. Startup points to this copy, so moving or replacing the app does not remove a running service. Linked, missing or changed runtime files are refused.

On a clean Mac, the explicit setup action installs the owned launchd service using the bundled Node and service. It obtains a private link without an external launcher or network download. An existing owned service is reused during ordinary connection. Unknown jobs, occupied ports and incomplete recovery are refused. Setup does not install coding harnesses or sign into them. Local setup and update actions cannot overlap.

The native client uses a private URLSession cookie store. API requests stay on the exact `http://127.0.0.1` service origin, and writes include that origin. The runtime accepts a small fixed CLI command list. It exposes no general shell or permission bypass.

## App and service updates

App updates and service updates are separate. Local preview builds keep Sparkle disabled. Settings can check available service releases. An explicit app-runtime upgrade uses the fixed internal `service use-app-runtime` command. It keeps the owned service ID, key, home and port, requires authenticated idle-only quiesce, and changes only its runtime startup paths. Both packages must declare the same supported data compatibility. Startup changes have a private recovery record; failed new-version health restores the earlier startup. Commit happens before resume, so an unclear resume never rolls back a runtime that may have accepted work. Choosing Upgrade again checks or recovers an interrupted adoption. Ordinary connection never automatically replaces an older running service. Save open drafts before upgrading. The optional global CLI keeps its existing separate package updater.

The signed packaging path uses `python3 macos/scripts/package.py --signed` with `AGENTKLAR_SIGN_IDENTITY`, `AGENTKLAR_NOTARY_PROFILE` and `AGENTKLAR_SPARKLE_PUBLIC_KEY`. It requires a Developer ID identity, a notarization profile and a 32-byte base64 Sparkle public key. The script signs nested components and the app, verifies the signature, notarizes and staples the app and DMG. A public release also needs signed update metadata and archives at the fixed appcast URL, `https://agentklar-seven.vercel.app/appcast.xml`.

Sparkle activation checks the signed-release marker, fixed feed, key and Apple Developer ID signature. Automatic checks are enabled only for that signed path; automatic installation is disabled. The restart callback asks for confirmation and checks for idle service work and no local API write, setup or service update in progress. The background service remains running during an app restart.

## Verification limits

The published beta.33 release passed [exact-source CI](https://github.com/kaltstart-co/agentklar/actions/runs/37012958180), including the native Apple Silicon build, eight XCTest cases and the standalone native boundary checks. The local Mac service run passed all 309 tests. Linux CI passed 305 service tests and skipped four checks that require macOS or the installed Antigravity CLI.

Historical beta.33 GUI checks on the MacBook covered Work, Models, Team, Settings, Context and Instructions, plus project selection and the native image picker. Those screenshots predate the beta.34 workspace redesign and do not prove its acceptance. The Mac mini GUI was not exercised.

The beta.34 revamp was built, signature-checked and installed into `/Applications/AgentKlar.app` on the MacBook, with the previous app preserved. Local service tests passed all 313 cases, TypeScript checks and both builds passed, and the native Foundation boundary checks passed. [Exact-source CI for `e321f81`](https://github.com/kaltstart-co/agentklar/actions/runs/37034820106) also passed the service checks, package smoke test, native build, XCTest and boundary checks; its preview packaging job was still running when this evidence was recorded.

GUI checks covered all seven main pages, compact tabs, the searchable project chooser, loaded instructions, the empty Team view and the scrolling task dialog. The picker keeps search above the scrolling list, leaves room around the native focus outline, and truncates long paths; a unique search returned only the matching project. Temporary Context drafts survived project switching and closing/reopening a tab. Temporary Team and Defaults drafts survived leaving and returning to their pages. Test drafts were cleared without saving or applying them. Hidden retained pages were verified absent from the accessibility tree. Reconnection draft preservation was reviewed in source; an actual authentication-loss GUI cycle remains unverified. These checks do not establish full GUI acceptance.

A real isolated launchd fixture passed fresh beta.34 startup and owned beta.33-to-beta.34 runtime adoption. The adoption preserved the service ID, home, port, key, project and saved file; startup used the private bundle and maintenance cleared. Both temporary owned jobs and startup files were removed afterward. Evidence: `/var/folders/bx/7z3_cmzs3g77dlrl7f0kxl1w0000gn/T/agentklar-bundled-runtime-proof-ipuk37wj/evidence.json`. This proves the isolated backend paths, not clean-Mac GUI setup. The normal default services remained on beta.33 at that check.

Full native GUI acceptance is pending, including narrow-window action layouts, project picture import, worker starts and approvals, remote linked review/fix, Git handoff/recovery, coordinated control and configuration writes. Clean-Mac startup is unverified. No signing identity is available, so Developer ID distribution, notarization and a signed Sparkle download/install round trip remain unverified. See [validation evidence](VALIDATION.md) for the exact checks and limits.


### Routing preferences and model scope — 2 October 2026

The installed beta.34 development app now shows three equal routing preference cards with a visible explanation and selected-option rules. Save preference changes only the project preference and keeps unsaved role drafts. The native GUI check selected all three options, saved Economical in the existing disposable UI project, confirmed the role draft remained, restored Balanced and confirmed it after relaunch. The final three-column layout was inspected in the running app. The real project preference was not changed.

Models and Usage now have a Computer selector for the current project's saved mappings. Remote account allowance is labelled with its computer; local task token totals are not shown as remote usage. The read endpoint requires an authenticated caller and the exact saved project mapping. Tests cover invalid scope, revoked grants, mismatched remote project and a mapping changed during discovery. Catalog reads do not start workers.

The Muse 1.4.2 native catalog returned a model with a null profile ID. Its installed SDK defines this as a model without a declared profile. The parser now accepts that row under the selected profile, while requiring the same provider and rejecting explicit mismatched profiles. Empty or fully rejected lists report unavailable. A live metadata-only probe returned `muse-spark-1.3-contributor`; no inference was started.

The MacBook's OpenCode 1.18.34 exposes its free provider models and reports no saved provider credentials. The Mac mini has OpenCode 2.0.12 with two stored Z.AI Coding Plan profiles. A bounded owned private server returned 17 models after its initial plugin snapshot settled, including GLM 5.3 models. AgentKlar's OpenCode 1 adapter uses different startup, model, session and permission contracts, so OpenCode 2 support remains unfinished. Saved credentials were kept on their original computer. The remote view alone does not fix adapter compatibility.

Validation passed TypeScript checks, all 319 service tests, the web/service build, the final Swift release build and Foundation checks. The app was signature-checked and installed with the previous app preserved. Through the native Updates page, the idle default MacBook service adopted the bundled beta.34 runtime. Its service identity, records and native configuration hashes were unchanged, and maintenance cleared. The Mac mini service remains beta.33. This is a local development installation, not a published or signed release.


## Current preset and delegation controls — beta.35

Team now has compact Routing preset and Delegation controls. Edit presets creates a named copy with task strengths and allowance thresholds. Apply policy changes routing and delegation; Save team changes roles only. Projects keep their applied copy until you apply an updated preset. See [Claude Code and Codex usage](delegation.md).

Only when asked is the default. Use team when helpful is an explicit project choice. Selecting a routing preset does not enable delegation. Connections now has one main connection action, a quiet refresh icon and detail links; installation choices open separately. Sidebar labels fill the row and define its click area.

The MacBook app and idle service are locally updated to beta.35. All 325 service tests, TypeScript, both builds, Foundation checks and package smoke passed. GUI checks covered named preset creation, validation, persistence, separate policy saves, role draft preservation and Settings navigation. The real project and native configs stayed unchanged. Empty-space coordinate clicks and real native-agent policy behavior remain unverified. See [validation details](VALIDATION.md).
