"""Local release gates. Never publishes artifacts or reads private signing keys."""
import base64
import binascii
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4
import xml.etree.ElementTree as ET

FEED_URL = "https://agentklar-seven.vercel.app/appcast.xml"
DOWNLOAD_URL = "https://agentklar-seven.vercel.app/downloads/"
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"


def release_configuration(environment):
    identity = environment.get("AGENTKLAR_SIGN_IDENTITY", "")
    profile = environment.get("AGENTKLAR_NOTARY_PROFILE", "")
    public_key = environment.get("AGENTKLAR_SPARKLE_PUBLIC_KEY", "")
    try:
        valid_key = len(base64.b64decode(public_key, validate=True)) == 32
    except (ValueError, binascii.Error):
        valid_key = False
    missing = []
    if not identity.startswith("Developer ID Application:"):
        missing.append("AGENTKLAR_SIGN_IDENTITY (Developer ID Application identity)")
    if not profile:
        missing.append("AGENTKLAR_NOTARY_PROFILE (existing notarytool keychain profile)")
    if not valid_key:
        missing.append("AGENTKLAR_SPARKLE_PUBLIC_KEY (32-byte base64 public key)")
    if missing:
        raise ValueError("Signed release needs: " + ", ".join(missing))
    return identity, profile, public_key


def signing_preflight(environment):
    identity, profile, public_key = release_configuration(environment)
    identities = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], check=True, capture_output=True, text=True).stdout
    if ('"' + identity + '"') not in identities:
        raise ValueError("Configured Developer ID Application identity is not available in this keychain.")
    account = environment.get("AGENTKLAR_SPARKLE_ACCOUNT", "ed25519")
    # Metadata lookup only: never use -w/-g, which expose secret key material.
    key = subprocess.run(["security", "find-generic-password", "-s", "https://sparkle-project.org", "-a", account], capture_output=True)
    if key.returncode:
        raise ValueError("Sparkle signing key is unavailable in this keychain (account: " + account + ").")
    tool = Path(__file__).resolve().parents[1] / ".build/artifacts/sparkle/Sparkle/bin/generate_keys"
    result = subprocess.run([str(tool), "--account", account, "-p"], check=True, capture_output=True, text=True)
    if result.stdout.strip() != public_key:
        raise ValueError("Configured Sparkle public key does not match this keychain account.")
    return identity, profile, public_key


def validate_feed(feed, archive, build):
    tree = ET.parse(feed)
    items = tree.findall("./channel/item")
    current = [item for item in items if item.findtext(SPARKLE + "version") == str(build)]
    if len(current) != 1:
        raise ValueError("Appcast must contain exactly one entry for this build.")
    item = current[0]
    enclosure = item.find("enclosure")
    if enclosure is None or enclosure.get("url") != DOWNLOAD_URL + archive.name:
        raise ValueError("Appcast archive URL does not match this release.")
    if enclosure.get("length") != str(archive.stat().st_size):
        raise ValueError("Appcast archive size does not match this release.")
    try:
        signature = base64.b64decode(enclosure.get(SPARKLE + "edSignature", ""), validate=True)
    except (ValueError, binascii.Error):
        signature = b""
    if len(signature) != 64:
        raise ValueError("Appcast needs a valid EdDSA archive signature.")
    if item.findtext(SPARKLE + "minimumSystemVersion") not in ("14.0", "14.0.0"):
        raise ValueError("Appcast minimum macOS version differs from this app.")
    if item.findtext(SPARKLE + "hardwareRequirements") != "arm64":
        raise ValueError("Appcast must require Apple Silicon for this archive.")
    return enclosure.get(SPARKLE + "edSignature")


def prepare_feed(package, out, archive, dmg, build, environment):
    import shutil
    # Build and verify privately first. A failure leaves the previous release intact.
    with tempfile.TemporaryDirectory(prefix="signed-release-", dir=out) as temporary:
        staging = Path(temporary) / "release"
        updates = staging / "downloads"
        updates.mkdir(parents=True)
        copied = updates / archive.name
        shutil.copy2(archive, copied)
        tools = package / ".build/artifacts/sparkle/Sparkle/bin"
        account = environment.get("AGENTKLAR_SPARKLE_ACCOUNT", "ed25519")
        feed = staging / "appcast.xml"
        subprocess.run([str(tools / "generate_appcast"), "--account", account, "--download-url-prefix", DOWNLOAD_URL, "--maximum-deltas", "0", "-o", str(feed), str(updates)], check=True)
        signature = validate_feed(feed, copied, build)
        subprocess.run([str(tools / "sign_update"), "--account", account, "--verify", str(copied), signature], check=True)
        subprocess.run([str(tools / "sign_update"), "--account", account, str(feed)], check=True)
        subprocess.run([str(tools / "sign_update"), "--account", account, "--verify", str(feed)], check=True)
        shutil.copy2(dmg, updates / dmg.name)
        checksums = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (copied, updates / dmg.name, feed)}
        (staging / "release.json").write_text(json.dumps({"build": str(build), "feedURL": FEED_URL, "sha256": checksums}, indent=2) + "\n")
        destination = out / "signed-release"
        previous = out / ("signed-release-previous-" + uuid4().hex)
        if destination.exists():
            destination.rename(previous)
        try:
            staging.rename(destination)
        except BaseException:
            if previous.exists():
                previous.rename(destination)
            raise
        return destination
