"""Modelli dati condivisi (richieste API e risultati)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class SearchSpec(BaseModel):
    """Criteri di ricerca inviati dall'interfaccia."""

    text: str = Field("", max_length=4000)
    mode: Literal["all", "any", "phrase", "solr"] = "all"
    exclude: str = Field("", max_length=1000)
    phrase: str = Field("", max_length=500)
    proximity: int = Field(0, ge=0, le=50)
    prefix: bool = False
    fuzzy: bool = False
    scope: Literal["all", "subject", "text"] = "all"
    numbers: str = Field("", max_length=8000)
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    products_in: list[str] = Field(default_factory=list, max_length=100)
    products_out: list[str] = Field(default_factory=list, max_length=100)
    fields: dict[str, str] = Field(default_factory=dict)
    core: Optional[str] = Field(None, max_length=100)
    area: Optional[str] = Field(None, max_length=200)
    langs: Optional[str] = Field(None, max_length=100)

    @field_validator("products_in", "products_out")
    @classmethod
    def _clean_codes(cls, value: list[str]) -> list[str]:
        out: list[str] = []
        for v in value:
            v = (v or "").strip().upper()
            if v and len(v) <= 40 and v not in out:
                out.append(v)
        return out

    @field_validator("fields")
    @classmethod
    def _clean_fields(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 60:
            raise ValueError("troppi filtri")
        return {
            str(k)[:60]: str(v)[:500]
            for k, v in value.items()
            if v is not None and str(v).strip()
        }


@dataclass
class Ticket:
    key: str
    id: str = ""
    number: Optional[int] = None
    product: str = ""
    date: Optional[str] = None  # ISO yyyy-mm-dd
    subject: str = ""
    subject_hl: list = field(default_factory=list)  # [[testo, evidenziato], ...]
    snippet: str = ""
    snippet_hl: list = field(default_factory=list)
    title: str = ""
    url: Optional[str] = None
    core: str = ""
    rank: int = 0
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ParsedResponse:
    tickets: list[Ticket]
    raw_count: int
    capped: bool
    max_results: Optional[int]
    facets: list = field(default_factory=list)
    errors: list = field(default_factory=list)
