"""Esecuzione delle ricerche.

Ogni ricerca corrisponde a una sola richiesta alla routine Solr di Zucchetti,
che restituisce al massimo N risultati (tipicamente 210, "i più rilevanti").
I risultati vengono verificati con i filtri locali e inviati all'interfaccia.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from typing import Awaitable, Callable, Optional

from .connectors.base import ConnectorSession
from .models import ParsedResponse, SearchSpec, Ticket
from .parser import parse_response
from .query import BuiltQuery, Profile, build_query

Emit = Callable[[dict], Awaitable[None]]


class TTLCache:
    def __init__(self, ttl_seconds: int, max_items: int = 300):
        self.ttl = ttl_seconds
        self.max_items = max_items
        self._data: OrderedDict = OrderedDict()

    def get(self, key):
        item = self._data.get(key)
        if item is None:
            return None
        ts, value = item
        if time.monotonic() - ts > self.ttl:
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)
        return value

    def set(self, key, value):
        if self.ttl <= 0:
            return
        self._data[key] = (time.monotonic(), value)
        self._data.move_to_end(key)
        while len(self._data) > self.max_items:
            self._data.popitem(last=False)


class SearchRun:
    def __init__(
        self,
        session: ConnectorSession,
        profile: Profile,
        spec: SearchSpec,
        built: BuiltQuery,
        cache: Optional[TTLCache],
        emit: Emit,
    ):
        self.session = session
        self.profile = profile
        self.spec = spec
        self.built = built
        self.cache = cache
        self.emit = emit
        pub = profile.public()
        self.core = spec.core if spec.core is not None else pub["default_core"]
        self.area = spec.area if spec.area is not None else pub["default_area"]
        self.langs = spec.langs if spec.langs is not None else pub["default_langs"]
        self.parse_cfg = profile.data.get("parse", {})
        self.requests = 0
        self.cache_hits = 0

    async def fetch(self, query: str) -> ParsedResponse:
        key = (query, self.core, self.area, self.langs)
        if self.cache is not None:
            hit = self.cache.get(key)
            if hit is not None:
                self.cache_hits += 1
                return hit
        self.requests += 1
        raw = await self.session.search_raw(query, self.core, self.area, self.langs)
        parsed = parse_response(raw, self.parse_cfg, self.profile.cap, self.core)
        if self.cache is not None and not parsed.errors:
            self.cache.set(key, parsed)
        return parsed

    async def run(self) -> dict:
        t0 = time.monotonic()
        query = self.built.query
        await self.emit({
            "type": "start", "query": query, "warnings": self.built.warnings, "cap": self.profile.cap,
        })

        resp = await self.fetch(query)

        accepted: list[Ticket] = []
        seen: set = set()
        filtered = 0
        for t in resp.tickets:
            if t.key in seen:
                continue
            seen.add(t.key)
            if not self.built.post.accepts(t):
                filtered += 1
                continue
            t.rank = len(accepted)
            accepted.append(t)

        for e in resp.errors:
            await self.emit({"type": "warning", "message": f"Zucchetti: {e}"})
        if accepted:
            await self.emit({"type": "batch", "tickets": [t.to_dict() for t in accepted]})

        stats = {
            "requests": self.requests,
            "cache_hits": self.cache_hits,
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
            "found": len(accepted),
            "filtered_out": filtered,
            "capped": resp.capped,
            "cap": self.profile.cap,
        }
        await self.emit({"type": "done", "stats": stats})
        return stats


async def run_search(
    session: ConnectorSession,
    profile: Profile,
    spec: SearchSpec,
    emit: Emit,
    cache: Optional[TTLCache] = None,
    built: Optional[BuiltQuery] = None,
) -> dict:
    built = built or build_query(spec, profile)
    return await SearchRun(session, profile, spec, built, cache, emit).run()
