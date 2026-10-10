#!/usr/bin/env python3
"""Scan Mailtropy and build packages using an explicit runtime-file allowlist."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
RUNTIME_FILES = (
    "manifest.json", "popup.html", "privacy.html",
    "src/analytics.js", "src/background.js", "src/constants.js",
    "src/gmailClient.js", "src/popup.js", "src/storage.js", "src/styles.css",
    "src/scanProgress.js",
    "assets/icon.png", "assets/icon-16.png", "assets/icon-48.png", "assets/icon-128.png",
)


def scan(scanner, mode, target, *options):
    subprocess.run([
        scanner, mode, str(target), "--config", str(ROOT / ".gitleaks.toml"),
        "--redact", "--no-banner", "--ignore-gitleaks-allow", *options,
    ], cwd=ROOT, check=True)


def build(scanner):
    manifest = json.loads((ROOT / "manifest.json").read_text())
    version = manifest["version"]
    public_key = (ROOT / "scripts/extension-public-key.txt").read_text().strip()
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mailtropy-release-") as temporary:
        stage = Path(temporary)
        for filename in RUNTIME_FILES:
            source = ROOT / filename
            if source.is_symlink() or not source.is_file():
                raise ValueError(f"Missing file or unexpected symlink: {filename}")
            destination = stage / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        for kind in ("release", "test"):
            packaged_manifest = dict(manifest)
            if kind == "test":
                packaged_manifest["key"] = public_key
            else:
                packaged_manifest.pop("key", None)
            (stage / "manifest.json").write_text(json.dumps(packaged_manifest, indent=2) + "\n")
            scan(scanner, "dir", stage)
            filename = f"mailtropy-v{version}" + ("-test" if kind == "test" else "") + ".zip"
            # Build to a temporary file; a failed scan never replaces a package.
            archive_path = stage / "package.zip"
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for name in RUNTIME_FILES:
                    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    entry.external_attr = 0o100644 << 16
                    archive.writestr(entry, (stage / name).read_bytes())
            with zipfile.ZipFile(archive_path) as archive:
                assert set(archive.namelist()) == set(RUNTIME_FILES)
                assert archive.testzip() is None
            shutil.move(str(archive_path), str(dist / filename))
            print(f"Created {dist / filename}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "build"))
    parser.add_argument("--gitleaks", default="gitleaks", help="Gitleaks executable name or path")
    args = parser.parse_args()
    scanner = shutil.which(args.gitleaks)
    if not scanner:
        parser.error("Gitleaks is required. Install it with: brew install gitleaks")
    # Both commands fail if current files or any historical commit contain a detected secret.
    scan(scanner, "dir", ROOT)
    scan(scanner, "git", ROOT, "--log-opts=--all")
    if args.command == "build":
        build(scanner)
    else:
        print("Working files and Git history passed secret checks.")


if __name__ == "__main__":
    main()
