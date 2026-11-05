"""Finto sito "Area Riservata" per provare il segnalibro senza Zucchetti.

Riproduce ciò che si è visto sul sito reale:
- la pagina di ricerca ha subito il portlet della ricerca veloce (spsl_wfast_search); il portlet
  dei risultati (spsl_wsolrresultsgrid) compare solo dopo la prima ricerca fatta dalla pagina;
- il modulo "Filtri" è l'iframe gspv_winf_search, con i codici reali (PAOW, CLOSE, HIGH...) nelle
  variabili w_<nome> e una query costruita come la pagina reale:
      IdCenSer:PAOW and ((IdMeseM:9 and IdAnnoM:2026) or ...) and (Testi:("x") or Oggetto:("x"))
- la routine servlet/spsl_fquery_mc risponde {"errors":["TICKET"]} senza pArea=TICKOPEXXX e con
  lingue non valide; altrimenti risponde con il motore demo e il limite di 210 risultati.

Il campo dello stato (IdStato) è inventato: quello reale il segnalibro lo impara dalla pagina.

    python -m uvicorn bookmarklet.test.fake_zucchetti:app --port 8770
"""
from __future__ import annotations

import html
import json
import threading
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response

from app.connectors import demo_engine

MCID = "e78b84ad59ea95692c27f98e5e270075"
CAP = 210
AREA = "TICKOPEXXX"
app = FastAPI()
LOG: list[dict] = []
_index = None
_lock = threading.Lock()
BOOKMARKLET = Path(__file__).resolve().parent.parent / "dist" / "bookmarklet.txt"


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
  function syncPost(url, body){ var x = new XMLHttpRequest(); x.open('POST', url, false);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); x.send(body); return x.responseText; }
  var enc = encodeURIComponent;
  // ricerca veloce della testata: pKeyword, pCore, pLangs (come yojyf.splResults)
  var fast = { input: new VC(''), pCore: new VC('TICKET'), g_UserLang: new VC('ITA'),
    splResults: { m_cID: '__MCID__', Link: function(){
      return syncPost('../servlet/spsl_fquery_mc', 'pKeyword=' + enc(fast.input.Value()) + '&pCore=' + enc(fast.pCore.Value()) + '&pLangs=' + enc(fast.g_UserLang.Value()) + '&m_cID=' + this.m_cID);
    } } };
  // portlet dei risultati (come phmio): compare dopo la prima ricerca dalla scheda Filtri
  var grid = { userInput: new VC(''), area: new VC(''), pCore: new VC(''), langs: new VC(''), cs_SITE: new VC(''),
    doResults: { rs: null },
    splResults: { m_cID: '__MCID__', Link: function(){
      return syncPost('../servlet/spsl_fquery_mc', 'pKeyword=' + enc(grid.userInput.Value()) + '&pArea=' + enc(grid.area.Value())
        + '&pCore=' + enc(grid.pCore.Value()) + '&pLangs=' + enc(grid.langs.Value()) + '&cs_SITE=&m_cID=' + this.m_cID);
    } },
    click: function(){ window.__clicked = this.doResults.rs.url1 + '|' + this.doResults.rs.id; },
    doSearch: function(){ var r = this.splResults.Link(); document.getElementById('esito').textContent = r.slice(0, 80); this.pCore.Value(''); }
  };
  var portlets = { spsl_wfast_search: fast };
  window.ZtVWeb = { getPortlet: function(n){ return portlets[n]; } };
  // evento della scheda Filtri verso i risultati: input, area, langs
  window.riceviRicercaDaiFiltri = function(input, area, langs){
    portlets.spsl_wsolrresultsgrid = grid;
    grid.userInput.Value(input); grid.area.Value(area); grid.langs.Value(langs);
    grid.doSearch();
  };
})();
</script></head><body>
<div id="bujlv_lblHeadertbl">RICERCA RAPIDA</div>
<iframe name="gspv_winf_search" src="../servlet/gspv_winf_search?m_cDecoration=none" style="width:100%;height:220px"></iframe>
<pre id="esito"></pre>
<p>Pagina finta per i test del segnalibro.</p>
</body></html>"""

FILTERS_FORM = """<!doctype html><html><head><meta charset="utf-8">
<script src="../servlet/SPPrxy/ktu0xgio/sipv_ffilters_search.js"></script>
<script>
var w_CentroServizi = 'PAOW', w_DataRiferimento = 1, w_StatoDett = '', w_Priorita = '', w_TestoSearchProv = '';
function Set_StatoDett(v){ w_StatoDett = v; document.getElementById('stato').value = v; }
function RicercaTickets(){
  var d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
  var mesi = [];
  for (var k = 2; k >= 0; k--) { var mm = m - k, yy = y; if (mm < 1) { mm += 12; yy -= 1; } mesi.push('(IdMeseM:' + mm + ' and IdAnnoM:' + yy + ' )'); }
  var kw = 'IdCenSer:' + w_CentroServizi + ' and ( ' + mesi.join(' or ') + '  ) ';
  var t = document.getElementById('testo').value;
  if (t) kw += ' and ( Testi:("' + t + '") or Oggetto:("' + t + '") )';
  if (w_StatoDett.trim()) kw += ' and IdStato:' + w_StatoDett.trim();
  parent.riceviRicercaDaiFiltri(kw, 'TICKOPEXXX', 'ITA');
}
</script></head><body><form id="filtri">
<select name="CentroServizi"><option value=""></option><option value="PAOW">[HR] Paghe Infinity</option></select>
<select name="DataRiferimento"><option value="1">Data ultimo aggiornamento</option><option value="2">Data di apertura</option></select>
<select name="StatoDett" id="stato" onchange="w_StatoDett=this.value"><option value=""></option><option value="OPEN ">Aperto</option><option value="00005">Lavorazione</option><option value="00008">Risolto</option><option value="CLOSE">Chiuso</option></select>
<select name="Priorita" onchange="w_Priorita=this.value"><option value=""></option><option value="HIGH ">Alta</option><option value="MED  ">Media</option><option value="LOW  ">Bassa</option></select>
<textarea name="TestoSearchProv" id="testo"></textarea>
<input type="button" id="cerca" value="Cerca" onclick="RicercaTickets()">
</form></body></html>"""


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


@app.get("/areariservata/servlet/SPPrxy/ktu0xgio/sipv_ffilters_search.js")
async def filters_script():
    return Response("function sipv_ffilters_search(){ /* finto */ return ''; }", media_type="application/javascript")


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
    params = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
    params.update({k: v for k, v in request.query_params.items()})
    LOG.append({"params": params, "cookie": request.cookies.get("JSESSIONID"), "ctype": request.headers.get("content-type")})
    if request.cookies.get("JSESSIONID") != "ok":
        return HTMLResponse('<html><body><form><input type="password" name="m_cPassword"></form></body></html>')
    if params.get("m_cID") != MCID:
        return PlainTextResponse("Accesso non consentito", status_code=403)
    # come la routine reale: senza l'area e lingue valide l'indice risponde con un errore
    if params.get("pArea", "") != AREA or params.get("pLangs", "") not in {"ITA", "ENG", "ITA,ENG"} or params.get("pCore", "") not in {"", "TICKET"}:
        core = params.get("pCore") or "TICKET"
        return Response(json.dumps({"data": [], "maxResults": [], "fields": [], "facet": [], "errors": [core]}), media_type="text/plain")
    try:
        docs, words = index().search(params.get("pKeyword", ""), CAP)
    except demo_engine.QuerySyntaxError as exc:
        return JSONResponse({"fields": [], "data": [], "facet": [], "maxResults": [str(CAP)], "errors": [str(exc)]})
    payload = demo_engine.to_zucchetti_json(docs, words, CAP, "TICKET")
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
