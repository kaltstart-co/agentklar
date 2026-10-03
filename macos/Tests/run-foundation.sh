#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
sdk="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk}"
if [ ! -d "$sdk" ]; then sdk="$(xcrun --show-sdk-path)"; fi
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -sdk "$sdk" -target arm64-apple-macos14.0 -swift-version 5 -parse-as-library \
  "$root/Sources/AgentKlar/JSON.swift" "$root/Sources/AgentKlar/LocalRuntime.swift" \
  "$root/Sources/AgentKlar/AgentKlarClient.swift" "$root/Sources/AgentKlar/NativeMemoryDocument.swift" "$root/Tests/LocalChecks/Checks.swift" -o "$out/checks"
"$out/checks"
