import asyncio
import socket
from contextlib import asynccontextmanager

import httpx
import main
from fastapi import FastAPI
from run_server import ThumbnailShutdownServer
from thumbnail_publication import ThumbnailPublicationHub
from uvicorn import Config


def test_uvicorn_shutdown_drains_sse_before_asgi_lifespan():
    async def run():
        hub = ThumbnailPublicationHub()
        lifespan_finished = asyncio.Event()

        @asynccontextmanager
        async def lifespan(app):
            app.state.thumbnail_publication_hub = hub
            yield
            lifespan_finished.set()

        app = FastAPI(lifespan=lifespan)
        app.add_api_route("/thumbnail-publications/events", main.thumbnail_publication_events)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        listener.setblocking(False)
        port = listener.getsockname()[1]
        server = ThumbnailShutdownServer(Config(app, lifespan="on", log_config=None, access_log=False),
                                         before_drain=hub.begin_shutdown)
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(200):
                if server.started or server_task.done():
                    break
                await asyncio.sleep(0.01)
            assert server.started, f"uvicorn startup failed: {server_task.exception() if server_task.done() else 'pending'}"

            async def hold_sse():
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", f"http://127.0.0.1:{port}/thumbnail-publications/events") as response:
                        assert response.status_code == 200
                        return await response.aread()

            request_task = asyncio.create_task(hold_sse())
            for _ in range(200):
                if hub._subscribers:
                    break
                await asyncio.sleep(0.01)
            assert len(hub._subscribers) == 1

            server.should_exit = True
            await asyncio.wait_for(server_task, timeout=5)
            body = await asyncio.wait_for(request_task, timeout=5)
            assert b": connected" in body
            assert lifespan_finished.is_set()
            assert not hub._subscribers
        finally:
            server.should_exit = True
            if not server_task.done():
                try:
                    await asyncio.wait_for(server_task, timeout=2)
                except TimeoutError:
                    server_task.cancel()

    asyncio.run(run())
