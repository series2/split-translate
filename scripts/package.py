#!/usr/bin/env python3
"""Build the single ZIP used for GitHub Releases and Chrome Web Store."""

import hashlib
import json
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
# Explicit allowlist: new runtime assets must be added here.
FILES = (
    "LICENSE",
    "manifest.json",
    "background.js",
    "compose.js",
    "content.css",
    "content.js",
    "scrollsync.js",
    "translate.js",
    "viewer.css",
    "viewer.html",
    "viewer.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
)


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", version):
        raise ValueError(f"Invalid manifest version: {version!r}")
    # Read everything first so missing files fail before writing an archive.
    entries = []
    for name in sorted(FILES):
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError(f"Refusing linked asset: {name}")
        entries.append((name, path.read_bytes()))

    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / f"split-translate-{version}.zip"
    with ZipFile(archive, "w") as package:
        for name, data in entries:
            # Stable ordering, timestamps and permissions for repeatable builds.
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            package.writestr(info, data, compresslevel=9)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_suffix(".zip.sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"Created {archive} ({len(entries)} files)")
    print(f"SHA-256: {digest}")
    print(f"Checksum: {checksum}")


if __name__ == "__main__":
    main()
