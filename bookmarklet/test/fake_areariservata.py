"""Finta "Area Riservata" (vecchia Ricerca rapida) per provare il ponte del segnalibro.

Va avviata su un'altra porta rispetto al finto portale Touch, così le due schede sono due siti
diversi come nella realtà (www.zucchetti.it e il portale HDA TOUCH):

    python -m uvicorn bookmarklet.test.fake_areariservata:app --port 8772

Riproduce quanto visto sulla pagina reale (jsp/sipv_psearch_infi.jsp, SitePainter):
- i portlet ZtVWeb: la ricerca veloce spsl_wfast_search (sempre presente, con splResults.m_cID e
  g_UserLang) e i risultati spsl_wsolrresultsgrid (compare solo dopo la prima ricerca della pagina);
- il modulo Filtri nell'iframe gspv_winf_search, con le variabili w_<nome>, i setter Set_<nome>, il centro
  servizi in select[name=CentroServizi] e la funzione sipv_ffilters_search() che compone pKeyword:
      IdCenSer:PAOW and ( (IdMeseM:9 and IdAnnoM:2026 ) or ... ) and ( Testi:("x") or Oggetto:("x") )
  (con «Data di apertura» i campi IdMeseA/IdAnnoA, nomi inventati: quelli reali il segnalibro li chiede
  alla pagina);
- servlet/spsl_fquery_mc: senza pArea=TICKOPEXXX risponde {"errors":["TICKET"]}; senza sessione una
  pagina di accesso; altrimenti il motore demo, al massimo 210 righe, nel formato reale
  (fields/data/facet/maxResults/errors, titoli "[#numero] [prodotto] [gg-mm-aaaa] oggetto");
- la pagina del ticket (url1) disegnata da JavaScript dopo il caricamento, con campi e testo completo.
I dati sono inventati (motore demo).
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

MCID = "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"
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


def _run(request: Request) -> str:
    return request.headers.get("x-e2e-run", "")


# come la pagina reale: controls.js di SitePainter definisce una funzione globale Set(name) e MooTools
# ridefinisce Array.from
HOSTILE = """<script>
function Set(name){ return window["Set_" + name](); }
Array.from = function(item){ return item == null ? [] : (typeof item.length == "number" && typeof item != "string") ? Array.prototype.slice.call(item) : [item]; };
</script>"""

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Ricerca rapida (finta)</title>
__HOSTILE__
<script>
(function(){
  function VC(v){ this.v = v; } VC.prototype.Value = function(x){ if (arguments.length) this.v = x; return this.v; };
  function syncPost(url, body){ var x = new XMLHttpRequest(); x.open('POST', url, false);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); x.send(body); return x.responseText; }
  var enc = encodeURIComponent;
  var fast = { input: new VC(''), pCore: new VC('TICKET'), g_UserLang: new VC('ITA'), splResults: { m_cID: '__MCID__' } };
  // risultati (come phmio): il portlet esiste dopo la prima ricerca della pagina
  var grid = { userInput: new VC(''), area: new VC(''), langs: new VC(''),
    splResults: { m_cID: '__MCID__', Link: function(){
      return syncPost('../servlet/spsl_fquery_mc', 'pKeyword=' + enc(grid.userInput.Value()) + '&pArea=' + enc(grid.area.Value())
        + '&pCore=&pLangs=' + enc(grid.langs.Value()) + '&cs_SITE=&m_cID=' + this.m_cID);
    } },
    doSearch: function(){ var r = JSON.parse(this.splResults.Link()); document.getElementById('esito').textContent = (r.data || []).length + ' risultati'; }
  };
  var portlets = { spsl_wfast_search: fast };
  window.ZtVWeb = { getPortlet: function(n){ return portlets[n] || null; } };
  window.riceviRicercaDaiFiltri = function(input, area, langs){
    portlets.spsl_wsolrresultsgrid = grid;
    grid.userInput.Value(input); grid.area.Value(area); grid.langs.Value(langs);
    grid.doSearch();
  };
})();
</script></head><body>
<div id="bujlv_lblHeadertbl">RICERCA RAPIDA</div>
<iframe name="gspv_winf_search" src="../servlet/gspv_winf_search?m_cDecoration=none" style="width:100%;height:240px"></iframe>
<pre id="esito"></pre>
<p>Area Riservata finta per le prove del segnalibro.</p>
</body></html>"""

FILTERS = """<!doctype html><html><head><meta charset="utf-8">
<script>
var w_CentroServizi = '', w_DataRiferimento = 1, w_SceltaData = 0, w_MeseDa = 0, w_MeseA = 0, w_AnnoDa = 0, w_AnnoA = 0, w_TestoSearch = '', w_CercaIn = 2;
function Set_CentroServizi(v){ w_CentroServizi = v; document.getElementById('cs').value = v; }
function Set_DataRiferimento(v){ w_DataRiferimento = v; }
function Set_SceltaData(v){ w_SceltaData = v; }
function Set_MeseDa(v){ w_MeseDa = v; } function Set_MeseA(v){ w_MeseA = v; }
function Set_AnnoDa(v){ w_AnnoDa = v; } function Set_AnnoA(v){ w_AnnoA = v; }
function Set_TestoSearch(v){ w_TestoSearch = v; }
// come sipv_ffilters_search.js: compone pKeyword dalle variabili del modulo (senza cercare)
function sipv_ffilters_search(){
  var f = w_DataRiferimento == 2 ? ['IdMeseA', 'IdAnnoA'] : ['IdMeseM', 'IdAnnoM'];
  var mesi = [], y = +w_AnnoDa, m = +w_MeseDa;
  while (y < +w_AnnoA || (y == +w_AnnoA && m <= +w_MeseA)) { mesi.push('(' + f[0] + ':' + m + ' and ' + f[1] + ':' + y + ' )'); m++; if (m > 12) { m = 1; y++; } if (mesi.length > 60) break; }
  var kw = 'IdCenSer:' + w_CentroServizi + ' and ( ' + mesi.join(' or ') + '  ) ';
  if (w_TestoSearch) kw += ' and ( Testi:(' + w_TestoSearch + ') or Oggetto:(' + w_TestoSearch + ') )';
  return kw;
}
function RicercaTickets(){
  var d = new Date(); w_AnnoDa = w_AnnoA = d.getFullYear(); w_MeseA = d.getMonth() + 1; w_MeseDa = Math.max(1, w_MeseA - 2);
  var t = document.getElementById('testo').value;
  w_TestoSearch = t ? '"' + t + '"' : '';
  parent.riceviRicercaDaiFiltri(sipv_ffilters_search(), 'TICKOPEXXX', 'ITA');
}
window.onload = function(){ Set_CentroServizi('PAOW'); };
</script></head><body><form>
<select name="CentroServizi" id="cs"><option value=""></option><option value="PAOW">[HR] Paghe Infinity</option></select>
<select name="DataRiferimento"><option value="1">Data ultimo aggiornamento</option><option value="2">Data di apertura</option></select>
<textarea name="TestoSearchProv" id="testo"></textarea>
<input type="button" id="cerca" class="SPButton" value="Cerca" onclick="RicercaTickets()">
</form></body></html>"""

TICKET = """<!doctype html><html><head><meta charset="utf-8"><title>Ticket (finto)</title></head><body>
<div id="app">Caricamento...</div>
<script>
// come una pagina SitePainter: i dati arrivano dopo e vanno in campi in sola lettura
setTimeout(function(){
  var d = __DATA__;
  var app = document.getElementById('app');
  app.innerHTML = '';
  function row(lab, val){ var l = document.createElement('label'); l.textContent = lab; var i = document.createElement('input'); i.readOnly = true; i.value = val; i.id = 'f' + app.children.length; l.htmlFor = i.id; app.appendChild(l); app.appendChild(i); app.appendChild(document.createElement('br')); }
  row('Numero ticket', d.number); row('Data', d.date); row('Prodotto', d.product); row('Stato', d.stato); row('Operatore', d.operatore); row('Oggetto', d.subject);
  var l = document.createElement('label'); l.textContent = 'Testo'; var t = document.createElement('textarea'); t.readOnly = true; t.value = d.text; t.id = 'ftesto'; l.htmlFor = 'ftesto'; app.appendChild(l); app.appendChild(t);
  var h = document.createElement('h3'); h.textContent = 'Interventi'; app.appendChild(h);
  d.notes.forEach(function(n){ var p = document.createElement('p'); p.textContent = n; app.appendChild(p); });
}, 400);
</script></body></html>"""


@app.get("/areariservata/jsp/sipv_psearch_infi.jsp")
async def search_page(ostile: int = 0):
    page = PAGE.replace("__MCID__", MCID).replace("__HOSTILE__", HOSTILE if ostile else "")
    r = HTMLResponse(page)
    r.set_cookie("JSESSIONID", "ok", path="/areariservata")
    return r


@app.get("/areariservata/servlet/gspv_winf_search")
async def filters():
    return HTMLResponse(FILTERS)


@app.get("/areariservata/jsp/spsl_wfast_search_portlet.jsp")
async def fast_jsp(request: Request):
    if request.cookies.get("JSESSIONID") != "ok":
        return HTMLResponse('<form><input type="password" name="m_cPassword"></form>')
    return PlainTextResponse(f"this.splResults=new ZtVWeb.SPLinkerCtrl();\nthis.splResults.m_cID='{MCID}';")


@app.get("/areariservata/jsp/gspv_fticket.jsp")
async def ticket(request: Request, TKNUMERO: int = 0):
    LOG.append({"run": _run(request), "ticket": TKNUMERO})
    doc = next((d for d in index().docs if d.number == TKNUMERO), None)
    if doc is None:
        return HTMLResponse("<!doctype html><html><body>Ticket non trovato</body></html>")
    notes = [f"{doc.date_str} - {doc.operatore}: presa in carico.", f"{doc.date_str} - {doc.operatore}: {doc.text.split('. ')[0]}."]
    data = {"number": str(doc.number), "date": doc.date_str, "product": doc.product, "stato": doc.stato, "operatore": doc.operatore,
            "subject": doc.subject, "text": doc.text, "notes": notes}
    return HTMLResponse(TICKET.replace("__DATA__", json.dumps(data).replace("</", "<\\/")))


@app.post("/areariservata/servlet/spsl_fquery_mc")
async def fquery(request: Request):
    body = (await request.body()).decode("utf-8")
    params = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
    LOG.append({"run": _run(request), "params": params, "order": [p.split("=")[0] for p in body.split("&")], "cookie": request.cookies.get("JSESSIONID")})
    if request.cookies.get("JSESSIONID") != "ok":
        return HTMLResponse('<html><body><form><input type="password" name="m_cPassword"></form></body></html>')
    if params.get("m_cID") != MCID:
        return PlainTextResponse("Accesso non consentito", status_code=403)
    if params.get("pArea", "") != AREA or params.get("pLangs", "") not in {"ITA", "ENG"}:
        core = params.get("pCore") or "TICKET"
        return Response(json.dumps({"data": [], "maxResults": [], "fields": [], "facet": [], "errors": [core]}), media_type="text/plain")
    try:
        docs, words = index().search(params.get("pKeyword", ""), CAP)
    except demo_engine.QuerySyntaxError as exc:
        return JSONResponse({"fields": [], "data": [], "facet": [], "maxResults": [str(CAP)], "errors": [str(exc)]})
    LOG[-1]["rows"] = len(docs)
    payload = demo_engine.to_zucchetti_json(docs, words, CAP, "TICKET")
    for row, d in zip(payload["data"], docs):
        row[6] = f"../jsp/gspv_fticket.jsp?TKNUMERO={d.number}" if d.number % 7 else f"function:apriTicket('{d.number}')"
    payload["data"].append("t,C,-1")  # come la pagina reale: una riga che non è un elenco
    return Response(json.dumps(payload), media_type="text/plain; charset=utf-8")


@app.get("/__log")
async def get_log(run: str = ""):
    return JSONResponse([e for e in LOG if e.get("run") == run] if run else LOG)


@app.post("/__reset")
async def reset(run: str = ""):
    LOG[:] = [e for e in LOG if e.get("run") != run] if run else []
    return {"ok": True}


@app.get("/__count")
async def count(q: str = ""):
    """Quanti ticket del motore demo contengono la parola (per i controlli della prova)."""
    docs, _ = index().search(f'Testi:("{q}") or Oggetto:("{q}")', 100000)
    return {"total": len(docs), "censer": sorted({d.censer for d in docs})}
