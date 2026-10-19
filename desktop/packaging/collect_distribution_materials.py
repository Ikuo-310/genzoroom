"""Collect package notices and a reproducible source snapshot for the installer."""
from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[2]
NOTICE_NAMES = ("license", "licence", "copying", "notice", "copyright")
SKIP_PARTS = {".git", ".venv", "node_modules", "dist", "target", "out", "__pycache__", ".pytest_cache"}


def safe_part(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._+-]", "_", value)


def copy_notice_files(source: Path, destination: Path) -> list[str]:
    copied = []
    for candidate in source.iterdir() if source.is_dir() else ():
        if not candidate.is_file() or not any(token in candidate.name.lower() for token in NOTICE_NAMES):
            continue
        if candidate.suffix.lower() not in ("", ".txt", ".md", ".rtf", ".html"):
            continue
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / candidate.name
        if target.exists() and target.read_bytes() != candidate.read_bytes():
            target = destination / f"{candidate.stem}-{len(copied)}{candidate.suffix}"
        if not target.exists():
            shutil.copyfile(candidate, target)
        copied.append(target.name)
    return copied


def package_inventory(output: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    python_lock = (ROOT / "desktop/packaging/runtime.lock").read_text(encoding="utf-8")
    for name in re.findall(r"^([A-Za-z0-9_.-]+)==", python_lock, re.M):
        package = metadata.distribution(name)
        folder = output / "Python" / f"{safe_part(package.metadata['Name'])}-{package.version}"
        files = []
        for file in package.files or ():
            relative = PurePosixPath(str(file).replace("\\", "/"))
            if ".dist-info/" not in str(relative) or not any(token in relative.name.lower() for token in NOTICE_NAMES):
                continue
            source = Path(package.locate_file(file))
            if source.is_file():
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / safe_part(relative.name)
                if not target.exists():
                    shutil.copyfile(source, target)
                files.append(target.relative_to(output).as_posix())
        classifier_license = next((item.removeprefix("License :: OSI Approved :: ")
                                   for item in package.metadata.get_all("Classifier", [])
                                   if item.startswith("License :: OSI Approved :: ")), None)
        entries.append({"ecosystem": "Python runtime", "name": package.metadata["Name"],
                        "version": package.version,
                        "license": package.metadata.get("License-Expression") or package.metadata.get("License")
                        or classifier_license or "review required",
                        "noticeFiles": "; ".join(files) or "not found; review required"})

    npm_lock = json.loads((ROOT / "frontend/package-lock.json").read_text(encoding="utf-8"))
    for key, details in npm_lock.get("packages", {}).items():
        if not key.startswith("node_modules/"):
            continue
        if details.get("dev", False):
            continue
        name = key[len("node_modules/"):]
        source = ROOT / "frontend" / key
        package_json = source / "package.json"
        if not package_json.is_file():
            continue
        license = details.get("license", "review required")
        if package_json.is_file():
            try:
                license = json.loads(package_json.read_text(encoding="utf-8")).get("license", license)
            except (json.JSONDecodeError, OSError):
                pass
        folder = output / "Frontend" / safe_part(name) / safe_part(str(details.get("version", "unknown")))
        files = copy_notice_files(source, folder)
        entries.append({"ecosystem": "Frontend lockfile", "name": name,
                        "version": str(details.get("version", "unknown")), "license": str(license),
                        "noticeFiles": "; ".join((folder / file).relative_to(output).as_posix() for file in files)
                        or "not found; review required"})

    return entries


def rust_inventory(output: Path) -> list[dict[str, str]]:
    cargo = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform",
         "x86_64-pc-windows-msvc", "--manifest-path", str(ROOT / "desktop/Cargo.toml")],
        cwd=ROOT, text=True, encoding="utf-8"))
    entries = []
    for package in cargo["packages"]:
        if package["source"] is None:
            continue
        package_dir = Path(package["manifest_path"]).parent
        folder = output / "Rust" / f"{safe_part(package['name'])}-{safe_part(package['version'])}"
        files = copy_notice_files(package_dir, folder)
        entries.append({"ecosystem": "Rust lockfile", "name": package["name"], "version": package["version"],
                        "license": package.get("license") or "review required",
                        "noticeFiles": "; ".join((folder / file).relative_to(output).as_posix() for file in files)
                        or "not found; review required"})
    return entries


def source_snapshot(destination: Path) -> None:
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=ROOT, text=True, encoding="utf-8"
    ).splitlines()
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=8) as archive:
        for item in sorted(set(paths)):
            relative = PurePosixPath(item)
            if any(part in SKIP_PARTS for part in relative.parts) or relative.name.endswith((".pyc", ".pyo")):
                continue
            path = ROOT.joinpath(*relative.parts)
            if path.is_file():
                archive.write(path, f"GenzoRoom/{relative.as_posix()}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--skip-rust", action="store_true")
    args = parser.parse_args()
    stage = args.stage.resolve()
    licenses = stage / "licenses"
    source = stage / "source"
    licenses.mkdir(parents=True, exist_ok=True)
    source.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "LICENSE", licenses / "GenzoRoom-AGPL-3.0-only.txt")
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.is_file():
        raise RuntimeError("python_license_missing")
    shutil.copyfile(python_license, licenses / "Python-LICENSE.txt")
    shutil.rmtree(licenses / "third-party", ignore_errors=True)
    inventory = package_inventory(licenses / "third-party")
    inventory.extend([
        {"ecosystem": "Windows runtime", "name": "Microsoft Edge WebView2 Evergreen Runtime",
         "version": "installed by the NSIS offline installer", "license": "Microsoft redistribution terms; release review required",
         "noticeFiles": "not bundled as a separate license file"},
        {"ecosystem": "Build tool", "name": "Nullsoft Scriptable Install System (NSIS)",
         "version": "pinned by the Tauri bundler toolset", "license": "NSIS license; verify build tool provenance",
         "noticeFiles": "build-time tool; not installed as an application runtime"},
    ])
    if not args.skip_rust:
        inventory.extend(rust_inventory(licenses / "third-party"))
    else:
        inventory.append({"ecosystem": "Rust lockfile", "name": "All Cargo.lock dependencies",
                          "version": "resolved in the follow-up packaging pass", "license": "pending metadata collection",
                          "noticeFiles": "pending; final build pass replaces this staging inventory"})
    (licenses / "third-party-inventory.json").write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Third-party components", "", "License expressions are copied from the locked package metadata. "
             "Review the bundled license files before public distribution.", "",
             "WebView2 standalone installer redistribution and NSIS build-tool provenance remain release-review items.", "",
             "| Ecosystem | Package | Version | License metadata | Notice files |",
             "|---|---|---|---|---|"]
    for item in inventory:
        lines.append("| {ecosystem} | {name} | {version} | {license} | {noticeFiles} |".format(**item))
    (licenses / "THIRD-PARTY-NOTICES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    source_snapshot(source / "GenzoRoom-corresponding-source.zip")
    (source / "SOURCE-OFFER.txt").write_text(
        "This validation installer includes GenzoRoom's corresponding source in "
        "GenzoRoom-corresponding-source.zip, including the Python, React, Rust, packaging, icon, lock, and build files.\n"
        "The source is licensed under AGPL-3.0-only; see ../licenses/GenzoRoom-AGPL-3.0-only.txt.\n"
        "This local validation package is not a public release; publish an accessible source offer with any public build.\n",
        encoding="utf-8")


if __name__ == "__main__":
    main()
