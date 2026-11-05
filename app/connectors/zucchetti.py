"""Connettore verso l'Area Riservata Zucchetti (Infinity / SitePainter).

Flusso:
1. login: legge la pagina di ingresso, individua il form con il campo password
   (SitePainter cp_login, ma anche eventuali pagine SSO), lo compila e lo invia;
   in alternativa si può incollare il cookie di una sessione già aperta nel browser.
2. verifica: apre la pagina di ricerca (gspv_psearch.jsp) e controlla di non
   essere stati rimandati al login.
3. m_cID: legge dal portlet dei risultati il codice di sicurezza della routine
   `spsl_fquery_mc` (splResults.m_cID); se non lo trova usa quello configurato.
4. ricerca: chiama la routine passando la query Solr in pKeyword, come fa
   `splResults.Link()` nella pagina originale, e restituisce il JSON grezzo.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx

from .base import Connector, ConnectorSession, LoginFailed, SessionExpired, Throttle, UpstreamError


class _FormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: list[dict] = []
        self._current: Optional[dict] = None
        self.loose_inputs: list[dict] = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v if v is not None else "") for k, v in attrs}
        if tag == "form":
            self._current = {"action": a.get("action", ""), "method": (a.get("method") or "get").lower(),
                             "id": a.get("id", ""), "inputs": []}
            self.forms.append(self._current)
        elif tag in ("input", "button"):
            entry = {"name": a.get("name", ""), "type": (a.get("type") or "text").lower(),
                     "value": a.get("value", ""), "id": a.get("id", "")}
            if self._current is not None:
                self._current["inputs"].append(entry)
            else:
                self.loose_inputs.append(entry)

    def handle_endtag(self, tag):
        if tag == "form":
            self._current = None


_USER_HINT = re.compile(r"user|login|utente|email|mail|account|username|codute", re.I)


def find_login_form(page_html: str, page_url: str) -> Optional[dict]:
    """Trova il form di login (quello con un campo password)."""
    p = _FormParser()
    try:
        p.feed(page_html)
    except Exception:  # noqa: BLE001 - HTML malformato
        return None
    for form in p.forms:
        inputs = form["inputs"]
        pwd = [i for i in inputs if i["type"] == "password" and i["name"]]
        if not pwd:
            continue
        pwd_idx = inputs.index(pwd[0])
        text_inputs = [i for i in inputs[:pwd_idx] if i["type"] in ("text", "email", "") and i["name"]]
        user = None
        for i in reversed(text_inputs):
            if _USER_HINT.search(i["name"]) or _USER_HINT.search(i["id"]):
                user = i
                break
        if user is None and text_inputs:
            user = text_inputs[-1]
        hidden = {i["name"]: i["value"] for i in inputs if i["type"] == "hidden" and i["name"]}
        for i in inputs:  # checkbox spuntate di default (es. "ricordami") ignorate
            if i["type"] == "submit" and i["name"] and i["name"] not in hidden:
                hidden[i["name"]] = i["value"]
        return {
            "action": urljoin(page_url, form["action"] or page_url),
            "method": form["method"],
            "fields": hidden,
            "user_field": user["name"] if user else None,
            "password_field": pwd[0]["name"],
        }
    return None


def page_has_password_input(page_html: str) -> bool:
    return bool(re.search(r"<input[^>]+type\s*=\s*['\"]?password", page_html or "", re.I))


def _looks_like_json(text: str) -> bool:
    t = (text or "").lstrip()
    return t.startswith("{") or t.startswith("[")


class ZucchettiSession(ConnectorSession):
    connector_id = "zucchetti"

    def __init__(self, connector: "ZucchettiConnector", client: httpx.AsyncClient, username: str):
        self.connector = connector
        self.client = client
        self.username = username
        cfg = connector.cfg["search"]
        self.throttle = Throttle(int(cfg.get("max_concurrency", 3)), int(cfg.get("min_interval_ms", 200)))
        self.m_cID: Optional[str] = None
        self.m_cID_source = ""

    # --- inizializzazione ----------------------------------------------------
    async def discover_m_cid(self) -> None:
        cfg = self.connector.cfg["search"]
        tpl = self.connector.template()
        rx = re.compile(cfg.get("m_cID_regex", r"splResults\.m_cID\s*=\s*'([0-9a-fA-F]{16,64})'"))
        for src in cfg.get("m_cID_sources", []):
            try:
                r = await self.client.get(self.connector.url(src))
            except httpx.HTTPError:
                continue
            m = rx.search(r.text or "")
            if m:
                self.m_cID = m.group(1)
                self.m_cID_source = src
                return
        self.m_cID = (tpl.get("params", {}).get("m_cID") if tpl else None) or cfg.get("m_cID") or None
        self.m_cID_source = "configurazione"

    # --- ricerca -------------------------------------------------------------
    def _build_params(self, query: str, core: str, area: str, langs: str) -> tuple[str, str, dict]:
        cfg = self.connector.cfg["search"]
        tpl = self.connector.template()
        endpoint = (tpl or {}).get("endpoint") or cfg.get("endpoint", "servlet/spsl_fquery_mc")
        method = ((tpl or {}).get("method") or cfg.get("method", "POST")).upper()
        params_tpl = dict((tpl or {}).get("params") or cfg.get("params", {}))
        values = {"{query}": query, "{core}": core, "{area}": area, "{langs}": langs}
        params: dict = {}
        for k, v in params_tpl.items():
            v = str(v)
            for ph, real in values.items():
                if v == ph:
                    v = real
                else:
                    v = v.replace(ph, real)
            params[k] = v
        if self.m_cID:
            params["m_cID"] = self.m_cID
        params.update(cfg.get("extra_params", {}))
        return endpoint, method, params

    def describe_request(self, query, core, area, langs) -> dict:
        endpoint, method, params = self._build_params(query, core, area, langs)
        return {"url": self.connector.url(endpoint), "method": method, "params": params,
                "m_cID_source": self.m_cID_source}

    async def search_raw(self, query: str, core: str, area: str, langs: str) -> str:
        cfg = self.connector.cfg["search"]
        endpoint, method, params = self._build_params(query, core, area, langs)
        url = self.connector.url(endpoint)
        headers = dict(cfg.get("extra_headers", {}))
        tpl_headers = (self.connector.template() or {}).get("headers") or {}
        headers.update(tpl_headers)
        async with self.throttle:
            try:
                if method == "GET":
                    r = await self.client.get(url, params=params, headers=headers)
                else:
                    r = await self.client.post(url, data=params, headers=headers)
            except httpx.TimeoutException as exc:
                raise UpstreamError("Zucchetti non ha risposto in tempo") from exc
            except httpx.HTTPError as exc:
                raise UpstreamError("Errore di comunicazione con Zucchetti", str(exc)) from exc
        if r.status_code in (401, 403):
            raise SessionExpired()
        if r.status_code >= 400:
            raise UpstreamError(f"Zucchetti ha risposto con errore HTTP {r.status_code}", r.text[:500])
        text = r.text or ""
        if not _looks_like_json(text) and (page_has_password_input(text) or self.connector.is_login_url(str(r.url))):
            raise SessionExpired()
        return text

    async def aclose(self) -> None:
        try:
            logout = self.connector.cfg.get("login", {}).get("logout_url")
            if logout:
                await self.client.get(self.connector.url(logout), timeout=5)
        except Exception:  # noqa: BLE001
            pass
        await self.client.aclose()


class ZucchettiConnector(Connector):
    id = "zucchetti"
    label = "Zucchetti – Area Riservata"

    def __init__(self, cfg: dict, data_dir: Path):
        self.cfg = cfg
        self.data_dir = data_dir
        self.template_path = data_dir / "request_template.json"
        self._template_cache: Optional[tuple[float, dict]] = None
        self.transport: Optional[httpx.AsyncBaseTransport] = None  # usato nei test

    # --- utilità ---------------------------------------------------------------
    def url(self, path: str) -> str:
        return urljoin(self.cfg["base_url"], path or "")

    def is_login_url(self, url: str) -> bool:
        path = urlparse(url).path.lower()
        return "login" in path or "cp_login" in path

    def template(self) -> Optional[dict]:
        """Modello di richiesta importato da cURL (Diagnostica), se presente."""
        try:
            mtime = self.template_path.stat().st_mtime
        except FileNotFoundError:
            return None
        if self._template_cache and self._template_cache[0] == mtime:
            return self._template_cache[1]
        try:
            data = json.loads(self.template_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        self._template_cache = (mtime, data)
        return data

    def profile_data(self) -> dict:
        return self.cfg

    def public(self) -> dict:
        return {
            "id": self.id, "label": self.label, "cookie_login": True,
            "hint": "Credenziali dell'Area Riservata Zucchetti",
        }

    def _client(self) -> httpx.AsyncClient:
        timeout = float(self.cfg["search"].get("timeout_seconds", 60))
        return httpx.AsyncClient(
            transport=self.transport,
            follow_redirects=True,
            timeout=httpx.Timeout(timeout, connect=15.0),
            verify=bool(self.cfg.get("verify_tls", True)),
            headers={
                "User-Agent": self.cfg.get("user_agent", "RicercaTKT/1.0"),
                "Accept-Language": "it-IT,it;q=0.9",
            },
        )

    async def _verify(self, client: httpx.AsyncClient) -> bool:
        lcfg = self.cfg.get("login", {})
        try:
            r = await client.get(self.url(lcfg.get("check_page", "")))
        except httpx.HTTPError as exc:
            raise UpstreamError("Impossibile contattare Zucchetti", str(exc)) from exc
        if r.status_code >= 400 or self.is_login_url(str(r.url)):
            return False
        text = r.text or ""
        if page_has_password_input(text):
            return False
        markers = lcfg.get("logged_in_markers") or []
        return not markers or any(m in text for m in markers)

    # --- login -----------------------------------------------------------------
    async def login(self, username: str, password: str) -> ConnectorSession:
        lcfg = self.cfg.get("login", {})
        client = self._client()
        try:
            try:
                entry = await client.get(self.url(lcfg.get("entry_page", "")))
            except httpx.HTTPError as exc:
                raise UpstreamError("Impossibile contattare Zucchetti", str(exc)) from exc
            form = find_login_form(entry.text or "", str(entry.url))
            if form:
                data = dict(form["fields"])
                for k, v in (lcfg.get("extra_fields") or {}).items():
                    data.setdefault(k, v)
                data[form["user_field"] or lcfg.get("username_field", "m_cUserName")] = username
                data[form["password_field"]] = password
                action, method = form["action"], form["method"]
            else:
                data = dict(lcfg.get("extra_fields") or {})
                data[lcfg.get("username_field", "m_cUserName")] = username
                data[lcfg.get("password_field", "m_cPassword")] = password
                action, method = self.url(lcfg.get("fallback_action", "servlet/cp_login")), "post"
            try:
                if method == "get":
                    await client.get(action, params=data)
                else:
                    await client.post(action, data=data)
            except httpx.HTTPError as exc:
                raise UpstreamError("Errore durante il login su Zucchetti", str(exc)) from exc
            if not await self._verify(client):
                raise LoginFailed("Login non riuscito: controlla nome utente e password.")
            session = ZucchettiSession(self, client, username)
            await session.discover_m_cid()
            return session
        except BaseException:
            await client.aclose()
            raise

    async def login_with_cookie(self, cookie: str, label: str) -> ConnectorSession:
        client = self._client()
        try:
            host = urlparse(self.cfg["base_url"]).hostname or ""
            count = 0
            for part in re.split(r";\s*", cookie.strip()):
                if "=" not in part:
                    continue
                name, value = part.split("=", 1)
                name = name.strip()
                if name.lower() in {"path", "domain", "expires", "max-age", "secure", "httponly", "samesite"}:
                    continue
                client.cookies.set(name, value.strip(), domain=host)
                count += 1
            if not count:
                raise LoginFailed("Cookie non valido: incolla il valore dell'intestazione Cookie.")
            if not await self._verify(client):
                raise LoginFailed("La sessione indicata dal cookie non è valida o è scaduta.")
            session = ZucchettiSession(self, client, label or "utente")
            await session.discover_m_cid()
            return session
        except BaseException:
            await client.aclose()
            raise
