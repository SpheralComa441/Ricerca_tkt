"""Sessioni utente dell'applicazione (in memoria).

Ogni sessione conserva la sessione autenticata verso il connettore (cookie
Zucchetti), mai la password. Le sessioni inattive scadono automaticamente.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Optional

from .connectors.base import ConnectorSession
from .search import TTLCache


@dataclass
class AppSession:
    sid: str
    connector_id: str
    username: str
    remote: ConnectorSession
    cache: TTLCache
    created: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)
    active_search: Optional[asyncio.Task] = None

    @property
    def user_key(self) -> str:
        return f"{self.connector_id}:{self.username.strip().lower()}"


class SessionStore:
    def __init__(self, idle_minutes: int, max_sessions: int, cache_ttl: int):
        self.idle = idle_minutes * 60
        self.max_sessions = max_sessions
        self.cache_ttl = cache_ttl
        self._sessions: dict[str, AppSession] = {}

    def create(self, connector_id: str, username: str, remote: ConnectorSession) -> AppSession:
        sid = secrets.token_urlsafe(32)
        s = AppSession(sid, connector_id, username, remote, TTLCache(self.cache_ttl))
        self._sessions[sid] = s
        return s

    def get(self, sid: Optional[str]) -> Optional[AppSession]:
        if not sid:
            return None
        s = self._sessions.get(sid)
        if s is None:
            return None
        if time.time() - s.last_used > self.idle:
            return None
        s.last_used = time.time()
        return s

    async def destroy(self, sid: str) -> None:
        s = self._sessions.pop(sid, None)
        if s:
            if s.active_search and not s.active_search.done():
                s.active_search.cancel()
            await s.remote.aclose()

    async def enforce_limit(self) -> None:
        if len(self._sessions) <= self.max_sessions:
            return
        oldest = sorted(self._sessions.values(), key=lambda s: s.last_used)
        for s in oldest[: len(self._sessions) - self.max_sessions]:
            await self.destroy(s.sid)

    async def cleanup(self) -> None:
        now = time.time()
        for sid in [k for k, s in self._sessions.items() if now - s.last_used > self.idle]:
            await self.destroy(sid)

    async def close_all(self) -> None:
        for sid in list(self._sessions):
            await self.destroy(sid)

    def __len__(self) -> int:
        return len(self._sessions)
