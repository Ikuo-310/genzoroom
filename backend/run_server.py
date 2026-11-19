"""Run Uvicorn with publication streams closed before its HTTP task drain."""

import os
from collections.abc import Callable

import uvicorn
from uvicorn import Config
from uvicorn.server import Server

from main import app, begin_server_shutdown


class ThumbnailShutdownServer(Server):
    def __init__(self, config, *, before_drain: Callable[[], None] = begin_server_shutdown):
        super().__init__(config)
        self.before_drain = before_drain

    async def shutdown(self, sockets=None):
        # Uvicorn drains active HTTP tasks before ASGI lifespan shutdown; SSE must end first.
        self.before_drain()
        await super().shutdown(sockets)


def main():
    config = Config(
        app,
        host=os.getenv("GENZOROOM_HOST", "0.0.0.0"),
        port=int(os.getenv("GENZOROOM_PORT", "8000")),
        workers=1,
        proxy_headers=False,
    )
    ThumbnailShutdownServer(config).run()


if __name__ == "__main__":
    main()
