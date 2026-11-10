"""Applicazione web: API + interfaccia statica."""
from __future__ import annotations

import asyncio
import html
import json
import logging
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .connectors.base import Connector, LoginFailed, SessionExpired, UpstreamError
from .connectors.demo import DemoConnector
from .connectors.zucchetti import ZucchettiConnector
from .curl_import import CurlParseError, parse_curl, to_template
from .models import SearchSpec
from .parser import UpstreamFormatError, parse_response
from .query import Profile, QueryError, build_query
from .search import run_search
from .sessions import AppSession, SessionStore
from .settings import BASE_DIR, Settings, get_settings
from .store import Store

log = logging.getLogger("ricerca_tkt")
STATIC_DIR = BASE_DIR / "static"
VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# Modelli delle richieste
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    connector: str = Field(..., max_length=40)
    username: str = Field("", max_length=200)
    password: str = Field("", max_length=500)
    cookie: str = Field("", max_length=20000)


class SaveSearchRequest(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., min_length=1, max_length=200)
    spec: dict


class FavoriteRequest(BaseModel):
    key: str = Field(..., min_length=1, max_length=200)
    ticket: dict
    note: str = Field("", max_length=10000)
    tags: list[str] = Field(default_factory=list, max_length=30)


class DiagRawRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=8000)
    core: Optional[str] = None
    area: Optional[str] = None
    langs: Optional[str] = None


class DiagCurlRequest(BaseModel):
    curl: str = Field(..., min_length=5, max_length=100000)
    keyword: str = Field("", max_length=500)
    save: bool = False


# ---------------------------------------------------------------------------
# Applicazione
# ---------------------------------------------------------------------------


class _LoginLimiter:
    def __init__(self, per_10min: int):
        self.limit = per_10min
        self.hits: dict[str, deque] = defaultdict(deque)

    def check(self, ip: str) -> bool:
        now = time.monotonic()
        q = self.hits[ip]
        while q and now - q[0] > 600:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()
    zcfg = settings.load_zucchetti_config()
    connectors: dict[str, Connector] = {}
    for cid in settings.connectors:
        if cid == "zucchetti":
            connectors[cid] = ZucchettiConnector(zcfg, settings.data_dir)
        elif cid == "demo":
            connectors[cid] = DemoConnector(zcfg, settings.demo_size, settings.demo_latency_ms)
    if not connectors:
        raise RuntimeError("Nessun connettore abilitato (variabile CONNECTORS)")
    profiles = {cid: Profile(c.profile_data()) for cid, c in connectors.items()}
    store = Store(settings.data_dir / "app.db")
    sessions = SessionStore(settings.session_idle_minutes, settings.max_sessions, settings.cache_ttl_seconds)
    limiter = _LoginLimiter(settings.login_attempts_per_10min)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def janitor():
            while True:
                await asyncio.sleep(60)
                try:
                    await sessions.cleanup()
                except Exception:  # noqa: BLE001
                    log.exception("pulizia sessioni")

        task = asyncio.create_task(janitor())
        try:
            yield
        finally:
            task.cancel()
            await sessions.close_all()

    app = FastAPI(title="Ricerca TKT", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.sessions = sessions
    app.state.store = store
    app.state.connectors = connectors

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    # --- dipendenze -----------------------------------------------------------
    def csrf(request: Request) -> None:
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            if request.headers.get("x-rtkt") != "1":
                raise HTTPException(403, "Richiesta non consentita")
            origin = request.headers.get("origin")
            if origin:
                host = request.headers.get("host", "")
                if origin.split("://", 1)[-1].rstrip("/") != host:
                    raise HTTPException(403, "Origine non consentita")

    def current(request: Request) -> AppSession:
        s = sessions.get(request.cookies.get(settings.cookie_name))
        if s is None:
            raise HTTPException(401, "Sessione scaduta: accedi di nuovo")
        return s

    def require_diag() -> None:
        if not settings.diagnostics:
            raise HTTPException(404, "Non trovato")

    # --- pagine -----------------------------------------------------------------
    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    async def index():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/demo/ticket/{number}", include_in_schema=False)
    async def demo_ticket(number: int, s: AppSession = Depends(current)):
        conn = connectors.get(s.connector_id)
        data = conn.ticket_page(number) if conn else None
        if not data:
            raise HTTPException(404, "Ticket non trovato")
        rows = "".join(
            f"<tr><th>{html.escape(k)}</th><td>{html.escape(str(v))}</td></tr>" for k, v in data.items()
        )
        page = (
            "<!doctype html><html lang='it'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>Ticket {number} (demo)</title><link rel='stylesheet' href='/static/css/app.css'></head>"
            f"<body class='ticket-page'><main><h1>Ticket #{number} <span class='badge'>demo</span></h1>"
            f"<table class='kv'>{rows}</table></main></body></html>"
        )
        return HTMLResponse(page)

    # --- autenticazione ----------------------------------------------------------
    @app.get("/api/config")
    async def api_config():
        return {
            "version": VERSION,
            "connectors": [c.public() for c in connectors.values()],
            "diagnostics": settings.diagnostics,
        }

    @app.post("/api/login", dependencies=[Depends(csrf)])
    async def api_login(body: LoginRequest, request: Request, response: Response):
        ip = request.client.host if request.client else "?"
        if not limiter.check(ip):
            raise HTTPException(429, "Troppi tentativi di accesso: riprova tra qualche minuto")
        conn = connectors.get(body.connector)
        if conn is None:
            raise HTTPException(400, "Connettore non disponibile")
        username = body.username.strip()
        if settings.allowed_users and body.connector != "demo" and username.lower() not in settings.allowed_users:
            raise HTTPException(403, "Utente non abilitato a questa applicazione")
        try:
            if body.cookie.strip():
                if not username:
                    raise HTTPException(400, "Indica il nome utente associato alla sessione")
                remote = await conn.login_with_cookie(body.cookie, username)
            else:
                if not username or not body.password:
                    raise HTTPException(400, "Inserisci nome utente e password")
                remote = await conn.login(username, body.password)
        except LoginFailed as exc:
            raise HTTPException(401, str(exc)) from exc
        except UpstreamError as exc:
            log.warning("login upstream error: %s %s", exc, exc.detail[:300])
            raise HTTPException(502, str(exc)) from exc
        old = request.cookies.get(settings.cookie_name)
        if old:
            await sessions.destroy(old)
        s = sessions.create(conn.id, username, remote)
        await sessions.enforce_limit()
        response.set_cookie(
            settings.cookie_name, s.sid, httponly=True, samesite="strict",
            secure=settings.cookie_secure, path="/",
        )
        return {"user": s.username, "connector": s.connector_id}

    @app.post("/api/logout", dependencies=[Depends(csrf)])
    async def api_logout(request: Request, response: Response):
        sid = request.cookies.get(settings.cookie_name)
        if sid:
            await sessions.destroy(sid)
        response.delete_cookie(settings.cookie_name, path="/")
        return {"ok": True}

    @app.get("/api/me")
    async def api_me(request: Request):
        s = sessions.get(request.cookies.get(settings.cookie_name))
        if s is None:
            return {"authenticated": False}
        conn = connectors[s.connector_id]
        return {
            "authenticated": True,
            "user": s.username,
            "connector": conn.public(),
            "profile": profiles[s.connector_id].public(),
            "diagnostics": settings.diagnostics,
        }

    # --- ricerca -------------------------------------------------------------------
    @app.post("/api/query-preview", dependencies=[Depends(csrf)])
    async def api_query_preview(spec: SearchSpec, s: AppSession = Depends(current)):
        try:
            built = build_query(spec, profiles[s.connector_id])
        except QueryError as exc:
            return {"query": "", "error": str(exc), "warnings": []}
        return {"query": built.query, "warnings": built.warnings, "error": ""}

    @app.post("/api/search", dependencies=[Depends(csrf)])
    async def api_search(spec: SearchSpec, s: AppSession = Depends(current)):
        profile = profiles[s.connector_id]
        try:
            built = build_query(spec, profile)
        except QueryError as exc:
            raise HTTPException(400, str(exc)) from exc

        queue: asyncio.Queue = asyncio.Queue()

        async def emit(ev: dict) -> None:
            await queue.put(ev)

        async def runner():
            try:
                stats = await run_search(s.remote, profile, spec, emit, cache=s.cache, built=built)
                summary = spec.text.strip() or spec.phrase.strip() or spec.numbers.strip() or "(solo filtri)"
                await asyncio.to_thread(
                    store.add_history, s.user_key, spec.model_dump(mode="json"), summary, stats["found"]
                )
            except asyncio.CancelledError:
                raise
            except SessionExpired:
                await queue.put({"type": "error", "code": "session_expired",
                                 "message": "La sessione Zucchetti è scaduta: accedi di nuovo."})
                asyncio.create_task(sessions.destroy(s.sid))
            except UpstreamFormatError as exc:
                log.warning("formato risposta inatteso: %s", exc.sample[:300])
                await queue.put({"type": "error", "code": "format",
                                 "message": f"{exc}. Usa la pagina Diagnostica per verificare la configurazione."})
            except UpstreamError as exc:
                await queue.put({"type": "error", "code": "upstream", "message": str(exc)})
            except Exception:  # noqa: BLE001
                log.exception("errore ricerca")
                await queue.put({"type": "error", "code": "internal", "message": "Errore interno durante la ricerca"})
            finally:
                await queue.put(None)

        if s.active_search and not s.active_search.done():
            s.active_search.cancel()
        task = asyncio.create_task(runner())
        s.active_search = task

        async def stream():
            try:
                while True:
                    ev = await queue.get()
                    if ev is None:
                        break
                    yield json.dumps(ev, ensure_ascii=False) + "\n"
            finally:
                if not task.done():
                    task.cancel()

        return StreamingResponse(stream(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.get("/api/suggest")
    async def api_suggest(q: str = "", s: AppSession = Depends(current)):
        q = q.strip()[:100]
        if len(q) < 2:
            return {"suggestions": []}
        hist = await asyncio.to_thread(store.history_terms, s.user_key, q)
        head, _, last = q.rpartition(" ")
        remote: list[str] = []
        if len(last) >= 2:
            try:
                words = await asyncio.wait_for(s.remote.suggest(last), timeout=3)
                remote = [(head + " " + w).strip() for w in words]
            except Exception:  # noqa: BLE001
                remote = []
        out: list[str] = []
        for item in hist + remote:
            if item not in out:
                out.append(item)
        return {"suggestions": out[:10]}

    # --- ricerche salvate, cronologia, preferiti --------------------------------------
    @app.get("/api/saved")
    def api_saved(s: AppSession = Depends(current)):
        return {"items": store.list_saved(s.user_key)}

    @app.post("/api/saved", dependencies=[Depends(csrf)])
    def api_save(body: SaveSearchRequest, s: AppSession = Depends(current)):
        SearchSpec.model_validate(body.spec)  # validazione
        sid = store.save_search(s.user_key, body.name.strip(), body.spec, body.id)
        return {"id": sid}

    @app.delete("/api/saved/{search_id}", dependencies=[Depends(csrf)])
    def api_saved_delete(search_id: int, s: AppSession = Depends(current)):
        return {"ok": store.delete_saved(s.user_key, search_id)}

    @app.get("/api/history")
    def api_history(s: AppSession = Depends(current)):
        return {"items": store.list_history(s.user_key)}

    @app.delete("/api/history", dependencies=[Depends(csrf)])
    def api_history_clear(s: AppSession = Depends(current)):
        store.clear_history(s.user_key)
        return {"ok": True}

    @app.get("/api/favorites")
    def api_favorites(s: AppSession = Depends(current)):
        return {"items": store.list_favorites(s.user_key)}

    @app.post("/api/favorites", dependencies=[Depends(csrf)])
    def api_favorite_save(body: FavoriteRequest, s: AppSession = Depends(current)):
        if len(json.dumps(body.ticket)) > 50000:
            raise HTTPException(413, "Ticket troppo grande")
        tags = [t.strip()[:40] for t in body.tags if t.strip()]
        store.upsert_favorite(s.user_key, body.key, body.ticket, body.note, tags)
        return {"ok": True}

    @app.delete("/api/favorites/{key}", dependencies=[Depends(csrf)])
    def api_favorite_delete(key: str, s: AppSession = Depends(current)):
        return {"ok": store.delete_favorite(s.user_key, key)}

    # --- diagnostica (solo con APP_DIAGNOSTICS=1) -----------------------------------
    @app.get("/api/diag", dependencies=[Depends(require_diag)])
    async def api_diag(s: AppSession = Depends(current)):
        info = {"connector": s.connector_id, "user": s.username}
        remote = s.remote
        if s.connector_id == "zucchetti":
            conn: ZucchettiConnector = connectors["zucchetti"]  # type: ignore[assignment]
            info.update({
                "base_url": conn.cfg.get("base_url"),
                "m_cID": getattr(remote, "m_cID", None),
                "m_cID_source": getattr(remote, "m_cID_source", ""),
                "template": conn.template(),
            })
        return info

    @app.post("/api/diag/raw", dependencies=[Depends(csrf), Depends(require_diag)])
    async def api_diag_raw(body: DiagRawRequest, s: AppSession = Depends(current)):
        pub = profiles[s.connector_id].public()
        core = body.core if body.core is not None else pub["default_core"]
        area = body.area if body.area is not None else pub["default_area"]
        langs = body.langs if body.langs is not None else pub["default_langs"]
        req = s.remote.describe_request(body.query, core, area, langs)
        try:
            raw = await s.remote.search_raw(body.query, core, area, langs)
        except SessionExpired as exc:
            raise HTTPException(401, "Sessione scaduta") from exc
        except UpstreamError as exc:
            return {"request": req, "error": str(exc), "detail": exc.detail[:5000]}
        result: dict = {"request": req, "raw": raw[:200000], "raw_length": len(raw)}
        try:
            parsed = parse_response(raw, profiles[s.connector_id].data.get("parse", {}),
                                    profiles[s.connector_id].cap, core)
            result["parsed"] = {
                "count": parsed.raw_count, "capped": parsed.capped, "max_results": parsed.max_results,
                "errors": parsed.errors, "facets": parsed.facets[:20],
                "sample": [t.to_dict() for t in parsed.tickets[:5]],
            }
        except UpstreamFormatError as exc:
            result["parse_error"] = str(exc)
        return result

    @app.post("/api/diag/import-curl", dependencies=[Depends(csrf), Depends(require_diag)])
    async def api_diag_curl(body: DiagCurlRequest, s: AppSession = Depends(current)):
        conn = connectors.get("zucchetti")
        if conn is None:
            raise HTTPException(400, "Connettore Zucchetti non abilitato")
        try:
            parsed = parse_curl(body.curl)
            tpl = to_template(parsed, conn.cfg["base_url"], body.keyword.strip())  # type: ignore[attr-defined]
        except CurlParseError as exc:
            raise HTTPException(400, str(exc)) from exc
        saved = False
        if body.save:
            path = conn.template_path  # type: ignore[attr-defined]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(tpl, indent=2, ensure_ascii=False), encoding="utf-8")
            saved = True
            if s.connector_id == "zucchetti":
                await s.remote.discover_m_cid()  # type: ignore[attr-defined]
        return {"template": tpl, "saved": saved, "had_cookie": parsed["had_cookie"]}

    @app.delete("/api/diag/template", dependencies=[Depends(csrf), Depends(require_diag)])
    async def api_diag_template_delete(s: AppSession = Depends(current)):
        conn = connectors.get("zucchetti")
        if conn is None:
            raise HTTPException(400, "Connettore Zucchetti non abilitato")
        try:
            conn.template_path.unlink()  # type: ignore[attr-defined]
        except FileNotFoundError:
            pass
        return {"ok": True}

    return app


def get_app() -> FastAPI:
    """Factory per uvicorn: `uvicorn app.main:get_app --factory`."""
    return create_app()
