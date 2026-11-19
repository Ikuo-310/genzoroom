import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
NGINX_CONFIG = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
RELEASE_NGINX_CONFIG = (ROOT / "release" / "nginx.conf").read_text(encoding="utf-8")


def exact_location(path: str) -> str:
    match = re.search(rf"(?ms)^\s*location = {re.escape(path)} \{{(?P<body>.*?)^\s*\}}", NGINX_CONFIG)
    assert match is not None, f"missing exact nginx location for {path}"
    return match.group("body")


def test_export_engine_diagnostics_use_long_exact_proxy_locations() -> None:
    for path in (
        "/api/developer/export-engine",
        "/api/developer/export-engine/decode",
        "/api/developer/export-engine/roundtrip",
    ):
        body = exact_location(path)
        backend_path = path.removeprefix("/api")
        assert f"proxy_pass http://backend_api{backend_path};" in body
        assert "proxy_connect_timeout 3s;" in body
        assert "proxy_read_timeout 1h;" in body
        assert "proxy_set_header Host $host;" in body


def test_stack_and_general_api_proxy_timeouts_are_unchanged() -> None:
    stack = exact_location("/api/stacks/apply")
    assert "proxy_read_timeout 90m;" in stack
    assert "proxy_connect_timeout 3s;" in stack

    general_api = re.search(r"(?ms)^\s*location /api/ \{(?P<body>.*?)^\s*\}", NGINX_CONFIG)
    assert general_api is not None
    assert "proxy_read_timeout 10s;" in general_api.group("body")


def test_nginx_variants_leave_private_image_cache_headers_to_backend() -> None:
    for config in (NGINX_CONFIG, RELEASE_NGINX_CONFIG):
        directives = config.lower()
        assert "proxy_cache " not in directives
        assert "proxy_hide_header cache-control" not in directives
        assert "add_header cache-control" not in directives
        assert "expires " not in directives
