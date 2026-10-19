"""Exercise Windows distribution identity resolution against isolated Git repositories."""
import json
from pathlib import Path
import subprocess
import sys

import pytest

from resolve_build_metadata import resolve_build_metadata


ROOT = Path(__file__).resolve().parents[2]


def git(repository: Path, *arguments: str) -> str:
    return subprocess.check_output(
        ["git", *arguments], cwd=repository, text=True, encoding="utf-8"
    ).strip()


def repository(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    git_init = subprocess.run(["git", "init", "-q", str(root)], capture_output=True)
    assert git_init.returncode == 0
    git(root, "config", "user.name", "Test User")
    git(root, "config", "user.email", "test@example.invalid")
    (root / "tracked.txt").write_text("initial\n", encoding="utf-8")
    git(root, "add", "tracked.txt")
    git(root, "commit", "-qm", "initial")
    return root


def test_untagged_development_branch_uses_validation_identity(tmp_path):
    root = repository(tmp_path)
    info = resolve_build_metadata(root)
    assert info == {
        "channel": "validation",
        "version": "0.0.0-validation",
        "packageVersion": "0.0.0-validation",
        "commit": git(root, "rev-parse", "HEAD"),
    }


def test_clean_exact_release_tag_uses_shared_stable_metadata(tmp_path):
    root = repository(tmp_path)
    git(root, "tag", "v0.2.3")
    info = resolve_build_metadata(root, require_release=True)
    assert info == {
        "channel": "stable",
        "version": "v0.2.3",
        "packageVersion": "0.2.3",
        "commit": git(root, "rev-parse", "HEAD"),
    }


def test_dirty_tagged_worktree_never_becomes_stable(tmp_path):
    root = repository(tmp_path)
    git(root, "tag", "v0.2.3")
    (root / "tracked.txt").write_text("changed\n", encoding="utf-8")
    assert resolve_build_metadata(root)["channel"] == "validation"
    with pytest.raises(ValueError, match="release_worktree_dirty"):
        resolve_build_metadata(root, require_release=True)


@pytest.mark.parametrize("tag", ["v0.2.3-rc.1", "v01.2.3", "release-v0.2.3"])
def test_release_mode_rejects_noncanonical_or_mismatched_tags(tmp_path, tag):
    root = repository(tmp_path)
    git(root, "tag", tag)
    with pytest.raises(ValueError, match="release_tag_required"):
        resolve_build_metadata(root, require_release=True)


def test_release_mode_rejects_a_version_tag_not_pointing_at_head(tmp_path):
    root = repository(tmp_path)
    git(root, "tag", "v0.2.2")
    (root / "tracked.txt").write_text("next commit\n", encoding="utf-8")
    git(root, "add", "tracked.txt")
    git(root, "commit", "-qm", "next")
    with pytest.raises(ValueError, match="release_tag_required"):
        resolve_build_metadata(root, require_release=True)


def test_multiple_version_tags_are_not_selected_implicitly(tmp_path):
    root = repository(tmp_path)
    git(root, "tag", "v0.2.2")
    git(root, "tag", "v0.2.3")
    assert resolve_build_metadata(root)["channel"] == "validation"
    with pytest.raises(ValueError, match="release_tag_required"):
        resolve_build_metadata(root, require_release=True)


def test_packaging_threads_identity_through_frontend_backend_and_tauri():
    script = (ROOT / "desktop/packaging/build.ps1").read_text(encoding="utf-8")
    backend = (ROOT / "desktop/packaging/package_backend.py").read_text(encoding="utf-8")
    assert "resolve_build_metadata.py" in script
    assert "--require-release" in script
    assert "$env:VITE_GENZOROOM_CHANNEL = $distributionChannel" in script
    assert "'--channel',$distributionChannel,'--version',$distributionVersion" in script
    assert "--config',$versionConfig" in script
    assert "$versionConfig = @{ version = $tauriVersion } | ConvertTo-Json -Compress" in script
    assert "from build_info import read_build_info" in backend
    assert "'GENZOROOM_CHANNEL': args.channel" in backend
    assert "'channel': args.channel, 'version': args.version, 'commit': args.commit" in backend


def test_cli_emits_json_metadata_for_build_script(tmp_path):
    root = repository(tmp_path)
    script = ROOT / "desktop/packaging/resolve_build_metadata.py"
    result = subprocess.run(
        [sys.executable, str(script), "--repository", str(root)],
        check=True, capture_output=True, text=True,
    )
    assert json.loads(result.stdout)["channel"] == "validation"
