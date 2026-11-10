"""Interpretazione della risposta della routine Solr di Zucchetti.

La routine `spsl_fquery_mc` restituisce un JSON del tipo::

    {"fields": [...], "data": [[...], ...], "facet": [["TICKET", "210", "TICKET"]],
     "maxResults": ["210"], "errors": []}

La colonna `description` contiene il titolo HTML con le parole trovate
evidenziate (`<span solrfound="true">`), ad esempio::

    [#1234567] [PAGHEW] [21-04-<span solrfound="true">2026</span>] detassazione
"""
from __future__ import annotations

import ast
import html
import json
import re
from datetime import datetime
from html.parser import HTMLParser
from typing import Any, Optional
from urllib.parse import urljoin

from .models import ParsedResponse, Ticket


class UpstreamFormatError(ValueError):
    """La risposta del server non è nel formato atteso."""

    def __init__(self, message: str, sample: str = ""):
        super().__init__(message)
        self.sample = sample


class _HighlightParser(HTMLParser):
    _HL_TAGS = {"em", "b", "strong", "mark"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.segments: list[list] = []
        self._stack: list[bool] = []

    def _hl(self) -> bool:
        return any(self._stack)

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "p", "div", "li", "tr"}:
            self._text(" ")
        if tag in {"br", "img", "hr", "input", "meta", "link"}:
            return
        attrs_d = {k.lower(): (v or "") for k, v in attrs}
        is_hl = attrs_d.get("solrfound", "").lower() == "true" or tag in self._HL_TAGS
        self._stack.append(is_hl)

    def handle_endtag(self, tag):
        if tag in {"br", "img", "hr", "input", "meta", "link"}:
            return
        if self._stack:
            self._stack.pop()
        if tag in {"p", "div", "li", "tr"}:
            self._text(" ")

    def handle_data(self, data):
        self._text(data)

    def _text(self, data: str) -> None:
        if not data:
            return
        hl = self._hl()
        if self.segments and self.segments[-1][1] == hl:
            self.segments[-1][0] += data
        else:
            self.segments.append([data, hl])


def html_to_segments(value: Any) -> list[list]:
    """HTML -> [[testo, evidenziato], ...] con spazi normalizzati."""
    if value is None:
        return []
    text = str(value)
    if "<" not in text and "&" not in text:
        segs = [[text, False]]
    else:
        p = _HighlightParser()
        p.feed(text)
        p.close()
        segs = p.segments
    out: list[list] = []
    for t, hl in segs:
        t = re.sub(r"\s+", " ", t)
        if not t:
            continue
        if out and out[-1][1] == hl:
            out[-1][0] += t
        else:
            out.append([t, hl])
    # trim
    if out:
        out[0][0] = out[0][0].lstrip()
        out[-1][0] = out[-1][0].rstrip()
        out = [s for s in out if s[0]]
    for s in out:
        s[0] = re.sub(r" {2,}", " ", s[0])
    return out


def segments_text(segs: list[list]) -> str:
    return "".join(s[0] for s in segs)


def slice_segments(segs: list[list], start: int, end: Optional[int] = None) -> list[list]:
    out: list[list] = []
    pos = 0
    for text, hl in segs:
        s_start, s_end = pos, pos + len(text)
        pos = s_end
        a = max(start, s_start)
        b = s_end if end is None else min(end, s_end)
        if a < b:
            out.append([text[a - s_start : b - s_start], hl])
    return out


def _loads(raw: str) -> Any:
    raw = raw.strip()
    if raw.startswith("﻿"):
        raw = raw[1:]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    try:  # letterale JavaScript con apici singoli
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        pass
    # a volte la stringa JSON è a sua volta racchiusa tra apici
    if raw[:1] in "\"'" and raw[-1:] == raw[:1]:
        try:
            inner = json.loads(raw) if raw[0] == '"' else ast.literal_eval(raw)
            if isinstance(inner, str):
                return json.loads(inner)
        except Exception:  # noqa: BLE001
            pass
    raise UpstreamFormatError("La risposta della ricerca non è un JSON valido", raw[:500])


def _ci(d: dict, *names: str, default=None):
    lower = {str(k).lower(): v for k, v in d.items()}
    for n in names:
        if n.lower() in lower:
            return lower[n.lower()]
    return default


def rows_from(fields: list, data: list) -> list[dict]:
    rows: list[dict] = []
    names = [str(f) for f in (fields or [])]
    for row in data or []:
        if isinstance(row, dict):
            rows.append(row)
        elif isinstance(row, (list, tuple)):
            if names and len(row) >= len(names):
                rows.append(dict(zip(names, row)))
        # le stringhe sono righe di metadati di SitePainter: ignorate
    return rows


def resolve_link(url: Optional[str], base: str) -> Optional[str]:
    if not url:
        return None
    url = str(url).strip()
    if not url or url.startswith("function:") or url.lower().startswith("javascript:"):
        return None
    # formato SitePainter "[target:_blank] ../servlet/..."
    m = re.match(r"^\[\s*target:[^\]]*\]\s*(.*)$", url)
    if m:
        url = m.group(1).strip()
    resolved = urljoin(base, url) if base else url
    if not re.match(r"^(https?:)?/", resolved):
        return None
    return resolved


def parse_title(title_segs: list[list], profile_parse: dict) -> dict:
    text = segments_text(title_segs)
    regex = profile_parse.get("title_regex")
    out = {"title": text, "subject": text, "subject_hl": title_segs, "number": None, "product": "", "date": None}
    if not regex:
        return out
    m = re.match(regex, text)
    if not m:
        return out
    gd = m.groupdict()
    if gd.get("number"):
        try:
            out["number"] = int(gd["number"])
        except ValueError:
            pass
    out["product"] = (gd.get("product") or "").strip()
    if gd.get("date"):
        try:
            out["date"] = (
                datetime.strptime(gd["date"].strip(), profile_parse.get("date_format", "%d-%m-%Y"))
                .date()
                .isoformat()
            )
        except ValueError:
            out["date"] = None
    if "subject" in gd and gd["subject"] is not None:
        start = m.start("subject")
        out["subject_hl"] = slice_segments(title_segs, start)
        out["subject"] = segments_text(out["subject_hl"]).strip()
    return out


_EXTRA_SKIP = {"img", "mimetype", "authcode", "urlpublic", "url2lbl"}


def parse_response(raw: str | dict, parse_cfg: dict, default_cap: int, core: str = "") -> ParsedResponse:
    payload = _loads(raw) if isinstance(raw, str) else raw
    if not isinstance(payload, dict):
        raise UpstreamFormatError("Formato della risposta inatteso", str(raw)[:500])

    fields = _ci(payload, "fields", default=[]) or []
    data = _ci(payload, "data", default=[]) or []
    rows = rows_from(fields, data)

    max_results = None
    mr = _ci(payload, "maxResults", "max_results")
    if isinstance(mr, (list, tuple)) and mr:
        mr = mr[0]
    try:
        max_results = int(str(mr).strip()) if mr not in (None, "") else None
    except ValueError:
        max_results = None

    errors = _ci(payload, "errors", default=[]) or []
    if isinstance(errors, str):
        errors = [errors]
    facets = _ci(payload, "facet", "facets", default=[]) or []

    title_f = parse_cfg.get("title_field", "description")
    snippet_f = parse_cfg.get("snippet_field", "altDescription")
    id_f = parse_cfg.get("id_field", "id")
    url_f = parse_cfg.get("url_field", "url1")
    link_base = parse_cfg.get("link_base", "")
    tpl = parse_cfg.get("ticket_url_template")

    tickets: list[Ticket] = []
    for i, row in enumerate(rows):
        title_segs = html_to_segments(_ci(row, title_f, default=""))
        info = parse_title(title_segs, parse_cfg)
        snippet_segs = html_to_segments(_ci(row, snippet_f, default=""))
        tid = str(_ci(row, id_f, default="") or "").strip()
        url = resolve_link(_ci(row, url_f), link_base)
        if tpl and (url is None):
            url = tpl.replace("{id}", tid).replace("{number}", str(info["number"] or ""))
        key = f"n{info['number']}" if info["number"] is not None else (f"i{tid}" if tid else f"t{info['title']}")
        extra = {}
        for k, v in row.items():
            lk = str(k).lower()
            if lk in {title_f.lower(), snippet_f.lower(), url_f.lower()} or lk in _EXTRA_SKIP:
                continue
            if isinstance(v, (str, int, float)) and str(v).strip() and len(str(v)) < 300:
                extra[str(k)] = v
        tickets.append(
            Ticket(
                key=key,
                id=tid,
                number=info["number"],
                product=info["product"],
                date=info["date"],
                subject=info["subject"],
                subject_hl=info["subject_hl"],
                snippet=segments_text(snippet_segs),
                snippet_hl=snippet_segs,
                title=info["title"],
                url=url,
                core=str(_ci(row, "type", "core", default=core) or core),
                rank=i,
                extra=extra,
            )
        )

    count = len(rows)
    cap = max_results if max_results else default_cap
    capped = bool(cap) and count >= cap
    return ParsedResponse(
        tickets=tickets,
        raw_count=count,
        capped=capped,
        max_results=max_results,
        facets=facets if isinstance(facets, list) else [],
        errors=[str(e) for e in errors],
    )


def strip_tags(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", " ", value or ""))
