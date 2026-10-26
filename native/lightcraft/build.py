"""Fail-closed preparation/build/probe for the pinned LightCraft source and local patch set."""

import argparse
import base64
import hashlib
import importlib.util
import json
import math
import os
import re
from pathlib import Path
import struct
import subprocess
import tempfile
import tomllib
import zlib

ROOT = Path(__file__).resolve().parent


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def manifest(path=None):
    value = json.loads((path or ROOT / "manifest.json").read_text(encoding="utf-8"))
    for patch in value["patches"]:
        if 'geometryDescriptorContract' in value and (not isinstance(patch.get('targets'), list) or not patch['targets']):
            raise ValueError('managed patch targets are required')
        if hashlib.sha256((ROOT / patch["file"]).read_bytes()).hexdigest() != patch["sha256"]:
            raise ValueError("patch digest mismatch")
        if "targets" in patch:
            text = (ROOT / patch["file"]).read_text(encoding="utf-8")
            targets = [line.split(" b/", 1)[1] for line in text.splitlines() if line.startswith("diff --git ")]
            if targets != patch["targets"] or len(targets) != len(set(targets)):
                raise ValueError("patch targets mismatch")
    if 'geometryDescriptorContract' in value:
        contracts = value.get('contracts', {'before': 1, 'preview': 1, 'region': 1})
        if type(value['geometryDescriptorContract']) is not int or value['geometryDescriptorContract'] != 2 \
                or contracts not in ({'before': 1, 'preview': 1, 'region': 1}, {'before': 1, 'preview': 1, 'region': 1, 'wb': 1}) \
                or any(type(version) is not int for version in contracts.values()):
            raise ValueError('unsupported managed contracts')
        if (contracts.get('wb') == 1 or 'developmentTargetDir' in value) and (contracts.get('wb') != 1 or
                not isinstance(value.get('developmentTargetDir'), str) or
                not re.fullmatch(r'target(?:-[a-z0-9]+)+', value['developmentTargetDir'])):
            raise ValueError('invalid managed development target')
    return value


def source_state(source, spec):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(source), *args])
    if git("rev-parse", "HEAD").decode().strip() != spec["commit"]:
        raise ValueError("LightCraft HEAD differs from the manifest; review UPDATE_GUIDE.md")
    if 'geometryDescriptorContract' in spec:
        upstream = tomllib.loads(git('show', 'HEAD:Cargo.toml').decode())
        if upstream['workspace']['package']['version'] != spec['version']:
            raise ValueError('upstream version differs from the manifest')
    if git("diff", "--cached", "--name-only").strip():
        raise ValueError("staged source changes are not allowed")
    if git("ls-files", "--others", "--exclude-standard").strip():
        raise ValueError("untracked source changes are not allowed")
    diff = git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-color").replace(b"\r\n", b"\n")
    if not diff:
        return "upstream"
    patches = [(ROOT / p["file"]).read_bytes().replace(b"\r\n", b"\n") for p in spec["patches"]]
    expected = b"".join(patch[patch.index(b"diff --git "):] for patch in patches)
    if diff != expected:
        raise ValueError("source has unrecognized changes; refusing to build")
    return "patched"


def prepare(source, spec, apply=False):
    state = source_state(source, spec)
    if apply:
        if state != "upstream":
            raise ValueError("patch set already applied; omit --apply to verify/build")
        for patch in spec["patches"]:
            args = ["git", "-C", str(source), "apply"]
            path = str(ROOT / patch["file"])
            run([*args, "--check", path])
            # Managed new sources join the working-tree diff without staging their contents.
            run([*args, "--intent-to-add", path])
        if source_state(source, spec) != "patched":
            raise ValueError("patch verification failed")
    state = source_state(source, spec)
    # Every managed Region build shares the same artifacts, regardless of engine version.
    if state == 'patched' and 'geometryDescriptorContract' in spec:
        shared = ROOT.parents[1]
        for native, original in [('region_schema.json','frontend/src/rawRegion.schema.json'),
                ('region_contract.json','frontend/src/rawRegionContract.json'),
                ('region_fixtures.json','frontend/src/test-fixtures/raw-region-v1.json')]:
            expected = (shared/original).read_bytes().replace(b'\r\n',b'\n')
            if (source/'crates/mcp/src'/native).read_bytes().replace(b'\r\n',b'\n') != expected:
                raise ValueError('Region shared contract artifact mismatch')
        if (shared/'backend/raw_region_schema.json').read_bytes().replace(b'\r\n',b'\n') != (shared/'frontend/src/rawRegion.schema.json').read_bytes().replace(b'\r\n',b'\n'):
            raise ValueError('Backend Region schema mismatch')
    return state


def probe(binary, spec=None):
    """Probe the actual binary with a synthetic file; never infer capabilities from its version."""
    spec = spec or manifest()
    with tempfile.TemporaryDirectory(prefix="genzoroom-before-") as folder:
        source = Path(folder) / "probe.png"
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        source.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress((b"\0" + bytes([64, 96, 128]) * 16) * 16)) + chunk(b"IEND", b""))
        def tool(index, name, args):
            return {"jsonrpc": "2.0", "id": index, "method": "tools/call", "params": {"name": name, "arguments": args}}
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
                "capabilities": {}, "clientInfo": {"name": "genzoroom-build", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            tool(3, "command_run", {"id": "library.import", "params": {"paths": [str(source)], "mode": "add"}}),
            tool(4, "command_run", {"id": "library.select", "params": {"ids": [1], "active": 1, "mode": "replace"}}),
            tool(5, "command_run", {"id": "beforeAfter.setBefore", "params": {"source": "import"}}),
            tool(6, "render_preview", {"id": 1, "max_side": 16, "before": True}),
            tool(7, "render_preview", {"id": 1, "max_side": 16}),
            tool(8, "command_run", {"id": "app.memoryBudget", "params": {"mb": 1024}}),
            tool(9, "get_develop", {"id": 1}),
            tool(10, "render_preview", {"id": 1, "max_side": 16, "preview_contract": 1}),
            tool(11, "render_preview", {"id": 1, "max_side": 16, "quality": "draft"}),
            tool(12, "render_preview", {"id": 1, "max_side": 16, "quality": "full", "before": True}),
            tool(13, "render_preview", {"id": 1, "max_side": 16, "quality": "draft", "before": True}),
            tool(14, "render_preview", {"id": 1, "max_side": 16, "quality": "draft",
                "stage_cache": "on", "stage_cache_budget_bytes": 1024**3}),
            tool(15, "render_preview", {"id": 1, "max_side": 16, "quality": "full",
                "stage_cache": "on", "stage_cache_budget_bytes": 1024**3}),
            tool(16, "render_preview", {"id": 1, "max_side": 16, "quality": "full", "stage_cache": "off"}),
            tool(17, "render_preview", {"id": 1, "max_side": 16, "quality": "full",
                "stage_cache": "on", "stage_cache_budget_bytes": 1}),
            tool(18, "get_develop", {"id": 1}),
            tool(100, "command_run", {"id": "app.gpu", "params": {"enabled": False}}),
            *[tool(index, "render_preview", {"id": 1, "max_side": 1024, "quality": "full",
                "stage_cache": "on", "stage_cache_budget_bytes": 512 * 1024**2,
                **({"before": True} if index == 103 else {})}) for index in (101, 102, 103)],
            tool(104, "render_preview", {"id": 1, "max_side": 1024, "quality": "full", "stage_cache": "off"}),
            tool(105, "get_develop", {"id": 1}),
        ]
        invalid = []
        for field, values, code in (
            ("quality", (None, True, 1, "FULL", "fast"), "preview_invalid_quality"),
            ("preview_contract", (None, True, 1.0, 2), "preview_invalid_contract"),
            ("before", (None, 0, "true"), "preview_invalid_contract"),
            ("stage_cache", (None, True, "reuse", "on"), "preview_invalid_stage_cache"),
            ("stage_cache_budget_bytes", (None, True, 0, -1), "preview_invalid_stage_cache"),
        ):
            for value in values:
                index = 20 + len(invalid)
                invalid.append((index, code))
                messages.append(tool(index, "render_preview", {"id": 1, "max_side": 16, field: value}))
        # Private TEMP also contains the MCP helper's transient PNGs; no source/photo paths are logged.
        environment = {**os.environ, "TEMP": folder, "TMP": folder}
        process = subprocess.run([str(binary), "mcp", "--headless", "--compact"],
            input="".join(json.dumps(item) + "\n" for item in messages).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=120, check=True, env=environment,
            creationflags=0x08000000 if os.name == "nt" else 0)
        if len(process.stdout) > 8 * 1024 * 1024:
            raise ValueError("probe response too large")
        replies = {item["id"]: item for line in process.stdout.splitlines() if (item := json.loads(line)).get("id")}
        server = replies[1]["result"]["serverInfo"]
        if server.get("name") != "lightcraft" or server.get("version") != spec["version"]:
            raise ValueError("binary version mismatch")
        preview = next(t for t in replies[2]["result"]["tools"] if t["name"] == "render_preview")
        region = next(t for t in replies[2]["result"]["tools"] if t["name"] == "render_region_preview")
        if region.get('_meta', {}).get('genzoroom.geometryDescriptorContract') != spec['geometryDescriptorContract']:
            raise ValueError('binary geometry descriptor contract mismatch')
        properties = preview["inputSchema"]["properties"]
        if properties.get("before", {}).get("type") != "boolean" \
                or properties.get("quality", {}).get("enum") != ["draft", "full"] \
                or properties.get("preview_contract", {}).get("type") != "integer" \
                or properties.get("preview_contract", {}).get("enum") != [1] \
                or properties.get("stage_cache", {}).get("enum") != ["off", "on"] \
                or properties.get("stage_cache_budget_bytes", {}).get("minimum") != 1:
            raise ValueError("binary lacks adaptive preview schema")
        metadata_by_id, images = {}, {}
        for index, kind, quality in ((6, "before", None), (7, "after", None),
                (10, "after", "full"), (11, "after", "draft"), (12, "before", "full"),
                (13, "before", "draft"), (14, "after", "draft"), (15, "after", "full"),
                (16, "after", "full"), (17, "after", "full")):
            result = replies[index]["result"]
            if result.get("isError") is not False:
                raise ValueError("binary render probe failed")
            metadata = json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))
            image = next(c for c in result["content"] if c["type"] == "image")
            png = base64.b64decode(image["data"], validate=True)
            if metadata["kind"] != kind or image["mimeType"] != "image/png" or png[:8] != b"\x89PNG\r\n\x1a\n" \
                    or tuple(struct.unpack(">II", png[16:24])) != (metadata["width"], metadata["height"]):
                raise ValueError("binary image kind/dimensions mismatch")
            if kind == "before" and metadata["beforeFingerprint"] != replies[5]["result"]["structuredContent"]["beforeFingerprint"]:
                raise ValueError("binary Before baseline mismatch")
            legacy = {"id", "width", "height", "kind"}
            if kind == "before":
                legacy |= {"beforeFingerprint", "effectiveBeforeFingerprint", "geometry"}
            if quality is None:
                if set(metadata) != legacy:
                    raise ValueError("legacy metadata changed")
            else:
                if set(metadata) != legacy | {"previewContract", "quality", "mode", "frame", "stageCache", "execution"} \
                        or metadata["previewContract"] != 1 or metadata["quality"] != quality or metadata["mode"] != "whole":
                    raise ValueError("adaptive metadata mismatch")
                execution = metadata["execution"]
                if not valid_execution(execution):
                    raise ValueError("missing render-local execution")
                frame, cache = metadata["frame"], metadata["stageCache"]
                if set(frame) != {"geometryId", "nativeWidth", "nativeHeight", "aspect", "fullWidth", "fullHeight", "window"} \
                        or any(type(frame[k]) is not int or frame[k] != 16 for k in ("nativeWidth", "nativeHeight", "fullWidth", "fullHeight")) \
                        or not isinstance(frame["geometryId"], str) or len(frame["geometryId"]) != 64 \
                        or any(c not in "0123456789abcdef" for c in frame["geometryId"]) \
                        or type(frame["aspect"]) not in (int, float) or not math.isfinite(frame["aspect"]) \
                        or frame["aspect"] != 1 or frame["window"] is not None:
                    raise ValueError("binary frame mismatch")
                if any(type(cache[k]) is not int or cache[k] < 0 for k in ("cpuBytes", "gpuBytes", "retainedBytes", "budgetBytes")) \
                        or cache["retainedBytes"] > cache["budgetBytes"] or type(cache["applied"]) is not bool:
                    raise ValueError("cache budget mismatch")
                if index in (14, 15) and (cache["mode"] != "on" or not cache["applied"] or cache["retainedBytes"] <= 0):
                    raise ValueError("cache comparison unavailable")
                if index == 17 and (cache["applied"] or cache["reason"] != "budget" or cache["retainedBytes"] != 0):
                    raise ValueError("small cache budget was not enforced")
            metadata_by_id[index], images[index] = metadata, png
        if any(metadata_by_id[i]["frame"]["geometryId"] != metadata_by_id[10]["frame"]["geometryId"] for i in range(11, 18)) \
                or any(images[i] != images[7] for i in (10, 15, 16)):
            raise ValueError("quality/cache changed Full geometry or pixels")
        if replies[9]["result"]["structuredContent"] != replies[18]["result"]["structuredContent"]:
            raise ValueError("render changed develop settings")
        if replies[100]["result"]["structuredContent"].get("enabled") is not False:
            raise ValueError("CPU admission probe did not disable GPU rendering")
        cpu_images = []
        for index in (101, 102, 103, 104):
            result = replies[index]["result"]
            if result.get("isError") is not False:
                raise ValueError("CPU admission render failed")
            meta = json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))
            png = base64.b64decode(next(c["data"] for c in result["content"] if c["type"] == "image"), validate=True)
            if meta["execution"] != {"outcome": "cpu_not_tried", "backend": "cpu", "reason": "gpu_disabled"}:
                raise ValueError("CPU execution evidence mismatch")
            cache = meta["stageCache"]
            if meta["quality"] != "full" or meta["kind"] != ("before" if index == 103 else "after") \
                    or struct.unpack(">II", png[16:24]) != (meta["width"], meta["height"]) \
                    or max(meta["width"], meta["height"]) != 1024 or cache["gpuBytes"] != 0:
                raise ValueError("CPU admission image contract mismatch")
            if index != 104 and (cache["mode"] != "on" or not cache["applied"] or cache["reason"] != "none" \
                    or cache["budgetBytes"] != 512 * 1024**2 or not 0 < cache["retainedBytes"] <= cache["budgetBytes"]):
                raise ValueError("CPU 1024px/512MiB cache admission unavailable")
            if index == 104 and (cache["mode"] != "off" or cache["applied"] or cache["retainedBytes"] != 0):
                raise ValueError("CPU cache mode invalidation failed")
            cpu_images.append(png)
        if len(set(cpu_images)) != 1 or replies[18]["result"]["structuredContent"] != replies[105]["result"]["structuredContent"]:
            raise ValueError("CPU cache changed Full pixels or settings")
        for index, code in invalid:
            result = replies[index]["result"]
            if result.get("isError") is not True or len(result.get("content", [])) != 1 \
                    or result["content"][0].get("type") != "text" \
                    or json.loads(result["content"][0]["text"]) != {"code": code}:
                raise ValueError("malformed preview options were not rejected")

    probe_gpu(binary)
    probe_whole_bytes(binary)
    region_spec = importlib.util.spec_from_file_location('genzoroom_region_probe', ROOT/'region_probe.py')
    region_module = importlib.util.module_from_spec(region_spec)
    region_spec.loader.exec_module(region_module)
    region_module.probe_region(binary, expected_version=spec['version'])
    if spec.get('contracts', {}).get('wb') == 1:
        wb_spec = importlib.util.spec_from_file_location('genzoroom_wb_probe', ROOT / 'wb_probe.py')
        wb_module = importlib.util.module_from_spec(wb_spec)
        wb_spec.loader.exec_module(wb_module)
        wb_module.probe_wb(binary, expected_version=spec['version'])


def valid_execution(value):
    if not isinstance(value, dict) or set(value) != {"outcome", "backend", "reason"}:
        return False
    return value == {"outcome": "gpu_success", "backend": "gpu", "reason": "none"} or \
        value == {"outcome": "cpu_fallback", "backend": "cpu", "reason": "gpu_failed"} or \
        value["outcome"] == "cpu_not_tried" and value["backend"] == "cpu" and value["reason"] in (
            "cpu_requested", "shutdown", "gpu_disabled", "unsupported", "gpu_unavailable")


def probe_whole_bytes(binary):
    """Exercise PNG/base64/line capacity with real pixels that cannot compress to a tiny fixture."""
    import random
    with tempfile.TemporaryDirectory(prefix="genzoroom-whole-") as folder:
        source = Path(folder) / "source.png"
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        pixels = random.Random(0).randbytes(2048**2 * 3)
        rows = b"".join(b"\0" + pixels[y * 2048 * 3:(y + 1) * 2048 * 3] for y in range(2048))
        source.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2048, 2048, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
        def call(index, name, args):
            return {"jsonrpc": "2.0", "id": index, "method": "tools/call", "params": {"name": name, "arguments": args}}
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
             "capabilities": {}, "clientInfo": {"name": "genzoroom-whole-probe", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            call(2, "command_run", {"id": "library.import", "params": {"paths": [str(source)], "mode": "add"}}),
            call(3, "render_preview", {"id": 1, "max_side": 2048, "quality": "full", "stage_cache": "off"}),
        ]
        process = subprocess.run([str(binary), "mcp", "--headless", "--compact"],
            input="".join(json.dumps(v) + "\n" for v in messages).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=120, check=True,
            env={**os.environ, "TEMP": folder, "TMP": folder, "LIGHTCRAFT_GPU_BACKEND": "off"},
            creationflags=0x08000000 if os.name == "nt" else 0)
        if len(process.stdout) > 24 * 1024**2:
            raise ValueError("Whole probe line capacity exceeded")
        replies = {v["id"]: v for line in process.stdout.splitlines() if (v := json.loads(line)).get("id")}
        result = replies[3]["result"]
        if result.get("isError") is not False:
            raise ValueError("Whole byte probe render failed")
        png = base64.b64decode(next(c["data"] for c in result["content"] if c["type"] == "image"), validate=True)
        meta = json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))
        if not 5 * 1024**2 < len(png) <= 17 * 1024**2 or struct.unpack(">II", png[16:24]) != (2048, 2048) \
                or (meta["width"], meta["height"]) != (2048, 2048) or meta["execution"]["backend"] != "cpu":
            raise ValueError("Whole byte/dimension probe mismatch")
        print(f"Whole CPU probe: 2048x2048, PNG {len(png)} bytes, line within 24 MiB")


def probe_gpu(binary):
    """An isolated real-device check; no available adapter is an explicit skip, not success."""
    with tempfile.TemporaryDirectory(prefix="genzoroom-dx12-") as folder:
        source = Path(folder) / "source.png"
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        source.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 3072, 2304, 8, 2, 0, 0, 0))
                          + chunk(b"IDAT", zlib.compress((b"\0" + bytes([64, 96, 128]) * 3072) * 2304)) + chunk(b"IEND", b""))
        def call(index, name, args):
            return {"jsonrpc": "2.0", "id": index, "method": "tools/call", "params": {"name": name, "arguments": args}}
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
             "capabilities": {}, "clientInfo": {"name": "genzoroom-gpu-probe", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            call(2, "command_run", {"id": "library.import", "params": {"paths": [str(source)], "mode": "add"}}),
            call(3, "command_run", {"id": "app.gpu", "params": {}}),
            *[call(i, "render_preview", {"id": 1, "max_side": 1024, "quality": "full", "stage_cache": mode,
               **({"before": True} if i == 6 else {}),
               **({"stage_cache_budget_bytes": budget} if mode == "on" else {})})
              for i, mode, budget in [(4, "off", 0), (5, "on", 512 << 20), (6, "on", 512 << 20), (7, "on", 1)]],
            *[call(i, "render_preview", {"id": 1, "max_side": side, "quality": quality, "stage_cache": mode,
               **({"before": True} if i == 12 else {}),
               **({"stage_cache_budget_bytes": budget} if mode == "on" else {})})
              for i, side, quality, mode, budget in [(8, 1536, "full", "off", 0), (9, 1536, "full", "on", 1 << 30),
                (10, 2048, "full", "off", 0), (11, 2048, "full", "on", 1 << 30), (12, 2048, "full", "on", 1 << 30),
                (13, 2048, "draft", "on", 1), (14, 2048, "full", "on", 1)]],
            call(15, "command_run", {"id": "app.gpu", "params": {"enabled": False}}),
            call(16, "render_preview", {"id": 1, "max_side": 2048, "quality": "full", "stage_cache": "off"}),
        ]
        environment = {**os.environ, "TEMP": folder, "TMP": folder,
                       "LIGHTCRAFT_GPU": "1", "LIGHTCRAFT_GPU_BACKEND": "dx12" if os.name == "nt" else "auto"}
        process = subprocess.run([str(binary), "mcp", "--headless", "--compact"],
            input="".join(json.dumps(v) + "\n" for v in messages).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=120, check=True, env=environment,
            creationflags=0x08000000 if os.name == "nt" else 0)
        if len(process.stdout) > 24 * 1024 * 1024:
            raise ValueError("GPU probe response too large")
        replies = {v["id"]: v for line in process.stdout.splitlines() if (v := json.loads(line)).get("id")}
        status = replies[3]["result"]["structuredContent"]
        images = []
        for index in range(4, 15):
            result = replies[index]["result"]
            if result.get("isError") is not False:
                raise ValueError("GPU probe render failed")
            meta = json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))
            if not valid_execution(meta["execution"]):
                raise ValueError("GPU probe execution mismatch")
            if status["available"] and meta["execution"]["outcome"] != "gpu_success":
                raise ValueError("available GPU did not complete the probe")
            side = 1024 if index <= 7 else 1536 if index <= 9 else 2048
            png = base64.b64decode(next(c["data"] for c in result["content"] if c["type"] == "image"), validate=True)
            if (meta["width"], meta["height"]) != (side, side * 3 // 4) or struct.unpack(">II", png[16:24]) != (side, side * 3 // 4):
                raise ValueError("GPU probe dimensions mismatch")
            cache = meta["stageCache"]
            if index in (5, 6) and (not cache["applied"] or not 0 < cache["retainedBytes"] <= 512 << 20):
                raise ValueError("GPU probe capacity admission failed")
            if index in (7, 13, 14) and (cache["applied"] or cache["reason"] != "budget" or cache["retainedBytes"]):
                raise ValueError("GPU probe tiny budget failed")
            images.append(next(c["data"] for c in result["content"] if c["type"] == "image"))
        if any(len(set(images[a:b])) != 1 for a, b in [(0, 4), (4, 6), (6, 9)]) or images[6] != images[10]:
            raise ValueError("GPU cache changed Full pixels")
        cpu = replies[16]["result"]
        meta = json.loads(next(c["text"] for c in cpu["content"] if c["type"] == "text"))
        png = base64.b64decode(next(c["data"] for c in cpu["content"] if c["type"] == "image"), validate=True)
        if meta["execution"] != {"outcome": "cpu_not_tried", "backend": "cpu", "reason": "gpu_disabled"} or struct.unpack(">II", png[16:24]) != (2048, 1536):
            raise ValueError("CPU Whole 2048 probe failed")
        print("DX12/GPU probe: real GPU success" if status["available"] else "SKIP GPU integration: no available adapter (CPU execution validated)")


def receipt(binary, spec):
    return {"version": spec["version"], "commit": spec["commit"], "patches": spec["patches"],
            "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "beforeContract": 1, "previewContract": 1, "regionContract": 1,
            "geometryDescriptorContract": spec['geometryDescriptorContract'],
            **({'wbContract': 1} if spec.get('contracts', {}).get('wb') == 1 else {})}


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--manifest", type=Path, help="Archived manifest for a reproducible older engine")
    args = parser.parse_args()
    spec = manifest(args.manifest)
    if args.source:
        state = prepare(args.source, spec, args.apply)
        print(f"LightCraft {spec['version']}: {state}")
        if args.build:
            if state != "patched" and spec["patches"]:
                raise ValueError("Before patches must be verified before building")
            run(["cargo", "test", "--locked", "-p", "lightcraft-mcp", "--", "--test-threads=1"], cwd=args.source)
            if spec.get('contracts', {}).get('wb') == 1:
                run(["cargo", "test", "--locked", "-p", "lightcraft-pipeline", "wb", "--", "--test-threads=1"], cwd=args.source)
                run(["cargo", "test", "--locked", "-p", "lightcraft-pipeline", "custom_white_balance_redevelops_in_camera_space",
                     "--", "--test-threads=1"], cwd=args.source)
            target = args.source.resolve() / spec.get('developmentTargetDir', 'target')
            run(["cargo", "build", "--release", "--locked", "--no-default-features", "-p", "lightcraft-cli",
                 "--target-dir", str(target)], cwd=args.source)
            if prepare(args.source, spec) != state:
                raise ValueError("source changed during build")
            binary = target / "release/lightcraft-cli.exe"
            verified = receipt(binary, spec)
            probe(binary, spec)
            if receipt(binary, spec) != verified:
                raise ValueError("binary changed during probe")
            binary.with_suffix(".genzoroom.json").write_text(json.dumps(verified, indent=2) + "\n", encoding="utf-8")
            print("Adaptive Before/After binary verified; SHA-256 receipt written")
    elif args.apply or args.build:
        parser.error("--source is required")
    if args.binary:
        actual = receipt(args.binary, spec)
        saved = json.loads(args.binary.with_suffix(".genzoroom.json").read_text(encoding="utf-8"))
        # JSON booleans must not compare equal to integer contract versions.
        if json.dumps(saved, sort_keys=True) != json.dumps(actual, sort_keys=True):
            raise ValueError("binary/patch receipt mismatch; rebuild with this manifest")
        probe(args.binary, spec)
        if receipt(args.binary, spec) != actual:
            raise ValueError("binary changed during probe")
        print("Adaptive Before/After binary capability and SHA-256 verified")
    if not args.source and not args.binary:
        parser.error("provide --source or --binary")


if __name__ == "__main__":
    main()
