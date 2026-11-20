"""Process-local notification fanout for durable thumbnail publication identities."""

import asyncio
from uuid import uuid4

KEEP_PUBLICATION_VERSION = object()


class ThumbnailPublicationHub:
    def __init__(self, *, queue_size: int = 256):
        self.generation_id = uuid4().hex
        self.sequence = 0
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue] = set()
        self._stopping = False

    @property
    def stopping(self) -> bool:
        return self._stopping

    def position(self) -> tuple[str, int]:
        return self.generation_id, self.sequence

    def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=self._queue_size)
        if self._stopping:
            queue.put_nowait(None)
            return queue
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self._subscribers.discard(queue)

    def begin_shutdown(self):
        """Wake streams before the ASGI server drains active HTTP tasks."""
        if self._stopping:
            return
        self._stopping = True
        for queue in tuple(self._subscribers):
            while not queue.empty():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            queue.put_nowait(None)

    def publish(self, asset_id, state: str, publication_version=KEEP_PUBLICATION_VERSION):
        if self._stopping:
            return
        self.sequence += 1
        event = {"generationId": self.generation_id, "sequence": self.sequence,
                 "assetId": str(asset_id), "state": state}
        if publication_version is not KEEP_PUBLICATION_VERSION:
            event["publicationVersion"] = publication_version
        for queue in tuple(self._subscribers):
            if queue.full():
                while not queue.empty():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                queue.put_nowait({"generationId": self.generation_id, "sequence": self.sequence,
                                  "type": "resync"})
            else:
                queue.put_nowait(event)
