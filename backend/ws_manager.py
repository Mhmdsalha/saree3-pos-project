from datetime import date, datetime
from decimal import Decimal

from fastapi import WebSocket
import json


def _json_default(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")

class ConnectionManager:
    def __init__(self):
        # user_id -> {session_token -> [websockets]}
        self.active: dict[int, dict[str, list[WebSocket]]] = {}
        self.socket_types: dict[WebSocket, str] = {}

    async def connect(self, websocket: WebSocket, user_id: int, session_token: str):
        await websocket.accept()
        if user_id not in self.active:
            self.active[user_id] = {}
        if session_token not in self.active[user_id]:
            self.active[user_id][session_token] = []
        self.active[user_id][session_token].append(websocket)
        self.socket_types[websocket] = "unknown"

    def mark_client_type(self, websocket: WebSocket, client_type: str):
        self.socket_types[websocket] = client_type

    def get_client_type(self, websocket: WebSocket) -> str:
        return self.socket_types.get(websocket, "unknown")

    def disconnect(self, websocket: WebSocket):
        dead_users = []
        for user_id, sessions in list(self.active.items()):
            dead_sessions = []
            for session_token, sockets in list(sessions.items()):
                if websocket in sockets:
                    sockets.remove(websocket)
                if not sockets:
                    dead_sessions.append(session_token)
            for session_token in dead_sessions:
                sessions.pop(session_token, None)
            if not sessions:
                dead_users.append(user_id)
        for user_id in dead_users:
            self.active.pop(user_id, None)
        self.socket_types.pop(websocket, None)

    def has_session_connections(self, user_id: int, session_token: str) -> bool:
        return bool(self.active.get(user_id, {}).get(session_token))

    def has_client_type_connections(self, user_id: int, session_token: str, client_type: str) -> bool:
        sockets = self.active.get(user_id, {}).get(session_token, [])
        return any(self.socket_types.get(ws) == client_type for ws in sockets)

    def _cleanup_dead(self, user_id: int, dead: list[tuple[str, WebSocket]]):
        for session_token, ws in dead:
            try:
                self.active[user_id][session_token].remove(ws)
            except Exception:
                pass

        # cleanup empty buckets
        for session_token in list(self.active.get(user_id, {}).keys()):
            if not self.active[user_id][session_token]:
                self.active[user_id].pop(session_token, None)
        if user_id in self.active and not self.active[user_id]:
            self.active.pop(user_id, None)

    async def send_to_user(self, user_id: int, data: dict):
        if user_id not in self.active:
            return

        dead: list[tuple[str, WebSocket]] = []
        payload = json.dumps(data, ensure_ascii=False, default=_json_default)
        for session_token, sockets in list(self.active[user_id].items()):
            for ws in list(sockets):
                try:
                    await ws.send_text(payload)
                except Exception:
                    dead.append((session_token, ws))

        self._cleanup_dead(user_id, dead)

    async def send_to_session(self, user_id: int, session_token: str, data: dict):
        sessions = self.active.get(user_id, {})
        sockets = list(sessions.get(session_token, []))
        if not sockets:
            return

        dead: list[tuple[str, WebSocket]] = []
        payload = json.dumps(data, ensure_ascii=False, default=_json_default)
        for ws in sockets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append((session_token, ws))

        self._cleanup_dead(user_id, dead)

    async def broadcast_to_cashier(self, user_id: int, data: dict):
        await self.send_to_user(user_id, data)

    async def broadcast_all(self, data: dict):
        for user_id in list(self.active.keys()):
            await self.send_to_user(user_id, data)
