#!/usr/bin/env bash
# Build the macOS menu-bar widget as an .app bundle.
# The widget must run inside a bundle (macOS requires a bundle identifier for
# notifications), so a bare `go build` binary will crash — use this instead.
#
# Usage:  scripts/build-bar.sh [output-dir]     (default: ./dist)
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "The menu-bar widget is macOS-only." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
APP="$OUT/Agentklar.app"
VERSION="$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

CGO_ENABLED=1 go build -C "$ROOT" -o "$APP/Contents/MacOS/agentklar-bar" ./cmd/agentklar-bar

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agentklar</string>
  <key>CFBundleDisplayName</key><string>Agentklar</string>
  <key>CFBundleIdentifier</key><string>co.kaltstart.agentklar-bar</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>agentklar-bar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

echo "built $APP"
echo "run it:   open \"$APP\""
echo "autostart: drag it into System Settings → General → Login Items"
