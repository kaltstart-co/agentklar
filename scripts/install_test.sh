#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

link_tools() {
  local bin="$1" tool path
  mkdir -p "$bin"
  for tool in awk cat grep head install mkdir mktemp mv rm sed tar tr; do
    path="$(command -v "$tool")"
    ln -s "$path" "$bin/$tool"
  done
}

make_release() {
  local dir="$1" mode="$2" archive checksum
  mkdir -p "$dir/payload"
  cat >"$dir/payload/agentklar" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = version ]; then
  [ "${STAGED_VERSION_FAIL:-0}" = 0 ] || exit 9
  printf 'agentklar test\n'
elif [ "${1:-}" = install ]; then
  printf 'install called\n' >>"$CALL_LOG"
fi
SCRIPT
  chmod +x "$dir/payload/agentklar"
  archive="$dir/agentklar_test_linux_amd64.tar.gz"
  tar -czf "$archive" -C "$dir/payload" agentklar
  checksum="$({ command -v shasum >/dev/null && shasum -a 256 "$archive"; } || sha256sum "$archive")"
  case "$mode" in
    valid) printf '%s  %s\n' "${checksum%% *}" "${archive##*/}" >"$dir/checksums.txt" ;;
    mismatch) printf '%064d  %s\n' 0 "${archive##*/}" >"$dir/checksums.txt" ;;
    missing-entry) printf '%064d  unrelated.tar.gz\n' 0 >"$dir/checksums.txt" ;;
  esac
}

make_curl() {
  local bin="$1" include_checksum="${2:-1}"
  cat >"$bin/curl" <<'SCRIPT'
#!/bin/sh
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *api.github.com*)
    printf '[{"tag_name":"v-test","assets":[{"browser_download_url":"https://fixtures/agentklar_test_linux_amd64.tar.gz"}'
    [ "$INCLUDE_CHECKSUM" = 1 ] && printf ',{"browser_download_url":"https://fixtures/checksums.txt"}'
    printf ']}]'
    ;;
  *checksums.txt) /bin/cp "$FIXTURES/checksums.txt" "$out" ;;
  *.tar.gz) /bin/cp "$FIXTURES/agentklar_test_linux_amd64.tar.gz" "$out" ;;
  *) exit 22 ;;
esac
SCRIPT
  chmod +x "$bin/curl"
  cat >"$bin/uname" <<'SCRIPT'
#!/bin/sh
[ "${1:-}" = -s ] && printf 'Linux\n' || printf 'x86_64\n'
SCRIPT
  chmod +x "$bin/uname"
}

add_sha() {
  local bin="$1" sha
  if sha="$(command -v shasum 2>/dev/null)"; then
    ln -s "$sha" "$bin/shasum"
  elif sha="$(command -v sha256sum 2>/dev/null)"; then
    ln -s "$sha" "$bin/sha256sum"
  else
    fail "test host needs shasum or sha256sum"
  fi
}

run_case() {
  local name="$1" mode="$2" include_checksum="$3" with_sha="$4" staged_fail="$5"
  local dir="$TEST_ROOT/$name" status=0
  mkdir -p "$dir/install" "$dir/home/.local/share/agentklar/project"
  printf 'old\n' >"$dir/install/agentklar"
  chmod +x "$dir/install/agentklar"
  printf 'workspace\n' >"$dir/home/.local/share/agentklar/project/control.sqlite"
  : >"$dir/calls"
  make_release "$dir/release" "$mode"
  link_tools "$dir/bin"
  make_curl "$dir/bin" "$include_checksum"
  [ "$with_sha" = 1 ] && add_sha "$dir/bin"

  env PATH="$dir/bin" HOME="$dir/home" FIXTURES="$dir/release" INCLUDE_CHECKSUM="$include_checksum" CALL_LOG="$dir/calls" \
    STAGED_VERSION_FAIL="$staged_fail" AGENTKLAR_INSTALL_DIR="$dir/install" \
    /bin/bash -s -- --no-agents <"$ROOT/install.sh" >"$dir/output" 2>&1 || status=$?

  [ "$(cat "$dir/home/.local/share/agentklar/project/control.sqlite")" = workspace ] || fail "$name changed workspace data"
  CASE_DIR="$dir"
  CASE_STATUS="$status"
}

run_case checksum-mismatch mismatch 1 1 0
[ "$CASE_STATUS" -ne 0 ] || fail "checksum mismatch succeeded"
[ "$(cat "$CASE_DIR/install/agentklar")" = old ] || fail "checksum mismatch replaced existing binary"

run_case invalid-binary valid 1 1 1
[ "$CASE_STATUS" -ne 0 ] || fail "invalid staged binary succeeded"
[ "$(cat "$CASE_DIR/install/agentklar")" = old ] || fail "invalid staged binary replaced existing binary"

run_case missing-checksum valid 0 1 0
[ "$CASE_STATUS" -ne 0 ] || fail "release without checksums succeeded"
[ "$(cat "$CASE_DIR/install/agentklar")" = old ] || fail "missing checksum replaced existing binary"

run_case missing-entry missing-entry 1 1 0
[ "$CASE_STATUS" -ne 0 ] || fail "missing checksum entry succeeded"
[ "$(cat "$CASE_DIR/install/agentklar")" = old ] || fail "missing checksum entry replaced existing binary"

run_case missing-sha valid 1 0 0
[ "$CASE_STATUS" -ne 0 ] || fail "release without SHA tool succeeded"
grep -qi 'sha256.*required\|required.*sha256' "$CASE_DIR/output" || fail "missing SHA tool error was unclear"
[ "$(cat "$CASE_DIR/install/agentklar")" = old ] || fail "missing SHA tool replaced existing binary"

run_case valid valid 1 1 0
[ "$CASE_STATUS" -eq 0 ] || { cat "$CASE_DIR/output" >&2; fail "valid release failed"; }
grep -q 'agentklar test' "$CASE_DIR/install/agentklar" || fail "valid release did not replace binary"
[ ! -s "$CASE_DIR/calls" ] || fail "--no-agents did not pass through bash -s --"

printf 'install tests passed\n'
