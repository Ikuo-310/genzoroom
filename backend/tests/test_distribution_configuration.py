"""Exercise publishing trust boundaries and the resolved user-facing Compose files."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from storage import StorageInitializationError


ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("filename", ["deployment.md", "release-validation.md", "architecture.md"])
def test_distribution_docs_reference_defined_storage_error_codes(filename):
    content = (ROOT / "docs" / filename).read_text(encoding="utf-8")
    codes = re.findall(r"`(storage_[a-z_]+|unsupported_db_schema|persistence_unavailable)`", content)
    assert set(codes) <= StorageInitializationError.MESSAGES.keys()


@pytest.fixture
def bash():
    # Windows' system bash is a WSL launcher, not the Git Bash used for these scripts.
    candidate = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else shutil.which("bash")
    if not candidate or not Path(candidate).is_file():
        pytest.skip("Bash is required for publishing-script regression checks")
    return str(candidate)


@pytest.fixture
def source_repo(tmp_path):
    repo = tmp_path / "source"
    repo.mkdir()

    def git(*args):
        result = subprocess.run(["git", "-c", "user.name=Distribution test", "-c",
                                 "user.email=distribution-test@example.invalid", *args],
                                cwd=repo, text=True, capture_output=True, check=True)
        return result.stdout.strip()

    git("init", "-b", "main")
    git("commit", "--allow-empty", "-m", "first main commit")
    first = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-m", "current trusted automation")
    current = git("rev-parse", "HEAD")
    git("checkout", "-b", "feature", first)
    git("commit", "--allow-empty", "-m", "outside main")
    foreign = git("rev-parse", "HEAD")
    git("checkout", "main")
    git("tag", "v0.1.0", first)
    return repo, first, current, foreign, git


def prepare(bash, source_repo, tmp_path, **overrides):
    repo, first, _, _, _ = source_repo
    output = tmp_path / "outputs"
    output.write_text("")
    env = {**os.environ, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
           "REQUESTED_COMMIT": first, "GITHUB_SHA": first, "GITHUB_RUN_ID": "42",
           "GITHUB_RUN_ATTEMPT": "1", "GITHUB_OUTPUT": output.as_posix(), **overrides}
    result = subprocess.run([bash, (ROOT / "release/prepare-image.sh").as_posix()],
                            cwd=repo, env=env, text=True, capture_output=True)
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return result, outputs


def test_manual_build_uses_exact_main_commit_and_distinct_retry_tags(bash, source_repo, tmp_path):
    _, first, current, _, _ = source_repo
    result, outputs = prepare(bash, source_repo, tmp_path)
    assert result.returncode == 0, result.stderr
    assert outputs == {"commit": first, "automation_commit": current,
                       "image_tag": f"sha-{first}-run42-attempt1", "channel": "validation",
                       "version": "0.0.0-validation"}
    retry, retry_outputs = prepare(bash, source_repo, tmp_path, GITHUB_RUN_ATTEMPT="2")
    assert retry.returncode == 0, retry.stderr
    assert retry_outputs["image_tag"] == f"sha-{first}-run42-attempt2"


def test_stable_tag_uses_version_only(bash, source_repo, tmp_path):
    result, outputs = prepare(bash, source_repo, tmp_path, GITHUB_EVENT_NAME="push",
                              GITHUB_REF="refs/tags/v0.1.0")
    assert result.returncode == 0, result.stderr
    assert outputs["image_tag"] == "v0.1.0"
    assert outputs["channel"] == "stable" and outputs["version"] == "v0.1.0"
    assert "latest" not in outputs.values()


@pytest.mark.parametrize("overrides,reason", [
    ({"REQUESTED_COMMIT": "main"}, "full 40-character"),
    ({"REQUESTED_COMMIT": "--help"}, "full 40-character"),
    ({"REQUESTED_COMMIT": "0" * 40}, "Commit was not found"),
    ({"GITHUB_REF": "refs/heads/feature"}, "Dispatch must use the main"),
    ({"GITHUB_EVENT_NAME": "pull_request"}, "Unsupported publishing event"),
    ({"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/tags/v0.1.0-rc.1"}, "Only stable"),
    ({"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/tags/v01.1.0"}, "Only stable"),
    ({"GITHUB_RUN_ATTEMPT": "1\ninjected=value"}, "Invalid run identity"),
])
def test_untrusted_or_ambiguous_publish_inputs_fail_without_outputs(
        bash, source_repo, tmp_path, overrides, reason):
    result, outputs = prepare(bash, source_repo, tmp_path, **overrides)
    assert result.returncode != 0
    assert reason in result.stderr
    assert outputs == {}


def test_commit_outside_main_is_rejected(bash, source_repo, tmp_path):
    _, _, _, foreign, _ = source_repo
    result, outputs = prepare(bash, source_repo, tmp_path, REQUESTED_COMMIT=foreign)
    assert result.returncode != 0
    assert "main history" in result.stderr
    assert outputs == {}


def test_tag_changed_since_event_is_rejected(bash, source_repo, tmp_path):
    _, _, current, _, _ = source_repo
    result, outputs = prepare(bash, source_repo, tmp_path, GITHUB_EVENT_NAME="push",
                              GITHUB_REF="refs/tags/v0.1.0", GITHUB_SHA=current)
    assert result.returncode != 0
    assert "triggering commit" in result.stderr
    assert outputs == {}


@pytest.mark.parametrize("filename", ["prepare-image.sh", "smoke-test.sh"])
def test_publishing_scripts_have_valid_bash_syntax(bash, filename):
    subprocess.run([bash, "-n", (ROOT / "release" / filename).as_posix()], check=True)


def test_release_workflow_passes_matching_metadata_to_both_build_outputs():
    workflow = (ROOT / ".github/workflows/publish-image.yml").read_text()
    dockerfile = (ROOT / "Dockerfile.release").read_text()
    script = (ROOT / "release/prepare-image.sh").read_text()
    for value in ("GENZOROOM_CHANNEL", "GENZOROOM_VERSION", "GENZOROOM_COMMIT"):
        assert f"{value}=${{{{ env.{value} }}}}" in workflow
        assert value in dockerfile
    assert "version=$image_tag" in script and "channel=stable" in script
    assert "channel=validation" in script and "version=0.0.0-validation" in script
    assert "org.opencontainers.image.revision=${{ needs.prepare.outputs.commit }}" in workflow
    assert "org.opencontainers.image.version=${{ needs.prepare.outputs.version }}" in workflow


def test_release_smoke_checks_frontend_backend_and_oci_build_identity():
    smoke = (ROOT / "release/smoke-test.sh").read_text()
    assert '"${GENZOROOM_CHANNEL:?Set GENZOROOM_CHANNEL}"' in smoke
    assert '"${GENZOROOM_VERSION:?Set GENZOROOM_VERSION}"' in smoke
    assert '"${GENZOROOM_COMMIT:?Set GENZOROOM_COMMIT}"' in smoke
    assert "from build_info import BUILD_INFO" in smoke
    assert "Path(\"/usr/share/nginx/html/assets\").glob(\"*.js\")" in smoke
    assert "org.opencontainers.image.version" in smoke


@pytest.fixture
def compose(tmp_path):
    docker = shutil.which("docker")
    if not docker:
        pytest.skip("Docker Compose CLI is required for interpolation checks; Engine is not needed")
    empty_env = tmp_path / "empty.env"
    empty_env.write_text("")

    def config(files, **overrides):
        env = {**os.environ, "GENZOROOM_IMAGE_TAG": "sha-" + "a" * 40 + "-run42-attempt1",
               "GENZOROOM_PERSIST_ROOT": tmp_path.as_posix(), "GENZOROOM_PORT": "",
               "IMMICH_DOCKER_NETWORK": "existing-immich", "IMMICH_URL": "http://immich:2283",
               "IMMICH_API_KEY": "test-key-not-a-real-secret", **overrides}
        args = [docker, "compose", "--env-file", str(empty_env), "-p", "distribution-test"]
        for filename in files:
            args.extend(["-f", str(ROOT / filename)])
        return subprocess.run([*args, "config", "--format", "json"], cwd=ROOT,
                              env=env, text=True, capture_output=True)
    return config


def resolved(result):
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("port", ["", "3191"])
def test_distribution_compose_preserves_storage_security_and_explicit_image(compose, port):
    service = resolved(compose(["compose.release.yml"], GENZOROOM_PORT=port))["services"]["genzoroom"]
    assert "build" not in service
    assert service["image"] == "ghcr.io/ikuo-310/genzoroom:sha-" + "a" * 40 + "-run42-attempt1"
    assert len(service["ports"]) == 1
    assert str(service["ports"][0]["published"]) == (port or "3190")
    assert service["ports"][0]["target"] == 8080
    assert service["restart"] == "unless-stopped"
    assert service["stop_grace_period"] == "1m15s"
    assert service["cap_drop"] == ["ALL"]
    assert service["security_opt"] == ["no-new-privileges:true"]
    assert service["volumes"][0]["target"] == "/genzoroom"
    assert service["volumes"][0]["type"] == "bind"
    assert service["volumes"][0]["bind"]["create_host_path"] is False
    assert service["environment"] == {"IMMICH_API_KEY": "test-key-not-a-real-secret",
                                       "IMMICH_URL": "http://immich:2283"}


def test_portainer_complete_file_matches_cli_base_and_override(compose):
    combined = resolved(compose(["compose.release.yml", "compose.release.immich-network.yml"]))
    standalone = resolved(compose(["compose.release.immich-standalone.yml"]))
    assert standalone == combined
    assert combined["networks"]["immich"]["name"] == "existing-immich"
    assert combined["networks"]["immich"]["external"] is True


@pytest.mark.parametrize("variable,files", [
    ("GENZOROOM_IMAGE_TAG", ["compose.release.yml"]),
    ("GENZOROOM_PERSIST_ROOT", ["compose.release.yml"]),
    ("IMMICH_DOCKER_NETWORK", ["compose.release.immich-standalone.yml"]),
])
def test_distribution_compose_refuses_missing_required_values(compose, variable, files):
    result = compose(files, **{variable: ""})
    assert result.returncode != 0
    assert variable in result.stderr
