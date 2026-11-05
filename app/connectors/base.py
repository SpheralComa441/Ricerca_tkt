"""Interfaccia comune dei connettori."""
from __future__ import annotations

import asyncio
import time
from typing import Optional


class LoginFailed(Exception):
    """Credenziali errate o login non riuscito."""


class SessionExpired(Exception):
    """La sessione verso il sistema remoto non è più valida."""


class UpstreamError(Exception):
    """Errore del sistema remoto (rete, HTTP, formato)."""

    def __init__(self, message: str, detail: str = ""):
        super().__init__(message)
        self.detail = detail


class Throttle:
    """Limita concorrenza e frequenza delle richieste verso il sistema remoto."""

    def __init__(self, max_concurrency: int, min_interval_ms: int):
        self.sem = asyncio.Semaphore(max(1, max_concurrency))
        self.min_interval = max(0, min_interval_ms) / 1000.0
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def __aenter__(self):
        await self.sem.acquire()
        if self.min_interval:
            async with self._lock:
                wait = self._last + self.min_interval - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                self._last = time.monotonic()
        return self

    async def __aexit__(self, *exc):
        self.sem.release()


class ConnectorSession:
    """Sessione autenticata di un utente verso un connettore."""

    connector_id: str = ""
    username: str = ""

    async def search_raw(self, query: str, core: str, area: str, langs: str) -> str:
        raise NotImplementedError

    async def suggest(self, prefix: str) -> list[str]:
        return []

    def describe_request(self, query: str, core: str, area: str, langs: str) -> dict:
        return {"query": query}

    async def aclose(self) -> None:
        return None


class Connector:
    id: str = ""
    label: str = ""

    def profile_data(self) -> dict:
        raise NotImplementedError

    async def login(self, username: str, password: str) -> ConnectorSession:
        raise NotImplementedError

    async def login_with_cookie(self, cookie: str, label: str) -> ConnectorSession:
        raise LoginFailed("Accesso tramite cookie non supportato da questo connettore")

    def public(self) -> dict:
        return {"id": self.id, "label": self.label, "cookie_login": False, "hint": ""}

    def ticket_page(self, number: int) -> Optional[dict]:
        return None
