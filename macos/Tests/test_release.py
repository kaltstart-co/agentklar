"""Offline release gates; no signing credentials, Apple services or downloads."""
import base64
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from release import release_configuration, signing_preflight, validate_feed, DOWNLOAD_URL
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
            xml = f'<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>39</sparkle:version><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><enclosure url="{DOWNLOAD_URL}{archive.name}" length="7" sparkle:edSignature="{signature}" /></item></channel></rss>'
            feed.write_text(xml)
            self.assertEqual(validate_feed(feed, archive, "39"), signature)
            for changed in (xml.replace('length="7"', 'length="8"'), xml.replace('>39<', '>38<'), xml.replace(signature, "bad"), xml.replace(DOWNLOAD_URL, "http://evil.example/")):
                feed.write_text(changed)
                with self.assertRaises(ValueError):
                    validate_feed(feed, archive, "39")

if __name__ == "__main__":
    unittest.main()
