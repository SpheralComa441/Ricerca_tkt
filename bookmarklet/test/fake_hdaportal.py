"""Finto portale ticket "HDAPortal" per provare il segnalibro senza Zucchetti.

Riproduce la struttura vista sul portale reale (ExtJS 6, schede "My tickets" / "All tickets"):
- un modulo elenco per scheda: pannello <id>_UC_ListCt con classi "module list entity-incident",
  area filtri con i campi <id>_UC_filter_default_<Nome> e gli stessi nomi dei campi (FullText,
  Subject, Date, LastChange, TicketStatusID, TicketPriorityID, ServiceID, CTITM.TranslatedDescription...),
  griglia <id>_UC_grd con le colonne ID, Date, Site, Subject (con il riepilogo nel title), Status...;
- archivio ExtJS con proxy ajax, paginazione, ordinamento per data decrescente e un token
  anti-falsificazione obbligatorio nell'intestazione (dal modulo _AntiForgeryForm);
- pulsanti "Open" e "Find by ID..." che aprono il ticket in una nuova scheda.

I dati sono inventati (motore demo). Il modo in cui la pagina applica i filtri sul portale reale
non è noto, quindi è configurabile per provare il segnalibro in tutti i casi:
    ?apply=auto   i filtri si applicano da soli quando cambiano (dopo una breve attesa)
    ?apply=enter  solo premendo Invio in un campo di testo; i valori vengono letti in quel momento
    ?apply=none   nessuna applicazione automatica: i valori vengono letti a ogni caricamento
    ?tab=all      si apre direttamente sulla scheda All tickets (altrimenti sulla Home)
    ?ostile=1     la pagina ridefinisce Set, Map, Array.from e Intl e contiene già il segnalibro

ExtJS (GPL) non è nel repository: vedi il README per scaricarlo in bookmarklet/test/vendor/.

    python -m uvicorn bookmarklet.test.fake_hdaportal:app --port 8770
"""
from __future__ import annotations

import html
import json
import random
import re
import threading
import unicodedata
import zlib
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse

from app.connectors import demo_engine

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "package" / "build"
BOOKMARKLET = HERE.parent / "dist" / "bookmarklet.txt"
TOKEN = "tok-prova-7f3a"
MAX_LIMIT = 500
app = FastAPI()
LOG: list[dict] = []
_lock = threading.Lock()
_data: list[dict] | None = None

STATUSES = [
    ("S1", "New"), ("S2", "In progress"), ("S3", "Pending"), ("S4", "Solved"), ("S5", "Closed"),
    ("S6", "Discarded"), ("S7", "Awaiting user feedback"), ("S8", "Feedback received"), ("S10", "Forwarded"),
    ("Z1C", "Agreed suspension"), ("Z2C", "Direct closure"), ("Z3C", "Appointment reached"),
    ("Z4C", "Reopened"), ("Z5C", "Assigned"), ("Z6C", "Awaiting external provider"),
]
OPEN_DEFAULT = ["S1", "S2", "S8", "S10", "Z3C", "Z4C", "Z5C"]
PRIORITIES = [("P1", "P1 - Critical"), ("P2", "P2 - High"), ("P3", "P3 - Medium"), ("P4", "P4 - Low"), ("P5", "P5 - Planning")]
PRIO_MAP = {"Urgente": "P1", "Alta": "P2", "Normale": "P3", "Bassa": "P4"}
PRODUCT_NAMES = {"PAGHEW": "PAGHE INFINITY", "HRINF": "HR INFINITY", "PRESWEB": "PRESENZE WEB", "HRPORTAL": "PORTALE HR"}
SERVICES: list[tuple[str, str]] = []
for _i, (_tip, _prod) in enumerate((t, p) for t in ("Informazione", "Anomalia", "Richiesta") for p in PRODUCT_NAMES.values()):
    SERVICES.append((f"SV{_i + 1}", f"{_tip} / {_prod}"))
SERVICE_IDS = {text: code for code, text in SERVICES}


def norm(s: str) -> str:
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()


def ms(dt: datetime) -> str:
    return f"/Date({int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)})/"


def data() -> list[dict]:
    global _data
    with _lock:
        if _data is None:
            rng = random.Random(7)
            today = date.today()
            rows = []
            for d in demo_engine.generate(6000, seed=11):
                if d.stato in ("Chiuso",):
                    st = rng.choice(["S5"] * 8 + ["Z2C", "S6"])
                elif d.stato == "Risolto":
                    st = "S4"
                elif d.stato == "In lavorazione":
                    st = rng.choice(["S2", "Z5C", "S10"])
                elif d.stato == "Aperto":
                    st = rng.choice(["S1", "Z4C"])
                else:
                    st = rng.choice(["S7", "S8", "S3", "Z3C", "Z1C", "Z6C"])
                opened = datetime.combine(d.date, time(rng.randint(8, 18), rng.randint(0, 59)))
                changed = min(datetime.combine(today, time(23, 0)), opened + timedelta(days=rng.randint(0, 40), hours=rng.randint(0, 8)))
                tip = {"Anomalia": "Anomalia", "Richiesta informazioni": "Informazione"}.get(d.tipologia, "Richiesta")
                service = f"{tip} / {PRODUCT_NAMES.get(d.product, d.product)}"
                closed = st in ("S4", "S5", "Z2C")
                rows.append({
                    "RecId": d.idx + 1, "TicketCode": f"{d.number + 3_000_000}Z",
                    "Date": opened, "LastChange": changed,
                    "Subject": d.subject, "Description": d.text,
                    "Resolution": ("Risolto: " + d.text.split(". ")[-1]) if closed else "-",
                    "AccountName": d.azienda.upper(), "AccountCode": str(200000 + zlib.crc32(d.azienda.encode()) % 90000),
                    "ContactName": d.persona.upper(), "TicketStatusID": st, "TicketStatusText": dict(STATUSES)[st],
                    "TicketPriorityID": PRIO_MAP.get(d.priorita, "P3"),
                    "TicketPriorityText": dict(PRIORITIES)[PRIO_MAP.get(d.priorita, "P3")],
                    "ServiceID": SERVICE_IDS.get(service, ""), "ServiceText": service,
                    "CatalogItemText": f"{d.classificazione} / {d.argomento}",
                    "AssignedTo": d.operatore, "OwnerGroup": d.gruppo, "Tags": "normativa" if rng.random() < 0.1 else "",
                    "Sla": rng.choice(["", "OK", "In scadenza", "Scaduto"]),
                    "_hay": norm(" ".join([d.subject, d.text, d.azienda, f"{d.number + 3_000_000}Z"])),
                })
            rows.sort(key=lambda r: r["Date"], reverse=True)
            _data = rows
        return _data


def to_json(r: dict) -> dict:
    out = {k: v for k, v in r.items() if not k.startswith("_")}
    out["Date"] = ms(r["Date"])
    out["LastChange"] = ms(r["LastChange"])
    return out


def parse_day(v: str) -> date | None:
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def apply_filters(rows: list[dict], filters: list[dict]) -> list[dict]:
    out = rows
    for f in filters:
        name, op, v = f.get("name"), f.get("op"), f.get("value")
        if v in (None, "", []):
            continue
        if name == "FullText":
            words = [w for w in re.findall(r"[0-9a-z]+", norm(str(v))) if w]
            out = [r for r in out if all(w in r["_hay"] for w in words)]
        elif name == "Subject":
            out = [r for r in out if norm(str(v)) in norm(r["Subject"])]
        elif name in ("Date", "LastChange"):
            day = parse_day(v)
            if day:
                out = [r for r in out if (r[name].date() >= day if op == "ge" else r[name].date() <= day)]
        elif name in ("TicketStatusID", "TicketPriorityID"):
            vals = set(v if isinstance(v, list) else str(v).split(","))
            out = [r for r in out if r[name] in vals]
        elif name == "ServiceID":
            out = [r for r in out if r["ServiceID"] == v]
        elif name == "CTITM.TranslatedDescription":
            out = [r for r in out if norm(str(v)) in norm(r["CatalogItemText"])]
        elif name == "AccountID":
            out = [r for r in out if r["AccountCode"] == v]
    return out


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Portale ticket (finto)</title>
<link rel="stylesheet" href="/__vendor/classic/theme-triton/resources/theme-triton-all.css">
<script src="/__vendor/ext-all.js"></script>
__HOSTILE__
<style>.tkt-open{font:600 20px sans-serif;margin:16px}</style>
</head><body id="icrm_container" class="desktop">
<form id="_AntiForgeryForm"><input type="hidden" name="_RVT" value="__TOKEN__"></form>
__BM__
<script>
window.__opened = []; window.__activity = 0;
window.Portal = { Const: { LoggedUser: { Name: "Utente di prova" } }, PageManager: {}, MessageBus: {} };
var CFG = { apply: "__APPLY__", tab: "__TAB__", statuses: __STATUSES__, open: __OPEN__, priorities: __PRIORITIES__, services: __SERVICES__ };
Ext.onReady(function () {
  Ext.ns("Ext.ux");
  Ext.ux.ActivityMonitor = { lastActive: new Date(), captureActivity: function () { this.lastActive = new Date(); window.__activity++; } };
  var token = document.querySelector("#_AntiForgeryForm input[name=_RVT]").value;
  Ext.Ajax.setDefaultHeaders({ RequestVerificationToken: token });
  Ext.define("Fake.Ticket", { extend: "Ext.data.Model", idProperty: "RecId", fields: [
    { name: "RecId", type: "int" }, "TicketCode", { name: "Date", type: "date", dateFormat: "MS" }, { name: "LastChange", type: "date", dateFormat: "MS" },
    "Subject", "Description", "Resolution", "AccountName", "AccountCode", "ContactName", "TicketStatusID", "TicketStatusText",
    "TicketPriorityID", "TicketPriorityText", "ServiceID", "ServiceText", "CatalogItemText", "AssignedTo", "OwnerGroup", "Tags", "Sla"] });
  var enc = Ext.String.htmlEncode;
  function multi(a, b) { return '<div class="list-cell"><div class="list-cell-multitext"><div class="text-default">' + enc(a || "") + '</div><div class="text-caption">' + enc(b || "") + "</div></div></div>"; }
  function dt(v) { return v ? '<div class="list-cell list-cell-datetime"><div class="list-cell-multitext"><div class="text-datetime-date">' + Ext.Date.format(v, "n/j/Y") + '</div><div class="text-datetime-time">' + Ext.Date.format(v, "g:i a") + "</div></div></div>" : ""; }
  var tabs;
  function openTicket(code, subject) {
    window.__opened.push(code);
    var id = "ticket_" + code.replace(/\\W/g, "");
    var t = Ext.getCmp(id) || tabs.add({ title: "Ticket " + code, id: id, closable: true, html: '<div class="tkt-open">' + enc(code) + "</div><p>" + enc(subject || "") + "</p>" });
    tabs.setActiveTab(t);
  }
  function makeModule(prefix, key, defaultStatuses) {
    var P = prefix + "_UC_";
    var fields = [];
    function fld(cfg) { var f = Ext.create(cfg.xclass || "Ext.form.field.Text", Ext.apply({ labelAlign: "right", labelWidth: 120, width: 360, margin: "4 8" }, cfg)); fields.push(f); return f; }
    fld({ xclass: "Ext.form.field.Hidden", id: P + "filter_default_Domain", name: "id", value: "1", role: "domain" });
    var fFull = fld({ id: P + "filter_default_FullText", name: "FullText", fieldLabel: "Search" });
    fld({ id: P + "filter_default_Subject", name: "Subject", fieldLabel: "Subject" });
    fld({ xclass: "Ext.form.field.Date", id: P + "filter_default_DateFromFilter", name: "Date", op: "ge", fieldLabel: "From date" });
    fld({ xclass: "Ext.form.field.Date", id: P + "filter_default_DateToFilter", name: "Date", op: "le", fieldLabel: "To date" });
    fld({ xclass: "Ext.form.field.Date", id: P + "filter_default_LastUpdateDateFromFilter", name: "LastChange", op: "ge", fieldLabel: "Last update from" });
    fld({ xclass: "Ext.form.field.Date", id: P + "filter_default_LastUpdateDateToFilter", name: "LastChange", op: "le", fieldLabel: "Last updated to" });
    function combo(id, name, label, list, isMulti, value) {
      return fld({ xclass: "Ext.form.field.ComboBox", id: P + "filter_default_" + id, name: name, fieldLabel: label, multiSelect: isMulti, delimiter: ",",
        queryMode: "local", editable: false, valueField: "value", displayField: "text", value: value,
        store: Ext.create("Ext.data.Store", { fields: ["value", "text"], data: list.map(function (x) { return { value: x[0], text: x[1] }; }) }) });
    }
    combo("StatusFilter", "TicketStatusID", "Status", CFG.statuses, true, defaultStatuses);
    combo("PriorityFilter", "TicketPriorityID", "Priority", CFG.priorities, true, null);
    combo("ServiceFilter", "ServiceID", "Service", CFG.services, false, null);
    fld({ id: P + "filter_default_CatalogItemTxt", name: "CTITM.TranslatedDescription", fieldLabel: "Classification (txt)" });
    fld({ id: P + "filter_default_ClassCliTxt", name: "CLASSCLI.TranslatedDescription", fieldLabel: "Client Classification(txt)" });

    function collect() {
      var out = [];
      Ext.each(fields, function (f) {
        if (f.role === "domain") return;
        var v = f.getValue();
        if (v === null || v === undefined || v === "" || (Ext.isArray(v) && !v.length)) return;
        if (Ext.isDate(v)) v = Ext.Date.format(v, "Y-m-d");
        out.push({ name: f.getName(), op: f.op || "eq", value: v });
      });
      return Ext.encode(out);
    }
    var store = Ext.create("Ext.data.Store", { model: "Fake.Ticket", pageSize: 50, remoteSort: true, autoLoad: key === "INC_ALLGRP_EXTENDED",
      sorters: [{ property: "Date", direction: "DESC" }],
      proxy: { type: "ajax", url: "/HDAPortal/List/GetData?list=" + key, actionMethods: { read: "POST" }, extraParams: { filters: collect() },
        reader: { type: "json", rootProperty: "data", totalProperty: "total" } } });
    function applyFilters() { store.getProxy().setExtraParam("filters", collect()); store.loadPage(1); }
    if (CFG.apply !== "enter") store.on("beforeload", function (st) { st.getProxy().setExtraParam("filters", collect()); });
    var task = new Ext.util.DelayedTask(function () { store.loadPage(1); });
    Ext.each(fields, function (f) {
      if (CFG.apply === "auto") f.on("change", function () { task.delay(700); });
      if (CFG.apply === "enter" && f.isXType("textfield") && !f.isXType("combobox") && !f.isXType("datefield"))
        f.on("specialkey", function (fd, e) { if (e.getKey() === e.ENTER) applyFilters(); });
    });
    var grid = Ext.create("Ext.grid.Panel", { id: P + "grd", store: store, flex: 1, cls: "list-view list-grid listViewGrid",
      selModel: { selType: "checkboxmodel", mode: "MULTI" }, viewConfig: { id: P + "GridView1" },
      columns: [
        { xtype: "templatecolumn", tpl: '<div class="gridCtxMenu"></div>', width: 40, menuDisabled: true, sortable: false },
        { id: P + "c23_0", text: "ID", dataIndex: "TicketCode", width: 120, renderer: function (v) { return '<div class="list-cell list-cell-primary"><div class="ticket-id">' + enc(v) + "</div></div>"; } },
        { id: P + "c20_1", text: "Date", dataIndex: "Date", width: 110, renderer: dt },
        { id: P + "c1_2", text: "Site", dataIndex: "AccountName", width: 200, sortable: false, renderer: function (v, m, r) { return multi(v, r.get("AccountCode")); } },
        { id: P + "c0_3", text: "Site Code", dataIndex: "AccountCode", width: 90, sortable: false },
        { id: P + "c45_12", text: "Subject", dataIndex: "Subject", width: 260, sortable: false, renderer: function (v, m, r) {
            var t = "Subject:\\n" + v + "\\n\\nIssue/Request:\\n" + Ext.String.ellipsis(r.get("Description"), 300) + "\\n\\nResolution:\\n" + (r.get("Resolution") || "-");
            return '<div class="list-cell"><div class="list-cell-multitext" title="' + Ext.String.htmlEncode(t) + '"><div class="text-default">' + enc(v) + '</div><div class="text-caption">' + enc(Ext.String.ellipsis(r.get("Description"), 50)) + "</div></div></div>"; } },
        { id: P + "c17_6", text: "Contact", dataIndex: "ContactName", width: 160, sortable: false },
        { id: P + "c11_5", text: "Status", dataIndex: "TicketStatusText", width: 120, sortable: false },
        { id: P + "c47_11", text: "Service", dataIndex: "ServiceText", width: 200, sortable: false },
        { id: P + "c41_13", text: "Priority", dataIndex: "TicketPriorityText", width: 110, sortable: false },
        { id: P + "c50_14", text: "Classification", dataIndex: "CatalogItemText", width: 200, sortable: false },
        { id: P + "c19_16", text: "Assigned to", dataIndex: "AssignedTo", width: 150, sortable: false },
        { id: P + "c36_20", text: "Owner Group", dataIndex: "OwnerGroup", width: 150, sortable: false },
        { id: P + "c26_21", text: "Last update", dataIndex: "LastChange", width: 110, renderer: dt },
        { id: P + "c29_23", text: "SLA", dataIndex: "Sla", width: 80, sortable: false },
        { id: P + "c38_19", text: "Resource Owner", dataIndex: "AssignedTo", hidden: true, sortable: false },
        { id: P + "c23_29", text: "Tags", dataIndex: "Tags", width: 100, sortable: false }
      ],
      listeners: { itemdblclick: function (v, r) { openTicket(r.get("TicketCode"), r.get("Subject")); } },
      tbar: { id: P + "listToolbar", items: [
        { xtype: "textfield", id: P + "defaultFilter_default_FullText", name: "FullText", emptyText: "Search", width: 220,
          listeners: { specialkey: function (f, e) { if (e.getKey() === e.ENTER) { fFull.setValue(f.getValue()); applyFilters(); } } } },
        { text: "Find by ID...", handler: function () {
            Ext.Msg.prompt("Find by ID", "Ticket ID:", function (btn, text) {
              if (btn !== "ok" || !text) return;
              Ext.Ajax.request({ url: "/HDAPortal/Ticket/Find", params: { code: text.trim() }, success: function (resp) {
                var o = Ext.decode(resp.responseText); if (o.found) openTicket(o.code, o.subject); else Ext.Msg.alert("Find by ID", "Ticket not found"); } });
            });
          } },
        { text: "Open", handler: function () { var s = grid.getSelection()[0]; if (s) openTicket(s.get("TicketCode"), s.get("Subject")); } },
        { text: "Change status...", handler: function () {} }
      ] },
      bbar: { xtype: "pagingtoolbar", id: P + "PagingToolbar", store: store, displayInfo: true,
        items: ["-", { xtype: "combobox", id: P + "ComboPageSize", width: 70, editable: false, queryMode: "local", value: 50,
          store: [10, 20, 25, 50, 100], listeners: { select: function (c) { store.setPageSize(c.getValue()); store.loadPage(1); } } }] }
    });
    return Ext.create("Ext.panel.Panel", { id: P + "ListCt", cls: "module list entity-incident", layout: { type: "vbox", align: "stretch" },
      items: [{ xtype: "panel", id: P + "mainFiltersPanel", items: [{ xtype: "panel", id: P + "filterArea_default", cls: "filter-area", layout: "column", items: fields }] }, grid] });
  }
  var mine = makeModule("id5e1f0c2a9b7d3e48", "MYTKT", CFG.open);
  var all = makeModule("id0a9c7e5b3d1f2468", "INC_ALLGRP_EXTENDED", CFG.open);
  tabs = Ext.create("Ext.tab.Panel", { id: "navbar", items: [
    { title: "Home", id: "body_Home", html: "<h2 style='margin:16px'>Home (finta)</h2>" },
    { title: "My tickets", id: "body_MYTKT", layout: "fit", items: [mine] },
    { title: "All tickets", id: "body_INC_ALLGRP_EXTENDED", layout: "fit", items: [all] }
  ] });
  Ext.create("Ext.container.Viewport", { layout: "fit", items: [tabs] });
  if (CFG.tab === "all") tabs.setActiveTab("body_INC_ALLGRP_EXTENDED");
  window.__ready = true;
});
</script></body></html>"""

# Ridefinizioni viste sulle pagine Zucchetti (dopo ExtJS, che non le usa).
HOSTILE = """<script>
function Set(name){ return window["Set_" + name](); }
window.Map = function(){ throw new Error("Map ridefinita dalla pagina"); };
Array.from = function(item){ return item == null ? [] : (typeof item.length == "number" && typeof item != "string") ? Array.prototype.slice.call(item) : [item]; };
window.Intl = { NumberFormat: function(){ throw new Error("Intl ridefinito"); } };
</script>"""


@app.get("/HDAPortal/")
async def portal(apply: str = "auto", tab: str = "home", ostile: int = 0):
    if apply not in ("auto", "enter", "none"):
        apply = "auto"
    bm = ""
    if ostile:
        href = html.escape(BOOKMARKLET.read_text(encoding="utf-8").strip(), quote=True)
        bm = f'<a id="__bm" href="{href}" style="position:fixed;right:4px;bottom:4px;z-index:99999">Ricerca TKT</a>'
    page = (PAGE.replace("__APPLY__", apply).replace("__TAB__", "all" if tab == "all" else "home")
            .replace("__STATUSES__", json.dumps(STATUSES)).replace("__OPEN__", json.dumps(OPEN_DEFAULT))
            .replace("__PRIORITIES__", json.dumps(PRIORITIES)).replace("__SERVICES__", json.dumps(SERVICES))
            .replace("__TOKEN__", TOKEN).replace("__HOSTILE__", HOSTILE if ostile else "").replace("__BM__", bm))
    r = HTMLResponse(page)
    r.set_cookie("ASP.NET_SessionId", "ok", path="/")
    return r


@app.get("/__vendor/{path:path}")
async def vendor(path: str):
    p = (VENDOR / path).resolve()
    if not str(p).startswith(str(VENDOR.resolve())) or not p.is_file():
        return PlainTextResponse("ExtJS non trovato: vedi il README (bookmarklet/test/vendor)", status_code=404)
    return FileResponse(p)


def _auth(request: Request) -> JSONResponse | None:
    if request.cookies.get("ASP.NET_SessionId") != "ok":
        return JSONResponse({"success": False, "message": "Sessione scaduta"}, status_code=401)
    if request.headers.get("requestverificationtoken") != TOKEN:
        return JSONResponse({"success": False, "message": "Token anti-falsificazione mancante"}, status_code=403)
    return None


@app.post("/HDAPortal/List/GetData")
async def list_data(request: Request, list_name: str = Query("", alias="list")):
    body = (await request.body()).decode("utf-8")
    params = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
    entry = {"list": list_name, "params": params, "token": request.headers.get("requestverificationtoken") == TOKEN}
    try:
        filters = json.loads(params.get("filters") or "[]")
    except ValueError:
        filters = []
    entry["filters"] = filters
    LOG.append(entry)
    denied = _auth(request)
    if denied:
        return denied
    rows = apply_filters(data(), filters)
    if list_name == "MYTKT":
        rows = [r for r in rows if r["AssignedTo"] == demo_engine.OPERATORI[0]]
    try:
        sorters = json.loads(params.get("sort") or "[]")
    except ValueError:
        sorters = []
    for s in reversed(sorters):
        prop = s.get("property")
        if prop in ("Date", "LastChange", "TicketCode"):
            rows = sorted(rows, key=lambda r: r[prop], reverse=s.get("direction") == "DESC")
    start = max(0, int(params.get("start") or 0))
    limit = max(1, min(MAX_LIMIT, int(params.get("limit") or 50)))
    entry["total"] = len(rows)
    return JSONResponse({"success": True, "total": len(rows), "data": [to_json(r) for r in rows[start:start + limit]]})


@app.post("/HDAPortal/Ticket/Find")
async def find(request: Request):
    denied = _auth(request)
    if denied:
        return denied
    body = (await request.body()).decode("utf-8")
    code = (parse_qs(body).get("code") or [""])[0].strip().upper()
    LOG.append({"find": code})
    for r in data():
        if r["TicketCode"] == code:
            return {"found": True, "code": code, "subject": r["Subject"]}
    return {"found": False}


@app.get("/areariservata/jsp/gspv_psearch.jsp")
async def old_site():
    return HTMLResponse("<!doctype html><html><head><title>Ricerca rapida</title><script>window.ZtVWeb={getPortlet:function(){return null;}};</script></head><body>Vecchia Area Riservata (finta)</body></html>")


@app.get("/__data")
async def get_data(limit: int = 5, q: str = ""):
    rows = apply_filters(data(), [{"name": "FullText", "value": q}]) if q else data()
    return JSONResponse({"total": len(rows), "data": [to_json(r) for r in rows[:limit]]})


@app.get("/__log")
async def get_log():
    return JSONResponse(LOG)


@app.post("/__reset")
async def reset():
    LOG.clear()
    return {"ok": True}
