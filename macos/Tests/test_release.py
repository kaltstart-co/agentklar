"""Offline release gates; no signing credentials, Apple services or downloads."""
import base64
import hashlib
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from release import release_configuration, signing_preflight, validate_feed, DOWNLOAD_URL, prepare_feed
from developer_id import create_request, signing_directory

class ReleaseChecks(unittest.TestCase):
    def config(self):
        return {"AGENTKLAR_SIGN_IDENTITY": "Developer ID Application: Example (TEAM)", "AGENTKLAR_NOTARY_PROFILE": "existing-profile", "AGENTKLAR_SPARKLE_PUBLIC_KEY": base64.b64encode(bytes(32)).decode()}

    def test_csr_refuses_existing_keys_and_preserves_permissions(self):
        with tempfile.TemporaryDirectory() as home:
            def create_fixture(*command):
                Path(command[command.index("-out") + 1]).touch(exist_ok=True)
            with patch("developer_id.run", side_effect=create_fixture) as run:
                request = create_request(home)
                directory = signing_directory(home)
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual((directory / "private-key.pem").stat().st_mode & 0o777, 0o600)
                self.assertIn("2048", run.call_args_list[0].args)
                (directory / "private-key.pem").write_text("existing-key-fixture")
                with self.assertRaises(FileExistsError):
                    create_request(home)
                self.assertEqual((directory / "private-key.pem").read_text(), "existing-key-fixture")
                self.assertEqual(run.call_count, 2)

    def test_csr_rejects_symlink_signing_directory(self):
        with tempfile.TemporaryDirectory() as home:
            base = Path(home) / ".agentklar"
            base.mkdir()
            (base / "signing").symlink_to(Path(home))
            with self.assertRaisesRegex(ValueError, "symbolic"):
                create_request(home)

    def test_missing_and_malformed_credentials_fail_before_build(self):
        for key in self.config():
            config = self.config()
            config[key] = ""
            with self.assertRaisesRegex(ValueError, key):
                release_configuration(config)
        for value in ("not base64", "YQ=="):
            config = self.config()
            config["AGENTKLAR_SPARKLE_PUBLIC_KEY"] = value
            with self.assertRaisesRegex(ValueError, "PUBLIC_KEY"):
                release_configuration(config)
        config = self.config()
        config["AGENTKLAR_SIGN_IDENTITY"] = "-"
        with self.assertRaisesRegex(ValueError, "Developer ID"):
            release_configuration(config)

    def test_unavailable_identity_fails_without_accessing_signing_key(self):
        with patch("release.subprocess.run") as run:
            run.return_value.stdout = "0 valid identities found"
            with self.assertRaisesRegex(ValueError, "not available"):
                signing_preflight(self.config())
            self.assertEqual(run.call_count, 1)

    def test_key_lookup_is_metadata_only(self):
        with patch("release.subprocess.run") as run:
            run.side_effect = [SimpleNamespace(stdout='"Developer ID Application: Example (TEAM)"'),
                               SimpleNamespace(returncode=0), SimpleNamespace(stdout=self.config()["AGENTKLAR_SPARKLE_PUBLIC_KEY"])]
            signing_preflight(self.config())
            command = run.call_args_list[1].args[0]
            self.assertEqual(command[:2], ["security", "find-generic-password"])
            self.assertFalse(set(command) & {"-g", "-w"})
            self.assertEqual(run.call_args.args[0][-1], "-p")

    def test_configured_update_public_key_must_match_keychain_account(self):
        with patch("release.subprocess.run") as run:
            run.side_effect = [SimpleNamespace(stdout='"Developer ID Application: Example (TEAM)"'),
                               SimpleNamespace(returncode=0), SimpleNamespace(stdout=base64.b64encode(bytes([1]) * 32).decode())]
            with self.assertRaisesRegex(ValueError, "does not match"):
                signing_preflight(self.config())

    def test_feed_rejects_wrong_archive_size_version_and_signature(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / "AgentKlar.zip"
            archive.write_bytes(b"archive")
            feed = Path(folder) / "appcast.xml"
            signature = base64.b64encode(bytes(64)).decode()
            xml = f'<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>39</sparkle:version><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="{DOWNLOAD_URL}{archive.name}" length="7" sparkle:edSignature="{signature}" /></item></channel></rss>'
            feed.write_text(xml)
            self.assertEqual(validate_feed(feed, archive, "39"), signature)
            for changed in (xml.replace('length="7"', 'length="8"'), xml.replace('>39<', '>38<'), xml.replace(signature, "bad"), xml.replace(DOWNLOAD_URL, "http://evil.example/"), xml.replace(">arm64<", ">x86_64<"), xml.replace("<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>", "")):
                feed.write_text(changed)
                with self.assertRaises(ValueError):
                    validate_feed(feed, archive, "39")

    def test_failed_feed_preparation_keeps_previous_verified_release(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            previous = out / "signed-release"
            previous.mkdir()
            (previous / "appcast.xml").write_text("previous signed feed fixture")
            (previous / "release.json").write_text("previous checksums fixture")
            archive = out / "AgentKlar.zip"
            archive.write_bytes(b"archive")
            dmg = out / "AgentKlar.dmg"
            dmg.write_bytes(b"image")
            with patch("release.subprocess.run", side_effect=subprocess.CalledProcessError(1, "generate_appcast")):
                with self.assertRaises(subprocess.CalledProcessError):
                    prepare_feed(out, out, archive, dmg, "40", {})
            self.assertEqual((previous / "appcast.xml").read_text(), "previous signed feed fixture")
            self.assertEqual((previous / "release.json").read_text(), "previous checksums fixture")
            self.assertEqual(sorted(p.name for p in out.iterdir()), ["AgentKlar.dmg", "AgentKlar.zip", "signed-release"])

    def test_successful_feed_is_verified_before_replacing_previous_output(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            previous = out / "signed-release"
            previous.mkdir()
            (previous / "appcast.xml").write_text("previous signed feed fixture")
            archive = out / "AgentKlar.zip"
            archive.write_bytes(b"archive")
            dmg = out / "AgentKlar.dmg"
            dmg.write_bytes(b"image")
            signature = base64.b64encode(bytes(64)).decode()
            commands = []
            def simulate_tools(command, **kwargs):
                commands.append(command)
                # Verification must finish while the previous reviewed output is intact.
                self.assertEqual((previous / "appcast.xml").read_text(), "previous signed feed fixture")
                if Path(command[0]).name == "generate_appcast":
                    feed = Path(command[command.index("-o") + 1])
                    feed.write_text(f'<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>40</sparkle:version><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="{DOWNLOAD_URL}{archive.name}" length="7" sparkle:edSignature="{signature}" /></item></channel></rss>')
                return SimpleNamespace(returncode=0)
            with patch("release.subprocess.run", side_effect=simulate_tools):
                staged = prepare_feed(out, out, archive, dmg, "40", {})
            self.assertEqual(staged, previous)
            self.assertEqual(len(commands), 4)
            self.assertIn("--verify", commands[1])
            self.assertIn("--verify", commands[3])
            saved = list(out.glob("signed-release-previous-*"))
            self.assertEqual(len(saved), 1)
            self.assertEqual((saved[0] / "appcast.xml").read_text(), "previous signed feed fixture")
            manifest = json.loads((staged / "release.json").read_text())
            for name, digest in manifest["sha256"].items():
                target = staged / name if name == "appcast.xml" else staged / "downloads" / name
                self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), digest)

if __name__ == "__main__":
    unittest.main()
