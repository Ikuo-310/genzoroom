from lightcraft_artifact import ENGINE_VERSION
import asyncio
import json
import sys

import pytest

from lightcraft_mcp import (LightCraftMCP, LightCraftError, MCPRpcError, MCPToolError,
                            MCPTransportError, MAX_LINE_BYTES, PROTOCOL_VERSION)


class PipeWriter:
    def __init__(self, respond=None, on_close=None):
        self.messages = []
        self.respond = respond
        self.on_close = on_close
        self.closed = False
        self.block = None
        self.broken = False

    def write(self, data):
        if self.broken or self.closed:
            raise BrokenPipeError("private pipe detail")
        message = json.loads(data)
        self.messages.append(message)
        if self.respond:
            self.respond(message)

    async def drain(self):
        if self.block is not None:
            await self.block.wait()

    def close(self):
        self.closed = True
        if self.on_close:
            self.on_close()


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(.001)


def reply(reader, message, result=None, error=None):
    packet = {"jsonrpc": "2.0", "id": message["id"]}
    packet["error" if error is not None else "result"] = error if error is not None else result
    reader.feed_data(json.dumps(packet, ensure_ascii=False).encode() + b"\n")


def test_handshake_notifications_unicode_and_errors():
    async def run():
        reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
        def respond(message):
            if message.get("method") == "initialize":
                reply(reader, message, {"protocolVersion": PROTOCOL_VERSION,
                                       "serverInfo": {"name": "lightcraft", "version": ENGINE_VERSION}})
            elif message.get("method") == "ping":
                reader.feed_data(b'\r\n{"jsonrpc":"2.0","method":"notifications/progress","params":{"message":"private"}}\r\n')
                reply(reader, message, {"unicode": "日本語"})
            elif "id" in message:
                reply(reader, message, {"isError": False, "content": [], "structuredContent": {"ok": True}})
        writer = PipeWriter(respond)
        client = LightCraftMCP(reader, writer, 7)
        try:
            assert await client.initialize("0.0.0-development") == ENGINE_VERSION
            await client.ping()
            assert [m["method"] for m in writer.messages] == ["initialize", "notifications/initialized", "ping"]
            assert [m.get("id") for m in writer.messages] == ["7:1", None, "7:2"]
            assert await client.call_tool("command_run", {}) == {"ok": True}
        finally:
            await client.close()
        assert writer.closed and client._reader_task.done() and not client._pending
    asyncio.run(run())


@pytest.mark.parametrize("result,code", [
    ({"protocolVersion": "old"}, "lightcraft_protocol_mismatch"),
    ({"protocolVersion": PROTOCOL_VERSION, "serverInfo": {"name": "other"}}, "lightcraft_server_mismatch"),
    ({"protocolVersion": PROTOCOL_VERSION, "serverInfo": {"name": "lightcraft", "version": "0.9.1"}}, "lightcraft_version_mismatch"),
])
def test_handshake_rejects_identity(result, code):
    async def run():
        reader = asyncio.StreamReader()
        writer = PipeWriter(lambda m: reply(reader, m, result))
        client = LightCraftMCP(reader, writer, 1)
        try:
            with pytest.raises(LightCraftError, match=code):
                await client.initialize("dev")
            assert len(writer.messages) == 1
        finally:
            await client.close()
    asyncio.run(run())


def test_rpc_and_tool_errors_are_distinct_and_do_not_break_transport():
    async def run():
        reader = asyncio.StreamReader()
        writer = PipeWriter()
        client = LightCraftMCP(reader, writer, 1)
        try:
            writer.respond = lambda m: reply(reader, m, error={"code": -32602, "message": "credential secret C:/photo.raw"})
            with pytest.raises(MCPRpcError) as caught:
                await client.ping()
            assert caught.value.rpc_code == -32602
            assert str(caught.value) == "lightcraft_rpc_error"
            writer.respond = lambda m: reply(reader, m, {"isError": True, "content": [{"type": "text", "text": "secret"}]})
            with pytest.raises(MCPToolError, match="^lightcraft_tool_error$"):
                await client.call_tool("command_run", {})
            writer.respond = lambda m: reply(reader, m, {})
            await client.ping()
            assert not client.failure.done()
        finally:
            await client.close()
    asyncio.run(run())


@pytest.mark.parametrize(("native_code", "reason"), [
    ("region_geometry_source_missing", "geometry_source_missing"),
    ("region_geometry_native_frame_missing", "geometry_native_frame_missing"),
    ("region_geometry_metadata_mismatch", "geometry_metadata_mismatch"),
    ("region_geometry_id_mismatch", "geometry_id_mismatch"),
    ("region_native_full_width_mismatch", "native_full_width_mismatch"),
    ("region_native_full_height_mismatch", "native_full_height_mismatch"),
    ("region_full_width_mismatch", "full_width_mismatch"),
    ("region_full_height_mismatch", "full_height_mismatch"),
    ("region_render_contract_mismatch", "render_contract_mismatch"),
    ("region_render_width_mismatch", "render_width_mismatch"),
    ("region_render_height_mismatch", "render_height_mismatch"),
])
def test_native_region_diagnostic_reasons_preserve_external_error_code(native_code, reason):
    async def run():
        reader = asyncio.StreamReader()
        text = json.dumps({"code": native_code})
        def respond(message):
            if message.get("method") == "initialize":
                reply(reader, message, {"protocolVersion": PROTOCOL_VERSION,
                    "serverInfo": {"name": "lightcraft", "version": ENGINE_VERSION}})
            elif message.get("method") == "tools/call":
                reply(reader, message, {"isError": True, "content": [{"type": "text", "text": text}]})
        writer = PipeWriter(respond)
        client = LightCraftMCP(reader, writer, 1)
        try:
            await client.initialize("diagnostic-test")
            with pytest.raises(MCPToolError) as caught:
                await client.call_tool_result("render_region_preview", {"operation": "plan"})
            assert caught.value.code == "raw_region_geometry_mismatch"
            assert caught.value.diagnostic_reason == reason
        finally:
            await client.close()
    asyncio.run(run())


@pytest.mark.parametrize("data,code", [
    (b'not json\n', "lightcraft_invalid_json"),
    (b'\xff\n', "lightcraft_invalid_utf8"),
    (b'[]\n', "lightcraft_invalid_response"),
    (b'{"jsonrpc":"2.0","id":"wrong","result":{}}\n', "lightcraft_unknown_id"),
    (b'{"jsonrpc":"2.0","id":null,"result":{}}\n', "lightcraft_unknown_id"),
    (b'{"jsonrpc":"2.0","id":"1:1","error":{},"result":{}}\n', "lightcraft_invalid_response"),
    (b'{"jsonrpc":"2.0","id":"1:1","error":{"code":true,"message":"x"}}\n', "lightcraft_invalid_response"),
    (b'{"jsonrpc":"2.0","method":"n","params":[]}\n', "lightcraft_invalid_notification"),
    (b'{"jsonrpc":"2.0","id":"1:1","result":NaN}\n', "lightcraft_invalid_json"),
    (b'x' * (MAX_LINE_BYTES + 1) + b'\n', "lightcraft_response_too_large"),
], ids=["json", "utf8", "array", "unknown", "null-id", "both", "bad-error", "bad-notification", "nan", "oversize"])
def test_bad_frames_fail_pending_without_resending(data, code):
    async def run():
        reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
        writer = PipeWriter(lambda m: reader.feed_data(data))
        client = LightCraftMCP(reader, writer, 1)
        try:
            with pytest.raises(MCPTransportError, match=code):
                await client.ping()
            with pytest.raises(MCPTransportError, match=code):
                await client.ping()
            assert len(writer.messages) == 1
        finally:
            await client.close()
    asyncio.run(run())


@pytest.mark.parametrize("partial,code", [(b'', "lightcraft_eof"), (b'{', "lightcraft_truncated_response")])
def test_eof(partial, code):
    async def run():
        reader = asyncio.StreamReader()
        def respond(_message):
            reader.feed_data(partial)
            reader.feed_eof()
        client = LightCraftMCP(reader, PipeWriter(respond), 1)
        try:
            with pytest.raises(MCPTransportError, match=code):
                await client.ping()
        finally:
            await client.close()
    asyncio.run(run())


def test_real_subprocess_oversized_stdout_is_rejected_and_drained():
    async def run():
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c",
            f"import sys; sys.stdout.buffer.write(b'x' * {MAX_LINE_BYTES * 8} + b'\\n'); sys.stdout.flush()",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=MAX_LINE_BYTES)
        client = LightCraftMCP(process.stdout, process.stdin, 7)
        wait_task = asyncio.create_task(process.wait())
        request_task = asyncio.create_task(client.ping(timeout=3))
        try:
            await until(lambda: client.failure.done())
            assert client.failure.result() == "lightcraft_response_too_large"
            with pytest.raises(MCPTransportError, match="lightcraft_response_too_large"):
                await request_task
            async with asyncio.timeout(3):
                await wait_task
            await client.close(wait_stdout=True)
            assert process.returncode == 0
            assert client._reader_task.done()
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            await client.close()
    asyncio.run(run())


def test_preview_envelope_above_one_mib_preserves_existing_tool_contract():
    from lightcraft_mcp import MAX_PREVIEW_LINE_BYTES
    async def run():
        reader = asyncio.StreamReader(limit=MAX_PREVIEW_LINE_BYTES)
        result = {"isError": False, "content": [{"type": "image", "data": "A" * (MAX_LINE_BYTES + 20),
                                                "mimeType": "image/png"}]}
        writer = PipeWriter(lambda m: reply(reader, m, result))
        client = LightCraftMCP(reader, writer, 9)
        try:
            envelope = await client.call_tool_result("render_preview", {"id": 1})
            assert len(envelope["content"][0]["data"]) > MAX_LINE_BYTES
            assert await client.call_tool("render_preview", {"id": 1}) is None
            assert not client._pending and not client._response_limits
        finally:
            await client.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["ordinary", "notification", "unknown", "tool_error", "not_image", "too_big"])
def test_preview_budget_is_not_granted_to_other_messages(mode):
    from lightcraft_mcp import MAX_PREVIEW_LINE_BYTES
    async def run():
        reader = asyncio.StreamReader(limit=MAX_PREVIEW_LINE_BYTES)
        result = {"isError": False, "content": [{"type": "image", "data": "A" * (MAX_LINE_BYTES + 20)}]}
        def respond(message):
            if mode == "notification":
                reader.feed_data(json.dumps({"jsonrpc": "2.0", "method": "notifications/progress",
                                              "params": {"message": "x" * MAX_LINE_BYTES}}).encode() + b"\n")
            elif mode == "unknown":
                reply(reader, {"id": "old:99"}, result)
            else:
                if mode == "tool_error": result["isError"] = True
                if mode == "not_image": result["content"][0]["type"] = "text"
                if mode == "too_big": result["content"][0]["data"] = "x" * MAX_PREVIEW_LINE_BYTES
                reply(reader, message, result)
        writer = PipeWriter(respond)
        client = LightCraftMCP(reader, writer, 9)
        try:
            with pytest.raises(MCPTransportError):
                await client.call_tool_result("command_run" if mode == "ordinary" else "render_preview", {})
            assert client.failure.done()
        finally:
            await client.close()
    asyncio.run(run())


def test_real_subprocess_over_preview_limit_is_drained_and_reaped():
    from lightcraft_mcp import MAX_PREVIEW_LINE_BYTES
    async def run():
        process = await asyncio.create_subprocess_exec(sys.executable, "-c",
            f"import sys; sys.stdin.buffer.readline(); sys.stdout.buffer.write(b'x' * {MAX_PREVIEW_LINE_BYTES + 1} + b'\\n'); sys.stdout.flush()",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=MAX_PREVIEW_LINE_BYTES)
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        waiting = asyncio.create_task(process.wait())
        try:
            with pytest.raises(MCPTransportError, match="lightcraft_response_too_large"):
                await client.call_tool_result("render_preview", {}, timeout=5)
            await asyncio.wait_for(waiting, 5)
            await client.close(wait_stdout=True)
            assert process.returncode == 0 and client._reader_task.done()
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            await client.close()
    asyncio.run(run())


def test_whole_maximum_base64_fits_preview_line_envelope():
    from lightcraft_mcp import MAX_PREVIEW_LINE_BYTES
    from lightcraft_raw import MAX_BASE64_CHARS
    async def run():
        reader = asyncio.StreamReader(limit=MAX_PREVIEW_LINE_BYTES)
        result = {"isError": False, "content": [{"type": "image", "data": "A" * MAX_BASE64_CHARS, "mimeType": "image/png"}]}
        writer = PipeWriter(lambda message: reply(reader, message, result))
        client = LightCraftMCP(reader, writer, 9)
        try:
            value = await client.call_tool_result("render_preview", {}, timeout=10)
            assert len(value["content"][0]["data"]) == MAX_BASE64_CHARS
            assert not client.failure.done()
        finally:
            await client.close()
    asyncio.run(run())


def test_serialization_and_waiting_timeout_do_not_poison_current_request():
    async def run():
        reader = asyncio.StreamReader()
        writer = PipeWriter()
        client = LightCraftMCP(reader, writer, 1)
        try:
            first = asyncio.create_task(client.ping())
            await until(lambda: len(writer.messages) == 1)
            with pytest.raises(MCPTransportError, match="lightcraft_busy_timeout"):
                await client.ping(timeout=.01)
            assert len(writer.messages) == 1 and not client.failure.done()
            second = asyncio.create_task(client.ping())
            await asyncio.sleep(.01)
            assert len(writer.messages) == 1
            # readuntil must preserve split frames and never associate by call order alone.
            reader.feed_data(b'{"jsonrpc":"2.0","id":"1:1",')
            reader.feed_data(b'"result":{}}\n')
            await first
            await until(lambda: len(writer.messages) == 2)
            reply(reader, writer.messages[1], {})
            await second
        finally:
            await client.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["reply_timeout", "drain_timeout", "cancel", "close", "close_drain", "broken"])
def test_inflight_failure_releases_pending_and_queued_requests(mode):
    async def run():
        reader = asyncio.StreamReader()
        writer = PipeWriter()
        if mode in ("drain_timeout", "close_drain"):
            writer.block = asyncio.Event()
        if mode == "broken":
            writer.broken = True
        client = LightCraftMCP(reader, writer, 1)
        task = asyncio.create_task(client.ping(timeout=.03))
        if mode != "broken":
            await until(lambda: bool(writer.messages))
        queued = asyncio.create_task(client.ping())
        if mode == "cancel":
            task.cancel()
        elif mode in ("close", "close_drain"):
            await client.close()
        results = await asyncio.gather(task, queued, return_exceptions=True)
        assert all(isinstance(r, (MCPTransportError, asyncio.CancelledError)) for r in results)
        assert len(writer.messages) <= 1 and not client._pending
        await client.close()
        assert client._reader_task.done()
    asyncio.run(run())


@pytest.mark.parametrize("result", [[], {}, {"isError": 1, "content": []}, {"isError": False, "content": {}}])
def test_invalid_tool_shape(result):
    async def run():
        reader = asyncio.StreamReader()
        client = LightCraftMCP(reader, PipeWriter(lambda m: reply(reader, m, result)), 1)
        try:
            with pytest.raises(MCPTransportError, match="lightcraft_invalid_tool_response"):
                await client.call_tool("command_run", {})
        finally:
            await client.close()
    asyncio.run(run())
