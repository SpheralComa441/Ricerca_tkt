"""Costruzione della query Solr a partire dai criteri dell'interfaccia.

La routine Zucchetti `spsl_fquery_mc` riceve una stringa di ricerca in sintassi
Lucene/Solr (parametro pKeyword). Qui la componiamo in modo sicuro (escape dei
caratteri speciali) e prepariamo anche i filtri da applicare localmente ai
risultati, per i criteri che Solr non può garantire.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from .models import SearchSpec

_SPECIAL = re.compile(r'([+\-&|!(){}\[\]^"~*?:\\/])')
_BOOL_WORDS = {"AND", "OR", "NOT", "TO"}
_EDGE_PUNCT = ".,;:!?()[]{}<>«»\"'`"
MAX_NUMBERS = 1000


class QueryError(ValueError):
    """Criteri di ricerca non validi o vuoti."""


def escape_term(term: str) -> str:
    term = _SPECIAL.sub(r"\\\1", term)
    if term.upper() in _BOOL_WORDS:
        term = term.lower()
    return term


def quote_phrase(text: str) -> str:
    text = " ".join(text.split())
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def split_user_text(text: str) -> list[tuple[str, str]]:
    """Divide il testo in parole e "frasi tra virgolette"."""
    out: list[tuple[str, str]] = []
    for m in re.finditer(r'"([^"]*)"|(\S+)', text or ""):
        if m.group(1) is not None:
            value = " ".join(m.group(1).split())
            if value:
                out.append(("phrase", value))
        else:
            value = m.group(2).strip(_EDGE_PUNCT)
            if value:
                out.append(("term", value))
    return out


def _term_clause(term: str, prefix: bool, fuzzy: bool) -> str:
    esc = escape_term(term)
    is_word = term.isalpha()
    use_prefix = prefix and len(term) >= 3 and is_word
    use_fuzzy = fuzzy and len(term) >= 4 and is_word
    if use_prefix and use_fuzzy:
        return f"({esc}* OR {esc}~1)"
    if use_prefix:
        return f"{esc}*"
    if use_fuzzy:
        return f"{esc}~1"
    return esc


def parse_numbers(text: str) -> tuple[list[int], list[tuple[int, int]]]:
    """'8900042, 8900000-8910000' -> ([8900042], [(8900000, 8910000)])."""
    singles: list[int] = []
    ranges: list[tuple[int, int]] = []
    for chunk in re.split(r"[\s,;]+", (text or "").replace("#", " ")):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = re.fullmatch(r"(\d{1,12})\s*(?:-|\.\.)\s*(\d{1,12})", chunk)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            ranges.append((min(a, b), max(a, b)))
            continue
        if not chunk.isdigit():
            raise QueryError(f"Numero ticket non valido: {chunk!r}")
        n = int(chunk)
        if n not in singles:
            singles.append(n)
    if len(singles) > MAX_NUMBERS:
        raise QueryError(f"Troppi numeri ticket (massimo {MAX_NUMBERS})")
    return singles, ranges


def _split_values(raw: str) -> tuple[list[str], list[str]]:
    pos: list[str] = []
    neg: list[str] = []
    for v in re.split(r"[;,\n]+", raw or ""):
        v = v.strip()
        if not v:
            continue
        if v[0] in "-!" and len(v) > 1:
            neg.append(v[1:].strip())
        else:
            pos.append(v)
    return pos, neg


def _or_group(items: list[str]) -> str:
    return items[0] if len(items) == 1 else "(" + " OR ".join(items) + ")"


def _last_day(d: date) -> date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])


# ---------------------------------------------------------------------------
# Profilo del connettore (mappatura campi e strategie)
# ---------------------------------------------------------------------------


class Profile:
    def __init__(self, data: dict):
        self.data = data
        self.fields: dict = {k: v for k, v in data.get("fields", {}).items() if not k.startswith("_")}
        self.strategies: dict = data.get("strategies", {})
        self.cap: int = int(data.get("search", {}).get("result_cap", 210))

    def solr(self, key: str) -> Optional[str]:
        f = self.fields.get(key) or {}
        name = f.get("solr")
        return name or None

    def field_format(self, key: str) -> str:
        return (self.fields.get(key) or {}).get("format", "solr")

    @property
    def earliest_year(self) -> int:
        return int(self.strategies.get("earliest_year", 2010))

    @property
    def date_strategy(self) -> str:
        s = self.strategies.get("date", "phrase")
        if s == "field" and not self.solr("date"):
            return "phrase"
        return s

    @property
    def number_strategy(self) -> str:
        return "field" if self.strategies.get("number") == "field" and self.solr("number") else "term"

    @property
    def product_strategy(self) -> str:
        return "field" if self.strategies.get("product") == "field" and self.solr("product") else "term"

    def month_phrase(self, d: date) -> str:
        tpl = self.strategies.get("month_phrase", "{mm}-{yyyy}")
        return tpl.replace("{mm}", f"{d.month:02d}").replace("{yyyy}", f"{d.year:04d}")

    def day_phrase(self, d: date) -> str:
        tpl = self.strategies.get("day_phrase", "{dd}-{mm}-{yyyy}")
        return (
            tpl.replace("{dd}", f"{d.day:02d}")
            .replace("{mm}", f"{d.month:02d}")
            .replace("{yyyy}", f"{d.year:04d}")
        )

    def format_date_value(self, d: date, end: bool) -> str:
        fmt = self.field_format("date")
        if fmt == "solr":
            return d.strftime("%Y-%m-%dT23:59:59Z" if end else "%Y-%m-%dT00:00:00Z")
        if fmt == "yyyymmdd":
            return d.strftime("%Y%m%d")
        return d.strftime(fmt)

    def public(self) -> dict:
        """Informazioni del profilo utili all'interfaccia."""
        fields = []
        for key, f in self.fields.items():
            fields.append(
                {
                    "key": key,
                    "label": f.get("label", key),
                    "hint": f.get("hint", ""),
                    "group": f.get("group", "riepilogo"),
                    "kind": f.get("kind", "string"),
                    "enabled": bool(f.get("solr")),
                }
            )
        search = self.data.get("search", {})
        return {
            "fields": fields,
            "cap": self.cap,
            "date_strategy": self.date_strategy,
            "number_strategy": self.number_strategy,
            "product_strategy": self.product_strategy,
            "default_core": search.get("default_core", ""),
            "default_area": search.get("default_area", ""),
            "default_langs": search.get("default_langs", ""),
            "earliest_year": self.earliest_year,
            "products": self.data.get("products", []),
        }


# ---------------------------------------------------------------------------
# Clausole di data
# ---------------------------------------------------------------------------


def date_phrase_clause(profile: Profile, start: date, end: date, max_phrases: int = 400) -> str:
    """Clausola che restringe al periodo cercando la data mostrata nel titolo.

    Mesi interi -> "04-2026"; giorni di mesi parziali -> "21-04-2026".
    Per periodi molto lunghi gli anni interi diventano la parola 2026 (meno
    precisa: i risultati vengono comunque verificati localmente).
    """
    if start > end:
        raise QueryError("La data iniziale è successiva a quella finale")

    def build(use_years: bool) -> list[str]:
        parts: list[str] = []
        d = start
        while d <= end:
            if use_years and d.month == 1 and d.day == 1 and date(d.year, 12, 31) <= end:
                parts.append(f"{d.year:04d}")
                d = date(d.year + 1, 1, 1)
                continue
            last = _last_day(d)
            if d.day == 1 and last <= end:
                parts.append(quote_phrase(profile.month_phrase(d)))
                d = last + timedelta(days=1)
            else:
                parts.append(quote_phrase(profile.day_phrase(d)))
                d += timedelta(days=1)
        return parts

    parts = build(False)
    if len(parts) > max_phrases:
        parts = build(True)
    return _or_group(parts)


def date_clause(profile: Profile, start: Optional[date], end: Optional[date]) -> Optional[str]:
    if start is None and end is None:
        return None
    if profile.date_strategy == "field":
        fname = profile.solr("date")
        lo = profile.format_date_value(start, False) if start else "*"
        hi = profile.format_date_value(end, True) if end else "*"
        return f"{fname}:[{lo} TO {hi}]"
    if profile.date_strategy == "phrase":
        earliest = date(profile.earliest_year, 1, 1)
        return date_phrase_clause(profile, start or earliest, end or date.today())
    return None


# ---------------------------------------------------------------------------
# Query completa
# ---------------------------------------------------------------------------


@dataclass
class PostFilters:
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    numbers: list[int] = field(default_factory=list)
    number_ranges: list[tuple[int, int]] = field(default_factory=list)
    products_in: list[str] = field(default_factory=list)
    products_out: list[str] = field(default_factory=list)

    def active(self) -> bool:
        return bool(
            self.date_from or self.date_to or self.numbers or self.number_ranges
            or self.products_in or self.products_out
        )

    def accepts(self, ticket) -> bool:
        if self.date_from or self.date_to:
            if not ticket.date:
                return False
            d = date.fromisoformat(ticket.date)
            if self.date_from and d < self.date_from:
                return False
            if self.date_to and d > self.date_to:
                return False
        if self.numbers or self.number_ranges:
            n = ticket.number
            if n is None:
                return False
            if n not in self.numbers and not any(a <= n <= b for a, b in self.number_ranges):
                return False
        prod = (ticket.product or "").upper()
        if self.products_in and prod not in self.products_in:
            return False
        if self.products_out and prod in self.products_out:
            return False
        return True


@dataclass
class BuiltQuery:
    clauses: list[str]  # clausole positive senza la data
    negatives: list[str]  # clausole "NOT ..."
    date_part: Optional[str]
    post: PostFilters
    warnings: list[str]
    date_from: Optional[date]
    date_to: Optional[date]

    def compose(self, extra: Optional[list[str]] = None, with_date: bool = True) -> str:
        positives = list(self.clauses)
        if with_date and self.date_part:
            positives.append(self.date_part)
        negatives = list(self.negatives)
        for e in extra or []:
            if e.startswith("NOT "):
                negatives.append(e)
            else:
                positives.append(e)
        if not positives:
            positives = ["*:*"]
        must_wrap = len(positives) > 1 or bool(negatives)
        parts = [_wrap(p) if must_wrap and p != "*:*" else p for p in positives]
        q = " AND ".join(parts)
        for n in negatives:
            q += f" AND {n}"
        return q

    @property
    def query(self) -> str:
        return self.compose()


def _wrap(clause: str) -> str:
    if clause.startswith("(") and clause.endswith(")") and _balanced_outer(clause):
        return clause
    return f"({clause})"


def _balanced_outer(clause: str) -> bool:
    depth = 0
    in_quote = False
    escaped = False
    for i, ch in enumerate(clause):
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_quote = not in_quote
            continue
        if in_quote:
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(clause) - 1:
                return False
    return depth == 0


def build_query(spec: SearchSpec, profile: Profile) -> BuiltQuery:
    clauses: list[str] = []
    negatives: list[str] = []
    warnings: list[str] = []
    post = PostFilters()

    # --- testo principale --------------------------------------------------
    text = (spec.text or "").strip()
    text_clause: Optional[str] = None
    if text:
        if spec.mode == "solr":
            text_clause = text
        elif spec.mode == "phrase":
            text_clause = quote_phrase(text.replace('"', " "))
            if spec.proximity:
                text_clause += f"~{spec.proximity}"
        else:
            parts = []
            for kind, value in split_user_text(text):
                if kind == "phrase":
                    parts.append(quote_phrase(value))
                else:
                    parts.append(_term_clause(value, spec.prefix, spec.fuzzy))
            if parts:
                joiner = " AND " if spec.mode == "all" else " OR "
                text_clause = joiner.join(parts)
    if spec.phrase.strip():
        p = quote_phrase(spec.phrase.replace('"', " "))
        text_clause = f"({text_clause}) AND {p}" if text_clause else p

    if text_clause:
        scope_field = None
        if spec.scope == "subject":
            scope_field = profile.solr("subject")
        elif spec.scope == "text":
            scope_field = profile.solr("text")
        if spec.scope != "all" and not scope_field:
            warnings.append(
                "Il campo per 'Cerca in' non è mappato nella configurazione: la ricerca è su tutti i campi."
            )
        clauses.append(f"{scope_field}:({text_clause})" if scope_field else text_clause)

    # --- parole da escludere ------------------------------------------------
    excl = []
    for kind, value in split_user_text(spec.exclude):
        excl.append(quote_phrase(value) if kind == "phrase" else escape_term(value))
    if excl:
        negatives.append(f"NOT {_or_group(excl)}")

    # --- numeri ticket -------------------------------------------------------
    singles, ranges = parse_numbers(spec.numbers)
    if singles or ranges:
        post.numbers, post.number_ranges = singles, ranges
        if profile.number_strategy == "field":
            items = [str(n) for n in singles] + [f"[{a} TO {b}]" for a, b in ranges]
            clauses.append(f"{profile.solr('number')}:{_or_group(items)}")
        else:
            if singles and not ranges:
                clauses.append(_or_group([str(n) for n in singles]))
            if ranges:
                warnings.append(
                    "Gli intervalli di numeri ticket sono applicati solo ai risultati restituiti "
                    "(campo 'Numero ticket' non mappato)."
                )

    # --- prodotti ------------------------------------------------------------
    if spec.products_in:
        post.products_in = list(spec.products_in)
        if profile.product_strategy == "field":
            items = [quote_phrase(p) for p in spec.products_in]
            clauses.append(f"{profile.solr('product')}:{_or_group(items)}")
        else:
            clauses.append(_or_group([escape_term(p) for p in spec.products_in]))
    if spec.products_out:
        post.products_out = list(spec.products_out)
        if profile.product_strategy == "field":
            items = [quote_phrase(p) for p in spec.products_out]
            negatives.append(f"NOT {profile.solr('product')}:{_or_group(items)}")

    # --- filtri di riepilogo (campi mappati) --------------------------------
    for key, raw in spec.fields.items():
        fdef = profile.fields.get(key)
        if not fdef:
            continue
        fname = profile.solr(key)
        if not fname:
            warnings.append(f"Il filtro '{fdef.get('label', key)}' non è mappato ed è stato ignorato.")
            continue
        pos, neg = _split_values(raw)
        if pos:
            clauses.append(f"{fname}:{_or_group([_field_value(v) for v in pos])}")
        if neg:
            negatives.append(f"NOT {fname}:{_or_group([_field_value(v) for v in neg])}")

    # --- periodo -------------------------------------------------------------
    if spec.date_from and spec.date_to and spec.date_from > spec.date_to:
        raise QueryError("La data iniziale è successiva a quella finale")
    dpart = date_clause(profile, spec.date_from, spec.date_to)
    if (spec.date_from or spec.date_to) and profile.date_strategy != "field":
        post.date_from, post.date_to = spec.date_from, spec.date_to

    if not clauses and not dpart and not negatives:
        if post.number_ranges:
            raise QueryError(
                "Gli intervalli di numeri ticket vanno combinati con un testo o un altro criterio "
                "(il campo 'Numero ticket' non è mappato nella configurazione)."
            )
        raise QueryError("Inserisci almeno un criterio di ricerca.")

    return BuiltQuery(
        clauses=clauses,
        negatives=negatives,
        date_part=dpart,
        post=post,
        warnings=warnings,
        date_from=spec.date_from,
        date_to=spec.date_to,
    )


def _field_value(value: str) -> str:
    value = value.strip()
    if "*" in value or "?" in value:
        # caratteri jolly espliciti: escape del resto, niente virgolette
        return "".join(ch if ch in "*?" else escape_term(ch) if _SPECIAL.match(ch) else ch for ch in value).replace(" ", "\\ ")
    return quote_phrase(value)
