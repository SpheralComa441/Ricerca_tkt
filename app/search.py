"""Esecuzione delle ricerche, compresa la ricerca estesa oltre il limite di risultati.

Zucchetti restituisce al massimo N risultati (tipicamente 210, "i più rilevanti").
La ricerca estesa suddivide il periodo in finestre (anno → mese → settimana →
giorno) e, se una finestra è ancora al limite, la suddivide ulteriormente; a
livello di giorno può proseguire "per esclusione" (ripete la query escludendo i
numeri di ticket già trovati). I risultati sono uniti senza duplicati.
"""
from __future__ import annotations

import asyncio
import calendar
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Awaitable, Callable, Optional

from .connectors.base import ConnectorSession
from .models import ParsedResponse, SearchSpec, Ticket
from .parser import parse_response
from .query import BuiltQuery, Profile, build_query, date_clause, number_exclusion_clause

Emit = Callable[[dict], Awaitable[None]]
MAX_IN_FLIGHT = 4


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


# ---------------------------------------------------------------------------
# Finestre temporali
# ---------------------------------------------------------------------------

LEVELS = ["year", "month", "part", "day"]


@dataclass
class Window:
    start: date
    end: date
    level: str
    excluded: list = field(default_factory=list)
    round: int = 0

    @property
    def label(self) -> str:
        if self.level == "year":
            base = f"{self.start.year}"
            if self.start != date(self.start.year, 1, 1) or self.end != date(self.start.year, 12, 31):
                base = f"{self.start:%d/%m}–{self.end:%d/%m/%Y}"
        elif self.level == "month":
            base = f"{self.start:%m/%Y}"
            last = calendar.monthrange(self.start.year, self.start.month)[1]
            if self.start.day != 1 or self.end.day != last:
                base = f"{self.start:%d}–{self.end:%d/%m/%Y}"
        elif self.level == "part":
            base = f"{self.start:%d}–{self.end:%d/%m/%Y}"
        else:
            base = f"{self.start:%d/%m/%Y}"
        return base + (f" (pag. {self.round + 1})" if self.round else "")

    def children(self) -> list["Window"]:
        out: list[Window] = []
        if self.level == "year":
            d = self.start
            while d <= self.end:
                last = date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])
                out.append(Window(d, min(last, self.end), "month"))
                d = last + timedelta(days=1)
        elif self.level == "month":
            bounds = [(1, 8), (9, 16), (17, 24), (25, 31)]
            last_day = calendar.monthrange(self.start.year, self.start.month)[1]
            for a, b in bounds:
                s = max(self.start, self.start.replace(day=min(a, last_day)))
                e = min(self.end, self.start.replace(day=min(b, last_day)))
                if s <= e and (not out or s > out[-1].end):
                    out.append(Window(s, e, "part"))
        elif self.level == "part":
            d = self.start
            while d <= self.end:
                out.append(Window(d, d, "day"))
                d += timedelta(days=1)
        return out


def initial_windows(start: date, end: date, split: str) -> list[Window]:
    level = {"auto": "year", "year": "year", "month": "month", "day": "day"}.get(split, "year")
    out: list[Window] = []
    if level == "year":
        for y in range(start.year, end.year + 1):
            out.append(Window(max(start, date(y, 1, 1)), min(end, date(y, 12, 31)), "year"))
    elif level == "month":
        for y in range(start.year, end.year + 1):
            year = Window(max(start, date(y, 1, 1)), min(end, date(y, 12, 31)), "year")
            out.extend(year.children())
    else:
        d = start
        while d <= end:
            out.append(Window(d, d, "day"))
            d += timedelta(days=1)
    out.sort(key=lambda w: w.start, reverse=True)  # i periodi recenti per primi
    return out


# ---------------------------------------------------------------------------
# Esecuzione
# ---------------------------------------------------------------------------


@dataclass
class _Request:
    query: str
    label: str
    window: Optional[Window] = None


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
        self.seen: dict[str, Ticket] = {}
        self.filtered_keys: set = set()
        self.requests = 0
        self.cache_hits = 0
        self.capped_labels: list[str] = []
        self.upstream_errors: list[str] = []
        self.max_excl = int(profile.strategies.get("max_exclusions", 800))

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

    async def merge(self, resp: ParsedResponse, label: str) -> int:
        new: list[Ticket] = []
        for t in resp.tickets:
            if t.key in self.seen or t.key in self.filtered_keys:
                continue
            if not self.built.post.accepts(t):
                self.filtered_keys.add(t.key)
                continue
            t.rank = len(self.seen)
            t.window = label
            self.seen[t.key] = t
            new.append(t)
        for e in resp.errors:
            if e not in self.upstream_errors:
                self.upstream_errors.append(e)
                await self.emit({"type": "warning", "message": f"Zucchetti: {e}"})
        if new:
            await self.emit({"type": "batch", "label": label, "tickets": [t.to_dict() for t in new]})
        return len(new)

    def _window_query(self, w: Window) -> str:
        extra = [date_clause(self.profile, w.start, w.end)]
        excl = number_exclusion_clause(self.profile, w.excluded)
        if excl:
            extra.append(excl)
        return self.built.compose(extra=[e for e in extra if e], with_date=False)

    def _base_paging_query(self, excluded: list) -> str:
        excl = number_exclusion_clause(self.profile, excluded)
        return self.built.compose(extra=[excl] if excl else [])

    async def run(self) -> dict:
        t0 = time.monotonic()
        spec = self.spec
        base_q = self.built.query
        hard = int(self.profile.extended.get("max_requests_hard_limit", 200))
        budget = max(1, min(spec.extended.max_requests, hard)) if spec.extended.enabled else 1

        plan = "base"
        use_windows = (
            spec.extended.enabled
            and spec.extended.split != "none"
            and self.profile.date_strategy in ("phrase", "field")
        )
        if spec.extended.enabled:
            plan = "windows" if use_windows else ("paging" if spec.extended.deep_paging else "base")
        await self.emit({
            "type": "start", "query": base_q, "warnings": self.built.warnings, "plan": plan,
            "budget": budget, "cap": self.profile.cap,
        })

        base = await self.fetch(base_q)
        await self.merge(base, "Ricerca principale")
        base_capped = base.capped
        unexplored = 0

        if spec.extended.enabled and base_capped and budget > 1:
            queue: list[_Request] = []
            if use_windows:
                earliest = date(int(self.profile.extended.get("earliest_year", 2010)), 1, 1)
                start = spec.date_from or earliest
                end = spec.date_to or date.today()
                if start <= end:
                    for w in initial_windows(start, end, spec.extended.split):
                        queue.append(_Request(self._window_query(w), w.label, w))
            elif spec.extended.deep_paging:
                excluded = [t.number for t in base.tickets if t.number is not None]
                if excluded:
                    queue.append(_Request(self._base_paging_query(excluded), "Pagina 2", None))
                    self._paging_excluded = excluded
                    self._paging_round = 1
            unexplored = await self._drain(queue, budget)
        elif base_capped:
            self.capped_labels.append("Ricerca principale")

        stats = {
            "requests": self.requests,
            "cache_hits": self.cache_hits,
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
            "found": len(self.seen),
            "filtered_out": len(self.filtered_keys),
            "capped": self.capped_labels[:100],
            "capped_count": len(self.capped_labels),
            "unexplored": unexplored,
            "budget": budget,
            "base_capped": base_capped,
            "extended": spec.extended.enabled,
            "complete": not self.capped_labels and unexplored == 0,
        }
        await self.emit({"type": "done", "stats": stats})
        return stats

    async def _drain(self, queue: list[_Request], budget: int) -> int:
        running: dict[asyncio.Task, _Request] = {}
        try:
            while queue or running:
                while queue and len(running) < MAX_IN_FLIGHT and self.requests + len(running) < budget:
                    req = queue.pop(0)
                    running[asyncio.create_task(self.fetch(req.query))] = req
                if not running:
                    break  # budget esaurito
                done, _ = await asyncio.wait(running.keys(), return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    req = running.pop(task)
                    resp = task.result()
                    await self.merge(resp, req.label)
                    if resp.capped:
                        queue[:0] = self._follow_up(req, resp)
                    await self.emit({
                        "type": "progress", "requests": self.requests, "budget": budget,
                        "pending": len(queue) + len(running), "found": len(self.seen), "label": req.label,
                    })
            return len(queue)
        finally:
            for task in running:
                task.cancel()

    def _follow_up(self, req: _Request, resp: ParsedResponse) -> list[_Request]:
        w = req.window
        nums = [t.number for t in resp.tickets if t.number is not None]
        if w is None:  # paginazione sulla query principale
            excluded = getattr(self, "_paging_excluded", []) + nums
            if not nums or len(excluded) > self.max_excl:
                self.capped_labels.append(req.label)
                return []
            self._paging_excluded = excluded
            self._paging_round = getattr(self, "_paging_round", 1) + 1
            return [_Request(self._base_paging_query(excluded), f"Pagina {self._paging_round + 1}", None)]
        kids = w.children()
        if kids:
            kids.sort(key=lambda k: k.start, reverse=True)
            return [_Request(self._window_query(k), k.label, k) for k in kids]
        if self.spec.extended.deep_paging and nums:
            excluded = w.excluded + nums
            if len(excluded) <= self.max_excl:
                nw = Window(w.start, w.end, w.level, excluded, w.round + 1)
                return [_Request(self._window_query(nw), nw.label, nw)]
        self.capped_labels.append(req.label)
        return []


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
