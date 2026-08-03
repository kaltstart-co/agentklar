#!/usr/bin/env bash
#
# install.sh — one-line installer for Agentklar.
#
#   curl -sSL https://raw.githubusercontent.com/kaltstart-co/agentklar/main/install.sh | bash
#
# What it does:
#   1. Downloads the newest Release archive for your OS/arch from GitHub
#      (pre-release included) and verifies it against checksums.txt.
#   2. Installs the `agentklar` binary to ~/.local/bin (and tells you if that
#      is not on your PATH).
#   3. Falls back to `go install ...@latest` if no matching binary exists and
#      Go is installed.
#   4. Optionally wires skill + slash commands + MCP into OpenCode, Claude
#      Code, and Codex via `agentklar install` (skip with --no-agents).
#
# Requires: curl, tar, and (shasum or sha256sum). No clone, no manual build.
set -euo pipefail

OWNER="kaltstart-co"
REPO="agentklar"
BIN="agentklar"
INSTALL_DIR="${AGENTKLAR_INSTALL_DIR:-$HOME/.local/bin}"
AGENTS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-agents) AGENTS=0; shift;;
    --with-go)   FORCE_GO=1; shift;;   # force the go install path
    -h|--help)
      sed -n '2,11p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
FORCE_GO="${FORCE_GO:-0}"

color() { printf '\033[1;36m%s\033[0m\n' "$*"; }
err()   { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }
note()  { printf '\033[1;33mnote:\033[0m %s\n' "$*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || { err "required command not found: $1"; exit 1; }; }
need curl
need tar

# --- platform detection -------------------------------------------------------
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os/$arch" in
  darwin/arm64|darwin/aarch64) os=darwin; arch=arm64;;
  darwin/x86_64)               os=darwin; arch=amd64;;
  linux/arm64|linux/aarch64)   os=linux;  arch=arm64;;
  linux/x86_64)                os=linux;  arch=amd64;;
  *) err "unsupported platform: $(uname -s)/$(uname -m)"; note "falling back to 'go install' if Go is present"; FORCE_GO=1;;
esac

# --- choose install method ----------------------------------------------------
api="https://api.github.com/repos/$OWNER/$REPO/releases"
asset_url=""
checksum_url=""
tag=""
if [[ "$FORCE_GO" != "1" ]]; then
  releases_json="$(curl -fsSL "$api?per_page=10" 2>/dev/null || true)"
  if [[ -n "$releases_json" ]]; then
    tag="$(printf '%s' "$releases_json" | grep -oE '"tag_name": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
    asset_url="$(printf '%s' "$releases_json" | grep -oE 'https://[^"]+\.tar\.gz' | grep -E "_${os}_${arch}\.tar\.gz\$" | head -1 || true)"
    checksum_url="$(printf '%s' "$releases_json" | grep -oE 'https://[^"]+/checksums\.txt' | head -1 || true)"
  fi
fi

mkdir -p "$INSTALL_DIR"

install_from_release() {
  color "Installing Agentklar $tag ($os/$arch) from GitHub Releases"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  archive="$tmp/${BIN}.tar.gz"
  color "  downloading $asset_url"
  curl -fsSL -o "$archive" "$asset_url"

  if [[ -n "$checksum_url" ]]; then
    curl -fsSL -o "$tmp/checksums.txt" "$checksum_url"
    expected="$(grep -E "_${os}_${arch}\.tar\.gz\$" "$tmp/checksums.txt" | awk '{print $1}' || true)"
    if [[ -n "$expected" ]]; then
      actual="$($SHA "$archive" | awk '{print $1}')"
      if [[ "$expected" != "$actual" ]]; then
        err "checksum mismatch (expected $expected, got $actual)"; exit 1
      fi
      color "  verified sha256"
    else
      note "no checksum entry for this archive; skipping verification"
    fi
  fi

  tar -xzf "$archive" -C "$tmp"
  install -m 0755 "$tmp/$BIN" "$INSTALL_DIR/$BIN"
}

install_from_go() {
  if ! command -v go >/dev/null 2>&1; then
    err "no Release binary for $os/$arch and Go is not installed."
    note "install Go 1.25+ from https://go.dev/dl/ and re-run, or build from source:"
    note "  git clone https://github.com/$OWNER/$REPO && cd $REPO && go build -o $INSTALL_DIR/$BIN ./cmd/$BIN"
    exit 1
  fi
  color "Installing Agentklar via go install (builds from latest main)"
  GOBIN="$INSTALL_DIR" go install "github.com/$OWNER/$REPO/cmd/$BIN@latest"
}

# Pick a sha256 tool once.
if command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
else SHA=""; note "no sha256 tool found; archive will not be verified"; fi

if [[ -n "$asset_url" ]]; then
  install_from_release
else
  note "no matching Release binary found; using the Go path."
  install_from_go
fi

# --- PATH check ---------------------------------------------------------------
bin_path="$INSTALL_DIR/$BIN"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) :;;
  *)
    note "$INSTALL_DIR is not on your PATH."
    printf '  Add it to your shell profile:\n    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    # Best-effort: still let us call the binary directly below.
    ;;
esac

color "Installed: $bin_path"
"$bin_path" version

# --- agent wiring -------------------------------------------------------------
if [[ "$AGENTS" == "1" ]]; then
  color "Wiring skill + slash commands into OpenCode, Claude Code, Codex"
  "$bin_path" install --agents opencode,claude,codex || note "agent wiring skipped (you can run 'agentklar install' later)"
fi

cat <<EOF

$(color "Next steps")
  agentklar init                       # create a workspace for the current repo
  agentklar status                     # one-glance overview
  agentklar open board                 # open the Vikunja board (if connected)

Website: https://agentklar.kaltstart.co
EOF
