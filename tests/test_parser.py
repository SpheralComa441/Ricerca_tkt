import pytest

from app.parser import (
    UpstreamFormatError,
    html_to_segments,
    parse_response,
    resolve_link,
    slice_segments,
)


def test_parse_sample(zcfg, sample_response):
    resp = parse_response(sample_response, zcfg["parse"], 210, "TICKET")
    assert resp.raw_count == 3  # la riga di metadati "t,C,-1" è ignorata
    assert resp.max_results == 210
    assert not resp.capped
    t = resp.tickets[0]
    assert t.number == 1234567
    assert t.product == "PAGHEW"
    assert t.date == "2026-04-21"
    assert t.subject == "detassazione"
    assert t.subject_hl == [["detassazione", True]]
    assert t.snippet == "detassazione dei premi spiegata la detassazione"
    assert t.url == "https://www.zucchetti.it/areariservata/jsp/gspv_fticket.jsp?TKSERIAL=0000123"
    assert t.key == "n1234567"

    t2 = resp.tickets[1]
    assert t2.subject == "detassazione & premio"
    assert t2.snippet == "Testo <con> entità"
    assert t2.url is None  # "function:..." non è un link apribile


def test_capped_detection(zcfg, sample_response):
    resp = parse_response(sample_response.replace('"210"', '"3"'), zcfg["parse"], 210)
    assert resp.capped


def test_segments_and_slicing():
    segs = html_to_segments('a <span solrfound="true">b</span> <em>c</em>d')
    assert segs == [["a ", False], ["b", True], [" ", False], ["c", True], ["d", False]]
    assert slice_segments(segs, 2, 5) == [["b", True], [" ", False], ["c", True]]


def test_invalid_payload():
    with pytest.raises(UpstreamFormatError):
        parse_response("<html>login</html>", {}, 210)


def test_js_literal_payload(zcfg):
    raw = "{'fields':['id','description'],'data':[['1','[#1] [P] [01-01-2025] x']]}"
    resp = parse_response(raw, zcfg["parse"], 210)
    assert resp.tickets[0].number == 1


def test_resolve_link():
    base = "https://www.zucchetti.it/areariservata/jsp/"
    assert resolve_link("../servlet/x?a=1", base) == "https://www.zucchetti.it/areariservata/servlet/x?a=1"
    assert resolve_link("javascript:alert(1)", base) is None
    assert resolve_link("ticket/5", "/demo/") == "/demo/ticket/5"
