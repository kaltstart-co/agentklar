# Agentklar Release & Shipping Plan

**Status:** Proposed. Turns the "build from source" dev slice into properly versioned,
verifiable releases. Aligns with the master delivery plan's Phase 2 (distribution
foundation) and its rule: **no public tagged release until the dogfood gate passes.**

**Date:** 2026-07-23

## 1. Principles

- **Reproducible and verifiable.** Every artifact has a checksum; releases are built by
  CI from a tag, never from a laptop.
- **The developer keeps control.** Installing Agentklar never needs `sudo`, never installs
  a daemon by default, and always works as a plain binary.
- **Ship the smallest useful thing first.** Source + `go install` works today; the signed
  one-liner and package managers come as demand appears.
- **Honest channels.** Pre-1.0 means contracts can change; say so, and use beta tags for
  anything not dogfood-proven.

## 2. Versioning

- **SemVer**, starting in the **v0.x** range. While `0.`, minor bumps may change behavior;
  document breaking changes in the changelog.
- Tags are `vX.Y.Z` (e.g. `v0.1.0`); pre-releases are `vX.Y.Z-beta.N` / `-rc.N`.
- The binary reports its version: `agentklar --version` prints the tag, commit, and build
  date, stamped at build time via `-ldflags "-X main.version=..."` (from `git describe`).
  This is a concrete near-term task — wire `--version` before the first tag.

## 3. What we build

Cross-platform binaries for the supported matrix (design §17):

| OS | arch |
|----|------|
| darwin | arm64, amd64 |
| linux | arm64, amd64 |

Each release publishes: the binaries, a `checksums.txt` (SHA-256), the source archive, and
a generated changelog. Built in CI with **GoReleaser** so the matrix and archives are
declarative and identical every time.

## 4. Release process

```text
merge to main (green CI)
  → choose version, update CHANGELOG.md
  → git tag vX.Y.Z && git push --tags
  → release workflow (GoReleaser) builds the matrix, checksums, changelog
  → publishes a GitHub Release with all artifacts
  → (beta tags publish as pre-release; stable tags as latest)
```

The release workflow triggers only on `v*` tags, needs `contents: write`, and runs the
same build/test gate as CI first. A failed build fails the release — no partial uploads.

## 5. How people install

In rough order of effort, each added when it earns its place:

1. **From source (today).**
   `go install github.com/kaltstart-co/agentklar/cmd/agentklar@latest`
   — works now that the module path matches the repo.
2. **Download a release binary.** Grab the matching archive from the Releases page, verify
   against `checksums.txt`, put it on `PATH`.
3. **One-line bootstrap** (design §7.1). A small, reviewed `install.sh`:
   detects OS/arch → downloads the matching release → **verifies checksum and signature
   against a public key embedded in the script** → installs to `~/.local/bin` → hands off
   to `agentklar install`. No `sudo`.
   `curl -fsSL https://agentklar.kaltstart.co/install.sh | sh`
4. **Homebrew tap** (`kaltstart-co/homebrew-tap`), auto-updated by GoReleaser on each
   stable release: `brew install kaltstart-co/tap/agentklar`.

The website's install section evolves with this: today it shows `git clone` / `go install`;
after v0.1.0 it leads with the one-liner and links the Releases page.

## 6. Supply-chain integrity

- **Now:** SHA-256 `checksums.txt` with every release; CI-only builds.
- **Next:** keyless signing with **cosign (Sigstore)** and **SLSA build provenance** via
  GoReleaser, so downloads are verifiable without a shared secret. The bootstrap script
  pins the public key it trusts.
- Dependencies are pinned in `go.sum`; a scheduled job (or Dependabot) watches for CVEs.

## 7. Changelog & communication

- Keep a `CHANGELOG.md` (Keep a Changelog format), grouped by version. GoReleaser can seed
  it from conventional-commit subjects (`feat:`, `fix:`, …) between tags.
- Release notes call out breaking changes and the compatibility tier of each supported
  agent (Full / Assisted / Configuration-only, per the design).

## 8. Gating — do not skip

Per the master delivery plan, the first **public tagged release** waits for the dogfood
gate (two weeks of real use, model-cost/bypass/abandonment measured). Before that:

- `main` stays installable via `go install` for early adopters.
- If we need wider testing sooner, cut a **`v0.0.x-beta`** pre-release, clearly labeled
  "not dogfood-proven," rather than a stable tag.

## 9. Delivery increments

1. Wire `agentklar --version` (ldflags) + add `CHANGELOG.md`.
2. Add GoReleaser config + a tag-triggered release workflow; test with a `v0.0.1-beta.1`
   pre-release built entirely by CI.
3. Publish the one-line `install.sh` (checksum verify first; signature once cosign lands).
4. After the dogfood gate: cut **v0.1.0**, update the site to lead with the one-liner.
5. Add the Homebrew tap and cosign/SLSA signing.
6. Later: `apt`/`rpm` or a container image only if real demand shows up.

Each increment is independently useful and reversible; nothing here blocks the source
install that already works.
