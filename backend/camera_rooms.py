from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect


LOGGER = logging.getLogger("emberwatch.camera_rooms")
ROOM_TTL_SECONDS = 600
MAX_VIEWERS_PER_ROOM = 3
SIGNAL_TYPES = {"offer", "answer", "ice"}


def ice_servers(expires_at: float) -> list[dict[str, Any]]:
    servers: list[dict[str, Any]] = []
    stun_urls = [
        item.strip()
        for item in os.getenv("WEBRTC_STUN_URLS", "stun:stun.l.google.com:19302").split(",")
        if item.strip()
    ]
    turn_urls = [
        item.strip()
        for item in os.getenv("WEBRTC_TURN_URLS", "").split(",")
        if item.strip()
    ]
    if stun_urls:
        servers.append({"urls": stun_urls})
    if turn_urls:
        shared_secret = os.getenv("WEBRTC_TURN_SHARED_SECRET")
        username_prefix = os.getenv("WEBRTC_TURN_USERNAME", "emberwatch").strip()
        if not shared_secret or not username_prefix:
            raise RuntimeError(
                "Set WEBRTC_TURN_SHARED_SECRET and WEBRTC_TURN_USERNAME when configuring TURN."
            )
        username = f"{int(expires_at)}:{username_prefix}"
        credential = base64.b64encode(
            hmac.new(
                shared_secret.encode("utf-8"),
                username.encode("utf-8"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        servers.append(
            {"urls": turn_urls, "username": username, "credential": credential}
        )
    return servers


@dataclass
class CameraRoom:
    room_id: str
    owner_token: str
    viewer_token: str
    expires_at: float
    ice_servers: list[dict[str, Any]]
    owner: WebSocket | None = None
    viewers: dict[str, WebSocket] = field(default_factory=dict)


class CameraRoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, CameraRoom] = {}
        self._lock = asyncio.Lock()

    async def create(self) -> dict[str, Any]:
        expires_at = time.time() + ROOM_TTL_SECONDS
        servers = ice_servers(expires_at)
        async with self._lock:
            self._purge_expired()
            room_id = secrets.token_urlsafe(8)
            room = CameraRoom(
                room_id=room_id,
                owner_token=secrets.token_urlsafe(32),
                viewer_token=secrets.token_urlsafe(32),
                expires_at=expires_at,
                ice_servers=servers,
            )
            self._rooms[room_id] = room
        return {
            "room_id": room.room_id,
            "owner_token": room.owner_token,
            "viewer_token": room.viewer_token,
            "expires_at": int(room.expires_at),
            "ttl_seconds": ROOM_TTL_SECONDS,
            "max_viewers": MAX_VIEWERS_PER_ROOM,
            "ice_servers": servers,
            "turn_configured": any(
                any(url.startswith(("turn:", "turns:")) for url in server["urls"])
                for server in servers
            ),
        }

    async def viewer_configuration(
        self, room_id: str, viewer_token: str
    ) -> dict[str, Any] | None:
        async with self._lock:
            self._purge_expired()
            room = self._rooms.get(room_id)
            if room is None or not secrets.compare_digest(room.viewer_token, viewer_token):
                return None
            return {
                "room_id": room.room_id,
                "expires_at": int(room.expires_at),
                "ice_servers": room.ice_servers,
                "turn_configured": any(
                    any(url.startswith(("turn:", "turns:")) for url in server["urls"])
                    for server in room.ice_servers
                ),
            }

    def _purge_expired(self) -> None:
        now = time.time()
        for room_id in [
            room_id
            for room_id, room in self._rooms.items()
            if room.expires_at <= now
        ]:
            del self._rooms[room_id]

    async def close(self, room_id: str, owner_token: str) -> bool:
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None or not secrets.compare_digest(room.owner_token, owner_token):
                return False
            del self._rooms[room_id]
        for viewer in list(room.viewers.values()):
            try:
                await viewer.send_json({"type": "room_closed"})
                await viewer.close(code=1000)
            except (WebSocketDisconnect, RuntimeError):
                LOGGER.debug("Viewer disconnected while camera room was closing.")
        if room.owner is not None:
            try:
                await room.owner.send_json({"type": "room_closed"})
                await room.owner.close(code=1000)
            except (WebSocketDisconnect, RuntimeError):
                LOGGER.debug("Owner disconnected while camera room was closing.")
        return True

    async def serve(self, websocket: WebSocket, room_id: str) -> None:
        await websocket.accept()
        try:
            auth = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except (asyncio.TimeoutError, ValueError, WebSocketDisconnect):
            await websocket.close(code=4401, reason="Send pairing credentials to connect.")
            return
        if not isinstance(auth, dict) or auth.get("type") != "auth":
            await websocket.close(code=4401, reason="Invalid pairing message.")
            return

        replaced_owner: WebSocket | None = None
        async with self._lock:
            self._purge_expired()
            room = self._rooms.get(room_id)
            token = auth.get("token")
            role = ""
            if room is not None and isinstance(token, str):
                if secrets.compare_digest(room.owner_token, token):
                    role = "owner"
                elif secrets.compare_digest(room.viewer_token, token):
                    role = "viewer"
            if not role:
                room = None
                peer_id = ""
            elif role == "owner":
                if room.owner is not None and room.owner is not websocket:
                    replaced_owner = room.owner
                room.owner = websocket
                peer_id = "owner"
            elif len(room.viewers) >= MAX_VIEWERS_PER_ROOM:
                room = None
                peer_id = ""
            else:
                peer_id = secrets.token_urlsafe(8)
                room.viewers[peer_id] = websocket
        if room is None:
            await websocket.close(
                code=4403,
                reason="Pairing expired, invalid, or the room is full.",
            )
            return
        if replaced_owner is not None:
            try:
                await replaced_owner.close(code=4001, reason="Owner session replaced.")
            except (WebSocketDisconnect, RuntimeError):
                LOGGER.debug("Previous owner disconnected during reconnection.")

        try:
            await websocket.send_json(
                {"type": "authenticated", "role": role, "peer_id": peer_id}
            )
            if role == "owner":
                for viewer_id, viewer in list(room.viewers.items()):
                    await websocket.send_json(
                        {"type": "viewer_joined", "peer_id": viewer_id}
                    )
                    try:
                        await viewer.send_json({"type": "owner_ready"})
                    except (WebSocketDisconnect, RuntimeError):
                        LOGGER.debug("Viewer disconnected during owner reconnection.")
            elif room.owner is not None:
                await room.owner.send_json({"type": "viewer_joined", "peer_id": peer_id})
                await websocket.send_json({"type": "owner_ready"})
            else:
                await websocket.send_json({"type": "waiting_for_owner"})

            while time.time() < room.expires_at:
                try:
                    message = await asyncio.wait_for(
                        websocket.receive_json(),
                        timeout=max(0.1, min(30, room.expires_at - time.time())),
                    )
                except asyncio.TimeoutError:
                    if time.time() >= room.expires_at:
                        break
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "close" and role == "owner":
                    await self.close(room_id, room.owner_token)
                    return
                message_type = message.get("type")
                if message_type not in SIGNAL_TYPES:
                    continue
                payload_key = "candidate" if message_type == "ice" else "description"
                payload = message.get(payload_key)
                if not isinstance(payload, dict) or len(str(payload)) > 65536:
                    continue
                target_id = message.get("peer_id")
                async with self._lock:
                    current = self._rooms.get(room_id)
                    if current is not room:
                        return
                    if role == "owner":
                        target = room.viewers.get(target_id) if isinstance(target_id, str) else None
                    else:
                        target = room.owner if target_id in {"owner", None} else None
                    source_id = peer_id
                if target is not None:
                    await target.send_json(
                        {
                            "type": message_type,
                            "peer_id": source_id,
                            payload_key: payload,
                        }
                    )
        except WebSocketDisconnect:
            LOGGER.debug("Camera signaling peer disconnected.")
        except (RuntimeError, ValueError, OSError):
            LOGGER.exception("Camera signaling failed for room %s.", room_id)
        finally:
            owner_disconnected_viewers: list[WebSocket] = []
            viewer_disconnected_owner: WebSocket | None = None
            async with self._lock:
                if self._rooms.get(room_id) is room:
                    if role == "owner" and room.owner is websocket:
                        room.owner = None
                        owner_disconnected_viewers = list(room.viewers.values())
                    elif role == "viewer":
                        room.viewers.pop(peer_id, None)
                        viewer_disconnected_owner = room.owner
            for viewer in owner_disconnected_viewers:
                try:
                    await viewer.send_json({"type": "owner_disconnected"})
                except (WebSocketDisconnect, RuntimeError):
                    LOGGER.debug("Viewer disconnected while notifying owner loss.")
            if viewer_disconnected_owner is not None:
                try:
                    await viewer_disconnected_owner.send_json(
                        {"type": "viewer_left", "peer_id": peer_id}
                    )
                except (WebSocketDisconnect, RuntimeError):
                    LOGGER.debug("Owner disconnected while notifying viewer loss.")


rooms = CameraRoomManager()
