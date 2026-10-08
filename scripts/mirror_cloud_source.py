#!/usr/bin/env python3
"""Prepare a public source-only cloud/ mirror. Dry-run unless --write is given.

Only the explicit file and directory/extension allowlists below are read. Runtime
configuration, credentials, local databases, attachments, and build output are
never opened or copied. Run after the cloud source has passed its final tests.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile


ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {
    "README.md",
    "package.json", "package-lock.json", "next.config.ts", "vite.config.ts",
    "drizzle.config.ts", "eslint.config.mjs", "postcss.config.mjs",
    "tsconfig.json", "cloudflare-env.d.ts", "components.json",
}
# This is an inclusion policy, not a broad copy followed by deletions.
TREE_EXTENSIONS = {
    "app": {".ts", ".tsx", ".css"},
    "build": {".ts", ".mjs", ".LICENSE"},
    "components": {".tsx"},
    "db": {".ts"},
    "hooks": {".ts", ".tsx"},
    "lib": {".ts", ".mts"},
    "public": {".js", ".css", ".svg"},
    "scripts": {".mjs", ".sh"},
    "tests": {".mjs", ".py"},
    "tools": {".py"},
    "vendor": {".css", ".md"},
}
MIGRATION_FILES = {
    "drizzle/0000_lean_supreme_intelligence.sql",
    "drizzle/meta/0000_snapshot.json", "drizzle/meta/_journal.json",
}
BLOCKED_PARTS = {"node_modules", "dist", "data", "private", "outputs", "work", "__pycache__"}
PRIVATE_PATTERNS = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}"),
    re.compile(rb"/Users/[A-Za-z0-9_. -]+/"),
]
PUBLIC_IGNORE = """node_modules/
dist/
.next/
.vinext/
.wrangler/
.sites-runtime/
.agents/
.codex/
.env*
.dev.vars*
.npmrc
data/
private/
outputs/
work/
__pycache__/
*.pyc
*.tsbuildinfo
*.log
.DS_Store
"""

def allowed(relative: Path) -> bool:
    if any(part.startswith(".") or part in BLOCKED_PARTS for part in relative.parts):
        return False
    value = relative.as_posix()
    return (value in ROOT_FILES or value in MIGRATION_FILES
            or (len(relative.parts) > 1 and relative.parts[0] in TREE_EXTENSIONS
                and relative.suffix in TREE_EXTENSIONS[relative.parts[0]]))


def source_plan(source: Path) -> dict[str, bytes]:
    source = source.resolve(strict=True)
    files = {}
    for directory in sorted(TREE_EXTENSIONS):
        base = source / directory
        if base.is_symlink():
            raise ValueError(f"Refusing symlink: {directory}")
        if base.is_dir():
            for path in sorted(base.rglob("*")):
                relative = path.relative_to(source)
                if path.is_symlink():
                    raise ValueError(f"Refusing symlink: {relative}")
                if path.is_file() and allowed(relative):
                    files[relative.as_posix()] = path.read_bytes()
    for name in sorted(ROOT_FILES | MIGRATION_FILES):
        path = source / name
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != source):
            raise ValueError(f"Refusing symlink: {name}")
        if not path.is_file():
            raise ValueError(f"Required public source missing: {name}")
        files[name] = path.read_bytes()
    for name, body in files.items():
        if any(pattern.search(body) for pattern in PRIVATE_PATTERNS):
            raise ValueError(f"Potential private material in allowed source: {name}; review before publishing")
    files[".gitignore"] = PUBLIC_IGNORE.encode()
    files[".openai/hosting.json"] = b'{"d1":"DB","r2":"BUCKET"}\n'
    files["next-env.d.ts"] = b'/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n'
    checksums = {name: hashlib.sha256(body).hexdigest() for name, body in sorted(files.items())}
    files["SOURCE_MANIFEST.json"] = (json.dumps({"schema": 1, "files": checksums}, indent=2) + "\n").encode()
    return files


def write_mirror(files: dict[str, bytes], destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise ValueError("Destination already exists; inspect it before replacing a previous source mirror")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".cloud-source-", dir=destination.parent))
    try:
        for name, body in sorted(files.items()):
            path = temp / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        temp.rename(destination)
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "renrob-cloud")
    parser.add_argument("--write", action="store_true", help="Write cloud/ after final cloud tests pass")
    args = parser.parse_args()
    try:
        files = source_plan(args.source)
        print(f"Public source allowlist: {len(files)} files, {sum(map(len, files.values())):,} bytes")
        if args.write:
            write_mirror(files, ROOT / "cloud")
            print("Prepared cloud/ locally. No Git commit, upload, or deployment performed.")
        else:
            print("Dry-run only. No files copied. Rerun --write after final cloud verification.")
    except (OSError, ValueError) as error:
        parser.exit(2, f"Source preparation stopped: {error}\n")


if __name__ == "__main__":
    main()
