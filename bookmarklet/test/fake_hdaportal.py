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
    ?lazy=1       l'elenco All tickets viene creato solo alla prima apertura della scheda
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
# persone e gruppi inventati (codici come quelli del portale: utenti e gruppi)
USERS = [(f"U{i + 1:03d}", name) for i, name in enumerate(demo_engine.OPERATORI)]
USER_CODES = {name: code for code, name in USERS}
GROUPS = [(f"G{i + 1}", name) for i, name in enumerate(demo_engine.GRUPPI)]
GROUP_CODES = {name: code for code, name in GROUPS}


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
                    "ContactName": d.persona.upper(), "ContactCode": "C" + str(zlib.crc32(d.persona.encode()) % 900000),
                    "TicketStatusID": st, "TicketStatusText": dict(STATUSES)[st],
                    "TicketPriorityID": PRIO_MAP.get(d.priorita, "P3"),
                    "TicketPriorityText": dict(PRIORITIES)[PRIO_MAP.get(d.priorita, "P3")],
                    "ServiceID": SERVICE_IDS.get(service, ""), "ServiceText": service,
                    "CatalogItemText": f"{d.classificazione} / {d.argomento}",
                    "AssignedTo": d.operatore, "AssignedCode": USER_CODES[d.operatore],
                    "OwnerGroup": d.gruppo, "GroupCode": GROUP_CODES[d.gruppo],
                    "ModifiedByText": ", ".join(d.op_part), "_modifiers": sorted(USER_CODES[o] for o in d.op_part),
                    "Tags": "normativa" if rng.random() < 0.1 else "",
                    "_interactions": d.idx,
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
        elif name == "ContactID":
            out = [r for r in out if r["ContactCode"] == v]
        elif name == "Relations.ObjectTag.ID":
            vals = set(v if isinstance(v, list) else str(v).split(","))
            out = [r for r in out if ("T1" in vals and r["Tags"] == "normativa")]
        elif name == "AssignedUserOrGroupID":
            out = [r for r in out if v in (r["AssignedCode"], r["GroupCode"])]
        elif name == "OwnerUserGroupID":
            out = [r for r in out if r["GroupCode"] == v]
        elif name == "OwnerUserID":
            out = [r for r in out if r["AssignedCode"] == v]
        elif name == "ModifiedBy":
            out = [r for r in out if v in r["_modifiers"]]
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
window.Portal = { Const: { LoggedUser: { Name: "Utente di prova" }, TypedLoggedUser: { ID: "U005", Name: __ME__ }, HDAUser: { DefaultUserGroupID: "G3" } }, PageManager: {}, MessageBus: {} };
var CFG = { apply: "__APPLY__", tab: "__TAB__", lazy: __LAZY__, openbind: __OPENBIND__, statuses: __STATUSES__, open: __OPEN__, priorities: __PRIORITIES__, services: __SERVICES__, users: __USERS__, groups: __GROUPS__ };
Ext.onReady(function () {
  Ext.ns("Ext.ux");
  Ext.ux.ActivityMonitor = { lastActive: new Date(), captureActivity: function () { this.lastActive = new Date(); window.__activity++; } };
  var token = document.querySelector("#_AntiForgeryForm input[name=_RVT]").value;
  Ext.Ajax.setDefaultHeaders({ RequestVerificationToken: token });
  Ext.define("Fake.Ticket", { extend: "Ext.data.Model", idProperty: "RecId", fields: [
    { name: "RecId", type: "int" }, "TicketCode", { name: "Date", type: "date", dateFormat: "MS" }, { name: "LastChange", type: "date", dateFormat: "MS" },
    "Subject", "Description", "Resolution", "AccountName", "AccountCode", "ContactName", "TicketStatusID", "TicketStatusText",
    "TicketPriorityID", "TicketPriorityText", "ServiceID", "ServiceText", "CatalogItemText", "AssignedTo", "AssignedCode", "OwnerGroup", "GroupCode", "ModifiedByText", "Tags", "Sla"] });
  var enc = Ext.String.htmlEncode;
  function multi(a, b) { return '<div class="list-cell"><div class="list-cell-multitext"><div class="text-default">' + enc(a || "") + '</div><div class="text-caption">' + enc(b || "") + "</div></div></div>"; }
  function dt(v) { return v ? '<div class="list-cell list-cell-datetime"><div class="list-cell-multitext"><div class="text-datetime-date">' + Ext.Date.format(v, "n/j/Y") + '</div><div class="text-datetime-time">' + Ext.Date.format(v, "g:i a") + "</div></div></div>" : ""; }
  var tabs;
  // come nel portale vero: il ticket si apre in una nuova scheda del browser, con un suo indirizzo
  function openTicket(code, recId) {
    window.__opened.push(code);
    window.open("/HDAPortal/Ticket/View?id=" + encodeURIComponent(recId), "_blank");
  }
  // come il tree-field del portale: campo in sola lettura con un menu ad albero, rami caricati quando si aprono
  Ext.define("Fake.TreeField", {
    extend: "Ext.form.field.Picker", alias: "widget.faketreefield", editable: false, valueField: "id", displayField: "text",
    initComponent: function () { this.callParent(arguments); this.addCls("tree-field userorgroup-treefield-extension"); },
    getStore: function () { return this.store; },
    createPicker: function () {
      var me = this;
      return Ext.create("Ext.tree.Panel", { floating: true, hidden: true, ownerCmp: me, store: me.store, rootVisible: false, width: 380, height: 320, cls: "fake-tree-picker",
        listeners: { itemclick: function (v, rec) { if (rec.get("selectable") === false) return; me.setValue(rec.getId(), rec.get("text")); me.collapse(); } } });
    },
    setValue: function (v, text) {
      var me = this, n = v && me.store ? me.store.getNodeById(v) : null;
      me.value = v === undefined || v === "" ? null : v;
      me.setRawValue(me.value ? (text || (n && n.get("text")) || me.value) : "");
      me.checkChange();
      return me;
    },
    getValue: function () { return this.value === undefined ? null : this.value; },
    getSubmitValue: function () { return this.getValue(); },
    clearValue: function () { this.setValue(null); },
    isEqual: function (a, b) { return a === b; }
  });
  function treeStore(kind) {
    return Ext.create("Ext.data.TreeStore", { root: { id: "root", text: "", expanded: false },
      proxy: { type: "ajax", url: "/HDAPortal/Lookup/Tree?kind=" + kind, reader: { type: "json" } } });
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
    // come sul portale: "Service", "Assigned to" e "Owner Group" con menu ad albero (non digitabili),
    // "Site", "Contact", "Resource Owner" e "Modified by" con ricerca sul server mentre si scrive
    function tree(id, name, label, kind) { return fld({ xclass: "Fake.TreeField", id: P + "filter_default_" + id, name: name, fieldLabel: label, store: treeStore(kind) }); }
    tree("ServiceFilter", "ServiceID", "Service", "service");
    tree("AssignedUserOrGroupFilter", "AssignedUserOrGroupID", "Assigned to", "assigned");
    tree("OwnerUserGroupID", "OwnerUserGroupID", "Owner Group", "group");
    function lookup(id, name, label, url) {
      var f = fld({ xclass: "Ext.form.field.ComboBox", id: P + "filter_default_" + id, name: name, fieldLabel: label, queryMode: "remote", minChars: 2,
        queryParam: "query", valueField: "value", displayField: "text", forceSelection: true, typeAhead: false, hideTrigger: false,
        store: Ext.create("Ext.data.Store", { fields: ["value", "text"], proxy: { type: "ajax", url: url || "/HDAPortal/Lookup/Users", reader: { type: "json", rootProperty: "data" } } }) });
      f.addCls("objectlink-field");
      return f;
    }
    lookup("AccountID", "AccountID", "Site", "/HDAPortal/Lookup/Accounts");
    lookup("ContactFilter", "ContactID", "Contact", "/HDAPortal/Lookup/Contacts");
    lookup("OwnerUserID", "OwnerUserID", "Resource Owner");
    lookup("ModifiedBy", "ModifiedBy", "Modified by");
    combo("TagFilter", "Relations.ObjectTag.ID", "Tags", [["T1", "normativa"], ["T2", "cliente importante"]], true, null);
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
    var store = Ext.create("Ext.data.Store", { model: "Fake.Ticket", pageSize: 50, remoteSort: true, autoLoad: key === "INC_ALLGRP_EXTENDED" || key === "INC_MYGRP",
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
    var vm = CFG.openbind ? Ext.create("Ext.app.ViewModel", { data: { sel: null } }) : null;
    var dbl = function (v, r) { openTicket(r.get("TicketCode"), r.getId()); };
    var grid = Ext.create("Ext.grid.Panel", { id: P + "grd", store: store, flex: 1, cls: "list-view list-grid listViewGrid",
      selModel: { selType: "checkboxmodel", mode: "MULTI" },
      // openbind: come in un portale MVVM, il doppio clic è ascoltato dalla view e Open si abilita con un binding
      viewConfig: CFG.openbind ? { id: P + "GridView1", listeners: { itemdblclick: dbl } } : { id: P + "GridView1" },
      viewModel: vm || undefined,
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
        { id: P + "c33_22", text: "Modified by", dataIndex: "ModifiedByText", hidden: true, sortable: false },
        { id: P + "c23_29", text: "Tags", dataIndex: "Tags", width: 100, sortable: false }
      ],
      listeners: CFG.openbind ? { selectionchange: function (sm, sel) { vm.set("sel", sel.length ? sel[0] : null); } } : { itemdblclick: dbl },
      tbar: { id: P + "listToolbar", items: [
        { xtype: "textfield", id: P + "defaultFilter_default_FullText", name: "FullText", emptyText: "Search", width: 220,
          listeners: { specialkey: function (f, e) { if (e.getKey() === e.ENTER) { fFull.setValue(f.getValue()); applyFilters(); } } } },
        { text: "Find by ID...", handler: function () {
            Ext.Msg.prompt("Find by ID", "Ticket ID:", function (btn, text) {
              if (btn !== "ok" || !text) return;
              Ext.Ajax.request({ url: "/HDAPortal/Ticket/Find", params: { code: text.trim() }, success: function (resp) {
                var o = Ext.decode(resp.responseText); if (o.found) openTicket(o.code, o.id); else Ext.Msg.alert("Find by ID", "Ticket not found"); } });
            });
          } },
        Ext.apply({ text: "Open", handler: function () { var s = grid.getSelection()[0]; if (s) openTicket(s.get("TicketCode"), s.getId()); } },
          CFG.openbind ? { disabled: true, bind: { disabled: "{!sel}" } } : {}),
        { text: "Discard ticket", handler: function () { window.__discarded = (window.__discarded || 0) + 1; } },
        { text: "Change status...", handler: function () {} }
      ] },
      bbar: { xtype: "pagingtoolbar", id: P + "PagingToolbar", store: store, displayInfo: true,
        items: ["-", { xtype: "combobox", id: P + "ComboPageSize", width: 70, editable: false, queryMode: "local", value: 50,
          store: [10, 20, 25, 50, 100], listeners: { select: function (c) { store.setPageSize(c.getValue()); store.loadPage(1); } } }] }
    });
    return Ext.create("Ext.panel.Panel", { id: P + "ListCt", cls: "module list entity-incident", layout: { type: "vbox", align: "stretch" },
      items: [{ xtype: "panel", id: P + "mainFiltersPanel", items: [{ xtype: "panel", id: P + "filterArea_default", cls: "filter-area", layout: "column", items: fields }] }, grid] });
  }
  // come nel portale vero: tra la scheda (body_X) e il modulo ci sono altri contenitori body_ctlNN
  function wrap(module, a, b) {
    return { xtype: "container", id: "body_ctl" + a, layout: "fit", items: [{ xtype: "panel", id: "body_ctl" + b, cls: "action-link module-container", layout: "fit", items: [module] }] };
  }
  var mine = makeModule("id5e1f0c2a9b7d3e48", "MYTKT", CFG.open);
  var grp = makeModule("id7c3b1a9e5d2f4061", "DEFGRP", CFG.open);
  var from = makeModule("id2f6e8d0c4b1a3957", "INC_MYGRP", CFG.open);
  var allBody = { title: "All tickets", id: "body_INC_ALLGRP_EXTENDED", layout: "fit", items: CFG.lazy ? [] : [wrap(makeModule("id0a9c7e5b3d1f2468", "INC_ALLGRP_EXTENDED", CFG.open), 85, 92)] };
  if (CFG.lazy) allBody.listeners = { activate: function (b) { if (!b.items.getCount()) setTimeout(function () { b.add(wrap(makeModule("id0a9c7e5b3d1f2468", "INC_ALLGRP_EXTENDED", CFG.open), 85, 92)); }, CFG.lazy > 1 ? CFG.lazy : 400); } };
  tabs = Ext.create("Ext.tab.Panel", { id: "navbar", items: [
    { title: "Home", id: "body_Home", html: "<h2 style='margin:16px'>Home (finta)</h2>" },
    { title: "My tickets", id: "body_MYTKT", layout: "fit", items: [wrap(mine, 43, 50)] },
    { title: "My Group Tickets", id: "body_DEFGRP", layout: "fit", items: [wrap(grp, 57, 64)] },
    { title: "Tickets from my groups", id: "body_INC_MYGRP", layout: "fit", items: [wrap(from, 71, 78)] },
    allBody
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
async def portal(apply: str = "auto", tab: str = "home", ostile: int = 0, lazy: int = 0, openbind: int = 0):
    if apply not in ("auto", "enter", "none"):
        apply = "auto"
    bm = ""
    if ostile:
        href = html.escape(BOOKMARKLET.read_text(encoding="utf-8").strip(), quote=True)
        bm = f'<a id="__bm" href="{href}" style="position:fixed;right:4px;bottom:4px;z-index:99999">Ricerca TKT</a>'
    page = (PAGE.replace("__APPLY__", apply).replace("__TAB__", "all" if tab == "all" else "home")
            .replace("__STATUSES__", json.dumps(STATUSES)).replace("__OPEN__", json.dumps(OPEN_DEFAULT))
            .replace("__PRIORITIES__", json.dumps(PRIORITIES)).replace("__SERVICES__", json.dumps(SERVICES))
            .replace("__USERS__", json.dumps(USERS)).replace("__GROUPS__", json.dumps(GROUPS)).replace("__LAZY__", str(max(0, min(lazy, 20000)))).replace("__OPENBIND__", "true" if openbind else "false")
            .replace("__ME__", json.dumps(USERS[4][1])).replace("__TOKEN__", TOKEN).replace("__HOSTILE__", HOSTILE if ostile else "").replace("__BM__", bm))
    r = HTMLResponse(page)
    r.set_cookie("ASP.NET_SessionId", "ok", path="/")
    return r


@app.get("/__vendor/{path:path}")
async def vendor(path: str):
    p = (VENDOR / path).resolve()
    if not str(p).startswith(str(VENDOR.resolve())) or not p.is_file():
        return PlainTextResponse("ExtJS non trovato: vedi il README (bookmarklet/test/vendor)", status_code=404)
    return FileResponse(p)


def _run(request: Request) -> str:
    return request.headers.get("x-e2e-run", "")


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
    entry = {"run": _run(request), "list": list_name, "params": params, "token": request.headers.get("requestverificationtoken") == TOKEN}
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
    elif list_name in ("DEFGRP", "INC_MYGRP"):
        # elenchi limitati ai gruppi dell'utente e, come visto sul portale, all'anno in corso
        rows = [r for r in rows if r["GroupCode"] in ("G1", "G2") and r["Date"].year == date.today().year]
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


@app.get("/HDAPortal/Lookup/Users")
async def lookup_users(request: Request, query: str = ""):
    denied = _auth(request)
    if denied:
        return denied
    q = norm(query)
    LOG.append({"run": _run(request), "lookup": query})
    return {"data": [{"value": c, "text": n} for c, n in USERS if q and q in norm(n)][:20]}


# alberi dei campi tree-field: gruppi con le persone (Assigned to), solo gruppi (Owner Group), servizi per tipo
FAMILIES = [("F1", "Informazione"), ("F2", "Anomalia"), ("F3", "Richiesta")]


@app.get("/HDAPortal/Lookup/Tree")
async def lookup_tree(request: Request, kind: str = "assigned", node: str = "root"):
    denied = _auth(request)
    if denied:
        return denied
    LOG.append({"run": _run(request), "tree": kind, "node": node})
    if kind == "group":
        return [{"id": c, "text": n, "leaf": True, "iconCls": "x-fa fa-users"} for c, n in GROUPS] if node == "root" else []
    if kind == "service":
        if node == "root":
            return [{"id": c, "text": n, "leaf": False, "selectable": False} for c, n in FAMILIES]
        fam = dict(FAMILIES).get(node)
        return [{"id": c, "text": t, "leaf": True} for c, t in SERVICES if fam and t.startswith(fam + " /")]
    if node == "root":
        return [{"id": c, "text": n, "leaf": False, "iconCls": "x-fa fa-users"} for c, n in GROUPS]
    gi = next((i for i, (c, _) in enumerate(GROUPS) if c == node), None)
    if gi is None:
        return []
    return [{"id": c, "text": n, "leaf": True, "iconCls": "x-fa fa-user"} for i, (c, n) in enumerate(USERS) if i % len(GROUPS) == gi]


def _lookup(rows: list[tuple[str, str]], query: str) -> dict:
    q = norm(query)
    return {"data": [{"value": c, "text": n} for c, n in rows if q and q in norm(n)][:20]}


@app.get("/HDAPortal/Lookup/Accounts")
async def lookup_accounts(request: Request, query: str = ""):
    denied = _auth(request)
    if denied:
        return denied
    LOG.append({"run": _run(request), "lookup": query, "kind": "accounts"})
    return _lookup(sorted({(r["AccountCode"], r["AccountName"]) for r in data()}, key=lambda x: x[1]), query)


@app.get("/HDAPortal/Lookup/Contacts")
async def lookup_contacts(request: Request, query: str = ""):
    denied = _auth(request)
    if denied:
        return denied
    LOG.append({"run": _run(request), "lookup": query, "kind": "contacts"})
    return _lookup(sorted({(r["ContactCode"], r["ContactName"]) for r in data()}, key=lambda x: x[1]), query)


def interactions(r: dict) -> list[dict]:
    """Messaggi inventati del ticket (deterministici)."""
    rng = random.Random(r["RecId"])
    out = [{"When": ms(r["Date"]), "Author": r["ContactName"].title(), "Kind": "Richiesta", "Text": r["Description"]}]
    t = r["Date"]
    for i in range(rng.randint(1, 4)):
        t = t + timedelta(hours=rng.randint(1, 30))
        who = rng.choice([r["AssignedTo"], *r["ModifiedByText"].split(", ")])
        out.append({"When": ms(min(t, r["LastChange"])), "Author": who, "Kind": "Risposta" if i % 2 == 0 else "Nota interna",
                    "Text": f"Messaggio {i + 1} sul ticket {r['TicketCode']}: verificato il caso di {r['AccountName'].title()}, " + r["Description"].split(". ")[0] + "."})
    if r["Resolution"] != "-":
        out.append({"When": ms(r["LastChange"]), "Author": r["AssignedTo"], "Kind": "Soluzione", "Text": r["Resolution"]})
    return out


TICKET_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Ticket (finto) - HDA TOUCH</title>
<link rel="stylesheet" href="/__vendor/classic/theme-triton/resources/theme-triton-all.css">
<script src="/__vendor/ext-all.js"></script></head><body>
<form id="_AntiForgeryForm"><input type="hidden" name="_RVT" value="__TOKEN__"></form>
<script>
Ext.onReady(function () {
  Ext.Ajax.setDefaultHeaders({ RequestVerificationToken: document.querySelector("#_AntiForgeryForm input[name=_RVT]").value });
  var id = new URLSearchParams(location.search).get("id");
  var vp = Ext.create("Ext.container.Viewport", { layout: "fit", items: [{ xtype: "panel", title: "Caricamento…", id: "tktpanel" }] });
  var mask = new Ext.LoadMask({ msg: "Loading...", target: vp }); mask.show();
  // come un portale vero: i dati arrivano dopo, con una richiesta a parte
  setTimeout(function () {
    Ext.Ajax.request({ url: "/HDAPortal/Ticket/Get", method: "GET", params: { id: id }, success: function (resp) {
      var o = Ext.decode(resp.responseText); mask.hide();
      if (!o.success) { vp.removeAll(); vp.add({ xtype: "panel", html: "Ticket non trovato" }); return; }
      var d = o.data, f = function (v) { return v ? Ext.Date.format(new Date(parseInt(String(v).replace(/\\D/g, ""), 10)), "n/j/Y g:i a") : ""; };
      vp.removeAll();
      vp.add({ xtype: "tabpanel", id: "tkttabs", items: [
        { title: "Ticket " + d.TicketCode, xtype: "form", scrollable: true, bodyPadding: 12, defaults: { xtype: "displayfield", labelWidth: 130, width: 700 }, items: [
          { fieldLabel: "Ticket", value: d.TicketCode }, { fieldLabel: "Status", value: d.TicketStatusText }, { fieldLabel: "Priority", value: d.TicketPriorityText },
          { fieldLabel: "Opened", value: f(d.Date) }, { fieldLabel: "Last update", value: f(d.LastChange) }, { fieldLabel: "Site", value: d.AccountName },
          { fieldLabel: "Contact", value: d.ContactName }, { fieldLabel: "Service", value: d.ServiceText }, { fieldLabel: "Classification", value: d.CatalogItemText },
          { fieldLabel: "Assigned to", value: d.AssignedTo }, { fieldLabel: "Owner group", value: d.OwnerGroup }, { fieldLabel: "Modified by", value: d.ModifiedByText },
          { xtype: "textfield", fieldLabel: "Subject", value: d.Subject, readOnly: true },
          { xtype: "textareafield", fieldLabel: "Issue/Request", value: d.Description, readOnly: true, height: 160 },
          { xtype: "textareafield", fieldLabel: "Resolution", value: d.Resolution, readOnly: true, height: 80 }] },
        { title: "Interactions", xtype: "grid", store: { fields: ["When", "Author", "Kind", "Text"], data: d.Interactions },
          columns: [{ text: "Date", dataIndex: "When", width: 140, renderer: f }, { text: "Author", dataIndex: "Author", width: 160 }, { text: "Type", dataIndex: "Kind", width: 110 }, { text: "Message", dataIndex: "Text", flex: 1, cellWrap: true }] }
      ] });
      document.title = "Ticket " + d.TicketCode + " - HDA TOUCH";
      window.__ticketReady = true;
    } });
  }, 500);
});
</script></body></html>"""


@app.get("/HDAPortal/Ticket/View")
async def ticket_view(request: Request, id: str = ""):
    LOG.append({"run": _run(request), "view": id})
    return HTMLResponse(TICKET_PAGE.replace("__TOKEN__", TOKEN))


@app.get("/HDAPortal/Ticket/Get")
async def ticket_get(request: Request, id: str = ""):
    denied = _auth(request)
    if denied:
        return denied
    LOG.append({"run": _run(request), "get": id})
    for r in data():
        if str(r["RecId"]) == id:
            return {"success": True, "data": {**to_json(r), "Interactions": interactions(r)}}
    return {"success": False}


@app.post("/HDAPortal/Ticket/Find")
async def find(request: Request):
    denied = _auth(request)
    if denied:
        return denied
    body = (await request.body()).decode("utf-8")
    code = (parse_qs(body).get("code") or [""])[0].strip().upper()
    LOG.append({"run": _run(request), "find": code})
    for r in data():
        if r["TicketCode"] == code:
            return {"found": True, "code": code, "id": r["RecId"], "subject": r["Subject"]}
    return {"found": False}


@app.get("/areariservata/jsp/gspv_psearch.jsp")
async def old_site():
    return HTMLResponse("<!doctype html><html><head><title>Ricerca rapida</title><script>window.ZtVWeb={getPortlet:function(){return null;}};</script></head><body>Vecchia Area Riservata (finta)</body></html>")


@app.get("/__data")
async def get_data(limit: int = 5, q: str = ""):
    rows = apply_filters(data(), [{"name": "FullText", "value": q}]) if q else data()
    return JSONResponse({"total": len(rows), "data": [to_json(r) for r in rows[:limit]]})


@app.get("/__log")
async def get_log(run: str = ""):
    return JSONResponse([e for e in LOG if e.get("run") == run] if run else LOG)


@app.post("/__reset")
async def reset(run: str = ""):
    LOG[:] = [e for e in LOG if e.get("run") != run] if run else []
    return {"ok": True}
