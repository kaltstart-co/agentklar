#!/usr/bin/env python3
"""Prepare a local CSR or import its Apple-issued certificate. Run by the owner."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def signing_directory(home):
    return Path(home) / ".agentklar/signing/developer-id"


def run(*command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def create_request(home):
    directory = signing_directory(home)
    # Refuse any existing directory: never replace a prior private key or CSR.
    for ancestor in (directory.parent, directory.parent.parent):
        if ancestor.is_symlink():
            raise ValueError("Signing folders must not be symbolic links.")
    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.mkdir(mode=0o700)
    key = directory / "private-key.pem"
    request = directory / "request.csr"
    key.touch(mode=0o600, exist_ok=False)
    try:
        run("openssl", "genrsa", "-out", str(key), "2048")
        key.chmod(0o600)
        run("openssl", "req", "-new", "-key", str(key), "-out", str(request), "-subj", "/CN=AgentKlar Developer ID/")
        request.chmod(0o600)
    except BaseException:
        # Retain any generated key for the owner; never retry by overwriting it.
        raise
    print("Upload this public certificate request in Apple's Developer portal:", request)
    print("Keep private-key.pem on this Mac. Do not upload or share it.")
    return request


def import_certificate(home, certificate):
    directory = signing_directory(home)
    key = directory / "private-key.pem"
    if directory.is_symlink() or key.is_symlink() or not key.is_file():
        raise ValueError("The original local CSR private key is missing or unsafe.")
    if directory.stat().st_mode & 0o077 or key.stat().st_mode & 0o077:
        raise ValueError("Signing directory must be 0700 and the private key 0600.")
    with tempfile.TemporaryDirectory(prefix="certificate-import-", dir=directory) as temporary:
        work = Path(temporary)
        pem = work / "certificate.pem"
        for encoding in ("DER", "PEM"):
            result = subprocess.run(["openssl", "x509", "-inform", encoding, "-in", str(certificate), "-out", str(pem)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                break
        else:
            raise ValueError("Choose the Developer ID Application certificate downloaded from Apple.")
        subject = run("openssl", "x509", "-in", str(pem), "-noout", "-subject", capture_output=True, text=True).stdout
        if "Developer ID Application:" not in subject:
            raise ValueError("This is not a Developer ID Application certificate.")
        # Compare public keys only; private key contents are never printed.
        cert_public = run("openssl", "x509", "-in", str(pem), "-noout", "-pubkey", capture_output=True).stdout
        key_public = run("openssl", "pkey", "-in", str(key), "-pubout", capture_output=True).stdout
        if cert_public != key_public:
            raise ValueError("Certificate does not match this Mac's original CSR key.")
        bundle = work / "identity.p12"
        print("Enter a temporary export password in the terminal, then the same password in the secure Keychain import dialog.")
        # OpenSSL prompts in the terminal; Keychain uses its secure dialog. No password enters argv, files, or chat.
        run("openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(pem), "-out", str(bundle))
        bundle.chmod(0o600)
        run("security", "import", str(bundle), "-k", str(Path(home) / "Library/Keychains/login.keychain-db"), "-T", "/usr/bin/codesign")
    run("security", "find-identity", "-v", "-p", "codesigning")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("create-csr", help="Create a new private key and public CSR; refuses an existing signing folder")
    importer = commands.add_parser("import-certificate", help="Import the Apple certificate paired with the CSR key; terminal prompts for passwords")
    importer.add_argument("certificate", type=Path)
    args = parser.parse_args()
    # Restrictive permissions also cover key creation and temporary files.
    os.umask(0o077)
    try:
        if args.action == "create-csr":
            create_request(Path.home())
        else:
            if not os.isatty(0):
                raise ValueError("Run certificate import yourself in an interactive terminal.")
            import_certificate(Path.home(), args.certificate.resolve())
    except (ValueError, FileExistsError) as error:
        raise SystemExit(str(error))

if __name__ == "__main__":
    main()
