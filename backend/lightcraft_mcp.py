"""Bounded JSON-lines MCP transport; process ownership belongs to the runtime."""

import asyncio
import json


MAX_LINE_BYTES = 1024 * 1024
# Base64 for the 17 MiB PNG envelope plus bounded metadata/JSON stays below 24 MiB.
MAX_PREVIEW_LINE_BYTES = 24 * MAX_LINE_BYTES
MAX_REGION_LINE_BYTES = 13 * MAX_LINE_BYTES
PROTOCOL_VERSION = "2025-06-18"


class LightCraftError(Exception):
    def __init__(self, code):
        self.code = code
        # Upstream messages can contain paths or user content; expose only local codes.
        super().__init__(code)


class MCPTransportError(LightCraftError):
    pass


class MCPRpcError(LightCraftError):
    def __init__(self, rpc_code):
        self.rpc_code = rpc_code
        super().__init__("lightcraft_rpc_error")


class MCPToolError(LightCraftError):
    def __init__(self, code="lightcraft_tool_error", diagnostic_reason=None):
        self.diagnostic_reason = diagnostic_reason
        super().__init__(code)


def _decode(line):
    def reject_constant(_value):
        raise ValueError()
    return json.loads(line.decode("utf-8"), parse_constant=reject_constant)


class LightCraftMCP:
    def __init__(self, reader, writer, generation):
        self.reader, self.writer = reader, writer
        self.generation = generation
        self._sequence = 0
        self._lock = asyncio.Lock()
        self._pending = {}
        self._response_limits = {}
        self._error = None
        self._draining_stdout = False
        # A result (rather than an exception) remains safe if failure precedes monitoring.
        self.failure = asyncio.get_running_loop().create_future()
        self._reader_task = asyncio.create_task(self._read(), name=f"lightcraft-stdout-{generation}")

    def abort(self, code="lightcraft_closed"):
        if self._error is not None:
            return
        self._error = code
        for future in self._pending.values():
            if not future.done():
                future.set_exception(MCPTransportError(code))
        if not self.failure.done():
            self.failure.set_result(code)

    def _check_open(self):
        if self._error is not None:
            raise MCPTransportError(self._error)

    async def _read(self):
        code = "lightcraft_read_failed"
        try:
            while True:
                try:
                    line = await self.reader.readuntil(b"\n")
                except asyncio.LimitOverrunError:
                    code = "lightcraft_response_too_large"
                    self._draining_stdout = True
                    break
                except asyncio.IncompleteReadError as error:
                    code = "lightcraft_truncated_response" if error.partial else "lightcraft_eof"
                    break
                if len(line) > max(self._response_limits.values(), default=MAX_LINE_BYTES):
                    code = "lightcraft_response_too_large"
                    self._draining_stdout = True
                    break
                if not line.strip():
                    if len(line) > MAX_LINE_BYTES:
                        code = "lightcraft_response_too_large"
                        self._draining_stdout = True
                        break
                    continue
                try:
                    # Parsing a bounded but potentially large frame must not stall ASGI.
                    message = await asyncio.to_thread(_decode, line)
                except UnicodeDecodeError:
                    code = "lightcraft_invalid_utf8"
                    self._draining_stdout = True
                    break
                except (ValueError, RecursionError):
                    code = "lightcraft_invalid_json"
                    self._draining_stdout = True
                    break
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    code = "lightcraft_invalid_response"
                    self._draining_stdout = True
                    break
                if "id" not in message:
                    if len(line) > MAX_LINE_BYTES:
                        code = "lightcraft_response_too_large"
                        self._draining_stdout = True
                        break
                    if not isinstance(message.get("method"), str) or \
                            not isinstance(message.get("params", {}), dict) or \
                            "result" in message or "error" in message:
                        code = "lightcraft_invalid_notification"
                        self._draining_stdout = True
                        break
                    # Notifications (including progress text) are never responses or logs.
                    continue
                request_id = message["id"]
                if type(request_id) is not str or request_id not in self._pending:
                    code = "lightcraft_unknown_id"
                    self._draining_stdout = True
                    break
                if len(line) > self._response_limits[request_id] or (
                        len(line) > MAX_LINE_BYTES and "error" in message):
                    code = "lightcraft_response_too_large"
                    self._draining_stdout = True
                    break
                future = self._pending[request_id]
                if future.done():
                    code = "lightcraft_duplicate_response"
                    self._draining_stdout = True
                    break
                if "method" in message or ("result" in message) == ("error" in message):
                    code = "lightcraft_invalid_response"
                    self._draining_stdout = True
                    break
                if "error" in message:
                    error = message["error"]
                    if not isinstance(error, dict) or type(error.get("code")) is not int or \
                            not isinstance(error.get("message"), str):
                        code = "lightcraft_invalid_response"
                        self._draining_stdout = True
                        break
                    future.set_exception(MCPRpcError(error["code"]))
                else:
                    if len(line) > MAX_LINE_BYTES:
                        result = message["result"]
                        if not isinstance(result, dict) or result.get("isError") is not False or \
                                not isinstance(result.get("content"), list) or not any(
                                    isinstance(c, dict) and c.get("type") == "image" for c in result["content"]):
                            code = "lightcraft_response_too_large"
                            self._draining_stdout = True
                            break
                    future.set_result(message["result"])
        except asyncio.CancelledError:
            return
        except Exception:
            pass
        self.abort(code)
        if self._draining_stdout:
            await self._discard_stdout()

    async def _discard_stdout(self):
        # Keep the child pipe moving after rejecting frames so subprocess exit can be reaped.
        try:
            while await self.reader.read(8192):
                pass
        except Exception:
            pass

    async def _drain(self):
        draining = asyncio.create_task(self.writer.drain())
        try:
            # Closing a client must also release a write blocked by pipe backpressure.
            await asyncio.wait((draining, self.failure), return_when=asyncio.FIRST_COMPLETED)
            self._check_open()
            await draining
        finally:
            draining.cancel()
            await asyncio.gather(draining, return_exceptions=True)

    async def request(self, method, params=None, *, timeout=5, _preview_response=False, _region_response=False):
        future = None
        request_id = None
        sent = False
        try:
            # One deadline covers admission, pipe backpressure and the reply.
            async with asyncio.timeout(timeout):
                async with self._lock:
                    self._check_open()
                    self._sequence += 1
                    request_id = f"{self.generation}:{self._sequence}"
                    packet = {"jsonrpc": "2.0", "id": request_id, "method": method,
                              "params": params if params is not None else {}}
                    encoded = json.dumps(packet, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
                    future = asyncio.get_running_loop().create_future()
                    self._pending[request_id] = future
                    self._response_limits[request_id] = MAX_REGION_LINE_BYTES if _region_response else MAX_PREVIEW_LINE_BYTES if _preview_response else MAX_LINE_BYTES
                    sent = True
                    self.writer.write(encoded)
                    await self._drain()
                    return await asyncio.shield(future)
        except TimeoutError:
            if sent:
                # The engine may still be executing; this connection cannot be reused.
                self.abort("lightcraft_timeout")
            raise MCPTransportError("lightcraft_timeout" if sent else "lightcraft_busy_timeout") from None
        except asyncio.CancelledError:
            if sent:
                self.abort("lightcraft_request_cancelled")
            raise
        except (OSError, RuntimeError):
            self.abort("lightcraft_write_failed")
            raise MCPTransportError("lightcraft_write_failed") from None
        finally:
            if request_id is not None:
                self._pending.pop(request_id, None)
                self._response_limits.pop(request_id, None)
            if future is not None:
                if not future.done():
                    future.cancel()
                elif not future.cancelled():
                    future.exception()

    async def notify(self, method, *, timeout=5):
        sent = False
        try:
            async with asyncio.timeout(timeout):
                async with self._lock:
                    self._check_open()
                    sent = True
                    self.writer.write(json.dumps({"jsonrpc": "2.0", "method": method}).encode() + b"\n")
                    await self._drain()
        except TimeoutError:
            if sent:
                self.abort("lightcraft_timeout")
            raise MCPTransportError("lightcraft_timeout" if sent else "lightcraft_busy_timeout") from None
        except asyncio.CancelledError:
            if sent:
                self.abort("lightcraft_request_cancelled")
            raise
        except (OSError, RuntimeError):
            self.abort("lightcraft_write_failed")
            raise MCPTransportError("lightcraft_write_failed") from None

    async def initialize(self, client_version, *, timeout=10):
        result = await self.request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                    "clientInfo": {"name": "genzoroom", "version": client_version}}, timeout=timeout)
        if not isinstance(result, dict) or result.get("protocolVersion") != PROTOCOL_VERSION:
            raise LightCraftError("lightcraft_protocol_mismatch")
        server = result.get("serverInfo")
        if not isinstance(server, dict) or server.get("name") != "lightcraft":
            raise LightCraftError("lightcraft_server_mismatch")
        if server.get("version") != "0.10.0":
            raise LightCraftError("lightcraft_version_mismatch")
        await self.notify("notifications/initialized", timeout=timeout)
        return server["version"]

    async def ping(self, *, timeout=5):
        if not isinstance(await self.request("ping", timeout=timeout), dict):
            self.abort("lightcraft_invalid_ping")
            raise MCPTransportError("lightcraft_invalid_ping")

    async def call_tool(self, name, arguments, *, timeout=5):
        result = await self.call_tool_result(name, arguments, timeout=timeout)
        return result.get("structuredContent")

    async def call_tool_result(self, name, arguments, *, timeout=5):
        # Only the image helper receives a larger budget; callers cannot enlarge arbitrary RPCs.
        result = await self.request("tools/call", {"name": name, "arguments": arguments}, timeout=timeout,
                                    _preview_response=name == "render_preview",
                                    _region_response=name == "render_region_preview" and arguments.get("operation") == "render")
        if not isinstance(result, dict) or type(result.get("isError")) is not bool or \
                not isinstance(result.get("content"), list):
            self.abort("lightcraft_invalid_tool_response")
            raise MCPTransportError("lightcraft_invalid_tool_response")
        if result["isError"]:
            if name == "render_region_preview" and len(result['content']) == 1:
                try:
                    text = result['content'][0]['text']
                    code = _decode(text.encode())['code'] if type(text) is str and len(text) <= 256 else None
                    if code in {'region_invalid_request','region_unsupported','region_geometry_mismatch','region_budget_exceeded',
                                'region_work_budget_exceeded','region_render_failed'}:
                        raise MCPToolError('raw_' + code)
                    if code in {'region_geometry_source_missing', 'region_geometry_native_frame_missing',
                                'region_geometry_metadata_mismatch', 'region_geometry_id_mismatch',
                                'region_native_full_width_mismatch', 'region_native_full_height_mismatch',
                                'region_full_width_mismatch', 'region_full_height_mismatch',
                                'region_render_contract_mismatch', 'region_render_width_mismatch',
                                'region_render_height_mismatch'}:
                        raise MCPToolError('raw_region_geometry_mismatch', code.removeprefix('region_'))
                except (KeyError, TypeError, ValueError, AttributeError):
                    pass
            if name == "render_preview" and len(result["content"]) == 1 and "structuredContent" not in result:
                item = result["content"][0]
                try:
                    value = _decode(item["text"].encode()) if item.get("type") == "text" and len(item.get("text", "")) <= 256 else None
                    codes = {"preview_invalid_quality": "raw_invalid_preview_request", "preview_invalid_contract": "raw_invalid_preview_request",
                        "preview_invalid_stage_cache": "raw_invalid_preview_request", "preview_unsupported": "raw_preview_unsupported",
                        "preview_geometry_unavailable": "raw_preview_geometry_unavailable", "preview_geometry_mismatch": "raw_preview_geometry_unavailable",
                        "preview_budget_exceeded": "raw_preview_budget_exceeded", "preview_render_failed": "raw_invalid_preview"}
                    if isinstance(value, dict) and set(value) == {"code"} and value["code"] in codes:
                        raise MCPToolError(codes[value["code"]])
                except (KeyError, TypeError, ValueError, AttributeError):
                    pass
            raise MCPToolError()
        return result

    async def close(self, *, drain_stdout=False, wait_stdout=False):
        self.abort()
        try:
            self.writer.close()
        except (OSError, RuntimeError):
            pass
        if wait_stdout:
            await asyncio.gather(self._reader_task, return_exceptions=True)
        elif drain_stdout and not self._reader_task.done():
            if not self._draining_stdout:
                self._draining_stdout = True
                self._reader_task.cancel()
                await asyncio.gather(self._reader_task, return_exceptions=True)
                self._reader_task = asyncio.create_task(
                    self._discard_stdout(), name=f"lightcraft-stdout-drain-{self.generation}")
        elif not self._draining_stdout:
            self._reader_task.cancel()
            await asyncio.gather(self._reader_task, return_exceptions=True)
