#!/usr/bin/env python3
"""Build the native Mac app with standard Apple tools. Public builds require signing."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess

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
installer = (root / "web/public/install.sh").read_bytes()
if b"AGENTKLAR_INSTALL_NO_OPEN" not in installer:
    raise SystemExit("Installer must keep setup inside the native app.")
(resources / "install.sh").write_bytes(installer)
(resources / "install.sha256").write_text(hashlib.sha256(installer).hexdigest() + "\n")
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
    nested = [p for p in (frameworks / "Sparkle.framework").rglob("*") if p.is_file() and not p.is_symlink() and p.read_bytes()[:4] in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf")]
    for path in sorted(nested, key=lambda p: len(p.parts), reverse=True):
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(path))
    for path in sorted((frameworks / "Sparkle.framework").rglob("*.xpc"), key=lambda p: len(p.parts), reverse=True):
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(path))
    for path in sorted((frameworks / "Sparkle.framework").rglob("*.app"), key=lambda p: len(p.parts), reverse=True):
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(path))
    run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(frameworks / "Sparkle.framework"))
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
