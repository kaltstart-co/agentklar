#!/usr/bin/env python3
"""Build the native Mac app with standard Apple tools. Public builds require signing."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import subprocess
import tempfile
import tarfile
import urllib.request

root = Path(__file__).resolve().parents[2]
package = root / "macos"
version = json.loads((root / "package.json").read_text())["version"]
build = re.fullmatch(r"0\.1\.0-beta\.(\d+)", version)
if not build:
    raise SystemExit("Define the Mac build number for this release before packaging.")
options = argparse.ArgumentParser()
options.add_argument("--signed", action="store_true")
args = options.parse_args()
identity = os.environ.get("AGENTKLAR_SIGN_IDENTITY")
public_key = os.environ.get("AGENTKLAR_SPARKLE_PUBLIC_KEY", "")
notary_profile = os.environ.get("AGENTKLAR_NOTARY_PROFILE")
if args.signed and (not identity or not notary_profile or len(base64.b64decode(public_key, validate=True)) != 32):
    raise SystemExit("Signed releases need Developer ID, notarization profile and Sparkle public key.")

if os.uname().machine != "arm64":
    raise SystemExit("This packaging target is Apple Silicon. Intel packaging needs its own verification.")

def run(*command):
    subprocess.run(command, check=True)

def extract_node_tools(archive_path, destination, folder_name):
    """Copy only regular Node/npm files; compatible with the system Python 3.9."""
    seen = set()
    total = 0
    with tarfile.open(archive_path) as archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != folder_name:
                continue
            relative = parts[1:]
            needed = relative in (("bin", "node"), ("LICENSE",)) or relative[:3] == ("lib", "node_modules", "npm")
            if not needed:
                continue
            if ".." in parts or member.name.startswith("/"):
                raise SystemExit("Official Node archive contains an unsafe path.")
            # npm's command links are unnecessary: execute npm-cli.js directly.
            if not member.isdir() and not member.isfile():
                continue
            if member.name in seen or len(seen) >= 50000:
                raise SystemExit("Official Node archive has duplicate or excessive entries.")
            seen.add(member.name)
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            total += member.size
            if member.size < 0 or member.size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024:
                raise SystemExit("Official Node files exceeded their size limit.")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit("Official Node archive contains an unreadable file.")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)

sdk = Path("/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk")
sdk_flags = ["--sdk", str(sdk)] if sdk.is_dir() else []
run("swift", "build", "--package-path", str(package), "--build-system", "native", "-c", "release", *sdk_flags)
out = package / "out"
out.mkdir(exist_ok=True)
app = out / "AgentKlar.app"
if app.exists():
    shutil.rmtree(app)
contents = app / "Contents"
resources = contents / "Resources"
macos = contents / "MacOS"
frameworks = contents / "Frameworks"
for folder in (resources, macos, frameworks):
    folder.mkdir(parents=True, exist_ok=True)
shutil.copy2(package / ".build/release/AgentKlar", macos / "AgentKlar")
sparkle = list((package / ".build/artifacts").glob("**/macos-arm64_x86_64/Sparkle.framework"))
if len(sparkle) != 1:
    raise SystemExit("Expected one pinned Sparkle Mac framework.")
shutil.copytree(sparkle[0], frameworks / "Sparkle.framework", symlinks=True)
shutil.copytree(root / "web/public/harness-icons", resources / "harness-icons")
for file in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
    shutil.copy2(root / file, resources / file)
# Build-time tools are bundled; first launch needs no npm, system Node or network.
node_version = "24.21.0"
node_digest = "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
runtime = resources / "runtime"
runtime.mkdir()
with tempfile.TemporaryDirectory(prefix="agentklar-app-runtime-") as folder:
    work = Path(folder)
    archive_path = work / "node.tar.gz"
    url = f"https://nodejs.org/dist/v{node_version}/node-v{node_version}-darwin-arm64.tar.gz"
    with urllib.request.urlopen(url, timeout=30) as response, archive_path.open("wb") as target:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 80 * 1024 * 1024:
                raise SystemExit("Official Node archive exceeded its size limit.")
            target.write(chunk)
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != node_digest:
        raise SystemExit("Official Node archive checksum differs.")
    extract_node_tools(archive_path, work, f"node-v{node_version}-darwin-arm64")
    node_root = work / f"node-v{node_version}-darwin-arm64"
    node = node_root / "bin/node"
    npm = node_root / "lib/node_modules/npm/bin/npm-cli.js"
    environment = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""))
    subprocess.run([str(node), str(npm), "run", "build"], cwd=root, env=environment, check=True)
    service = runtime / "agentklar"
    service.mkdir()
    for name in ("package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"):
        shutil.copy2(root / name, service / name)
    for name in ("bin", "dist", "skills"):
        shutil.copytree(root / name, service / name)
    subprocess.run([str(node), str(npm), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service, env=environment, check=True)
    shutil.rmtree(service / "node_modules/.bin", ignore_errors=True)
    (runtime / "bin").mkdir()
    shutil.copy2(node, runtime / "bin/node")
    shutil.copy2(node_root / "LICENSE", runtime / "NODE_LICENSE")

def runtime_manifest():
    files = {}
    for path in sorted(runtime.rglob("*")):
        if path.is_symlink():
            raise SystemExit("Bundled service contains an unsupported symlink.")
        if path.is_file():
            files[path.relative_to(runtime).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    data = json.dumps({"version": version, "nodeVersion": node_version, "dataCompatibility": 1, "files": files}, separators=(",", ":")).encode()
    (resources / "runtime-manifest.json").write_bytes(data)
    return hashlib.sha256(data).hexdigest()

runtime_hash = runtime_manifest()
png = out / "AgentKlar.png"
run("swift", str(package / "scripts/icon.swift"), str(png))
iconset = out / "AgentKlar.iconset"
iconset.mkdir(exist_ok=True)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        run("sips", "-z", str(size * scale), str(size * scale), str(png), "--out", str(iconset / f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"))
run("iconutil", "-c", "icns", str(iconset), "-o", str(resources / "AgentKlar.icns"))
info = {
    "CFBundleIdentifier": "co.kaltstart.agentklar",
    "CFBundleName": "AgentKlar",
    "CFBundleDisplayName": "AgentKlar",
    "CFBundleExecutable": "AgentKlar",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "0.1.0",
    "CFBundleVersion": build.group(1),
    "CFBundleIconFile": "AgentKlar.icns",
    "AgentKlarReleaseVersion": version,
    "AgentKlarRuntimeManifestSHA256": runtime_hash,
    "LSMinimumSystemVersion": "14.0",
    "LSApplicationCategoryType": "public.app-category.developer-tools",
    "NSHighResolutionCapable": True,
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    "AgentKlarSignedRelease": args.signed,
    "SUFeedURL": "https://agentklar-seven.vercel.app/appcast.xml",
    "SUEnableAutomaticChecks": args.signed,
    "SUAutomaticallyUpdate": False,
    "SUAllowsAutomaticUpdates": False,
    "SUSendProfileInfo": False,
    "SUShowReleaseNotes": False,
    "SURequireSignedFeed": True,
    "SUVerifyUpdateBeforeExtraction": True,
}
if args.signed:
    info["SUPublicEDKey"] = public_key
with (contents / "Info.plist").open("wb") as target:
    plistlib.dump(info, target)
if args.signed:
    # Sign nested helpers before their enclosing framework and app.
    nested = [p for base in (frameworks / "Sparkle.framework", runtime) for p in base.rglob("*") if p.is_file() and not p.is_symlink() and p.read_bytes()[:4] in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf")]
    for path in sorted(nested, key=lambda p: len(p.parts), reverse=True):
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(path))
    for path in sorted((frameworks / "Sparkle.framework").rglob("*.xpc"), key=lambda p: len(p.parts), reverse=True):
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(path))
    for path in sorted((frameworks / "Sparkle.framework").rglob("*.app"), key=lambda p: len(p.parts), reverse=True):
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(path))
    run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(frameworks / "Sparkle.framework"))
    info["AgentKlarRuntimeManifestSHA256"] = runtime_manifest()
    with (contents / "Info.plist").open("wb") as target:
        plistlib.dump(info, target)
    run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(app))
else:
    run("codesign", "--force", "--sign", "-", str(app))
run("codesign", "--verify", "--deep", "--strict", str(app))
archive = out / f"AgentKlar-{version}-arm64.zip"
if archive.exists():
    archive.unlink()
run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive))
if args.signed:
    run("xcrun", "notarytool", "submit", str(archive), "--keychain-profile", notary_profile, "--wait")
    run("xcrun", "stapler", "staple", str(app))
    archive.unlink()
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive))
image_folder = out / "image"
if image_folder.exists():
    shutil.rmtree(image_folder)
image_folder.mkdir()
shutil.copytree(app, image_folder / "AgentKlar.app", symlinks=True)
(image_folder / "Applications").symlink_to("/Applications")
dmg = out / f"AgentKlar-{version}-arm64.dmg"
if dmg.exists():
    dmg.unlink()
run("hdiutil", "create", "-volname", "AgentKlar", "-srcfolder", str(image_folder), "-format", "UDZO", str(dmg))
if args.signed:
    run("codesign", "--timestamp", "--sign", identity, str(dmg))
    run("xcrun", "notarytool", "submit", str(dmg), "--keychain-profile", notary_profile, "--wait")
    run("xcrun", "stapler", "staple", str(dmg))
print(f"Native SwiftUI app built: {app}. Signed public release: {args.signed}.")
