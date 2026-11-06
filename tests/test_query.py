from datetime import date

import pytest

from app.models import SearchSpec
from app.query import (
    Profile,
    QueryError,
    build_query,
    date_phrase_clause,
    escape_term,
    parse_numbers,
)


def spec(**kw) -> SearchSpec:
    return SearchSpec(**kw)


def test_all_words(zprofile):
    assert build_query(spec(text="detassazione premio"), zprofile).query == "detassazione AND premio"


def test_any_words_and_quoted_phrase(zprofile):
    q = build_query(spec(text='"premio di risultato" conguaglio', mode="any"), zprofile).query
    assert q == '"premio di risultato" OR conguaglio'


def test_exact_phrase_with_proximity(zprofile):
    q = build_query(spec(text="premio risultato", mode="phrase", proximity=3), zprofile).query
    assert q == '"premio risultato"~3'


def test_special_chars_escaped(zprofile):
    q = build_query(spec(text="730/2025 (bozza) AND"), zprofile).query
    assert q == r"730\/2025 AND bozza AND and"
    assert escape_term("a:b") == r"a\:b"


def test_prefix_and_fuzzy(zprofile):
    q = build_query(spec(text="detass cedolino 12", prefix=True, fuzzy=True), zprofile).query
    assert q == "(detass* OR detass~1) AND (cedolino* OR cedolino~1) AND 12"


def test_solr_mode_passthrough_and_exclusions(zprofile):
    q = build_query(spec(text="a OR b", mode="solr", exclude='storno "cassa integrazione"'), zprofile).query
    assert q == '(a OR b) AND NOT (storno OR "cassa integrazione")'


def test_only_negative_uses_match_all(zprofile):
    built = build_query(spec(exclude="storno", numbers="123"), zprofile)
    assert built.query == "(123) AND NOT storno"
    with pytest.raises(QueryError):
        build_query(spec(), zprofile)


def test_numbers_term_strategy(zprofile):
    built = build_query(spec(numbers="#1234567, 1234568"), zprofile)
    assert built.query == "(1234567 OR 1234568)"
    with pytest.raises(QueryError, match="intervalli"):
        build_query(spec(numbers="1234567, 1230000-1240000"), zprofile)
    built = build_query(spec(text="tfr", numbers="#1234567, 1234568; 1230000-1240000"), zprofile)
    assert built.query == "tfr"
    assert built.post.numbers == [1234567, 1234568]
    assert built.post.number_ranges == [(1230000, 1240000)]
    assert any("intervalli" in w for w in built.warnings)


def test_parse_numbers_errors():
    assert parse_numbers("1 2..5") == ([1], [(2, 5)])
    with pytest.raises(QueryError):
        parse_numbers("12a")


def test_products_term_strategy_and_post_filter(zprofile):
    built = build_query(spec(text="x", products_in=["paghew"], products_out=["HRINF"]), zprofile)
    assert built.query == "(x) AND (PAGHEW)"
    assert built.post.products_in == ["PAGHEW"]
    assert built.post.products_out == ["HRINF"]


def test_date_phrase_strategy(zprofile):
    built = build_query(spec(text="x", date_from=date(2026, 3, 30), date_to=date(2026, 5, 2)), zprofile)
    assert built.query == (
        '(x) AND ("30-03-2026" OR "31-03-2026" OR "04-2026" OR "01-05-2026" OR "02-05-2026")'
    )
    assert built.post.date_from == date(2026, 3, 30)


def test_date_phrase_long_range_uses_years(zprofile):
    clause = date_phrase_clause(zprofile, date(1990, 1, 1), date(2026, 12, 31))
    assert clause.startswith("(1990 OR 1991")
    assert '"' not in clause


def test_date_field_strategy(zcfg):
    zcfg["fields"]["date"]["solr"] = "TKDATAGG"
    zcfg["strategies"]["date"] = "field"
    built = build_query(spec(text="x", date_from=date(2024, 1, 1)), Profile(zcfg))
    assert built.query == "(x) AND (TKDATAGG:[2024-01-01T00:00:00Z TO *])"
    assert built.post.date_from is None  # nessun filtro locale con il campo


def test_mapped_fields(zcfg):
    zcfg["fields"]["stato"]["solr"] = "TKSTATO"
    zcfg["fields"]["operatore"]["solr"] = "TKOPER"
    built = build_query(spec(text="x", fields={"stato": "Chiuso, -Aperto", "operatore": "ros*", "azienda": "ACME"}),
                        Profile(zcfg))
    assert built.query == '(x) AND (TKSTATO:"Chiuso") AND (TKOPER:ros*) AND NOT TKSTATO:"Aperto"'
    assert any("Azienda" in w for w in built.warnings)


def test_scope_unmapped_warns(zprofile):
    built = build_query(spec(text="x", scope="subject"), zprofile)
    assert built.query == "x"
    assert built.warnings


def test_scope_mapped(zcfg):
    zcfg["fields"]["subject"]["solr"] = "TKOGGETTO"
    assert build_query(spec(text="a b", scope="subject"), Profile(zcfg)).query == "TKOGGETTO:(a AND b)"


def test_inverted_dates_rejected(zprofile):
    with pytest.raises(QueryError):
        build_query(spec(text="x", date_from=date(2026, 2, 1), date_to=date(2026, 1, 1)), zprofile)


def test_invalid_year_rejected(zprofile):
    with pytest.raises(QueryError, match="Anno non valido"):
        build_query(spec(text="x", date_from=date(26, 1, 1)), zprofile)
