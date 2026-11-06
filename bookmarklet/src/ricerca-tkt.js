/*
 * Ricerca TKT — versione "segnalibro" (bookmarklet) per il portale ticket Zucchetti (HDAPortal).
 *
 * Si avvia dentro il portale, già aperto e con l'utente collegato. Il portale è un'applicazione
 * ExtJS: le ricerche usano l'elenco "All tickets" della pagina stessa (i suoi filtri e il suo
 * archivio dati), quindi passano per la sessione, i controlli e i permessi del portale, senza
 * password, server o installazioni. Una richiesta per ricerca, con un numero massimo di risultati.
 * Preferiti, note, ricerche salvate e cronologia restano nel browser (localStorage del portale).
 * Cliccato nella vecchia Ricerca rapida dell'Area Riservata fa da ponte (ar-bridge.js): le ricerche del
 * portale cercano anche lì, con la sessione dell'Area Riservata, e i risultati arrivano con postMessage.
 */
(() => {
  "use strict";
  const NS = "__RicercaTKT__";
  const VERSION = "3.0.0";
  if (window[NS]) { window[NS].toggle(); return; }
  try {

  // ===================================================================== funzioni native
  // Alcune pagine Zucchetti ridefiniscono funzioni globali del browser (ad esempio Set):
  // usiamo quelle originali, prese da un riquadro nascosto e pulito.
  const PRISTINE = (() => {
    let fw = null;
    const frameWin = () => {
      if (!fw) {
        const f = document.createElement("iframe");
        f.id = "ricerca-tkt-realm";
        f.setAttribute("aria-hidden", "true");
        f.tabIndex = -1;
        f.style.cssText = "display:none!important";
        document.documentElement.appendChild(f);
        fw = f.contentWindow;
      }
      return fw;
    };
    const isNative = (v) => {
      try { return typeof v === "function" && /\{\s*\[native code\]\s*\}\s*$/.test(frameWin().Function.prototype.toString.call(v)); } catch { return false; }
    };
    const pick = (name) => (isNative(window[name]) ? window[name] : frameWin()[name]);
    return {
      Set: pick("Set"), Map: pick("Map"), URL: pick("URL"), DOMParser: pick("DOMParser"), Blob: pick("Blob"),
      AbortController: pick("AbortController"), Promise: pick("Promise"), Intl: frameWin().Intl,
      JSON: window.JSON && isNative(window.JSON.parse) && isNative(window.JSON.stringify) ? window.JSON : frameWin().JSON,
    };
  })();
  // eslint-disable-next-line no-shadow
  const { Set, Map, URL, DOMParser, Blob, AbortController, Promise, Intl, JSON } = PRISTINE;

// @include ar-bridge.js

  // ===================================================================== ambiente: il portale ExtJS
  // Nella vecchia Area Riservata il segnalibro fa da ponte per Ricerca TKT nel portale Touch.
  if (/\/areariservata\//i.test(location.pathname) || (window.ZtVWeb && !window.Ext)) { arBridgeMain(); return; }
  const Ext = window.Ext;
  if (!Ext || !Ext.ComponentQuery || typeof Ext.getCmp !== "function") {
    alert("Ricerca TKT: apri il portale ticket Zucchetti (HDA TOUCH, dopo l'accesso), vai nella scheda \u00abAll tickets\u00bb e clicca di nuovo il segnalibro.");
    return;
  }
  const LIST_NAMES = { INC_ALLGRP_EXTENDED: "All tickets", MYTKT: "My tickets", DEFGRP: "My Group Tickets" };
  const SUFFIX = "_UC_ListCt";
  const allComponents = () => {
    try {
      const cm = Ext.ComponentManager;
      if (cm && typeof cm.getAll === "function") return cm.getAll();
      if (cm && cm.all) return typeof cm.all.getArray === "function" ? cm.all.getArray() : Object.values(cm.all.map || cm.all);
    } catch { /* */ }
    return [];
  };
  const isGrid = (c) => !!(c && typeof c.getStore === "function" && typeof c.getView === "function" && (c.isXType ? c.isXType("tablepanel") || c.isXType("gridpanel") : true));
  // Pannello della scheda che contiene il modulo: il figlio diretto del tabpanel (body_INC_ALLGRP_EXTENDED).
  // Nel portale vero tra la scheda e l'elenco ci sono altri contenitori body_ctlNN: non vanno presi.
  const isTabPanel = (p) => !!(p && typeof p.isXType === "function" && p.isXType("tabpanel"));
  function ownerBody(c) {
    let first = null;
    for (let p = c, i = 0; p && i < 40; p = p.ownerCt || (typeof p.up === "function" ? p.up() : null), i++) {
      if (!/^body_/.test(p.id || "")) continue;
      if (isTabPanel(p.ownerCt)) return p;
      if (!first && !/^body_ctl\d/.test(p.id)) first = p;
    }
    return first;
  }
  // Schede del portale (My tickets, My Group Tickets, Tickets from my groups, All tickets...): il titolo
  // di un elenco è il testo della scheda che lo contiene.
  const ALL_TAB_RE = /^(all tickets?|tutti i ticket|tutti i tickets)$/i;
  const ALL_KEY = "INC_ALLGRP_EXTENDED";
  function portalTabs() {
    try {
      return Ext.ComponentQuery.query("tab").map((t) => ({ t, text: textOf(String((typeof t.getText === "function" ? t.getText() : t.text) || "")), card: t.card || null }))
        .filter((x) => x.text);
    } catch { return []; }
  }
  function isInside(card, cmp, el) {
    if (!card) return false;
    try { if (el && card.el && card.el.dom && card.el.dom.contains(el)) return true; } catch { /* */ }
    for (let p = cmp, i = 0; p && i < 60; p = p.ownerCt || p.floatParent || null, i++) if (p === card) return true;
    return false;
  }
  const bodyKey = (id) => { const x = /^body_([^-]+)/.exec(id || ""); return x ? x[1] : ""; };
  function findModules() {
    const tabs = portalTabs();
    const ids = new Set();
    for (const el of document.querySelectorAll('[id$="' + SUFFIX + '"]')) if (/\bentity-incident\b/.test(el.className || "")) ids.add(el.id);
    for (const c of allComponents()) {
      const cls = `${c.cls || ""} ${c.userCls || ""} ${c.baseCls || ""}`;
      if (typeof c.id === "string" && c.id.endsWith(SUFFIX) && /\bentity-incident\b/.test(cls)) ids.add(c.id);
    }
    const out = [];
    for (const id of ids) {
      const cmp = Ext.getCmp(id);
      const prefix = id.slice(0, -SUFFIX.length);
      const P = prefix + "_UC_";
      let grid = Ext.getCmp(P + "grd");
      if (!isGrid(grid)) { const v = Ext.getCmp(P + "GridView1"); grid = v && (v.grid || v.ownerGrid || v.ownerCt) || null; }
      if (!isGrid(grid) && cmp && typeof cmp.query === "function") grid = cmp.query("gridpanel").find(isGrid) || null;
      let store = null;
      try { store = isGrid(grid) ? grid.getStore() : null; } catch { store = null; }
      const el = document.getElementById(id);
      const domBody = el ? el.closest('.x-tabpanel-child[id^="body_"]') : null;
      const cmpBody = cmp ? ownerBody(cmp) : null;
      const key = bodyKey(domBody && domBody.id) || bodyKey(cmpBody && cmpBody.id) || prefix;
      const tab = tabs.find((x) => isInside(x.card, cmp, el)) || null;
      const title = (tab && tab.text) || LIST_NAMES[key] || key;
      out.push({
        prefix, P, key, title: textOf(String(title)), cmp, grid: isGrid(grid) ? grid : null, store,
        field: (name) => Ext.getCmp(P + "filter_default_" + name) || null,
        quick: Ext.getCmp(P + "defaultFilter_default_FullText") || null,
        rendered: !!(grid && grid.rendered), tabText: tab ? tab.text : "", bodyId: (domBody && domBody.id) || (cmpBody && cmpBody.id) || "",
      });
    }
    return out;
  }
  // Ricerca globale: solo l'elenco All tickets (riconosciuto dal pannello body_INC_ALLGRP_EXTENDED o dalla scheda).
  const isAllList = (m) => !!m && (m.key === ALL_KEY || ALL_TAB_RE.test(m.tabText || ""));
  const allTab = () => portalTabs().find((x) => ALL_TAB_RE.test(x.text) || (x.card && x.card.id === "body_" + ALL_KEY)) || null;

  // ===================================================================== archivio locale
  const store = {
    get(key, def) {
      try { const v = localStorage.getItem("rtkt2:" + key); return v === null ? def : JSON.parse(v); } catch { return def; }
    },
    set(key, value) {
      try { localStorage.setItem("rtkt2:" + key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };
  const AR_DEFAULT = "https://www.zucchetti.it/areariservata/jsp/sipv_psearch_infi.jsp";
  const DEFAULT_SETTINGS = { v: 1, cap: 200, list: "", arUrl: AR_DEFAULT, arOn: true };
  const settings = Object.assign({}, DEFAULT_SETTINGS, store.get("settings", {}) || {});
  const CAPS = [50, 100, 200, 500];
  if (!CAPS.includes(+settings.cap)) settings.cap = 200;

  // ===================================================================== utilità
  const NF = new Intl.NumberFormat("it-IT");
  const fmtN = (n) => NF.format(n || 0);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const MESI_L = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const fmtDate = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
  const fmtDT = (iso) => { try { return new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }); } catch { return iso; } };
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m = 1..12
  const norm = (s) => (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function textOf(html) {
    if (!/[<&]/.test(html)) return html.replace(/\s+/g, " ").trim();
    const d = new DOMParser().parseFromString(`<body>${html}`, "text/html");
    return (d.body.textContent || "").replace(/\s+/g, " ").trim();
  }
  async function waitUntil(cond, ms, signal) {
    const end = performance.now() + ms;
    for (;;) {
      if (signal && signal.aborted) { const e = new Error("Ricerca interrotta."); e.name = "AbortError"; throw e; }
      let ok = false;
      try { ok = !!cond(); } catch { ok = false; }
      if (ok) return true;
      if (performance.now() >= end) return false;
      await sleep(50);
    }
  }
  // attività dell'utente per il controllo di inattività del portale (Ext.ux.ActivityMonitor)
  let lastPing = 0;
  function activity(force) {
    const now = Date.now();
    if (!force && now - lastPing < 20000) return;
    lastPing = now;
    try {
      const am = Ext.ux && Ext.ux.ActivityMonitor;
      if (am && typeof am.captureActivity === "function") am.captureActivity();
      else if (am) am.lastActive = new Date();
    } catch { /* */ }
  }

  // ===================================================================== richieste osservate
  // Solo per verificare che i filtri arrivino al portale e per i dati tecnici: niente cookie e
  // valori mascherati (vedi maskDeep).
  // on: si registra solo mentre il pannello è aperto (non il lavoro normale nel portale)
  const conn = { ext: [], xhr: [], seq: 0, errors: [], lastRun: null, on: true };
  const keep = (list, r) => { r.seq = ++conn.seq; list.push(r); if (list.length > 25) list.shift(); return r; };
  function bodyText(b) {
    if (b === null || b === undefined) return "";
    if (typeof b === "string") return b;
    try { if (typeof b.toString === "function" && b.constructor && /URLSearchParams/.test(b.constructor.name)) return b.toString(); } catch { /* */ }
    try { return JSON.stringify(b); } catch { return String(b); }
  }
  function summarize(text) {
    const shape = (v, d) => {
      if (v === null || v === undefined) return v;
      if (Array.isArray(v)) return { array: v.length, first: v.length && d < 4 ? shape(v[0], d + 1) : undefined };
      if (typeof v === "object") { if (d > 3) return "object"; const o = {}; for (const k of Object.keys(v).slice(0, 80)) o[k] = shape(v[k], d + 1); return o; }
      if (typeof v === "number" || typeof v === "boolean") return d <= 1 ? v : typeof v;
      return typeof v === "string" && /^\/Date\(\d+/.test(v) ? "data /Date()/" : typeof v;
    };
    try { return { bytes: text.length, json: shape(JSON.parse(text), 0) }; } catch { return { bytes: (text || "").length, json: null }; }
  }
  try {
    const pend = new Map();
    Ext.Ajax.on("beforerequest", (c, o) => {
      try {
        if (!conn.on) return;
        const r = keep(conn.ext, { at: new Date().toISOString(), url: String(o.url || ""), method: o.method || (o.params || o.jsonData ? "POST" : "GET"), params: o.params || null, json: o.jsonData || null, headers: Object.keys(Object.assign({}, (c && c.getDefaultHeaders && c.getDefaultHeaders()) || {}, o.headers || {})) });
        pend.set(o, r);
      } catch { /* */ }
    });
    const done = (o, resp, failed) => {
      const r = pend.get(o);
      if (!r) return;
      pend.delete(o);
      r.status = resp ? resp.status : null;
      r.failed = !!failed;
      try { r.response = summarize(resp && typeof resp.responseText === "string" ? resp.responseText : ""); } catch { /* */ }
    };
    Ext.Ajax.on("requestcomplete", (c, resp, o) => done(o, resp, false));
    Ext.Ajax.on("requestexception", (c, resp, o) => done(o, resp, true));
  } catch { /* Ext.Ajax non disponibile */ }
  try {
    const XP = XMLHttpRequest.prototype;
    if (!XP.__rtktHook) {
      XP.__rtktHook = true;
      const open = XP.open, send = XP.send, setH = XP.setRequestHeader;
      XP.open = function (m, u) { try { this.__rtkt = { method: m, url: String(u), headers: [] }; } catch { /* */ } return open.apply(this, arguments); };
      XP.setRequestHeader = function (n) { try { if (this.__rtkt) this.__rtkt.headers.push(String(n)); } catch { /* */ } return setH.apply(this, arguments); };
      XP.send = function (b) {
        try {
          const r = this.__rtkt;
          if (r && conn.on && !/\.(js|css|png|gif|jpe?g|svg|woff2?)(\?|$)/i.test(r.url) && !/signalr/i.test(r.url)) {
            r.at = new Date().toISOString(); r.body = bodyText(b).slice(0, 20000);
            keep(conn.xhr, r);
            this.addEventListener("loadend", () => { try { r.status = this.status; r.response = summarize(typeof this.responseText === "string" ? this.responseText : ""); } catch { /* */ } });
          }
        } catch { /* */ }
        return send.apply(this, arguments);
      };
    }
  } catch { /* */ }
  const reqBlob = (r) => norm(decodeURIComponentSafe(`${r.url} ${bodyText(r.params)} ${bodyText(r.json)} ${r.body || ""}`));
  function decodeURIComponentSafe(s) { try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch { return String(s); } }

  // Valori mascherati nei dati tecnici: restano la struttura, i nomi dei campi, codici, date e i
  // valori cercati con Ricerca TKT; il resto (nomi, testi) diventa «N car.».
  const KEEP_WORDS = new Set(["eq", "ne", "like", "in", "notin", "ge", "gt", "le", "lt", "and", "or", "not", "asc", "desc", "true", "false", "null", "property", "value", "operator", "field", "name", "type", "direction"]);
  // valori sempre mascherati in base al nome del campo (credenziali, contatti, nomi)
  const SECRET_KEY = /pass|pwd|secret|token|rvt|auth|cookie|session|login|^user(name)?$|mail|phone|tel(efono)?$|mobile|cell|fax|vat|piva|fiscal|iban|name$|nome$/i;
  function maskDeep(v, keepSet, depth = 0, key = "") {
    if (depth > 7) return "…";
    if (key && SECRET_KEY.test(key) && v !== null && v !== undefined && v !== "" && typeof v !== "object") return `\u00ab${String(v).length} car.\u00bb`;
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if (typeof v === "number") return Math.abs(v) >= 1e9 ? `\u00ab${String(v).length} cifre\u00bb` : v;
    if (typeof v === "string") {
      const s = v;
      if (keepSet.has(norm(s).trim())) return s;
      if (/^\s*[[{]/.test(s)) { try { return { json: maskDeep(JSON.parse(s), keepSet, depth + 1) }; } catch { /* non JSON */ } }
      if (!s.trim() || KEEP_WORDS.has(s.toLowerCase())) return s;
      // codici: al massimo 8 cifre (ID dei ticket come 11936627Z sì, telefoni e partite IVA no)
      if ((/^(?=.*[0-9_])[A-Z0-9_\-.,/]{1,14}$/.test(s.trim()) && (s.match(/\d/g) || []).length <= 8) || /^[A-Z]{1,4}$/.test(s.trim())) return s;
      if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s) || /^\/Date\(-?\d+\)\/$/.test(s)) return s;
      if (s.length <= 60 && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) && (/[a-z][A-Z]/.test(s) || /[._]/.test(s) || /^[A-Z]{2,}[a-z]/.test(s))) return s;
      return `\u00ab${s.length} car.\u00bb`;
    }
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => maskDeep(x, keepSet, depth + 1, key));
    if (typeof v === "object") { const o = {}; for (const k of Object.keys(v).slice(0, 80)) o[k] = maskDeep(v[k], keepSet, depth + 1, k); return o; }
    return typeof v;
  }
  function maskUrl(u, keepSet) {
    try {
      const x = new URL(u, location.href);
      const q = [];
      for (const [k, v] of x.searchParams) q.push(`${k}=${JSON.stringify(maskDeep(v, keepSet, 0, k))}`);
      return x.pathname + (q.length ? " ? " + q.join(" & ") : "");
    } catch { return "(url)"; }
  }
  function maskBody(b, keepSet) {
    const s = String(b || "");
    if (!s) return "";
    if (/^\s*[[{]/.test(s)) return maskDeep(s, keepSet);
    if (/=/.test(s) && !/\s/.test(s.slice(0, 200))) {
      const o = {};
      for (const part of s.split("&")) { const i = part.indexOf("="); const k = decodeURIComponentSafe(i < 0 ? part : part.slice(0, i)); o[k] = maskDeep(decodeURIComponentSafe(i < 0 ? "" : part.slice(i + 1)), keepSet, 0, k); }
      return o;
    }
    return maskDeep(s, keepSet);
  }

  // ===================================================================== campi dei filtri del portale
  const CLOSED_RE = /(clos|solv|resolv|discard|cancel|direct closure|chius|risolt|scartat|annullat|evas)/i;
  const asList = (v) => {
    if (v === null || v === undefined || v === "") return [];
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String(typeof x.get === "function" ? x.get("value") : x.value ?? x.id ?? "") : String(x))).filter(Boolean);
    return String(v).split(/\s*,\s*/).filter(Boolean);
  };
  function comboOptions(f) {
    try {
      const st = f && typeof f.getStore === "function" ? f.getStore() : null;
      if (!st || typeof st.getRange !== "function") return [];
      const vf = f.valueField || "value", df = f.displayField || "text";
      const out = [];
      // tutte le voci, non solo quelle filtrate dopo una ricerca nel campo
      let recs = st.getRange();
      try { const d = st.getData && st.getData(); const src = d && typeof d.getSource === "function" ? d.getSource() : null; if (src && typeof src.getRange === "function") recs = src.getRange(); } catch { /* */ }
      for (const r of recs) {
        const v = r.get(vf);
        if (v === null || v === undefined || v === "") continue;
        out.push([String(v), textOf(String(r.get(df) ?? v))]);
      }
      return out;
    } catch { return []; }
  }
  const sameList = (a, b) => a.slice().sort().join("\u0001") === b.slice().sort().join("\u0001");
  function setMulti(f, codes) {
    if (sameList(asList(f.getValue()), codes)) return true;
    const attempts = codes.length
      ? [() => f.setValue(codes.slice()), () => f.setValue(codes.join(",")), () => {
        const st = f.getStore();
        f.setValue(codes.map((c) => st.findRecord(f.valueField || "value", c, 0, false, true, true)).filter(Boolean));
      }]
      : [() => (typeof f.clearValue === "function" ? f.clearValue() : f.setValue(null)), () => f.setValue([]), () => f.setValue("")];
    for (const a of attempts) { try { a(); if (sameList(asList(f.getValue()), codes)) return true; } catch { /* prova il successivo */ } }
    return false;
  }
  function setText(f, v) {
    const cur = f.getValue();
    if (String(cur === null || cur === undefined ? "" : cur) === v) return true;
    f.setValue(v);
    return String(f.getValue() ?? "") === v;
  }
  const toDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  function setDate(f, iso) {
    const d = toDate(iso);
    const cur = f.getValue();
    if ((!d && !cur) || (d && isDate(cur) && isoOf(cur) === iso)) return true;
    f.setValue(d);
    const now = f.getValue();
    return d ? isDate(now) && isoOf(now) === iso : !now;
  }
  const fieldLabel = (f, fb) => { try { return textOf(String((typeof f.getFieldLabel === "function" ? f.getFieldLabel() : f.fieldLabel) || f.emptyText || fb)); } catch { return fb; } };
  function fieldDisplay(f) {
    try {
      const raw = typeof f.getRawValue === "function" ? f.getRawValue() : "";
      if (raw && String(raw).trim()) return String(raw).trim();
      const v = f.getValue();
      if (isDate(v)) return fmtDate(isoOf(v));
      if (Array.isArray(v)) return v.length ? v.join(", ") : "";
      if (v && typeof v === "object") return "";
      return v === null || v === undefined ? "" : String(v).trim();
    } catch { return ""; }
  }
  // campi gestiti da Ricerca TKT (suffisso dell'id → chiave)
  const CONTROLLED = {
    FullText: "text", Subject: "subject", DateFromFilter: "dfrom", DateToFilter: "dto",
    LastUpdateDateFromFilter: "ufrom", LastUpdateDateToFilter: "uto", StatusFilter: "st", PriorityFilter: "pr",
    CatalogItemTxt: "classif", ClassCliTxt: "classcli", Domain: "",
  };
  function filterFields(m) {
    const pre = m.P + "filter_default_";
    const out = [];
    for (const c of allComponents()) {
      if (typeof c.id !== "string" || !c.id.startsWith(pre)) continue;
      const suffix = c.id.slice(pre.length);
      if (!/^\w+$/.test(suffix) || typeof c.getValue !== "function") continue;
      out.push({ suffix, f: c });
    }
    return out;
  }
  // Gruppi e persone: campi del portale con menu ad albero o ricerca (valori = codici del portale)
  const PEOPLE = [
    ["AssignedUserOrGroupFilter", "Assegnato a (persona o gruppo)"],
    ["OwnerUserGroupID", "Gruppo proprietario"],
    ["ModifiedBy", "Modificato da (chi ci ha lavorato)"],
    ["OwnerUserID", "Responsabile (Resource Owner)"],
  ];
  const PEOPLE_KEYS = new Set(PEOPLE.map(([k]) => k));
  function scalarValue(f, v) {
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object") {
      try { if (typeof v.get === "function") return String(v.get(f.valueField || "value") ?? ""); } catch { /* */ }
      return String(v.value ?? v.id ?? v.Value ?? v.ID ?? "");
    }
    return v === null || v === undefined ? "" : String(v);
  }
  // nomi già visti per i codici (ricerche salvate, scelte nel pannello): un campo ad albero appena caricato
  // mostra il codice finché il suo ramo non viene aperto
  const NAMES = new Map();
  const rememberName = (v, t) => { if (v && t && String(t) !== String(v) && NAMES.size < 2000) NAMES.set(String(v), String(t).slice(0, 200)); };
  function personValue(f) {
    try {
      const v = scalarValue(f, f.getValue());
      if (!v || /^\[\{"value":""/.test(v)) return null;
      const t = fieldDisplay(f) || v;
      if (t !== v) rememberName(v, t);
      return { v, t: t === v && NAMES.has(v) ? NAMES.get(v) : t };
    } catch { return null; }
  }
  const canLookup = (f) => !!(f && typeof f.doQuery === "function" && typeof f.getStore === "function" && !f.readOnly && f.editable !== false);
  // Imposta un gruppo o una persona ({v: codice, t: nome}) in un campo del portale.
  function setPerson(f, d) {
    const code = String(d.v);
    rememberName(code, String(d.t || "").replace(/[<>"`]/g, "").trim());
    const same = () => scalarValue(f, f.getValue()) === code;
    const vf = f.valueField || "value", df = f.displayField || "text";
    // il nome può arrivare da un file importato e finire nel menu del portale (BoundList: {text} senza codifica HTML)
    const label = String(d.t || "").replace(/[<>"`]/g, "").slice(0, 200).trim() || code;
    let st = null;
    try { st = typeof f.getStore === "function" ? f.getStore() : null; } catch { /* */ }
    const plain = !!(st && !st.isTreeStore);
    const raw = () => { try { return typeof f.getRawValue === "function" ? String(f.getRawValue() || "").trim() : "x"; } catch { return "x"; } };
    // record con codice e nome, senza aggiungerlo all'elenco del campo: Ext lo accetta anche con l'elenco non caricato
    const asRecord = () => {
      try { if (!plain || typeof st.getModel !== "function") return false; const M = st.getModel(); f.setValue(new M({ [vf]: code, [df]: label })); return same(); } catch { return false; }
    };
    // campi ad albero (tree-field): il valore è il codice del nodo, non il nodo
    if (st && st.isTreeStore) {
      // un TreePicker non segnala il cambio da solo: checkChange avvisa il portale (che ricarica l'elenco)
      const changed = () => { try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ } };
      try { f.setValue(code); changed(); if (same()) return true; } catch { /* */ }
      try { const n = st.getNodeById(code); if (n) { f.setValue(n); changed(); if (same() && typeof f.getValue() !== "object") return true; } } catch { /* */ }
      try { f.setValue(code); changed(); } catch { /* */ }
      return same();
    }
    // con l'elenco del campo non caricato setValue(codice) non segnala il cambio: checkChange lo fa (solo se è cambiato)
    const signal = () => { try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ } };
    try { const r = st && typeof st.findRecord === "function" ? st.findRecord(vf, code, 0, false, true, true) : null; if (r) { f.setValue(r); if (same()) { signal(); return true; } } } catch { /* */ }
    try {
      f.setValue(code);
      if (same()) {
        // elenco del campo mai caricato (pagina nuova): Ext tiene il codice ma il campo resta vuoto; con il nome noto si mostra quello
        if (!raw() && label !== code && !asRecord()) { try { f.setValue(code); } catch { /* */ } }
        signal();
        return same();
      }
    } catch { /* */ }
    if (asRecord()) return true;
    try {
      if (plain && typeof st.add === "function") {
        const [r] = st.add({ [vf]: code, [df]: label });
        f.setValue(r);
        if (same()) return true;
        try { st.remove(r); } catch { /* */ }
      }
    } catch { /* */ }
    return false;
  }
  function clearField(f) {
    try { if (typeof f.clearValue === "function") f.clearValue(); else f.setValue(null); } catch { try { f.setValue(""); } catch { /* */ } }
  }
  // ===================================================================== tutti i filtri del portale nel pannello
  // Tipo di ogni campo filtro: albero (tree-field), ricerca sul server (objectlink), elenco (combo con le
  // scelte già nella pagina), data o testo. I valori sono i codici del portale, con il nome per mostrarli.
  const clsOf = (f) => { try { return `${f.cls || ""} ${f.userCls || ""} ${f.el && f.el.dom ? f.el.dom.className : ""}`; } catch { return ""; } };
  function treeStoreOf(f) {
    const gets = [() => f.getStore && f.getStore(), () => f.store, () => f.treeStore, () => f.picker && f.picker.getStore && f.picker.getStore(), () => f.tree && f.tree.getStore && f.tree.getStore()];
    for (const get of gets) { try { const st = get(); if (st && st.isTreeStore && typeof st.getRootNode === "function") return st; } catch { /* */ } }
    return null;
  }
  function fieldKind(f) {
    try {
      if (f.isXType && f.isXType("hiddenfield")) return "hidden";
      if (f.isXType && f.isXType("datefield")) return "date";
      if (treeStoreOf(f)) return "tree";
      if (/\btree-?field\b/i.test(clsOf(f))) return "treemenu"; // albero senza archivio leggibile: solo dal menu del portale
      if (canLookup(f) && f.queryMode !== "local") return "remote";
      if (typeof f.getStore === "function" && comboOptions(f).length) return "list";
      if (f.isXType && f.isXType("combobox")) return canLookup(f) ? "remote" : "list";
      return "text";
    } catch { return "text"; }
  }
  // campi filtro gestiti dal pannello (oltre a quelli della barra di ricerca): gruppi e persone prima
  function pfFields(m) {
    const all = filterFields(m).filter(({ suffix }) => !(suffix in CONTROLLED)).map((x) => Object.assign(x, { kind: fieldKind(x.f) })).filter((x) => x.kind !== "hidden");
    const rank = (x) => { const i = PEOPLE.findIndex(([k]) => k === x.suffix); return i < 0 ? 100 : i; };
    return all.map((x, i) => Object.assign(x, { i, label: PEOPLE_KEYS.has(x.suffix) ? PEOPLE.find(([k]) => k === x.suffix)[1] : fieldLabel(x.f, x.suffix) }))
      .sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  }
  const isMulti = (f) => !!(f && f.multiSelect);
  const emptyJson = (v) => /^\[\{"value":""/.test(String(v || ""));
  // valore di un campo come {v, t}: v = codice (o elenco di codici, testo, data AAAA-MM-GG)
  function pfValue(f, kind) {
    try {
      kind = kind || fieldKind(f);
      if (kind === "date") { const v = f.getValue(); return isDate(v) ? { v: isoOf(v), t: fmtDate(isoOf(v)) } : null; }
      if (kind === "text") { const v = String(f.getValue() ?? "").trim(); return v && !emptyJson(v) ? { v, t: v } : null; }
      if (kind === "list" && isMulti(f)) {
        const codes = asList(f.getValue());
        if (!codes.length) return null;
        const names = new Map(comboOptions(f));
        return { v: codes, t: codes.map((c) => names.get(c) || c).join(", ") };
      }
      return personValue(f);
    } catch { return null; }
  }
  function setPf(f, want, kind) {
    kind = kind || fieldKind(f);
    const cur = pfValue(f, kind);
    if (!want || want.v === undefined || want.v === null || want.v === "" || (Array.isArray(want.v) && !want.v.length)) {
      if (cur) clearField(f);
      return !pfValue(f, kind);
    }
    if (kind === "date") return setDate(f, String(want.v));
    if (kind === "text") return setText(f, String(want.v));
    if (kind === "list" && isMulti(f)) return setMulti(f, (Array.isArray(want.v) ? want.v : String(want.v).split(",")).map(String));
    if (cur && cur.v === String(want.v)) return true;
    return setPerson(f, { v: Array.isArray(want.v) ? want.v[0] : want.v, t: want.t });
  }
  // filtri del pannello con un valore (esclusi gruppi e persone): per descrizione e confronti
  function keptFilters(m) {
    return pfFields(m).filter((x) => !PEOPLE_KEYS.has(x.suffix)).map((x) => Object.assign(x, { val: pfValue(x.f, x.kind) })).filter((x) => x.val)
      .map((x) => ({ suffix: x.suffix, f: x.f, label: x.label, value: x.val.t, val: x.val }));
  }
  function statusCodes(m, s) {
    const opts = comboOptions(m.field("StatusFilter"));
    if (s.st === "all") return opts.map(([v]) => v); // senza elenco delle opzioni: nessun filtro
    if (s.st === "open") return opts.filter(([, t]) => !CLOSED_RE.test(t)).map(([v]) => v);
    if (s.st === "closed") return opts.filter(([, t]) => CLOSED_RE.test(t)).map(([v]) => v);
    if (s.st === "custom") return (s.stCodes || []).filter((c) => !opts.length || opts.some(([v]) => v === c));
    return null; // "page": lascia lo stato impostato nella pagina
  }
  function applyValues(m, s, run) {
    const doSet = (suffix, wanted, fn) => {
      const f = m.field(suffix) || (suffix === "FullText" ? m.quick : null);
      if (!f) { if (wanted) run.failed.push(`${suffix}: campo non trovato`); return; }
      try { if (fn(f)) run.applied.push(suffix); else run.failed.push(`${suffix}: valore non accettato`); } catch (e) { run.failed.push(`${suffix}: ${e && e.message}`); }
    };
    doSet("FullText", !!s.text, (f) => setText(f, s.text || ""));
    if (m.quick && m.quick !== m.field("FullText")) { try { setText(m.quick, s.text || ""); } catch { /* */ } }
    doSet("Subject", !!s.subject, (f) => setText(f, s.subject || ""));
    doSet("DateFromFilter", !!s.dfrom, (f) => setDate(f, s.dfrom));
    doSet("DateToFilter", !!s.dto, (f) => setDate(f, s.dto));
    doSet("LastUpdateDateFromFilter", !!s.ufrom, (f) => setDate(f, s.ufrom));
    doSet("LastUpdateDateToFilter", !!s.uto, (f) => setDate(f, s.uto));
    const st = statusCodes(m, s);
    if (st) doSet("StatusFilter", s.st !== "all", (f) => setMulti(f, st));
    doSet("PriorityFilter", !!(s.pr && s.pr.length), (f) => setMulti(f, s.pr || []));
    doSet("CatalogItemTxt", !!s.classif, (f) => setText(f, s.classif || ""));
    doSet("ClassCliTxt", !!s.classcli, (f) => setText(f, s.classcli || ""));
    if (s.people && typeof s.people === "object") {
      for (const [suffix] of PEOPLE) {
        const want = s.people[suffix];
        doSet(suffix, !!want, (f) => {
          const cur = personValue(f);
          if (want && want.v) return cur && cur.v === String(want.v) ? true : setPerson(f, want);
          if (cur) clearField(f);
          return !personValue(f);
        });
      }
    }
    // altri filtri del portale (Servizio, Sede, Contatto, Etichette...): quelli voluti, gli altri tolti
    if (s.pf && typeof s.pf === "object") {
      for (const x of pfFields(m)) {
        if (PEOPLE_KEYS.has(x.suffix) || x.kind === "treemenu") continue;
        const want = s.pf[x.suffix];
        doSet(x.suffix, !!want, (f) => setPf(f, want, x.kind));
      }
    }
  }
  async function pressEnter(m) {
    const f = m.field("FullText") || m.quick;
    if (!f) return "";
    const was = !!(document.body && document.body.inert);
    if (document.body) document.body.inert = false;
    try {
      const inp = f.inputEl && f.inputEl.dom;
      if (inp && inp.isConnected) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          const e = new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
          for (const k of ["keyCode", "which", "charCode"]) { try { Object.defineProperty(e, k, { get: () => (k === "charCode" && type !== "keypress" ? 0 : 13) }); } catch { /* */ } }
          inp.dispatchEvent(e);
        }
        return "dom";
      }
      const ke = new KeyboardEvent("keydown", { key: "Enter", code: "Enter" });
      try { Object.defineProperty(ke, "keyCode", { get: () => 13 }); } catch { /* */ }
      f.fireEvent("specialkey", f, new Ext.event.Event(ke));
      return "evento";
    } catch { return ""; } finally { if (document.body) document.body.inert = was; }
  }
  const loading = (st) => { try { return typeof st.isLoading === "function" ? st.isLoading() : !!st.loading; } catch { return false; } };
  // Caricamenti dell'elenco osservati durante una ricerca. Conta solo la risposta all'ultima richiesta partita:
  // la risposta tardiva di una richiesta precedente (ricerca interrotta, caricamento iniziale del portale)
  // non chiude la ricerca. done = l'operazione i cui dati sono ora nell'elenco.
  function watchStore(st) {
    const w = { started: 0, loaded: 0, lastAt: 0, ok: null, error: "", last: null, done: null, retries: 0 };
    const before = (s, op) => { w.started++; w.last = op || null; w.lastAt = performance.now(); };
    const load = (s, recs, ok, op) => {
      w.done = op || null;
      if (!w.started) return; // caricamento partito prima della ricerca
      w.lastAt = performance.now();
      if (op && w.last && op !== w.last) return; // risposta a una richiesta precedente
      w.loaded++; w.ok = ok !== false;
      if (ok === false) {
        try {
          const e = op && typeof op.getError === "function" ? op.getError() : null;
          w.error = e ? (typeof e === "string" ? e : [e.status, e.statusText].filter(Boolean).join(" ")) : "";
        } catch { /* */ }
      }
    };
    st.on("beforeload", before);
    st.on("load", load);
    w.stop = () => { try { st.un("beforeload", before); st.un("load", load); } catch { /* */ } };
    return w;
  }
  async function waitLoads(st, w, signal) {
    const end = performance.now() + 120000;
    for (;;) {
      const ok = await waitUntil(() => w.loaded > 0 && !loading(st) && performance.now() - w.lastAt > 700, end - performance.now(), signal);
      if (!ok) throw new Error("Il portale non ha finito di caricare l'elenco dopo 2 minuti.");
      // una risposta più vecchia è arrivata dopo la nostra e ha sostituito l'elenco: si ricarica (stessi filtri dell'ultima richiesta)
      if (!w.done || !w.last || w.done === w.last || w.retries >= 2) break;
      w.retries++; w.loaded = 0;
      try { st.reload(); } catch { break; }
    }
    if (w.ok === false) {
      const auth = /^(401|403)\b/.test(w.error);
      const big = settings.cap > 50 ? ` Se l'errore si ripete prova a ridurre il massimo di ticket per ricerca (Impostazioni, ora ${settings.cap}).` : "";
      throw new Error(`Il portale ha risposto con un errore al caricamento dell'elenco${w.error ? ` (${w.error})` : ""}.${auth ? " La sessione potrebbe essere scaduta: ricarica la pagina del portale e riprova." : big}`);
    }
  }
  function setPageSize(st, n) {
    const size = n || settings.cap;
    try {
      if (typeof st.setPageSize === "function") { if (st.getPageSize() !== size) st.setPageSize(size); }
      else st.pageSize = size;
    } catch { /* */ }
    try { return typeof st.getPageSize === "function" ? st.getPageSize() : st.pageSize; } catch { return null; }
  }
  // Ricerca: imposta i filtri dell'elenco della pagina e aspetta che il portale lo ricarichi.
  // Imposta i valori con apply(), poi aspetta che il portale ricarichi l'elenco da solo; se non lo fa
  // preme Invio nel campo Search e, come ultima possibilità, ricarica l'archivio dell'elenco.
  const triggers = {}; // modo di avvio che ha funzionato, per elenco: le ricerche successive partono subito
  // valori dei filtri gestiti: se apply() non cambia nulla il portale non può ricaricare da solo
  function fieldSig(m) {
    const out = [];
    for (const suffix of new Set([...Object.keys(CONTROLLED), ...PEOPLE_KEYS, ...pfFields(m).map((x) => x.suffix)])) {
      const f = m.field(suffix);
      if (!f) continue;
      try { const v = f.getValue(); out.push(isDate(v) ? isoOf(v) : Array.isArray(v) ? asList(v).sort().join(",") : scalarValue(f, v)); } catch { out.push("?"); }
    }
    return out.join("\u0001");
  }
  async function reload(m, apply, run, signal) {
    const st = m.store;
    // un caricamento già in corso (quello iniziale della scheda, o la richiesta di una ricerca interrotta) finisce
    // prima: la sua risposta non deve sostituire l'elenco durante o dopo questa ricerca
    if (loading(st)) {
      const pt = $("#progt"), was = pt.textContent;
      pt.textContent = "Aspetto che il portale finisca il caricamento precedente…";
      try { await waitUntil(() => !loading(st), 60000, signal); } finally { if (pt.textContent !== was) pt.textContent = was; }
    }
    const w = watchStore(st);
    const known = triggers[m.key] || "";
    try {
      activity(true);
      const before = fieldSig(m);
      apply();
      const changed = fieldSig(m) !== before;
      run.changed = changed;
      if (known === "loadPage" && changed) { run.trigger = "loadPage"; st.loadPage(1); }
      else {
        if (changed && !known.startsWith("invio")) await waitUntil(() => w.started > 0, known === "automatico" ? 1500 : 900, signal);
        if (!w.started) {
          run.trigger = "invio " + (await pressEnter(m));
          await waitUntil(() => w.started > 0, 1200, signal);
        }
        if (!w.started) { run.trigger = "loadPage"; st.loadPage(1); }
        else if (!run.trigger) run.trigger = "automatico";
      }
      await waitLoads(st, w, signal);
      run.loads = w.loaded;
      if (changed) {
        // «loadPage» si ricorda solo se è stato l'unico caricamento: se il portale ha caricato anche da solo, in
        // ritardo, la ricerca successiva rifà tutta la sequenza (attesa, Invio, loadPage)
        if (run.trigger === "loadPage" && w.started - w.retries > 1) delete triggers[m.key];
        else triggers[m.key] = run.trigger.startsWith("invio") ? "invio" : run.trigger;
      }
    } finally { w.stop(); }
  }
  // valori dei filtri della pagina prima della prima ricerca, per poterli ripristinare
  function snapshot(m) {
    const values = {};
    const people = {}; // campi con un solo valore scelto da un elenco: {v,t} o null, per rimetterli con il nome
    const pf = pfFields(m);
    for (const suffix of new Set([...Object.keys(CONTROLLED), ...pf.map((x) => x.suffix)])) {
      const f = CONTROLLED[suffix] || pf.some((x) => x.suffix === suffix) ? m.field(suffix) : null;
      if (f) { try { const v = f.getValue(); values[suffix] = Array.isArray(v) ? v.slice() : v; } catch { /* */ } }
    }
    for (const x of pf) if (["tree", "remote", "list"].includes(x.kind) && !isMulti(x.f)) people[x.suffix] = personValue(x.f);
    let quick, pageSize = null;
    try { quick = m.quick ? m.quick.getValue() : undefined; } catch { /* */ }
    try { pageSize = m.store.getPageSize(); } catch { /* */ }
    return { values, people, quick, pageSize };
  }
  // da chiamare prima di ogni scrittura nei campi filtro della pagina, per poterli ripristinare
  function ensureSnapshot(m) { if (m && !S.snaps[m.key]) S.snaps[m.key] = snapshot(m); }
  // se il portale manda meno righe di quelle chieste (limite lato server) la pagina successiva partirebbe da
  // pageSize e salterebbe dei ticket: si allinea pageSize alle righe ricevute
  function fitPageSize(st) {
    try {
      const got = st.getCount(), size = st.getPageSize();
      if ((st.currentPage || 1) === 1 && got > 0 && got < size && st.getTotalCount() > got) st.setPageSize(got);
    } catch { /* */ }
  }
  async function pageSearch(m, s, signal) {
    const run = { at: new Date().toISOString(), list: m.key, trigger: "", applied: [], failed: [], loads: 0, ms: 0, verified: null, pageSize: null };
    conn.lastRun = run;
    const seq0 = conn.seq;
    const t0 = performance.now();
    ensureSnapshot(m);
    try {
      await reload(m, () => { run.pageSize = setPageSize(m.store); applyValues(m, s, run); }, run, signal);
      const reqs = [...conn.ext, ...conn.xhr].filter((r) => r.seq > seq0);
      const probe = norm(s.text || s.subject || "").split(/\s+/).filter((x) => x.length >= 3)[0];
      if (probe && reqs.length) run.verified = reqs.some((r) => reqBlob(r).includes(probe));
      fitPageSize(m.store);
      return readStore(m);
    } finally { run.ms = Math.round(performance.now() - t0); }
  }
  // rimette i filtri della pagina com'erano; restituisce i gruppi e le persone che il portale non ha ripreso
  async function restoreSnapshot(m, sn, signal) {
    const run = { trigger: "", loads: 0 }, missed = [];
    await reload(m, () => {
      for (const [suffix, v] of Object.entries(sn.values)) {
        const f = m.field(suffix);
        if (!f) continue;
        try {
          if (Array.isArray(v) || f.multiSelect) setMulti(f, asList(v));
          else if (v === null || v === undefined || v === "") { if (typeof f.clearValue === "function") f.clearValue(); else f.setValue(null); }
          // con il nome: se una ricerca per nome ha ricaricato l'elenco del campo il codice da solo non basta
          else if (sn.people && sn.people[suffix]) setPerson(f, sn.people[suffix]);
          else f.setValue(v);
        } catch { /* */ }
      }
      for (const [suffix, want] of Object.entries(sn.people || {})) {
        const f = m.field(suffix), now = f && personValue(f);
        if (f && (want ? !now || now.v !== want.v : now)) missed.push((PEOPLE.find(([k]) => k === suffix) || [, fieldLabel(f, suffix)])[1].replace(/ \(.*$/, ""));
      }
      if (m.quick && sn.quick !== undefined) { try { m.quick.setValue(sn.quick); } catch { /* */ } }
      try { if (sn.pageSize && typeof m.store.setPageSize === "function") m.store.setPageSize(sn.pageSize); } catch { /* */ }
    }, run, signal);
    return missed;
  }
  // Stato dell'elenco del portale dopo una ricerca: serve a «Carica i successivi» e «Quanti per anno?» per
  // sapere se l'elenco contiene ancora la stessa ricerca (Ripristina, Azzera, filtri o ordinamento cambiati nel portale).
  function sortSig(st) {
    try { const ss = st.getSorters(); return (ss ? ss.getRange() : []).map((x) => `${x.getProperty()}:${x.getDirection()}`).join(","); } catch { return ""; }
  }
  function listState(m) {
    let size = null;
    try { size = m.store.getPageSize(); } catch { /* */ }
    return {
      sig: fieldSig(m), size, sort: sortSig(m.store),
      people: PEOPLE.map(([k]) => { const f = m.field(k); const p = f && personValue(f); return p ? p.v : ""; }).join("\u0001"),
      kept: keptFilters(m).map((k) => `${k.suffix}=${k.value}`).join("\u0001"),
    };
  }
  const DRIFT_MSG = "Dopo la ricerca sono cambiati nel portale i gruppi e persone, i filtri della pagina o l'ordinamento dell'elenco: premi «Cerca» per rifare la ricerca.";
  // Rimette nell'elenco del portale la ricerca dei risultati se sono cambiati solo i filtri gestiti da Ricerca TKT
  // o il numero di righe; false se sono cambiati gruppi e persone, i filtri lasciati dalla pagina o l'ordinamento
  // (sono scelte dell'utente nel portale: non si tolgono senza dirlo).
  async function ensureLastInPortal(m, signal) {
    const was = S.info && S.info.state;
    if (!was || !S.last) return false;
    const now = listState(m);
    if (now.people !== was.people || now.kept !== was.kept || now.sort !== was.sort) return false;
    if (now.sig === was.sig && now.size === was.size) return true;
    ensureSnapshot(m);
    const run = { applied: [], failed: [], trigger: "", loads: 0 };
    await reload(m, () => { setPageSize(m.store, S.info.pageSize); applyValues(m, Object.assign({}, S.last, { people: undefined, pf: undefined }), run); }, run, signal);
    S.info.state = listState(m);
    return true;
  }
  // pagina indicata (non st.currentPage: l'utente può aver sfogliato l'elenco nel portale) con la dimensione della ricerca
  async function loadNextPage(m, page, size, signal) {
    const st = m.store;
    if (loading(st)) await waitUntil(() => !loading(st), 60000, signal);
    const w = watchStore(st);
    try {
      activity(true);
      setPageSize(st, size);
      st.loadPage(page);
      await waitLoads(st, w, signal);
      return readStore(m);
    } finally { w.stop(); }
  }

  // ===================================================================== lettura dei ticket dall'elenco
  const SEM = [
    ["code", /^(id|n\.?|nr\.?|numero|ticket|id ticket|codice|code|number)$/],
    ["date", /^(date|data|data apertura|data di apertura|opened|open date|creation date|data creazione|created)$/],
    ["subject", /^(subject|oggetto|titolo|title)$/],
    ["site", /^(site|sede|cliente|client|customer|account|azienda)$/],
    ["siteCode", /^(site code|codice sede|codice cliente|client code|account code)$/],
    ["contact", /^(contact|contatto|referente)$/],
    ["status", /^(status|stato)$/],
    ["priority", /^(priority|priorita)$/],
    ["service", /^(service|servizio)$/],
    ["classification", /^(classification|classificazione)$/],
    ["assigned", /^(assigned to|assegnato a|assegnatario|incaricato)$/],
    ["group", /^(owner group|gruppo|gruppo proprietario|gruppo assegnatario)$/],
    ["updated", /^(last update|last updated|ultimo aggiornamento|ultima modifica|last change|modified)$/],
    ["sender", /^(mittente|sender|from)$/],
    ["owner", /^(resource owner|responsabile|risorsa responsabile)$/],
    ["modifiers", /^(modified by|modificato da|modificatori)$/],
    ["sla", /^(sla)$/],
    ["tags", /^(tags?|etichette)$/],
  ];
  const semOf = (header) => { const k = norm(header).replace(/\s+/g, " ").trim(); const s = SEM.find(([, re]) => re.test(k)); return s ? s[0] : ""; };
  function gridColumns(grid) {
    let cols = [];
    try { cols = typeof grid.getColumns === "function" ? grid.getColumns() : grid.headerCt.getGridColumns(); } catch { cols = []; }
    return cols.filter((c) => c && !c.isCheckerHd && !/^(checkcolumn|rownumberer|actioncolumn)$/.test(c.xtype || ""))
      .map((c, i) => {
        const header = textOf(String(c.text || c.header || ""));
        return { c, id: typeof c.getId === "function" ? c.getId() : c.id, header, dataIndex: c.dataIndex, hidden: !!(c.hidden || (typeof c.isHidden === "function" && c.isHidden())), sem: semOf(header), idx: i };
      }).filter((x) => x.header);
  }
  function partsFromEl(el) {
    const parts = [];
    const walk = (n) => {
      for (const ch of n.childNodes) {
        if (ch.nodeType === 3) { const t = ch.nodeValue.replace(/\s+/g, " ").trim(); if (t) parts.push(t); }
        else if (ch.nodeType === 1 && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(ch.tagName)) walk(ch);
      }
    };
    walk(el);
    const t = el.matches && el.matches("[title],[data-qtip]") ? el : el.querySelector("[title],[data-qtip]");
    return { parts, title: t ? t.getAttribute("title") || t.getAttribute("data-qtip") || "" : "" };
  }
  function valueText(v) {
    if (v === null || v === undefined) return "";
    if (isDate(v)) return `${fmtDate(isoOf(v))} ${pad(v.getHours())}:${pad(v.getMinutes())}`;
    if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(", ");
    if (typeof v === "object") return String(v.text || v.Text || v.Description || v.description || v.name || v.Name || "");
    if (typeof v === "boolean") return v ? "Sì" : "No";
    return textOf(String(v));
  }
  const cssEsc = (s) => (window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  function cellParts(m, rec, col, row) {
    const value = col.dataIndex ? (() => { try { return rec.get(col.dataIndex); } catch { return undefined; } })() : undefined;
    try {
      const view = m.grid.getView();
      const node = view.getNode(rec);
      const td = node && node.querySelector(`[data-columnid="${cssEsc(col.id)}"]`);
      if (td) return Object.assign(partsFromEl(td), { value });
    } catch { /* riga non disegnata */ }
    try {
      const c = col.c;
      if (typeof c.renderer === "function") {
        const meta = { tdCls: "", tdAttr: "", tdStyle: "", style: "", innerCls: "", column: c, record: rec, recordIndex: row };
        const out = c.renderer.call(c.usingDefaultRenderer ? c : c.scope || m.grid, value, meta, rec, row, col.idx, m.store, m.grid.getView());
        const doc = new DOMParser().parseFromString(`<div id="rtkt-cell" ${String(meta.tdAttr || "").replace(/[<>]/g, "")}>${out === null || out === undefined ? "" : String(out)}</div>`, "text/html");
        return Object.assign(partsFromEl(doc.getElementById("rtkt-cell") || doc.body), { value });
      }
      if (c.tpl && typeof c.tpl.apply === "function") {
        const doc = new DOMParser().parseFromString(`<div id="rtkt-cell">${c.tpl.apply(rec.getData ? rec.getData() : rec.data)}</div>`, "text/html");
        return Object.assign(partsFromEl(doc.getElementById("rtkt-cell") || doc.body), { value });
      }
    } catch { /* uso il valore grezzo */ }
    const t = valueText(value);
    return { parts: t ? [t] : [], title: "", value };
  }
  function parseDateText(s, raw) {
    if (isDate(raw)) return { date: isoOf(raw), time: `${pad(raw.getHours())}:${pad(raw.getMinutes())}` };
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    let y, mo, d;
    if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; } else {
      const m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s || "");
      if (!m) return { date: null, time: "" };
      const a = +m[1], b = +m[2];
      y = +m[3];
      let fmt = "m/d/Y";
      try { fmt = (Ext.Date && Ext.Date.defaultFormat) || fmt; } catch { /* */ }
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else if (/^[mn]/i.test(fmt)) { mo = a; d = b; } else { d = a; mo = b; }
    }
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return { date: null, time: "" };
    const tm = /(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i.exec((s || "").replace(/\d{1,2}[/.-]\d{1,2}[/.-]\d{4}/, " "));
    let time = "";
    if (tm) { let hh = +tm[1]; if (tm[3]) { const pm = /^p/i.test(tm[3]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; } time = `${pad(hh)}:${tm[2]}`; }
    return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
  }
  // Riepilogo nel "title" della colonna Oggetto: "Subject:\n…\n\nIssue/Request:\n…\n\nResolution:\n…"
  const SEC_LABEL_RE = /^(subject|oggetto|issue\/request|issue|request|richiesta|problema|description|descrizione|resolution|soluzione|risoluzione|risposta)$/i;
  function sections(title) {
    const out = [];
    const re = /(?:^|\n\s*\n)([A-Za-z\u00c0-\u00ff][^\n:]{0,40}):[ \t]*\n/g;
    let marks = [];
    let x;
    while ((x = re.exec(title))) marks.push({ label: x[1].trim(), start: x.index, body: re.lastIndex });
    // con le etichette note (Subject, Issue/Request, Resolution) una frase del testo che finisce con ":" non è una sezione
    if (marks.some((k) => SEC_LABEL_RE.test(k.label))) marks = marks.filter((k) => SEC_LABEL_RE.test(k.label));
    for (let i = 0; i < marks.length; i++) out.push([marks[i].label, title.slice(marks[i].body, i + 1 < marks.length ? marks[i + 1].start : undefined).trim()]);
    return out;
  }
  function toTicket(m, rec, row, cols) {
    const t = { key: "", code: "", recId: "", list: m.key, source: "Touch", rank: row, cols: [] };
    try { t.recId = String(typeof rec.getId === "function" ? rec.getId() : rec.id); } catch { /* */ }
    for (const col of cols) {
      const { parts, title, value } = cellParts(m, rec, col, row);
      const text = parts.join(" ");
      if (text || title) t.cols.push({ h: col.header, v: parts.join(" · ").slice(0, 2000) });
      const sem = col.sem;
      if (!sem || !(text || title)) continue;
      if (sem === "date" || sem === "updated") {
        if (t[sem]) continue;
        const p = parseDateText(text, value);
        if (p.date) { t[sem] = p.date; if (sem === "date") t.time = p.time; else t.updTime = p.time; }
      } else if (sem === "subject") {
        if (t.subject) continue;
        t.subject = parts[0] || "";
        const sec = title ? sections(title) : [];
        if (sec.length) {
          if (sec[0][1] && !t.subject) t.subject = sec[0][1];
          const rest = sec.slice(1);
          const res = rest.find(([l]) => /resol|soluz|risoluz|risposta/i.test(l));
          const req = rest.find((s) => s !== res);
          if (req) t.preview = req[1];
          if (res && res[1] && res[1] !== "-") t.resolution = res[1];
        } else if (parts.length > 1) t.preview = parts.slice(1).join(" ");
        else if (title && title !== t.subject) t.preview = title;
      } else if (sem === "site") {
        if (t.site) continue;
        t.site = parts[0] || "";
        if (parts[1] && /^[\w-]{2,20}$/.test(parts[1])) t.siteCode = parts[1];
      } else if (sem === "code") {
        if (!t.code) t.code = parts[0] || text;
      } else if (!t[sem]) t[sem] = text;
    }
    t.key = t.code ? `c:${t.code}` : `r:${m.key}:${t.recId}`;
    // dato del ticket usato nell'indirizzo della sua pagina (se non è l'id o il numero)
    const tp = touchTemplate();
    if (tp && tp.field !== "recId" && tp.field !== "code") { try { const v = rec.get(tp.field); if (v !== undefined && v !== null) t.ref = { [tp.field]: String(v).slice(0, 100) }; } catch { /* */ } }
    return t;
  }
  function readStore(m) {
    const st = m.store;
    const cols = gridColumns(m.grid);
    let recs = [];
    try { recs = st.getRange(); } catch { recs = []; }
    let total = null;
    try { total = st.getTotalCount(); } catch { /* */ }
    return { tickets: recs.map((r, i) => toTicket(m, r, i, cols)), total: typeof total === "number" ? total : recs.length, page: st.currentPage || 1, pageSize: (() => { try { return st.getPageSize(); } catch { return settings.cap; } })(), cols };
  }

  // ===================================================================== apertura dei ticket nel portale
  // pulsanti della barra dell'elenco: per testo o per il nome stabile del comando (aria-label del portale,
  // es. ACCESSIBILITY_List_Btn_Toolbar_RecordView = Open, ..._WF_FindById = Find by ID)
  function findButton(m, re, aria) {
    const lists = [];
    try { const tb = Ext.getCmp(m.P + "listToolbar"); if (tb && tb.query) lists.push(tb.query("button")); } catch { /* */ }
    try { if (m.cmp && m.cmp.query) lists.push(m.cmp.query("button")); } catch { /* */ }
    const ariaOf = (b) => { try { return String(b.ariaLabel || (b.el && b.el.dom && b.el.dom.getAttribute("aria-label")) || ""); } catch { return ""; } };
    if (aria) for (const list of lists) for (const b of list) if (aria.test(ariaOf(b))) return b;
    for (const list of lists) {
      for (const b of list) {
        const text = textOf(String((typeof b.getText === "function" ? b.getText() : b.text) || "")).replace(/\u00a0/g, " ").trim();
        if (re.test(text)) return b;
      }
    }
    return null;
  }
  function clickBtn(b) {
    try {
      if (b.rendered && b.el && b.el.dom && b.el.dom.isConnected && (typeof b.isVisible !== "function" || b.isVisible(true))) { b.el.dom.click(); return true; }
    } catch { /* */ }
    try {
      if (typeof b.fireHandler === "function") { b.fireHandler(new Ext.event.Event(new MouseEvent("click", { bubbles: true }))); return true; }
    } catch (e) { conn.errors.push(`pulsante: ${e && e.message}`); }
    return false;
  }
  // Porta in primo piano la scheda dell'elenco: per ogni tabpanel tra il modulo e la pagina attiva il figlio
  // diretto che lo contiene (setActiveTab accetta solo i figli diretti). Senza tabpanel: clic sulla scheda.
  function showModuleTab(m) {
    let found = false;
    try {
      for (let p = m && m.cmp, i = 0; p && p.ownerCt && i < 60; p = p.ownerCt, i++) {
        if (!isTabPanel(p.ownerCt)) continue;
        found = true;
        if (p.ownerCt.getActiveTab() !== p) p.ownerCt.setActiveTab(p);
      }
    } catch { /* */ }
    if (!found && m && isAllList(m)) {
      try {
        const t = allTab();
        if (t && !t.t.active && t.t.el && t.t.el.dom) {
          const was = !!(document.body && document.body.inert);
          if (document.body) document.body.inert = false;
          try { t.t.el.dom.click(); } finally { if (document.body) document.body.inert = was; }
        }
      } catch { /* */ }
    }
  }
  function recordFor(m, t) {
    if (!m || !m.store || t.list !== m.key) return null;
    const cols = gridColumns(m.grid);
    const codeCol = cols.find((c) => c.sem === "code");
    const codeOf = (r, i) => (codeCol ? cellParts(m, r, codeCol, i).parts[0] || "" : "");
    try {
      const r = t.recId ? m.store.getById(t.recId) : null;
      if (r && (!t.code || codeOf(r, m.store.indexOf(r)) === t.code)) return r;
    } catch { /* */ }
    if (!t.code) return null;
    const recs = m.store.getRange();
    for (let i = 0; i < recs.length; i++) if (codeOf(recs[i], i) === t.code) return recs[i];
    return null;
  }
  // ---- indirizzo del ticket nel portale (HDA TOUCH apre ogni ticket in una nuova scheda del browser)
  // La prima apertura insegna lo schema dell'indirizzo (quale dato del ticket contiene): dopo, ogni risultato
  // ha il suo collegamento diretto e il ticket si può leggere nel pannello senza aprire schede.
  const URLKEY = "touchUrl";
  const absUrl = (u) => { try { const x = new URL(String(u), location.href); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  function touchTemplate() { const t = store.get(URLKEY, null); return t && typeof t.tpl === "string" && t.tpl.includes("{v}") && typeof t.field === "string" ? t : null; }
  function touchUrl(t) {
    const tp = touchTemplate();
    if (!tp || !t || t.src === "ar") return null;
    const v = tp.field === "recId" ? t.recId : tp.field === "code" ? t.code : t.ref && t.ref[tp.field];
    if (v === undefined || v === null || v === "") return null;
    return absUrl(tp.tpl.replace("{v}", encodeURIComponent(String(v))));
  }
  function learnTemplate(url, t, rec) {
    if (!url || !t) return null;
    const cands = [["recId", t.recId], ["code", t.code]];
    try {
      const d = rec && typeof rec.getData === "function" ? rec.getData() : null;
      if (d) for (const [k, v] of Object.entries(d)) if ((typeof v === "string" || typeof v === "number") && String(v).length >= 2 && String(v).length <= 64) cands.push([k, String(v)]);
    } catch { /* */ }
    for (const [field, v] of cands) {
      if (v === undefined || v === null || v === "") continue;
      for (const enc of new Set([encodeURIComponent(String(v)), String(v)])) {
        const mm = new RegExp(`(^|[^A-Za-z0-9])${escRe(enc)}(?=$|[^A-Za-z0-9])`).exec(url);
        if (!mm) continue;
        const at = mm.index + mm[1].length;
        const tp = { tpl: url.slice(0, at) + "{v}" + url.slice(at + enc.length), field, at: new Date().toISOString() };
        // il dato scelto deve dare di nuovo lo stesso indirizzo
        if (absUrl(tp.tpl.replace("{v}", encodeURIComponent(String(v)))) !== absUrl(url) && absUrl(tp.tpl.replace("{v}", String(v))) !== absUrl(url)) continue;
        store.set(URLKEY, tp);
        return tp;
      }
    }
    return null;
  }
  // Apre il ticket con i comandi del portale (Open, doppio clic, Find by ID) e intercetta la nuova scheda:
  // mode "observe" la lascia aprire e ne ricorda l'indirizzo; mode "intercept" non apre nulla e restituisce
  // l'indirizzo (oppure carica la pagina nella cornice indicata, se il portale la apre con un modulo POST).
  async function portalOpen(m, t, mode, frame) {
    const rec = recordFor(m, t);
    const got = { url: null, posted: false, how: "" };
    const W = window, origOpen = W.open, FP = HTMLFormElement.prototype, origSubmit = FP.submit;
    const take = (u) => { const a = u && !/^(about:blank|javascript:)/i.test(String(u)) ? absUrl(u) : null; if (a) got.url = a; return a; };
    const sink = { closed: false, opener: W, focus() {}, blur() {}, close() { this.closed = true; }, document: { write() {}, writeln() {}, open() {}, close() {} } };
    Object.defineProperty(sink, "location", { get: () => ({ get href() { return got.url || "about:blank"; }, set href(v) { take(v); }, assign: take, replace: take, toString: () => got.url || "about:blank" }), set: take });
    W.open = function (u) {
      take(u);
      if (mode === "observe") return origOpen.apply(W, arguments);
      return sink;
    };
    const onClick = (e) => {
      const a = (e.composedPath ? e.composedPath() : []).find((x) => x && x.tagName === "A");
      if (!a || !a.href || /^javascript:/i.test(a.getAttribute("href") || "") || (a.getAttribute("href") || "").startsWith("#")) return;
      if (a.target && a.target !== "_self") { take(a.href); if (mode !== "observe") e.preventDefault(); }
    };
    const formUrl = (fm) => {
      if ((fm.method || "get").toLowerCase() !== "get") return null;
      try { const u = new URL(fm.action || location.href, location.href); for (const [k, v] of new FormData(fm)) if (typeof v === "string") u.searchParams.append(k, v); return u.href; } catch { return null; }
    };
    const viaForm = (fm) => {
      if (!fm.target || fm.target === "_self") return false;
      const u = formUrl(fm);
      if (u) { take(u); if (mode === "observe") return false; return true; }
      if (mode !== "observe" && frame) { fm.target = frame.name; got.posted = true; }
      return false;
    };
    FP.submit = function () { if (viaForm(this)) return undefined; return origSubmit.call(this); };
    const onSubmit = (e) => { if (viaForm(e.target)) e.preventDefault(); };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    try {
      activity(true);
      if (rec) {
        showModuleTab(m);
        await sleep(50);
        try { m.grid.getSelectionModel().select([rec]); } catch { /* */ }
        const b = findButton(m, /^(open|apri)$/i, /_RecordView$/);
        const usable = () => !!b && !b.destroyed && !(typeof b.isDisabled === "function" && b.isDisabled());
        // il portale riabilita i comandi dopo il cambio di selezione (binding con timer o disable/enable della barra)
        if (b) await waitUntil(usable, 1500);
        let href = "";
        try { href = typeof b.getHref === "function" ? b.getHref() || "" : b.href || ""; } catch { href = ""; }
        if (usable() && href && !/^(#|javascript:)/i.test(href)) { take(href); got.how = "Open (collegamento)"; if (mode === "observe") origOpen.call(W, got.url, "_blank"); }
        else if (usable() && clickBtn(b)) got.how = "Open";
        else {
          try {
            const view = m.grid.getView();
            const node = view.getNode(rec);
            const cell = node && [...node.querySelectorAll("td.x-grid-cell")].find((td) => { const c = Ext.getCmp(td.getAttribute("data-columnid")); return c && c.dataIndex; });
            const was = !!(document.body && document.body.inert);
            if (document.body) document.body.inert = false;
            try {
              // doppio clic vero: Ext genera itemdblclick/rowdblclick/celldblclick sulla view e li ripete sulla griglia
              if (cell) cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
              else view.fireEvent("itemdblclick", view, rec, node, m.store.indexOf(rec), new Ext.event.Event(new MouseEvent("dblclick", { bubbles: true })));
            } finally { if (document.body) document.body.inert = was; }
            got.how = "doppio clic";
          } catch { /* sotto: Find by ID */ }
        }
      }
      if (!got.how && t.code) got.how = (await findById(m, t.code, true)) ? "Find by ID" : "";
      if (got.how) await waitUntil(() => !!got.url || got.posted, 4000);
    } finally {
      W.open = origOpen; FP.submit = origSubmit;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    }
    if (got.url) learnTemplate(got.url, t, rec);
    return got;
  }
  // «Apri in Touch»: con l'indirizzo noto si apre direttamente, altrimenti con i comandi del portale
  async function openTicket(t) {
    if (t.src === "ar") { arOpen(t); return; }
    const url = touchUrl(t);
    if (url) { window.open(url, "_blank", "noopener"); return; }
    const m = currentModule();
    hide();
    const got = await portalOpen(m, t, "observe");
    if (got.url) { show(); render(); return; } // il ticket è nella nuova scheda; il pannello resta qui con i risultati
    if (!got.how) { show(); toast(t.code ? `Ticket ${t.code} non presente nell'elenco: numero copiato, aprilo dal portale` : "Ticket non presente nell'elenco"); }
  }
  // quiet: per la lettura nel pannello (nessun messaggio, il pannello resta aperto); true se la richiesta è partita
  async function findById(m, code, quiet) {
    if (code && !quiet) await copyText(code, null);
    const b = m && findButton(m, /^(find by id|trova per id|cerca per id|trova id|vai al ticket)/i, /_FindById$/);
    if (!b) { if (!quiet) { show(); toast(code ? `Ticket ${code} non presente nell'elenco: numero copiato, aprilo dal portale` : "Ticket non presente nell'elenco"); } return false; }
    showModuleTab(m);
    await sleep(50);
    // solo una finestra comparsa DOPO il clic è quella di Find by ID: mai scrivere o confermare in una finestra
    // già aperta dall'utente (Change status..., Reply...)
    const visWins = () => Ext.ComponentQuery.query("window").filter((w) => !w.destroyed && w.isVisible && w.isVisible());
    const before = new Set(visWins());
    if ((typeof b.isDisabled === "function" && b.isDisabled()) || !clickBtn(b)) { if (!quiet) { show(); toast(code ? `Numero ${code} copiato: aprilo dal portale` : "Apri il ticket dal portale"); } return false; }
    if (!code) return false;
    let field = null;
    await waitUntil(() => {
      const fresh = visWins().filter((w) => !before.has(w));
      const act = Ext.WindowManager && typeof Ext.WindowManager.getActive === "function" ? Ext.WindowManager.getActive() : null;
      const w = fresh.includes(act) ? act : fresh[fresh.length - 1];
      const f = w && w.query("textfield").find((x) => x.isVisible && x.isVisible() && !(x.isXType && x.isXType("hiddenfield")));
      if (f) { field = f; return true; }
      return false;
    }, 2500);
    if (!field) return false; // il numero è già negli appunti
    try { field.setValue(code); if (!quiet) field.focus(true, 30); } catch { /* */ }
    // conferma con il pulsante della finestra (OK / Find / Cerca...), se riconoscibile
    try {
      const w = field.up("window");
      const ok = w && w.query("button").filter((x) => x.isVisible && x.isVisible(true))
        .find((x) => /^(ok|find|search|cerca|trova|apri|open|vai|go)$/i.test(textOf(String((x.getText ? x.getText() : x.text) || ""))));
      if (ok && String(field.getValue()) === code) { await sleep(80); clickBtn(ok); return true; }
      if (quiet && w) { try { w.close(); } catch { /* */ } }
    } catch { /* l'utente conferma a mano */ }
    return false;
  }

  // ---- lettura del ticket completo: la pagina del ticket in una cornice nascosta, poi il testo nel pannello
  let readerSeq = 0;
  function readerFrame() {
    const fr = document.createElement("iframe");
    fr.name = `rtkt-reader-${++readerSeq}`;
    // senza allow-top-navigation e allow-popups: la pagina del ticket non può cambiare la pagina del portale
    fr.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms");
    fr.setAttribute("aria-hidden", "true");
    fr.tabIndex = -1;
    fr.style.cssText = "position:fixed;left:-12000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none";
    document.documentElement.appendChild(fr);
    return fr;
  }
  const frameWin = (fr) => { try { const w = fr.contentWindow; return w && w.document ? w : null; } catch { return null; } };
  async function waitFrame(fr, signal) {
    let lastLen = -1, since = 0, cross = false;
    const ok = await waitUntil(() => {
      let w;
      try { w = fr.contentWindow; if (!w) return false; void w.document; } catch { cross = true; return true; }
      const doc = w.document;
      if (!doc || doc.readyState !== "complete" || w.location.href === "about:blank") return false;
      const X = w.Ext;
      if (X) {
        if (!X.isReady) return false;
        // tutte le richieste in corso (isLoading() senza argomenti guarda solo l'ultima), tranne quelle continue
        try { if (X.Ajax && X.Ajax.requests && Object.values(X.Ajax.requests).some((r) => r && typeof r.isLoading === "function" && r.isLoading() && !/signalr|poll|heartbeat|keepalive/i.test(String((r.options && r.options.url) || "")))) return false; } catch { /* */ }
        try { if (X.ComponentQuery.query("loadmask").some((lm) => lm.isVisible && lm.isVisible())) return false; } catch { /* */ }
        // una finestra di avviso aperta ha la sua maschera: allora la pagina è pronta (il suo testo si legge)
        let modal = false;
        try { modal = X.ComponentQuery.query("window").some((x) => x.modal && x.isVisible && x.isVisible()); } catch { /* */ }
        try { if (!modal && [...doc.querySelectorAll(".x-mask")].some((el) => el.offsetWidth > 0 && w.getComputedStyle(el).display !== "none" && w.getComputedStyle(el).visibility !== "hidden")) return false; } catch { /* */ }
      }
      const len = ((doc.body && doc.body.innerText) || "").length;
      if (len !== lastLen) { lastLen = len; since = performance.now(); return false; }
      return len > 0 && performance.now() - since > 900;
    }, 25000, signal);
    if (cross) throw new Error("La pagina del ticket è su un altro sito: aprila con «Apri in Touch».");
    if (!ok) throw new Error("La pagina del ticket non ha finito di caricarsi.");
  }
  // testo leggibile (anche da HTML), con gli a capo
  function plainText(v) {
    let s = String(v ?? "");
    if (/<[a-z][\s\S]*>/i.test(s) || /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) {
      const d = new DOMParser().parseFromString(`<body>${s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")}`, "text/html");
      s = d.body.textContent || "";
    }
    return s.replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // contenuto leggibile di una pagina ExtJS (o di un suo pannello, root): campi con etichetta, testi lunghi, elenchi
  function extractTicket(w, root) {
    const doc = w.document, X = w.Ext;
    const out = { title: plainText(doc.title), fields: [], texts: [], tables: [] };
    const q = (sel) => (root && typeof root.query === "function" ? root.query(sel) : X.ComponentQuery.query(sel));
    const seen = new Set();
    const fmt = (v) => (isDate(v) ? `${fmtDate(isoOf(v))} ${pad(v.getHours())}:${pad(v.getMinutes())}` : v);
    if (X && X.ComponentQuery) {
      for (const c of q("[isFormField]")) {
        try {
          if (c.ownerCt && c.ownerCt.isXType && (c.ownerCt.isXType("checkboxgroup") || c.ownerCt.isXType("radiogroup"))) continue;
          if ((c.isXType && c.isXType("hiddenfield")) || c.inputType === "password" || (c.isHidden && c.isHidden())) continue;
          const label = plainText((typeof c.getFieldLabel === "function" ? c.getFieldLabel() : c.fieldLabel) || c.boxLabel || c.name || "").replace(/:$/, "");
          let v = typeof c.getDisplayValue === "function" ? c.getDisplayValue() : null;
          if (v === null || v === undefined || v === "") v = c.rendered && typeof c.getRawValue === "function" ? c.getRawValue() : c.getValue();
          v = plainText(fmt(v));
          if (!v || emptyJson(v)) continue;
          const key = label + "\u0001" + v;
          if (seen.has(key)) continue;
          seen.add(key);
          const long = v.length > 160 || v.includes("\n") || (c.isXType && (c.isXType("textareafield") || c.isXType("htmleditor")));
          (long ? out.texts : out.fields).push({ label, value: v.slice(0, 20000) });
        } catch { /* */ }
      }
      for (const g of q("tablepanel")) {
        try {
          const st = g.getStore();
          const cols = (typeof g.getVisibleColumns === "function" ? g.getVisibleColumns() : typeof g.getColumns === "function" ? g.getColumns() : g.columns || []).filter((c) => c.dataIndex && !c.hidden);
          if (!st || !cols.length || typeof st.getRange !== "function") continue;
          const rows = st.getRange().slice(0, 300).map((r, i) => cols.map((c, j) => {
            let v = r.get(c.dataIndex);
            if (typeof c.renderer === "function") { try { v = c.renderer.call(c.usingDefaultRenderer ? c : c.scope || g, v, {}, r, i, j, st, g.getView && g.getView()); } catch { /* valore grezzo */ } }
            return plainText(fmt(v));
          }));
          if (rows.length) out.tables.push({ title: plainText(g.title || (g.tab && g.tab.text) || ""), head: cols.map((c) => plainText(c.text || c.dataIndex)), rows });
        } catch { /* */ }
      }
      for (const c of q("component")) {
        try {
          // testo libero dei pannelli (Ext cancella c.html dopo averlo disegnato: allora si legge il DOM)
          const ic = c.initialConfig || {};
          if (!(ic.html || ic.tpl || ic.contentEl || typeof c.html === "string") || (c.items && c.items.getCount && c.items.getCount())) continue;
          if (c.isXType && ["htmleditor", "tablepanel", "menu", "toolbar", "tabbar", "boundlist", "field"].some((x) => c.isXType(x))) continue;
          const el = c.rendered ? (c.body || (typeof c.getTargetEl === "function" ? c.getTargetEl() : null) || c.el) : null;
          const raw = el && el.dom ? el.dom.innerText : typeof c.html === "string" ? c.html : "";
          const v = plainText(raw);
          if (v.length > 30 && !seen.has(v)) { seen.add(v); out.texts.push({ label: plainText(c.title || ""), value: v.slice(0, 20000) }); }
        } catch { /* */ }
      }
    }
    if (!out.fields.length && !out.texts.length && !out.tables.length) {
      const el = root && root.el && root.el.dom ? root.el.dom : doc.body;
      const v = plainText((el && el.innerText) || "");
      if (v) out.texts.push({ label: "", value: v.slice(0, 40000) });
    }
    return out;
  }
  // Anteprima del portale accanto all'elenco (<P>PreviewModule): se la pagina del ticket non si può leggere
  async function previewRead(m, t, signal) {
    const pv = Ext.getCmp(m.P + "PreviewModule");
    const rec = recordFor(m, t);
    if (!pv || !rec || !pv.el) return null;
    const was = !!pv.collapsed;
    try {
      showModuleTab(m);
      if (was && typeof pv.expand === "function") pv.expand(false);
      try { m.grid.getSelectionModel().select([rec]); } catch { /* */ }
      await sleep(300);
      let last = -1, since = 0;
      const ok = await waitUntil(() => {
        const el = pv.body && pv.body.dom;
        if (!el) return false;
        if ([...pv.el.dom.querySelectorAll(".x-mask")].some((x) => x.offsetWidth > 0 && getComputedStyle(x).display !== "none")) return false;
        const len = (el.innerText || "").length;
        if (len !== last) { last = len; since = performance.now(); return false; }
        return len > 20 && performance.now() - since > 800;
      }, 15000, signal);
      if (!ok) return null;
      const c = extractTicket(window, pv);
      return c.fields.length || c.texts.length || c.tables.length ? c : null;
    } finally { if (was) { try { pv.collapse(); } catch { /* */ } } }
  }
  // diagnosi per i dati tecnici (senza contenuti)
  conn.reader = null;
  async function loadTouchTicket(t, signal) {
    try { return await loadTouchPage(t, signal); } catch (e) {
      if (e && e.name === "AbortError") throw e;
      const m = currentModule();
      const pv = m ? await previewRead(m, t, signal).catch(() => null) : null;
      if (pv) { conn.reader = Object.assign({}, conn.reader, { via: "anteprima", pageError: String(e && e.message) }); return Object.assign(pv, { url: (e && e.url) || touchUrl(t), note: "Dall'anteprima del portale" }); }
      throw e;
    }
  }
  async function loadTouchPage(t, signal) {
    const m = currentModule();
    const fr = readerFrame();
    try {
      let url = touchUrl(t), how = url ? "indirizzo noto" : "";
      if (!url) {
        if (!m) throw new Error("Non trovo l'elenco «All tickets» del portale.");
        const got = await portalOpen(m, t, "intercept", fr);
        url = got.url; how = got.how + (got.posted ? " (modulo)" : "");
        if (!url && !got.posted) throw new Error(got.how ? "Il portale non ha aperto il ticket: usa «Apri in Touch»." : "Ticket non presente nell'elenco del portale: cercalo o aprilo con «Apri in Touch».");
      }
      if (url) { if (new URL(url).origin !== location.origin) throw Object.assign(new Error("La pagina del ticket è su un altro sito: aprila con «Apri in Touch»."), { url }); fr.src = url; }
      await waitFrame(fr, signal);
      const w = frameWin(fr);
      // schede interne non ancora disegnate (deferredRender): si aprono una per volta, poi si torna alla prima
      try {
        for (const tp of w.Ext.ComponentQuery.query("tabpanel")) {
          const cur = tp.getActiveTab();
          const todo = tp.items.getRange().filter((c) => !c.rendered);
          for (const c of todo.slice(0, 8)) { try { tp.setActiveTab(c); } catch { /* */ } }
          if (todo.length) { await sleep(300); await waitFrame(fr, signal); try { tp.setActiveTab(cur); } catch { /* */ } }
        }
      } catch { /* */ }
      const content = extractTicket(w);
      conn.reader = { at: new Date().toISOString(), how, url: url ? url.replace(/[?#].*$/, "") + (url.includes("?") ? "?…" : "") : null, tpl: touchTemplate() ? touchTemplate().field : null, ext: !!w.Ext, fields: content.fields.length, texts: content.texts.length, tables: content.tables.map((x) => x.rows.length), classes: (() => { try { return [...new Set(w.Ext.ComponentQuery.query("component").map((c) => c.xtype))].slice(0, 60); } catch { return null; } })() };
      return Object.assign(content, { url: url || touchUrl(t) });
    } finally {
      try { const w = frameWin(fr); if (w && w.Ext && w.Ext.Ajax && typeof w.Ext.Ajax.abortAll === "function") w.Ext.Ajax.abortAll(); } catch { /* */ }
      setTimeout(() => fr.remove(), 0);
    }
  }

  // ===================================================================== interfaccia
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    add(el, children);
    return el;
  }
  function add(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    }
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  function hl(text, words) {
    if (!text) return [""];
    if (!words || !words.length) return [text];
    const re = new RegExp(words.map(escRe).join("|"), "gi");
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))) { if (m.index > last) out.push(text.slice(last, m.index)); out.push(h("mark", null, m[0])); last = m.index + m[0].length; if (!m[0]) re.lastIndex++; }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  const CSS = `
:host{all:initial}
.ov{--bg:#f4f6f9;--sf:#fff;--sf2:#f0f3f7;--bd:#dde3ea;--bd2:#c3ccd7;--tx:#1c2430;--mu:#5d6b7c;--ac:#1f5fbf;--ac2:#194f9f;--acs:#e3edfb;--act:#fff;--mk:#fff1a8;--mkt:#2a2200;--wb:#fff6e0;--wbd:#f0cf7a;--wt:#5c4300;--er:#b42318;--eb:#fdecea;--ok:#13795b;--okb:#e3f4ec;--st:#e0a100;--sh:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
position:fixed;inset:0;z-index:2147483646;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased;text-align:left;color-scheme:light}
@media (prefers-color-scheme:dark){.ov{--bg:#0f141b;--sf:#161d26;--sf2:#1c2530;--bd:#2a3542;--bd2:#3a4757;--tx:#e4e9f0;--mu:#9aa8b8;--ac:#5b9bff;--ac2:#7aafff;--acs:#1b2b44;--act:#0b1220;--mk:#5a4a00;--mkt:#fff4c2;--wb:#2d2610;--wbd:#6b5617;--wt:#f3dc9b;--er:#ff8a80;--eb:#3a1714;--ok:#5fd3a5;--okb:#12322a;--st:#ffc940;--sh:0 1px 2px rgba(0,0,0,.4);color-scheme:dark}}
*{box-sizing:border-box}[hidden]{display:none!important}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}code{background:var(--sf2);padding:1px 5px;border-radius:4px}
h2{font-size:18px;margin:0 0 .6em}h3{font-size:14px;margin:0 0 .5em}
.mu{color:var(--mu)}.sm{font-size:12.5px}
input,select,textarea,button{font:inherit;color:inherit;margin:0}
input:not([type=checkbox]):not([type=file]),select,textarea{background:var(--sf);border:1px solid var(--bd2);border-radius:6px;padding:6px 9px;min-height:34px;width:100%}
textarea{resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
input:disabled,select:disabled{opacity:.55;background:var(--sf2);cursor:not-allowed}
.fld{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--mu)}.fld>*:not(span){color:var(--tx);font-size:14px}
.ck{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer}.ck input{width:16px;height:16px;accent-color:var(--ac)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--bd2);background:var(--sf);border-radius:6px;padding:6px 14px;min-height:34px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--sf2);text-decoration:none}.btn.pri{background:var(--ac);border-color:var(--ac);color:var(--act);font-weight:600}.btn.pri:hover{background:var(--ac2)}
.btn.gh{background:transparent;border-color:transparent;color:var(--ac)}.btn.gh:hover{background:var(--acs)}.btn.s{min-height:28px;padding:3px 9px;font-size:13px}.btn.dg{color:var(--er)}.btn:disabled{opacity:.55;cursor:default}
.ib{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:0;background:transparent;color:var(--mu);cursor:pointer;font-size:15px;line-height:1}.ib:hover{background:var(--sf2);color:var(--tx)}.ib.on{color:var(--st)}
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--acs);color:var(--ac);white-space:nowrap}.badge.cl{background:var(--okb);color:var(--ok)}.badge.pr{background:var(--sf2);color:var(--mu)}.badge.src{background:var(--wnb,#fff4d6);color:var(--wn,#7a5200)}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;box-shadow:var(--sh);padding:16px}.card+.card{margin-top:14px}
.top{display:flex;align-items:center;gap:16px;padding:8px 18px;background:var(--sf);border-bottom:1px solid var(--bd);flex:none}
#close{margin-left:auto}.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;white-space:nowrap}
.mark{width:26px;height:26px;border-radius:7px;background:var(--ac);position:relative;flex:none}.mark:before{content:"";position:absolute;left:6px;top:6px;width:10px;height:10px;border:2.5px solid #fff;border-radius:50%}.mark:after{content:"";position:absolute;left:17px;top:16px;width:6px;height:2.5px;background:#fff;transform:rotate(45deg);border-radius:2px}
.tabs{display:flex;gap:2px;flex:1;overflow-x:auto}.tabs button{border:0;background:transparent;padding:8px 12px;border-radius:6px;cursor:pointer;color:var(--mu);white-space:nowrap}.tabs button:hover{background:var(--sf2);color:var(--tx)}.tabs button[aria-current=page]{color:var(--ac);background:var(--acs);font-weight:600}
.cnt:not(:empty){font-size:11px;background:var(--sf2);border-radius:999px;padding:0 6px;margin-left:2px}
.body{flex:1;overflow:auto}.page{max-width:1440px;margin:0 auto;padding:16px 18px 60px}
.panel{display:flex;flex-direction:column;gap:12px}
.sbar{display:flex;gap:8px}.sbar input{min-height:44px;font-size:16px}.sbar .btn.pri{min-height:44px;padding:0 22px;font-size:15px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.between{justify-content:space-between}.end{justify-content:flex-end}
.quick{display:grid;grid-template-columns:170px 150px 150px 190px minmax(160px,1fr);gap:10px;align-items:end}
details.adv{border-top:1px solid var(--bd);padding-top:10px}details.adv summary{cursor:pointer;font-weight:600;color:var(--ac)}
.ag{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
fieldset{border:1px solid var(--bd);border-radius:8px;padding:10px 12px 12px;margin:0;display:flex;flex-direction:column;gap:9px;min-width:0}legend{font-weight:600;font-size:13px;padding:0 4px}.full{grid-column:1/-1}
.two{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px}
.tg{display:flex;flex-wrap:wrap;gap:5px}.tg button{border:1px solid var(--bd2);background:var(--sf);border-radius:999px;padding:3px 10px;cursor:pointer;font-size:12.5px}.tg button[aria-pressed=true]{background:var(--ac);border-color:var(--ac);color:var(--act);font-weight:600}
.qp{display:flex;align-items:center;gap:10px;background:var(--sf2);border-radius:8px;padding:6px 10px;flex-wrap:wrap}.qp code{flex:1;min-width:200px;background:transparent;padding:0;overflow-wrap:anywhere;white-space:pre-wrap;max-height:4.5em;overflow:auto;font-family:inherit;font-size:13px}
.note{font-size:12.5px;color:var(--wt);background:var(--wb);border:1px solid var(--wbd);border-radius:6px;padding:4px 9px}
.tree{border:1px solid var(--bd2);border-radius:6px;padding:6px;background:var(--sf);display:flex;flex-direction:column;gap:4px}.tree input{width:100%}
.tl{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto}.tl li{display:flex;align-items:center;gap:2px}.tl .tgl{width:22px;min-width:22px;height:22px;border:0;background:transparent;cursor:pointer;color:var(--mu);border-radius:4px;padding:0}
.tl .nm{border:0;background:transparent;text-align:left;padding:3px 6px;border-radius:4px;cursor:pointer;color:var(--tx);font:inherit;overflow-wrap:anywhere}.tl button.nm:hover{background:var(--acs)}.tl .nm.on{background:var(--acs);color:var(--ac);font-weight:600}.tl .nm.off{color:var(--mu)}
.srcs{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:8px}.srcs .srcn{font-weight:600}.pill{font-size:12px;border-radius:999px;padding:1px 8px;background:var(--sf2);color:var(--mu)}.pill.on{background:var(--okb);color:var(--ok)}.pill.wait{background:var(--wnb,#fff4d6);color:var(--wn,#7a5200)}
.lk,.lst{display:flex;flex-direction:column;gap:4px}.lst .tg{max-height:200px;overflow:auto}.yb span.ar{background:var(--wn,#b07a00);opacity:.75}
dialog.rd{width:min(980px,calc(100vw - 24px));max-width:none;height:min(90vh,1000px);padding:0;display:none;flex-direction:column}dialog.rd[open]{display:flex}
.rdh{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--bd)}.rdt{min-width:0;flex:1 1 300px}.rdt h3{margin:2px 0 0;font-size:16px;overflow-wrap:anywhere}
.rdb{overflow:auto;padding:12px 16px 20px;display:flex;flex-direction:column;gap:14px}.rdb h4{margin:0 0 4px;font-size:13px;color:var(--mu);text-transform:uppercase;letter-spacing:.03em}
.rdf{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:3px 14px;margin:0}.rdf dt{color:var(--mu);font-size:13px}.rdf dd{margin:0;overflow-wrap:anywhere}
.pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:8px 10px;line-height:1.5}
.rdtab{width:100%;border-collapse:collapse;font-size:13px}.rdtab th,.rdtab td{border-bottom:1px solid var(--bd);padding:5px 6px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}.rdtab th{color:var(--mu);font-weight:600}.rdtw{overflow:auto}
.ppl{display:flex;flex-direction:column;gap:8px}.pr{display:grid;grid-template-columns:230px minmax(0,1fr) auto;gap:8px;align-items:start}.pr .lb{font-size:13px;padding-top:6px}.pr .cv{display:flex;flex-direction:column;gap:4px;min-width:0}.pr .act{display:flex;gap:4px;flex-wrap:wrap}
.sug{list-style:none;margin:0;padding:4px;border:1px solid var(--bd2);border-radius:6px;background:var(--sf);max-height:220px;overflow:auto}.sug li button{width:100%;text-align:left;border:0;background:transparent;padding:5px 8px;border-radius:4px;cursor:pointer}.sug li button:hover{background:var(--acs)}
.yc{margin-bottom:10px;padding:12px 14px}.yc h3{margin:0 0 8px}.yr{display:grid;grid-template-columns:52px minmax(0,1fr) 110px auto;gap:8px;align-items:center;font-size:13px;padding:2px 0}.yr .yb{height:8px;background:var(--sf2);border-radius:4px;overflow:hidden;display:flex}.yr .yb span{display:block;height:100%;background:var(--ac)}.yr .yn{text-align:right;font-variant-numeric:tabular-nums}.yr.on b{color:var(--ac)}.yr.on .yb span{background:var(--st)}
.chip{display:inline-flex;align-items:center;gap:3px;background:var(--acs);color:var(--ac);border-radius:999px;padding:1px 4px 1px 9px;font-size:12.5px;font-weight:600}.chip button{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 3px;font-size:14px;line-height:1;border-radius:50%}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips:empty{display:none}
.tips{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:var(--mu)}.tips b{color:var(--tx)}
.res-grid{display:grid;grid-template-columns:250px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}
.facets{position:sticky;top:0;padding:12px;display:flex;flex-direction:column;gap:16px;max-height:calc(100vh - 90px);overflow:auto}
.facet h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu);margin-bottom:6px}.facet ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.facet li button{width:100%;display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;border:0;background:transparent;text-align:left;padding:4px 6px;border-radius:5px;cursor:pointer;font-size:13px;position:relative}
.facet li button:hover{background:var(--sf2)}.facet li button[aria-pressed=true]{background:var(--acs);color:var(--ac);font-weight:600}.facet .n{color:var(--mu);font-size:12px}
.facet li button .fill{position:absolute;left:0;top:2px;bottom:2px;background:var(--acs);border-radius:4px}.facet li button>span:not(.fill){position:relative;overflow-wrap:anywhere}.facet li button[aria-pressed=true] .fill{background:transparent}
.prog{padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px}.bar{flex:1;height:6px;background:var(--sf2);border-radius:3px;overflow:hidden}.bar span{display:block;height:100%;width:30%;background:var(--ac);animation:ind 1.1s infinite ease-in-out}@keyframes ind{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
.alert{border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:13.5px;display:flex;flex-direction:column;gap:4px;background:var(--wb);border:1px solid var(--wbd);color:var(--wt)}.alert.err{background:var(--eb);border-color:var(--er);color:var(--er)}
.sum{margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.tb{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.tb .rf{flex:1;min-width:220px;width:auto}.tb select{width:auto}
.menu{position:relative}.ml{position:absolute;right:0;top:calc(100% + 4px);z-index:5;background:var(--sf);border:1px solid var(--bd2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:4px;display:flex;flex-direction:column;min-width:190px}.ml button{border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:5px;cursor:pointer}.ml button:hover{background:var(--acs)}
.list{display:flex;flex-direction:column;gap:8px}.gt{font-size:12.5px;font-weight:700;color:var(--mu);text-transform:uppercase;letter-spacing:.05em;margin:10px 2px 0;display:flex;gap:8px}
.res{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:10px 14px;display:flex;flex-direction:column;gap:4px}.res.sel{border-color:var(--ac);box-shadow:0 0 0 1px var(--ac) inset}
.rh{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}.rh input[type=checkbox]{width:16px;height:16px;accent-color:var(--ac)}.num{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:13.5px}.sp{flex:1}
.subj{font-size:15.5px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}.snip{color:var(--mu);font-size:13.5px;overflow-wrap:anywhere;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.snip.rs{-webkit-line-clamp:2}.snip b{color:var(--tx);font-weight:600}
.meta{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--mu)}.meta b{font-weight:600;color:var(--tx)}.tag{background:var(--sf2);border:1px solid var(--bd);border-radius:999px;padding:0 8px}.nt{font-style:italic;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--tx)}
details.cols summary{cursor:pointer;font-size:12.5px;color:var(--ac)}details.cols dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 12px;margin:6px 0 0;font-size:12.5px}details.cols dt{color:var(--mu)}details.cols dd{margin:0;overflow-wrap:anywhere}
mark{background:var(--mk);color:var(--mkt);border-radius:2px;padding:0 1px}
.pager{display:flex;gap:4px;justify-content:center;margin-top:14px;flex-wrap:wrap}.pager button{min-width:34px;height:32px;border:1px solid var(--bd);background:var(--sf);border-radius:6px;cursor:pointer;padding:0 8px}.pager button[aria-current=page]{background:var(--ac);color:var(--act);border-color:var(--ac);font-weight:600}.pager button:disabled{opacity:.45}
.li{display:flex;align-items:center;gap:12px;padding:10px 4px;border-top:1px solid var(--bd);flex-wrap:wrap}.li:first-child{border-top:0}.li .m{flex:1;min-width:200px}.li .t{font-weight:600;overflow-wrap:anywhere}.li .s{font-size:12.5px;color:var(--mu);overflow-wrap:anywhere}.empty{color:var(--mu);padding:18px 4px}
.pre{background:var(--sf2);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;margin:10px 0 0}
dialog{border:1px solid var(--bd2);border-radius:12px;padding:20px;width:min(480px,calc(100vw - 32px));background:var(--sf);color:var(--tx);box-shadow:0 20px 50px rgba(0,0,0,.25)}dialog::backdrop{background:rgba(10,15,25,.45)}dialog form{display:flex;flex-direction:column;gap:10px}dialog h3{margin:0;font-size:16px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--tx);color:var(--bg);padding:9px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:13.5px;z-index:3;max-width:min(680px,calc(100vw - 32px))}
@media (max-width:1100px){.quick{grid-template-columns:repeat(3,minmax(0,1fr))}.quick>:nth-child(4),.quick>:nth-child(5){grid-column:span 3}}
@media (max-width:820px){.pr{grid-template-columns:1fr}.res-grid{grid-template-columns:1fr}.facets{position:static;flex-direction:row;flex-wrap:wrap;max-height:none}.facet{flex:1 1 200px}.ag,.two{grid-template-columns:1fr}.top{flex-wrap:wrap;gap:8px}.tabs{order:3;flex-basis:100%}}
@media (max-width:560px){.quick{grid-template-columns:1fr 1fr}.quick>:nth-child(1),.quick>:nth-child(4),.quick>:nth-child(5){grid-column:span 2}}
`;

  const MARKUP = `
<div class="ov" role="dialog" aria-label="Ricerca TKT" aria-modal="true">
 <header class="top">
  <div class="brand"><span class="mark" aria-hidden="true"></span>Ricerca TKT</div>
  <nav class="tabs" id="nav">
   <button type="button" data-tab="search" aria-current="page">Cerca</button>
   <button type="button" data-tab="saved">Salvate</button>
   <button type="button" data-tab="history">Cronologia</button>
   <button type="button" data-tab="favorites">Preferiti <span class="cnt" id="fav-count"></span></button>
   <button type="button" data-tab="settings">Impostazioni</button>
  </nav>
  <button type="button" class="btn gh s" id="close" title="Chiudi (Esc): torni al portale">Chiudi ✕</button>
 </header>
 <div class="body" id="scroller"><div class="page">
  <section id="tab-search">
   <form id="sf" class="card panel" autocomplete="off">
    <div class="sbar"><input id="q" type="search" placeholder="Cerca nei ticket… es. detassazione premio" aria-label="Testo da cercare" spellcheck="false" list="hist-list"><datalist id="hist-list"></datalist><button type="submit" class="btn pri" id="go">Cerca</button></div>
    <div class="quick">
     <label class="fld">Data di apertura<select id="preset"><option value="">Qualsiasi</option><option value="30d">Ultimi 30 giorni</option><option value="3m">Ultimi 3 mesi</option><option value="6m">Ultimi 6 mesi</option><option value="1y">Ultimi 12 mesi</option><option value="ytd">Anno corrente</option><option value="py">Anno scorso</option><option value="2y">Ultimi 2 anni</option><option value="5y">Ultimi 5 anni</option><option value="custom">Personalizzato</option></select></label>
     <label class="fld">Dal<input type="date" id="dfrom"></label>
     <label class="fld">Al<input type="date" id="dto"></label>
     <label class="fld">Stato<select id="st"><option value="all">Tutti gli stati</option><option value="open">Aperti</option><option value="closed">Chiusi e risolti</option><option value="custom">Scegli…</option><option value="page">Come nella pagina</option></select></label>
     <label class="fld">Massimo ticket<select id="capq" title="Righe chieste al portale in una ricerca (le più recenti)"><option>50</option><option>100</option><option>200</option><option>500</option></select></label>
    </div>
    <div class="srcs" id="srcs"><span class="mu sm">Dove cercare:</span><span class="srcn">Portale Touch</span><label class="ck"><input type="checkbox" id="src-ar"> anche nell'Area Riservata <span class="mu sm">(vecchia Ricerca rapida, altri ticket)</span></label><span id="ar-state" class="pill"></span><button type="button" class="btn gh s" id="ar-connect">Collega l'Area Riservata</button></div>
    <div id="ar-help" class="note" hidden></div>
    <details class="adv" id="adv"><summary>Opzioni avanzate <span class="mu sm" id="adv-n"></span></summary>
     <div class="ag">
      <fieldset><legend>Testo</legend>
       <label class="fld">L'oggetto contiene<input id="subject" placeholder="es. conguaglio"></label>
       <label class="fld">Escludi parole (sui risultati)<input id="exclude" placeholder='es. storno "cassa integrazione"'></label>
       <label class="ck"><input type="checkbox" id="allw"> Tutte le parole cercate devono comparire in oggetto, richiesta o soluzione (verifica sui risultati)</label>
      </fieldset>
      <fieldset><legend>Ultimo aggiornamento e classificazione</legend>
       <div class="two"><label class="fld">Aggiornato dal<input type="date" id="ufrom"></label><label class="fld">Aggiornato al<input type="date" id="uto"></label></div>
       <div class="two"><label class="fld">Classificazione (testo)<input id="classif" placeholder="es. Normativa"></label><label class="fld">Classificazione cliente (testo)<input id="classcli"></label></div>
      </fieldset>
      <fieldset class="full" id="st-box" hidden><legend>Stati</legend><div class="tg" id="st-list"></div><div class="row"><button type="button" class="btn gh s" data-sel="st:all">Tutti</button><button type="button" class="btn gh s" data-sel="st:open">Solo aperti</button><button type="button" class="btn gh s" data-sel="st:closed">Solo chiusi</button><button type="button" class="btn gh s" data-sel="st:none">Nessuno</button></div></fieldset>
      <fieldset class="full"><legend>Priorità <span class="mu sm">(nessuna scelta = tutte)</span></legend><div class="tg" id="pr-list"></div></fieldset>
      <fieldset class="full" id="ppl-box"><legend>Gruppi e persone <span class="mu sm">(filtri del portale, su tutti i ticket)</span></legend><div class="ppl" id="ppl"></div>
       <p class="mu sm" style="margin:0">Apri l'elenco con <b>Scegli…</b> (o scrivi un nome) e scegli: il filtro vale nel portale su tutti i ticket. <b>Menu del portale</b> resta disponibile se un campo non si lascia impostare da qui.</p></fieldset>
      <fieldset class="full" id="pf-box"><legend>Altri filtri del portale</legend><div class="ppl" id="pf"></div>
       <p class="mu sm" style="margin:0">Servizio, Sede, Contatto, Etichette e gli altri filtri dell'elenco All tickets: si scelgono qui e restano nelle ricerche salvate.</p></fieldset>
     </div>
    </details>
    <div class="qp"><span class="mu sm">Filtri inviati al portale</span><code id="qprev"></code>
     <div class="row" style="gap:2px"><button type="button" class="btn gh s" id="qsave">Salva ricerca</button><button type="button" class="btn gh s" id="qreset">Azzera</button><button type="button" class="btn gh s" id="qrestore" hidden title="Rimette nell'elenco del portale i filtri e le righe per pagina che c'erano prima della prima ricerca">Ripristina il portale</button></div></div>
    <div id="qwarn" class="list" style="gap:4px"></div>
   </form>
   <div id="emptyst" class="card" style="margin-top:16px"><h2>Come cercare</h2><ul class="tips">
    <li>Il testo va nel campo <b>Search</b> dell'elenco del portale, insieme a periodo, stato e gli altri filtri: la ricerca la fa il portale, sui suoi dati aggiornati. Chiudendo il pannello l'elenco del portale mostra la stessa ricerca; <b>Ripristina il portale</b> rimette i filtri di prima.</li>
    <li>Per i ticket storici lascia <b>Tutti gli stati</b> (la pagina del portale di solito mostra solo quelli aperti).</li>
    <li>La ricerca è su <b>tutti i ticket</b> (elenco All tickets), ma il portale li ordina per data: arrivano i <b class="capn">200</b> più recenti. Se il portale ne ha di più, <b>Quanti per anno?</b> mostra la distribuzione su tutti gli anni e con un clic cerchi in un anno solo.</li>
    <li>In <b>Opzioni avanzate</b> ci sono tutti i filtri del portale: gruppi e persone (Assegnato a, Gruppo proprietario, Modificato da, Responsabile, con <b>Io</b> e <b>Il mio gruppo</b>), Servizio, Sede, Contatto, Etichette… Valgono su tutti i ticket e restano nelle ricerche salvate.</li>
    <li>Con <b>Collega l'Area Riservata</b> si cerca anche nella vecchia Ricerca rapida (altri ticket): si apre in una nuova scheda, lì si preme il segnalibro e si conferma.</li>
    <li><b>Leggi</b> mostra il ticket completo nel pannello (richiesta, soluzione, messaggi); <b>Apri in Touch</b> apre la sua pagina nel portale. <kbd>/</kbd> per cercare, <kbd>Esc</kbd> per tornare al portale, un altro clic sul segnalibro per riaprire.</li></ul></div>
   <div id="results" class="res-grid" hidden>
    <aside class="card facets" id="facets"></aside>
    <div>
     <div class="card prog" id="prog" hidden><div class="bar"><span></span></div><span class="sm" id="progt">Ricerca in corso…</span><button type="button" class="btn gh s" id="stop">Interrompi</button></div>
     <div id="alert" class="alert" hidden></div>
     <div id="years" class="card yc" hidden></div>
     <div class="sum" id="sum"></div>
     <div class="tb">
      <input id="refine" class="rf" type="search" placeholder='Filtra nei risultati… (parole, -escludi, "frase")'>
      <select id="sort" aria-label="Ordinamento"><option value="rank">Ordine del portale</option><option value="date_desc">Apertura: più recenti</option><option value="date_asc">Apertura: meno recenti</option><option value="upd_desc">Ultimo aggiornamento</option><option value="code_desc">ID: decrescente</option><option value="code_asc">ID: crescente</option><option value="subject">Oggetto A→Z</option><option value="status">Stato</option></select>
      <select id="group" aria-label="Raggruppamento"><option value="none">Nessun raggruppamento</option><option value="status">Per stato</option><option value="service">Per servizio</option><option value="site">Per sede</option><option value="group">Per gruppo</option><option value="assigned">Per assegnatario</option><option value="owner">Per responsabile</option><option value="priority">Per priorità</option><option value="month">Per mese</option><option value="year">Per anno</option></select>
      <select id="psize" aria-label="Risultati per pagina"><option>25</option><option selected>50</option><option>100</option><option>250</option></select>
      <div class="menu"><button type="button" class="btn gh s" id="exp">Esporta ▾</button><div class="ml" id="expm" hidden><button type="button" data-x="csv">CSV (Excel)</button><button type="button" data-x="json">JSON</button><button type="button" data-x="codes">Copia ID ticket</button><button type="button" data-x="list">Copia elenco</button></div></div>
      <label class="ck sm"><input type="checkbox" id="selall"> Seleziona pagina</label>
     </div>
     <div id="active" class="chips" style="margin-bottom:8px"></div>
     <div id="list" class="list"></div>
     <nav id="pager" class="pager"></nav>
    </div>
   </div>
  </section>
  <section id="tab-saved" hidden><div class="card"><h2>Ricerche salvate</h2><div id="saved"></div></div></section>
  <section id="tab-history" hidden><div class="card"><div class="row between"><h2>Cronologia</h2><button type="button" class="btn gh s" id="hclear">Svuota cronologia</button></div><div id="hist"></div></div></section>
  <section id="tab-favorites" hidden><div class="card"><div class="row between"><h2>Preferiti</h2><div class="row"><input id="ffilter" type="search" placeholder="Filtra per testo o etichetta…" style="width:260px"><button type="button" class="btn gh s" id="fexp">Esporta CSV</button></div></div><div id="favs" class="list"></div></div></section>
  <section id="tab-settings" hidden>
   <div class="card"><h2>Collegamento al portale</h2><pre class="pre mono" id="conninfo"></pre>
    <div class="row" style="margin-top:10px"><button type="button" class="btn" id="tread">Leggi l'elenco attuale della pagina</button><button type="button" class="btn" id="tcopy">Copia dati tecnici</button><button type="button" class="btn gh" id="tdl">Scarica dati tecnici</button></div>
    <pre class="pre mono" id="treadout" hidden></pre>
    <p class="mu sm">I dati tecnici servono a correggere il collegamento se qualcosa non va: descrivono l'elenco del portale (colonne, filtri, richieste inviate) senza cookie né token; nomi e testi sono sostituiti da «N car.». Controllali comunque prima di condividerli.</p></div>
   <div class="card"><h2>Risultati</h2><div class="row"><label class="fld" style="max-width:320px">Massimo ticket per ricerca (anche nella scheda Cerca)<select id="s-cap"><option>50</option><option>100</option><option>200</option><option>500</option></select></label></div>
    <p class="mu sm">È il numero di righe chieste al portale in una sola richiesta (la pagina ne mostra 50 alla volta). Valori più bassi sono più leggeri per il portale; dai risultati si possono caricare i successivi.</p></div>
   <div class="card"><h2>Area Riservata</h2><div class="row"><label class="fld" style="flex:1 1 420px">Indirizzo della Ricerca rapida dell'Area Riservata<input id="s-arurl" type="url" spellcheck="false"></label></div>
    <p class="mu sm">Con «Collega l'Area Riservata» (scheda Cerca) questa pagina si apre in una nuova scheda: lì si preme il segnalibro e si conferma. Da quel momento le ricerche cercano anche lì (solo testo, oggetto e periodo: gli altri filtri esistono solo nel portale Touch). La sua scheda va lasciata aperta.</p></div>
   <div class="card"><h2>Dati personali</h2><p class="mu sm">Preferiti, note, ricerche salvate e cronologia sono salvati solo in questo browser.</p>
    <div class="row"><button type="button" class="btn" id="pexp">Esporta</button><label class="btn">Importa<input type="file" id="pimp" accept="application/json,.json" hidden></label><button type="button" class="btn gh dg" id="pdel">Cancella tutto</button></div></div>
   <div class="row end" style="margin-top:14px"><button type="button" class="btn pri" id="ssave">Salva impostazioni</button></div>
   <p class="mu sm">Ricerca TKT ${VERSION} · versione segnalibro per il portale ticket</p>
  </section>
 </div></div>
 <dialog id="dnote"><form method="dialog"><h3 id="ntitle">Nota</h3><label class="fld">Nota personale<textarea id="ntext" rows="5"></textarea></label><label class="fld">Etichette (separate da virgola)<input id="ntags" placeholder="es. da verificare, normativa"></label><div class="row end"><button type="button" value="cancel" class="btn gh">Annulla</button><button type="button" value="remove" class="btn gh dg" id="nrem">Rimuovi dai preferiti</button><button value="ok" class="btn pri">Salva</button></div></form></dialog>
 <dialog id="dread" class="rd" aria-labelledby="rtitle"><div class="rdh"><div class="rdt"><span class="mu sm" id="rsrc"></span><h3 id="rtitle"></h3></div><div class="row"><a id="rlink" class="btn s pri" target="_blank" rel="noopener" hidden>Apri in Touch ↗</a><button type="button" class="btn s" id="ropen" hidden>Apri in Touch ↗</button><button type="button" class="btn s gh" id="rcopy">Copia testo</button><button type="button" class="btn s gh" id="rclose">Chiudi</button></div></div><div id="rbody" class="rdb"></div></dialog>
 <dialog id="dsave"><form method="dialog"><h3>Salva ricerca</h3><label class="fld">Nome<input id="sname" maxlength="200"></label><div class="row end"><button type="button" value="cancel" class="btn gh">Annulla</button><button value="ok" class="btn pri">Salva</button></div></form></dialog>
 <div class="toast" id="toast" role="status" hidden></div>
</div>`;

  const host = document.createElement("div");
  host.id = "ricerca-tkt-host";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);
  const tpl = document.createElement("template");
  tpl.innerHTML = MARKUP; // markup costante, nessun dato esterno
  root.appendChild(tpl.content);
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const prevOverflow = document.documentElement.style.overflow;
  const prevInert = !!(document.body && document.body.inert);

  // ===================================================================== stato
  const emptyFacets = () => ({ source: new Set(), status: new Set(), priority: new Set(), service: new Set(), group: new Set(), assigned: new Set(), owner: new Set(), modifiers: new Set(), site: new Set(), year: null, month: null, tags: new Set() });
  const S = {
    results: [], keys: new Set(), facet: emptyFacets(), refine: "", sort: "rank", group: "none", page: 1, size: 50,
    selected: new Set(), searching: false, abort: null, last: null, words: [], alerts: [], visible: [], pageItems: [],
    favorites: new Map(), info: null, modules: [], stCodes: new Set(), prCodes: new Set(), snaps: {}, years: null, opening: null,
  };
  for (const f of store.get("favorites", [])) if (f && f.key) S.favorites.set(f.key, f);
  const saveFavs = () => store.set("favorites", [...S.favorites.values()].map((f) => Object.assign({}, f, { ticket: clean(f.ticket) })));

  let toastT = 0;
  function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:0";
      root.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch { /* */ } ta.remove();
    }
    if (msg !== null) toast(msg || "Copiato negli appunti");
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = h("a", { href: url, download: name });
    root.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // ===================================================================== modulo di ricerca
  function currentModule() {
    S.modules = findModules();
    return S.modules.find((m) => m.store && isAllList(m)) || null;
  }
  // Se l'elenco All tickets non esiste ancora (scheda mai aperta) apre la scheda e aspetta che compaia.
  function ensureAllTickets() {
    const m = currentModule();
    if (m) return Promise.resolve(m);
    if (S.opening) return S.opening;
    const tab = allTab();
    if (!tab) return Promise.resolve(null);
    S.opening = (async () => {
      const was = !!(document.body && document.body.inert);
      try {
        if (document.body) document.body.inert = false;
        const bar = tab.t.ownerCt;
        const tp = (bar && bar.tabPanel) || (tab.card && typeof tab.card.up === "function" ? tab.card.up("tabpanel") : null);
        if (tp && tab.card && typeof tp.setActiveTab === "function") tp.setActiveTab(tab.card);
        else if (tab.t.el && tab.t.el.dom) tab.t.el.dom.click();
      } catch { /* */ } finally { if (document.body) document.body.inert = was; }
      await waitUntil(() => !!currentModule(), 10000);
      return currentModule();
    })();
    S.opening.finally(() => { S.opening = null; });
    return S.opening;
  }
  function renderToggles() {
    const m = currentModule();
    renderPeople(m);
    const stOpts = m ? comboOptions(m.field("StatusFilter")) : [];
    const prOpts = m ? comboOptions(m.field("PriorityFilter")) : [];
    S.stOpts = stOpts;
    const stl = clear($("#st-list"));
    for (const [v, t] of stOpts) stl.appendChild(h("button", { type: "button", "aria-pressed": String(S.stCodes.has(v)), "data-v": v, onclick: (e) => { if (S.stCodes.has(v)) S.stCodes.delete(v); else S.stCodes.add(v); e.currentTarget.setAttribute("aria-pressed", String(S.stCodes.has(v))); onFormChange(); } }, t));
    if (!stOpts.length) stl.appendChild(h("span", { class: "mu sm", text: "Elenco degli stati non disponibile nella pagina." }));
    const prl = clear($("#pr-list"));
    for (const [v, t] of prOpts) prl.appendChild(h("button", { type: "button", "aria-pressed": String(S.prCodes.has(v)), onclick: (e) => { if (S.prCodes.has(v)) S.prCodes.delete(v); else S.prCodes.add(v); e.currentTarget.setAttribute("aria-pressed", String(S.prCodes.has(v))); onFormChange(); } }, t));
    if (!prOpts.length) prl.appendChild(h("span", { class: "mu sm", text: "Filtro priorità non disponibile nella pagina." }));
    $("#st").querySelectorAll("option").forEach((o) => { o.disabled = !stOpts.length && !["all", "page"].includes(o.value); });
    if (!stOpts.length && !["all", "page"].includes($("#st").value)) $("#st").value = "all";
    $("#st-box").hidden = $("#st").value !== "custom";
    renderKept(m);
  }
  // durante una ricerca, un conteggio o un caricamento i filtri della pagina non si toccano
  const busy = () => { if (!S.searching) return false; toast("Attendi la fine della ricerca o premi Interrompi"); return true; };
  // ---- filtri del portale nel pannello: gruppi e persone, poi tutti gli altri (Servizio, Sede, Contatto...)
  const openTrees = new Set(); // alberi aperti nel pannello: restano aperti quando il pannello si ridisegna
  const openNodes = new Map(); // per campo: rami aperti dell'albero
  function changePf(m, fn) {
    if (busy()) return false;
    ensureSnapshot(m);
    try { return !!fn(); } catch { return false; }
  }
  function afterPf() { renderFilters(currentModule()); previewNow(); advCount(); }
  function renderFilters(m) {
    const fields = m ? pfFields(m) : [];
    const people = fields.filter((x) => PEOPLE_KEYS.has(x.suffix)), others = fields.filter((x) => !PEOPLE_KEYS.has(x.suffix));
    const fill = (box, list) => { clear(box); for (const x of list) box.appendChild(filterRow(m, x)); };
    fill($("#ppl"), people); $("#ppl-box").hidden = !people.length;
    fill($("#pf"), others); $("#pf-box").hidden = !others.length;
  }
  const renderPeople = renderFilters;
  // utente collegato e suo gruppo predefinito (Portal.Const del portale): scelte rapide «Io» e «Il mio gruppo»
  function me() {
    try {
      const C = window.Portal && window.Portal.Const;
      if (!C) return null;
      const u = C.TypedLoggedUser || C.LoggedUser || {};
      const H = C.HDAUser || {};
      const id = u.ID || u.Id || u.UserID || H.UserID || "";
      return { id: String(id || ""), name: textOf(String(u.Name || u.Description || u.FullName || "")), group: String(H.DefaultUserGroupID || ""), groupName: textOf(String(H.DefaultUserGroupDescription || H.DefaultUserGroupName || "")) };
    } catch { return null; }
  }
  const ME_FIELDS = new Set(["AssignedUserOrGroupFilter", "ModifiedBy", "OwnerUserID"]);
  const MYGROUP_FIELDS = new Set(["AssignedUserOrGroupFilter", "OwnerUserGroupID"]);
  function filterRow(m, x) {
    const { suffix, f, kind, label } = x;
    const cur = pfValue(f, kind);
    const multiList = kind === "list" && isMulti(f);
    const cv = h("div", { class: "cv" });
    const act = h("div", { class: "act" });
    if (cur && !multiList && kind !== "text" && kind !== "date") {
      cv.appendChild(h("span", { class: "chips" }, h("span", { class: "chip" }, cur.t, h("button", { type: "button", "aria-label": `Togli ${label}`, title: "Togli il filtro", onclick: () => { if (changePf(m, () => { clearField(f); return true; })) afterPf(); } }, "×"))));
    } else if (!cur && (kind === "tree" || kind === "remote" || kind === "treemenu")) cv.appendChild(h("span", { class: "mu sm", style: "padding-top:6px" }, "qualsiasi"));
    if (kind === "remote") cv.appendChild(lookupEditor(m, f, label, suffix, !!cur));
    else if (kind === "list") cv.appendChild(listEditor(m, f, label, suffix));
    else if (kind === "date") {
      const inp = h("input", { type: "date", value: cur ? cur.v : "", "aria-label": label, "data-pfd": suffix });
      inp.addEventListener("change", () => { if (changePf(m, () => setPf(f, inp.value ? { v: inp.value } : null, kind))) afterPf(); else { toast("Il portale non ha accettato la data"); afterPf(); } });
      cv.appendChild(inp);
    } else if (kind === "text") {
      const inp = h("input", { type: "text", value: cur ? cur.v : "", "aria-label": label, "data-pft": suffix, placeholder: "qualsiasi" });
      inp.addEventListener("change", () => { if (changePf(m, () => setPf(f, inp.value.trim() ? { v: inp.value.trim() } : null, kind))) afterPf(); });
      cv.appendChild(inp);
    } else if (kind === "tree") {
      act.appendChild(h("button", { type: "button", class: "btn s", "aria-expanded": String(openTrees.has(suffix)), "data-pftree": suffix, onclick: () => {
        if (openTrees.has(suffix)) openTrees.delete(suffix); else openTrees.add(suffix);
        renderFilters(currentModule());
      } }, openTrees.has(suffix) ? "Chiudi l'elenco" : "Scegli…"));
      if (openTrees.has(suffix)) cv.appendChild(treeBrowser(m, f, label, suffix));
    }
    const who = me();
    const quick = (v, t, text) => act.appendChild(h("button", { type: "button", class: "btn gh s", title: t, "data-quick": text, onclick: () => {
      if (changePf(m, () => setPerson(f, { v, t }))) afterPf(); else if (!S.searching) toast("Il portale non ha accettato il valore");
    } }, text));
    if (who && who.id && ME_FIELDS.has(suffix) && (!cur || cur.v !== who.id)) quick(who.id, who.name || "Io", "Io");
    if (who && who.group && MYGROUP_FIELDS.has(suffix) && (!cur || cur.v !== who.group)) quick(who.group, who.groupName || "Il mio gruppo", "Il mio gruppo");
    if (kind === "tree" || kind === "treemenu" || kind === "remote") {
      act.appendChild(h("button", { type: "button", class: kind === "treemenu" ? "btn s" : "btn gh s", title: "Scegli con il menu del portale: il pannello si nasconde e si riapre dopo la scelta", onclick: () => { if (!busy()) pickInPortal(m, f, label); } }, kind === "treemenu" ? "Scegli nel portale…" : "Menu del portale"));
    }
    return h("div", { class: "pr", "data-pf": suffix }, h("span", { class: "lb" }, label), cv, act);
  }
  // ricerca del nome nel portale mentre si scrive (campi con ricerca sul server: persone, sedi, contatti...)
  function lookupEditor(m, f, label, suffix, has) {
    const wrap = h("div", { class: "lk" });
    const sug = h("ul", { class: "sug", hidden: true });
    const inp = h("input", { type: "search", placeholder: has ? "Cambia: scrivi un nome…" : "Scrivi almeno 2 lettere…", "aria-label": `Cerca ${label}`, "data-pfq": suffix, "data-ppl": suffix });
    let seq = 0;
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const b = sug.querySelector("button");
      if (b) b.click();
    });
    inp.addEventListener("input", debounce(async () => {
      const q = inp.value.trim();
      const my = ++seq;
      clear(sug); sug.hidden = q.length < 2;
      if (q.length < 2) return;
      sug.appendChild(h("li", { class: "mu sm", text: "Cerco nel portale…" }));
      let list = [];
      try { list = await queryField(f, q); } catch { list = []; }
      if (my !== seq) return;
      clear(sug);
      if (!list.length) sug.appendChild(h("li", { class: "mu sm", text: "Nessun risultato" }));
      for (const it of list.slice(0, 30)) sug.appendChild(h("li", null, h("button", { type: "button", onclick: () => {
        const ok = changePf(m, () => (it.r ? pickRecord(f, it.r) : setPerson(f, { v: it.v, t: it.t })));
        if (!ok && !S.searching) toast("Il portale non ha accettato il valore: usa «Menu del portale»");
        afterPf();
      } }, it.t)));
    }, 350));
    wrap.append(inp, sug);
    return wrap;
  }
  // scelte già presenti nella pagina (elenco del campo): pulsanti da premere, con ricerca se sono tante
  function listEditor(m, f, label, suffix) {
    const opts = comboOptions(f);
    const multi = isMulti(f);
    const cur = new Set(multi ? asList(f.getValue()) : [(personValue(f) || {}).v].filter(Boolean));
    const wrap = h("div", { class: "lst" });
    const box = h("div", { class: "tg", "data-pfl": suffix });
    const q = opts.length > 12 ? h("input", { type: "search", placeholder: `Cerca tra ${opts.length} voci…`, "aria-label": `Cerca in ${label}` }) : null;
    const draw = () => {
      clear(box);
      const n = q ? norm(q.value.trim()) : "";
      const shown = opts.filter(([v, t]) => cur.has(v) || !n || norm(t).includes(n));
      for (const [v, t] of shown.slice(0, 60)) box.appendChild(h("button", { type: "button", "aria-pressed": String(cur.has(v)), "data-v": v, onclick: () => {
        const next = new Set(cur);
        if (next.has(v)) next.delete(v); else { if (!multi) next.clear(); next.add(v); }
        const ok = changePf(m, () => (multi ? setMulti(f, [...next]) : next.size ? setPerson(f, { v, t }) : (clearField(f), true)));
        if (!ok && !S.searching) toast("Il portale non ha accettato il valore");
        afterPf();
      } }, t));
      if (shown.length > 60) box.appendChild(h("span", { class: "mu sm", text: `… altre ${shown.length - 60}: restringi la ricerca` }));
      if (!shown.length) box.appendChild(h("span", { class: "mu sm", text: "Nessuna voce" }));
    };
    if (q) { q.addEventListener("input", debounce(draw, 150)); wrap.appendChild(q); }
    wrap.appendChild(box);
    draw();
    return wrap;
  }
  // ---- elenco ad albero del campo (tree-field): rami caricati dal portale quando si aprono
  const nodeText = (f, n) => { try { return textOf(String(n.get("text") ?? n.get(f.displayField || "text") ?? n.getId())); } catch { return ""; } };
  const nodeValue = (f, n) => { try { const v = f.valueField && f.valueField !== "id" ? n.get(f.valueField) : null; return String(v ?? n.getId()); } catch { return ""; } };
  const selectable = (n) => { try { return n.get("selectable") !== false && !n.get("disabled") && !n.isRoot(); } catch { return true; } };
  // carica i figli di un ramo senza aprirlo (store.load({node}) + flushLoad: due load nello stesso momento si perderebbero)
  function expandNode(n, st) {
    return new Promise((res) => {
      try { if (!n || n.isLeaf() || (n.isLoaded() && (n.childNodes.length || !n.isRoot()))) return res(); } catch { return res(); }
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      setTimeout(fin, 10000);
      try {
        const ts = st || (typeof n.getTreeStore === "function" ? n.getTreeStore() : null);
        const root = ts && typeof ts.getRootNode === "function" ? ts.getRootNode() : null;
        // mentre si carica la radice Ext ignora le richieste dei rami (TreeStore.load): si aspetta
        if (root && root !== n && root.isLoading && root.isLoading()) {
          const t = setInterval(() => { if (!root.isLoading()) { clearInterval(t); done = true; expandNode(n, ts).then(res); } }, 100);
          return;
        }
        if (ts && typeof ts.load === "function" && !n.isLoading()) {
          ts.load({ node: n, callback: fin });
          if (typeof ts.flushLoad === "function") ts.flushLoad();
        } else if (n.isLoading && n.isLoading()) { const t = setInterval(() => { if (!n.isLoading()) { clearInterval(t); fin(); } }, 100); } else n.expand(false, fin);
      } catch { try { n.expand(false, fin); } catch { fin(); } }
    });
  }
  function treeBrowser(m, f, label, suffix) {
    const st = treeStoreOf(f);
    const open = openNodes.get(suffix) || new Set();
    openNodes.set(suffix, open);
    const wrap = h("div", { class: "tree", "data-tree": suffix });
    const q = h("input", { type: "search", placeholder: "Cerca un nome…", "aria-label": `Cerca in ${label}` });
    const note = h("div", { class: "mu sm" });
    const list = h("ul", { class: "tl" });
    wrap.append(q, note, list);
    let alive = true, deep = null;
    const curV = (pfValue(f, "tree") || {}).v;
    const pick = (n) => {
      const ok = changePf(m, () => setPerson(f, { v: nodeValue(f, n), t: nodeText(f, n) }));
      if (!ok) { if (!S.searching) toast("Il portale non ha accettato il valore: usa «Menu del portale»"); return; }
      alive = false; openTrees.delete(suffix); afterPf();
    };
    const row = (n, depth, path) => {
      const leaf = (() => { try { return n.isLeaf(); } catch { return true; } })();
      const id = String(n.getId());
      const isOpen = open.has(id);
      const li = h("li", { style: `padding-left:${depth * 16}px` });
      li.appendChild(leaf ? h("span", { class: "tgl" }) : h("button", { type: "button", class: "tgl", "aria-expanded": String(isOpen), "aria-label": `${isOpen ? "Chiudi" : "Apri"} ${nodeText(f, n)}`, onclick: async () => {
        if (isOpen) open.delete(id); else { open.add(id); note.textContent = "Carico dal portale…"; await expandNode(n, st); note.textContent = ""; }
        draw();
      } }, isOpen ? "▾" : "▸"));
      const name = (path ? path + " › " : "") + nodeText(f, n);
      li.appendChild(selectable(n)
        ? h("button", { type: "button", class: "nm" + (nodeValue(f, n) === curV ? " on" : ""), "data-node": nodeValue(f, n), onclick: () => pick(n) }, name)
        : h("span", { class: "nm off" }, name));
      return li;
    };
    const kids = (n) => { try { return n.childNodes || []; } catch { return []; } };
    const draw = () => {
      if (!alive) return;
      clear(list);
      const root = st.getRootNode();
      const text = norm(q.value.trim());
      if (text.length >= 2) {
        const out = [];
        const walk = (n, path) => { for (const c of kids(n)) { const t = nodeText(f, c); if (norm(t).includes(text)) out.push([c, path]); walk(c, path ? path + " › " + t : t); } };
        walk(root, "");
        for (const [c, path] of out.slice(0, 80)) list.appendChild(row(c, 0, path));
        if (!out.length) list.appendChild(h("li", { class: "mu sm", text: deep ? "Cerco in tutto l'elenco…" : "Nessun risultato" }));
        return;
      }
      const walk = (n, depth) => { for (const c of kids(n)) { list.appendChild(row(c, depth, "")); if (open.has(String(c.getId()))) walk(c, depth + 1); } };
      walk(root, 0);
      if (!kids(root).length) list.appendChild(h("li", { class: "mu sm", text: "Elenco vuoto" }));
    };
    // per cercare un nome servono tutti i rami: si caricano (al massimo 80 richieste al portale)
    const loadAll = async () => {
      if (deep) return deep;
      deep = (async () => {
        const queue = [st.getRootNode()];
        let loads = 0;
        while (queue.length && alive && loads < 80) {
          const n = queue.shift();
          let need = false;
          try { need = !n.isLeaf() && !n.isLoaded(); } catch { need = false; }
          if (need) { loads++; note.textContent = `Carico l'elenco dal portale… (${loads})`; await expandNode(n, st); }
          for (const c of kids(n)) queue.push(c);
        }
        note.textContent = queue.length ? "Elenco caricato in parte: restringi la ricerca o apri i rami" : "";
        deep = null;
        draw();
      })();
      return deep;
    };
    q.addEventListener("input", debounce(() => { draw(); if (norm(q.value.trim()).length >= 2) loadAll(); }, 250));
    if (!st) { note.textContent = "Elenco non leggibile: usa «Menu del portale»"; return wrap; }
    note.textContent = "Carico dal portale…";
    expandNode(st.getRootNode(), st).then(() => { note.textContent = ""; draw(); });
    return wrap;
  }
  async function queryField(f, q) {
    const st = f.getStore();
    const vf = f.valueField || "value", df = f.displayField || "text";
    const map = (r) => ({ r, v: String(r.get(vf) ?? ""), t: textOf(String(r.get(df) ?? r.get(vf) ?? "")) });
    if (f.queryMode === "local") { const n = norm(q); return st.getRange().map(map).filter((x) => x.v && norm(x.t).includes(n)); }
    // richiesta a parte con il proxy del campo: non apre il menu e non ricarica l'elenco del campo (che con
    // forceSelection cancellerebbe il valore già scelto)
    try {
      const px = st.getProxy();
      if (px && typeof px.createOperation === "function") {
        const recs = await new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error("timeout")), 10000);
          const op = px.createOperation("read", { params: Object.assign({}, st.lastOptions && st.lastOptions.params, { [f.queryParam || "query"]: q }), page: 1, start: 0, limit: 50,
            callback: (records, o, ok) => { clearTimeout(to); if (ok === false) rej(new Error("errore")); else res(records || []); } });
          op.execute();
        });
        activity(true);
        return recs.map(map).filter((x) => x.v);
      }
    } catch { /* sotto: con il campo stesso */ }
    let loaded = false;
    const on = () => { loaded = true; };
    st.on("load", on);
    const was = !!(document.body && document.body.inert);
    try {
      if (document.body) document.body.inert = false;
      f.lastQuery = null;
      f.doQuery(q, true, true);
    } catch { try { st.load({ params: { [f.queryParam || "query"]: q } }); } catch { /* */ } } finally { if (document.body) document.body.inert = was; }
    await waitUntil(() => loaded && !loading(st), 8000);
    st.un("load", on);
    try { if (typeof f.collapse === "function") f.collapse(); } catch { /* */ }
    activity(true);
    return st.getRange().map(map).filter((x) => x.v);
  }
  function pickRecord(f, r) {
    try {
      f.setValue(r);
      try { f.fireEvent("select", f, r); } catch { /* */ }
      return scalarValue(f, f.getValue()) === String(r.get(f.valueField || "value"));
    } catch { return false; }
  }
  // Scelta con il menu del portale: il pannello si nasconde e si riapre dopo la scelta.
  let pill = null;
  function showPill(text, onClick) {
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "ricerca-tkt-pill";
      const r = pill.attachShadow({ mode: "open" });
      const st = document.createElement("style");
      st.textContent = ":host{all:initial}button{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;font:600 14px system-ui,Segoe UI,Arial,sans-serif;background:#1f5fbf;color:#fff;border:0;border-radius:999px;padding:10px 18px;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer;max-width:calc(100vw - 32px)}";
      r.appendChild(st);
      r.appendChild(document.createElement("button"));
      document.documentElement.appendChild(pill);
    }
    const b = pill.shadowRoot.querySelector("button");
    b.textContent = text;
    b.onclick = onClick;
    pill.style.display = "";
  }
  const hidePill = () => { if (pill) pill.style.display = "none"; };
  function expandFilters(m, f) {
    try { const fp = Ext.getCmp(m.P + "mainFiltersPanel"); if (fp && fp.collapsed && typeof fp.expand === "function") fp.expand(false); } catch { /* */ }
    try {
      if (f && typeof f.isVisible === "function" && !f.isVisible(true) && m.cmp && m.cmp.el && m.cmp.isVisible(true)) {
        const tg = m.cmp.el.dom.querySelector(".filter-toggle");
        if (tg) tg.click();
      }
    } catch { /* */ }
  }
  let pickCleanup = null; // scelta nel portale in corso: si chiude tornando al pannello per qualsiasi strada
  async function pickInPortal(m, f, label) {
    if (pickCleanup) pickCleanup();
    ensureSnapshot(m);
    hide();
    showModuleTab(m);
    await sleep(60);
    expandFilters(m, f);
    await sleep(150);
    if (host.style.display !== "none") return; // pannello riaperto nel frattempo
    const cleanup = () => {
      if (pickCleanup !== cleanup) return;
      pickCleanup = null;
      try { f.un("change", onChange); } catch { /* */ }
      document.removeEventListener("keydown", onKey, true);
      hidePill();
    };
    const back = () => {
      if (pickCleanup !== cleanup) return;
      cleanup();
      setTimeout(() => { if (host.style.display === "none") show(); $("#adv").open = true; }, 300);
    };
    const onChange = () => { if (personValue(f)) back(); };
    const onKey = (e) => { if (e.key === "Escape" && !(f.isExpanded) && host.style.display === "none") back(); };
    pickCleanup = cleanup;
    f.on("change", onChange);
    document.addEventListener("keydown", onKey, true);
    showPill(`Scegli «${label}» nel portale · poi Ricerca TKT si riapre (clic qui per tornare subito)`, back);
    try { if (f.el && f.el.dom) f.el.dom.scrollIntoView({ block: "center" }); } catch { /* */ }
    try { if (typeof f.focus === "function") f.focus(); } catch { /* */ }
    try { if (typeof f.expand === "function") f.expand(); else if (typeof f.onTriggerClick === "function") f.onTriggerClick(); } catch { /* */ }
  }
  // ---- distribuzione per anno (una richiesta al portale per anno, fino a coprire il totale)
  // riga per anno: t = ticket nel portale Touch, a = nell'Area Riservata (ac: almeno uno dei conteggi al massimo
  // di righe, quindi «almeno»)
  function renderYears() {
    const box = clear($("#years"));
    const y = S.years;
    box.hidden = !y;
    if (!y) return;
    const withAr = y.rows.some((r) => r.a !== null && r.a !== undefined);
    const max = Math.max(1, ...y.rows.map((r) => (r.t || 0) + (r.a || 0)));
    const head = y.running ? `conteggio in corso… ${y.phase || ""}` : `${fmtN(y.sum)} su ${fmtN(y.total)} contati nel portale Touch${y.stopped ? " (interrotto)" : ""}`;
    box.appendChild(h("div", { class: "row between" }, h("h3", null, withAr ? "Ticket per anno: portale Touch e Area Riservata" : "Ticket per anno nel portale"), h("span", { class: "mu sm" }, head)));
    if (withAr && AR.info && AR.info.updDate) box.appendChild(h("p", { class: "mu sm", style: "margin:0", text: "Nell'Area Riservata l'anno è quello dell'ultimo aggiornamento del ticket." }));
    for (const r of [...y.rows].sort((a, b) => b.y - a.y)) {
      const bar = h("span"), bar2 = h("span", { class: "ar" });
      bar.style.width = `${((r.t || 0) / max) * 100}%`;
      bar2.style.width = `${((r.a || 0) / max) * 100}%`;
      const n = withAr ? `${r.t === null || r.t === undefined ? "—" : fmtN(r.t)} + ${r.a === null || r.a === undefined ? "…" : fmtN(r.a) + (r.ac ? "+" : "")}` : fmtN(r.t || 0);
      box.appendChild(h("div", { class: "yr" + (y.active === r.y ? " on" : "") }, h("b", null, String(r.y)), h("div", { class: "yb" }, bar, bar2), h("span", { class: "yn", title: withAr ? "portale Touch + Area Riservata («+»: almeno)" : "" }, n),
        (r.t || r.a) ? h("button", { type: "button", class: "btn gh s", disabled: y.running, onclick: () => searchYear(r.y) }, `Cerca nel ${r.y}`) : h("span")));
    }
    if (withAr) box.appendChild(h("p", { class: "mu sm", style: "margin:0", text: "«+» = l'Area Riservata ne ha almeno tanti: con «Cerca nel …» si cercano mese per mese, per averli tutti." }));
  }
  // ricerca dell'anno scelto: la stessa ricerca che il riepilogo ha contato (anche dopo altri clic sugli anni)
  function searchYear(y) {
    if (S.searching) return;
    const base = (S.years && S.years.base) || S.last || spec();
    const from = `${y}-01-01`, to = `${y}-12-31`;
    applySpec(Object.assign({}, base, { dfrom: base.dfrom && base.dfrom > from ? base.dfrom : from, dto: base.dto && base.dto < to ? base.dto : to }));
    onFormChange();
    const row = S.years && S.years.rows.find((r) => r.y === y);
    if (S.years) { S.years.active = y; S.keepYears = S.years; }
    // nell'Area Riservata un anno «al massimo» si cerca mese per mese
    runSearch({ people: base.people, pf: base.pf, arMonths: !!(row && row.yc) });
  }
  async function yearCounts() {
    const m = currentModule();
    if (!m || S.searching || !S.last || !S.info || m.key !== S.module) return;
    const s = S.last;
    const nowY = new Date().getFullYear();
    const toY = s.dto ? Math.min(nowY, +s.dto.slice(0, 4)) : nowY;
    const fromY = s.dfrom ? +s.dfrom.slice(0, 4) : 1990;
    const withAr = !!(S.info.ar && arOn());
    const ctrl = new AbortController();
    S.abort = ctrl; S.searching = true; $("#prog").hidden = false; $("#progt").textContent = "Conto i ticket anno per anno…"; $("#go").disabled = true;
    try {
      if (!(await ensureLastInPortal(m, ctrl.signal))) { pushAlert("warn", DRIFT_MSG); S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false; render(); return; }
    } catch (e) {
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false;
      if (!(e && e.name === "AbortError")) pushAlert("err", e && e.message ? e.message : "Errore nel conteggio per anno");
      render(); return;
    }
    S.years = { base: s, rows: [], sum: 0, total: S.info.total, running: true, stopped: false, phase: "portale Touch" };
    const rowOf = (y) => { let r = S.years.rows.find((x) => x.y === y); if (!r) { r = { y, t: null, a: null, ac: false }; S.years.rows.push(r); } return r; };
    render(); renderYears();
    const yearSpec = (y) => Object.assign({}, s, { dfrom: s.dfrom && s.dfrom > `${y}-01-01` ? s.dfrom : `${y}-01-01`, dto: s.dto && s.dto < `${y}-12-31` ? s.dto : `${y}-12-31`, people: undefined, pf: undefined });
    try {
      // portale Touch: una richiesta per anno, fino a coprire il totale
      // anni dei ticket già caricati: la serie di anni vuoti conta solo sotto il più vecchio
      const ys = S.results.filter((t) => t.src !== "ar").map((t) => +String(t.date || "").slice(0, 4)).filter((v) => v > 0);
      const floorY = Math.min(nowY - 2, ys.length ? Math.min(...ys) : toY);
      let zeros = 0;
      for (let y = toY; y >= fromY; y--) {
        const sp = yearSpec(y);
        const run = { applied: [], failed: [], trigger: "", loads: 0 };
        await reload(m, () => { setPageSize(m.store, 1); applyValues(m, sp, run); }, run, ctrl.signal);
        let n = 0;
        try { n = m.store.getTotalCount() || 0; } catch { /* */ }
        rowOf(y).t = n; S.years.sum += n;
        renderYears();
        if (S.years.sum >= S.years.total) break;
        zeros = n ? 0 : zeros + 1;
        if (zeros >= 3 && y < floorY) break;
      }
      // Area Riservata: una richiesta per anno; un anno al massimo di righe si conta mese per mese
      if (withAr) {
        S.years.phase = "Area Riservata";
        const ya = S.results.filter((t) => t.src === "ar").map((t) => +String(t.date || "").slice(0, 4)).filter((v) => v > 0);
        const floorA = Math.min(nowY - 2, ya.length ? Math.min(...ya) : toY);
        let za = 0;
        for (let y = toY; y >= Math.max(fromY, 2000); y--) {
          $("#progt").textContent = `Area Riservata: conto il ${y}…`;
          const c = await arCount(yearSpec(y), ctrl.signal);
          const r = rowOf(y);
          r.a = c.n; r.ac = c.capped; r.yc = c.capped;
          renderYears();
          if (c.capped) {
            let sum = 0, capped = false;
            for (let mo = 1; mo <= 12; mo++) {
              if (y === nowY && mo > new Date().getMonth() + 1) break;
              $("#progt").textContent = `Area Riservata: ${MESI_L[mo - 1]} ${y}…`;
              const from = `${y}-${pad(mo)}-01`, to = `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
              const cm = await arCount(Object.assign({}, yearSpec(y), { dfrom: s.dfrom && s.dfrom > from ? s.dfrom : from, dto: s.dto && s.dto < to ? s.dto : to }), ctrl.signal);
              sum += cm.n; capped = capped || cm.capped;
            }
            r.a = Math.max(r.a, sum); r.ac = capped;
            renderYears();
          }
          za = r.a ? 0 : za + 1;
          if (za >= 3 && y < floorA) break;
        }
      }
    } catch (e) {
      S.years.stopped = true;
      if (!(e && e.name === "AbortError")) pushAlert("err", e && e.message ? e.message : "Errore nel conteggio per anno");
    } finally {
      S.years.running = false;
      // l'elenco del portale torna sulla ricerca principale (serve per «Apri» e «Carica i successivi»)
      try {
        const run = { applied: [], failed: [], trigger: "", loads: 0 };
        await reload(m, () => { setPageSize(m.store, S.info.pageSize); applyValues(m, Object.assign({}, s, { people: undefined, pf: undefined }), run); }, run);
        S.info.state = listState(m);
      } catch { /* */ }
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false;
      renderYears(); render();
    }
  }
  function renderKept() { /* i filtri della pagina sono ora nel pannello (renderFilters) */ }
  function preset(v) {
    const t = new Date();
    const back = (days, months) => {
      const d = new Date(t);
      if (days) d.setDate(d.getDate() - days);
      if (months) { d.setDate(1); d.setMonth(d.getMonth() - months); d.setDate(Math.min(t.getDate(), lastDay(d.getFullYear(), d.getMonth() + 1))); }
      return isoOf(d);
    };
    let from = null, to = isoOf(t);
    switch (v) {
      case "30d": from = back(30); break; case "3m": from = back(0, 3); break; case "6m": from = back(0, 6); break;
      case "1y": from = back(0, 12); break; case "2y": from = back(0, 24); break; case "5y": from = back(0, 60); break;
      case "ytd": from = `${t.getFullYear()}-01-01`; break;
      case "py": from = `${t.getFullYear() - 1}-01-01`; to = `${t.getFullYear() - 1}-12-31`; break;
      case "custom": return;
      default: to = null;
    }
    $("#dfrom").value = from || ""; $("#dto").value = to || "";
  }
  function spec() {
    return {
      text: $("#q").value.trim(), subject: $("#subject").value.trim(), exclude: $("#exclude").value.trim(), allWords: $("#allw").checked,
      dfrom: $("#dfrom").value || "", dto: $("#dto").value || "", ufrom: $("#ufrom").value || "", uto: $("#uto").value || "",
      st: $("#st").value || "all", stCodes: [...S.stCodes], pr: [...S.prCodes], classif: $("#classif").value.trim(), classcli: $("#classcli").value.trim(),
      people: peopleSpec(currentModule()), pf: pfSpec(currentModule()),
    };
  }
  function peopleSpec(m) {
    const out = {};
    if (!m) return out;
    for (const [suffix] of PEOPLE) { const f = m.field(suffix); const v = f ? personValue(f) : null; if (v) out[suffix] = v; }
    return out;
  }
  function pfSpec(m) {
    const out = {};
    if (!m) return out;
    for (const k of keptFilters(m)) out[k.suffix] = k.val;
    return out;
  }
  function applySpec(s) {
    s = s || {};
    $("#q").value = s.text || ""; $("#subject").value = s.subject || ""; $("#exclude").value = s.exclude || ""; $("#allw").checked = !!s.allWords;
    $("#dfrom").value = s.dfrom || ""; $("#dto").value = s.dto || ""; $("#ufrom").value = s.ufrom || ""; $("#uto").value = s.uto || "";
    $("#preset").value = s.dfrom || s.dto ? "custom" : "";
    $("#st").value = ["all", "open", "closed", "custom", "page"].includes(s.st) ? s.st : "all";
    S.stCodes = new Set(Array.isArray(s.stCodes) ? s.stCodes : []); S.prCodes = new Set(Array.isArray(s.pr) ? s.pr : []);
    $("#classif").value = s.classif || ""; $("#classcli").value = s.classcli || "";
    const m = currentModule();
    const bad = [];
    if (m && s.people && typeof s.people === "object") {
      for (const [suffix, label] of PEOPLE) {
        const f = m.field(suffix);
        const want = s.people[suffix];
        const short = label.replace(/ \(.*$/, "");
        if (!f) { if (want && want.v) bad.push(short); continue; }
        const cur = personValue(f);
        try {
          if (want && want.v) { if (!cur || cur.v !== String(want.v)) { ensureSnapshot(m); if (!setPerson(f, want)) bad.push(short); } }
          else if (cur) { ensureSnapshot(m); clearField(f); }
        } catch { if (want && want.v) bad.push(short); }
      }
    }
    if (m && s.pf && typeof s.pf === "object") {
      for (const x of pfFields(m)) {
        if (PEOPLE_KEYS.has(x.suffix) || x.kind === "treemenu") continue;
        const want = s.pf[x.suffix], cur = pfValue(x.f, x.kind);
        if (!want && !cur) continue;
        if (want && cur && JSON.stringify(cur.v) === JSON.stringify(want.v)) continue;
        ensureSnapshot(m);
        try { if (!setPf(x.f, want, x.kind) && want) bad.push(x.label); } catch { if (want) bad.push(x.label); }
      }
    }
    renderToggles(); advCount(); preview();
    if (bad.length) toast(`Il portale non ha accettato: ${bad.join(", ")}. Usa «Scegli nel portale».`);
    return bad;
  }
  function advCount() {
    const s = spec();
    const n = [s.subject, s.exclude, s.allWords, s.ufrom || s.uto, s.classif, s.classcli, s.pr.length, s.st === "custom"].filter(Boolean).length + Object.keys(s.people || {}).length + Object.keys(s.pf || {}).length;
    $("#adv-n").textContent = n ? `(${n} attiv${n === 1 ? "a" : "e"})` : "";
  }
  const onFormChange = () => { preview(); advCount(); };
  function describe(s, m) {
    const p = [];
    if (s.text) p.push(`Search = "${s.text}"`);
    if (s.subject) p.push(`Subject = "${s.subject}"`);
    if (s.dfrom || s.dto) p.push(`Apertura ${s.dfrom ? "dal " + fmtDate(s.dfrom) : ""}${s.dfrom && s.dto ? " " : ""}${s.dto ? "al " + fmtDate(s.dto) : ""}`);
    if (s.ufrom || s.uto) p.push(`Aggiornamento ${s.ufrom ? "dal " + fmtDate(s.ufrom) : ""}${s.ufrom && s.uto ? " " : ""}${s.uto ? "al " + fmtDate(s.uto) : ""}`);
    const stl = { all: "tutti gli stati", open: "stati aperti", closed: "stati chiusi e risolti", page: "stato come nella pagina" };
    if (s.st === "custom") {
      const codes = Array.isArray(s.stCodes) ? s.stCodes : [];
      const names = (S.stOpts || []).filter(([v]) => codes.includes(v)).map(([, t]) => t);
      p.push(`Stato: ${names.length ? names.join(", ") : codes.join(", ") || "nessuno"}`);
    } else p.push(stl[s.st] || "tutti gli stati");
    if (Array.isArray(s.pr) && s.pr.length) p.push(`Priorità: ${s.pr.join(", ")}`);
    if (s.classif) p.push(`Classificazione ~ "${s.classif}"`);
    if (s.classcli) p.push(`Classif. cliente ~ "${s.classcli}"`);
    for (const [suffix, label] of PEOPLE) { const v = s.people && s.people[suffix]; if (v) p.push(`${label.replace(/ \(.*$/, "")} = ${v.t || v.v}`); }
    if (s.pf && typeof s.pf === "object") {
      const labels = m ? new Map(pfFields(m).map((x) => [x.suffix, x.label])) : new Map();
      for (const [suffix, v] of Object.entries(s.pf)) if (v && v.v !== undefined) p.push(`${labels.get(suffix) || suffix} = ${v.t || (Array.isArray(v.v) ? v.v.join(", ") : v.v)}`);
    }
    if (s.exclude) p.push(`poi senza: ${s.exclude}`);
    return p.join(" · ");
  }
  function previewNow() {
    const m = currentModule();
    const s = spec();
    $("#qprev").textContent = `${describe(s, m)} · tutti i ticket (${m ? m.title : "All tickets"}) · i ${settings.cap} più recenti`;
    const box = clear($("#qwarn"));
    if (!m) box.appendChild(h("div", { class: "note", text: S.opening ? "Apro la scheda «All tickets» del portale…" : "Non trovo l'elenco «All tickets» del portale: aprilo una volta dalla barra delle schede e riapri il segnalibro." }));
    $("#qrestore").hidden = !(m && S.snaps[m.key]);
    if (arOn() && settings.arOn !== false) {
      const bl = arBlockers(s);
      if (bl.length) box.appendChild(h("div", { class: "note", text: `Area Riservata: non usata con questi filtri (${bl.join(", ")}): lì non esistono. Toglili per cercare anche nell'Area Riservata.` }));
      else if (!(s.text || s.subject || s.dfrom || s.dto)) box.appendChild(h("div", { class: "note", text: "Area Riservata: scrivi un testo o scegli un periodo per cercare anche lì." }));
    }
    if (s.st === "custom" && !s.stCodes.length) box.appendChild(h("div", { class: "note", text: "Nessuno stato scelto: verrà tolto il filtro sullo stato." }));
  }
  const preview = debounce(previewNow, 120);
  function safeDescribe(s) { try { return describe(s && typeof s === "object" ? s : {}); } catch { return "(ricerca non leggibile)"; } }
  function refreshHistList() {
    const dl = clear($("#hist-list"));
    const seen = new Set();
    for (const it of store.get("history", [])) { const t = it.spec && it.spec.text; if (t && !seen.has(t)) { seen.add(t); dl.appendChild(h("option", { value: t })); } if (seen.size >= 15) break; }
  }
  const wordsOf = (s) => [...new Set(`${s.text || ""} ${s.subject || ""}`.replace(/["()]/g, " ").split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2 && !/^(and|or|not|e|o)$/i.test(w)))];

  // ===================================================================== Area Riservata (vecchia Ricerca rapida)
  // È un altro sito con altri ticket (numeri come #1234567). Ricerca TKT la apre in una scheda; dopo un clic
  // sul segnalibro in quella scheda e una conferma, le due schede si parlano con postMessage: le ricerche
  // le fa la pagina dell'Area Riservata, con la sessione dell'utente, e i risultati arrivano qui.
  const AR = { win: null, origin: "", state: "off", info: null, seq: 0, pending: new Map(), timer: 0, nonce: "" };
  const arUrl = () => absUrl(settings.arUrl || AR_DEFAULT) || AR_DEFAULT;
  const arOriginOf = () => { try { return new URL(arUrl()).origin; } catch { return ""; } };
  const randomId = () => { try { const a = new Uint32Array(4); crypto.getRandomValues(a); return [...a].map((x) => x.toString(36)).join(""); } catch { return String(Math.random()).slice(2) + Date.now().toString(36); } };
  const arOn = () => AR.state === "on" && !!AR.win && !AR.win.closed;
  function renderArState() {
    if (AR.state === "on" && (!AR.win || AR.win.closed)) arDrop("La scheda dell'Area Riservata è stata chiusa");
    const st = $("#ar-state"), help = $("#ar-help"), btn = $("#ar-connect");
    st.className = "pill" + (AR.state === "on" ? " on" : AR.state === "waiting" ? " wait" : "");
    st.textContent = AR.state === "on" ? "collegata" : AR.state === "waiting" ? "in attesa del segnalibro…" : "non collegata";
    btn.textContent = AR.state === "on" ? "Scollega" : AR.state === "waiting" ? "Riapri la scheda" : "Collega l'Area Riservata";
    $("#src-ar").checked = settings.arOn !== false && AR.state === "on";
    $("#src-ar").disabled = AR.state !== "on";
    help.hidden = AR.state !== "waiting";
    if (AR.state === "waiting") {
      clear(help);
      help.append(h("b", null, "Collega l'Area Riservata: "), "nella scheda che si è aperta accedi se serve, poi premi lì il segnalibro ", h("b", null, "Ricerca TKT"), " e conferma il collegamento. Lascia aperta quella scheda e torna qui.");
    }
  }
  function arDrop(why) {
    const was = AR.state;
    AR.state = "off"; AR.info = null;
    clearInterval(AR.timer);
    for (const p of AR.pending.values()) { clearTimeout(p.to); p.reject(new Error(why || "Area Riservata scollegata")); }
    AR.pending.clear();
    if (was === "on" && why) toast(why);
  }
  function arPost(msg) {
    try { AR.win.postMessage(Object.assign({ ns: "rtkt", v: 1 }, msg), AR.origin); return true; } catch { return false; }
  }
  function arConnect() {
    if (AR.state === "on") { arPost({ type: "bye" }); arDrop(); renderArState(); return; }
    AR.origin = arOriginOf();
    AR.nonce = randomId();
    try { AR.win = window.open(arUrl(), "rtkt-ar"); } catch { AR.win = null; }
    if (!AR.win) { toast("Il browser ha bloccato la nuova scheda: consenti le finestre popup per questo sito e riprova"); return; }
    AR.state = "waiting";
    renderArState();
    clearInterval(AR.timer);
    const t0 = Date.now();
    AR.timer = setInterval(() => {
      if (AR.state !== "waiting") { clearInterval(AR.timer); return; }
      if (!AR.win || AR.win.closed || Date.now() - t0 > 20 * 60000) { arDrop(); renderArState(); return; }
      arPost({ type: "hello", nonce: AR.nonce, from: `Ricerca TKT ${VERSION}` });
    }, 1000);
  }
  window.addEventListener("message", (e) => {
    if (!AR.win || e.source !== AR.win || e.origin !== AR.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.ns !== "rtkt" || d.v !== 1) return;
    if (d.type === "ready") {
      if (d.nonce !== AR.nonce || AR.state === "on") return;
      AR.state = "on";
      AR.info = { version: str(d.version, 40), page: str(d.page, 200) };
      clearInterval(AR.timer);
      AR.timer = setInterval(() => { if (!AR.win || AR.win.closed) { arDrop("La scheda dell'Area Riservata è stata chiusa"); renderArState(); } }, 3000);
      renderArState(); previewNow();
      toast("Area Riservata collegata: le ricerche cercano anche lì");
      arCall("info", {}, null, null, 15000).then((r) => { if (AR.info) { AR.info.updDate = !(r.fields && r.fields.open); AR.info.fields = r.fields && r.fields.how; } }).catch(() => {});
      return;
    }
    if (d.type === "bye") { arDrop("Area Riservata scollegata"); renderArState(); previewNow(); return; }
    const p = typeof d.id === "string" ? AR.pending.get(d.id) : null;
    if (!p) return;
    if (d.type === "progress") { if (p.progress) p.progress(str(d.text, 200)); return; }
    AR.pending.delete(d.id);
    clearTimeout(p.to);
    if (d.ok === false) p.reject(new Error(str(d.error, 400) || "Errore dall'Area Riservata"));
    else p.resolve(d);
  });
  function arCall(type, payload, signal, progress, ms) {
    if (!arOn()) return Promise.reject(new Error("Area Riservata non collegata"));
    const id = `${AR.nonce}-${++AR.seq}`;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, progress, to: setTimeout(() => { if (AR.pending.delete(id)) reject(new Error("L'Area Riservata non risponde: controlla la sua scheda (sessione scaduta?)")); }, ms || 120000) };
      AR.pending.set(id, p);
      if (signal) signal.addEventListener("abort", () => {
        if (!AR.pending.delete(id)) return;
        clearTimeout(p.to);
        arPost({ type: "abort", id });
        const e = new Error("Ricerca interrotta."); e.name = "AbortError"; reject(e);
      }, { once: true });
      if (!arPost(Object.assign({ type, id }, payload))) { AR.pending.delete(id); clearTimeout(p.to); reject(new Error("Area Riservata non raggiungibile")); }
    });
  }
  // filtri che l'Area Riservata non conosce: con questi attivi si cerca solo nel portale Touch
  function arBlockers(s) {
    const out = [];
    if (s.st && s.st !== "all") out.push("stato");
    if (s.pr && s.pr.length) out.push("priorità");
    if (Object.keys(s.people || {}).length) out.push("gruppi e persone");
    if (Object.keys(s.pf || {}).length) out.push("altri filtri del portale");
    if (s.ufrom || s.uto || s.classif || s.classcli) out.push("aggiornamento o classificazione");
    return out;
  }
  const arWanted = (s) => arOn() && settings.arOn !== false && !arBlockers(s).length && !!(s.text || s.subject || s.dfrom || s.dto);
  const arSpec = (s) => ({ text: s.text || "", subject: s.subject || "", allWords: !!s.allWords, dfrom: s.dfrom || "", dto: s.dto || "" });
  function arSafeUrl(u) {
    try { const x = new URL(String(u), arUrl()); return x.origin === AR.origin && /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
  }
  // risultato dell'Area Riservata → ticket del pannello (solo testo, lunghezze limitate)
  function arTicket(x, i) {
    if (!x || typeof x !== "object") return null;
    const n = String(x.number ?? "").replace(/\D/g, "").slice(0, 12);
    const date = isoDay(x.date);
    const t = {
      key: n ? `a:${n}` : `a:x${i}`, src: "ar", source: "Area Riservata", code: n ? `#${n}` : "", number: n, list: "AR", rank: i, recId: "",
      date, time: "", subject: str(x.subject, 500), preview: str(x.snippet, 3000), service: str(x.product, 60), product: str(x.product, 60),
      status: str(x.status, 60), url: x.url ? arSafeUrl(x.url) : null, arRef: str(x.ref, 300), cols: [],
    };
    return t;
  }
  async function arSearch(s, signal, progress) {
    const r = await arCall("search", { spec: arSpec(s) }, signal, progress);
    const list = Array.isArray(r.tickets) ? r.tickets.slice(0, 2000) : [];
    return { tickets: list.map(arTicket).filter(Boolean), capped: !!r.capped, max: parseInt(r.max, 10) || null, count: parseInt(r.count, 10) || list.length, ms: parseInt(r.ms, 10) || 0 };
  }
  // tutti i ticket dell'Area Riservata del periodo: una ricerca per mese (ogni mese ha al massimo 210 righe)
  async function arSearchMonths(s, signal, progress) {
    const now = new Date();
    const a = /^(\d{4})-(\d{2})/.exec(s.dfrom || "") || [null, String(now.getFullYear()), "01"];
    const b = /^(\d{4})-(\d{2})/.exec(s.dto || "") || [null, String(now.getFullYear()), pad(now.getMonth() + 1)];
    let y = +a[1], mo = +a[2];
    const tickets = [], seen = new Set(), cappedMonths = [];
    let max = null, n = 0;
    while ((y < +b[1] || (y === +b[1] && mo <= +b[2])) && n < 36) {
      n++;
      if (progress) progress(`${MESI_L[mo - 1]} ${y}…`);
      const from = `${y}-${pad(mo)}-01`, to = `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
      const r = await arSearch(Object.assign({}, s, { dfrom: s.dfrom && s.dfrom > from ? s.dfrom : from, dto: s.dto && s.dto < to ? s.dto : to }), signal, null);
      max = r.max || max;
      if (r.capped) cappedMonths.push(`${MESI[mo - 1]} ${y}`);
      for (const t of r.tickets) if (!seen.has(t.key)) { seen.add(t.key); tickets.push(t); }
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    return { tickets, capped: cappedMonths.length > 0, cappedMonths, max, count: tickets.length, months: n, ms: 0 };
  }
  async function arCount(s, signal) {
    const r = await arCall("search", { spec: arSpec(s), countOnly: true }, signal, null);
    return { n: parseInt(r.count, 10) || 0, capped: !!r.capped };
  }
  async function arRead(t, signal) {
    if (!arOn()) throw Object.assign(new Error("Per leggere un ticket dell'Area Riservata collegala (pulsante «Collega l'Area Riservata»)."), { url: t.url });
    const r = await arCall("read", { ticket: { number: t.number, url: t.url, ref: t.arRef } }, signal, null, 60000);
    const c = r.content && typeof r.content === "object" ? r.content : {};
    const fl = (a, max) => (Array.isArray(a) ? a.slice(0, max) : []);
    return {
      title: str(c.title, 300),
      fields: fl(c.fields, 80).map((x) => ({ label: str(x && x.label, 200), value: str(x && x.value, 4000) })).filter((x) => x.value),
      texts: fl(c.texts, 40).map((x) => ({ label: str(x && x.label, 200), value: str(x && x.value, 40000) })).filter((x) => x.value),
      tables: fl(c.tables, 10).map((tb) => ({ title: str(tb && tb.title, 200), head: fl(tb && tb.head, 20).map((x) => str(x, 200)), rows: fl(tb && tb.rows, 300).map((r2) => fl(r2, 20).map((x) => str(x, 8000))) })),
      url: (r.url && arSafeUrl(r.url)) || t.url,
    };
  }
  function arOpen(t) {
    if (t.url) window.open(t.url, "_blank", "noopener");
    else if (arOn()) arCall("open", { ticket: { number: t.number, ref: t.arRef } }, null, null, 15000).catch((e) => toast(e.message));
    else toast("Collega l'Area Riservata per aprire questo ticket");
  }

  // ===================================================================== ricerca
  function hay(t) {
    if (t._hay === undefined) t._hay = norm([t.code, t.subject, t.preview, t.resolution, t.site, t.siteCode, t.contact, t.status, t.priority, t.service, t.classification, t.assigned, t.group, t.owner, t.modifiers, t.tags, fmtDate(t.date)].join(" "));
    const f = S.favorites.get(t.key);
    return f ? `${t._hay} ${norm(f.note)} ${norm(f.tags.join(" "))}` : t._hay;
  }
  function parseRefine(text) {
    const inc = [], exc = [];
    for (const m of (text || "").matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
      const t = norm(m[2] || m[4]);
      if (!t || t === "-") continue;
      (m[1] || m[3] ? exc : inc).push(t);
    }
    return { inc, exc };
  }
  function addResults(tickets, s) {
    let dropped = 0;
    const ex = parseRefine(s.exclude);
    const need = s.allWords ? wordsOf({ text: s.text }).map(norm) : [];
    for (const t of tickets) {
      if (S.keys.has(t.key)) continue;
      const x = norm([t.subject, t.preview, t.resolution, t.code, t.site, t.classification, t.service].join(" "));
      if ((ex.inc.length || ex.exc.length) && [...ex.inc, ...ex.exc].some((w) => x.includes(w))) { dropped++; continue; }
      if (need.length && !need.every((w) => x.includes(w))) { dropped++; continue; }
      S.keys.add(t.key); t.rank = S.results.length; S.results.push(t);
    }
    return dropped;
  }
  // people: gruppi e persone voluti (ricerca salvata, cronologia, anno): anche se la pagina non li ha presi,
  // così il filtro mancante viene segnalato e la cronologia li conserva
  async function runSearch(wanted) {
    if (S.searching) return;
    const ctrl = new AbortController();
    S.searching = true; S.abort = ctrl; $("#go").disabled = true; // occupato prima di qualsiasi attesa
    let m = currentModule();
    if (!m) {
      const p = ensureAllTickets();
      previewNow(); // «Apro la scheda All tickets del portale…»
      m = await p.catch(() => null);
      if (!m || ctrl.signal.aborted) {
        S.abort = null; S.searching = false; S.keepYears = null; $("#go").disabled = false;
        if (!m) toast("Non trovo l'elenco «All tickets» del portale: aprilo una volta dalla barra delle schede");
        preview(); return;
      }
    }
    const s = spec();
    if (wanted && wanted.people && typeof wanted.people === "object") s.people = JSON.parse(JSON.stringify(wanted.people));
    if (wanted && wanted.pf && typeof wanted.pf === "object") s.pf = JSON.parse(JSON.stringify(wanted.pf));
    S.last = s; S.words = wordsOf(s); S.module = m.key; S.years = S.keepYears || null; S.keepYears = null; renderYears();
    Object.assign(S, { results: [], keys: new Set(), page: 1, alerts: [], info: null, refine: "" });
    S.selected.clear(); S.facet = emptyFacets();
    const withAr = arWanted(s);
    $("#refine").value = ""; $("#emptyst").hidden = true; $("#results").hidden = false; $("#prog").hidden = false; $("#progt").textContent = withAr ? "Ricerca in corso nel portale Touch e nell'Area Riservata…" : "Ricerca in corso nel portale…"; $("#go").disabled = true;
    S.searching = true;
    renderAlerts(); render();
    // Area Riservata in parallelo (se collegata): i suoi risultati si aggiungono a quelli del portale
    const arProg = (txt) => { if (S.searching) $("#progt").textContent = `Area Riservata: ${txt}`; };
    const arP = withAr ? (wanted && wanted.arMonths ? arSearchMonths(s, ctrl.signal, arProg) : arSearch(s, ctrl.signal, arProg)).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })) : null;
    const addAr = async () => {
      if (!arP) return 0;
      if (S.searching) $("#progt").textContent = "Aspetto i risultati dell'Area Riservata…";
      const a = await arP;
      if (!a.ok) { if (!(a.e && a.e.name === "AbortError")) pushAlert("warn", `Area Riservata: ${(a.e && a.e.message) || "errore"}. I risultati sono solo quelli del portale Touch.`); return 0; }
      const before = S.results.length;
      const dropped = addResults(a.v.tickets, s);
      S.info = Object.assign(S.info || { total: 0, loaded: 0, page: 1, pageSize: settings.cap, dropped: 0, ms: 0 }, {});
      S.info.dropped += dropped;
      S.info.ar = { loaded: a.v.tickets.length, added: S.results.length - before, capped: a.v.capped, max: a.v.max, ms: a.v.ms };
      if (a.v.months) { if (a.v.capped) pushAlert("warn", `Area Riservata, cercata mese per mese: in ${a.v.cappedMonths.join(", ")} ci sono più di ${fmtN(a.v.max || 210)} ticket (il massimo per ricerca): restringi la ricerca per vederli tutti.`); }
      else if (a.v.capped) pushAlert("warn", `L'Area Riservata restituisce al massimo ${fmtN(a.v.max || a.v.tickets.length)} ticket per ricerca: qui ci sono i primi ${fmtN(a.v.tickets.length)}, non tutti. Restringi il periodo o usa «Quanti per anno?» e cerca un anno alla volta.`);
      mergeByDate();
      return S.results.length - before;
    };
    try {
      const r = await pageSearch(m, s, ctrl.signal);
      const dropped = addResults(r.tickets, s);
      const run = conn.lastRun;
      S.info = { total: r.total, loaded: r.tickets.length, page: r.page, pageSize: r.pageSize, dropped, ms: run.ms, state: listState(m) };
      if (run.failed.length) pushAlert("warn", `Alcuni filtri non sono stati impostati nella pagina: ${run.failed.join("; ")}. I risultati potrebbero non rispettarli.`);
      if (run.verified === false) pushAlert("warn", "Il portale ha ricaricato l'elenco, ma la richiesta non sembra contenere il testo cercato: i risultati potrebbero non essere filtrati. Se succede, manda i dati tecnici (Impostazioni).");
      if (r.pageSize < settings.cap && r.total > r.tickets.length) pushAlert("warn", `Il portale restituisce al massimo ${fmtN(r.pageSize)} ticket per richiesta.`);
      if (r.total > r.tickets.length) pushAlert("warn", `Il portale ha ${fmtN(r.total)} ticket per questa ricerca, su tutti gli anni: qui ci sono i ${fmtN(r.tickets.length)} più recenti. Con «Quanti per anno?» vedi come si distribuiscono e cerchi in un anno solo; oppure restringi la ricerca o carica i successivi.`);
      if (dropped) pushAlert("info", `${fmtN(dropped)} ticket scartati dai filtri sui risultati.`);
      if (!r.tickets.length && r.total) pushAlert("warn", "Il portale indica dei risultati ma l'elenco è vuoto: manda i dati tecnici da Impostazioni.");
      await addAr();
      const hist = store.get("history", []);
      hist.unshift({ spec: s, results: S.results.length, total: r.total + (S.info.ar ? S.info.ar.loaded : 0), created: new Date().toISOString() });
      store.set("history", hist.slice(0, 200));
      refreshHistList();
    } catch (e) {
      if (e && e.name === "AbortError") pushAlert("warn", "Ricerca interrotta: il portale potrebbe completare comunque il caricamento dell'elenco.");
      else {
        pushAlert("err", e && e.message ? e.message : "Errore durante la ricerca");
        conn.errors.push(String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
        try { await addAr(); } catch { /* */ } // i risultati dell'Area Riservata si mostrano comunque
      }
    } finally {
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false;
      renderKept(currentModule()); preview(); render();
    }
  }
  // risultati di due fonti: in ordine di data (più recenti prima), a parità prima il portale Touch
  function mergeByDate() {
    if (!S.results.some((t) => t.src === "ar")) return;
    S.results.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (a.src === b.src ? a.rank - b.rank : a.src === "ar" ? 1 : -1));
    S.results.forEach((t, i) => { t.rank = i; });
  }
  async function loadMore() {
    const m = currentModule();
    if (!m || S.searching || !S.info || m.key !== S.module) return;
    const ctrl = new AbortController();
    S.abort = ctrl; S.searching = true; $("#prog").hidden = false; $("#progt").textContent = "Carico i ticket successivi…"; $("#go").disabled = true;
    render();
    try {
      if (!(await ensureLastInPortal(m, ctrl.signal))) { pushAlert("warn", DRIFT_MSG); return; }
      S.years = null; renderYears();
      const r = await loadNextPage(m, S.info.page + 1, S.info.pageSize, ctrl.signal);
      const before = S.results.length;
      S.info.dropped += addResults(r.tickets, S.last);
      S.info.loaded += r.tickets.length; S.info.page = r.page; S.info.total = r.total;
      S.info.state = listState(m);
      toast(`Aggiunti ${fmtN(S.results.length - before)} ticket`);
    } catch (e) { if (!(e && e.name === "AbortError")) pushAlert("err", e && e.message ? e.message : "Errore"); } finally {
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false; render(); preview();
    }
  }
  function pushAlert(kind, message) {
    if (!S.alerts.some((a) => a.message === message)) S.alerts.push({ kind, message });
    renderAlerts();
  }
  function renderAlerts() {
    const box = clear($("#alert"));
    const items = S.alerts.filter((a) => a.kind !== "info");
    box.hidden = !items.length;
    box.className = "alert" + (items.some((a) => a.kind === "err") ? " err" : "");
    for (const a of items) box.appendChild(h("div", null, a.message));
  }

  // ===================================================================== risultati
  const FACETS = [["source", "Fonte"], ["status", "Stato"], ["priority", "Priorità"], ["group", "Gruppo"], ["assigned", "Assegnato a"], ["owner", "Responsabile"], ["modifiers", "Modificato da"], ["service", "Servizio"], ["site", "Sede / cliente"]];
  const MULTI_FACETS = new Set(["modifiers"]);
  const fvals = (t, k) => { const v = t[k] || ""; return MULTI_FACETS.has(k) ? v.split(/\s*[,;]\s*/).filter(Boolean) : [v || "—"]; };
  function filterItems(skip) {
    const r = parseRefine(S.refine), f = S.facet;
    return S.results.filter((t) => {
      if (r.inc.length || r.exc.length) { const x = hay(t); if (!r.inc.every((w) => x.includes(w)) || r.exc.some((w) => x.includes(w))) return false; }
      for (const [k] of FACETS) if (skip !== k && f[k].size && !fvals(t, k).some((v) => f[k].has(v))) return false;
      if (skip !== "year" && f.year && (t.date || "").slice(0, 4) !== f.year) return false;
      if (skip !== "month" && skip !== "year" && f.month && (t.date || "").slice(5, 7) !== f.month) return false;
      if (skip !== "tags" && f.tags.size) { const fv = S.favorites.get(t.key); if (!fv || !fv.tags.some((x) => f.tags.has(x))) return false; }
      return true;
    });
  }
  const codeNum = (t) => { const m = /\d+/.exec(t.code || ""); return m ? +m[0] : 0; };
  const SORT = {
    rank: (a, b) => a.rank - b.rank,
    date_desc: (a, b) => `${b.date || ""}${b.time || ""}`.localeCompare(`${a.date || ""}${a.time || ""}`) || a.rank - b.rank,
    date_asc: (a, b) => `${a.date || "9999"}${a.time || ""}`.localeCompare(`${b.date || "9999"}${b.time || ""}`) || a.rank - b.rank,
    upd_desc: (a, b) => `${b.updated || ""}${b.updTime || ""}`.localeCompare(`${a.updated || ""}${a.updTime || ""}`) || a.rank - b.rank,
    code_desc: (a, b) => codeNum(b) - codeNum(a),
    code_asc: (a, b) => codeNum(a) - codeNum(b),
    subject: (a, b) => (a.subject || "").localeCompare(b.subject || "", "it", { sensitivity: "base" }) || a.rank - b.rank,
    status: (a, b) => (a.status || "").localeCompare(b.status || "", "it") || a.rank - b.rank,
  };
  const gkey = (t) => (S.group === "year" ? (t.date || "").slice(0, 4) || "—" : S.group === "month" ? (t.date || "").slice(0, 7) || "—" : S.group === "none" ? "" : t[S.group] || "—");
  const glabel = (k) => (S.group === "month" && /^\d{4}-\d{2}$/.test(k) ? `${MESI_L[+k.slice(5) - 1]} ${k.slice(0, 4)}` : k === "—" ? "Senza valore" : k);
  function visible() {
    const items = filterItems();
    const so = SORT[S.sort] || SORT.rank;
    if (S.group === "none") return items.sort(so);
    const dir = S.group === "month" || S.group === "year" ? -1 : 1;
    return items.sort((a, b) => { const ga = gkey(a), gb = gkey(b); if (ga !== gb) return ga === "—" ? 1 : gb === "—" ? -1 : ga.localeCompare(gb, "it") * dir; return so(a, b); });
  }
  function render() {
    if ($("#results").hidden) return;
    const items = visible();
    S.visible = items;
    renderFacets(); renderActive(); renderSummary(items.length);
    const pages = Math.max(1, Math.ceil(items.length / S.size));
    S.page = Math.min(S.page, pages);
    const pageItems = items.slice((S.page - 1) * S.size, S.page * S.size);
    S.pageItems = pageItems;
    const list = clear($("#list"));
    let lg = null;
    for (const t of pageItems) {
      if (S.group !== "none") {
        const g = gkey(t);
        if (g !== lg) { list.appendChild(h("div", { class: "gt" }, glabel(g), h("span", { class: "mu", text: fmtN(items.filter((x) => gkey(x) === g).length) }))); lg = g; }
      }
      list.appendChild(ticketEl(t));
    }
    if (!pageItems.length && !S.searching) list.appendChild(h("div", { class: "card empty", text: S.results.length ? "Nessun risultato con i filtri attuali." : "Nessun ticket trovato." }));
    $("#selall").checked = pageItems.length > 0 && pageItems.every((t) => S.selected.has(t.key));
    renderPager(pages);
  }
  function renderSummary(nv) {
    const el = clear($("#sum"));
    if (S.searching) { el.appendChild(h("span", { class: "mu", text: $("#progt").textContent })); return; }
    const total = S.results.length;
    const parts = [h("b", null, fmtN(total)), total === 1 ? " ticket" : " ticket"];
    const ar = S.info && S.info.ar;
    if (ar) parts.push(h("span", { class: "mu" }, `: ${fmtN(total - ar.added)} dal portale Touch${S.info.total > S.info.loaded ? ` (i più recenti su ${fmtN(S.info.total)})` : ""}, ${fmtN(ar.added)} dall'Area Riservata${ar.capped ? " (massimo raggiunto)" : ""}`));
    else if (S.info && S.info.total > total) parts.push(h("span", { class: "mu" }, `, i più recenti su ${fmtN(S.info.total)} nel portale`));
    if (nv !== total) parts.push(" · ", h("b", null, fmtN(nv)), " dopo i filtri");
    if (S.info) parts.push(h("span", { class: "mu" }, ` · ${(S.info.ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} s`));
    if (S.info && (S.info.total > S.info.loaded || (ar && ar.capped))) {
      parts.push(h("button", { type: "button", class: "btn s", id: "yearsbtn", onclick: yearCounts, title: "Conta i ticket di questa ricerca anno per anno (una richiesta al portale per anno)" }, "Quanti per anno?"));
      if (S.info.total > S.info.loaded) parts.push(h("button", { type: "button", class: "btn s", id: "more", onclick: loadMore }, `Carica i successivi ${fmtN(Math.min(S.info.pageSize || settings.cap, S.info.total - S.info.loaded))}`));
    }
    if (S.selected.size) parts.push(" · ", h("b", null, fmtN(S.selected.size)), " selezionati ", h("button", { type: "button", class: "btn gh s", onclick: () => { S.selected.clear(); render(); } }, "deseleziona"));
    add(el, parts);
  }
  function metaItem(label, value) { return value ? h("span", null, `${label} `, h("b", null, value)) : null; }
  function ticketEl(t, noSel) {
    const fav = S.favorites.get(t.key);
    const sel = S.selected.has(t.key);
    const label = t.code || "ticket";
    const words = noSel ? [] : S.words;
    const extra = [];
    if (fav) { for (const g of fav.tags) extra.push(h("span", { class: "tag", text: g })); if (fav.note) extra.push(h("span", { class: "nt", text: fav.note })); }
    return h("article", { class: "res" + (sel ? " sel" : "") },
      h("div", { class: "rh" },
        noSel ? null : h("input", { type: "checkbox", "aria-label": `Seleziona ${label}`, checked: sel, onchange: (e) => { if (e.target.checked) S.selected.add(t.key); else S.selected.delete(t.key); render(); } }),
        h("a", { class: "num", href: "#", title: "Leggi il ticket completo", onclick: (e) => { e.preventDefault(); readTicket(t); } }, label),
        t.src === "ar" ? h("span", { class: "badge src" }, "Area Riservata") : null,
        t.code ? h("button", { type: "button", class: "ib", title: "Copia ID", "aria-label": "Copia ID", onclick: () => copyText(t.code, `Copiato ${t.code}`) }, "⧉") : null,
        t.status ? h("span", { class: "badge" + (CLOSED_RE.test(t.status) ? " cl" : "") }, t.status) : null,
        t.priority ? h("span", { class: "badge pr" }, t.priority) : null,
        t.date ? h("time", { class: "mu", text: `${fmtDate(t.date)}${t.time ? " " + t.time : ""}` }) : null,
        h("span", { class: "sp" }),
        h("button", { type: "button", class: "ib" + (fav ? " on" : ""), "aria-pressed": String(!!fav), title: fav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti", onclick: () => toggleFav(t) }, fav ? "★" : "☆"),
        h("button", { type: "button", class: "ib", title: "Nota ed etichette", "aria-label": "Nota ed etichette", onclick: () => openNote(t) }, "✎"),
        h("button", { type: "button", class: "btn s", onclick: () => readTicket(t) }, "Leggi"),
        openLink(t)),
      h("div", { class: "subj" }, hl(t.subject || "(senza oggetto)", words)),
      t.preview ? h("div", { class: "snip" }, hl(t.preview, words)) : null,
      t.resolution ? h("div", { class: "snip rs" }, h("b", null, "Soluzione: "), hl(t.resolution, words)) : null,
      h("div", { class: "meta" }, metaItem("Sede", [t.site, t.siteCode].filter(Boolean).join(" · ")), metaItem("Contatto", t.contact), metaItem("Servizio", t.service),
        metaItem("Classificazione", t.classification), metaItem("Assegnato a", t.assigned), metaItem("Gruppo", t.group), metaItem("Responsabile", t.owner !== t.assigned ? t.owner : ""), metaItem("Modificato da", t.modifiers),
        t.updated ? metaItem("Aggiornato", `${fmtDate(t.updated)}${t.updTime ? " " + t.updTime : ""}`) : null, metaItem("SLA", t.sla), metaItem("Tag", t.tags)),
      extra.length ? h("div", { class: "meta" }, extra) : null,
      t.cols && t.cols.length ? h("details", { class: "cols" }, h("summary", null, "Tutte le colonne"), h("dl", null, t.cols.map((c) => [h("dt", null, c.h), h("dd", null, c.v)]))) : null);
  }
  // collegamento al ticket: indirizzo diretto se noto, altrimenti apertura con i comandi del portale
  function openLink(t) {
    const url = t.src === "ar" ? t.url : touchUrl(t);
    const text = t.src === "ar" ? "Area Riservata ↗" : "Apri in Touch ↗";
    if (url) return h("a", { class: "btn s gh", href: url, target: "_blank", rel: "noopener", title: "Apri in una nuova scheda" }, text);
    return h("button", { type: "button", class: "btn s gh", title: "Apri con il pulsante Open del portale (nuova scheda)", onclick: () => openTicket(t) }, text);
  }
  // ---- lettura nel pannello
  const READ = new Map(); // ticket già letti in questa sessione
  let readCtrl = null, readT = null;
  function setReadLink(t, url) {
    const a = $("#rlink"), b = $("#ropen");
    const ar = t.src === "ar";
    url = url || (ar ? t.url : touchUrl(t));
    a.textContent = b.textContent = ar ? "Apri nell'Area Riservata ↗" : "Apri in Touch ↗";
    if (url) { a.href = url; a.hidden = false; b.hidden = true; } else { a.hidden = true; a.removeAttribute("href"); b.hidden = false; }
  }
  function readSummary(t) {
    const items = [["Stato", t.status], ["Priorità", t.priority], ["Aperto", t.date ? `${fmtDate(t.date)}${t.time ? " " + t.time : ""}` : ""], ["Aggiornato", t.updated ? `${fmtDate(t.updated)}${t.updTime ? " " + t.updTime : ""}` : ""],
      ["Sede", [t.site, t.siteCode].filter(Boolean).join(" · ")], ["Contatto", t.contact], ["Servizio", t.service || t.product], ["Classificazione", t.classification],
      ["Assegnato a", t.assigned], ["Gruppo", t.group], ["Responsabile", t.owner], ["Modificato da", t.modifiers]].filter(([, v]) => v);
    return items.length ? h("dl", { class: "rdf" }, items.map(([k, v]) => [h("dt", null, k), h("dd", null, v)])) : null;
  }
  function renderRead(box, c) {
    const words = S.words;
    if (c.fields && c.fields.length) box.appendChild(h("section", null, h("h4", null, "Dati del ticket"), h("dl", { class: "rdf" }, c.fields.map((x) => [h("dt", null, x.label || "—"), h("dd", null, hl(x.value, words))]))));
    for (const x of c.texts || []) box.appendChild(h("section", null, x.label ? h("h4", null, x.label) : null, h("div", { class: "pre" }, hl(x.value, words))));
    for (const tb of c.tables || []) {
      box.appendChild(h("section", null, h("h4", null, `${tb.title || "Elenco"} (${tb.rows.length})`),
        h("div", { class: "rdtw" }, h("table", { class: "rdtab" }, h("thead", null, h("tr", null, tb.head.map((x) => h("th", null, x)))), h("tbody", null, tb.rows.map((r) => h("tr", null, r.map((x) => h("td", null, hl(x, words))))))))));
    }
    if (!box.children.length) box.appendChild(h("div", { class: "note", text: "La pagina del ticket non contiene testo leggibile: aprila con il collegamento." }));
  }
  function readText(t, c) {
    const out = [`${t.code || ""} ${t.subject || ""}`.trim()];
    if (c) {
      for (const x of c.fields || []) out.push(`${x.label}: ${x.value}`);
      for (const x of c.texts || []) out.push("", x.label ? `${x.label}:` : "", x.value);
      for (const tb of c.tables || []) { out.push("", `${tb.title || "Elenco"}:`, tb.head.join(" | ")); for (const r of tb.rows) out.push(r.join(" | ")); }
    }
    return out.filter((x, i) => x !== "" || i > 0).join("\n");
  }
  async function readTicket(t) {
    readT = t;
    const d = $("#dread");
    $("#rsrc").textContent = t.src === "ar" ? "Area Riservata" : "Portale Touch";
    $("#rtitle").textContent = `${t.code || "Ticket"}${t.subject ? " · " + t.subject : ""}`;
    setReadLink(t);
    const body = clear($("#rbody"));
    const sum = readSummary(t);
    if (sum) body.appendChild(sum);
    const box = h("div", { class: "rdb0" });
    body.appendChild(box);
    if (!d.open) d.showModal();
    if (readCtrl) readCtrl.abort();
    const ctrl = readCtrl = new AbortController();
    const cached = READ.get(t.key);
    if (cached) { renderRead(box, cached); setReadLink(t, cached.url); return; }
    box.appendChild(h("div", { class: "mu", text: t.src === "ar" ? "Leggo il ticket dall'Area Riservata…" : "Leggo il ticket dal portale…" }));
    try {
      const c = t.src === "ar" ? await arRead(t, ctrl.signal) : await loadTouchTicket(t, ctrl.signal);
      if (ctrl !== readCtrl) return;
      READ.set(t.key, c);
      clear(box); renderRead(box, c); setReadLink(t, c.url);
      if (t.src !== "ar") render(); // ora i risultati hanno il collegamento diretto
    } catch (e) {
      if (ctrl !== readCtrl || (e && e.name === "AbortError")) return;
      clear(box);
      box.appendChild(h("div", { class: "note" }, (e && e.message) || "Lettura non riuscita"));
      if (t.preview || t.resolution) box.appendChild(h("section", null, h("h4", null, "Dall'elenco (testo abbreviato)"), h("div", { class: "pre" }, hl([t.preview, t.resolution && "Soluzione: " + t.resolution].filter(Boolean).join("\n\n"), S.words))));
      setReadLink(t, e && e.url);
    }
  }
  function renderPager(pages) {
    const nav = clear($("#pager"));
    if (pages <= 1) return;
    const go = (p) => { S.page = p; render(); $("#results").scrollIntoView({ block: "start" }); };
    nav.appendChild(h("button", { type: "button", disabled: S.page === 1, onclick: () => go(S.page - 1), "aria-label": "Pagina precedente" }, "‹"));
    const show = new Set([1, pages, S.page - 2, S.page - 1, S.page, S.page + 1, S.page + 2]);
    let last = 0;
    for (let p = 1; p <= pages; p++) {
      if (!show.has(p)) continue;
      if (p - last > 1) nav.appendChild(h("span", { class: "mu", text: "…" }));
      nav.appendChild(h("button", { type: "button", "aria-current": p === S.page ? "page" : null, onclick: () => go(p) }, String(p)));
      last = p;
    }
    nav.appendChild(h("button", { type: "button", disabled: S.page === pages, onclick: () => go(S.page + 1), "aria-label": "Pagina successiva" }, "›"));
  }
  function countBy(items, fn) { const m = new Map(); for (const t of items) { const k = fn(t); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; }
  function facetBtn(label, n, pressed, onclick, pct) {
    const fill = pct === undefined ? null : h("span", { class: "fill" });
    if (fill) fill.style.width = `${pct}%`;
    return h("li", null, h("button", { type: "button", "aria-pressed": String(pressed), onclick }, fill, h("span", null, label), h("span", { class: "n", text: fmtN(n) })));
  }
  function facetBox(id, title, entries) {
    return h("div", { class: "facet", id }, h("h3", null, title), h("ul", null, entries));
  }
  function renderFacets() {
    const f = S.facet;
    const box = clear($("#facets"));
    for (const [k, title] of FACETS) {
      const c = new Map();
      for (const t of filterItems(k)) for (const v of fvals(t, k)) if (v && v !== "—") c.set(v, (c.get(v) || 0) + 1);
      for (const v of f[k]) if (!c.has(v)) c.set(v, 0);
      if (c.size < 2 && !f[k].size) continue;
      const ent = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15)
        .map(([v, n]) => facetBtn(v, n, f[k].has(v), () => { if (f[k].has(v)) f[k].delete(v); else f[k].add(v); S.page = 1; render(); }));
      box.appendChild(facetBox(`f-${k}`, title, ent));
    }
    const yc = countBy(filterItems("year"), (t) => (t.date || "").slice(0, 4));
    if (yc.size) {
      const ymax = Math.max(1, ...yc.values());
      box.appendChild(facetBox("f-year", "Anno di apertura", [...yc.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, n]) =>
        facetBtn(y, n, f.year === y, () => { f.year = f.year === y ? null : y; f.month = null; S.page = 1; render(); }, (n / ymax) * 100))));
    }
    if (f.year) {
      const mc = countBy(filterItems("month"), (t) => (t.date || "").slice(5, 7));
      const mmax = Math.max(1, ...mc.values());
      box.appendChild(facetBox("f-month", "Mese", [...mc.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([mm, n]) =>
        facetBtn(`${MESI[+mm - 1]} ${f.year}`, n, f.month === mm, () => { f.month = f.month === mm ? null : mm; S.page = 1; render(); }, (n / mmax) * 100))));
    }
    const tc = new Map();
    for (const t of filterItems("tags")) { const fv = S.favorites.get(t.key); if (fv) for (const g of fv.tags) tc.set(g, (tc.get(g) || 0) + 1); }
    if (tc.size || f.tags.size) {
      box.appendChild(facetBox("f-tag", "Etichette", [...tc.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) =>
        facetBtn(g, n, f.tags.has(g), () => { if (f.tags.has(g)) f.tags.delete(g); else f.tags.add(g); S.page = 1; render(); }))));
    }
    if (!box.children.length) box.appendChild(h("div", { class: "mu sm", text: S.searching ? "…" : "Nessun filtro disponibile." }));
    box.hidden = !S.results.length;
  }
  function renderActive() {
    const box = clear($("#active"));
    const f = S.facet;
    const chip = (label, rm) => box.appendChild(h("span", { class: "chip" }, label, h("button", { type: "button", "aria-label": `Rimuovi ${label}`, onclick: rm }, "×")));
    for (const [k, title] of FACETS) for (const v of f[k]) chip(`${title}: ${v}`, () => { f[k].delete(v); render(); });
    if (f.year) chip(`Anno: ${f.year}`, () => { f.year = null; f.month = null; render(); });
    if (f.month) chip(`Mese: ${MESI[+f.month - 1]}`, () => { f.month = null; render(); });
    for (const g of f.tags) chip(`Etichetta: ${g}`, () => { f.tags.delete(g); render(); });
    if (S.refine.trim()) chip(`Testo: ${S.refine.trim()}`, () => { $("#refine").value = ""; S.refine = ""; render(); });
    if (box.children.length > 1) box.appendChild(h("button", { type: "button", class: "btn gh s", onclick: () => { S.facet = emptyFacets(); $("#refine").value = ""; S.refine = ""; render(); } }, "Azzera filtri"));
  }

  // ===================================================================== esportazione
  const noFormula = (v) => { const x = v === null || v === undefined ? "" : String(v); return /^[=+\-@\t\r]/.test(x) ? "'" + x : x; };
  function cell(v) {
    const s = noFormula(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const CSV_HEAD = "ID;Data apertura;Ora;Ultimo aggiornamento;Stato;Priorità;Oggetto;Richiesta;Soluzione;Sede;Codice sede;Contatto;Servizio;Classificazione;Assegnato a;Gruppo;Responsabile;Modificato da;SLA;Tag;Nota;Etichette";
  function csvRow(t, f) {
    return [t.code, fmtDate(t.date), t.time, fmtDate(t.updated), t.status, t.priority, t.subject, t.preview, t.resolution, t.site, t.siteCode, t.contact, t.service, t.classification, t.assigned, t.group, t.owner, t.modifiers, t.sla, t.tags, f ? f.note : "", f ? f.tags.join(", ") : ""].map(cell).join(";");
  }
  const toCSV = (items) => "\ufeff" + [CSV_HEAD, ...items.map((t) => csvRow(t, S.favorites.get(t.key)))].join("\r\n");
  function clean(t) { const { _hay, ...rest } = t; return rest; }
  function doExport(kind) {
    $("#expm").hidden = true;
    const items = S.selected.size ? S.visible.filter((t) => S.selected.has(t.key)) : S.visible;
    if (!items.length) { toast("Nessun risultato da esportare"); return; }
    const stamp = isoOf(new Date());
    if (kind === "csv") download(`ticket-${stamp}.csv`, toCSV(items), "text/csv;charset=utf-8");
    else if (kind === "json") download(`ticket-${stamp}.json`, JSON.stringify({ spec: S.last, tickets: items.map(clean) }, null, 2), "application/json");
    else if (kind === "codes") copyText(items.map((t) => t.code || "").filter(Boolean).join("\n"), `Copiati ${fmtN(items.length)} ID`);
    else copyText(items.map((t) => [t.code, fmtDate(t.date), t.status, t.subject].map(noFormula).join("\t")).join("\n"), `Copiato elenco di ${fmtN(items.length)} ticket`);
  }

  // ===================================================================== preferiti, salvate, cronologia
  function updateFavCount() { $("#fav-count").textContent = S.favorites.size ? String(S.favorites.size) : ""; }
  function rerender() { if (!$("#tab-favorites").hidden) renderFavs(); else render(); }
  const favTicket = (t) => { const c = clean(t); delete c.rank; return c; };
  function toggleFav(t) {
    if (S.favorites.has(t.key)) { S.favorites.delete(t.key); toast("Rimosso dai preferiti"); }
    else { S.favorites.set(t.key, { key: t.key, ticket: favTicket(t), note: "", tags: [], updated: new Date().toISOString() }); toast("Aggiunto ai preferiti"); }
    saveFavs(); updateFavCount(); rerender();
  }
  let noteT = null;
  function openNote(t) {
    noteT = t;
    const f = S.favorites.get(t.key);
    $("#ntitle").textContent = `Nota per ${t.code || "il ticket"}`;
    $("#ntext").value = f ? f.note : ""; $("#ntags").value = f ? f.tags.join(", ") : ""; $("#nrem").hidden = !f;
    $("#dnote").showModal(); $("#ntext").focus();
  }
  for (const d of ["#dnote", "#dsave"]) $(d + ' button[value="cancel"]').addEventListener("click", () => $(d).close("cancel"));
  $("#nrem").addEventListener("click", () => {
    if (noteT) { S.favorites.delete(noteT.key); saveFavs(); updateFavCount(); rerender(); }
    $("#dnote").close("remove");
  });
  $("#dnote form").addEventListener("submit", () => {
    if (!noteT) return;
    S.favorites.set(noteT.key, { key: noteT.key, ticket: favTicket(noteT), note: $("#ntext").value.trim(), tags: [...new Set($("#ntags").value.split(",").map((x) => x.trim()).filter(Boolean))], updated: new Date().toISOString() });
    saveFavs(); updateFavCount(); rerender();
  });
  function favItems() {
    const r = parseRefine($("#ffilter").value);
    return [...S.favorites.values()].sort((a, b) => (b.updated || "").localeCompare(a.updated || "")).filter((f) => {
      const x = norm(`${hay(f.ticket)} ${f.note} ${f.tags.join(" ")}`);
      return r.inc.every((w) => x.includes(w)) && !r.exc.some((w) => x.includes(w));
    });
  }
  function renderFavs() {
    const box = clear($("#favs"));
    const items = favItems();
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: S.favorites.size ? "Nessun preferito corrisponde al filtro." : "Nessun preferito: usa ☆ sui risultati per salvarli qui, con note ed etichette." })); return; }
    for (const f of items) box.appendChild(ticketEl(f.ticket, true));
  }
  // ricerca salvata o della cronologia: si aspetta l'elenco All tickets prima di impostarla (gruppi, persone e stati)
  async function openSpec(s) {
    if (busy()) return false;
    tab("search");
    if (!currentModule()) { const p = ensureAllTickets(); previewNow(); await p; } // «Apro la scheda All tickets del portale…»
    applySpec(s);
    return true;
  }
  async function runSpec(s) { if (await openSpec(s)) runSearch({ people: s && s.people, pf: s && s.pf }); }
  function renderSaved() {
    const box = clear($("#saved"));
    const items = store.get("saved", []);
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: 'Nessuna ricerca salvata: usa "Salva ricerca" sotto la barra di ricerca.' })); return; }
    items.forEach((it, i) => box.appendChild(h("div", { class: "li" },
      h("div", { class: "m" }, h("div", { class: "t", text: it.name }), h("div", { class: "s", text: safeDescribe(it.spec) })),
      h("span", { class: "mu sm", text: fmtDT(it.created) }),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec) }, "Esegui"),
      h("button", { type: "button", class: "btn gh s", onclick: () => openSpec(it.spec) }, "Apri"),
      h("button", { type: "button", class: "btn gh s dg", onclick: () => { if (!confirm(`Eliminare la ricerca "${it.name}"?`)) return; const all = store.get("saved", []); all.splice(i, 1); store.set("saved", all); renderSaved(); } }, "Elimina"))));
  }
  function renderHistory() {
    const box = clear($("#hist"));
    const items = store.get("history", []);
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: "La cronologia è vuota." })); return; }
    for (const it of items) box.appendChild(h("div", { class: "li" },
      h("div", { class: "m" }, h("div", { class: "t", text: safeDescribe(it.spec) }), h("div", { class: "s", text: `${fmtDT(it.created)} · ${fmtN(it.results)} risultati${it.total > it.results ? ` su ${fmtN(it.total)}` : ""}` })),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec) }, "Ripeti"),
      h("button", { type: "button", class: "btn gh s", onclick: () => openSpec(it.spec) }, "Apri")));
  }
  $("#dsave form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const name = $("#sname").value.trim();
    if (!name) return;
    const all = store.get("saved", []);
    all.push({ name, spec: spec(), created: new Date().toISOString() });
    all.sort((a, b) => a.name.localeCompare(b.name, "it"));
    if (store.set("saved", all)) toast("Ricerca salvata"); else toast("Impossibile salvare (spazio del browser esaurito?)");
  });

  // ===================================================================== impostazioni e dati tecnici
  const names = (o) => { try { return o ? Object.keys(o).filter((k) => o[k]) : []; } catch { return []; } };
  function methodsOf(o) {
    const out = new Set();
    try {
      let p = o;
      for (let i = 0; p && i < 4; i++, p = Object.getPrototypeOf(p)) {
        if (p.$className && /^Ext\./.test(p.$className)) break;
        for (const k of Object.getOwnPropertyNames(p)) { try { if (typeof o[k] === "function" && /filter|search|load|refresh|apply|query|find|reset|clear/i.test(k)) out.add(k); } catch { /* */ } }
      }
    } catch { /* */ }
    return [...out].slice(0, 60);
  }
  function compTech(c) {
    if (!c) return null;
    let ctrl = null;
    try { ctrl = typeof c.getController === "function" ? c.getController() : c.controller || null; } catch { /* */ }
    return { cls: c.$className, xtype: c.xtype, rendered: !!c.rendered, listeners: names(c.hasListeners), methods: methodsOf(c), controller: ctrl && typeof ctrl === "object" ? { cls: ctrl.$className, methods: methodsOf(ctrl) } : ctrl ? String(ctrl) : null };
  }
  function moduleTech(m, keepSet) {
    const st = m.store;
    const t = { key: m.key, prefix: m.prefix, title: m.title, module: compTech(m.cmp), grid: compTech(m.grid) };
    try {
      const px = st.getProxy();
      const reader = px && px.getReader ? px.getReader() : null;
      t.store = {
        cls: st.$className, pageSize: st.getPageSize ? st.getPageSize() : st.pageSize, currentPage: st.currentPage, total: st.getTotalCount(), count: st.getCount(),
        remoteSort: st.getRemoteSort ? st.getRemoteSort() : st.remoteSort, remoteFilter: st.getRemoteFilter ? st.getRemoteFilter() : st.remoteFilter,
        sorters: (st.getSorters ? st.getSorters().getRange() : []).map((s) => ({ property: s.getProperty ? s.getProperty() : s.property, direction: s.getDirection ? s.getDirection() : s.direction })),
        filters: (st.getFilters ? st.getFilters().getRange() : []).map((f) => ({ property: f.getProperty ? f.getProperty() : f.property, operator: f.getOperator ? f.getOperator() : f.operator })),
        listeners: names(st.hasListeners),
        proxy: px ? {
          cls: px.$className, type: px.type, url: px.getUrl ? maskUrl(px.getUrl() || "", keepSet) : null, api: px.getApi ? maskDeep(px.getApi(), keepSet) : null,
          actionMethods: px.getActionMethods ? px.getActionMethods() : px.actionMethods, extraParams: maskDeep(px.getExtraParams ? px.getExtraParams() : px.extraParams, keepSet),
          pageParam: px.getPageParam && px.getPageParam(), startParam: px.getStartParam && px.getStartParam(), limitParam: px.getLimitParam && px.getLimitParam(),
          sortParam: px.getSortParam && px.getSortParam(), filterParam: px.getFilterParam && px.getFilterParam(), simpleSortMode: px.getSimpleSortMode && px.getSimpleSortMode(),
          paramsAsJson: px.getParamsAsJson && px.getParamsAsJson(), headers: names(px.getHeaders ? px.getHeaders() : px.headers),
          reader: reader ? { cls: reader.$className, rootProperty: reader.getRootProperty && reader.getRootProperty(), totalProperty: reader.getTotalProperty && reader.getTotalProperty(), successProperty: reader.getSuccessProperty && reader.getSuccessProperty() } : null,
        } : null,
      };
    } catch (e) { t.storeError = String(e && e.message); }
    try { const model = m.store.getModel ? m.store.getModel() : m.store.model; t.model = { cls: model && model.$className, idProperty: model && model.idProperty, fields: ((model && model.getFields && model.getFields()) || []).map((f) => `${f.name}:${f.type || (f.getType && f.getType()) || ""}`) }; } catch { /* */ }
    try {
      t.columns = gridColumns(m.grid).map((c) => ({ header: c.header, dataIndex: c.dataIndex, xtype: c.c.xtype, hidden: c.hidden, sem: c.sem, renderer: typeof c.c.renderer === "function", tpl: !!c.c.tpl }));
      const first = m.store.getAt(0);
      if (first) {
        const cols = gridColumns(m.grid);
        t.firstRowShape = cols.map((c) => { const p = cellParts(m, first, c, 0); return `${c.header}: ${p.parts.length} parti${p.title ? ", title " + p.title.length + " car. " + JSON.stringify(sections(p.title).map(([l]) => (SEC_LABEL_RE.test(l) ? l : maskDeep(l, keepSet)))) : ""}`; });
      }
    } catch (e) { t.columnsError = String(e && e.message); }
    t.filters = filterFields(m).map(({ suffix, f }) => {
      const opts = comboOptions(f);
      const controlled = suffix in CONTROLLED;
      let value = "";
      try { value = controlled ? maskDeep(f.getValue(), keepSet) : (fieldDisplay(f) ? "(impostato)" : ""); } catch { /* */ }
      const o = { suffix, cls: f.$className, xtype: f.xtype, name: f.getName ? f.getName() : f.name, label: fieldLabel(f, suffix), controlled, value, options: opts.length, sample: opts.slice(0, 20).map(([v, x]) => (controlled ? `${v}=${x}` : maskDeep(v, keepSet))), valueField: f.valueField, displayField: f.displayField, multi: !!f.multiSelect, listeners: names(f.hasListeners) };
      if (PEOPLE_KEYS.has(suffix)) {
        try {
          let st = null;
          try { st = typeof f.getStore === "function" ? f.getStore() : f.store || null; } catch { /* */ }
          const raw = f.getValue();
          Object.assign(o, {
            people: true, lookup: canLookup(f), readOnly: !!f.readOnly, editable: f.editable, queryMode: f.queryMode, queryParam: f.queryParam, minChars: f.minChars,
            forceSelection: f.forceSelection, valueType: Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw, valueKeys: raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).slice(0, 20) : null,
            value: maskDeep(scalarValue(f, raw), keepSet), triggers: names(f.getTriggers ? f.getTriggers() : f.triggers),
            store: st ? { cls: st.$className, tree: !!st.isTreeStore, count: typeof st.getCount === "function" ? st.getCount() : null, fields: (() => { try { return (st.getModel().getFields() || []).map((x) => x.name).slice(0, 30); } catch { return null; } })(), url: (() => { try { const px = st.getProxy(); return px && px.getUrl ? maskUrl(px.getUrl() || "", keepSet) : null; } catch { return null; } })() } : null,
            methods: methodsOf(f),
          });
        } catch { /* */ }
      }
      return o;
    });
    try { t.buttons = (m.cmp && m.cmp.query ? m.cmp.query("button") : []).map((b) => textOf(String((b.getText ? b.getText() : b.text) || b.tooltip || b.itemId || ""))).filter(Boolean).slice(0, 60); } catch { /* */ }
    return t;
  }
  const NAV_TAB_RE = /^(home|my tickets|my group tickets|tickets from my groups|all tickets?|tutti i ticket|tutti i tickets|registry|contacts)$/i;
  function techData() {
    const s = S.last || spec();
    const keepSet = new Set([s.text, s.subject, s.classif, s.classcli, ...wordsOf(s), ...(s.stCodes || []), ...(s.pr || [])].filter(Boolean).map((x) => norm(x).trim()));
    const m = currentModule();
    const req = (r) => ({ at: r.at, method: r.method, url: maskUrl(r.url, keepSet), params: maskDeep(r.params, keepSet), json: maskDeep(r.json, keepSet), body: r.body !== undefined ? maskBody(r.body, keepSet) : undefined, headers: r.headers, status: r.status, failed: r.failed, response: r.response });
    let ext = null;
    try { ext = Ext.getVersion().version; } catch { /* */ }
    return {
      tool: `Ricerca TKT ${VERSION} (segnalibro)`, page: location.origin + location.pathname, at: new Date().toISOString(), ext,
      portal: { Portal: !!window.Portal, PageManager: !!(window.Portal && window.Portal.PageManager), ActivityMonitor: !!(Ext.ux && Ext.ux.ActivityMonitor), dateFormat: (Ext.Date && Ext.Date.defaultFormat) || null },
      lists: S.modules.map((x) => ({ key: x.key, prefix: x.prefix, title: x.title, tab: x.tabText, body: x.bodyId, all: isAllList(x), grid: !!x.grid, store: !!x.store, rendered: x.rendered })),
      tabs: portalTabs().map((x) => ({ text: NAV_TAB_RE.test(x.text) || (x.card && /^body_/.test(x.card.id || "")) ? x.text : maskDeep(x.text, keepSet), card: x.card ? x.card.id : null, cardCls: x.card ? x.card.$className : null })),
      current: m ? moduleTech(m, keepSet) : null,
      lastSearch: conn.lastRun ? Object.assign({}, conn.lastRun, { spec: maskDeep(s, keepSet) }) : null,
      requests: conn.ext.slice(-12).map(req), xhr: conn.xhr.slice(-12).map(req), errors: conn.errors.slice(-10), settings: Object.assign({}, settings, { arUrl: settings.arUrl ? maskUrl(settings.arUrl, keepSet) : "" }),
      reader: conn.reader, touchUrl: touchTemplate() ? { field: touchTemplate().field, path: maskUrl(touchTemplate().tpl.replace("{v}", "0"), keepSet) } : null,
      ar: { state: AR.state, origin: AR.origin || null, fields: AR.info ? AR.info.fields || null : null, updDate: AR.info ? !!AR.info.updDate : null, lastSearch: S.info && S.info.ar ? S.info.ar : null },
    };
  }
  function renderSettings() {
    $("#s-cap").value = String(settings.cap);
    $("#s-arurl").value = settings.arUrl || AR_DEFAULT;
    const m = currentModule();
    const lines = [];
    let ver = "?";
    try { ver = Ext.getVersion().version; } catch { /* */ }
    lines.push(`Portale: ${location.origin}${location.pathname} · ExtJS ${ver}`);
    lines.push(`Elenchi di ticket nella pagina: ${S.modules.length ? S.modules.map((x) => `${x.title || x.key}${isAllList(x) ? " ← usato" : ""}${x.store ? "" : " (senza dati)"}`).join(", ") : "nessuno — apri la scheda «All tickets»"}`);
    if (m) {
      const cols = gridColumns(m.grid);
      lines.push(`Elenco usato: ${m.title} · ${(() => { try { return `${fmtN(m.store.getTotalCount())} ticket con i filtri attuali, ${fmtN(m.store.getCount())} caricati`; } catch { return "—"; } })()}`);
      lines.push(`Colonne riconosciute: ${cols.filter((c) => c.sem).map((c) => `${c.header}→${c.sem}`).join(", ") || "nessuna"}`);
      const ff = filterFields(m);
      lines.push(`Filtri della pagina gestiti: ${ff.filter((x) => x.suffix in CONTROLLED && CONTROLLED[x.suffix]).map((x) => x.suffix).join(", ") || "nessuno"}`);
      const st = comboOptions(m.field("StatusFilter"));
      lines.push(`Stati disponibili: ${st.length ? st.map(([, t]) => t).join(", ") : "—"}`);
      lines.push(`Gruppi e persone: ${PEOPLE.map(([k, l]) => { const f = m.field(k); return `${l.replace(/ \(.*$/, "")}: ${f ? (canLookup(f) ? "ricerca" : "menu") : "assente"}`; }).join(" · ")}`);
    }
    if (conn.lastRun) {
      const r = conn.lastRun;
      lines.push(`Ultima ricerca: ${fmtDT(r.at)} · avvio ${r.trigger || "—"} · ${r.loads} caricament${r.loads === 1 ? "o" : "i"} · ${(r.ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} s · filtri impostati: ${r.applied.join(", ") || "—"}${r.failed.length ? " · NON impostati: " + r.failed.join("; ") : ""} · testo nella richiesta: ${r.verified === null ? "non verificato" : r.verified ? "sì" : "NO"}`);
    }
    lines.push(`Richieste osservate: ${conn.ext.length} (ExtJS), ${conn.xhr.length} (XHR)`);
    const tp = touchTemplate();
    lines.push(`Pagina del ticket: ${tp ? `indirizzo imparato (dal dato «${tp.field}»)` : "indirizzo non ancora imparato (si impara al primo «Leggi» o «Apri in Touch»)"}${conn.reader ? ` · ultima lettura: ${conn.reader.via || conn.reader.how || "—"}, ${conn.reader.fields || 0} campi, ${conn.reader.texts || 0} testi` : ""}`);
    lines.push(`Area Riservata: ${AR.state === "on" ? `collegata (${AR.origin}${AR.info && AR.info.updDate ? ", periodo per data di aggiornamento" : ""})` : AR.state === "waiting" ? "in attesa del segnalibro nella sua scheda" : "non collegata"}`);
    $("#conninfo").textContent = lines.join("\n");
  }
  $("#tread").addEventListener("click", () => {
    const out = $("#treadout");
    out.hidden = false;
    const m = currentModule();
    if (!m) { out.textContent = "Nessun elenco di ticket trovato nella pagina."; return; }
    try {
      const r = readStore(m);
      out.textContent = [`${m.title}: ${fmtN(r.tickets.length)} righe caricate su ${fmtN(r.total)} (pagina ${r.page}, ${r.pageSize} per pagina)`, ""].concat(
        r.tickets.slice(0, 3).map((t) => `${t.code || "(ID?)"} · ${fmtDate(t.date)} ${t.time || ""} · ${t.status || "(stato?)"} · ${t.subject || "(oggetto?)"}\n  richiesta: ${(t.preview || "—").slice(0, 160)}\n  sede: ${t.site || "—"} · servizio: ${t.service || "—"} · aggiornato: ${fmtDate(t.updated) || "—"}`)).join("\n");
    } catch (e) { out.textContent = `Errore: ${e && e.message}`; }
  });
  $("#ssave").addEventListener("click", () => {
    settings.cap = CAPS.includes(+$("#s-cap").value) ? +$("#s-cap").value : 200;
    { const u = absUrl($("#s-arurl").value.trim()); if (u) settings.arUrl = u; else if (!$("#s-arurl").value.trim()) settings.arUrl = AR_DEFAULT; }
    store.set("settings", settings);
    $("#capq").value = String(settings.cap);
    $$(".capn").forEach((x) => { x.textContent = settings.cap; });
    preview();
    toast("Impostazioni salvate");
  });
  $("#tcopy").addEventListener("click", () => copyText(JSON.stringify(techData(), null, 2), "Dati tecnici copiati"));
  $("#tdl").addEventListener("click", () => download("ricerca-tkt-dati-tecnici.json", JSON.stringify(techData(), null, 2), "application/json"));
  $("#pexp").addEventListener("click", () => download("ricerca-tkt-dati-personali.json", JSON.stringify({ version: VERSION, favorites: [...S.favorites.values()], saved: store.get("saved", []), history: store.get("history", []), settings }, null, 2), "application/json"));
  const str = (v, max = 2000) => (v === null || v === undefined ? "" : String(v)).slice(0, max);
  const TKEYS = ["code", "recId", "list", "date", "time", "updated", "updTime", "subject", "preview", "resolution", "site", "siteCode", "contact", "status", "priority", "service", "classification", "assigned", "group", "owner", "modifiers", "sender", "sla", "tags", "source", "number", "product", "arRef"];
  function importTicket(t, key) {
    const o = { key: str(key, 300) };
    for (const k of TKEYS) if (t[k] !== undefined && t[k] !== null) o[k] = str(t[k], k === "preview" || k === "resolution" ? 6000 : 500);
    for (const k of ["date", "updated"]) if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) delete o[k];
    if (t.src === "ar") { o.src = "ar"; o.source = "Area Riservata"; }
    // collegamenti solo http(s); quelli dell'Area Riservata solo verso il suo sito
    if (typeof t.url === "string") { try { const u = new URL(t.url); if (/^https?:$/.test(u.protocol) && (o.src !== "ar" || u.origin === arOriginOf())) o.url = u.href; } catch { /* */ } }
    if (t.ref && typeof t.ref === "object") { const [k, v] = Object.entries(t.ref)[0] || []; if (k && /^\w{1,60}$/.test(k)) o.ref = { [k]: str(v, 100) }; }
    o.cols = Array.isArray(t.cols) ? t.cols.slice(0, 60).map((c) => ({ h: str(c && c.h, 100), v: str(c && c.v, 2000) })) : [];
    return o;
  }
  // ricerche importate: solo i campi noti, con i tipi giusti (un file modificato a mano non deve rompere gli elenchi)
  const strList = (a) => (Array.isArray(a) ? a.slice(0, 100).map((x) => str(x, 100)).filter(Boolean) : []);
  const isoDay = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  function importSpec(sp) {
    if (!sp || typeof sp !== "object" || Array.isArray(sp)) return null;
    const people = {};
    const src = sp.people && typeof sp.people === "object" ? sp.people : {};
    for (const [k] of PEOPLE) {
      const p = src[k];
      const v = p && typeof p === "object" && (typeof p.v === "string" || typeof p.v === "number") ? str(p.v, 100) : "";
      if (v) people[k] = { v, t: textOf(str(p.t, 200)).replace(/[<>"`]/g, "") || v };
    }
    const pf = {};
    const srcPf = sp.pf && typeof sp.pf === "object" && !Array.isArray(sp.pf) ? sp.pf : {};
    for (const [k, p] of Object.entries(srcPf).slice(0, 40)) {
      if (!/^\w{1,60}$/.test(k) || (k in CONTROLLED) || PEOPLE_KEYS.has(k) || !p || typeof p !== "object") continue;
      const v = Array.isArray(p.v) ? strList(p.v).slice(0, 50) : typeof p.v === "string" || typeof p.v === "number" ? str(p.v, 200) : "";
      if (v && v.length) pf[k] = { v, t: textOf(str(p.t, 300)).replace(/[<>"`]/g, "") || (Array.isArray(v) ? v.join(", ") : v) };
    }
    // stesso ordine delle chiavi di spec(): serve al confronto dei doppioni
    return {
      text: str(sp.text, 500), subject: str(sp.subject, 500), exclude: str(sp.exclude, 500), allWords: sp.allWords === true,
      dfrom: isoDay(sp.dfrom), dto: isoDay(sp.dto), ufrom: isoDay(sp.ufrom), uto: isoDay(sp.uto),
      st: ["all", "open", "closed", "custom", "page"].includes(sp.st) ? sp.st : "all", stCodes: strList(sp.stCodes), pr: strList(sp.pr),
      classif: str(sp.classif, 500), classcli: str(sp.classcli, 500), people, pf,
    };
  }
  const specKey = (sp) => { try { return JSON.stringify(importSpec(sp)); } catch { return ""; } };
  $("#pimp").addEventListener("change", async () => {
    const inp = $("#pimp");
    const file = inp.files[0];
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      let nf = 0, ns = 0, nh = 0;
      if (Array.isArray(d.favorites)) {
        for (const f of d.favorites) {
          if (!f || !f.key || !f.ticket || typeof f.ticket !== "object") continue;
          const key = str(f.key, 300);
          S.favorites.set(key, { key, ticket: importTicket(f.ticket, key), note: str(f.note, 10000), tags: Array.isArray(f.tags) ? f.tags.map((x) => str(x, 40)).filter(Boolean) : [], updated: str(f.updated, 40) });
          nf++;
        }
        saveFavs();
      }
      if (Array.isArray(d.saved)) {
        const cur = store.get("saved", []);
        const k = (x) => `${x.name}\u0001${specKey(x.spec)}`;
        const seen = new Set(cur.map(k));
        for (const x of d.saved) {
          const spc = x && typeof x === "object" && x.name && importSpec(x.spec);
          if (!spc) continue;
          const item = { name: str(x.name, 200), spec: spc, created: str(x.created, 40) };
          if (!seen.has(k(item))) { seen.add(k(item)); cur.push(item); ns++; }
        }
        cur.sort((a, b) => a.name.localeCompare(b.name, "it"));
        store.set("saved", cur);
      }
      if (Array.isArray(d.history)) {
        const cur = store.get("history", []);
        const k = (x) => `${x.created}\u0001${specKey(x.spec)}`;
        const seen = new Set(cur.map(k));
        for (const x of d.history) {
          const spc = x && typeof x === "object" && importSpec(x.spec);
          if (!spc) continue;
          const item = { spec: spc, results: parseInt(x.results, 10) || 0, total: parseInt(x.total, 10) || 0, created: str(x.created, 40) };
          if (!seen.has(k(item))) { seen.add(k(item)); cur.push(item); nh++; }
        }
        cur.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
        store.set("history", cur.slice(0, 200));
      }
      if (d.settings && typeof d.settings === "object") {
        if (CAPS.includes(+d.settings.cap)) settings.cap = +d.settings.cap;
        if (typeof d.settings.list === "string") settings.list = d.settings.list.slice(0, 100);
        store.set("settings", settings);
        renderSettings(); preview();
      }
      updateFavCount(); refreshHistList();
      toast(`Importati: ${nf} preferiti, ${ns} ricerche salvate, ${nh} voci di cronologia`);
    } catch { toast("File non valido"); } finally { inp.value = ""; }
  });
  $("#pdel").addEventListener("click", () => {
    if (!confirm("Cancellare preferiti, note, ricerche salvate e cronologia da questo browser?")) return;
    S.favorites.clear(); saveFavs(); store.set("saved", []); store.set("history", []); updateFavCount(); refreshHistList(); toast("Dati personali cancellati");
  });
  $("#fexp").addEventListener("click", () => {
    const items = favItems();
    download("preferiti.csv", "\ufeff" + [CSV_HEAD, ...items.map((f) => csvRow(f.ticket, f))].join("\r\n"), "text/csv;charset=utf-8");
  });

  // ===================================================================== navigazione ed eventi
  function tab(name) {
    $$("#nav button").forEach((b) => (b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    for (const sec of $$("section[id^=tab-]")) sec.hidden = sec.id !== `tab-${name}`;
    if (name === "saved") renderSaved(); else if (name === "history") renderHistory(); else if (name === "favorites") renderFavs(); else if (name === "settings") renderSettings(); else render();
  }
  $$("#nav button").forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab)));
  $("#sf").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
  $("#sf").addEventListener("input", (e) => { if (e.target.id === "dfrom" || e.target.id === "dto") $("#preset").value = "custom"; onFormChange(); });
  $("#sf").addEventListener("change", onFormChange);
  $("#preset").addEventListener("change", () => { preset($("#preset").value); onFormChange(); });
  $("#st").addEventListener("change", () => {
    $("#st-box").hidden = $("#st").value !== "custom";
    if ($("#st").value === "custom") { $("#adv").open = true; if (!S.stCodes.size) for (const [v] of S.stOpts || []) S.stCodes.add(v); renderToggles(); }
  });
  $("#capq").addEventListener("change", () => {
    settings.cap = CAPS.includes(+$("#capq").value) ? +$("#capq").value : 200;
    store.set("settings", settings);
    $$(".capn").forEach((x) => { x.textContent = settings.cap; });
    preview();
  });
  $$("[data-sel]").forEach((b) => b.addEventListener("click", () => {
    const what = b.dataset.sel.split(":")[1];
    S.stCodes = new Set((S.stOpts || []).filter(([, t]) => what === "all" || (what === "open" && !CLOSED_RE.test(t)) || (what === "closed" && CLOSED_RE.test(t))).map(([v]) => v));
    renderToggles(); onFormChange();
  }));
  $("#qreset").addEventListener("click", () => { if (busy()) return; applySpec({ people: {}, pf: {} }); $("#q").focus(); });
  $("#qsave").addEventListener("click", () => { const s = spec(); $("#sname").value = s.text || s.subject || ""; $("#dsave").showModal(); $("#sname").select(); });
  $("#stop").addEventListener("click", () => S.abort && S.abort.abort());
  $("#qrestore").addEventListener("click", async () => {
    const m = currentModule();
    const sn = m && S.snaps[m.key];
    if (!sn || S.searching) return;
    S.searching = true; $("#go").disabled = true; $("#qrestore").disabled = true;
    try {
      const missed = await restoreSnapshot(m, sn);
      delete S.snaps[m.key];
      toast(missed.length ? `Filtri ripristinati tranne: ${missed.join(", ")} (rimettili nel portale)` : "Filtri dell'elenco del portale ripristinati");
    } catch (e) { toast(e && e.message ? e.message : "Ripristino non riuscito"); }
    finally { S.searching = false; $("#go").disabled = false; $("#qrestore").disabled = false; renderToggles(); preview(); render(); }
  });
  $("#ar-connect").addEventListener("click", arConnect);
  $("#src-ar").addEventListener("change", () => { settings.arOn = $("#src-ar").checked; store.set("settings", settings); previewNow(); });
  $("#rclose").addEventListener("click", () => $("#dread").close());
  $("#dread").addEventListener("close", () => { if (readCtrl) readCtrl.abort(); readCtrl = null; });
  $("#ropen").addEventListener("click", () => { if (readT) openTicket(readT); });
  $("#rcopy").addEventListener("click", () => { if (readT) copyText(readText(readT, READ.get(readT.key)), "Testo del ticket copiato"); });
  $("#refine").addEventListener("input", debounce(() => { S.refine = $("#refine").value; S.page = 1; render(); }, 150));
  $("#sort").addEventListener("change", () => { S.sort = $("#sort").value; S.page = 1; render(); });
  $("#group").addEventListener("change", () => { S.group = $("#group").value; S.page = 1; render(); });
  $("#psize").addEventListener("change", () => { S.size = +$("#psize").value; S.page = 1; render(); });
  $("#selall").addEventListener("change", () => { for (const t of S.pageItems) { if ($("#selall").checked) S.selected.add(t.key); else S.selected.delete(t.key); } render(); });
  $("#exp").addEventListener("click", (e) => { e.stopPropagation(); $("#expm").hidden = !$("#expm").hidden; });
  root.addEventListener("click", () => { $("#expm").hidden = true; });
  $$("#expm button").forEach((b) => b.addEventListener("click", () => doExport(b.dataset.x)));
  $("#hclear").addEventListener("click", () => { if (confirm("Svuotare la cronologia?")) { store.set("history", []); renderHistory(); refreshHistList(); } });
  $("#ffilter").addEventListener("input", debounce(renderFavs, 150));

  function show() {
    if (pickCleanup) pickCleanup(); // tornando al pannello per qualsiasi strada la scelta nel portale finisce
    conn.on = true;
    host.style.display = ""; document.documentElement.style.overflow = "hidden"; if (document.body) document.body.inert = true;
    renderToggles(); renderArState(); previewNow();
    $("#capq").value = String(settings.cap);
    if (!$("#tab-settings").hidden) renderSettings();
    if (!currentModule() && allTab()) { ensureAllTickets().then(() => { renderToggles(); preview(); }); previewNow(); }
    activity(true);
    setTimeout(() => $("#q").focus(), 0);
  }
  function hide() {
    if (S.abort) S.abort.abort();
    root.querySelectorAll("dialog[open]").forEach((d) => d.close());
    host.style.display = "none";
    conn.on = false;
    document.documentElement.style.overflow = prevOverflow;
    if (document.body) document.body.inert = prevInert;
  }
  $("#close").addEventListener("click", hide);
  // eventi da tastiera: restano dentro il pannello (non arrivano al portale)
  const keyHandler = (e) => {
    if (host.style.display === "none") return;
    activity();
    const inner = e.composedPath()[0] || e.target;
    const tag = (inner.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape" && !root.querySelector("dialog[open]")) { e.preventDefault(); if (S.searching && S.abort) S.abort.abort(); else hide(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); tab("search"); $("#q").focus(); $("#q").select(); }
    e.stopPropagation();
  };
  host.addEventListener("keydown", keyHandler);
  host.addEventListener("pointerdown", () => activity());
  document.addEventListener("keydown", (e) => { if (host.style.display !== "none" && e.key === "Escape" && e.target === document.body) keyHandler(e); }, true);

  window[NS] = { toggle() { if (host.style.display === "none") show(); else hide(); }, version: VERSION };

  // avvio
  $$(".capn").forEach((x) => { x.textContent = settings.cap; });
  updateFavCount();
  refreshHistList();
  show();
  if (!currentModule() && !allTab()) toast("Non trovo l'elenco «All tickets» del portale: aprilo una volta dalla barra delle schede e riapri il segnalibro");

  } catch (err) {
    try { console.error("Ricerca TKT", err); } catch { /* */ }
    alert(`Ricerca TKT non è riuscito ad avviarsi su questa pagina.\n\n${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n") : err}\n\nCopia questo messaggio e invialo per la correzione.`);
  }
})();
