"""Run Uvicorn with publication streams closed before its HTTP task drain."""

import asyncio
import os
from pathlib import Path
from collections.abc import Callable

from uvicorn import Config
from uvicorn.server import Server

from connection_identity import ConnectionIdentityError, identify
import storage


class ThumbnailShutdownServer(Server):
    def __init__(self, config, *, before_drain: Callable[[], None] | None = None):
        super().__init__(config)
        if before_drain is None:
            from main import begin_server_shutdown
            before_drain = begin_server_shutdown
        self.before_drain = before_drain

    async def shutdown(self, sockets=None):
        # Uvicorn drains active HTTP tasks before ASGI lifespan shutdown; SSE must end first.
        self.before_drain()
        await super().shutdown(sockets)


def configure_docker_storage(url: str | None = None, key: str | None = None) -> str | None:
    storage.clear_profile(Path("/genzoroom"))
    url = os.getenv("IMMICH_URL", "").strip() if url is None else url.strip()
    key = os.getenv("IMMICH_API_KEY", "") if key is None else key
    key = key or ""
    if url or key.strip():
        if not url or not key.strip():
            raise RuntimeError("immich_connection_incomplete")
        try:
            normalized_url, user_id = asyncio.run(identify(url, key))
        except ConnectionIdentityError as error:
            raise RuntimeError(f"immich_{error.code}") from None
        storage.configure_profile(Path("/genzoroom"), normalized_url, user_id)
    else:
        # A disconnected Docker instance can serve health/UI routes but must not open shared state.
        storage.clear_profile(Path("/genzoroom"))
        return None
    return storage.PROFILE_ID


def main():
    configure_docker_storage()

    from main import app
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
