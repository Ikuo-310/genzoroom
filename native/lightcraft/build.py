"""Fail-closed preparation/build/probe for the pinned LightCraft source and local patch set."""

import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib

ROOT = Path(__file__).resolve().parent


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def manifest():
    value = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    for patch in value["patches"]:
        if hashlib.sha256((ROOT / patch["file"]).read_bytes()).hexdigest() != patch["sha256"]:
            raise ValueError("patch digest mismatch")
    return value


def source_state(source, spec):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(source), *args])
    if git("rev-parse", "HEAD").decode().strip() != spec["commit"]:
        raise ValueError("LightCraft HEAD differs from the manifest; review UPDATE_GUIDE.md")
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
    return source_state(source, spec)


def probe(binary):
    """Probe the actual binary with a synthetic file; never infer capabilities from its version."""
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
        if server.get("name") != "lightcraft" or server.get("version") != manifest()["version"]:
            raise ValueError("binary version mismatch")
        preview = next(t for t in replies[2]["result"]["tools"] if t["name"] == "render_preview")
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
                if set(metadata) != legacy | {"previewContract", "quality", "mode", "frame", "stageCache"} \
                        or metadata["previewContract"] != 1 or metadata["quality"] != quality or metadata["mode"] != "whole":
                    raise ValueError("adaptive metadata mismatch")
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
        for index, code in invalid:
            result = replies[index]["result"]
            if result.get("isError") is not True or len(result.get("content", [])) != 1 \
                    or result["content"][0].get("type") != "text" \
                    or json.loads(result["content"][0]["text"]) != {"code": code}:
                raise ValueError("malformed preview options were not rejected")


def receipt(binary, spec):
    return {"version": spec["version"], "commit": spec["commit"], "patches": spec["patches"],
            "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "beforeContract": 1, "previewContract": 1}


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--binary", type=Path)
    args = parser.parse_args()
    spec = manifest()
    if args.source:
        state = prepare(args.source, spec, args.apply)
        print(f"LightCraft {spec['version']}: {state}")
        if args.build:
            if state != "patched" and spec["patches"]:
                raise ValueError("Before patches must be verified before building")
            run(["cargo", "test", "--locked", "-p", "lightcraft-mcp", "--", "--test-threads=1"], cwd=args.source)
            run(["cargo", "build", "--release", "--locked", "--no-default-features", "-p", "lightcraft-cli"], cwd=args.source)
            if prepare(args.source, spec) != state:
                raise ValueError("source changed during build")
            binary = args.source / "target/release/lightcraft-cli.exe"
            verified = receipt(binary, spec)
            probe(binary)
            if receipt(binary, spec) != verified:
                raise ValueError("binary changed during probe")
            binary.with_suffix(".genzoroom.json").write_text(json.dumps(verified, indent=2) + "\n", encoding="utf-8")
            print("Adaptive Before/After binary verified; SHA-256 receipt written")
    elif args.apply or args.build:
        parser.error("--source is required")
    if args.binary:
        actual = receipt(args.binary, spec)
        saved = json.loads(args.binary.with_suffix(".genzoroom.json").read_text(encoding="utf-8"))
        if saved != actual:
            raise ValueError("binary/patch receipt mismatch; rebuild with this manifest")
        probe(args.binary)
        if receipt(args.binary, spec) != actual:
            raise ValueError("binary changed during probe")
        print("Adaptive Before/After binary capability and SHA-256 verified")
    if not args.source and not args.binary:
        parser.error("provide --source or --binary")


if __name__ == "__main__":
    main()
