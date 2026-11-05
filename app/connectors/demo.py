"""Connettore dimostrativo: archivio sintetico locale, stesso formato di Zucchetti."""
from __future__ import annotations

import asyncio
import copy
import json
import random
import threading
from typing import Optional

from . import demo_engine
from .base import Connector, ConnectorSession, LoginFailed, Throttle, UpstreamError

DEMO_CAP = 210

_INDEX: Optional[demo_engine.DemoIndex] = None
_INDEX_LOCK = threading.Lock()


def get_index(size: int) -> demo_engine.DemoIndex:
    global _INDEX
    with _INDEX_LOCK:
        if _INDEX is None or len(_INDEX.docs) != size:
            _INDEX = demo_engine.DemoIndex(demo_engine.generate(size))
        return _INDEX


DEMO_FIELD_MAP = {
    "number": "TKNUMERO", "subject": "TKOGGETTO", "text": "TKTESTO", "date": "TKDATA",
    "product": "TKPRODOTTO", "centro_servizi": "TKCENTRO", "stato": "TKSTATO",
    "stato_base": "TKSTATOBASE", "priorita": "TKPRIORITA", "tipologia": "TKTIPOLOGIA",
    "gruppo": "TKGRUPPO", "operatore": "TKOPERATORE", "azienda": "TKAZIENDA",
    "persona": "TKPERSONA", "operatore_partecipante": "TKOPPART",
    "gruppo_partecipante": "TKGRPPART", "classificazione": "TKCLASSIF", "argomento": "TKARGOMENTO",
}


class DemoSession(ConnectorSession):
    connector_id = "demo"

    def __init__(self, username: str, index: demo_engine.DemoIndex, latency_ms: int):
        self.username = username
        self.index = index
        self.latency_ms = latency_ms
        self.throttle = Throttle(4, 0)
        self._rng = random.Random()

    async def search_raw(self, query: str, core: str, area: str, langs: str) -> str:
        async with self.throttle:
            if self.latency_ms:
                await asyncio.sleep(self.latency_ms / 1000.0 * (0.6 + 0.8 * self._rng.random()))
            try:
                docs, words = await asyncio.to_thread(self.index.search, query, DEMO_CAP)
            except demo_engine.QuerySyntaxError as exc:
                payload = {"fields": [], "data": [], "facet": [], "maxResults": [str(DEMO_CAP)],
                           "errors": [f"Sintassi non valida: {exc}"]}
                return json.dumps(payload)
            return json.dumps(demo_engine.to_zucchetti_json(docs, words, DEMO_CAP, core or "TICKET"))

    async def suggest(self, prefix: str) -> list[str]:
        prefix = (prefix or "").strip().lower()
        if len(prefix) < 2:
            return []
        vocab = self.index.vocab["subject"]
        out = [w for w in vocab if w.startswith(prefix) and not w.isdigit()]
        out.sort(key=lambda w: -len(self.index.post["subject"].get(w, ())))
        return out[:8]

    def describe_request(self, query, core, area, langs):
        return {"connector": "demo", "pKeyword": query, "pCore": core, "pArea": area, "pLangs": langs}


class DemoConnector(Connector):
    id = "demo"
    label = "Demo (dati sintetici)"

    def __init__(self, base_profile: dict, size: int, latency_ms: int):
        self._profile = copy.deepcopy(base_profile)
        for key, solr in DEMO_FIELD_MAP.items():
            if key in self._profile.get("fields", {}):
                self._profile["fields"][key]["solr"] = solr
        self._profile.setdefault("strategies", {}).update(
            {"date": "field", "number": "field", "product": "field", "earliest_year": 2016}
        )
        self._profile.setdefault("search", {})["result_cap"] = DEMO_CAP
        self._profile["search"]["default_core"] = "TICKET"
        self._profile.setdefault("parse", {})["link_base"] = "/demo/"
        self._profile["products"] = [p for p, _ in demo_engine.PRODUCTS]
        self.size = size
        self.latency_ms = latency_ms

    def profile_data(self) -> dict:
        return self._profile

    def public(self) -> dict:
        return {
            "id": self.id, "label": self.label, "cookie_login": False,
            "hint": "Qualsiasi nome utente, password: demo",
        }

    async def login(self, username: str, password: str) -> ConnectorSession:
        if not username.strip() or password != "demo":
            raise LoginFailed("Per la demo usa un nome qualsiasi e la password 'demo'.")
        try:
            index = await asyncio.to_thread(get_index, self.size)
        except Exception as exc:  # noqa: BLE001
            raise UpstreamError("Impossibile preparare i dati demo", str(exc)) from exc
        return DemoSession(username.strip(), index, self.latency_ms)

    def ticket_page(self, number: int) -> Optional[dict]:
        if _INDEX is None:
            return None
        idx = _INDEX.by_number.get(number)
        if idx is None:
            return None
        d = _INDEX.docs[idx]
        return {
            "Numero": f"#{d.number}", "Data": d.date_str, "Prodotto": d.product,
            "Oggetto": d.subject, "Stato": d.stato, "Stato base": d.stato_base,
            "Priorità": d.priorita, "Tipologia": d.tipologia, "Centro servizi": d.centro,
            "Gruppo": d.gruppo, "Operatore": d.operatore, "Azienda": d.azienda,
            "Persona": d.persona, "Operatori partecipanti": ", ".join(d.op_part),
            "Gruppi partecipanti": ", ".join(d.gr_part), "Classificazione": d.classificazione,
            "Argomento": d.argomento, "Testo": d.text,
        }
