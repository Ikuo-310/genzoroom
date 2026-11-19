"""Process-local notification fanout for durable thumbnail publication identities."""

import asyncio
from uuid import uuid4


class ThumbnailPublicationHub:
    def __init__(self, *, queue_size: int = 256):
        self.generation_id = uuid4().hex
        self.sequence = 0
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue] = set()

    def position(self) -> tuple[str, int]:
        return self.generation_id, self.sequence

    def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self._subscribers.discard(queue)

    def publish(self, asset_id, state: str, publication_version: str | None):
        self.sequence += 1
        event = {"generationId": self.generation_id, "sequence": self.sequence,
                 "assetId": str(asset_id), "state": state,
                 "publicationVersion": publication_version}
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
