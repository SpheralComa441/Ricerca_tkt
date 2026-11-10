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
    const notify = () => {
      try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
      try { if (typeof f.fireEvent === "function") f.fireEvent("select", f); } catch { /* */ }
    };
    if (sameList(asList(f.getValue()), codes)) return true;
    const attempts = codes.length
      ? [() => f.setValue(codes.slice()), () => f.setValue(codes.join(",")), () => {
        const st = f.getStore();
        f.setValue(codes.map((c) => st.findRecord(f.valueField || "value", c, 0, false, true, true)).filter(Boolean));
      }]
      : [() => (typeof f.clearValue === "function" ? f.clearValue() : f.setValue(null)), () => f.setValue([]), () => f.setValue("")];
    for (const a of attempts) { try { a(); if (sameList(asList(f.getValue()), codes)) { notify(); return true; } } catch { /* prova il successivo */ } }
    return false;
  }
  function setText(f, v) {
    const cur = f.getValue();
    if (String(cur === null || cur === undefined ? "" : cur) === v) return true;
    f.setValue(v);
    try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
    return String(f.getValue() ?? "") === v;
  }
  const toDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  function setDate(f, iso) {
    const d = toDate(iso);
    const cur = f.getValue();
    if ((!d && !cur) || (d && isDate(cur) && isoOf(cur) === iso)) return true;
    f.setValue(d);
    try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
    try { if (typeof f.fireEvent === "function") f.fireEvent("select", f, d); } catch { /* */ }
    const now = f.getValue();
    return d ? isDate(now) && isoOf(now) === iso : !now;
  }
  const fieldLabel = (f, fb) => { try { return textOf(String((typeof f.getFieldLabel === "function" ? f.getFieldLabel() : f.fieldLabel) || f.emptyText || fb)); } catch { return fb; } };
  // Nei campi objectlink-field e combo-field di Touch il valore interno o l'input nascosto può essere JSON:
  // [{"value":"C349471X","text":"COOPERATIVA SERVIZI ELABORAZIONE","index":0}]
  function parseJsonValue(raw) {
    if (raw === null || raw === undefined) return null;
    let arr = raw;
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s.startsWith("[") && !s.startsWith("{")) return null;
      try { arr = JSON.parse(s); } catch { return null; }
    }
    const items = (Array.isArray(arr) ? arr : [arr]).filter((x) => x && typeof x === "object" && ("value" in x || "Value" in x || "text" in x || "Text" in x));
    if (!items.length) return null;
    const vals = items.map((x) => String(x.value ?? x.Value ?? "")).filter(Boolean);
    const txts = items.map((x) => textOf(String(x.text ?? x.Text ?? x.value ?? x.Value ?? ""))).filter(Boolean);
    if (!vals.length) return { v: "", t: "" };
    return { v: vals[0], vals, t: txts.join(", ") || vals.join(", ") };
  }
  function fieldDisplay(f) {
    try {
      const raw = typeof f.getRawValue === "function" ? f.getRawValue() : "";
      if (raw && String(raw).trim()) {
        const j = parseJsonValue(raw);
        if (j) return j.t;
        return String(raw).trim();
      }
      // In Touch gli objectlink-field salvano {value,text} in un <input type="hidden"> dentro il componente
      try {
        const dom = f && f.el && f.el.dom;
        if (dom) {
          for (const inp of dom.querySelectorAll('input[type="hidden"]')) {
            const j = parseJsonValue(inp.value);
            if (j && j.t) return j.t;
          }
        }
      } catch { /* */ }
      const v = f.getValue();
      const jv = parseJsonValue(v);
      if (jv) return jv.t;
      if (isDate(v)) return fmtDate(isoOf(v));
      if (Array.isArray(v)) return v.length ? v.join(", ") : "";
      if (v && typeof v === "object") return String(v.text || v.Text || v.Description || "");
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
    ["AssignedUserOrGroupFilter", "Assegnato a (Assigned to)"],
    ["OwnerUserGroupID", "Gruppo proprietario (Owner group)"],
    ["ModifiedBy", "Modificato da (Modified by)"],
    ["OwnerUserID", "Responsabile (Resource Owner)"],
  ];
  const PEOPLE_KEYS = new Set(PEOPLE.map(([k]) => k));
  // Etichette chiare (italiano + nome Touch) e ordine logico per tutti gli altri filtri di Touch (sia All tickets sia My Group Tickets)
  const PF_META = {
    ServiceFilter: { label: "Servizio (Service)", short: "Service", group: "client", order: 1, hint: "Albero dei servizi / prodotti" },
    ServiceID: { label: "Servizio (Service)", short: "Service", group: "client", order: 1, hint: "Albero dei servizi / prodotti" },
    ServiceCenter: { label: "Centro servizi (Service center)", short: "Service center", group: "client", order: 2, hint: "Scrivi almeno 2 lettere per cercare" },
    AccountID: { label: "Sede / Cliente (Site)", short: "Site", group: "client", order: 3, hint: "Ragione sociale o codice sede" },
    RefAccountID: { label: "Sede / Cliente (Site)", short: "Site", group: "client", order: 3, hint: "Ragione sociale o codice sede" },
    DeliverySite: { label: "Sede operativa (Delivery site)", short: "Delivery site", group: "client", order: 4, hint: "Sede di consegna / operativa" },
    ContactFilter: { label: "Contatto (Contact)", short: "Contact", group: "client", order: 5, hint: "Persona di riferimento del ticket" },
    ReferenceID: { label: "Contatto (Contact)", short: "Contact", group: "client", order: 5, hint: "Persona di riferimento del ticket" },
    OriginalClientID: { label: "Cliente finale (End customer)", short: "End customer", group: "client", order: 6, hint: "Cliente finale indiretto" },
    OriginalContactID: { label: "Contatto cliente finale (End customer contact)", short: "End customer contact", group: "client", order: 7, hint: "Referente del cliente finale" },
    SupplierID: { label: "Fornitore (Supplier)", short: "Supplier", group: "client", order: 8, hint: "Fornitore associato al ticket" },
    CustomerTop: { label: "Top Client", short: "Top Client", group: "client", order: 9, hint: "Cliente prioritario" },
    ObjectTypeFilter: { label: "Tipo oggetto (Object type)", short: "Object type", group: "class", order: 10, hint: "Incident, Request, ecc." },
    TicketCategoryID: { label: "Categoria ticket (Ticket category)", short: "Ticket category", group: "class", order: 11, hint: "Albero categorie del ticket" },
    CatalogFolder: { label: "Cartella di classificazione (Classification folder)", short: "Classification folder", group: "class", order: 12, hint: "Albero cartelle di classificazione" },
    CatalogItem: { label: "Voce di classificazione (Classification)", short: "Classification", group: "class", order: 13, hint: "Scrivi almeno 2 lettere per cercare" },
    CatalogItemID: { label: "Voce di classificazione (Classification)", short: "Classification", group: "class", order: 13, hint: "Scelta dall'albero di classificazione" },
    ClassCli: { label: "Voce classif. cliente (Customer class.)", short: "Customer class.", group: "class", order: 14, hint: "Scelta dall'albero cliente" },
    TagFilter: { label: "Tag / Etichette (Tags)", short: "Tags", group: "extra", order: 15, hint: "Etichette del ticket nel portale" },
    Tags: { label: "Tag / Etichette (Tags)", short: "Tags", group: "extra", order: 15, hint: "Etichette del ticket nel portale" },
    TicketSource: { label: "Origine ticket (Ticket Source)", short: "Ticket Source", group: "extra", order: 16, hint: "es. Customer, Intern, Automatic" },
    Channel: { label: "Canale (Channel)", short: "Channel", group: "extra", order: 17, hint: "es. Web, Phone, E-Mail" },
    FlagSollecito: { label: "Sollecitato (Solicited)", short: "Solicited", group: "extra", order: 18, hint: "Yes / No" },
    Escalated: { label: "Escalated", short: "Escalated", group: "extra", order: 20 },
    WorkingStatus: { label: "Stato lavorazione (Working status)", short: "Working status", group: "extra", order: 21 },
    AssignedUserGroupID: { label: "Gruppo assegnatario (Assigned to group)", short: "Assigned to group", group: "other", order: 22 },
    AssignedUserID: { label: "Utente assegnatario (Assigned to user)", short: "Assigned to user", group: "other", order: 23 },
  };
  function scalarValue(f, v) {
    const j = parseJsonValue(v);
    if (j) return j.v;
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object") {
      try { if (typeof v.get === "function") return String(v.get(f.valueField || "value") ?? ""); } catch { /* */ }
      return String(v.value ?? v.id ?? v.Value ?? v.ID ?? "");
    }
    if (v === null || v === undefined) {
      try {
        const dom = f && f.el && f.el.dom;
        if (dom) {
          for (const inp of dom.querySelectorAll('input[type="hidden"]')) {
            const jh = parseJsonValue(inp.value);
            if (jh && jh.v) return jh.v;
          }
        }
      } catch { /* */ }
      return "";
    }
    return String(v);
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
  function syncHiddenJson(f, code, label) {
    try {
      const dom = f && f.el && f.el.dom;
      if (!dom) return;
      const jStr = code ? JSON.stringify([{ value: code, text: label || code, index: 0 }]) : '[{"value":"","text":"","index":0}]';
      for (const inp of dom.querySelectorAll('input[type="hidden"]')) {
        if (/^\s*\[\s*\{/.test(inp.value || "")) inp.value = jStr;
      }
    } catch { /* */ }
  }
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
    // campi ad albero (tree-field di Touch o Fake.TreeField): il valore è il codice del nodo
    const ts = (st && st.isTreeStore ? st : null) || treeStoreOf(f);
    if (ts) {
      // un TreePicker / TreeField non segnala il cambio da solo: checkChange e select avvisano il portale
      const changed = () => {
        try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
        try { if (typeof f.fireEvent === "function") f.fireEvent("select", f); } catch { /* */ }
      };
      try {
        if (typeof f.setValueBase === "function") {
          f.setValueBase(code, [label], false);
          if (f.component && f.component.rendered && typeof f.updateTreeSelection === "function") {
            try { f.updateTreeSelection(code); } catch { /* */ }
          }
          changed();
          if (same()) return true;
        }
      } catch { /* */ }
      try { f.setValue(code, label, false); changed(); if (same()) return true; } catch { /* */ }
      try { f.setValue(code); changed(); if (same()) return true; } catch { /* */ }
      try { const n = ts.getNodeById(code); if (n) { f.setValue(n); changed(); if (same() && typeof f.getValue() !== "object") return true; } } catch { /* */ }
      try { f.setValue(code); changed(); } catch { /* */ }
      return same();
    }
    // con l'elenco del campo non caricato setValue(codice) non segnala il cambio: checkChange lo fa (solo se è cambiato)
    const signal = (rec) => {
      syncHiddenJson(f, code, label);
      try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
      try { if (typeof f.fireEvent === "function") f.fireEvent("select", f, rec); } catch { /* */ }
    };
    try { const r = st && typeof st.findRecord === "function" ? st.findRecord(vf, code, 0, false, true, true) : null; if (r) { f.setValue(r); if (same()) { signal(r); return true; } } } catch { /* */ }
    try {
      f.setValue(code);
      if (same()) {
        // elenco del campo mai caricato (pagina nuova): Ext tiene il codice ma il campo resta vuoto; con il nome noto si mostra quello
        if (!raw() && label !== code && !asRecord()) { try { f.setValue(code); } catch { /* */ } }
        signal();
        return same();
      }
    } catch { /* */ }
    if (asRecord()) { signal(); return true; }
    try {
      if (plain && typeof st.add === "function") {
        const [r] = st.add({ [vf]: code, [df]: label });
        f.setValue(r);
        if (same()) { signal(r); return true; }
        try { st.remove(r); } catch { /* */ }
      }
    } catch { /* */ }
    // objectlink-field di Touch con stato JSON salvato nel campo o nell'input nascosto
    try {
      const jStr = JSON.stringify([{ value: code, text: label, index: 0 }]);
      f.setValue(jStr);
      if (typeof f.setRawValue === "function") f.setRawValue(label);
      if (same()) { signal(); return true; }
    } catch { /* */ }
    return false;
  }
  function clearField(f) {
    try {
      if (typeof f.clear === "function" && f.component) {
        f.clear();
        if (f.component.rendered && typeof f.component.clearChecked === "function") {
          try { f.component.suspendEvents(); f.component.clearChecked(); f.component.resumeEvents(); } catch { /* */ }
        }
      } else if (typeof f.clearValue === "function") f.clearValue();
      else f.setValue(null);
    } catch { try { f.setValue(""); } catch { /* */ } }
    syncHiddenJson(f, "", "");
    try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
    try { if (typeof f.fireEvent === "function") f.fireEvent("select", f); } catch { /* */ }
  }
  // ===================================================================== tutti i filtri del portale nel pannello
  // Tipo di ogni campo filtro: albero (tree-field), ricerca sul server (objectlink), elenco (combo con le
  // scelte già nella pagina), data o testo. I valori sono i codici del portale, con il nome per mostrarli.
  const clsOf = (f) => { try { return `${f.cls || ""} ${f.userCls || ""} ${f.el && f.el.dom ? f.el.dom.className : ""}`; } catch { return ""; } };
  function treeStoreOf(f) {
    const gets = [
      () => f.getStore && f.getStore(),
      () => f.store,
      () => f.treeStore,
      () => f.component && f.component.getStore && f.component.getStore(),
      () => f.component && f.component.store,
      () => f.picker && f.picker.getStore && f.picker.getStore(),
      () => f.getPicker && f.getPicker() && f.getPicker().getStore && f.getPicker().getStore(),
      () => f.tree && f.tree.getStore && f.tree.getStore(),
    ];
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
  // campi filtro gestiti dal pannello (oltre a quelli della barra di ricerca): gruppi e persone prima, poi in ordine logico Touch
  function pfFields(m) {
    const all = filterFields(m).filter(({ suffix }) => !(suffix in CONTROLLED)).map((x) => Object.assign(x, { kind: fieldKind(x.f) })).filter((x) => x.kind !== "hidden");
    const rank = (x) => {
      const pi = PEOPLE.findIndex(([k]) => k === x.suffix);
      if (pi >= 0) return pi;
      const meta = PF_META[x.suffix];
      return meta ? 10 + meta.order : 100;
    };
    return all.map((x, i) => {
      const meta = PF_META[x.suffix];
      const label = PEOPLE_KEYS.has(x.suffix)
        ? PEOPLE.find(([k]) => k === x.suffix)[1]
        : (meta && meta.label) || fieldLabel(x.f, x.suffix);
      return Object.assign(x, { i, label, short: (meta && meta.short) || fieldLabel(x.f, x.suffix) || label, hint: (meta && meta.hint) || "", group: PEOPLE_KEYS.has(x.suffix) ? "people" : (meta && meta.group) || "other" });
    }).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  }
  const isMulti = (f) => !!(f && (f.multiSelect || /\b(multiComboField|multicombo-field|static-objectlink-multi-field|x-tagcombo)\b/i.test(clsOf(f))));
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
        if (PEOPLE_KEYS.has(x.suffix)) continue;
        const want = s.pf[x.suffix];
        doSet(x.suffix, !!want, (f) => setPf(f, want, x.kind));
      }
      const have = new Set(pfFields(m).map((x) => x.suffix));
      for (const [k, want] of Object.entries(s.pf)) if (want && !PEOPLE_KEYS.has(k) && !have.has(k)) run.failed.push(`${k}: campo non trovato`);
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
          else if (v === null || v === undefined || v === "" || emptyJson(v)) clearField(f);
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
        if (parts.length > 1 && !t.counters) t.counters = parts.slice(1).filter(Boolean);
      } else if (sem === "service") {
        if (!t.service) t.service = parts.length > 1 ? parts.join(" / ") : text;
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
  // Schede di dettaglio ticket aperte dentro la stessa pagina di HDA TOUCH (_UC_DetailCt o _UC_DetailViewCt)
  const DETAIL_RE = /_UC_Detail(View)?Ct$/;
  function findDetailModules(w) {
    w = w || window;
    const doc = w.document, X = w.Ext;
    const ids = new Set();
    if (doc) {
      for (const el of doc.querySelectorAll('[id$="_UC_DetailCt"],[id$="_UC_DetailViewCt"],.detail-content-wrapper.detail')) {
        if (el.id) ids.add(el.id);
      }
    }
    if (X && X.ComponentManager) {
      try {
        const all = typeof X.ComponentManager.getAll === "function" ? X.ComponentManager.getAll() : Object.values((X.ComponentManager.all && X.ComponentManager.all.map) || {});
        for (const c of all) if (c && typeof c.id === "string" && DETAIL_RE.test(c.id)) ids.add(c.id);
      } catch { /* */ }
    }
    const out = [];
    for (const id of ids) {
      const cmp = X && typeof X.getCmp === "function" ? X.getCmp(id) : null;
      const el = (doc && doc.getElementById(id)) || (cmp && cmp.el && cmp.el.dom) || null;
      const m = /^(.+)_UC_Detail(View)?Ct$/.exec(id);
      const prefix = m ? m[1] : "";
      const P = prefix ? prefix + "_UC_" : "";
      let titleText = "";
      try {
        const tel = el && el.querySelector(".detail-title-text,[id$='_UC_Title']");
        if (tel) titleText = textOf(tel.textContent || "");
      } catch { /* */ }
      if (!titleText && X && P) {
        try { const tc = X.getCmp(P + "Title"); if (tc) titleText = textOf(String(tc.text || (tc.el && tc.el.dom && tc.el.dom.textContent) || "")); } catch { /* */ }
      }
      let code = "";
      const cm = /^([A-Z0-9_-]{3,24})\s*:/.exec(titleText);
      if (cm) code = cm[1];
      if (!code && el) {
        try {
          const cinp = el.querySelector('input[id$="_Code_inputEl"],[id$="_secGeneral_Code"] input');
          if (cinp && cinp.value) code = cinp.value.trim();
        } catch { /* */ }
      }
      if (!code && X && P) {
        try {
          const cf = X.getCmp(P + "ctrl_secGeneral_Code") || (cmp && cmp.query && cmp.query('[id$="_Code"]')[0]);
          if (cf && typeof cf.getValue === "function") code = String(cf.getValue() || "").trim();
        } catch { /* */ }
      }
      const tabChild = el ? el.closest(".portal-tab,.x-tabpanel-child") : null;
      const tabCmp = (tabChild && X && X.getCmp(tabChild.id)) || null;
      if (!code && tabCmp && tabCmp.title) {
        const tm = /^([A-Z0-9_-]{3,24})\s*:/.exec(textOf(String(tabCmp.title)));
        if (tm) code = tm[1];
      }
      out.push({ id, prefix, P, cmp, el, code, title: titleText, tabCmp, tabId: tabChild ? tabChild.id : "" });
    }
    return out;
  }
  function matchDetailModule(w, code, excludeIds) {
    const list = findDetailModules(w);
    const normCode = String(code || "").trim().toUpperCase();
    if (normCode) {
      const exact = list.find((d) => (!excludeIds || !excludeIds.has(d.id)) && d.code.toUpperCase() === normCode);
      if (exact) return exact;
    }
    if (excludeIds) {
      const fresh = list.filter((d) => !excludeIds.has(d.id));
      if (fresh.length) {
        if (!normCode) return fresh[fresh.length - 1];
        const compat = fresh.find((d) => !d.code || d.code.toUpperCase() === normCode);
        if (compat) return compat;
      }
    }
    return null;
  }
  function activateDetailTab(d) {
    if (!d) return false;
    try {
      const pc = Ext.getCmp("body_portalPagesContainer");
      if (pc && d.tabCmp && typeof pc.setActiveTab === "function") { pc.setActiveTab(d.tabCmp); return true; }
      for (let p = d.cmp || d.tabCmp, i = 0; p && p.ownerCt && i < 40; p = p.ownerCt, i++) {
        if (isTabPanel(p.ownerCt)) { p.ownerCt.setActiveTab(p); return true; }
      }
      if (d.code) {
        const tab = portalTabs().find((x) => x.text.toUpperCase().startsWith(d.code.toUpperCase() + ":"));
        if (tab && tab.t && tab.t.el && tab.t.el.dom) { tab.t.el.dom.click(); return true; }
      }
    } catch { /* */ }
    return false;
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
  // ---- indirizzo del ticket nel portale (HDA TOUCH apre ogni ticket in una scheda ExtJS o in una nuova scheda del browser)
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
  // Apre il ticket con i comandi del portale (Open, doppio clic, Find by ID) e intercetta la nuova scheda
  // (sia scheda del browser window.open / form POST, sia scheda ExtJS interna nel portale Touch):
  // mode "observe" la lascia aprire; mode "intercept" non apre schede esterne e restituisce l'indirizzo,
  // la cornice o la scheda interna del portale.
  let portalLock = Promise.resolve();
  async function portalOpen(m, t, mode, frame, signal) {
    const prev = portalLock;
    let release;
    portalLock = new Promise((r) => { release = r; });
    try {
      await prev;
      if (signal && signal.aborted) { const e = new Error("Ricerca interrotta."); e.name = "AbortError"; throw e; }
      return await portalOpenOnce(m, t, mode, frame);
    } finally { release(); }
  }
  async function portalOpenOnce(m, t, mode, frame) {
    const W = window;
    // Se il ticket è già aperto in una scheda interna di Touch, lo usiamo subito
    const already = t && t.code ? matchDetailModule(W, t.code) : null;
    if (already && mode === "intercept") {
      return { url: null, posted: false, detail: already, freshTab: false, how: "scheda Touch già aperta", manual: false };
    }
    const rec = recordFor(m, t);
    const beforeDetails = new Set(findDetailModules(W).map((d) => d.id));
    const got = { url: null, posted: false, detail: null, freshTab: false, how: "", manual: false };
    const checkDetail = () => {
      const d = matchDetailModule(W, t && t.code, beforeDetails) || (t && t.code ? matchDetailModule(W, t.code) : null);
      if (d) { got.detail = d; got.freshTab = !beforeDetails.has(d.id); return true; }
      return false;
    };
    const origOpen = W.open, FP = HTMLFormElement.prototype, origSubmit = FP.submit, AP = HTMLAnchorElement.prototype, origClick = AP.click;
    // richieste del portale partite dopo il nostro comando (Find by ID, Open...): finché sono in corso si aspetta
    const reqsBefore = new Set(Object.keys((Ext.Ajax && Ext.Ajax.requests) || {}));
    const pendingNew = () => { try { return Object.entries(Ext.Ajax.requests || {}).some(([id, r]) => !reqsBefore.has(id) && r && typeof r.isLoading === "function" && r.isLoading()); } catch { return false; } };
    // un clic o un tasto dell'utente nel portale (fuori dal pannello): quello che apre dopo è suo, non si tocca
    let userAt = -1e9;
    const onGesture = (e) => { if (e.isTrusted && e.target !== host) userAt = performance.now(); };
    const byUser = () => performance.now() - userAt < 1500;
    const take = (u) => { const a = u && !/^(about:blank|javascript:)/i.test(String(u)) ? absUrl(u) : null; if (a) got.url = a; return a; };
    const sink = { closed: false, opener: W, focus() {}, blur() {}, close() { this.closed = true; }, document: { write() {}, writeln() {}, open() {}, close() {} } };
    Object.defineProperty(sink, "location", { get: () => ({ get href() { return got.url || "about:blank"; }, set href(v) { take(v); }, assign: take, replace: take, toString: () => got.url || "about:blank" }), set: take });
    const hookOpen = function (u) {
      if (byUser()) return origOpen.apply(W, arguments);
      take(u);
      if (mode === "observe") return origOpen.apply(W, arguments);
      return sink;
    };
    const linkHref = (a) => (a && a.href && a.target && a.target !== "_self" && !/^javascript:/i.test(a.getAttribute("href") || "") && !(a.getAttribute("href") || "").startsWith("#") ? a.href : "");
    // <a target=_blank> creato al volo e cliccato senza inserirlo nella pagina: il clic non arriva al documento
    const hookClick = function () {
      const u = !this.isConnected && !byUser() ? linkHref(this) : "";
      if (u) { take(u); if (mode !== "observe") return undefined; }
      return origClick.call(this);
    };
    W.open = hookOpen;
    AP.click = hookClick;
    const onClick = (e) => {
      if (e.isTrusted && e.target !== host) return; // clic vero dell'utente nel portale
      const u = linkHref((e.composedPath ? e.composedPath() : []).find((x) => x && x.tagName === "A"));
      if (u) { take(u); if (mode !== "observe") e.preventDefault(); }
    };
    const formUrl = (fm) => {
      if ((fm.method || "get").toLowerCase() !== "get") return null;
      try { const u = new URL(fm.action || location.href, location.href); for (const [k, v] of new FormData(fm)) if (typeof v === "string") u.searchParams.append(k, v); return u.href; } catch { return null; }
    };
    const viaForm = (fm) => {
      if (!fm.target || fm.target === "_self" || byUser()) return false;
      const u = formUrl(fm);
      if (u) { take(u); if (mode === "observe") return false; return true; }
      if (mode !== "observe" && frame) {
        const was = fm.getAttribute("target");
        fm.target = frame.name; got.posted = true;
        setTimeout(() => { if (fm.getAttribute("target") === frame.name) { if (was === null) fm.removeAttribute("target"); else fm.setAttribute("target", was); } }, 0);
      }
      return false;
    };
    const hookSubmit = function () { if (viaForm(this)) return undefined; return origSubmit.call(this); };
    FP.submit = hookSubmit;
    const onSubmit = (e) => { if (viaForm(e.target)) e.preventDefault(); };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    W.addEventListener("pointerdown", onGesture, true);
    W.addEventListener("keydown", onGesture, true);
    try {
      activity(true);
      if (rec) {
        showModuleTab(m);
        await sleep(50);
        try { m.grid.getSelectionModel().select([rec]); } catch { /* */ }
        const b = findButton(m, /^(open|apri)$/i, /_RecordView$/);
        const usable = () => !!b && !b.destroyed && !(typeof b.isDisabled === "function" && b.isDisabled());
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
              if (cell) cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
              else view.fireEvent("itemdblclick", view, rec, node, m.store.indexOf(rec), new Ext.event.Event(new MouseEvent("dblclick", { bubbles: true })));
            } finally { if (document.body) document.body.inert = was; }
            got.how = "doppio clic";
          } catch { /* sotto: Find by ID */ }
        }
      }
      if (!got.how && t.code) {
        const r = await findById(m, t.code, mode !== "observe");
        if (r === true) got.how = "Find by ID"; else if (r === "manual") got.manual = true;
      }
      if (got.how) {
        const done = () => !!got.url || got.posted || checkDetail();
        if (!(await waitUntil(done, 4000)) && pendingNew()) await waitUntil(() => done() || !pendingNew(), 16000);
        if (!got.url && !got.posted && !got.detail) checkDetail();
      }
    } finally {
      if (W.open === hookOpen) W.open = origOpen;
      if (FP.submit === hookSubmit) FP.submit = origSubmit;
      if (AP.click === hookClick) AP.click = origClick;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      W.removeEventListener("pointerdown", onGesture, true);
      W.removeEventListener("keydown", onGesture, true);
    }
    if (got.url) learnTemplate(got.url, t, rec);
    return got;
  }
  // «Apri in Touch»: con l'indirizzo noto si apre direttamente, altrimenti con la scheda interna o i comandi del portale
  async function openTicket(t) {
    if (t.src === "ar") { arOpen(t); return; }
    const url = touchUrl(t);
    if (url) { window.open(url, "_blank", "noopener"); return; }
    const existing = t && t.code ? matchDetailModule(window, t.code) : null;
    if (existing) { hide(); activateDetailTab(existing); return; }
    const m = currentModule();
    hide();
    const got = await portalOpen(m, t, "observe");
    if (got.url) { show(); render(); return; } // il ticket è nella nuova scheda del browser; il pannello resta qui con i risultati
    if (got.detail) { activateDetailTab(got.detail); return; } // aperto nella scheda interna di Touch
    if (got.manual) return; // Find by ID compilato (o numero negli appunti): si conferma nel portale
    if (!got.how && !t.code) { show(); toast("Ticket non presente nell'elenco"); } // con il numero: messaggio già dato da findById
  }
  // quiet: per la lettura nel pannello (nessun messaggio, il pannello resta aperto); true se la richiesta è partita
  async function findById(m, code, quiet) {
    if (code && !quiet) await copyText(code, null);
    const b = m && findButton(m, /^(find by id|trova per id|cerca per id|trova id|vai al ticket)/i, /_FindById$/);
    if (!b) { if (!quiet) { show(); toast(code ? `Ticket ${code} non presente nell'elenco: numero copiato, aprilo dal portale` : "Ticket non presente nell'elenco"); } return false; }
    showModuleTab(m);
    await sleep(50);
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
    if (!field) return quiet ? false : "manual";
    try { field.setValue(code); if (!quiet) field.focus(true, 30); } catch { /* */ }
    try {
      const w = field.up("window");
      const ok = w && w.query("button").filter((x) => x.isVisible && x.isVisible(true))
        .find((x) => /^(ok|find|search|cerca|trova|apri|open|vai|go|confirm|conferma|vai al ticket)$/i.test(textOf(String((x.getText ? x.getText() : x.text) || ""))));
      if (ok && String(field.getValue()) === code) { await sleep(80); clickBtn(ok); return true; }
      if (quiet && w) { try { w.close(); } catch { /* */ } }
    } catch { /* l'utente conferma a mano */ }
    return quiet ? false : "manual";
  }

  // ---- lettura del ticket completo: da scheda interna di Touch o in una cornice nascosta, con navigazione dello storico
  let readerSeq = 0;
  function readerFrame() {
    const fr = document.createElement("iframe");
    fr.name = `rtkt-reader-${++readerSeq}`;
    fr.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms");
    fr.setAttribute("aria-hidden", "true");
    fr.tabIndex = -1;
    fr.style.cssText = "position:fixed;left:-12000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none";
    document.documentElement.appendChild(fr);
    return fr;
  }
  const frameWin = (fr) => { try { const w = fr.contentWindow; return w && w.document ? w : null; } catch { return null; } };
  // maschera di caricamento visibile; non conta quella fissa che Ext mette sui componenti disabilitati (maskOnDisable)
  const busyMask = (X, w, el) => {
    if (!(el.offsetWidth > 0) || w.getComputedStyle(el).display === "none" || w.getComputedStyle(el).visibility === "hidden") return false;
    const p = el.parentElement;
    if (p && p.closest(".x-item-disabled")) return false;
    try { const c = p && X && X.getCmp(p.id); if (c && typeof c.isDisabled === "function" && c.isDisabled()) return false; } catch { /* */ }
    return true;
  };
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
        try { if (X.Ajax && X.Ajax.requests && Object.values(X.Ajax.requests).some((r) => r && typeof r.isLoading === "function" && r.isLoading() && !/signalr|poll|heartbeat|keepalive/i.test(String((r.options && r.options.url) || "")))) return false; } catch { /* */ }
        try { if (X.ComponentQuery.query("loadmask").some((lm) => lm.isVisible && lm.isVisible())) return false; } catch { /* */ }
        let modal = false;
        try { modal = X.ComponentQuery.query("window").some((x) => x.modal && x.isVisible && x.isVisible()); } catch { /* */ }
        try { if (!modal && [...doc.querySelectorAll(".x-mask")].some((el) => busyMask(X, w, el))) return false; } catch { /* */ }
      }
      const len = ((doc.body && doc.body.innerText) || "").length;
      if (len !== lastLen) { lastLen = len; since = performance.now(); return false; }
      return len > 0 && performance.now() - since > 900;
    }, 25000, signal);
    if (cross) throw new Error("La pagina del ticket è su un altro sito: aprila con «Apri in Touch».");
    if (!ok) throw new Error("La pagina del ticket non ha finito di caricarsi.");
  }
  async function waitDetailReady(w, domRoot, signal, maxMs = 12000) {
    const X = w.Ext;
    let lastLen = -1, since = 0;
    await waitUntil(() => {
      if (X) {
        try { if (X.Ajax && X.Ajax.requests && Object.values(X.Ajax.requests).some((r) => r && typeof r.isLoading === "function" && r.isLoading() && !/signalr|poll|heartbeat|keepalive/i.test(String((r.options && r.options.url) || "")))) return false; } catch { /* */ }
      }
      if (domRoot) {
        try { if ([...domRoot.querySelectorAll(".x-mask")].some((el) => busyMask(X, w, el))) return false; } catch { /* */ }
      }
      const txt = domRoot ? (domRoot.innerText || domRoot.textContent || "") : "";
      const len = txt.length;
      if (len !== lastLen) { lastLen = len; since = performance.now(); return false; }
      return len > 20 && performance.now() - since > 350;
    }, maxMs, signal);
  }
  // testo leggibile (anche da HTML o HTML doppiamente codificato &lt;p&gt;...&lt;/p&gt;), senza fogli di stile o script
  function plainText(v) {
    let s = String(v ?? "");
    for (let pass = 0; pass < 2; pass++) {
      if (!(/<[a-z][\s\S]*>/i.test(s) || /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s))) break;
      const d = new DOMParser().parseFromString(`<body>${s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")}</body>`, "text/html");
      d.body.querySelectorAll("style,script,noscript,template").forEach((n) => n.remove());
      const next = d.body.textContent || "";
      if (next === s) break;
      s = next;
    }
    return s.replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Legge il testo da un campo HTML ricco di Touch (ProblemHTML / SolutionHTML con TinyMCE, iframe o div.htmlEditor)
  function extractHtmlFieldEl(w, el, X) {
    if (!el) return "";
    // 1. Istanza TinyMCE attiva
    try {
      if (w.tinymce && typeof w.tinymce.get === "function") {
        for (const edEl of el.querySelectorAll(".htmlEditor,[id$='_Editor']")) {
          const ed = edEl.id && w.tinymce.get(edEl.id);
          if (ed && typeof ed.getContent === "function") {
            const c = plainText(ed.getContent());
            if (c) return c;
          }
        }
      }
    } catch { /* */ }
    // 2. iframe di TinyMCE (_ifr)
    try {
      for (const ifr of el.querySelectorAll("iframe")) {
        const idoc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
        if (idoc && idoc.body) {
          const c = plainText(idoc.body.innerHTML || idoc.body.innerText || "");
          if (c) return c;
        }
      }
    } catch { /* */ }
    // 3. Componente ExtJS
    try {
      if (X && el.id) {
        const cmp = X.getCmp(el.id);
        if (cmp && typeof cmp.getValue === "function") {
          const c = plainText(cmp.getValue());
          if (c && !emptyJson(c)) return c;
        }
      }
    } catch { /* */ }
    // 4. div.htmlEditor o input nascosto del campo
    try {
      for (const n of el.querySelectorAll(".htmlEditor,input[type='hidden'],textarea")) {
        const raw = n.tagName === "INPUT" || n.tagName === "TEXTAREA" ? n.value : n.innerHTML || n.textContent;
        const c = plainText(raw);
        if (c && !emptyJson(c)) return c;
      }
    } catch { /* */ }
    return "";
  }
  // Traduce i tipi di messaggio in inglese di Touch in etichette chiare in italiano
  const MSG_KIND_IT = {
    "initial request": "Richiesta iniziale",
    "initialrequest": "Richiesta iniziale",
    "customerreply": "Risposta cliente",
    "customer reply": "Risposta cliente",
    "operatorreply": "Risposta operatore",
    "operator reply": "Risposta operatore",
    "internalnote": "Nota interna",
    "internal note": "Nota interna",
    "solution": "Soluzione",
    "resolution": "Soluzione",
  };
  const fmtMsgDate = (raw) => {
    const s = plainText(raw || "");
    if (!s) return "";
    const p = parseDateText(s);
    return p && p.d ? `${fmtDate(p.d)}${p.t ? " " + p.t : ""}` : s;
  };
  // Estrae i messaggi da una griglia conversazioni di Touch (entity-ticketconversationitem: Storico conversazioni,
  // Conversation / publicCommunications, Internal notes, Other departments conversations)
  function extractConversationGrid(g, domEl, sectionTitle) {
    const messages = [];
    const rows = [];
    const seenMsg = new Set();
    const addMsg = (type, author, date, text, internal, files, hasAttIcon) => {
      type = plainText(type || "");
      author = plainText(author || "").replace(/^\s*[-–—:·]\s*/, "").trim();
      date = fmtMsgDate(date);
      text = plainText(text || "");
      if (!text && !author && !type) return;
      const isInt = !!internal || /internal|nota interna|nota sul cliente/i.test(type) || /internal|note interne|note sul cliente/i.test(sectionTitle || "");
      const kind = MSG_KIND_IT[norm(type)] || type || (isInt ? "Nota interna" : "Messaggio");
      const sig = `${norm(kind)}|${date}|${norm(author)}|${norm(text).slice(0, 120)}`;
      if (seenMsg.has(sig)) return;
      seenMsg.add(sig);
      const body = files && files.length ? `${text}${text ? "\n" : ""}[Allegati: ${files.join(", ")}]` : text;
      const hasAttachment = !!(hasAttIcon || (files && files.length));
      messages.push({
        section: sectionTitle || "Storico conversazioni",
        kind,
        type: kind,
        who: author,
        author,
        date,
        body,
        text: body,
        internal: isInt,
        hasAttachment,
      });
      rows.push([kind || "—", [author, date].filter(Boolean).join(" · "), body]);
    };
    // 1. Record dello store ExtJS (contengono il testo completo non troncato a ~400 caratteri)
    const storeRecs = [];
    try {
      const st = g && typeof g.getStore === "function" ? g.getStore() : null;
      if (st && typeof st.getRange === "function") storeRecs.push(...st.getRange());
    } catch { /* */ }
    // 2. Righe DOM renderizzate nella tabella (.list-view-row o tr.x-grid-row)
    const domRows = domEl ? [...domEl.querySelectorAll("tr.x-grid-row")] : [];
    const count = Math.max(storeRecs.length, domRows.length);
    for (let i = 0; i < count; i++) {
      const r = storeRecs[i];
      const tr = domRows[i];
      let type = "", author = "", date = "", text = "", internal = false, hasAttIcon = false;
      const files = [];
      if (tr) {
        try {
          const icon = tr.querySelector("i[title],i[data-qtip],[data-columnid$='_c7_0'] [title],[data-columnid$='_c7_0'] [data-qtip]");
          if (icon) type = icon.getAttribute("title") || icon.getAttribute("data-qtip") || "";
          const userTd = tr.querySelector("[data-columnid$='_c5_1']") || tr.querySelectorAll("td.x-grid-cell")[1];
          if (userTd) {
            const dtEl = userTd.querySelector(".text-datetime-date");
            if (dtEl) date = dtEl.textContent || "";
            const bolds = [...userTd.querySelectorAll("b,strong,[style*='font-weight']")].map((b) => plainText(b.textContent)).filter(Boolean);
            if (bolds.length && !type) type = bolds[0];
            const clone = userTd.cloneNode(true);
            clone.querySelectorAll(".text-datetime-date").forEach((n) => n.remove());
            let rawAuthor = plainText(clone.textContent || "");
            if (rawAuthor && type && rawAuthor.toLowerCase() === type.toLowerCase()) rawAuthor = "";
            else if (rawAuthor && type && rawAuthor.toLowerCase().startsWith(type.toLowerCase())) rawAuthor = plainText(rawAuthor.slice(type.length)).replace(/^\s*[-–—:·]\s*/, "").trim();
            author = rawAuthor;
          }
          const bodyEl = tr.querySelector(".ticketconversationitem-text,[data-columnid$='_c12_3'],[data-columnid$='_c9_2']");
          if (bodyEl) text = plainText(bodyEl.innerHTML || bodyEl.textContent || "");
          if (tr.querySelector("[data-columnid$='_c8_2'] .icon-attachment,[data-columnid$='_c13_2'] .icon-attachment")) hasAttIcon = true;
          for (const att of tr.querySelectorAll("[data-columnid$='_c8_2'] [title],[data-columnid$='_c8_2'] a,[data-columnid$='_c13_2'] [title],[data-columnid$='_c13_2'] a")) {
            const at = plainText(att.getAttribute("title") || att.textContent || "");
            if (at && !/^(allegato|attachment)$/i.test(at)) files.push(at);
            else if (at) hasAttIcon = true;
          }
        } catch { /* */ }
      }
      if (r) {
        try {
          const d = (typeof r.getData === "function" ? r.getData() : r.data) || {};
          const pickStr = (re) => {
            for (const [k, v] of Object.entries(d)) if (re.test(k) && v && (typeof v === "string" || typeof v === "number")) return String(v);
            return "";
          };
          const sText = plainText(pickStr(/^(text|body|message|detail|description|html|content|note|testo|messaggio|comunicazione)/i));
          // Se il testo nello store è più lungo di quello troncato nel DOM, usiamo il testo completo dello store
          if (sText && sText.length >= text.length) text = sText;
          if (!type) type = pickStr(/^(type|kind|itemtype|eventtype|category|subject|title|tipo)/i);
          if (!author) {
            const cand = pickStr(/^(user|author|sender|from|createdby|operator|utente|autore|mittente)/i);
            if (cand && (!type || cand.toLowerCase() !== type.toLowerCase())) author = cand;
          }
          if (!date) {
            for (const [k, v] of Object.entries(d)) {
              if (/date|time|created|timestamp|data/i.test(k) && v) {
                date = isDate(v) ? `${fmtDate(isoOf(v))} ${pad(v.getHours())}:${pad(v.getMinutes())}` : String(v);
                break;
              }
            }
          }
          if (/internal|note|intern/i.test(String(d.Type || d.ItemType || d.Kind || ""))) internal = true;
        } catch { /* */ }
      }
      addMsg(type, author, date, text, internal, files, hasAttIcon);
    }
    return { messages, rows };
  }
  // Estrae le note da una griglia entity-note di Touch (Internal notes e Notes on customer)
  function extractNoteGrid(g, domEl, sectionTitle) {
    const messages = [];
    const seen = new Set();
    const isCust = /customer|cliente|accountnotes/i.test(sectionTitle || "") || !!(domEl && domEl.closest("[id$='_AccountNotes']"));
    const defaultKind = isCust ? "Nota sul cliente" : "Nota interna";
    const pushNote = (author, date, title, body) => {
      author = plainText(author || "");
      date = fmtMsgDate(date);
      title = plainText(title || "");
      body = plainText(body || "");
      const full = title && body && !norm(body).startsWith(norm(title)) ? `${title}\n${body}` : (body || title);
      if (!full) return;
      const sig = `${defaultKind}|${date}|${norm(author)}|${norm(full).slice(0, 120)}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      messages.push({
        section: sectionTitle || defaultKind,
        kind: defaultKind,
        type: defaultKind,
        who: author,
        author,
        date,
        body: full,
        text: full,
        internal: true,
        hasAttachment: false,
      });
    };
    const domRows = domEl ? [...domEl.querySelectorAll("tr.x-grid-row")] : [];
    for (const tr of domRows) {
      try {
        const dtTd = tr.querySelector("[data-columnid$='_c0_0']") || tr.querySelectorAll("td.x-grid-cell")[0];
        const usrTd = tr.querySelector("[data-columnid$='_c1_1']") || tr.querySelectorAll("td.x-grid-cell")[1];
        const ttlTd = tr.querySelector("[data-columnid$='_c7_2']");
        const txtTd = tr.querySelector("[data-columnid$='_c6_3']") || tr.querySelectorAll("td.x-grid-cell")[2];
        const date = dtTd ? plainText(dtTd.textContent || "") : "";
        const img = usrTd && usrTd.querySelector("img[title],img[alt],[title],[data-qtip]");
        const author = (img && (img.getAttribute("title") || img.getAttribute("data-qtip") || img.getAttribute("alt"))) || (usrTd ? plainText(usrTd.textContent || "") : "");
        const title = ttlTd ? plainText(ttlTd.textContent || "") : "";
        const body = txtTd ? plainText(txtTd.innerHTML || txtTd.textContent || "") : "";
        pushNote(author, date, title, body);
      } catch { /* */ }
    }
    if (!messages.length && g && typeof g.getStore === "function") {
      try {
        const st = g.getStore();
        for (const r of (st && st.getRange ? st.getRange() : [])) {
          const d = (typeof r.getData === "function" ? r.getData() : r.data) || {};
          pushNote(d.User || d.Author || d.CreatedBy || "", d.Date || d.CreatedDate || "", d.Title || d.Subject || "", d.Note || d.Text || d.Description || d.Body || "");
        }
      } catch { /* */ }
    }
    return messages;
  }
  // Estrae gli allegati da una griglia entity-attachment di Touch
  function extractAttachmentGrid(g, domEl) {
    const rows = [];
    const seen = new Set();
    const domRows = domEl ? [...domEl.querySelectorAll("tr.x-grid-row")] : [];
    for (const tr of domRows) {
      try {
        const nameTd = tr.querySelector("[data-columnid$='_c2_1']") || tr.querySelectorAll("td.x-grid-cell")[1];
        const dateTd = tr.querySelector("[data-columnid$='_c5_2']") || tr.querySelectorAll("td.x-grid-cell")[2];
        const srcTd = tr.querySelector("[data-columnid$='_c3_3']") || tr.querySelectorAll("td.x-grid-cell")[3];
        const qtipEl = nameTd && nameTd.querySelector("[data-qtip],[title]");
        const name = plainText((qtipEl && (qtipEl.getAttribute("data-qtip") || qtipEl.getAttribute("title"))) || (nameTd && nameTd.textContent) || "");
        const date = fmtMsgDate(dateTd ? dateTd.textContent : "");
        const src = plainText(srcTd ? srcTd.textContent : "");
        if (!name) continue;
        const sig = `${norm(name)}|${date}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        rows.push([name, date || "—", src || "—"]);
      } catch { /* */ }
    }
    return rows;
  }
  // Etichette dei campi in italiano per evitare duplicati inglese/italiano nel riepilogo del ticket
  const FIELD_LABEL_IT = {
    "code": "Codice ticket",
    "ticket code": "Codice ticket",
    "subject": "Oggetto",
    "service": "Servizio",
    "ticket category": "Categoria ticket",
    "status": "Stato",
    "priority": "Priorità",
    "classification": "Classificazione",
    "customer classification": "Classificazione cliente",
    "site": "Sede / Cliente",
    "azienda / sede": "Sede / Cliente",
    "contact": "Contatto",
    "end customer": "Cliente finale",
    "end customer contact": "Contatto cliente finale",
    "assigned to": "Assegnato a",
    "assigned": "Assegnato a",
    "owner": "Responsabile",
    "owner group": "Gruppo proprietario",
    "modified by": "Modificato da",
    "channel": "Canale",
    "source": "Origine",
    "work status": "Stato lavorazione",
    "date": "Data apertura",
  };
  // Contenuto leggibile di una pagina ExtJS o di un pannello di dettaglio Touch (root):
  // campi con etichetta, pannello destro (Overview/Contatto/SLA), ProblemHTML/SolutionHTML, storico conversazioni e tabelle
  function extractTicket(w, root) {
    const doc = w.document, X = w.Ext;
    const out = { title: plainText(doc ? doc.title : ""), fields: [], texts: [], tables: [], messages: [] };
    const rootCmp = root && typeof root.query === "function" ? root : null;
    const rootDom = (root && root.el && root.el.dom) || (root && root.nodeType === 1 ? root : null) || (doc ? doc.body : null);
    const q = (sel) => {
      if (rootCmp) return rootCmp.query(sel);
      if (rootDom && rootDom !== (doc && doc.body) && X && X.ComponentQuery) {
        return X.ComponentQuery.query(sel).filter((c) => { try { return c.el && c.el.dom && rootDom.contains(c.el.dom); } catch { return false; } });
      }
      return X && X.ComponentQuery ? X.ComponentQuery.query(sel) : [];
    };
    const seen = new Set();
    const seenField = new Map();
    const seenTextByLabel = new Map();
    const seenTextVal = new Set();
    const fmt = (v) => (isDate(v) ? `${fmtDate(isoOf(v))} ${pad(v.getHours())}:${pad(v.getMinutes())}` : v);
    const addField = (label, value, forceLong) => {
      label = plainText(label || "").replace(/:$/, "").trim();
      if (label && !forceLong && FIELD_LABEL_IT[norm(label)]) label = FIELD_LABEL_IT[norm(label)];
      value = plainText(fmt(value));
      if (!value || emptyJson(value) || value === "—" || value === "-" || /^loading\.{0,3}$/i.test(value)) return;
      const j = parseJsonValue(value);
      if (j) {
        if (!j.v && !j.t) return;
        value = j.t && j.v && j.t !== j.v && !j.t.includes(j.v) ? `${j.t} (${j.v})` : (j.t || j.v);
      }
      const k = norm(label) + "\u0001" + norm(value);
      if (seen.has(k)) return;
      seen.add(k);
      const long = forceLong || value.length > 160 || value.includes("\n");
      if (!long && label) {
        const lk = norm(label);
        if (seenField.has(lk)) {
          const prev = seenField.get(lk);
          if (value.length > prev.value.length && value.includes(prev.value)) prev.value = value.slice(0, 20000);
          return;
        }
      }
      if (long) {
        const nv = norm(value);
        if (seenTextVal.has(nv)) return;
        const lk = norm(label);
        if (lk && seenTextByLabel.has(lk)) {
          const prev = seenTextByLabel.get(lk);
          if (value.length > prev.value.length) { prev.value = value.slice(0, 40000); seenTextVal.add(nv); }
          return;
        }
        const item = { label, value: value.slice(0, 40000) };
        out.texts.push(item);
        seenTextVal.add(nv);
        if (lk) seenTextByLabel.set(lk, item);
        return;
      }
      const item = { label, value: value.slice(0, 40000) };
      out.fields.push(item);
      if (label) seenField.set(norm(label), item);
    };
    // Titolo del dettaglio Touch (<TicketCode>: <Subject>)
    if (rootDom) {
      try {
        const dt = rootDom.querySelector(".detail-title-text,[id$='_UC_Title']");
        if (dt) { const t = plainText(dt.textContent || ""); if (t) out.title = t; }
      } catch { /* */ }
    }
    // 1. Campi HTML ricchi di Touch: ProblemHTML (Issue/Request) e SolutionHTML (Resolution)
    if (rootDom) {
      for (const hf of rootDom.querySelectorAll(".html-field,[id$='_ProblemHTML'],[id$='_SolutionHTML']")) {
        try {
          const id = hf.id || "";
          const lblEl = hf.querySelector(".field-label-inner,.x-form-item-label-inner,.x-form-item-label-text,label.field-label");
          let label = plainText((lblEl && lblEl.textContent) || "");
          if (/ProblemHTML$/i.test(id) || /^issue\/request$/i.test(label)) label = "Richiesta (Issue/Request)";
          else if (/SolutionHTML$/i.test(id) || /^resolution$/i.test(label)) label = "Soluzione (Resolution)";
          const val = extractHtmlFieldEl(w, hf, X);
          if (val) addField(label || "Testo", val, true);
        } catch { /* */ }
      }
    }
    // 2. Campi ExtJS [isFormField]
    if (X && X.ComponentQuery) {
      for (const c of q("[isFormField]")) {
        try {
          if (c.ownerCt && c.ownerCt.isXType && (c.ownerCt.isXType("checkboxgroup") || c.ownerCt.isXType("radiogroup"))) continue;
          if ((c.isXType && c.isXType("hiddenfield")) || c.inputType === "password" || (c.isHidden && c.isHidden())) continue;
          // evita i campi filtro della barra di ricerca, il selettore Page size e i campi HTML ricchi già estratti al punto 1
          if (/filter_default_|defaultFilter_default_|ComboPageSize|_ProblemHTML$|_SolutionHTML$/i.test(c.id || "") || /ComboPageSize/i.test(c.name || "")) continue;
          if (/\bhtml-field\b/i.test(clsOf(c)) || (c.el && c.el.dom && c.el.dom.closest(".html-field,[id$='_ProblemHTML'],[id$='_SolutionHTML']"))) continue;
          const label = plainText((typeof c.getFieldLabel === "function" ? c.getFieldLabel() : c.fieldLabel) || c.boxLabel || c.name || "").replace(/:$/, "");
          let v;
          if (c.isXType && (c.isXType("checkboxgroup") || c.isXType("radiogroup"))) v = (typeof c.getChecked === "function" ? c.getChecked() : []).map((b) => b.boxLabel || b.inputValue || "").filter(Boolean).join(", ");
          else if (c.isXType && c.isXType("checkbox")) v = c.getValue() ? "Sì" : "No";
          else {
            v = fieldDisplay(c);
            if (!v) v = typeof c.getDisplayValue === "function" ? c.getDisplayValue() : null;
            if (v === null || v === undefined || v === "") v = c.rendered && typeof c.getRawValue === "function" ? c.getRawValue() : c.getValue();
          }
          if (v !== null && typeof v === "object" && !Array.isArray(v) && !isDate(v)) {
            const j = parseJsonValue(v);
            if (j) v = j.t || j.v;
            else continue;
          }
          const forceLong = !!(c.isXType && (c.isXType("textareafield") || c.isXType("htmleditor")));
          addField(label, v, forceLong);
        } catch { /* */ }
      }
    }
    // 3. Campi nel DOM (inclusi objectlink-field, tree-field, tag-field e input nascosti JSON di Touch)
    if (rootDom) {
      for (const fld of rootDom.querySelectorAll(".field,.x-field")) {
        try {
          if (fld.classList.contains("html-field") || fld.classList.contains("filterField") || fld.classList.contains("page-size-field") || /filter_default_|defaultFilter_default_|ComboPageSize|_ProblemHTML$|_SolutionHTML$/i.test(fld.id || "")) continue;
          if (fld.closest(".x-grid,.list-grid,.html-field,[id$='_ProblemHTML'],[id$='_SolutionHTML']")) continue;
          const lblEl = fld.querySelector(".field-label-inner,.x-form-item-label-inner,.x-form-item-label-text,label.field-label");
          const label = plainText((lblEl && lblEl.textContent) || "");
          if (!label) continue;
          let val = "";
          for (const inp of fld.querySelectorAll('input[type="hidden"]')) {
            const j = parseJsonValue(inp.value);
            if (j && (j.t || j.v)) { val = j.t && j.v && j.t !== j.v && !j.t.includes(j.v) ? `${j.t} (${j.v})` : (j.t || j.v); break; }
          }
          if (!val) {
            const tags = [...fld.querySelectorAll(".x-tagfield-item-text,.x-taglabel-item,.tag-item")].map((n) => plainText(n.textContent)).filter(Boolean);
            if (tags.length) val = tags.join(", ");
          }
          if (!val) {
            const vis = fld.querySelector('input:not([type="hidden"]):not([type="button"]),textarea');
            if (vis && vis.value) val = vis.value;
          }
          if (val) addField(label, val, false);
        } catch { /* */ }
      }
      // 4. Pannello destro di riepilogo Touch (RightCustomValues: ContactDetails0, TicketOverView2, ServiceLevels1)
      for (const box of rootDom.querySelectorAll("[id$='_TicketOverView2'],.ticket-overview")) {
        for (const n of box.querySelectorAll("[data-qtip]")) {
          const tip = plainText(n.getAttribute("data-qtip") || "");
          const val = plainText(n.textContent || "");
          if (tip && val && val !== "-") addField(tip, val, false);
        }
      }
      for (const box of rootDom.querySelectorAll("[id$='_ContactDetails0'],.contact-details-box")) {
        const name = plainText((box.querySelector(".contact-main-info-name") || {}).textContent || "");
        const company = plainText((box.querySelector(".contact-main-info-company") || {}).textContent || "");
        const block = plainText((box.querySelector(".HighlightBlock") || {}).textContent || "");
        if (name) addField("Contatto", name, false);
        if (company) addField("Sede / Cliente", company, false);
        if (block) addField("Stato amministrativo cliente", block, false);
        for (const item of box.querySelectorAll(".contact-other-info-item")) {
          const v = plainText(item.textContent || "");
          if (!v || v === "-") continue;
          const ic = item.querySelector("i");
          const cls = (ic && ic.className) || "";
          const lbl = /envelope|mail/i.test(cls) || /@/.test(v) ? "Email contatto" : /phone|tel/i.test(cls) || /^[\d+\s/.()-]{6,}$/.test(v) ? "Telefono contatto" : /map|marker/i.test(cls) ? "Località contatto" : "Info contatto";
          addField(lbl, v, false);
        }
      }
      for (const box of rootDom.querySelectorAll("[id$='_ServiceLevels1'],.sla-panel")) {
        const parts = [...box.querySelectorAll(".sla-title,.sla-type,.sla-info-item")].map((n) => plainText(n.textContent)).filter(Boolean);
        if (parts.length) addField("SLA", parts.join(" · "), false);
      }
    }
    // 5. Griglie e tabelle (Storico conversazioni, Comunicazioni, Note interne, Note sul cliente, Allegati, Log...)
    const handledGrids = new Set();
    if (X && X.ComponentQuery) {
      for (const g of q("tablepanel")) {
        try {
          // Non saltiamo le griglie _UC_grd interne al ticket; saltiamo solo l'elenco principale dei ticket del portale
          if (!root && S.modules && S.modules.some((m) => m.grid === g)) continue;
          const gDom = g.el && g.el.dom;
          if (gDom) handledGrids.add(gDom);
          const listCt = gDom && gDom.closest(".module.list,[id$='_UC_ListCt']");
          const cls = `${g.cls || ""} ${g.userCls || ""} ${(gDom && gDom.className) || ""} ${(listCt && listCt.className) || ""}`;
          const rawTitle = plainText(g.title || (g.tab && g.tab.text) || (g.up && g.up("panel[title]") && g.up("panel[title]").title) || "");
          if (/entity-ticketconversationitem/i.test(cls) || (gDom && gDom.closest("[id$='_ConversationHistory']"))) {
            const secTitle = rawTitle || (gDom && gDom.closest("[id$='_ConversationHistory']") ? "Storico conversazioni" : "Conversazioni");
            const conv = extractConversationGrid(g, gDom, secTitle);
            for (const m of conv.messages) out.messages.push(m);
            continue;
          }
          if (/entity-note/i.test(cls) || (gDom && gDom.closest("[id$='_AccountNotes']"))) {
            const secTitle = rawTitle || (gDom && gDom.closest("[id$='_AccountNotes']") ? "Note sul cliente" : "Note interne");
            for (const m of extractNoteGrid(g, gDom, secTitle)) out.messages.push(m);
            continue;
          }
          if (/entity-attachment/i.test(cls)) {
            const attRows = extractAttachmentGrid(g, gDom);
            if (attRows.length) out.tables.push({ title: "Allegati", head: ["File", "Data", "Origine"], rows: attRows });
            continue;
          }
          const st = g.getStore && g.getStore();
          const allCols = (typeof g.getVisibleColumns === "function" ? g.getVisibleColumns() : typeof g.getColumns === "function" ? g.getColumns() : g.columns || [])
            .filter((c) => c && !c.hidden && !c.isCheckerHd && !/^(checkcolumn|rownumberer|actioncolumn)$/.test(c.xtype || ""));
          const cols = allCols.filter((c) => c.dataIndex || c.text || c.header);
          if (st && cols.length && typeof st.getRange === "function" && st.getRange().length) {
            const rows = st.getRange().slice(0, 300).map((r, i) => cols.map((c, j) => {
              let v = c.dataIndex ? r.get(c.dataIndex) : "";
              if (typeof c.renderer === "function") { try { v = c.renderer.call(c.usingDefaultRenderer ? c : c.scope || g, v, {}, r, i, j, st, g.getView && g.getView()); } catch { /* valore grezzo */ } }
              const txt = plainText(fmt(v));
              if (txt) return txt;
              try {
                const view = g.getView && g.getView();
                const node = view && view.getNode(r);
                const cid = typeof c.getId === "function" ? c.getId() : c.id;
                const td = node && cid && node.querySelector(`[data-columnid="${cssEsc(cid)}"]`);
                if (td) return plainText(td.innerText || td.textContent || "");
              } catch { /* */ }
              return "";
            })).filter((r) => r.some(Boolean));
            if (rows.length) out.tables.push({ title: rawTitle || "Elenco", head: cols.map((c) => plainText(c.text || c.header || c.dataIndex || "")), rows });
          }
        } catch { /* */ }
      }
    }
    // Griglie di conversazione, note o allegati presenti nel DOM ma non lette via ExtJS
    if (rootDom) {
      for (const gDom of rootDom.querySelectorAll(".entity-ticketconversationitem .x-grid, .entity-ticketconversationitem.x-grid, [id$='_ConversationHistory'] .x-grid")) {
        if (handledGrids.has(gDom)) continue;
        handledGrids.add(gDom);
        const secTitle = gDom.closest("[id$='_ConversationHistory']") ? "Storico conversazioni" : "Conversazioni";
        const conv = extractConversationGrid(X && gDom.id ? X.getCmp(gDom.id) : null, gDom, secTitle);
        for (const m of conv.messages) out.messages.push(m);
      }
      for (const gDom of rootDom.querySelectorAll(".entity-note .x-grid, .entity-note.x-grid, [id$='_AccountNotes'] .x-grid")) {
        if (handledGrids.has(gDom)) continue;
        handledGrids.add(gDom);
        const secTitle = gDom.closest("[id$='_AccountNotes']") ? "Note sul cliente" : "Note interne";
        for (const m of extractNoteGrid(X && gDom.id ? X.getCmp(gDom.id) : null, gDom, secTitle)) out.messages.push(m);
      }
      for (const gDom of rootDom.querySelectorAll(".entity-attachment .x-grid, .entity-attachment.x-grid")) {
        if (handledGrids.has(gDom)) continue;
        handledGrids.add(gDom);
        const attRows = extractAttachmentGrid(X && gDom.id ? X.getCmp(gDom.id) : null, gDom);
        if (attRows.length) out.tables.push({ title: "Allegati", head: ["File", "Data", "Origine"], rows: attRows });
      }
    }
    if (X && X.ComponentQuery) {
      // elenchi disegnati con un modello (dataview con itemTpl: comunicazioni, note...), non le griglie e i menu a tendina
      for (const dv of q("dataview")) {
        try {
          if ((dv.isXType && (dv.isXType("tableview") || dv.isXType("boundlist"))) || dv.floating || (dv.up && dv.up("[floating]")) || !dv.rendered || !dv.el) continue;
          const v = plainText(dv.el.dom.innerText || dv.el.dom.textContent || "");
          if (!v || seen.has(v)) continue;
          seen.add(v);
          const ow = dv.title ? dv : dv.up && dv.up("panel[title]");
          out.texts.push({ label: plainText((ow && ow.title) || ""), value: v.slice(0, 40000) });
        } catch { /* */ }
      }
      for (const c of q("component")) {
        try {
          const ic = c.initialConfig || {};
          if (!(ic.html || ic.tpl || ic.contentEl || typeof c.html === "string") || (c.items && c.items.getCount && c.items.getCount())) continue;
          if (c.isXType && ["htmleditor", "tablepanel", "menu", "toolbar", "tabbar", "boundlist", "field"].some((x) => c.isXType(x))) continue;
          const el = c.rendered ? (c.body || (typeof c.getTargetEl === "function" ? c.getTargetEl() : null) || c.el) : null;
          if (el && el.dom && el.dom.closest("[id$='_RightCustomValues'],[id$='_MajorIncidentDetails'],[id$='_ClientNotesDetails'],.analysis-ct,.x-mask")) continue;
          const raw = el && el.dom ? el.dom.innerHTML || el.dom.innerText : typeof c.html === "string" ? c.html : "";
          const v = plainText(raw);
          if (v.length > 30 && !/^loading\.{0,3}$/i.test(v) && !seen.has(v)) { seen.add(v); addField(plainText(c.title || ""), v, true); }
        } catch { /* */ }
      }
    }
    if (!out.fields.length && !out.texts.length && !out.tables.length && !out.messages.length) {
      const el = rootDom || (doc && doc.body);
      const v = plainText((el && el.innerText) || "");
      if (v) out.texts.push({ label: "", value: v.slice(0, 40000) });
    }
    return out;
  }
  function mergeExtracted(target, src, sectionLabel) {
    if (!src) return target;
    if (!target.title && src.title) target.title = src.title;
    const fSeen = new Set(target.fields.map((x) => `${norm(x.label)}\u0001${norm(x.value)}`));
    const fLabelSeen = new Set(target.fields.map((x) => norm(x.label)).filter(Boolean));
    for (const f of src.fields || []) {
      const k = `${norm(f.label)}\u0001${norm(f.value)}`;
      const lk = norm(f.label);
      if (!fSeen.has(k) && (!lk || !fLabelSeen.has(lk))) {
        fSeen.add(k);
        if (lk) fLabelSeen.add(lk);
        target.fields.push(f);
      }
    }
    const tSeen = new Set(target.texts.map((x) => `${norm(x.label)}\u0001${norm(x.value)}`));
    const tValSeen = new Set(target.texts.map((x) => norm(x.value)));
    for (const x of src.texts || []) {
      const lbl = x.label || sectionLabel || "";
      const k = `${norm(lbl)}\u0001${norm(x.value)}`;
      const nv = norm(x.value);
      if (!tSeen.has(k) && !tValSeen.has(nv)) {
        tSeen.add(k);
        tValSeen.add(nv);
        target.texts.push({ label: lbl, value: x.value });
      }
    }
    const mSeen = new Set((target.messages || []).map((m) => `${norm(m.kind || m.type)}|${m.date}|${norm(m.who || m.author)}|${norm(m.body || m.text || "").slice(0, 120)}`));
    for (const m of src.messages || []) {
      const k = `${norm(m.kind || m.type)}|${m.date}|${norm(m.who || m.author)}|${norm(m.body || m.text || "").slice(0, 120)}`;
      if (!mSeen.has(k)) { mSeen.add(k); target.messages.push(m); }
    }
    const tbSeen = new Set((target.tables || []).map((tb) => `${tb.title}|${tb.rows.length}|${(tb.rows[0] || []).join(",")}`));
    for (const tb of src.tables || []) {
      const title = tb.title && tb.title !== "Elenco" ? tb.title : (sectionLabel || tb.title || "Elenco");
      const k = `${title}|${tb.rows.length}|${(tb.rows[0] || []).join(",")}`;
      if (!tbSeen.has(k)) { tbSeen.add(k); target.tables.push(Object.assign({}, tb, { title })); }
    }
    return target;
  }
  const cleanTreeLabel = (rawHtml) => {
    const s = String(rawHtml || "");
    if (!s) return "";
    const d = new DOMParser().parseFromString(`<body>${s}</body>`, "text/html");
    d.body.querySelectorAll(".badge").forEach((b) => b.remove());
    return plainText(d.body.textContent || "").replace(/^\d+\s*/, "").replace(/\s+\d+$/, "").trim();
  };
  // Naviga l'albero laterale del dettaglio Touch (<prefix>_UC_PagesTree: Ticket, Storico conversazioni,
  // Internal notes, Attachments, Log, History Email...) per caricare tutte le sezioni della storia del ticket
  async function loadDetailHistory(w, detail, t, signal) {
    const X = w.Ext;
    const dom = detail.el || (detail.cmp && detail.cmp.el && detail.cmp.el.dom);
    await waitDetailReady(w, dom, signal, 10000);
    const out = extractTicket(w, detail.cmp || { el: { dom } });
    const tree = (X && detail.P && X.getCmp(detail.P + "PagesTree")) || (detail.cmp && detail.cmp.query && detail.cmp.query("treepanel")[0]) || null;
    const cards = (X && detail.P && X.getCmp(detail.P + "DetailPagesCard")) || null;
    if (!tree) return out;
    const treeDom = tree.el && tree.el.dom;
    // Elenco dei nodi nell'albero laterale con eventuale contatore badge
    const nodes = [];
    try {
      const st = tree.getStore && tree.getStore();
      const root = st && st.getRootNode && st.getRootNode();
      const walk = (n) => {
        for (const c of (n && n.childNodes) || []) {
          const rawHtml = String(c.get("text") || "");
          const text = cleanTreeLabel(rawHtml);
          const bm = /class=["'][^"']*badge[^"']*["'][^>]*>\s*(\d+)/i.exec(rawHtml);
          let badge = bm ? +bm[1] : 0;
          if (!badge && treeDom) {
            const item = treeDom.querySelector(`[data-recordid="${cssEsc(String(c.internalId ?? c.getId()))}"] .badge`);
            if (item) badge = parseInt(item.textContent, 10) || 0;
          }
          nodes.push({ rec: c, id: String(c.getId() || ""), text, badge });
          walk(c);
        }
      };
      if (root) walk(root);
    } catch { /* */ }
    if (!nodes.length && treeDom) {
      for (const item of treeDom.querySelectorAll(".x-grid-item")) {
        const badgeEl = item.querySelector(".badge");
        const badge = badgeEl ? parseInt(badgeEl.textContent, 10) || 0 : 0;
        const clone = item.cloneNode(true);
        clone.querySelectorAll(".badge").forEach((b) => b.remove());
        const text = plainText(clone.textContent || "").replace(/^\d+\s*/, "").trim();
        nodes.push({ rec: null, domItem: item, id: item.getAttribute("data-recordid") || text, text, badge });
      }
    }
    const hasInternalCounter = t && Array.isArray(t.counters) && t.counters.some((c) => /internal|note/i.test(c));
    const wantNode = (n) => {
      const tx = norm(n.text);
      if (/^(ticket|incident|dettaglio)$/i.test(tx)) return true;
      if (/storico conversazioni|conversation\s*history|comunicazioni|conversazioni/i.test(tx)) return true;
      if (/internal notes|note interne/i.test(tx) && (n.badge > 0 || hasInternalCounter)) return true;
      if (/history email|storico email|other departments|altri reparti|notes on customer|note sul cliente|attachments|allegati/i.test(tx) && n.badge > 0) return true;
      return false;
    };
    const selModel = tree.getSelectionModel && tree.getSelectionModel();
    const initialRec = selModel && selModel.getSelection && selModel.getSelection()[0];
    const initialText = initialRec ? cleanTreeLabel(initialRec.get("text") || "") : "";
    const selectNode = async (n) => {
      const was = !!(w.document.body && w.document.body.inert);
      if (w.document.body) w.document.body.inert = false;
      try {
        const rowEl = n.domItem || (treeDom && n.rec && treeDom.querySelector(`[data-recordid="${cssEsc(String(n.rec.internalId ?? n.rec.getId()))}"]`));
        const cell = rowEl && (rowEl.querySelector(".x-tree-node-text") || rowEl.querySelector("td.x-grid-cell") || rowEl);
        if (cell && typeof cell.click === "function") cell.click();
        else if (n.rec && selModel && typeof selModel.select === "function") {
          selModel.select([n.rec]);
          const view = tree.getView && tree.getView();
          if (view && typeof view.fireEvent === "function") view.fireEvent("itemclick", view, n.rec, rowEl, 0);
        }
      } catch { /* */ } finally { if (w.document.body) w.document.body.inert = was; }
      await sleep(160);
      const getCard = () => (cards && cards.getLayout && cards.getLayout().getActiveItem && cards.getLayout().getActiveItem()) || detail.cmp;
      const activeCard = getCard();
      const cardDom = (activeCard && activeCard.el && activeCard.el.dom) || dom;
      await waitDetailReady(w, cardDom, signal, 8000);
      if (n.badge > 0) {
        await waitUntil(() => {
          const ac = getCard();
          const cd = (ac && ac.el && ac.el.dom) || cardDom;
          try {
            if (ac && typeof ac.getLoader === "function" && ac.getLoader() && ac.getLoader().isLoading && ac.getLoader().isLoading()) return false;
            if (ac && typeof ac.query === "function") {
              for (const g of ac.query("tablepanel")) {
                const st = g.getStore && g.getStore();
                if (st && loading(st)) return false;
                if (st && typeof st.getCount === "function" && st.getCount() > 0) return true;
              }
            }
          } catch { /* */ }
          return !!(cd && cd.querySelectorAll("tr.x-grid-row").length > 0);
        }, 5000, signal);
      }
      const finalCard = getCard();
      return finalCard || { el: { dom: cardDom } };
    };
    for (const n of nodes) {
      if (!wantNode(n)) continue;
      if (initialText && norm(n.text) === norm(initialText)) continue;
      if (signal && signal.aborted) break;
      const activeCard = await selectNode(n);
      mergeExtracted(out, extractTicket(w, activeCard), n.text);
    }
    // Estrae anche eventuali griglie/schede caricate dentro l'intero contenitore del dettaglio
    mergeExtracted(out, extractTicket(w, detail.cmp || { el: { dom } }));
    // Ripristina il nodo iniziale (es. Ticket)
    if (initialRec) {
      const initNode = nodes.find((n) => n.rec === initialRec);
      if (initNode) { try { await selectNode(initNode); } catch { /* */ } }
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
        if ([...pv.el.dom.querySelectorAll(".x-mask")].some((x) => busyMask(Ext, window, x))) return false;
        const len = (el.innerText || "").length;
        if (len !== last) { last = len; since = performance.now(); return false; }
        return len > 20 && performance.now() - since > 800;
      }, 15000, signal);
      if (!ok) return null;
      const c = extractTicket(window, pv);
      return c.fields.length || c.texts.length || c.tables.length || (c.messages && c.messages.length) ? c : null;
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
    // 1. Se il ticket è già aperto in una scheda interna di Touch, leggiamo direttamente quella scheda + storico
    const existingDetail = t && t.code ? matchDetailModule(window, t.code) : null;
    if (existingDetail) {
      const content = await loadDetailHistory(window, existingDetail, t, signal);
      conn.reader = { at: new Date().toISOString(), how: "scheda Touch aperta", url: null, tpl: null, ext: true, fields: content.fields.length, texts: content.texts.length, messages: (content.messages || []).length, tables: content.tables.map((x) => x.rows.length) };
      return Object.assign(content, { url: touchUrl(t) });
    }
    const fr = readerFrame();
    try {
      let url = touchUrl(t), how = url ? "indirizzo noto" : "", detail = null, freshTab = false;
      const pc = Ext.getCmp("body_portalPagesContainer");
      const prevTab = pc && typeof pc.getActiveTab === "function" ? pc.getActiveTab() : null;
      if (!url) {
        if (!m) throw new Error("Non trovo l'elenco «All tickets» del portale.");
        const got = await portalOpen(m, t, "intercept", fr, signal);
        url = got.url; detail = got.detail; freshTab = !!got.freshTab;
        how = got.how + (got.posted ? " (modulo)" : detail ? " (scheda Touch)" : "");
        if (!url && !got.posted && !detail) throw new Error(got.how ? "Il portale non ha aperto il ticket: usa «Apri in Touch»." : "Ticket non presente nell'elenco del portale: cercalo o aprilo con «Apri in Touch».");
      }
      // 2. Il portale ha aperto il ticket in una scheda ExtJS interna della stessa pagina
      if (detail) {
        try {
          const content = await loadDetailHistory(window, detail, t, signal);
          conn.reader = { at: new Date().toISOString(), how, url: null, tpl: null, ext: true, fields: content.fields.length, texts: content.texts.length, messages: (content.messages || []).length, tables: content.tables.map((x) => x.rows.length) };
          return Object.assign(content, { url: null });
        } finally {
          if (freshTab && prevTab && pc && typeof pc.setActiveTab === "function") {
            try { pc.setActiveTab(prevTab); } catch { /* */ }
          }
        }
      }
      // 3. Il portale ha fornito un URL o inviato un modulo nella cornice nascosta
      if (url) { if (new URL(url).origin !== location.origin) throw Object.assign(new Error("La pagina del ticket è su un altro sito: aprila con «Apri in Touch»."), { url }); fr.src = url; }
      await waitFrame(fr, signal);
      const w = frameWin(fr);
      // Se dentro la cornice c'è un modulo di dettaglio Touch con PagesTree, navighiamo anche lì lo storico
      const frameDetail = findDetailModules(w)[0];
      let content;
      if (frameDetail) {
        content = await loadDetailHistory(w, frameDetail, t, signal);
      } else {
        // schede interne non ancora disegnate (deferredRender): si aprono una per volta, poi si torna alla prima
        try {
          for (const tp of w.Ext.ComponentQuery.query("tabpanel")) {
            const cur = tp.getActiveTab();
            const todo = tp.items.getRange().filter((c) => !c.rendered);
            for (const c of todo.slice(0, 8)) { try { tp.setActiveTab(c); } catch { /* */ } }
            if (todo.length) { await sleep(300); await waitFrame(fr, signal); try { tp.setActiveTab(cur); } catch { /* */ } }
          }
        } catch { /* */ }
        content = extractTicket(w);
      }
      conn.reader = { at: new Date().toISOString(), how, url: url ? url.replace(/[?#].*$/, "") + (url.includes("?") ? "?…" : "") : null, tpl: touchTemplate() ? touchTemplate().field : null, ext: !!w.Ext, fields: content.fields.length, texts: content.texts.length, messages: (content.messages || []).length, tables: content.tables.map((x) => x.rows.length), classes: (() => { try { return [...new Set(w.Ext.ComponentQuery.query("component").map((c) => c.xtype))].slice(0, 60); } catch { return null; } })() };
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
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--acs);color:var(--ac);white-space:nowrap}.badge.cl{background:var(--okb);color:var(--ok)}.badge.pr{background:var(--sf2);color:var(--mu)}.badge.src{background:var(--wb);color:var(--wt)}.badge.cnt{background:var(--sf2);color:var(--mu);font-weight:500}
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
details.adv{border-top:1px solid var(--bd);padding-top:10px}details.adv summary{cursor:pointer;font-weight:600;color:var(--ac);display:flex;align-items:center;gap:8px;user-select:none}
details.adv summary:hover{text-decoration:underline}
.ag{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
fieldset{border:1px solid var(--bd);border-radius:8px;padding:10px 12px 12px;margin:0;display:flex;flex-direction:column;gap:9px;min-width:0}legend{font-weight:600;font-size:13px;padding:0 6px;color:var(--tx)}.full{grid-column:1/-1}
.two{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px}
.tg{display:flex;flex-wrap:wrap;gap:5px}.tg button{border:1px solid var(--bd2);background:var(--sf);border-radius:999px;padding:3px 10px;cursor:pointer;font-size:12.5px}.tg button[aria-pressed=true]{background:var(--ac);border-color:var(--ac);color:var(--act);font-weight:600}
.qp{display:flex;align-items:center;gap:10px;background:var(--sf2);border-radius:8px;padding:6px 10px;flex-wrap:wrap}.qp code{flex:1;min-width:200px;background:transparent;padding:0;overflow-wrap:anywhere;white-space:pre-wrap;max-height:4.5em;overflow:auto;font-family:inherit;font-size:13px}
.note{font-size:12.5px;color:var(--wt);background:var(--wb);border:1px solid var(--wbd);border-radius:6px;padding:4px 9px}
.tree{border:1px solid var(--bd2);border-radius:6px;padding:6px;background:var(--sf);display:flex;flex-direction:column;gap:4px}.tree input{width:100%}
.tl{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto}.tl li{display:flex;align-items:center;gap:2px}.tl .tgl{width:22px;min-width:22px;height:22px;border:0;background:transparent;cursor:pointer;color:var(--mu);border-radius:4px;padding:0}
.tl .nm{border:0;background:transparent;text-align:left;padding:3px 6px;border-radius:4px;cursor:pointer;color:var(--tx);font:inherit;overflow-wrap:anywhere}.tl button.nm:hover{background:var(--acs)}.tl .nm.on{background:var(--acs);color:var(--ac);font-weight:600}.tl .nm.off{color:var(--mu)}
.srcs{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:4px}.srcs .srcn{font-weight:600}.pill{font-size:12px;border-radius:999px;padding:1px 8px;background:var(--sf2);color:var(--mu)}.pill.on{background:var(--okb);color:var(--ok)}.pill.wait{background:var(--wnb,#fff4d6);color:var(--wn,#7a5200)}
.lk,.lst{display:flex;flex-direction:column;gap:4px}.lst .tg{max-height:180px;overflow:auto}.yb span.ar{background:var(--wn,#b07a00);opacity:.75}
dialog.rd{width:min(1120px,calc(100vw - 24px));max-width:none;height:min(92vh,1040px);padding:0;display:none;flex-direction:column}dialog.rd[open]{display:flex}
.rdh{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--bd)}.rdt{min-width:0;flex:1 1 300px}.rdt h3{margin:2px 0 0;font-size:16px;overflow-wrap:anywhere}
.rdb{overflow:auto;padding:14px 18px 24px;display:flex;flex-direction:column;gap:16px}.rdb0{display:flex;flex-direction:column;gap:16px}.rdb h4{margin:0 0 6px;font-size:12.5px;color:var(--mu);text-transform:uppercase;letter-spacing:.04em}
.rdf{display:grid;grid-template-columns:minmax(130px,max-content) minmax(0,1fr) minmax(130px,max-content) minmax(0,1fr);gap:4px 14px;margin:0;background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}.rdf dt{color:var(--mu);font-size:12.5px;font-weight:600}.rdf dd{margin:0;overflow-wrap:anywhere;font-size:13.5px}
.rd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.rd-box{border:1px solid var(--bd);border-radius:8px;padding:10px 12px;background:var(--sf);display:flex;flex-direction:column;gap:6px}
.rd-box.req{border-left:4px solid var(--ac)}.rd-box.sol{border-left:4px solid var(--ok);background:var(--okb)}
.tl-list{display:flex;flex-direction:column;gap:10px}
.tl-item{border:1px solid var(--bd);border-left:4px solid var(--ac);border-radius:8px;background:var(--sf);padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.tl-item.note-int{border-left-color:var(--st);background:var(--wb)}
.tl-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--mu);border-bottom:1px solid var(--bd);padding-bottom:5px}
.tl-hd b{color:var(--tx);font-size:13px}
.tl-bd{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font-size:13.5px}
.pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:8px 10px;line-height:1.5}
.rdtab{width:100%;border-collapse:collapse;font-size:13px}.rdtab th,.rdtab td{border-bottom:1px solid var(--bd);padding:5px 6px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}.rdtab th{color:var(--mu);font-weight:600}.rdtw{overflow:auto}
.ppl{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;align-items:start}
.pf-ghd{grid-column:1/-1;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--mu);margin:4px 0 -2px;padding-bottom:3px;border-bottom:1px dashed var(--bd)}
.pr{display:flex;flex-direction:column;gap:6px;background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;min-width:0}
.pr.on{border-color:var(--ac);background:var(--acs)}
.pr.open{grid-column:1/-1}
.pr-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.pr .lb{font-size:13px;font-weight:600;color:var(--tx);line-height:1.3}.pr .lb small{display:block;font-weight:400;font-size:11.5px;color:var(--mu)}
.pr .cv{display:flex;flex-direction:column;gap:4px;min-width:0}.pr .act{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.sug{list-style:none;margin:0;padding:4px;border:1px solid var(--bd2);border-radius:6px;background:var(--sf);max-height:220px;overflow:auto}.sug li button{width:100%;text-align:left;border:0;background:transparent;padding:5px 8px;border-radius:4px;cursor:pointer}.sug li button:hover{background:var(--acs)}
.yc{margin-bottom:10px;padding:12px 14px}.yc h3{margin:0 0 8px}.yr{display:grid;grid-template-columns:52px minmax(0,1fr) 110px auto;gap:8px;align-items:center;font-size:13px;padding:2px 0}.yr .yb{height:8px;background:var(--sf2);border-radius:4px;overflow:hidden;display:flex}.yr .yb span{display:block;height:100%;background:var(--ac)}.yr .yn{text-align:right;font-variant-numeric:tabular-nums}.yr.on b{color:var(--ac)}.yr.on .yb span{background:var(--st)}
.chip{display:inline-flex;align-items:center;gap:3px;background:var(--acs);color:var(--ac);border-radius:999px;padding:2px 5px 2px 10px;font-size:12.5px;font-weight:600}.chip button{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 3px;font-size:14px;line-height:1;border-radius:50%}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.chips:empty{display:none}
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
@media (max-width:820px){.ppl{grid-template-columns:1fr}.rdf{grid-template-columns:minmax(110px,max-content) minmax(0,1fr)}.res-grid{grid-template-columns:1fr}.facets{position:static;flex-direction:row;flex-wrap:wrap;max-height:none}.facet{flex:1 1 200px}.ag,.two{grid-template-columns:1fr}.top{flex-wrap:wrap;gap:8px}.tabs{order:3;flex-basis:100%}}
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
    <div class="sbar"><input id="q" type="search" placeholder="Cerca nei ticket (Search)… es. detassazione premio, codice ticket, testo" aria-label="Testo da cercare" spellcheck="false" list="hist-list"><datalist id="hist-list"></datalist><button type="submit" class="btn pri" id="go">Cerca</button></div>
    <div class="quick">
     <label class="fld">Data di apertura (Opening date)<select id="preset"><option value="">Qualsiasi</option><option value="30d">Ultimi 30 giorni</option><option value="3m">Ultimi 3 mesi</option><option value="6m">Ultimi 6 mesi</option><option value="1y">Ultimi 12 mesi</option><option value="ytd">Anno corrente</option><option value="py">Anno scorso</option><option value="2y">Ultimi 2 anni</option><option value="5y">Ultimi 5 anni</option><option value="custom">Personalizzato</option></select></label>
     <label class="fld">Aperta dal (From)<input type="date" id="dfrom"></label>
     <label class="fld">Aperta al (To)<input type="date" id="dto"></label>
     <label class="fld">Stato (Status)<select id="st"><option value="all">Tutti gli stati</option><option value="open">Aperti</option><option value="closed">Chiusi e risolti</option><option value="custom">Scegli stati…</option><option value="page">Come nella pagina</option></select></label>
     <label class="fld">Massimo ticket<select id="capq" title="Righe chieste al portale in una ricerca (le più recenti)"><option>50</option><option>100</option><option>200</option><option>500</option></select></label>
    </div>
    <div class="srcs" id="srcs"><span class="mu sm">Dove cercare:</span><span class="srcn">Portale Touch</span><label class="ck"><input type="checkbox" id="src-ar"> anche nell'Area Riservata <span class="mu sm">(vecchia Ricerca rapida, altri ticket)</span></label><span id="ar-state" class="pill"></span><button type="button" class="btn gh s" id="ar-connect">Collega l'Area Riservata</button></div>
    <div id="ar-help" class="note" hidden></div>
    <div id="qactive" class="chips"></div>
    <details class="adv" id="adv"><summary>Tutti i filtri di Touch e opzioni avanzate <span class="mu sm" id="adv-n"></span></summary>
     <div class="ag">
      <fieldset><legend>Oggetto e parole nel testo</legend>
       <label class="fld">Oggetto (Subject)<input id="subject" placeholder="es. conguaglio"></label>
       <label class="fld">Escludi parole (sui risultati)<input id="exclude" placeholder='es. storno "cassa integrazione"'></label>
       <label class="ck"><input type="checkbox" id="allw"> Tutte le parole cercate devono comparire in oggetto, richiesta o soluzione (verifica sui risultati)</label>
      </fieldset>
      <fieldset><legend>Ultimo aggiornamento e classificazioni (Touch)</legend>
       <div class="two"><label class="fld">Aggiornato dal (Last update from)<input type="date" id="ufrom"></label><label class="fld">Aggiornato al (Last update to)<input type="date" id="uto"></label></div>
       <div class="two"><label class="fld">Classificazione (Classification)<input id="classif" placeholder="es. Normativa"></label><label class="fld">Classificazione cliente (Client Classification)<input id="classcli" placeholder="es. Custom"></label></div>
      </fieldset>
      <fieldset class="full" id="st-box" hidden><legend>Stati (Status)</legend><div class="tg" id="st-list"></div><div class="row"><button type="button" class="btn gh s" data-sel="st:all">Tutti</button><button type="button" class="btn gh s" data-sel="st:open">Solo aperti</button><button type="button" class="btn gh s" data-sel="st:closed">Solo chiusi</button><button type="button" class="btn gh s" data-sel="st:none">Nessuno</button></div></fieldset>
      <fieldset class="full"><legend>Priorità (Priority) <span class="mu sm">— nessuna scelta = tutte</span></legend><div class="tg" id="pr-list"></div></fieldset>
      <fieldset class="full" id="ppl-box"><legend>Gruppi e persone (Assegnato a, Gruppo proprietario, Modificato da, Responsabile)</legend><div class="ppl" id="ppl"></div>
       <p class="mu sm" style="margin:0">Usa i tasti rapidi <b>Io</b> / <b>Il mio gruppo</b>, scrivi un nome per cercare o premi <b>Scegli…</b> per aprire l'albero dei gruppi.</p></fieldset>
      <fieldset class="full" id="pf-box"><legend>Servizio, cliente, canale e altri filtri di Touch</legend><div class="ppl" id="pf"></div>
       <p class="mu sm" style="margin:0">Tutti i filtri dell'elenco <b>All tickets</b> di Touch (Servizio, Sede/Account, Contatto, Origine, Canale, Sollecito, Top client, Tag, Catalogo, Escalated, Stato lavorazione): valgono su tutti i ticket e si salvano nelle ricerche salvate.</p></fieldset>
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
    <li>In <b>Tutti i filtri di Touch e opzioni avanzate</b> trovi tutti i 23 filtri di Touch organizzati in riquadri chiari: gruppi e persone (con <b>Io</b> e <b>Il mio gruppo</b>), Servizio, Sede/Account, Contatto, Origine, Canale, Sollecito, Top client, Tag, Voce di catalogo, Escalated, Stato lavorazione.</li>
    <li>Con <b>Collega l'Area Riservata</b> si cerca anche nella vecchia Ricerca rapida (altri ticket): si apre in una nuova scheda, lì si preme il segnalibro e si conferma.</li>
    <li><b>Leggi</b> mostra il ticket completo nel pannello con <b>Richiesta</b>, <b>Soluzione</b> e l'intero <b>Storico conversazioni / Note interne</b>; <b>Apri in Touch</b> apre la scheda nel portale. <kbd>/</kbd> per cercare, <kbd>Esc</kbd> per tornare al portale, un altro clic sul segnalibro per riaprire.</li></ul></div>
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
    const loadComboOnce = (suffix) => {
      if (!m) return;
      const f = m.field(suffix);
      const key = `${m.key}:${suffix}`;
      if (!f || listLoaded.has(key)) return;
      try {
        const st = typeof f.getStore === "function" ? f.getStore() : f.store;
        const px = st && typeof st.getProxy === "function" ? st.getProxy() : null;
        if (px && !px.isMemoryProxy && !loading(st)) {
          listLoaded.add(key);
          st.load({ callback: () => renderToggles() });
        }
      } catch { /* */ }
    };
    const stOpts = m ? comboOptions(m.field("StatusFilter")) : [];
    const prOpts = m ? comboOptions(m.field("PriorityFilter")) : [];
    if (m && !stOpts.length) loadComboOnce("StatusFilter");
    if (m && !prOpts.length) loadComboOnce("PriorityFilter");
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
  const listQuery = new Map(); // testo cercato negli elenchi lunghi: resta quando la riga si ridisegna
  const listLoaded = new Set(); // elenchi senza voci già chiesti al portale (una volta per pagina)
  const openNodes = new Map(); // per campo: rami aperti dell'albero
  function changePf(m, fn) {
    if (busy()) return false;
    ensureSnapshot(m);
    try { return !!fn(); } catch { return false; }
  }
  function afterPf() { renderFilters(currentModule()); previewNow(); advCount(); }
  const PF_GROUP_LABELS = {
    client: "Servizio, centro servizi, sede e cliente",
    class: "Categoria, classificazione e tipo oggetto",
    extra: "Tag, canale, origine, sollecito e lavorazione",
    other: "Altri filtri del portale",
  };
  function renderFilters(m) {
    const fields = m ? pfFields(m) : [];
    const people = fields.filter((x) => PEOPLE_KEYS.has(x.suffix)), others = fields.filter((x) => !PEOPLE_KEYS.has(x.suffix));
    const fill = (box, list, withGroups) => {
      clear(box);
      const multiGroups = withGroups && new Set(list.map((x) => x.group || "other")).size > 1;
      let lastG = null;
      for (const x of list) {
        const g = x.group || "other";
        if (multiGroups && g !== lastG) {
          box.appendChild(h("div", { class: "pf-ghd" }, PF_GROUP_LABELS[g] || g));
          lastG = g;
        }
        box.appendChild(filterRow(m, x));
      }
    };
    fill($("#ppl"), people, false); $("#ppl-box").hidden = !people.length;
    fill($("#pf"), others, true); $("#pf-box").hidden = !others.length;
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
      const nm = u.Name || u.Description || u.FullName || (!H.ID || String(H.ID) === String(id) ? H.FullName || H.ObjectDescription : "") || "";
      return { id: String(id || ""), name: textOf(String(nm)), group: String(H.DefaultUserGroupID || ""), groupName: textOf(String(H.DefaultUserGroupDescription || H.DefaultUserGroupName || "")) };
    } catch { return null; }
  }
  const ME_FIELDS = new Set(["AssignedUserOrGroupFilter", "ModifiedBy", "OwnerUserID"]);
  const MYGROUP_FIELDS = new Set(["AssignedUserOrGroupFilter", "OwnerUserGroupID"]);
  function filterRow(m, x) {
    const { suffix, f, kind, label, hint } = x;
    const cur = pfValue(f, kind);
    const multiList = kind === "list" && isMulti(f);
    const cv = h("div", { class: "cv" });
    const act = h("div", { class: "act" });
    if (cur && !multiList && kind !== "text" && kind !== "date") {
      cv.appendChild(h("span", { class: "chips" }, h("span", { class: "chip" }, cur.t, h("button", { type: "button", "aria-label": `Togli ${label}`, title: "Togli il filtro", onclick: () => { if (changePf(m, () => { clearField(f); return true; })) afterPf(); } }, "×"))));
    } else if (!cur && (kind === "tree" || kind === "remote" || kind === "treemenu")) cv.appendChild(h("span", { class: "mu sm" }, "qualsiasi"));
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
    const quick = (v, t, text) => act.appendChild(h("button", { type: "button", class: "btn gh s", title: t, "data-quick": text, onclick: async () => {
      if (busy()) return;
      // nome mancante (il portale vero non lo dà per il gruppo): dall'albero del campo, primo livello
      if (t === v) { const ts = treeStoreOf(f); if (ts) { try { await expandNode(ts.getRootNode(), ts); const n = ts.getNodeById(v); if (n) t = nodeText(f, n) || v; } catch { /* */ } } }
      if (changePf(m, () => setPerson(f, { v, t }))) afterPf(); else if (!S.searching) toast("Il portale non ha accettato il valore");
    } }, text));
    // senza nome si passa il codice: il nome lo mette il portale (o l'albero); «Io» in una ricerca condivisa indicherebbe chi la apre
    if (who && who.id && ME_FIELDS.has(suffix) && (!cur || cur.v !== who.id)) quick(who.id, who.name || who.id, "Io");
    if (who && who.group && MYGROUP_FIELDS.has(suffix) && (!cur || cur.v !== who.group)) quick(who.group, who.groupName || who.group, "Il mio gruppo");
    if (kind === "tree" || kind === "treemenu" || kind === "remote" || (kind === "list" && !comboOptions(f).length)) {
      act.appendChild(h("button", { type: "button", class: kind === "treemenu" ? "btn s" : "btn gh s", title: "Scegli con il menu del portale: il pannello si nasconde e si riapre dopo la scelta", onclick: () => { if (!busy()) pickInPortal(m, f, label); } }, kind === "treemenu" ? "Scegli nel portale…" : "Menu del portale"));
    }
    const cls = "pr" + (cur ? " on" : "") + (openTrees.has(suffix) ? " open" : "");
    return h("div", { class: cls, "data-pf": suffix },
      h("div", { class: "pr-hd" }, h("span", { class: "lb" }, label, hint ? h("small", null, hint) : null), act),
      cv);
  }
  // ricerca del nome nel portale mentre si scrive (campi con ricerca sul server: persone, sedi, contatti...)
  function lookupEditor(m, f, label, suffix, has) {
    const wrap = h("div", { class: "lk" });
    const sug = h("ul", { class: "sug", hidden: true });
    const inp = h("input", { type: "search", placeholder: has ? "Cambia: scrivi un nome…" : "Scrivi almeno 2 lettere…", "aria-label": `Cerca ${label}`, "data-pfq": suffix, "data-ppl": suffix });
    let seq = 0, shownFor = null, pending = null;
    const first = () => { const b = sug.querySelector("button"); if (b) b.click(); };
    inp.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = inp.value.trim();
      if (shownFor === q) return first();
      if (q.length < 2) return;
      if (pending) await pending;
      if (shownFor !== inp.value.trim()) await find();
      if (shownFor === inp.value.trim()) first();
    });
    const later = debounce(() => { if (inp.isConnected && shownFor !== inp.value.trim()) find(); }, 350);
    inp.addEventListener("input", () => { shownFor = null; ++seq; later(); });
    const find = () => (pending = (async () => {
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
      shownFor = q;
    })().finally(() => { pending = null; }));
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
    const q = opts.length > 12 ? h("input", { type: "search", placeholder: `Cerca tra ${opts.length} voci…`, "aria-label": `Cerca in ${label}`, "data-pflq": suffix, value: listQuery.get(suffix) || "" }) : null;
    const draw = () => {
      clear(box);
      const n = q ? norm(q.value.trim()) : "";
      const match = opts.filter(([v, t]) => cur.has(v) || !n || norm(t).includes(n));
      // le voci scelte restano visibili (e si possono togliere) anche oltre le prime 60
      const shown = match.slice(0, 60).concat(match.slice(60).filter(([v]) => cur.has(v)));
      for (const [v, t] of shown) box.appendChild(h("button", { type: "button", "aria-pressed": String(cur.has(v)), "data-v": v, onclick: () => {
        const next = new Set(cur);
        if (next.has(v)) next.delete(v); else { if (!multi) next.clear(); next.add(v); }
        const ok = changePf(m, () => (multi ? setMulti(f, [...next]) : next.size ? setPerson(f, { v, t }) : (clearField(f), true)));
        if (!ok && !S.searching) toast("Il portale non ha accettato il valore");
        afterPf();
      } }, t));
      if (match.length > shown.length) box.appendChild(h("span", { class: "mu sm", text: `… altre ${match.length - shown.length}: restringi la ricerca` }));
      if (!shown.length) box.appendChild(h("span", { class: "mu sm", text: loadingList ? "Carico le voci dal portale…" : "Nessuna voce" }));
    };
    // elenco del campo caricato dal portale alla prima apertura del menu: si carica una volta da qui
    let loadingList = false;
    try {
      const st = !opts.length && typeof f.getStore === "function" ? f.getStore() : null;
      const px = st && typeof st.getProxy === "function" ? st.getProxy() : null;
      if (px && !px.isMemoryProxy && !loading(st) && !listLoaded.has(suffix)) {
        listLoaded.add(suffix); loadingList = true;
        st.load({ callback: () => { loadingList = false; if (wrap.isConnected) afterPf(); } });
      }
    } catch { loadingList = false; }
    if (q) {
      q.addEventListener("input", () => listQuery.set(suffix, q.value));
      q.addEventListener("input", debounce(draw, 150));
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); }); // Invio non invia il modulo (ricerca dei ticket)
      wrap.appendChild(q);
    }
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
      try { if (!n || n.isLeaf() || (n.isLoaded() && (n.childNodes.length || !n.isRoot()))) return res(true); } catch { return res(true); }
      let done = false;
      const fin = (ok) => { if (!done) { done = true; res(ok !== false); } };
      setTimeout(() => fin(false), 10000);
      try {
        const ts = st || (typeof n.getTreeStore === "function" ? n.getTreeStore() : null);
        const root = ts && typeof ts.getRootNode === "function" ? ts.getRootNode() : null;
        // mentre si carica la radice Ext ignora le richieste dei rami (TreeStore.load): si aspetta
        if (root && root !== n && root.isLoading && root.isLoading()) {
          const t = setInterval(() => { if (!root.isLoading()) { clearInterval(t); done = true; expandNode(n, ts).then(res); } }, 100);
          return;
        }
        if (ts && typeof ts.load === "function" && !n.isLoading()) {
          ts.load({ node: n, callback: (recs, op, ok) => fin(ok) });
          if (typeof ts.flushLoad === "function") ts.flushLoad();
        } else if (n.isLoading && n.isLoading()) { const t = setInterval(() => { if (!n.isLoading()) { clearInterval(t); fin(n.isLoaded()); } }, 100); } else n.expand(false, () => fin(true));
      } catch { try { n.expand(false, () => fin(true)); } catch { fin(false); } }
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
    let alive = true, deep = null, walking = false;
    const failed = new Set(); // rami che il portale non ha caricato
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
        if (isOpen) open.delete(id); else { open.add(id); note.textContent = "Carico dal portale…"; if (await expandNode(n, st)) failed.delete(id); else failed.add(id); note.textContent = ""; }
        draw();
      } }, isOpen ? "▾" : "▸"));
      const name = (path ? path + " › " : "") + nodeText(f, n) + (failed.has(id) ? " — ramo non caricato (chiudi e riapri per riprovare)" : "");
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
        if (!out.length) list.appendChild(h("li", { class: "mu sm", text: walking ? "Cerco in tutto l'elenco…" : failed.size ? "Nessun risultato nei rami caricati: alcuni rami non si sono caricati" : "Nessun risultato" }));
        return;
      }
      const walk = (n, depth) => { for (const c of kids(n)) { list.appendChild(row(c, depth, "")); if (open.has(String(c.getId()))) walk(c, depth + 1); } };
      walk(root, 0);
      if (!kids(root).length) list.appendChild(h("li", { class: "mu sm", text: failed.has(String(root.getId())) ? "Il portale non ha risposto (sessione scaduta?): riprova o usa «Menu del portale»" : "Elenco vuoto" }));
    };
    // per cercare un nome servono tutti i rami: si caricano (al massimo 80 richieste al portale)
    const loadAll = async () => {
      if (deep) return deep;
      walking = true;
      deep = (async () => {
        const queue = [st.getRootNode()];
        let loads = 0;
        while (queue.length && alive && loads < 80) {
          const n = queue.shift();
          let need = false;
          try { need = !n.isLeaf() && !n.isLoaded(); } catch { need = false; }
          if (need) { loads++; note.textContent = `Carico l'elenco dal portale… (${loads})`; if (!(await expandNode(n, st))) failed.add(String(n.getId())); draw(); }
          for (const c of kids(n)) queue.push(c);
        }
        note.textContent = queue.length ? "Elenco caricato in parte: restringi la ricerca o apri i rami" : "";
      })().finally(() => { walking = false; deep = null; draw(); });
      return deep;
    };
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); }); // Invio non invia il modulo (ricerca dei ticket)
    q.addEventListener("input", debounce(() => { if (norm(q.value.trim()).length >= 2) loadAll(); draw(); }, 250));
    if (!st) { note.textContent = "Elenco non leggibile: usa «Menu del portale»"; return wrap; }
    note.textContent = "Carico dal portale…";
    expandNode(st.getRootNode(), st).then((ok) => { if (!ok) failed.add(String(st.getRootNode().getId())); note.textContent = ""; draw(); });
    return wrap;
  }
  async function queryField(f, q) {
    const st = typeof f.getStore === "function" ? f.getStore() : f.store;
    if (!st) return [];
    const vf = f.valueField || "value", df = f.displayField || "text";
    const map = (r) => {
      const d = (r && (typeof r.getData === "function" ? r.getData() : r.data)) || {};
      const vRaw = (r && typeof r.get === "function" ? r.get(vf) : undefined) ?? d[vf] ?? d.value ?? d.Value ?? d.ID ?? d.Id ?? d.id ?? d.Code ?? "";
      const tRaw = (r && typeof r.get === "function" ? r.get(df) : undefined) ?? d[df] ?? d.text ?? d.Text ?? d.Description ?? d.Name ?? d.ObjectDescription ?? vRaw;
      return { r, v: String(vRaw ?? ""), t: textOf(String(tRaw ?? "")) };
    };
    if (f.queryMode === "local") { const n = norm(q); return st.getRange().map(map).filter((x) => x.v && norm(x.t).includes(n)); }
    // richiesta a parte con il proxy del campo: non apre il menu e non ricarica l'elenco del campo (che con
    // forceSelection cancellerebbe il valore già scelto). Se però il proxy non restituisce voci (es. PageProxy di
    // Ext.Net che richiede l'evento beforequery del campo), passiamo sotto a f.doQuery.
    try {
      const px = typeof st.getProxy === "function" ? st.getProxy() : null;
      if (px && typeof px.createOperation === "function") {
        const recs = await new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error("timeout")), 8000);
          const op = px.createOperation("read", { params: Object.assign({}, st.lastOptions && st.lastOptions.params, { [f.queryParam || "query"]: q }), page: 1, start: 0, limit: 50,
            callback: (records, o, ok) => { clearTimeout(to); if (ok === false) rej(new Error("errore")); else res(records || []); } });
          op.execute();
        });
        const mapped = recs.map(map).filter((x) => x.v);
        if (mapped.length) {
          activity(true);
          return mapped;
        }
      }
    } catch { /* sotto: con il campo stesso */ }
    const prev = personValue(f);
    let loaded = false;
    const on = () => { loaded = true; };
    st.on("load", on);
    const was = !!(document.body && document.body.inert);
    try {
      if (document.body) document.body.inert = false;
      f.lastQuery = null;
      if (f.inputEl && f.inputEl.dom) f.inputEl.dom.value = q;
      f.doQuery(q, false, true);
    } catch { try { st.load({ params: { [f.queryParam || "query"]: q } }); } catch { /* */ } } finally { if (document.body) document.body.inert = was; }
    await waitUntil(() => loaded && !loading(st), 8000);
    st.un("load", on);
    const out = st.getRange().map(map).filter((x) => x.v);
    try { if (typeof f.collapse === "function") f.collapse(); } catch { /* */ }
    if (prev && !personValue(f)) { try { setPerson(f, prev); } catch { /* */ } }
    activity(true);
    return out;
  }
  function pickRecord(f, r) {
    try {
      const vf = f.valueField || "value", df = f.displayField || "text";
      const code = String((r && typeof r.get === "function" ? r.get(vf) : (r && r.data && r.data[vf])) ?? "");
      const label = textOf(String((r && typeof r.get === "function" ? r.get(df) : (r && r.data && r.data[df])) ?? code));
      f.setValue(r);
      syncHiddenJson(f, code, label);
      try { if (typeof f.checkChange === "function") f.checkChange(); } catch { /* */ }
      try { if (typeof f.fireEvent === "function") f.fireEvent("select", f, r); } catch { /* */ }
      if (scalarValue(f, f.getValue()) === code) return true;
      return setPerson(f, { v: code, t: label });
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
              const from = `${y}-${pad(mo)}-01`, to = `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
              if ((s.dfrom && s.dfrom > to) || (s.dto && s.dto < from)) continue; // mese fuori dal periodo
              $("#progt").textContent = `Area Riservata: ${MESI_L[mo - 1]} ${y}…`;
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
        if (PEOPLE_KEYS.has(x.suffix)) continue;
        const want = s.pf[x.suffix], cur = pfValue(x.f, x.kind);
        if (!want && !cur) continue;
        if (want && cur && JSON.stringify(cur.v) === JSON.stringify(want.v)) continue;
        ensureSnapshot(m);
        try { if (!setPf(x.f, want, x.kind) && want) bad.push(x.label); } catch { if (want) bad.push(x.label); }
      }
      const have = new Set(pfFields(m).map((x) => x.suffix));
      for (const [k, want] of Object.entries(s.pf)) if (want && !PEOPLE_KEYS.has(k) && !have.has(k)) bad.push(want.t ? `${k} (${want.t})` : k);
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
      const labels = m ? new Map(pfFields(m).map((x) => [x.suffix, x.short || x.label])) : new Map();
      for (const [suffix, v] of Object.entries(s.pf)) if (v && v.v !== undefined) p.push(`${labels.get(suffix) || (PF_META[suffix] && (PF_META[suffix].short || PF_META[suffix].label)) || suffix} = ${v.t || (Array.isArray(v.v) ? v.v.join(", ") : v.v)}`);
    }
    if (s.exclude) p.push(`poi senza: ${s.exclude}`);
    return p.join(" · ");
  }
  function renderQueryChips(s, m) {
    const box = clear($("#qactive"));
    if (!box) return;
    const chips = [];
    const pushChip = (text, fn) => chips.push(h("span", { class: "chip" }, text, h("button", { type: "button", title: "Togli questo filtro", "aria-label": `Togli ${text}`, onclick: fn }, "×")));
    if (s.dfrom || s.dto) pushChip(`Apertura: ${s.dfrom ? fmtDate(s.dfrom) : "…"} → ${s.dto ? fmtDate(s.dto) : "…"}`, () => { $("#dfrom").value = ""; $("#dto").value = ""; $("#preset").value = ""; onFormChange(); });
    if (s.ufrom || s.uto) pushChip(`Aggiornato: ${s.ufrom ? fmtDate(s.ufrom) : "…"} → ${s.uto ? fmtDate(s.uto) : "…"}`, () => { $("#ufrom").value = ""; $("#uto").value = ""; onFormChange(); });
    if (s.st && s.st !== "all") {
      const stl = { open: "Stato: Aperti", closed: "Stato: Chiusi e risolti", page: "Stato: Come nella pagina", custom: `Stati scelti (${(s.stCodes || []).length})` };
      pushChip(stl[s.st] || `Stato: ${s.st}`, () => { $("#st").value = "all"; $("#st-box").hidden = true; onFormChange(); });
    }
    for (const p of s.pr || []) pushChip(`Priorità: ${p}`, () => { S.prCodes.delete(p); renderToggles(); onFormChange(); });
    if (s.subject) pushChip(`Oggetto: "${s.subject}"`, () => { $("#subject").value = ""; onFormChange(); });
    if (s.exclude) pushChip(`Escludi: ${s.exclude}`, () => { $("#exclude").value = ""; onFormChange(); });
    if (s.allWords) pushChip("Tutte le parole", () => { $("#allw").checked = false; onFormChange(); });
    if (s.classif) pushChip(`Classificazione: "${s.classif}"`, () => { $("#classif").value = ""; onFormChange(); });
    if (s.classcli) pushChip(`Classif. cliente: "${s.classcli}"`, () => { $("#classcli").value = ""; onFormChange(); });
    for (const [suffix, label] of PEOPLE) {
      const v = s.people && s.people[suffix];
      if (v) pushChip(`${label.replace(/ \(.*$/, "")}: ${v.t || v.v}`, () => {
        const mod = currentModule(); const f = mod && mod.field(suffix);
        if (f && changePf(mod, () => { clearField(f); return true; })) afterPf();
      });
    }
    if (s.pf && typeof s.pf === "object") {
      const metaMap = m ? new Map(pfFields(m).map((x) => [x.suffix, x])) : new Map();
      for (const [suffix, v] of Object.entries(s.pf)) {
        if (!v || v.v === undefined) continue;
        const info = metaMap.get(suffix);
        const lbl = (info && info.label) || suffix;
        pushChip(`${lbl}: ${v.t || (Array.isArray(v.v) ? v.v.join(", ") : v.v)}`, () => {
          const mod = currentModule(); const f = mod && mod.field(suffix);
          if (f && changePf(mod, () => { clearField(f); return true; })) afterPf();
        });
      }
    }
    if (chips.length) {
      box.appendChild(h("span", { class: "mu sm" }, "Filtri attivi:"));
      for (const c of chips) box.appendChild(c);
    }
  }
  function previewNow() {
    const m = currentModule();
    const s = spec();
    $("#qprev").textContent = `${describe(s, m)} · tutti i ticket (${m ? m.title : "All tickets"}) · i ${settings.cap} più recenti`;
    renderQueryChips(s, m);
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
  // in attesa del segnalibro nella scheda dell'Area Riservata: «hello» ogni secondo, con un codice nuovo
  function arWait() {
    AR.nonce = randomId();
    AR.state = "waiting";
    clearInterval(AR.timer);
    const t0 = Date.now();
    AR.timer = setInterval(() => {
      if (AR.state !== "waiting") { clearInterval(AR.timer); return; }
      if (!AR.win || AR.win.closed || Date.now() - t0 > 20 * 60000) { arDrop(); renderArState(); return; }
      arPost({ type: "hello", nonce: AR.nonce, from: `Ricerca TKT ${VERSION}` });
    }, 1000);
  }
  function arConnect() {
    if (AR.state === "on") { arPost({ type: "bye", nonce: AR.nonce }); arDrop(); renderArState(); return; }
    AR.origin = arOriginOf();
    try { AR.win = window.open(arUrl(), "rtkt-ar"); } catch { AR.win = null; }
    if (!AR.win) { toast("Il browser ha bloccato la nuova scheda: consenti le finestre popup per questo sito e riprova"); return; }
    arWait();
    renderArState();
  }
  window.addEventListener("pagehide", () => { if (AR.state === "on") arPost({ type: "bye", reason: "pagehide", nonce: AR.nonce }); });
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d.ns !== "rtkt" || d.v !== 1) return;
    // «bye»: la pagina dell'Area Riservata si chiude o cambia (Chrome lo consegna con e.source null) o l'utente la scollega
    if (d.type === "bye") {
      if (!AR.win || e.origin !== AR.origin || (e.source !== AR.win && e.source !== null) || !AR.nonce || d.nonce !== AR.nonce || AR.state !== "on") return;
      if (d.reason === "pagehide" && !AR.win.closed) { arDrop("La pagina dell'Area Riservata è cambiata: quando è di nuovo la «Ricerca rapida», premi lì il segnalibro"); arWait(); }
      else arDrop("Area Riservata scollegata");
      renderArState(); previewNow(); return;
    }
    if (!AR.win || e.source !== AR.win || e.origin !== AR.origin) return;
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
    const tickets = [], seen = new Set(), cappedMonths = [], failedMonths = [];
    let max = null, n = 0, lastErr = null, fails = 0, okN = 0;
    while ((y < +b[1] || (y === +b[1] && mo <= +b[2])) && n < 36) {
      n++;
      if (progress) progress(`${MESI_L[mo - 1]} ${y}…`);
      const from = `${y}-${pad(mo)}-01`, to = `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
      let r;
      try { r = await arSearch(Object.assign({}, s, { dfrom: s.dfrom && s.dfrom > from ? s.dfrom : from, dto: s.dto && s.dto < to ? s.dto : to }), signal, null); } catch (e) {
        if (e && e.name === "AbortError") throw e;
        lastErr = e;
        // due mesi di fila non riusciti o scheda scollegata: inutile continuare (sessione scaduta, pagina che non risponde)
        if (++fails >= 2 || !arOn()) { failedMonths.push(`${fails >= 2 ? failedMonths.pop() : `${MESI[mo - 1]} ${y}`} e seguenti`); break; }
        failedMonths.push(`${MESI[mo - 1]} ${y}`);
        mo++; if (mo > 12) { mo = 1; y++; }
        continue;
      }
      fails = 0; okN++;
      max = r.max || max;
      if (r.capped) cappedMonths.push(`${MESI[mo - 1]} ${y}`);
      for (const t of r.tickets) if (!seen.has(t.key)) { seen.add(t.key); tickets.push(t); }
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    if (lastErr && !okN) throw lastErr; // nessun mese riuscito: come una ricerca non riuscita
    return { tickets, capped: cappedMonths.length > 0, cappedMonths, failedMonths, failMsg: lastErr ? str(lastErr.message, 300) : "", max, count: tickets.length, months: n, ms: 0 };
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
    if (t.url) { window.open(t.url, "_blank", "noopener"); return; }
    // senza indirizzo (url1 «function:…»): si apre solo dalla pagina dell'Area Riservata
    if (t.number) {
      copyText(`#${t.number}`, `Questo ticket si apre solo dall'Area Riservata: cercalo lì con il numero #${t.number} (copiato negli appunti)`);
      try { if (AR.win && !AR.win.closed) AR.win.focus(); } catch { /* */ }
    } else toast("Questo ticket si apre solo dalla pagina dell'Area Riservata");
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
      if (need.length && t.src !== "ar" && !need.every((w) => x.includes(w))) { dropped++; continue; }
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
    if (!wanted && m) {
      // Se l'utente ha scritto del testo in un filtro con ricerca sul server (es. Servizio o Sede) senza premere
      // Invio né cliccare un suggerimento prima di premere «Cerca», selezioniamo automaticamente la prima voce trovata
      for (const inp of $$("input[data-pfq]")) {
        const q = (inp.value || "").trim();
        const suffix = inp.getAttribute("data-pfq");
        if (q.length < 2 || !suffix) continue;
        const f = m.field(suffix);
        if (!f || personValue(f)) continue;
        try {
          const list = await queryField(f, q);
          if (list && list.length) {
            const it = list[0];
            ensureSnapshot(m);
            if (it.r) pickRecord(f, it.r); else setPerson(f, { v: it.v, t: it.t });
            inp.value = "";
          }
        } catch { /* */ }
      }
      renderFilters(m);
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
    let arStopped = false;
    const addAr = async () => {
      if (!arP) return 0;
      if (S.searching) $("#progt").textContent = "Aspetto i risultati dell'Area Riservata…";
      const a = await arP;
      if (!a.ok) {
        if (a.e && a.e.name === "AbortError") { arStopped = true; pushAlert("warn", "Ricerca nell'Area Riservata interrotta: i risultati sono solo quelli del portale Touch."); }
        else pushAlert("warn", `Area Riservata: ${(a.e && a.e.message) || "errore"}. I risultati sono solo quelli del portale Touch.`);
        return 0;
      }
      const before = S.results.length;
      const inPeriod = (t) => !t.date || ((!s.dfrom || t.date >= s.dfrom) && (!s.dto || t.date <= s.dto));
      const list = a.v.tickets.filter(inPeriod);
      const dropped = addResults(list, s) + (a.v.tickets.length - list.length);
      S.info = Object.assign(S.info || { total: 0, loaded: 0, page: 1, pageSize: settings.cap, dropped: 0, ms: 0 }, {});
      S.info.dropped += dropped;
      S.info.ar = { loaded: a.v.tickets.length, added: S.results.length - before, capped: a.v.capped, max: a.v.max, ms: a.v.ms };
      if (a.v.failedMonths && a.v.failedMonths.length) pushAlert("warn", `Area Riservata, cercata mese per mese: mancano i ticket di ${a.v.failedMonths.join(", ")} (${a.v.failMsg || "errore"}). Ripeti la ricerca per averli.`);
      if (a.v.months) { if (a.v.capped) pushAlert("warn", `Area Riservata, cercata mese per mese: in ${a.v.cappedMonths.join(", ")} ci sono più di ${fmtN(a.v.max || 210)} ticket (il massimo per ricerca): restringi la ricerca per vederli tutti.`); }
      else if (a.v.capped) pushAlert("warn", `L'Area Riservata restituisce al massimo ${fmtN(a.v.max || a.v.tickets.length)} ticket per ricerca: qui ci sono i primi ${fmtN(a.v.tickets.length)}, non tutti. ${S.info.state ? "Restringi il periodo o usa «Quanti per anno?» e cerca un anno alla volta." : "Restringi il periodo e cerca un anno alla volta."}`);
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
      hist.unshift({ spec: s, arMonths: withAr && !!(wanted && wanted.arMonths) ? true : undefined, stopped: arStopped || undefined, results: S.results.length, total: r.total + (S.info.ar ? S.info.ar.loaded : 0), created: new Date().toISOString() });
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
      mergeByDate(); // con l'Area Riservata l'elenco resta in ordine di data
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
    if (S.info && S.info.state && (S.info.total > S.info.loaded || (ar && ar.capped))) {
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
    const cnts = Array.isArray(t.counters) ? t.counters.map((c) => h("span", { class: "pill", text: c })) : [];
    return h("article", { class: "res" + (sel ? " sel" : "") },
      h("div", { class: "rh" },
        noSel ? null : h("input", { type: "checkbox", "aria-label": `Seleziona ${label}`, checked: sel, onchange: (e) => { if (e.target.checked) S.selected.add(t.key); else S.selected.delete(t.key); render(); } }),
        h("a", { class: "num", href: "#", title: "Leggi il ticket completo", onclick: (e) => { e.preventDefault(); readTicket(t); } }, label),
        t.src === "ar" ? h("span", { class: "badge src" }, "Area Riservata") : null,
        t.code ? h("button", { type: "button", class: "ib", title: "Copia ID", "aria-label": "Copia ID", onclick: () => copyText(t.code, `Copiato ${t.code}`) }, "⧉") : null,
        t.status ? h("span", { class: "badge" + (CLOSED_RE.test(t.status) ? " cl" : "") }, t.status) : null,
        t.priority ? h("span", { class: "badge pr" }, t.priority) : null,
        t.date ? h("time", { class: "mu", text: `${fmtDate(t.date)}${t.time ? " " + t.time : ""}` }) : null,
        cnts,
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
    return h("button", { type: "button", class: "btn s gh", title: t.src === "ar" ? "Senza indirizzo: copia il numero, da cercare nella scheda dell'Area Riservata" : "Apri con il pulsante Open del portale (nuova scheda)", onclick: () => openTicket(t) }, t.src === "ar" ? "Copia numero AR" : text);
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
  const isInternalMsg = (m) => !!(m && (m.internal || /nota interna|internal note|nota sul cliente|notes on customer/i.test(String(m.kind || m.type || ""))));
  function renderRead(box, c, t) {
    const words = S.words;
    const texts = Array.isArray(c.texts) ? c.texts : [];
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const usedIdx = new Set();
    const isReqLabel = (lbl) => /^(richiesta|issue|request|problem|descrizione)/i.test(lbl || "");
    const isSolLabel = (lbl) => /^(soluzione|resolution|solution|risoluzione)/i.test(lbl || "");
    const reqIdx = texts.findIndex((x) => isReqLabel(x.label));
    const solIdx = texts.findIndex((x) => isSolLabel(x.label));
    if (reqIdx >= 0) usedIdx.add(reqIdx);
    if (solIdx >= 0) usedIdx.add(solIdx);
    const earliestReqMsg = reqIdx < 0 && msgs.length ? [...msgs].reverse().find((m) => !isInternalMsg(m) && (m.body || m.text)) : null;
    const reqVal = (reqIdx >= 0 ? texts[reqIdx].value : "") || (t && t.preview) || (earliestReqMsg ? (earliestReqMsg.body || earliestReqMsg.text) : "");
    const reqLbl = (reqIdx >= 0 && texts[reqIdx].label) || "Richiesta (Issue/Request)";
    const solVal = (solIdx >= 0 ? texts[solIdx].value : "") || (t && t.resolution) || "";
    const solLbl = (solIdx >= 0 && texts[solIdx].label) || "Soluzione (Resolution)";
    const normReq = norm(reqVal);
    const normSol = norm(solVal);
    texts.forEach((x, i) => {
      if (isReqLabel(x.label) || isSolLabel(x.label)) usedIdx.add(i);
      const nv = norm(x.value);
      if (nv && (nv === normReq || nv === normSol)) usedIdx.add(i);
    });
    if (reqVal || solVal) {
      const grid = h("div", { class: "rd-grid" });
      if (reqVal) grid.appendChild(h("section", { class: "rd-box req" }, h("h4", null, reqLbl), h("div", { class: "pre" }, hl(reqVal, words))));
      if (solVal) grid.appendChild(h("section", { class: "rd-box sol" }, h("h4", null, solLbl), h("div", { class: "pre" }, hl(solVal, words))));
      box.appendChild(grid);
    }
    if (msgs.length) {
      let mode = "all";
      const listEl = h("div", { class: "tl-list" });
      const nInt = msgs.filter(isInternalMsg).length, nPub = msgs.length - nInt;
      const filterBar = nInt > 0 && nPub > 0 ? h("div", { class: "tg" }) : null;
      const drawMsgs = () => {
        clear(listEl);
        if (filterBar) {
          clear(filterBar);
          for (const [k, lbl] of [["all", `Tutti (${msgs.length})`], ["pub", `Comunicazioni (${nPub})`], ["int", `Note interne (${nInt})`]]) {
            filterBar.appendChild(h("button", { type: "button", "aria-pressed": String(mode === k), onclick: () => { mode = k; drawMsgs(); } }, lbl));
          }
        }
        const shown = msgs.filter((m) => mode === "all" || (mode === "int" ? isInternalMsg(m) : !isInternalMsg(m)));
        for (const m of shown) {
          const isInt = isInternalMsg(m);
          const kind = m.kind || m.type || (isInt ? "Nota interna" : "Messaggio");
          const who = m.who || m.author || "";
          const body = m.body || m.text || "";
          listEl.appendChild(h("article", { class: "tl-item" + (isInt ? " note-int" : "") },
            h("div", { class: "tl-hd" },
              h("span", { class: "badge" + (isInt ? " src" : "") }, kind),
              who ? h("b", null, hl(who, words)) : null,
              m.date ? h("span", { class: "mu" }, m.date) : null,
              m.hasAttachment ? h("span", { class: "pill" }, "📎 Allegato") : null),
            h("div", { class: "tl-bd" }, hl(body, words))));
        }
      };
      drawMsgs();
      box.appendChild(h("section", null,
        h("div", { class: "row between", style: "margin-bottom:6px" }, h("h4", { style: "margin:0" }, `Storico conversazioni e note (${msgs.length})`), filterBar),
        listEl));
    }
    texts.forEach((x, i) => {
      if (usedIdx.has(i)) return;
      box.appendChild(h("section", null, x.label ? h("h4", null, x.label) : null, h("div", { class: "pre" }, hl(x.value, words))));
    });
    if (c.fields && c.fields.length) box.appendChild(h("section", null, h("h4", null, "Dati del ticket"), h("dl", { class: "rdf" }, c.fields.map((x) => [h("dt", null, x.label || "—"), h("dd", null, hl(x.value, words))]))));
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
      if (c.messages && c.messages.length) {
        out.push("", "Storico conversazioni:");
        for (const m of c.messages) out.push(`[${[m.date, m.kind || m.type, m.who || m.author].filter(Boolean).join(" · ")}]`, m.body || m.text || "");
      }
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
    // il ticket già letto si riusa solo se l'elenco non lo mostra aggiornato da allora
    const ver = `${t.status || ""}|${t.updated || ""}|${t.updTime || ""}`;
    const cached = READ.get(t.key);
    if (cached && cached.ver === ver) { renderRead(box, cached, t); setReadLink(t, cached.url); return; }
    box.appendChild(h("div", { class: "mu", text: t.src === "ar" ? "Leggo il ticket dall'Area Riservata…" : "Leggo il ticket completo e lo storico dal portale…" }));
    try {
      const c = t.src === "ar" ? await arRead(t, ctrl.signal) : await loadTouchTicket(t, ctrl.signal);
      if (ctrl !== readCtrl) return;
      c.ver = ver;
      READ.set(t.key, c);
      clear(box); renderRead(box, c, t); setReadLink(t, c.url);
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
  // ricerche della 2.x (senza pf, la 2.0 anche senza people): nessun filtro, come dopo l'importazione (importSpec)
  const fullSpec = (s) => (s && typeof s === "object" ? Object.assign({}, s, { people: s.people && typeof s.people === "object" ? s.people : {}, pf: s.pf && typeof s.pf === "object" && !Array.isArray(s.pf) ? s.pf : {} }) : s);
  async function openSpec(s) {
    s = fullSpec(s);
    if (busy()) return false;
    tab("search");
    if (!currentModule()) { const p = ensureAllTickets(); previewNow(); await p; } // «Apro la scheda All tickets del portale…»
    applySpec(s);
    return true;
  }
  async function runSpec(s, arMonths) { s = fullSpec(s); if (await openSpec(s)) runSearch({ people: s && s.people, pf: s && s.pf, arMonths: arMonths === true }); }
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
      h("div", { class: "m" }, h("div", { class: "t", text: safeDescribe(it.spec) }), h("div", { class: "s", text: `${fmtDT(it.created)} · ${fmtN(it.results)} risultati${it.total > it.results ? ` su ${fmtN(it.total)}` : ""}${it.stopped ? " (Area Riservata interrotta)" : ""}${it.arMonths ? " · Area Riservata mese per mese" : ""}` })),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec, it.arMonths === true) }, "Ripeti"),
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
    // indirizzo dell'Area Riservata: completo («https://» se manca) e di un altro sito, altrimenti non si salva nulla
    const raw = $("#s-arurl").value.trim();
    let arU = AR_DEFAULT;
    if (raw) {
      arU = null;
      try { const x = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : "https://" + raw.replace(/^\/+/, "")); if (/^https?:$/.test(x.protocol) && x.hostname.includes(".") && x.origin !== location.origin) arU = x.href; } catch { /* */ }
      if (!arU) { toast(`Indirizzo dell'Area Riservata non valido: scrivilo completo, per esempio ${AR_DEFAULT}`); $("#s-arurl").focus(); return; }
    }
    settings.arUrl = arU;
    settings.cap = CAPS.includes(+$("#s-cap").value) ? +$("#s-cap").value : 200;
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
