#!/usr/bin/env bash
# Run with: curl -fsSL https://agentklar-seven.vercel.app/install.sh | bash
set -euo pipefail

main() {
  local platform arch node_hash runtime node_bin prefix cli existing work archive hash
  case "$(uname -s)" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) echo "AgentKlar supports macOS and Linux." >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) echo "AgentKlar needs an ARM64 or x64 computer." >&2; return 1 ;;
  esac
  for tool in curl tar mktemp awk; do
    command -v "$tool" >/dev/null || { echo "Install $tool, then run this command again." >&2; return 1; }
  done
  if ! command -v sha256sum >/dev/null && ! command -v shasum >/dev/null; then
    echo "Install sha256sum or shasum, then run this command again." >&2; return 1
  fi
  if [ "$(id -u)" = 0 ]; then echo "Run this installer as your normal user, without sudo." >&2; return 1; fi
  existing=$(command -v agentklar || true)
  if [ -z "$existing" ] && [ -x "$HOME/.local/bin/agentklar" ]; then existing="$HOME/.local/bin/agentklar"; fi
  if [ -z "$existing" ] && { [ -e "$HOME/.local/bin/agentklar" ] || [ -L "$HOME/.local/bin/agentklar" ]; }; then
    echo "Existing ~/.local/bin/agentklar is not usable. Move or repair it, then run this installer again. It was kept unchanged." >&2
    return 1
  fi
  if [ -n "$existing" ]; then
    echo "Checking your existing AgentKlar install."
    # The updater preserves package paths and refuses unsafe replacement or active work.
    "$existing" update || { echo "Existing installation kept. Follow the updater message above; older betas need a manual upgrade." >&2; return 1; }
    cli="$existing"
  else
    work=$(mktemp -d)
    trap "rm -rf -- $(printf '%q' "$work")" EXIT
    umask 077
    prefix=""
    if command -v node >/dev/null && command -v npm >/dev/null &&
       [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = 24 ]; then
      prefix=$(npm prefix -g 2>/dev/null || true)
      if [ ! -d "$prefix" ] || [ ! -w "$prefix" ]; then prefix=""; fi
    fi
    if [ -n "$prefix" ]; then
      node_bin=$(dirname "$(command -v node)")
      echo "Using your Node 24 and npm."
    else
      # Official Node distribution, pinned with its published SHA256. No package manager.
      case "$platform-$arch" in
        darwin-arm64) node_hash=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
        darwin-x64) node_hash=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
        linux-arm64) node_hash=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
        linux-x64) node_hash=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
      esac
      runtime="$HOME/.local/share/agentklar/node-v24.21.0-$platform-$arch"
      if [ ! -x "$runtime/bin/node" ] || [ ! -x "$runtime/bin/npm" ]; then
        echo "Installing private Node 24 and npm from nodejs.org."
        download "https://nodejs.org/dist/v24.21.0/node-v24.21.0-$platform-$arch.tar.gz" "$work/node.tar.gz"
        verify "$work/node.tar.gz" "$node_hash"
        tar -xzf "$work/node.tar.gz" -C "$work"
        mkdir -p "$HOME/.local/share/agentklar"
        if [ -e "$runtime" ]; then echo "Incomplete runtime exists at $runtime. Inspect it before retrying." >&2; return 1; fi
        mv "$work/node-v24.21.0-$platform-$arch" "$runtime"
      fi
      node_bin="$runtime/bin"
      export PATH="$node_bin:$PATH"
      [ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || { echo "The official Node binary cannot run on this computer." >&2; return 1; }
      prefix="$runtime"
    fi
    # Keep package install and future update discovery on this checked installation.
    export NPM_CONFIG_PREFIX="$prefix"
    # Do not replace a hidden existing install through npm: use its guarded updater.
    if [ -e "$prefix/lib/node_modules/agentklar" ]; then
      echo "Existing package found at $prefix. Run its agentklar update command first." >&2; return 1
    fi
    archive="$work/agentklar.tgz"
    echo "Downloading AgentKlar 0.1.0-beta.28."
    download "https://github.com/kaltstart-co/agentklar/releases/download/v0.1.0-beta.28/agentklar-0.1.0-beta.28.tgz" "$archive"
    verify "$archive" 376a2798314a8fce87cc9df3aa1b655fe7ed9ab42df4b05f81d54ea110fa45dc
    npm install -g --prefix "$prefix" --omit=dev --ignore-scripts --no-audit --no-fund "$archive"
    cli="$prefix/bin/agentklar"
    [ "$("$cli" --version)" = 0.1.0-beta.28 ] || { echo "Installed version did not match the checked release." >&2; return 1; }
    # A small launcher also works when the native runtime is outside the shell PATH.
    mkdir -p "$HOME/.local/bin"
    if [ -e "$HOME/.local/bin/agentklar" ] || [ -L "$HOME/.local/bin/agentklar" ]; then
      echo "Existing ~/.local/bin/agentklar kept. Use $cli."
    else
      {
        printf '#!/usr/bin/env bash\n'
        printf 'export PATH=%q:"$PATH"\n' "$node_bin"
        printf 'export NPM_CONFIG_PREFIX=%q\n' "$prefix"
        printf 'exec %q "$@"\n' "$cli"
      } > "$HOME/.local/bin/agentklar"
      chmod 700 "$HOME/.local/bin/agentklar"
      cli="$HOME/.local/bin/agentklar"
    fi
    rm -rf -- "$work"
    trap - EXIT
    # The checked seed provides the guarded updater for the latest compatible release.
    "$cli" update
  fi
  printf 'AgentKlar is ready. Command: %s\n' "$cli"
  printf 'For the terminal menu, run %s in an interactive terminal.\n' "$cli"
  echo "Register your project in the dashboard, then connect your signed-in native harness."
  if [ "$platform" = darwin ]; then
    "$cli" service install
    "$cli" service start
    if [ "${AGENTKLAR_INSTALL_NO_OPEN:-0}" != 1 ]; then "$cli" service open; fi
  else
    echo "Keep this terminal open. Open the private setup URL printed below."
    exec "$cli" start
  fi
}

download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 "$1" --output "$2"
}
verify() {
  local actual
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$1" | awk '{print $1}');
  else actual=$(shasum -a 256 "$1" | awk '{print $1}'); fi
  [ "$actual" = "$2" ] || { echo "Download checksum failed. Nothing was installed from that download." >&2; return 1; }
}
main "$@"
