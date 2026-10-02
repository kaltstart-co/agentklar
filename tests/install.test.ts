import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve("web/public/install.sh");
const releaseHash = "376a2798314a8fce87cc9df3aa1b655fe7ed9ab42df4b05f81d54ea110fa45dc";
const runtimeHash = "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057";

function fixture(options: { bootstrap?: boolean; existing?: boolean; busy?: boolean; corrupt?: string; platform?: string; conflictingPrefix?: boolean; noOpen?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentklar-installer-"));
  const bin = join(root, "tools"), home = join(root, "home"), templates = join(root, "templates"), log = join(root, "calls");
  const runtime = join(home, ".local/share/agentklar/node-v24.21.0-darwin-arm64");
  const prefix = options.bootstrap ? runtime : join(root, "npm");
  for (const dir of [bin, home, templates, ...(options.bootstrap ? [] : [prefix])]) mkdirSync(dir, { recursive: true });
  const script = (path: string, source: string) => writeFileSync(path, `#!/bin/bash\nset -eu\n${source}\n`, { mode: 0o700 });
  script(join(bin, "uname"), 'if [ "$1" = -s ]; then echo "$TEST_PLATFORM"; else echo arm64; fi');
  script(join(bin, "id"), "echo 501");
  script(join(bin, "curl"), `printf 'curl %s\\n' "$*" >> "$TEST_LOG"
target=""; while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then target="$2"; shift; fi; shift; done
printf 'fixture archive' > "$target"`);
  script(join(bin, "sha256sum"), `case "$1" in
  */node.tar.gz) value=${runtimeHash}; kind=runtime ;;
  *) value=${releaseHash}; kind=release ;;
esac
if [ "$TEST_CORRUPT" = "$kind" ]; then value=bad; fi
printf '%s  %s\\n' "$value" "$1"`);
  script(join(templates, "node"), "echo 24");
  script(join(templates, "agentklar"), `printf 'agentklar %s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = --version ]; then echo 0.1.0-beta.28; fi
if [ "$1" = update ] && [ "$TEST_BUSY" = yes ]; then echo 'Active workers block update.' >&2; exit 1; fi
if [ "$1" = update ] && [ "$TEST_CONFLICT_PREFIX" = yes ]; then
  [ "$(npm prefix -g)" = "$TEST_PREFIX" ] || { echo 'Wrong updater npm root' >&2; exit 1; }
fi
if [ "$1" = service ] && [ "$TEST_CONFLICT_PREFIX" = yes ]; then
  [ "$NPM_CONFIG_PREFIX" = "$TEST_PREFIX" ] || { echo 'Wrong startup npm prefix' >&2; exit 1; }
fi`);
  script(join(templates, "npm"), `printf 'npm %s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = prefix ]; then echo "\${NPM_CONFIG_PREFIX:-$TEST_PREFIX}"; exit; fi
if [ "$1" != install ]; then echo 'Unexpected npm command' >&2; exit 1; fi
mkdir -p "$TEST_PREFIX/bin" "$TEST_PREFIX/lib/node_modules/agentklar"
cp "$TEST_TEMPLATES/agentklar" "$TEST_PREFIX/bin/agentklar"`);
  script(join(bin, "tar"), `printf 'tar %s\\n' "$*" >> "$TEST_LOG"
destination=""; while [ "$#" -gt 0 ]; do if [ "$1" = -C ]; then destination="$2"; shift; fi; shift; done
mkdir -p "$destination/node-v24.21.0-darwin-arm64/bin"
cp "$TEST_TEMPLATES/node" "$TEST_TEMPLATES/npm" "$destination/node-v24.21.0-darwin-arm64/bin/"`);
  if (!options.bootstrap) {
    script(join(bin, "node"), "echo 24");
    script(join(bin, "npm"), `exec "$TEST_TEMPLATES/npm" "$@"`);
  }
  if (options.existing) script(join(bin, "agentklar"), `exec "$TEST_TEMPLATES/agentklar" "$@"`);
  const result = () => spawnSync("/bin/bash", [installer], { encoding: "utf8", timeout: 10000, env: {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, TEST_PREFIX: prefix, TEST_LOG: log,
    TEST_TEMPLATES: templates, TEST_BUSY: options.busy ? "yes" : "no", TEST_CORRUPT: options.corrupt || "",
    TEST_PLATFORM: options.platform || "Darwin",
    TEST_CONFLICT_PREFIX: options.conflictingPrefix ? "yes" : "no",
    ...(options.noOpen ? { AGENTKLAR_INSTALL_NO_OPEN: "1" } : {}),
    ...(options.conflictingPrefix ? { NPM_CONFIG_PREFIX: join(root, "unrelated-prefix") } : {}),
  } });
  return { root, home, prefix, runtime, result, calls: () => existsSync(log) ? readFileSync(log, "utf8") : "", close: () => rmSync(root, { recursive: true, force: true }) };
}

test("installer reuses Node24, checks the pinned release and opens managed setup", () => {
  const f = fixture();
  try {
    const result = f.result(); assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.match(calls, /https:\/\/github.com\/kaltstart-co\/agentklar\/releases\/download\/v0\.1\.0-beta\.28\/agentklar-0\.1\.0-beta\.28\.tgz/);
    assert.match(calls, /npm install -g --prefix .* --omit=dev --ignore-scripts --no-audit --no-fund/);
    assert.doesNotMatch(calls, /nodejs.org|tar /);
    assert.match(calls, /agentklar service install\nagentklar service start\nagentklar service open/);
    const launcher = readFileSync(join(f.home, ".local/bin/agentklar"), "utf8");
    assert.match(launcher, /export PATH=/); assert.match(launcher, /exec .*agentklar "\$@"/);
    assert.match(launcher, /export NPM_CONFIG_PREFIX=/);
    const again = f.result(); assert.equal(again.status, 0, again.stderr);
    assert.equal((f.calls().match(/npm install/g) || []).length, 1);
    assert.match(f.calls(), /agentklar update/);
  } finally { f.close(); }
});

test("desktop installer starts the managed service without opening an external browser", () => {
  const f = fixture({ noOpen: true });
  try {
    const result = f.result(); assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), /agentklar service install\nagentklar service start/);
    assert.doesNotMatch(f.calls(), /agentklar service open/);
  } finally { f.close(); }
});

test("private runtime pins install, updater and startup prefix despite conflicting npm environment", () => {
  const f = fixture({ bootstrap: true, conflictingPrefix: true });
  try {
    const first = f.result(); assert.equal(first.status, 0, first.stderr);
    const again = f.result(); assert.equal(again.status, 0, again.stderr);
    assert.equal((f.calls().match(/npm install/g) || []).length, 1);
    assert.ok(existsSync(join(f.runtime, "bin/agentklar")));
    assert.match(readFileSync(join(f.home, ".local/bin/agentklar"), "utf8"), /export NPM_CONFIG_PREFIX=.*node-v24/);
  } finally { f.close(); }
});

test("installer bootstraps checked official Node24 when Node/npm are absent", () => {
  const f = fixture({ bootstrap: true });
  try {
    const result = f.result(); assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), /https:\/\/nodejs.org\/dist\/v24\.21\.0\/node-v24\.21\.0-darwin-arm64.tar.gz/);
    assert.ok(existsSync(join(f.runtime, "bin/node")));
    assert.match(f.calls(), /agentklar service open/);
  } finally { f.close(); }
});

for (const corrupt of ["release", "runtime"]) test(`installer rejects a corrupt ${corrupt} before extraction or npm install`, () => {
  const f = fixture({ bootstrap: corrupt === "runtime", corrupt });
  try {
    const result = f.result(); assert.equal(result.status, 1); assert.match(result.stderr, /checksum failed/);
    assert.doesNotMatch(f.calls(), /npm install|tar |agentklar service/);
    if (corrupt === "runtime") assert.equal(existsSync(f.runtime), false);
  } finally { f.close(); }
});

test("installer preserves an existing app when its guarded update refuses active work", () => {
  const f = fixture({ existing: true, busy: true });
  try {
    const result = f.result(); assert.equal(result.status, 1); assert.match(result.stderr, /Active workers/);
    assert.equal(f.calls().trim(), "agentklar update");
    assert.equal(existsSync(join(f.home, ".local/bin/agentklar")), false);
  } finally { f.close(); }
});

for (const collision of ["file", "dangling symlink"] as const) test(`installer preserves an occupied launcher ${collision} before any setup`, () => {
  const f = fixture({ bootstrap: true });
  const launcher = join(f.home, ".local/bin/agentklar");
  const missing = join(f.root, "missing-target");
  try {
    mkdirSync(join(f.home, ".local/bin"), { recursive: true });
    if (collision === "file") writeFileSync(launcher, "existing unrelated file", { mode: 0o600 });
    else symlinkSync(missing, launcher);
    const result = f.result();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Move or repair it.*kept unchanged/);
    assert.equal(f.calls(), "");
    assert.equal(existsSync(f.runtime), false);
    if (collision === "file") assert.equal(readFileSync(launcher, "utf8"), "existing unrelated file");
    else assert.equal(readlinkSync(launcher), missing);
  } finally { f.close(); }
});

test("Linux starts in foreground and unsupported platforms do nothing", () => {
  for (const platform of ["Linux", "Windows_NT"]) {
    const f = fixture({ platform });
    try {
      const result = f.result();
      if (platform === "Linux") { assert.equal(result.status, 0, result.stderr); assert.match(f.calls(), /agentklar start\n$/); assert.doesNotMatch(f.calls(), /agentklar service/); }
      else { assert.equal(result.status, 1); assert.equal(f.calls(), ""); }
    } finally { f.close(); }
  }
});
