#!/usr/bin/env python3
"""Test a packaged app runtime in a new private profile; never uses a global CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("app", type=Path)
parser.add_argument("--report", type=Path)
args = parser.parse_args()
app = args.app.resolve(strict=True)
root = Path(__file__).resolve().parents[1]
work = Path(tempfile.mkdtemp(prefix="agentklar-bundled-acceptance-", dir="/private/tmp")).resolve()
home = work / "home"
service_home = home / "service"
home.mkdir(mode=0o700)
(home / "fixture-project").mkdir(mode=0o700)
for folder in ("codex", "claude"):
    (home / folder).mkdir(mode=0o700)
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
env = {"HOME": str(home), "AGENTKLAR_HOME": str(service_home), "AGENTKLAR_PORT": str(port),
       "PATH": "/usr/bin:/bin", "CODEX_HOME": str(home / "codex"), "CLAUDE_CONFIG_DIR": str(home / "claude"),
       "LANG": "en_US.UTF-8", "TMPDIR": str(work)}
runner = work / "acceptance"
report = {"app": str(app), "privateProfile": str(home), "phases": [], "cleanup": False,
          "scope": "Packaged runtime and native client first launch/reopen on this Mac; no clean hardware, signing or Gatekeeper claim"}
try:
    sdk = os.environ.get("SDKROOT", "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk")
    sources = [root / "Sources/AgentKlar" / name for name in ("JSON.swift", "LocalRuntime.swift", "AgentKlarClient.swift")]
    subprocess.run(["swiftc", "-sdk", sdk, "-target", "arm64-apple-macos14.0", "-swift-version", "5", "-parse-as-library",
                    *map(str, sources), str(root / "Tests/LocalChecks/BundledAcceptance.swift"), "-o", str(runner)], check=True, timeout=90)
    journal_before = None
    for phase in ("first", "reopen"):
        result = subprocess.run([str(runner), str(app), str(home), phase], env=env, cwd=home,
                                capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise RuntimeError(f"{phase} acceptance failed (exit {result.returncode}); output retained only inside private profile")
        phase_report = json.loads(result.stdout.strip().splitlines()[-1])
        report["phases"].append(phase_report)
        journal = json.loads((service_home / "launchd-install.json").read_text())
        if journal["home"] != str(service_home):
            raise RuntimeError("Install escaped private service home")
        if journal_before is not None and journal != journal_before:
            raise RuntimeError("Reopen changed service install identity")
        journal_before = journal
        plist = home / "Library/LaunchAgents" / (journal["label"] + ".plist")
        data = plist.read_bytes()
        if hashlib.sha256(data).hexdigest() != journal["plistHash"]:
            raise RuntimeError("Managed plist changed unexpectedly")
        startup = plistlib.loads(data)
        if startup["EnvironmentVariables"].get("HOME") != str(home):
            raise RuntimeError("Launched service did not retain private HOME")
        if startup["ProgramArguments"][0] != str(Path(phase_report["launcher"]).parents[2] / "bin/node"):
            raise RuntimeError("Service did not use the copied bundled Node")
    report["passed"] = True
finally:
    journal_file = service_home / "launchd-install.json"
    if journal_file.exists():
        journal = json.loads(journal_file.read_text())
        label = "com.agentklar.local." + hashlib.sha256(str(service_home).encode()).hexdigest()[:16]
        if journal.get("home") != str(service_home) or journal.get("label") != label:
            raise RuntimeError("Cleanup ownership mismatch; private profile kept")
        target = f"gui/{os.getuid()}/{label}"
        subprocess.run(["/bin/launchctl", "bootout", target], capture_output=True)
        deadline = time.monotonic() + 10
        while subprocess.run(["/bin/launchctl", "print", target], capture_output=True).returncode == 0:
            if time.monotonic() >= deadline:
                raise RuntimeError("Owned test service did not stop; private profile kept")
            time.sleep(0.1)
    report["cleanup"] = True
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    shutil.rmtree(work)
print(json.dumps(report, indent=2))
