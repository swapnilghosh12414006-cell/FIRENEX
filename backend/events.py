import asyncio

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect


class EventHub:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, event: dict) -> None:
        async with self._lock:
            connections = tuple(self._connections)
        if not connections:
            return
        results = await asyncio.gather(
            *(connection.send_json(event) for connection in connections),
            return_exceptions=True,
        )
        failed = [
            connection
            for connection, result in zip(connections, results)
            if isinstance(result, Exception)
        ]
        if failed:
            async with self._lock:
                for connection in failed:
                    self._connections.discard(connection)


hub = EventHub()
