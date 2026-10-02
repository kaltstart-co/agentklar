# AgentKlar for macOS

AgentKlar has a native SwiftUI development preview for Apple Silicon Macs running macOS 14 or newer. It uses native windows, lists, forms, folder selection and alerts. Electron is retired and is not shipped. The app does not embed the browser dashboard or a WebView.

The TypeScript service still owns projects, saved work, workers and approvals. It runs with standalone Node 24. The app connects over the local API through a private session obtained with `agentklar service open --print`. Native harnesses keep their own accounts, settings and permission decisions. Closing the app leaves the managed service and background work running.

## Preview features

- Work: create a worker task with automatic model advice or explicit pins, set image/tool requirements, stop it, read results and events, and review supported concrete approvals once. Local review/fix actions preserve their source workspace.
- Context: edit the shared brief, memory and handoff with revision checks.
- Instructions: read AGENTS.md or CLAUDE.md, preview a change, apply it and undo an unchanged owned change. Native tabs manage project/personal skills and the separate Claude workflow plugin through reviewed receipts.
- Team: save roles, responsibilities, local/remote harness/model pins and cost preference.
- Models and Usage: read native metadata, cached benchmark evidence, available allowance and reported task usage. Missing values stay unknown.
- Settings: connect a harness, choose a native installation, save the main harness, preview model/effort defaults, manage paired devices and check updates.
- Remote work: choose a saved remote role or include connected computers in automatic selection; read compact owner status/results, request stop and review supported concrete remote approvals. Remote task selection never requests an unsupported local event tail.

These extended screens are in the source build and have not been released in beta.32. This preview has not reached browser feature parity. Remote linked review/fix, explicit Git change handoff and coordinated-control UI still use the existing browser support dashboard. Open-main-harness guidance uses the terminal. Unknown approval kinds cannot be accepted in the native app. Worker completion is not human review.

## Build locally

From the repository root:

```sh
bash macos/Tests/run-foundation.sh
python3 macos/scripts/package.py
```

The package uses SwiftPM and pins Sparkle 2.10.0. Packaging builds the ARM64 release executable, copies the framework, icons, notices and installer, and creates `macos/out/AgentKlar.app`, a versioned ARM64 ZIP and DMG. It does not install the app into Applications. The current script uses the installed macOS 26.5 SDK when available; the app's minimum runtime is macOS 14.

The local build is ad-hoc signed and its signature is checked during packaging. This is a development preview, not a Developer ID signed or notarized public release. Intel packaging is unverified. Do not disable Gatekeeper to treat this preview as a trusted public release.

## First connection and repair

The app discovers existing launchers in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and PATH. It keeps the standalone Node 24 environment and uses fixed managed-service commands. It can start the owned service and obtain a one-time local link; an unknown or unhealthy service requires terminal repair guidance.

If AgentKlar is missing, the explicit local setup action runs the bundled root installer after checking its SHA-256 hash, with `AGENTKLAR_INSTALL_NO_OPEN=1`. Packaging copies the current installer and records its hash. Setup preserves existing launchers and native accounts; it does not install coding harnesses or sign into them. Local setup and update actions cannot overlap.

The native client uses a private URLSession cookie store. API requests stay on the exact `http://127.0.0.1` service origin, and writes include that origin. The runtime accepts a small fixed CLI command list. It exposes no general shell or permission bypass.

## App and service updates

App updates and service updates are separate. Local preview builds keep Sparkle disabled. Settings can check the existing service updater and request a confirmed `agentklar update`, without force. The CLI still enforces ownership, active-work refusal, release verification and recovery. Save open drafts before updating.

The signed packaging path uses `python3 macos/scripts/package.py --signed` with `AGENTKLAR_SIGN_IDENTITY`, `AGENTKLAR_NOTARY_PROFILE` and `AGENTKLAR_SPARKLE_PUBLIC_KEY`. It requires a Developer ID identity, a notarization profile and a 32-byte base64 Sparkle public key. The script signs nested components and the app, verifies the signature, notarizes and staples the app and DMG. A public release also needs signed update metadata and archives at the fixed appcast URL, `https://agentklar-seven.vercel.app/appcast.xml`.

Sparkle activation checks the signed-release marker, fixed feed, key and Apple Developer ID signature. Automatic checks are enabled only for that signed path; automatic installation is disabled. The restart callback asks for confirmation and checks for idle service work and no local API write, setup or service update in progress. The background service remains running during an app restart.

## Verification limits

The native release build compiles all views. Six XCTest cases and the standalone boundary checks passed in Mac CI. A GUI smoke check on the MacBook opened all seven pages, switched saved projects, read the actual root instruction file, checked service update status, and opened and cancelled a task draft. Both Macs have the preview in Applications and a healthy beta.32 local service; the Mac mini GUI was not exercised.

Full native GUI acceptance is pending. Worker launch and concrete approval decisions, instruction apply/undo, context/team saves, metadata refresh and first installation still need GUI workflow proof. No signing identity is available, so Developer ID distribution, notarization and a signed Sparkle download/install round trip remain unverified. See [validation evidence](VALIDATION.md) for the exact checks and limits.
