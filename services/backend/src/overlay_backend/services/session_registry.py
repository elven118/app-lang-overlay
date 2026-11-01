from __future__ import annotations

import asyncio

from ..domain import ClientSession, ProtocolError


class SessionRegistry:
    """Keeps session state isolated across concurrent WebSocket clients."""

    def __init__(self) -> None:
        self._sessions: dict[str, ClientSession] = {}
        self._lock = asyncio.Lock()

    async def create(self, session: ClientSession) -> ClientSession:
        async with self._lock:
            if session.session_id in self._sessions:
                raise ProtocolError("session_exists", "A session with this ID already exists")
            self._sessions[session.session_id] = session
            return session

    def get(self, session_id: str) -> ClientSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise ProtocolError("session_missing", "Start the session before sending frames")
        return session

    async def remove(self, session_id: str) -> None:
        async with self._lock:
            self._sessions.pop(session_id, None)

    def __len__(self) -> int:
        return len(self._sessions)
