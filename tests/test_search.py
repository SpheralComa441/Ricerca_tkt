"""Ricerca sul motore demo: una sola richiesta per ricerca, limite di Zucchetti rispettato."""
import asyncio
import copy
from datetime import date

import pytest

from app.connectors import demo_engine
from app.connectors.demo import DemoConnector, DemoSession, get_index
from app.models import SearchSpec
from app.query import Profile
from app.search import TTLCache, run_search

SIZE = 12000


@pytest.fixture(scope="module")
def index():
    return get_index(SIZE)


class CountingSession(DemoSession):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    async def search_raw(self, query, core, area, langs):
        self.calls.append(query)
        return await super().search_raw(query, core, area, langs)


def run(session, profile, spec, cache=None):
    events = []

    async def emit(ev):
        events.append(ev)

    stats = asyncio.run(run_search(session, profile, spec, emit, cache=cache))
    tickets = [t for e in events if e["type"] == "batch" for t in e["tickets"]]
    return stats, tickets, events


def count_matching(index, pred):
    return sum(1 for d in index.docs if pred(d))


def test_demo_query_language(index):
    docs, _ = index.search('(detassazione OR "premio di risultato") AND NOT TKSTATO:Aperto', 10**6)
    assert docs and all(d.stato != "Aperto" for d in docs)
    docs, _ = index.search("TKNUMERO:[0 TO *] AND TKPRODOTTO:PAGHEW", 10**6)
    assert len(docs) == count_matching(index, lambda d: d.product == "PAGHEW")
    docs, _ = index.search("detass*", 10**6)
    assert len(docs) == count_matching(index, lambda d: "detassazione" in d.all_tokens)
    with pytest.raises(demo_engine.QuerySyntaxError):
        index.search("(a OR", 10)


def test_capped_search_makes_one_request(zcfg, index):
    conn = DemoConnector(zcfg, SIZE, 0)
    profile = Profile(conn.profile_data())
    session = CountingSession("t", index, 0)
    assert count_matching(index, lambda d: "cedolino" in d.all_tokens) > 210

    stats, tickets, events = run(session, profile, SearchSpec(text="cedolino"))
    assert len(session.calls) == 1
    assert stats["requests"] == 1
    assert stats["capped"] is True and stats["cap"] == 210
    assert len(tickets) == 210 == stats["found"]
    assert len({t["key"] for t in tickets}) == 210
    assert [e["type"] for e in events] == ["start", "batch", "done"]


def test_uncapped_search(zcfg, index):
    profile = Profile(DemoConnector(zcfg, SIZE, 0).profile_data())
    session = CountingSession("t", index, 0)
    spec = SearchSpec(text="cedolino", products_in=["730WEB"], date_from=date(2025, 1, 1), date_to=date(2025, 12, 31))
    stats, tickets, _ = run(session, profile, spec)
    expected = count_matching(index, lambda d: "cedolino" in d.all_tokens and d.product == "730WEB"
                              and d.date.year == 2025)
    assert 0 < expected < 210
    assert len(tickets) == expected and stats["capped"] is False
    assert len(session.calls) == 1


def test_cache_avoids_second_request(zcfg, index):
    profile = Profile(DemoConnector(zcfg, SIZE, 0).profile_data())
    session = CountingSession("t", index, 0)
    cache = TTLCache(600)
    run(session, profile, SearchSpec(text="tfr"), cache)
    stats, tickets, _ = run(session, profile, SearchSpec(text="tfr"), cache)
    assert len(session.calls) == 1
    assert stats["requests"] == 0 and stats["cache_hits"] == 1 and tickets


def test_phrase_strategy_date_with_post_filter(zcfg, index):
    """Profilo come quello reale: nessun campo mappato, periodo cercato come data nel titolo."""
    profile = Profile(copy.deepcopy(zcfg))
    assert profile.date_strategy == "phrase"
    session = CountingSession("t", index, 0)
    spec = SearchSpec(text="cedolino", date_from=date(2025, 3, 10), date_to=date(2025, 4, 30))
    stats, tickets, events = run(session, profile, spec)

    assert len(session.calls) == 1
    assert events[0]["query"].startswith('(cedolino) AND ("10-03-2025" OR "11-03-2025"')
    assert events[0]["query"].endswith('"31-03-2025" OR "04-2025")')
    assert tickets
    assert all("2025-03-10" <= t["date"] <= "2025-04-30" for t in tickets)
    expected = count_matching(
        index, lambda d: "cedolino" in d.all_tokens and date(2025, 3, 10) <= d.date <= date(2025, 4, 30)
    )
    if not stats["capped"]:
        assert len(tickets) == expected


def test_post_filter_discards_out_of_range(zcfg, index):
    """Un ticket che cita la data solo nel testo viene scartato dal filtro locale."""
    profile = Profile(copy.deepcopy(zcfg))
    session = CountingSession("t", index, 0)
    spec = SearchSpec(text="2024", date_from=date(2025, 1, 1), date_to=date(2025, 12, 31))
    stats, tickets, _ = run(session, profile, spec)
    assert all(t["date"].startswith("2025") for t in tickets)
    assert stats["found"] == len(tickets)
