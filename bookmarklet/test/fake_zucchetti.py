"""Finto sito "Area Riservata" per provare il segnalibro senza Zucchetti.

Riproduce ciò che si vede nell'outerHTML reale: un oggetto ZtVWeb con il portlet
`spsl_wsolrresultsgrid`, il cui `splResults.Link()` fa una chiamata sincrona alla
routine `servlet/spsl_fquery_mc`, e l'iframe dei filtri. Le risposte arrivano dal
motore demo con il limite di 210 risultati.

    python -m uvicorn bookmarklet.test.fake_zucchetti:app --port 8770
"""
from __future__ import annotations

import html
import json
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response

from app.connectors import demo_engine

MCID = "1ef51ea72b7e79d713e5b1b42030dfa2"
CAP = 210
app = FastAPI()
LOG: list[dict] = []
_index = None
_lock = threading.Lock()


def index() -> demo_engine.DemoIndex:
    global _index
    with _lock:
        if _index is None:
            _index = demo_engine.DemoIndex(demo_engine.generate(12000))
        return _index


# Come nella pagina reale: controls.js di SitePainter definisce una funzione globale Set(name)
# e MooTools ridefinisce Array.from. Altre ridefinizioni simulate per prudenza.
HOSTILE = """<script>
function Set(name){ return window["Set_" + name](); }
window.Map = function(){ throw new Error("Map ridefinita dalla pagina"); };
Array.from = function(item){ return item == null ? [] : (typeof item.length == "number" && typeof item != "string") ? Array.prototype.slice.call(item) : [item]; };
window.Intl = { NumberFormat: function(){ throw new Error("Intl ridefinito"); } };
</script>"""

SEARCH_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Ricerca rapida (finta)</title>
__HOSTILE__
<script>
(function(){
  function VC(v){ this.v = v; } VC.prototype.Value = function(x){ if (arguments.length) this.v = x; return this.v; };
  function JSURL(url){ this.url = url; }
  JSURL.prototype.Response = function(){
    var parts = this.url.split('?'); var x = new XMLHttpRequest();
    x.open('POST', parts[0], false);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
    x.send(parts[1] || ''); return x.responseText;
  };
  var portlet = {
    userInput: new VC(''), area: new VC(''), pCore: new VC(''), langs: new VC(''), cs_SITE: new VC(''),
    doResults: { rs: null },
    splResults: { m_cID: '__MCID__', Link: function(){
      var p = portlet;
      var q = 'm_cID=' + this.m_cID + '&pKeyword=' + encodeURIComponent(p.userInput.Value()) + '&pArea=' + encodeURIComponent(p.area.Value())
        + '&pCore=' + encodeURIComponent(p.pCore.Value()) + '&pLangs=' + encodeURIComponent(p.langs.Value()) + '&cs_SITE=';
      return new JSURL('../servlet/spsl_fquery_mc?' + q).Response();
    } },
    click: function(){ window.__clicked = this.doResults.rs.url1 + '|' + this.doResults.rs.id; },
    // come doSearch() dopo "Cerca" nella scheda Filtri: i valori arrivano dal modulo dei filtri
    doSearch: function(){ var r = this.splResults.Link(); document.getElementById('esito').textContent = r.slice(0, 80); this.pCore.Value(''); }
  };
  window.cercaDallaPagina = function(){
    portlet.userInput.Value('detassazione AND (TKSTATO:"Chiuso")'); portlet.area.Value('HR'); portlet.langs.Value('ITA,ENG');
    portlet.doSearch();
  };
  var portlets = { spsl_wsolrresultsgrid: portlet };
  window.ZtVWeb = { getPortlet: function(n){ return portlets[n]; } };
})();
</script></head><body>
<div id="bujlv_lblHeadertbl">RICERCA RAPIDA</div>
<iframe name="gspv_winf_search" src="../servlet/gspv_winf_search?m_cDecoration=none" style="width:100%;height:200px"></iframe>
<p>Pagina finta per i test del segnalibro.</p>
<button id="cerca-pagina" onclick="cercaDallaPagina()">Cerca (scheda Filtri)</button><pre id="esito"></pre>
</body></html>"""

FILTERS_FORM = """<!doctype html><html><body><form id="filtri">
<label>Stato tickets <input name="w_STATO"></label>
<script>/* qui la pagina reale costruisce la query: TKSTATO:"..." */</script>
</form></body></html>"""


BOOKMARKLET = Path(__file__).resolve().parent.parent / "dist" / "bookmarklet.txt"


@app.get("/areariservata/jsp/gspv_psearch.jsp")
async def search_page(ostile: int = 0):
    """Con ?ostile=1 la pagina ridefinisce Set, Map, Array.from e Intl come le pagine reali
    e contiene già il link del segnalibro (il test lo clicca senza eseguire codice nella pagina)."""
    page = SEARCH_PAGE.replace("__MCID__", MCID).replace("__HOSTILE__", HOSTILE if ostile else "")
    if ostile:
        href = html.escape(BOOKMARKLET.read_text(encoding="utf-8").strip(), quote=True)
        page = page.replace("<body>", f'<body><a id="__bm" href="{href}">Ricerca TKT</a>', 1)
    r = HTMLResponse(page)
    r.set_cookie("JSESSIONID", "ok", path="/areariservata")
    return r


@app.get("/areariservata/jsp/home.jsp")
async def home():
    r = HTMLResponse("<!doctype html><html><body><h1>Home Area Riservata (finta)</h1></body></html>")
    r.set_cookie("JSESSIONID", "ok", path="/areariservata")
    return r


@app.get("/altro/pagina.html")
async def other():
    return HTMLResponse("<!doctype html><html><body>Altro sito</body></html>")


@app.get("/areariservata/servlet/gspv_winf_search")
async def filters():
    return HTMLResponse(FILTERS_FORM)


@app.get("/areariservata/jsp/spsl_wsolrresultsgrid_portlet.jsp")
async def portlet_jsp(request: Request):
    if request.cookies.get("JSESSIONID") != "ok":
        return HTMLResponse('<form><input type="password" name="m_cPassword"></form>')
    return PlainTextResponse(f"this.splResults=new ZtVWeb.SPLinkerCtrl();\nthis.splResults.m_cID='{MCID}';")


@app.get("/areariservata/jsp/gspv_fticket.jsp")
async def ticket(TKNUMERO: int = 0):
    return HTMLResponse(f"<!doctype html><html><body><h1>Ticket {TKNUMERO}</h1></body></html>")


@app.post("/areariservata/servlet/spsl_fquery_mc")
async def fquery(request: Request):
    body = (await request.body()).decode("utf-8")
    from urllib.parse import parse_qs

    params = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
    params.update({k: v for k, v in request.query_params.items()})
    LOG.append({"params": params, "cookie": request.cookies.get("JSESSIONID"), "ctype": request.headers.get("content-type")})
    if request.cookies.get("JSESSIONID") != "ok":
        return HTMLResponse('<html><body><form><input type="password" name="m_cPassword"></form></body></html>')
    if params.get("m_cID") != MCID:
        return PlainTextResponse("Accesso non consentito", status_code=403)
    # come la routine reale: senza lingue valide l'indice risponde con un errore
    if params.get("pLangs", "") not in {"ITA", "ENG", "ITA,ENG"}:
        core = params.get("pCore") or "TICKET"
        return Response(json.dumps({"data": [], "maxResults": [], "fields": [], "facet": [], "errors": [core]}), media_type="text/plain")
    try:
        docs, words = index().search(params.get("pKeyword", ""), CAP)
    except demo_engine.QuerySyntaxError as exc:
        return JSONResponse({"fields": [], "data": [], "facet": [], "maxResults": [str(CAP)], "errors": [str(exc)]})
    payload = demo_engine.to_zucchetti_json(docs, words, CAP, params.get("pCore") or "TICKET")
    for row, d in zip(payload["data"], docs):
        row[6] = f"../jsp/gspv_fticket.jsp?TKNUMERO={d.number}" if d.number % 2 == 0 else f"function:apriTicket('{d.number}')"
    payload["data"].append("t,C,-1")
    return Response(json.dumps(payload), media_type="text/plain; charset=utf-8")


@app.get("/__log")
async def get_log():
    return JSONResponse(LOG)


@app.post("/__reset")
async def reset():
    LOG.clear()
    return {"ok": True}
