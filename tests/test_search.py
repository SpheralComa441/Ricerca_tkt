"""Ricerca estesa sul motore demo, anche con la strategia "phrase" usata di default per Zucchetti."""
import asyncio
import copy
from datetime import date

import pytest

from app.connectors import demo_engine
from app.connectors.demo import DemoConnector, DemoSession, get_index
from app.models import SearchSpec
from app.query import Profile
from app.search import Window, initial_windows, run_search

SIZE = 12000


@pytest.fixture(scope="module")
def index():
    return get_index(SIZE)


def run(session, profile, spec):
    events = []

    async def emit(ev):
        events.append(ev)

    stats = asyncio.run(run_search(session, profile, spec, emit))
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


def test_extended_field_strategy_finds_everything(zcfg, index):
    conn = DemoConnector(zcfg, SIZE, 0)
    profile = Profile(conn.profile_data())
    session = DemoSession("t", index, 0)
    expected = count_matching(index, lambda d: "cedolino" in d.all_tokens)
    assert expected > 210

    stats, tickets, _ = run(session, profile, SearchSpec(text="cedolino"))
    assert len(tickets) == 210 and stats["base_capped"]

    spec = SearchSpec(text="cedolino", extended={"enabled": True, "max_requests": 200})
    stats, tickets, _ = run(session, profile, spec)
    assert len(tickets) == expected
    assert len({t["key"] for t in tickets}) == len(tickets)
    assert stats["complete"]


def test_extended_phrase_strategy(zcfg, index):
    """Profilo come quello reale: nessun campo mappato, periodo filtrato con le frasi data del titolo."""
    cfg = copy.deepcopy(zcfg)
    cfg["extended"]["earliest_year"] = 2016
    profile = Profile(cfg)
    assert profile.date_strategy == "phrase"
    session = DemoSession("t", index, 0)
    pred = lambda d: "cedolino" in d.all_tokens and date(2024, 1, 1) <= d.date <= date(2025, 6, 30)
    expected = count_matching(index, pred)

    spec = SearchSpec(text="cedolino", date_from=date(2024, 1, 1), date_to=date(2025, 6, 30),
                      extended={"enabled": True, "max_requests": 200})
    stats, tickets, events = run(session, profile, spec)
    assert events[0]["query"].startswith('(cedolino) AND ("01-2024" OR "02-2024"')
    assert len(tickets) == expected
    assert all("2024-01-01" <= t["date"] <= "2025-06-30" for t in tickets)


def test_deep_paging_without_windows(zcfg, index):
    profile = Profile(copy.deepcopy(zcfg))
    session = DemoSession("t", index, 0)
    expected = count_matching(index, lambda d: "detassazione" in d.all_tokens)
    spec = SearchSpec(text="detassazione", extended={"enabled": True, "split": "none", "max_requests": 50})
    stats, tickets, _ = run(session, profile, spec)
    assert stats["requests"] > 1
    assert len(tickets) == min(expected, 210 * stats["requests"])


def test_budget_exhaustion_reported(zcfg, index):
    conn = DemoConnector(zcfg, SIZE, 0)
    profile = Profile(conn.profile_data())
    session = DemoSession("t", index, 0)
    spec = SearchSpec(text="buongiorno", extended={"enabled": True, "max_requests": 3})
    stats, _, _ = run(session, profile, spec)
    assert stats["requests"] == 3
    assert stats["unexplored"] > 0 and not stats["complete"]


def test_windows():
    ws = initial_windows(date(2025, 11, 15), date(2026, 2, 3), "auto")
    assert [w.label for w in ws] == ["01/01–03/02/2026", "15/11–31/12/2025"]
    months = Window(date(2026, 1, 1), date(2026, 2, 3), "year").children()
    assert [m.label for m in months] == ["01/2026", "01–03/02/2026"]
    parts = Window(date(2026, 2, 1), date(2026, 2, 28), "month").children()
    assert [(p.start.day, p.end.day) for p in parts] == [(1, 8), (9, 16), (17, 24), (25, 28)]
    assert len(parts[0].children()) == 8
