/*
 * Ricerca TKT — versione "segnalibro" (bookmarklet) per il portale ticket Zucchetti (HDAPortal).
 *
 * Si avvia dentro il portale, già aperto e con l'utente collegato. Il portale è un'applicazione
 * ExtJS: le ricerche usano l'elenco "All tickets" della pagina stessa (i suoi filtri e il suo
 * archivio dati), quindi passano per la sessione, i controlli e i permessi del portale, senza
 * password, server o installazioni. Una richiesta per ricerca, con un numero massimo di risultati.
 * Preferiti, note, ricerche salvate e cronologia restano nel browser (localStorage del portale).
 */
(() => {
  "use strict";
  const NS = "__RicercaTKT__";
  const VERSION = "2.1.0";
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

  // ===================================================================== ambiente: il portale ExtJS
  const Ext = window.Ext;
  if (!Ext || !Ext.ComponentQuery || typeof Ext.getCmp !== "function") {
    const old = !!window.ZtVWeb || /\/areariservata\//i.test(location.pathname);
    alert(old
      ? "Ricerca TKT 2 funziona sul nuovo portale ticket (HDAPortal), non sulla vecchia Area Riservata.\n\nApri il portale ticket, vai nella scheda \u00abAll tickets\u00bb e clicca di nuovo il segnalibro."
      : "Ricerca TKT: apri il portale ticket Zucchetti (dopo l'accesso), vai nella scheda \u00abAll tickets\u00bb e clicca di nuovo il segnalibro.");
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
  function ownerBody(c) {
    for (let p = c, i = 0; p && i < 40; p = p.ownerCt || (typeof p.up === "function" ? p.up() : null), i++) if (/^body_/.test(p.id || "")) return p;
    return null;
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
      const domBody = el ? el.closest('[id^="body_"]') : null;
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
  const DEFAULT_SETTINGS = { v: 1, cap: 200, list: "" };
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
  const conn = { ext: [], xhr: [], seq: 0, errors: [], lastRun: null };
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
          if (r && !/\.(js|css|png|gif|jpe?g|svg|woff2?)(\?|$)/i.test(r.url) && !/signalr/i.test(r.url)) {
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
  function maskDeep(v, keepSet, depth = 0) {
    if (depth > 7) return "…";
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v;
      if (keepSet.has(norm(s).trim())) return s;
      if (/^\s*[[{]/.test(s)) { try { return { json: maskDeep(JSON.parse(s), keepSet, depth + 1) }; } catch { /* non JSON */ } }
      if (!s.trim() || KEEP_WORDS.has(s.toLowerCase())) return s;
      if (/^(?=.*[0-9_])[A-Z0-9_\-.,/]{1,14}$/.test(s.trim()) || /^[A-Z]{1,4}$/.test(s.trim())) return s;
      if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s) || /^\/Date\(-?\d+\)\/$/.test(s)) return s;
      if (s.length <= 60 && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) && (/[a-z][A-Z]/.test(s) || /[._]/.test(s) || /^[A-Z]{2,}[a-z]/.test(s))) return s;
      return `\u00ab${s.length} car.\u00bb`;
    }
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => maskDeep(x, keepSet, depth + 1));
    if (typeof v === "object") { const o = {}; for (const k of Object.keys(v).slice(0, 80)) o[k] = maskDeep(v[k], keepSet, depth + 1); return o; }
    return typeof v;
  }
  function maskUrl(u, keepSet) {
    try {
      const x = new URL(u, location.href);
      const q = [];
      for (const [k, v] of x.searchParams) q.push(`${k}=${JSON.stringify(maskDeep(v, keepSet))}`);
      return x.pathname + (q.length ? " ? " + q.join(" & ") : "");
    } catch { return "(url)"; }
  }
  function maskBody(b, keepSet) {
    const s = String(b || "");
    if (!s) return "";
    if (/^\s*[[{]/.test(s)) return maskDeep(s, keepSet);
    if (/=/.test(s) && !/\s/.test(s.slice(0, 200))) {
      const o = {};
      for (const part of s.split("&")) { const i = part.indexOf("="); const k = decodeURIComponentSafe(i < 0 ? part : part.slice(0, i)); o[k] = maskDeep(decodeURIComponentSafe(i < 0 ? "" : part.slice(i + 1)), keepSet); }
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
      for (const r of st.getRange()) {
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
  function personValue(f) {
    try {
      const v = scalarValue(f, f.getValue());
      if (!v || /^\[\{"value":""/.test(v)) return null;
      return { v, t: fieldDisplay(f) || v };
    } catch { return null; }
  }
  const canLookup = (f) => !!(f && typeof f.doQuery === "function" && typeof f.getStore === "function" && !f.readOnly && f.editable !== false);
  function setPerson(f, d) {
    const same = () => scalarValue(f, f.getValue()) === String(d.v);
    const vf = f.valueField || "value", df = f.displayField || "text";
    let st = null;
    try { st = typeof f.getStore === "function" ? f.getStore() : null; } catch { /* */ }
    try { const r = st && typeof st.findRecord === "function" ? st.findRecord(vf, d.v, 0, false, true, true) : null; if (r) { f.setValue(r); if (same()) return true; } } catch { /* */ }
    try { f.setValue(d.v); if (same()) return true; } catch { /* */ }
    try { if (st && typeof st.add === "function" && !st.isTreeStore) { const [r] = st.add({ [vf]: d.v, [df]: d.t }); f.setValue(r); if (same()) return true; } } catch { /* */ }
    return false;
  }
  function clearField(f) {
    try { if (typeof f.clearValue === "function") f.clearValue(); else f.setValue(null); } catch { try { f.setValue(""); } catch { /* */ } }
  }
  function keptFilters(m) {
    return filterFields(m).filter(({ suffix, f }) => !(suffix in CONTROLLED) && !PEOPLE_KEYS.has(suffix) && !(f.isXType && f.isXType("hiddenfield")))
      .map(({ suffix, f }) => ({ suffix, f, label: fieldLabel(f, suffix), value: fieldDisplay(f) }))
      .filter((x) => x.value && !/^\[\{"value":""/.test(x.value));
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
  function watchStore(st) {
    const w = { started: 0, loaded: 0, lastAt: 0, ok: null, error: "" };
    const before = () => { w.started++; w.lastAt = performance.now(); };
    const load = (s, recs, ok, op) => {
      if (!w.started) return; // caricamento partito prima della ricerca
      w.loaded++; w.lastAt = performance.now(); w.ok = ok !== false;
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
    const ok = await waitUntil(() => w.loaded > 0 && !loading(st) && performance.now() - w.lastAt > 700, 120000, signal);
    if (!ok) throw new Error("Il portale non ha finito di caricare l'elenco dopo 2 minuti.");
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
    for (const suffix of [...Object.keys(CONTROLLED), ...PEOPLE_KEYS]) {
      const f = m.field(suffix);
      if (!f) continue;
      try { const v = f.getValue(); out.push(isDate(v) ? isoOf(v) : Array.isArray(v) ? asList(v).sort().join(",") : scalarValue(f, v)); } catch { out.push("?"); }
    }
    return out.join("\u0001");
  }
  async function reload(m, apply, run, signal) {
    const st = m.store;
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
      if (changed) triggers[m.key] = run.trigger.startsWith("invio") ? "invio" : run.trigger;
    } finally { w.stop(); }
  }
  // valori dei filtri della pagina prima della prima ricerca, per poterli ripristinare
  function snapshot(m) {
    const values = {};
    for (const suffix of [...Object.keys(CONTROLLED), ...PEOPLE_KEYS]) {
      const f = CONTROLLED[suffix] || PEOPLE_KEYS.has(suffix) ? m.field(suffix) : null;
      if (f) { try { const v = f.getValue(); values[suffix] = Array.isArray(v) ? v.slice() : v; } catch { /* */ } }
    }
    let quick, pageSize = null;
    try { quick = m.quick ? m.quick.getValue() : undefined; } catch { /* */ }
    try { pageSize = m.store.getPageSize(); } catch { /* */ }
    return { values, quick, pageSize };
  }
  async function pageSearch(m, s, signal) {
    const run = { at: new Date().toISOString(), list: m.key, trigger: "", applied: [], failed: [], loads: 0, ms: 0, verified: null, pageSize: null };
    conn.lastRun = run;
    const seq0 = conn.seq;
    const t0 = performance.now();
    if (!S.snaps[m.key]) S.snaps[m.key] = snapshot(m);
    try {
      await reload(m, () => { run.pageSize = setPageSize(m.store); applyValues(m, s, run); }, run, signal);
      const reqs = [...conn.ext, ...conn.xhr].filter((r) => r.seq > seq0);
      const probe = norm(s.text || s.subject || "").split(/\s+/).filter((x) => x.length >= 3)[0];
      if (probe && reqs.length) run.verified = reqs.some((r) => reqBlob(r).includes(probe));
      return readStore(m);
    } finally { run.ms = Math.round(performance.now() - t0); }
  }
  async function restoreSnapshot(m, sn, signal) {
    const run = { trigger: "", loads: 0 };
    await reload(m, () => {
      for (const [suffix, v] of Object.entries(sn.values)) {
        const f = m.field(suffix);
        if (!f) continue;
        try {
          if (Array.isArray(v) || f.multiSelect) setMulti(f, asList(v));
          else if (v === null || v === undefined || v === "") { if (typeof f.clearValue === "function") f.clearValue(); else f.setValue(null); }
          else f.setValue(v);
        } catch { /* */ }
      }
      if (m.quick && sn.quick !== undefined) { try { m.quick.setValue(sn.quick); } catch { /* */ } }
      try { if (sn.pageSize && typeof m.store.setPageSize === "function") m.store.setPageSize(sn.pageSize); } catch { /* */ }
    }, run, signal);
  }
  async function loadNextPage(m, signal) {
    const st = m.store;
    const w = watchStore(st);
    try {
      activity(true);
      const cur = st.currentPage || 1;
      st.loadPage(cur + 1);
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
  function sections(title) {
    const out = [];
    const re = /(?:^|\n\s*\n)([A-Za-z\u00c0-\u00ff][^\n:]{0,40}):[ \t]*\n/g;
    const marks = [];
    let x;
    while ((x = re.exec(title))) marks.push({ label: x[1].trim(), start: x.index, body: re.lastIndex });
    for (let i = 0; i < marks.length; i++) out.push([marks[i].label, title.slice(marks[i].body, i + 1 < marks.length ? marks[i + 1].start : undefined).trim()]);
    return out;
  }
  function toTicket(m, rec, row, cols) {
    const t = { key: "", code: "", recId: "", list: m.key, rank: row, cols: [] };
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
  function findButton(m, re) {
    const lists = [];
    try { const tb = Ext.getCmp(m.P + "listToolbar"); if (tb && tb.query) lists.push(tb.query("button")); } catch { /* */ }
    try { if (m.cmp && m.cmp.query) lists.push(m.cmp.query("button")); } catch { /* */ }
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
  function showModuleTab(m) {
    try {
      const body = Ext.getCmp("body_" + m.key);
      const tp = body && typeof body.up === "function" ? body.up("tabpanel") : null;
      if (tp && tp.getActiveTab() !== body) tp.setActiveTab(body);
    } catch { /* */ }
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
  async function openTicket(t) {
    const m = currentModule();
    const rec = recordFor(m, t);
    hide();
    activity(true);
    if (rec) {
      showModuleTab(m);
      await sleep(50);
      try { m.grid.getSelectionModel().select([rec]); } catch { /* */ }
      const b = findButton(m, /^(open|apri)$/i);
      if (b && !(typeof b.isDisabled === "function" && b.isDisabled()) && clickBtn(b)) return;
      try {
        const view = m.grid.getView();
        m.grid.fireEvent("itemdblclick", view, rec, view.getNode(rec), m.store.indexOf(rec), new Ext.event.Event(new MouseEvent("dblclick", { bubbles: true })));
        return;
      } catch { /* sotto: Find by ID */ }
    }
    await findById(m, t.code);
  }
  async function findById(m, code) {
    if (code) await copyText(code, null);
    const b = m && findButton(m, /^(find by id|trova per id|cerca per id|trova id|vai al ticket)/i);
    if (!b) { show(); toast(code ? `Ticket ${code} non presente nell'elenco: numero copiato, aprilo dal portale` : "Ticket non presente nell'elenco"); return; }
    showModuleTab(m);
    await sleep(50);
    clickBtn(b);
    if (!code) return;
    let field = null;
    await waitUntil(() => {
      const wins = Ext.ComponentQuery.query("window").filter((w) => w.isVisible && w.isVisible());
      for (const w of wins.reverse()) {
        const f = w.query("textfield").find((x) => x.isVisible && x.isVisible() && !(x.isXType && x.isXType("hiddenfield")));
        if (f) { field = f; return true; }
      }
      return false;
    }, 2500);
    if (!field) return;
    try { field.setValue(code); field.focus(true, 30); } catch { /* */ }
    // conferma con il pulsante della finestra (OK / Find / Cerca...), se riconoscibile
    try {
      const w = field.up("window");
      const ok = w && w.query("button").filter((x) => x.isVisible && x.isVisible(true))
        .find((x) => /^(ok|find|search|cerca|trova|apri|open|vai|go)$/i.test(textOf(String((x.getText ? x.getText() : x.text) || ""))));
      if (ok && String(field.getValue()) === code) { await sleep(80); clickBtn(ok); }
    } catch { /* l'utente conferma a mano */ }
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
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--acs);color:var(--ac);white-space:nowrap}.badge.cl{background:var(--okb);color:var(--ok)}.badge.pr{background:var(--sf2);color:var(--mu)}
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
.kept{display:flex;flex-direction:column;gap:5px}.kept .chip{align-self:flex-start}
.ppl{display:flex;flex-direction:column;gap:8px}.pr{display:grid;grid-template-columns:230px minmax(0,1fr) auto;gap:8px;align-items:start}.pr .lb{font-size:13px;padding-top:6px}.pr .cv{display:flex;flex-direction:column;gap:4px;min-width:0}.pr .act{display:flex;gap:4px;flex-wrap:wrap}
.sug{list-style:none;margin:0;padding:4px;border:1px solid var(--bd2);border-radius:6px;background:var(--sf);max-height:220px;overflow:auto}.sug li button{width:100%;text-align:left;border:0;background:transparent;padding:5px 8px;border-radius:4px;cursor:pointer}.sug li button:hover{background:var(--acs)}
.yc{margin-bottom:10px;padding:12px 14px}.yc h3{margin:0 0 8px}.yr{display:grid;grid-template-columns:52px minmax(0,1fr) 80px auto;gap:8px;align-items:center;font-size:13px;padding:2px 0}.yr .yb{height:8px;background:var(--sf2);border-radius:4px;overflow:hidden}.yr .yb span{display:block;height:100%;background:var(--ac)}.yr .yn{text-align:right;font-variant-numeric:tabular-nums}.yr.on b{color:var(--ac)}.yr.on .yb span{background:var(--st)}
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
       <p class="mu sm" style="margin:0">Scrivi un nome per cercarlo nel portale, oppure usa <b>Scegli nel portale</b>: si apre il menu del portale per quel campo e, dopo la scelta, Ricerca TKT si riapre da solo.</p></fieldset>
      <fieldset class="full"><legend>Altri filtri impostati nella pagina del portale</legend><div class="kept" id="kept"></div>
       <p class="mu sm" style="margin:0">Servizio, Sede, Contatto, Assegnato a, Gruppo… si impostano nei filtri del portale (chiudi con Esc): Ricerca TKT li mantiene in tutte le ricerche.</p></fieldset>
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
    <li>Gruppi e persone (Assegnato a, Gruppo, Modificato da, Responsabile) sono filtri del portale, quindi valgono su tutti i ticket; nei risultati ci sono anche le faccette.</li>
    <li><b>Apri</b> apre il ticket nel portale; <kbd>/</kbd> per cercare, <kbd>Esc</kbd> per tornare al portale, un altro clic sul segnalibro per riaprire.</li></ul></div>
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
   <div class="card"><h2>Dati personali</h2><p class="mu sm">Preferiti, note, ricerche salvate e cronologia sono salvati solo in questo browser.</p>
    <div class="row"><button type="button" class="btn" id="pexp">Esporta</button><label class="btn">Importa<input type="file" id="pimp" accept="application/json,.json" hidden></label><button type="button" class="btn gh dg" id="pdel">Cancella tutto</button></div></div>
   <div class="row end" style="margin-top:14px"><button type="button" class="btn pri" id="ssave">Salva impostazioni</button></div>
   <p class="mu sm">Ricerca TKT ${VERSION} · versione segnalibro per il portale ticket</p>
  </section>
 </div></div>
 <dialog id="dnote"><form method="dialog"><h3 id="ntitle">Nota</h3><label class="fld">Nota personale<textarea id="ntext" rows="5"></textarea></label><label class="fld">Etichette (separate da virgola)<input id="ntags" placeholder="es. da verificare, normativa"></label><div class="row end"><button type="button" value="cancel" class="btn gh">Annulla</button><button type="button" value="remove" class="btn gh dg" id="nrem">Rimuovi dai preferiti</button><button value="ok" class="btn pri">Salva</button></div></form></dialog>
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
  const emptyFacets = () => ({ status: new Set(), priority: new Set(), service: new Set(), group: new Set(), assigned: new Set(), owner: new Set(), modifiers: new Set(), site: new Set(), year: null, month: null, tags: new Set() });
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
  // ---- gruppi e persone
  function renderPeople(m) {
    const box = clear($("#ppl"));
    const present = m ? PEOPLE.filter(([k]) => m.field(k)) : [];
    $("#ppl-box").hidden = !present.length;
    for (const [suffix, label] of present) {
      const f = m.field(suffix);
      const cur = personValue(f);
      const sug = h("ul", { class: "sug", hidden: true });
      const inp = canLookup(f) ? h("input", { type: "search", placeholder: cur ? "Cambia: scrivi un nome…" : "Scrivi almeno 2 lettere del nome…", "aria-label": `Cerca ${label}`, "data-ppl": suffix }) : null;
      if (inp) {
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
            const ok = it.r ? pickRecord(f, it.r) : setPerson(f, { v: it.v, t: it.t });
            if (!ok) toast("Il portale non ha accettato il valore: usa «Scegli nel portale»");
            renderPeople(currentModule()); previewNow(); advCount();
          } }, it.t)));
        }, 350));
      }
      box.appendChild(h("div", { class: "pr" },
        h("span", { class: "lb" }, label),
        h("div", { class: "cv" }, cur ? h("span", { class: "chip" }, cur.t, h("button", { type: "button", "aria-label": `Togli ${label}`, title: "Togli il filtro", onclick: () => { clearField(f); renderPeople(currentModule()); previewNow(); advCount(); } }, "×")) : h("span", { class: "mu sm", style: "padding-top:6px" }, "qualsiasi"), inp, sug),
        h("div", { class: "act" }, h("button", { type: "button", class: "btn s", onclick: () => pickInPortal(m, f, label) }, "Scegli nel portale…"))));
    }
  }
  async function queryField(f, q) {
    const st = f.getStore();
    const vf = f.valueField || "value", df = f.displayField || "text";
    const map = (r) => ({ r, v: String(r.get(vf) ?? ""), t: textOf(String(r.get(df) ?? r.get(vf) ?? "")) });
    if (f.queryMode === "local") { const n = norm(q); return st.getRange().map(map).filter((x) => x.v && norm(x.t).includes(n)); }
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
      if (f && typeof f.isVisible === "function" && !f.isVisible(true) && m.cmp && m.cmp.el) {
        const tg = m.cmp.el.dom.querySelector(".filter-toggle");
        if (tg) tg.click();
      }
    } catch { /* */ }
  }
  async function pickInPortal(m, f, label) {
    hide();
    showModuleTab(m);
    await sleep(60);
    expandFilters(m, f);
    await sleep(150);
    let done = false;
    const back = () => {
      if (done) return;
      done = true;
      try { f.un("change", onChange); } catch { /* */ }
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => { hidePill(); show(); $("#adv").open = true; }, 300);
    };
    const onChange = () => { if (personValue(f)) back(); };
    const onKey = (e) => { if (e.key === "Escape" && !(f.isExpanded)) back(); };
    f.on("change", onChange);
    document.addEventListener("keydown", onKey, true);
    showPill(`Scegli «${label}» nel portale · poi Ricerca TKT si riapre (clic qui per tornare subito)`, back);
    try { if (f.el && f.el.dom) f.el.dom.scrollIntoView({ block: "center" }); } catch { /* */ }
    try { if (typeof f.focus === "function") f.focus(); } catch { /* */ }
    try { if (typeof f.expand === "function") f.expand(); else if (typeof f.onTriggerClick === "function") f.onTriggerClick(); } catch { /* */ }
  }
  // ---- distribuzione per anno (una richiesta al portale per anno, fino a coprire il totale)
  function renderYears() {
    const box = clear($("#years"));
    const y = S.years;
    box.hidden = !y;
    if (!y) return;
    const max = Math.max(1, ...y.rows.map(([, n]) => n));
    box.appendChild(h("div", { class: "row between" }, h("h3", null, "Ticket per anno nel portale"),
      h("span", { class: "mu sm" }, y.running ? `conteggio in corso… ${fmtN(y.sum)} su ${fmtN(y.total)}` : `${fmtN(y.sum)} su ${fmtN(y.total)} contati${y.stopped ? " (interrotto)" : ""}`)));
    for (const [yy, n] of y.rows) {
      const bar = h("span");
      bar.style.width = `${(n / max) * 100}%`;
      box.appendChild(h("div", { class: "yr" + (y.active === yy ? " on" : "") }, h("b", null, String(yy)), h("div", { class: "yb" }, bar), h("span", { class: "yn" }, fmtN(n)),
        n ? h("button", { type: "button", class: "btn gh s", disabled: y.running, onclick: () => searchYear(yy) }, `Cerca nel ${yy}`) : h("span")));
    }
  }
  function searchYear(y) {
    const s = S.last || spec();
    const from = `${y}-01-01`, to = `${y}-12-31`;
    $("#dfrom").value = s.dfrom && s.dfrom > from ? s.dfrom : from;
    $("#dto").value = s.dto && s.dto < to ? s.dto : to;
    $("#preset").value = "custom";
    onFormChange();
    if (S.years) { S.years.active = y; S.keepYears = S.years; }
    runSearch();
  }
  async function yearCounts() {
    const m = currentModule();
    if (!m || S.searching || !S.last || !S.info) return;
    const s = S.last;
    const nowY = new Date().getFullYear();
    const toY = s.dto ? Math.min(nowY, +s.dto.slice(0, 4)) : nowY;
    const fromY = s.dfrom ? +s.dfrom.slice(0, 4) : 1990;
    const ctrl = new AbortController();
    S.abort = ctrl; S.searching = true; $("#prog").hidden = false; $("#progt").textContent = "Conto i ticket anno per anno…"; $("#go").disabled = true;
    S.years = { rows: [], sum: 0, total: S.info.total, running: true, stopped: false };
    render(); renderYears();
    let zeros = 0;
    try {
      for (let y = toY; y >= fromY; y--) {
        const sp = Object.assign({}, s, { dfrom: s.dfrom && s.dfrom > `${y}-01-01` ? s.dfrom : `${y}-01-01`, dto: s.dto && s.dto < `${y}-12-31` ? s.dto : `${y}-12-31`, people: undefined });
        const run = { applied: [], failed: [], trigger: "", loads: 0 };
        await reload(m, () => { setPageSize(m.store, 1); applyValues(m, sp, run); }, run, ctrl.signal);
        let n = 0;
        try { n = m.store.getTotalCount() || 0; } catch { /* */ }
        S.years.rows.push([y, n]); S.years.sum += n;
        renderYears();
        if (S.years.sum >= S.years.total) break;
        zeros = n ? 0 : zeros + 1;
        if (zeros >= 3 && y < nowY - 2) break;
      }
    } catch (e) {
      S.years.stopped = true;
      if (!(e && e.name === "AbortError")) pushAlert("err", e && e.message ? e.message : "Errore nel conteggio per anno");
    } finally {
      S.years.running = false;
      // l'elenco del portale torna sulla ricerca principale (serve per «Apri» e «Carica i successivi»)
      try {
        const run = { applied: [], failed: [], trigger: "", loads: 0 };
        await reload(m, () => { setPageSize(m.store); applyValues(m, Object.assign({}, s, { people: undefined }), run); }, run);
        S.info.page = 1;
      } catch { /* */ }
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false;
      renderYears(); render();
    }
  }
  function renderKept(m) {
    const box = clear($("#kept"));
    const items = m ? keptFilters(m) : [];
    if (!items.length) { box.appendChild(h("span", { class: "mu sm", text: "Nessuno." })); return; }
    for (const k of items) {
      box.appendChild(h("span", { class: "chip" }, `${k.label}: ${k.value}`, h("button", { type: "button", title: "Togli il filtro dalla pagina", "aria-label": `Togli ${k.label}`, onclick: () => {
        try { if (typeof k.f.clearValue === "function") k.f.clearValue(); else k.f.setValue(null); } catch { /* */ }
        renderKept(currentModule()); preview();
      } }, "×")));
    }
  }
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
      people: peopleSpec(currentModule()),
    };
  }
  function peopleSpec(m) {
    const out = {};
    if (!m) return out;
    for (const [suffix] of PEOPLE) { const f = m.field(suffix); const v = f ? personValue(f) : null; if (v) out[suffix] = v; }
    return out;
  }
  function applySpec(s) {
    s = s || {};
    $("#q").value = s.text || ""; $("#subject").value = s.subject || ""; $("#exclude").value = s.exclude || ""; $("#allw").checked = !!s.allWords;
    $("#dfrom").value = s.dfrom || ""; $("#dto").value = s.dto || ""; $("#ufrom").value = s.ufrom || ""; $("#uto").value = s.uto || "";
    $("#preset").value = s.dfrom || s.dto ? "custom" : "";
    $("#st").value = ["all", "open", "closed", "custom", "page"].includes(s.st) ? s.st : "all";
    S.stCodes = new Set(s.stCodes || []); S.prCodes = new Set(s.pr || []);
    $("#classif").value = s.classif || ""; $("#classcli").value = s.classcli || "";
    const m = currentModule();
    if (m && s.people && typeof s.people === "object") {
      for (const [suffix] of PEOPLE) {
        const f = m.field(suffix);
        if (!f) continue;
        const want = s.people[suffix], cur = personValue(f);
        try { if (want && want.v) { if (!cur || cur.v !== String(want.v)) setPerson(f, want); } else if (cur) clearField(f); } catch { /* */ }
      }
    }
    renderToggles(); advCount(); preview();
  }
  function advCount() {
    const s = spec();
    const n = [s.subject, s.exclude, s.allWords, s.ufrom || s.uto, s.classif, s.classcli, s.pr.length, s.st === "custom"].filter(Boolean).length + Object.keys(s.people || {}).length;
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
      const names = (S.stOpts || []).filter(([v]) => (s.stCodes || []).includes(v)).map(([, t]) => t);
      p.push(`Stato: ${names.length ? names.join(", ") : (s.stCodes || []).join(", ") || "nessuno"}`);
    } else p.push(stl[s.st] || "tutti gli stati");
    if (s.pr && s.pr.length) p.push(`Priorità: ${s.pr.join(", ")}`);
    if (s.classif) p.push(`Classificazione ~ "${s.classif}"`);
    if (s.classcli) p.push(`Classif. cliente ~ "${s.classcli}"`);
    for (const [suffix, label] of PEOPLE) { const v = s.people && s.people[suffix]; if (v) p.push(`${label.replace(/ \(.*$/, "")} = ${v.t || v.v}`); }
    if (m) { const k = keptFilters(m); if (k.length) p.push(`dalla pagina: ${k.map((x) => `${x.label} = ${x.value}`).join(", ")}`); }
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
    if (s.st === "custom" && !s.stCodes.length) box.appendChild(h("div", { class: "note", text: "Nessuno stato scelto: verrà tolto il filtro sullo stato." }));
  }
  const preview = debounce(previewNow, 120);
  function refreshHistList() {
    const dl = clear($("#hist-list"));
    const seen = new Set();
    for (const it of store.get("history", [])) { const t = it.spec && it.spec.text; if (t && !seen.has(t)) { seen.add(t); dl.appendChild(h("option", { value: t })); } if (seen.size >= 15) break; }
  }
  const wordsOf = (s) => [...new Set(`${s.text || ""} ${s.subject || ""}`.replace(/["()]/g, " ").split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2 && !/^(and|or|not|e|o)$/i.test(w)))];

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
  async function runSearch() {
    const s = spec();
    if (S.searching) return;
    const m = currentModule() || (await ensureAllTickets());
    if (!m) { toast("Non trovo l'elenco «All tickets» del portale: aprilo una volta dalla barra delle schede"); preview(); return; }
    const ctrl = new AbortController();
    S.abort = ctrl; S.last = s; S.words = wordsOf(s); S.module = m.key; S.years = S.keepYears || null; S.keepYears = null; renderYears();
    Object.assign(S, { results: [], keys: new Set(), page: 1, alerts: [], info: null, refine: "" });
    S.selected.clear(); S.facet = emptyFacets();
    $("#refine").value = ""; $("#emptyst").hidden = true; $("#results").hidden = false; $("#prog").hidden = false; $("#progt").textContent = "Ricerca in corso nel portale…"; $("#go").disabled = true;
    S.searching = true;
    renderAlerts(); render();
    try {
      const r = await pageSearch(m, s, ctrl.signal);
      const dropped = addResults(r.tickets, s);
      const run = conn.lastRun;
      S.info = { total: r.total, loaded: r.tickets.length, page: r.page, pageSize: r.pageSize, dropped, ms: run.ms };
      if (run.failed.length) pushAlert("warn", `Alcuni filtri non sono stati impostati nella pagina: ${run.failed.join("; ")}. I risultati potrebbero non rispettarli.`);
      if (run.verified === false) pushAlert("warn", "Il portale ha ricaricato l'elenco, ma la richiesta non sembra contenere il testo cercato: i risultati potrebbero non essere filtrati. Se succede, manda i dati tecnici (Impostazioni).");
      if (r.total > r.tickets.length) pushAlert("warn", `Il portale ha ${fmtN(r.total)} ticket per questa ricerca, su tutti gli anni: qui ci sono i ${fmtN(r.tickets.length)} più recenti. Con «Quanti per anno?» vedi come si distribuiscono e cerchi in un anno solo; oppure restringi la ricerca o carica i successivi.`);
      if (dropped) pushAlert("info", `${fmtN(dropped)} ticket scartati dai filtri sui risultati.`);
      if (!r.tickets.length && r.total) pushAlert("warn", "Il portale indica dei risultati ma l'elenco è vuoto: manda i dati tecnici da Impostazioni.");
      const hist = store.get("history", []);
      hist.unshift({ spec: s, results: S.results.length, total: r.total, created: new Date().toISOString() });
      store.set("history", hist.slice(0, 200));
      refreshHistList();
    } catch (e) {
      if (e && e.name === "AbortError") pushAlert("warn", "Ricerca interrotta: il portale potrebbe completare comunque il caricamento dell'elenco.");
      else { pushAlert("err", e && e.message ? e.message : "Errore durante la ricerca"); conn.errors.push(String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)); }
    } finally {
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false;
      renderKept(currentModule()); preview(); render();
    }
  }
  async function loadMore() {
    const m = currentModule();
    if (!m || S.searching || !S.info || m.key !== S.module) return;
    S.years = null; renderYears();
    const ctrl = new AbortController();
    S.abort = ctrl; S.searching = true; $("#prog").hidden = false; $("#progt").textContent = "Carico i ticket successivi…"; $("#go").disabled = true;
    render();
    try {
      const r = await loadNextPage(m, ctrl.signal);
      const before = S.results.length;
      S.info.dropped += addResults(r.tickets, S.last);
      S.info.loaded += r.tickets.length; S.info.page = r.page; S.info.total = r.total;
      toast(`Aggiunti ${fmtN(S.results.length - before)} ticket`);
    } catch (e) { pushAlert("err", e && e.message ? e.message : "Errore"); } finally {
      S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false; render();
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
  const FACETS = [["status", "Stato"], ["priority", "Priorità"], ["group", "Gruppo"], ["assigned", "Assegnato a"], ["owner", "Responsabile"], ["modifiers", "Modificato da"], ["service", "Servizio"], ["site", "Sede / cliente"]];
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
    if (S.info && S.info.total > total) parts.push(h("span", { class: "mu" }, `, i più recenti su ${fmtN(S.info.total)} nel portale`));
    if (nv !== total) parts.push(" · ", h("b", null, fmtN(nv)), " dopo i filtri");
    if (S.info) parts.push(h("span", { class: "mu" }, ` · ${(S.info.ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} s`));
    if (S.info && S.info.total > S.info.loaded) {
      parts.push(h("button", { type: "button", class: "btn s", id: "yearsbtn", onclick: yearCounts, title: "Conta i ticket di questa ricerca anno per anno (una richiesta al portale per anno)" }, "Quanti per anno?"));
      parts.push(h("button", { type: "button", class: "btn s", id: "more", onclick: loadMore }, `Carica i successivi ${fmtN(Math.min(S.info.pageSize || settings.cap, S.info.total - S.info.loaded))}`));
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
        h("a", { class: "num", href: "#", title: "Apri il ticket nel portale", onclick: (e) => { e.preventDefault(); openTicket(t); } }, label),
        t.code ? h("button", { type: "button", class: "ib", title: "Copia ID", "aria-label": "Copia ID", onclick: () => copyText(t.code, `Copiato ${t.code}`) }, "⧉") : null,
        t.status ? h("span", { class: "badge" + (CLOSED_RE.test(t.status) ? " cl" : "") }, t.status) : null,
        t.priority ? h("span", { class: "badge pr" }, t.priority) : null,
        t.date ? h("time", { class: "mu", text: `${fmtDate(t.date)}${t.time ? " " + t.time : ""}` }) : null,
        h("span", { class: "sp" }),
        h("button", { type: "button", class: "ib" + (fav ? " on" : ""), "aria-pressed": String(!!fav), title: fav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti", onclick: () => toggleFav(t) }, fav ? "★" : "☆"),
        h("button", { type: "button", class: "ib", title: "Nota ed etichette", "aria-label": "Nota ed etichette", onclick: () => openNote(t) }, "✎"),
        h("button", { type: "button", class: "btn s", onclick: () => openTicket(t) }, "Apri ↗")),
      h("div", { class: "subj" }, hl(t.subject || "(senza oggetto)", words)),
      t.preview ? h("div", { class: "snip" }, hl(t.preview, words)) : null,
      t.resolution ? h("div", { class: "snip rs" }, h("b", null, "Soluzione: "), hl(t.resolution, words)) : null,
      h("div", { class: "meta" }, metaItem("Sede", [t.site, t.siteCode].filter(Boolean).join(" · ")), metaItem("Contatto", t.contact), metaItem("Servizio", t.service),
        metaItem("Classificazione", t.classification), metaItem("Assegnato a", t.assigned), metaItem("Gruppo", t.group), metaItem("Responsabile", t.owner !== t.assigned ? t.owner : ""), metaItem("Modificato da", t.modifiers),
        t.updated ? metaItem("Aggiornato", `${fmtDate(t.updated)}${t.updTime ? " " + t.updTime : ""}`) : null, metaItem("SLA", t.sla), metaItem("Tag", t.tags)),
      extra.length ? h("div", { class: "meta" }, extra) : null,
      t.cols && t.cols.length ? h("details", { class: "cols" }, h("summary", null, "Tutte le colonne"), h("dl", null, t.cols.map((c) => [h("dt", null, c.h), h("dd", null, c.v)]))) : null);
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
  function runSpec(s) { tab("search"); applySpec(s); runSearch(); }
  function renderSaved() {
    const box = clear($("#saved"));
    const items = store.get("saved", []);
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: 'Nessuna ricerca salvata: usa "Salva ricerca" sotto la barra di ricerca.' })); return; }
    items.forEach((it, i) => box.appendChild(h("div", { class: "li" },
      h("div", { class: "m" }, h("div", { class: "t", text: it.name }), h("div", { class: "s", text: describe(it.spec) })),
      h("span", { class: "mu sm", text: fmtDT(it.created) }),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec) }, "Esegui"),
      h("button", { type: "button", class: "btn gh s", onclick: () => { tab("search"); applySpec(it.spec); } }, "Apri"),
      h("button", { type: "button", class: "btn gh s dg", onclick: () => { if (!confirm(`Eliminare la ricerca "${it.name}"?`)) return; const all = store.get("saved", []); all.splice(i, 1); store.set("saved", all); renderSaved(); } }, "Elimina"))));
  }
  function renderHistory() {
    const box = clear($("#hist"));
    const items = store.get("history", []);
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: "La cronologia è vuota." })); return; }
    for (const it of items) box.appendChild(h("div", { class: "li" },
      h("div", { class: "m" }, h("div", { class: "t", text: describe(it.spec) }), h("div", { class: "s", text: `${fmtDT(it.created)} · ${fmtN(it.results)} risultati${it.total > it.results ? ` su ${fmtN(it.total)}` : ""}` })),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec) }, "Ripeti"),
      h("button", { type: "button", class: "btn gh s", onclick: () => { tab("search"); applySpec(it.spec); } }, "Apri")));
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
        t.firstRowShape = cols.map((c) => { const p = cellParts(m, first, c, 0); return `${c.header}: ${p.parts.length} parti${p.title ? ", title " + p.title.length + " car. " + JSON.stringify(sections(p.title).map(([l]) => l)) : ""}`; });
      }
    } catch (e) { t.columnsError = String(e && e.message); }
    t.filters = filterFields(m).map(({ suffix, f }) => {
      const opts = comboOptions(f);
      const controlled = suffix in CONTROLLED;
      let value = "";
      try { value = controlled ? maskDeep(f.getValue(), keepSet) : (fieldDisplay(f) ? "(impostato)" : ""); } catch { /* */ }
      const o = { suffix, cls: f.$className, xtype: f.xtype, name: f.getName ? f.getName() : f.name, label: fieldLabel(f, suffix), controlled, value, options: opts.length, sample: opts.slice(0, 20).map(([v, x]) => (controlled ? `${v}=${x}` : v)), valueField: f.valueField, displayField: f.displayField, multi: !!f.multiSelect, listeners: names(f.hasListeners) };
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
      tabs: portalTabs().map((x) => ({ text: x.text, card: x.card ? x.card.id : null, cardCls: x.card ? x.card.$className : null })),
      current: m ? moduleTech(m, keepSet) : null,
      lastSearch: conn.lastRun ? Object.assign({}, conn.lastRun, { spec: maskDeep(s, keepSet) }) : null,
      requests: conn.ext.slice(-12).map(req), xhr: conn.xhr.slice(-12).map(req), errors: conn.errors.slice(-10), settings,
    };
  }
  function renderSettings() {
    $("#s-cap").value = String(settings.cap);
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
  const TKEYS = ["code", "recId", "list", "date", "time", "updated", "updTime", "subject", "preview", "resolution", "site", "siteCode", "contact", "status", "priority", "service", "classification", "assigned", "group", "owner", "modifiers", "sender", "sla", "tags"];
  function importTicket(t, key) {
    const o = { key: str(key, 300) };
    for (const k of TKEYS) if (t[k] !== undefined && t[k] !== null) o[k] = str(t[k], k === "preview" || k === "resolution" ? 6000 : 500);
    for (const k of ["date", "updated"]) if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) delete o[k];
    o.cols = Array.isArray(t.cols) ? t.cols.slice(0, 60).map((c) => ({ h: str(c && c.h, 100), v: str(c && c.v, 2000) })) : [];
    return o;
  }
  const importSpec = (sp) => (sp && typeof sp === "object" ? JSON.parse(JSON.stringify(sp)) : null);
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
        const k = (x) => `${x.name}\u0001${JSON.stringify(x.spec)}`;
        const seen = new Set(cur.map(k));
        for (const x of d.saved) {
          const spc = x && x.name && importSpec(x.spec);
          if (!spc) continue;
          const item = { name: str(x.name, 200), spec: spc, created: str(x.created, 40) };
          if (!seen.has(k(item))) { seen.add(k(item)); cur.push(item); ns++; }
        }
        cur.sort((a, b) => a.name.localeCompare(b.name, "it"));
        store.set("saved", cur);
      }
      if (Array.isArray(d.history)) {
        const cur = store.get("history", []);
        const k = (x) => `${x.created}\u0001${JSON.stringify(x.spec)}`;
        const seen = new Set(cur.map(k));
        for (const x of d.history) {
          const spc = x && importSpec(x.spec);
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
  $("#qreset").addEventListener("click", () => { applySpec({ people: {} }); $("#q").focus(); });
  $("#qsave").addEventListener("click", () => { const s = spec(); $("#sname").value = s.text || s.subject || ""; $("#dsave").showModal(); $("#sname").select(); });
  $("#stop").addEventListener("click", () => S.abort && S.abort.abort());
  $("#qrestore").addEventListener("click", async () => {
    const m = currentModule();
    const sn = m && S.snaps[m.key];
    if (!sn || S.searching) return;
    S.searching = true; $("#go").disabled = true; $("#qrestore").disabled = true;
    try { await restoreSnapshot(m, sn); delete S.snaps[m.key]; toast("Filtri dell'elenco del portale ripristinati"); }
    catch (e) { toast(e && e.message ? e.message : "Ripristino non riuscito"); }
    finally { S.searching = false; $("#go").disabled = false; $("#qrestore").disabled = false; renderKept(currentModule()); preview(); }
  });
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
    host.style.display = ""; document.documentElement.style.overflow = "hidden"; if (document.body) document.body.inert = true;
    renderToggles(); previewNow();
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
