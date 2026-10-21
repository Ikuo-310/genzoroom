"""Bounded JSON-lines MCP transport; process ownership belongs to the runtime."""

import asyncio
import json


MAX_LINE_BYTES = 1024 * 1024
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
    def __init__(self):
        super().__init__("lightcraft_tool_error")


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
        self._error = None
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
                    break
                except asyncio.IncompleteReadError as error:
                    code = "lightcraft_truncated_response" if error.partial else "lightcraft_eof"
                    break
                if len(line) > MAX_LINE_BYTES:
                    code = "lightcraft_response_too_large"
                    break
                if not line.strip():
                    continue
                try:
                    # Parsing a bounded but potentially large frame must not stall ASGI.
                    message = await asyncio.to_thread(_decode, line)
                except UnicodeDecodeError:
                    code = "lightcraft_invalid_utf8"
                    break
                except (ValueError, RecursionError):
                    code = "lightcraft_invalid_json"
                    break
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    code = "lightcraft_invalid_response"
                    break
                if "id" not in message:
                    if not isinstance(message.get("method"), str) or \
                            not isinstance(message.get("params", {}), dict) or \
                            "result" in message or "error" in message:
                        code = "lightcraft_invalid_notification"
                        break
                    # Notifications (including progress text) are never responses or logs.
                    continue
                request_id = message["id"]
                if type(request_id) is not str or request_id not in self._pending:
                    code = "lightcraft_unknown_id"
                    break
                future = self._pending[request_id]
                if future.done():
                    code = "lightcraft_duplicate_response"
                    break
                if "method" in message or ("result" in message) == ("error" in message):
                    code = "lightcraft_invalid_response"
                    break
                if "error" in message:
                    error = message["error"]
                    if not isinstance(error, dict) or type(error.get("code")) is not int or \
                            not isinstance(error.get("message"), str):
                        code = "lightcraft_invalid_response"
                        break
                    future.set_exception(MCPRpcError(error["code"]))
                else:
                    future.set_result(message["result"])
        except asyncio.CancelledError:
            return
        except Exception:
            pass
        self.abort(code)

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

    async def request(self, method, params=None, *, timeout=5):
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
        result = await self.request("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)
        if not isinstance(result, dict) or type(result.get("isError")) is not bool or \
                not isinstance(result.get("content"), list):
            self.abort("lightcraft_invalid_tool_response")
            raise MCPTransportError("lightcraft_invalid_tool_response")
        if result["isError"]:
            raise MCPToolError()
        return result.get("structuredContent")

    async def close(self):
        self.abort()
        self._reader_task.cancel()
        await asyncio.gather(self._reader_task, return_exceptions=True)
        try:
            self.writer.close()
        except (OSError, RuntimeError):
            pass
