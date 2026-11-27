// Ricerca TKT v5 — app principale (pagina dell'estensione).
//
// Gestisce le 5 fonti (HDA Touch, Vecchio Cruscotto, Storico, Knowledge Base Touch, FAQ Touch),
// la barra di navigazione sinistra, la colonna filtri richiudibile (Opzione B), i risultati,
// il pannello Attività recente e il lettore unificato.

import { h, clear, $, highlight, toast, icon } from "./dom.js";
import { renderSidebar, renderDateBar } from "./sidebar.js";
import { renderReader, renderReaderLoading, renderReaderError } from "./reader.js";
import { openDiag } from "./diag.js";
import { makeTransport, AuthError, PORTAL_BASE } from "../lib/transport.js";
import { makeHda } from "../lib/hda.js";
import { makeAr, emptyArFilters, hasArFilter } from "../lib/ar.js";
import { sortByRelevance, matchesAllTerms, bestSnippet, searchTerms, highlightPatterns, listFilter } from "../lib/relevance.js";
import { makeStorico, emptyStoricoFilters, hasStoricoFilter, enrichArTicket, movePeople } from "../lib/storico.js";
import { makeKb, emptyKbFilters, hasKbFilter, kbCodeFrom, kbLabel, isKbId, kbStatusInfo } from "../lib/kb.js";
import { makeFaq, emptyFaqFilters, hasFaqFilter, faqLabel, isFaqId, faqStatusInfo } from "../lib/faq.js";
import { makeRowReader } from "../lib/rows.js";
import { emptyFilters, buildConditions, describeFilters, DOMAIN_CONDITION, OPEN_STATUS_IDS, isUnconstrained, hasNarrowingFilter, primaryTerm, wildcardText } from "../lib/filters.js";
import { statusInfo, mergePortalStatuses } from "../lib/statuses.js";
import { loadTicket } from "../lib/ticket.js";
import { saveTicket, getTicket, searchArchive, archivedMap, archiveInfo, kvGet, kvSet, onKvChange, reviveRow } from "../lib/store.js";
import { makeLookups } from "../lib/lookups.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "../lib/richtext.js";
import { ticketIdFrom, ticketIdVariants, ticketNumber, isLegacyTicketNumber, isTouchNativeId, ticketMergeKey, fmtRelative, fmtDate, fmtDateTime, tokens, queryTerms, pool, sleep, csvCell, debounce } from "../lib/util.js";

const inExtension = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
const DAY = 86400000;
const DEFAULT_SETTINGS = { pageSize: 50, portalLang: "auto", archiveOnRead: true, archiveCap: 300, arCentro: "", autoWildcard: true, theme: "dark" };

function portalLang(settings, touchLang) {
  const chosen = settings && settings.portalLang;
  if (chosen && chosen !== "auto") return chosen;
  return touchLang || "it";
}

const SORTS = {
  relevance: { label: "Attinenza", field: "date", fb: "c20" },
  date: { label: "Data di apertura / creazione", field: "date", fb: "c20" },
  lastChange: { label: "Ultimo aggiornamento", field: "lastChange", fb: "c26" },
  id: { label: "Numero / Codice", field: "id", fb: "c23" },
};

const KB_SORTS = {
  relevance: { label: "Attinenza" },
  date: { label: "Data creazione" },
  publishDate: { label: "Data pubblicazione" },
  id: { label: "Codice" },
};

const FAQ_SORTS = {
  relevance: { label: "Attinenza" },
  date: { label: "Data creazione" },
  publishDate: { label: "Data pubblicazione" },
  importance: { label: "Importanza" },
  id: { label: "Codice" },
};

// ---------------------------------------------------------------- registro (per la Diagnostica)
const LOG = [];
function log(msg) {
  const t = new Date().toLocaleTimeString("it-IT");
  LOG.push(`${t}  ${msg}`);
  if (LOG.length > 400) LOG.shift();
}

// ---------------------------------------------------------------- stato
const S = {
  source: "touch", // touch | ar | storico | kb | faq (barra sinistra)
  view: "results", // results | archive | favorites | recent (schede sottolineate)
  filters: emptyFilters(),
  activeEffectiveFilters: null,
  sort: { key: "relevance", dir: "DESC" },
  results: [],
  total: 0,
  page: 1,
  loading: false,
  pending: new Set(),
  error: null,
  notices: [],
  solo: false,
  touchTotal: 0,
  touchScan: null,
  arS: { filters: emptyArFilters(), results: [], loading: false, error: null, key: "", at: 0, notices: [] },
  storico: { filters: emptyStoricoFilters(), results: [], total: 0, loading: false, error: null, key: "" },
  kbS: { filters: emptyKbFilters(), results: [], total: 0, page: 1, browseAll: false, loading: false, error: null, key: "", at: 0, notices: [], sort: { key: "relevance", dir: "DESC" } },
  faqS: { filters: emptyFaqFilters(), results: [], total: 0, loadedOnce: false, loading: false, error: null, key: "", at: 0, notices: [], sort: { key: "relevance", dir: "DESC" } },
  stLookups: { groups: {}, operators: {}, clients: {} },
  archiveHits: [],
  archiveCount: 0,
  archived: new Map(),
  saved: [],
  captures: [],
  calib: { learned: {}, config: [], overrides: {}, containsText: null },
  caps: {},
  sampleTicket: null,
  favorites: [],
  recent: [],
  typesSeen: {},
  current: null,
  cursor: -1,
  connected: null,
  arConnected: null,
  job: null,
  updater: null,
  updateBarDismissed: false,
  settings: { ...DEFAULT_SETTINGS },
};
const ui = { openSections: {}, statusDetail: false, showInternal: true, newestFirst: false, readerSearch: "", showFilters: true, touchDateMode: "open" };
const listFilters = { touch: "", ar: "", storico: "", kb: "", faq: "" };

let transport, hda, ar, storico, kb, faq, lookups;
let rowReader = makeRowReader(null);
let searchAbort = null;
let kbAbort = null;
let faqAbort = null;
let openSeq = 0;

const ctx = {
  S,
  ui,
  get hda() { return hda; },
  get ar() { return ar; },
  get storico() { return storico; },
  get kb() { return kb; },
  get faq() { return faq; },
  get lookups() { return lookups; },
  log,
  LOG,
  setFilter,
  setFilters,
  resetFilters,
  applySaved,
  deleteSaved,
  openTicket,
  closeReader,
  openInTouch,
  openArHome,
  searchLegacyRefInTouch,
  isFavorite,
  toggleFavorite,
  saveUi,
  saveSettings,
  setTheme,
  toggleTheme,
  getUpdateStatus,
  checkUpdates,
  applyUpdate,
  saveUpdaterConfig,
  reloadExtension,
  reloadCalibration,
  refreshArchiveCount,
  storicoSetFilter,
  storicoReset,
  storicoLookup,
  arSetFilter,
  arReset,
  kbSetFilter,
  kbReset,
  faqSetFilter,
  faqReset,
  setAutoWildcard,
  openInNewPage,
  arCentre: () => (ar && ar.state.idCenSer) || S.caps.arCentro || "",
};

// ---------------------------------------------------------------- metadati delle 5 fonti

const SOURCES = {
  touch: { label: "HDA Touch", short: "T", ico: "ticket", subtitle: "Ticket di HDA TOUCH", title: "Ticket di HDA TOUCH" },
  ar: { label: "Vecchio Cruscotto", short: "VC", ico: "layers", subtitle: "Ricerca rapida Area Riservata", title: "Ticket del Vecchio Cruscotto (Area Riservata)" },
  storico: { label: "Ricerca avanzata", short: "RA", ico: "history", subtitle: "Area Riservata · archivio completo (anche pre-2024)", title: "Ricerca avanzata dell'Area Riservata (senza ricerca per parole)" },
  kb: { label: "Knowledge Base", short: "KB", ico: "book", subtitle: "Articoli Knowledge Base di HDA Touch", title: "Articoli Knowledge Base di HDA Touch" },
  faq: { label: "FAQ", short: "FQ", ico: "help", subtitle: "FAQ di HDA Touch (ricerca dedicata)", title: "FAQ di HDA Touch — ricerca dedicata su Domanda e Risposta" },
};

const isResultsView = () => S.view === "results";
const sourceOf = (r) => (r && (r.source === "ar" || r.source === "storico" || r.source === "kb" || r.source === "faq") ? r.source : "touch");
const touchRows = () => S.results.filter((r) => r.source !== "ar");
const arRows = () => S.arS.results;

const numberOf = (r) => {
  if (!r) return "";
  if (r.source === "kb" || isKbId(r.id)) return kbLabel(r);
  if (r.source === "faq" || isFaqId(r.id)) return faqLabel(r);
  return "#" + ticketNumber(r.id);
};

// ---------------------------------------------------------------- utilità

function slim(row) {
  if (!row) return null;
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "raw") continue;
    o[k] = v instanceof Date ? v.getTime() : v;
  }
  return o;
}

function rankQueryFor(source = S.source) {
  if (source === "faq") {
    const f = S.faqS.filters;
    return [f.query, f.question, f.answer].filter(Boolean).join(" ").trim();
  }
  const text = String(S.filters.text || "").trim();
  if (source === "kb") {
    return [kbCodeFrom(text) ? "" : text, S.kbS.filters.title || ""].join(" ").trim();
  }
  return [ticketIdFrom(text) ? "" : text, source === "touch" ? S.filters.subject || "" : ""].join(" ").trim();
}

const byRelevance = (source = S.source) => {
  const sortObj = source === "kb" ? S.kbS.sort : source === "faq" ? S.faqS.sort : S.sort;
  return sortObj.key === "relevance" && searchTerms(rankQueryFor(source)).length > 0;
};

const SNIPPETS = new WeakMap();
function snippetOf(row, source = sourceOf(row)) {
  if (!row) return "";
  const q = rankQueryFor(source);
  const hit = SNIPPETS.get(row);
  if (hit && hit.q === q) return hit.s;
  const p = row.fullAnswer || row.problem ? String(row.fullAnswer || row.problem) : "";
  let t = p ? (isProbablyHtml(unescapeIfEscapedHtml(p)) ? htmlToText(p) : cleanText(p)).replace(/\s+/g, " ").trim() : "";
  if (q) {
    if (row.fullText && !matchesAllTerms(t, q)) t = cleanText(String(row.fullText).replace(/  +/g, " — "));
    else if (row.solution && !matchesAllTerms(t, q)) {
      const sol = String(row.solution);
      t = [t, (isProbablyHtml(unescapeIfEscapedHtml(sol)) ? htmlToText(sol) : cleanText(sol)).replace(/\s+/g, " ").trim()].filter(Boolean).join(" — ");
    }
    t = bestSnippet(t, q, 260);
  } else t = t.slice(0, 260);
  SNIPPETS.set(row, { q, s: t });
  return t;
}

function sortSpec() {
  const s = SORTS[S.sort.key] || SORTS.date;
  return [{ property: rowReader.sortAlias(s.field) || s.fb, direction: S.sort.key === "relevance" ? "DESC" : S.sort.dir }];
}

const conditionsForId = (id) => [{ ...DOMAIN_CONDITION }, { property: "ID", value: id, op: "eq", id: "ID" }];

function openTouchHome() {
  if (inExtension && chrome.tabs) chrome.tabs.create({ url: PORTAL_BASE + "/" });
  else window.open(PORTAL_BASE + "/", "_blank");
}

function openArHome(url) {
  if (ar) ar.openHome(url);
}

function searchLegacyRefInTouch(num) {
  const clean = ticketNumber(num);
  if (!clean) return;
  leaveSolo();
  closeReader();
  S.source = "touch";
  S.view = "results";
  S.filters.text = "";
  S.filters.subject = clean;
  filtersChanged(true);
}

// ---------------------------------------------------------------- connessione

function setConn(state, text) {
  S.connected = state;
  const el = $("#conn");
  if (!el) return;
  el.classList.toggle("ok", state === true);
  el.classList.toggle("err", state === false);
  $(".conn-text", el).textContent = text || (state ? "HDA Touch connesso" : state === false ? "Touch disconnesso — apri" : "Verifica Touch…");
  el.title = state === false ? "Apri HDA TOUCH ed esegui l'accesso, poi torna qui" : "Stato della connessione a HDA TOUCH";
}

function setArConn(state, text) {
  S.arConnected = state;
  const el = $("#arConn");
  if (!el) return;
  el.classList.toggle("ok", state === true);
  el.classList.toggle("err", false);
  $(".conn-text", el).textContent = text || (state === true ? "Area Riservata attiva" : "Collega Area Riservata");
  el.title =
    state === true
      ? "Vecchio Cruscotto (Area Riservata Zucchetti) collegato"
      : "Clicca per aprire l'Area Riservata Zucchetti ed eseguire l'accesso (per Vecchio Cruscotto e Ricerca avanzata)";
}

async function checkArConnection() {
  if (!ar) return false;
  try {
    const st = await ar.checkStatus();
    setArConn(st.connected === true);
    if (st.connected) {
      log(`vecchio cruscotto collegato (${st.mode}${st.idCenSer ? ", centro " + st.idCenSer : ", centro non ancora noto"})`);
      ensureCentre().then((c) => (c ? warmNames() : log("centro servizi dell'Area Riservata non trovato: si può scrivere in Diagnostica → Impostazioni")));
    }
    return st.connected === true;
  } catch {
    setArConn(false);
    return false;
  }
}

let statusesLoaded = false;

async function checkConnection() {
  setConn(null);
  checkArConnection();
  try {
    const st = await hda.staticList("TicketStatuses");
    mergePortalStatuses(st);
    statusesLoaded = true;
    setConn(true, `HDA Touch${transport.mode === "proxy" ? " (scheda)" : ""}`);
    log(`connessione ok: utente ${hda.currentUserId || "?"}, ${st.length} stati`);
    if (hda.currentUserId && !S.caps.defaultGroupId) {
      hda.projection("User", [{ property: "ID", op: "eq", value: hda.currentUserId }], ["ID", "FullName", "DefaultUserGroupID"], 1)
        .then((rows) => {
          const u = rows && rows[0];
          if (u && (u.DefaultUserGroupID || u.FullName)) {
            if (u.DefaultUserGroupID) S.caps.defaultGroupId = u.DefaultUserGroupID;
            if (u.FullName) S.caps.userFullName = u.FullName;
            kvSet("caps", S.caps);
          }
        })
        .catch(() => {});
    }
    // Metadati statici leggeri di KB e FAQ in background (non rallentano l'avvio)
    Promise.all([kb.loadMeta(), faq.loadMeta()]).then(() => {
      if (S.source === "kb" || S.source === "faq") refreshSidebar();
    }).catch(() => {});
    return true;
  } catch (e) {
    log("connessione: " + e.message);
    setConn(false, e instanceof AuthError ? null : "Touch non raggiungibile");
    S.error = e;
    renderAll();
    return false;
  }
}

// ---------------------------------------------------------------- calibrazione (colonne e filtri di Touch)

async function reloadCalibration(force = false) {
  const cached = await kvGet("listCfg_v3", null);
  if (!force && cached && Date.now() - cached.at < DAY && cached.mapping && Object.keys(cached.mapping).length) {
    applyListConfig(cached);
  } else {
    try {
      const params = (await kvGet("touchIncidentsListParams", null)) || {};
      const cfg = await hda.listConfig("Incidents", params);
      if (Object.keys(cfg.mapping || {}).length) {
        const keep = { at: Date.now(), mapping: cfg.mapping, filters: cfg.filters, viewId: cfg.viewId || null };
        await kvSet("listCfg_v3", keep);
        applyListConfig(keep);
        log(`configurazione elenco: ${Object.keys(cfg.mapping).length} colonne, ${cfg.filters.length} filtri`);
      } else {
        log(`configurazione elenco senza mappa colonne (${cfg.size} caratteri): uso la mappa di riserva`);
      }
    } catch (e) {
      log("configurazione elenco: " + e.message + " (uso la mappa di riserva)");
    }
  }
  // Configurazione colonne KB e FAQ (con cache 24h)
  const kbFaqCfg = await kvGet("kbFaqCfg_v1", null);
  if (!force && kbFaqCfg && Date.now() - kbFaqCfg.at < DAY) {
    if (kbFaqCfg.kb) kb.setMapping(kbFaqCfg.kb);
    if (kbFaqCfg.faq) faq.setMapping(kbFaqCfg.faq);
  } else {
    Promise.all([kb.loadConfig(), faq.loadConfig()]).then(([kc, fc]) => {
      const save = {
        at: Date.now(),
        kb: kc && Object.keys(kc.mapping || {}).length ? kc.mapping : null,
        faq: fc && Object.keys(fc.mapping || {}).length ? fc.mapping : null,
      };
      if (save.kb || save.faq) kvSet("kbFaqCfg_v1", save);
    }).catch(() => {});
  }
  if (force || !statusesLoaded) {
    try {
      mergePortalStatuses(await hda.staticList("TicketStatuses"));
      statusesLoaded = true;
    } catch (e) {
      log("stati: " + e.message);
    }
  }
}

function applyListConfig(cfg) {
  rowReader = makeRowReader(cfg.mapping);
  S.calib.config = cfg.filters || [];
}

function checkReader(rawRows) {
  if (!rawRows.length) return;
  const ok = (r) => /^\d{5,}[A-Z]?$/.test(String(r.id || ""));
  if (ok(rowReader.read(rawRows[0]))) return;
  const fb = makeRowReader(null);
  if (ok(fb.read(rawRows[0]))) {
    log("la mappa colonne della configurazione non corrisponde ai dati: uso quella di riserva");
    rowReader = fb;
    return;
  }
  const k = Object.keys(rawRows[0]).find((c) => /^\d{6,}Z$/.test(String(rawRows[0][c])));
  if (k) {
    log(`colonna ID trovata in ${k}`);
    const base = fb;
    rowReader = { ...base, read: (raw) => ({ ...base.read(raw), id: raw[k] }) };
  }
}

// ---------------------------------------------------------------- filtri Touch

let pendingSidebar = false;
function refreshSidebar() {
  const a = document.activeElement;
  const sb = $("#sidebar");
  if (a && sb.contains(a) && a.tagName === "INPUT" && /^(text|search|date|number)$/.test(a.type)) {
    pendingSidebar = true;
    return;
  }
  pendingSidebar = false;
  const top = sb.scrollTop;
  renderSidebar(ctx);
  sb.scrollTop = top;
}

const searchSoon = debounce(() => search(), 350);

function filtersChanged(immediate) {
  refreshSidebar();
  syncSearchBoxes();
  if (immediate) search();
  else {
    S.loading = true;
    renderAll();
    searchSoon();
  }
}

function dropTicketNumberFor(keys) {
  const tid = ticketIdFrom(S.filters.text);
  if (!tid || !keys.some((k) => k !== "text" && !(S.filters[k] == null || S.filters[k] === "" || (Array.isArray(S.filters[k]) && !S.filters[k].length)))) return;
  S.filters.text = "";
  const q = $("#q");
  if (q) q.value = "";
  toast(`Tolto il numero ${ticketNumber(tid)} dalla barra di ricerca: ora vedi i ticket dei filtri scelti.`, "info", 4000);
}

function setFilter(key, val, immediate = false) {
  S.filters[key] = val;
  dropTicketNumberFor([key]);
  filtersChanged(immediate);
}

function setFilters(obj) {
  Object.assign(S.filters, obj);
  dropTicketNumberFor(Object.keys(obj));
  filtersChanged(true);
}

function resetFilters() {
  S.filters = emptyFilters();
  filtersChanged(true);
}

function syncSearchBoxes() {
  const q = $("#q");
  if (q && document.activeElement !== q) q.value = S.filters.text || "";
  const fq = $("#faqQ");
  if (fq && document.activeElement !== fq) fq.value = S.faqS.filters.query || "";
}

function applySaved(i) {
  const s = S.saved[i];
  if (!s) return;
  S.source = "touch";
  S.view = "results";
  S.filters = { ...emptyFilters(), ...s.filters };
  if (s.sort) S.sort = { ...s.sort };
  filtersChanged(true);
  toast(`Ricerca «${s.name}» applicata`, "ok", 1500);
}

function deleteSaved(i) {
  const s = S.saved[i];
  if (!s || !confirm(`Eliminare la ricerca salvata «${s.name}»?`)) return;
  S.saved.splice(i, 1);
  kvSet("saved", S.saved);
  refreshSidebar();
}

function saveSearchDialog() {
  const dlg = $("#saveDlg");
  clear(dlg);
  const name = h("input", { class: "input", type: "text", placeholder: "es. Aperti del mio gruppo", value: "" });
  const save = () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    const i = S.saved.findIndex((s) => s.name.toLowerCase() === n.toLowerCase());
    const rec = { name: n, filters: JSON.parse(JSON.stringify(S.filters)), sort: { ...S.sort } };
    if (i >= 0) S.saved[i] = rec;
    else S.saved.push(rec);
    kvSet("saved", S.saved);
    dlg.close();
    ui.openSections.saved = true;
    refreshSidebar();
    toast("Ricerca salvata", "ok", 1500);
  };
  name.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), save()));
  dlg.append(
    h("div", { class: "dlg-h" }, h("h2", null, "Salva la ricerca"), h("button", { class: "btn btn-icon", onclick: () => dlg.close() }, icon("close"))),
    h("div", { class: "dlg-b" },
      h("div", { class: "field" }, h("label", null, "Nome"), name),
      h("div", { class: "chips" }, describeFilters(S.filters).map((c) => h("span", { class: "chip" }, h("span", null, c.label)))),
      h("div", null, h("button", { class: "btn btn-primary", onclick: save }, "Salva"))),
  );
  dlg.showModal();
  name.focus();
}

// ---------------------------------------------------------------- ricerca HDA Touch (+ Vecchio Cruscotto + Storico + KB Touch)

function fallbackToSubject(f) {
  return { ...f, text: "", subject: [f.subject, String(f.text || "").replace(/\*/g, "")].filter(Boolean).join(" ").trim() };
}

function touchSentText(text) {
  const s = String(text || "").trim();
  if (!s || ticketIdFrom(s) || /"/.test(s)) return s;
  return S.settings.autoWildcard !== false ? wildcardText(s) : s;
}

async function setAutoWildcard(on) {
  if ((S.settings.autoWildcard !== false) === !!on) return;
  await saveSettings({ autoWildcard: !!on });
  refreshSidebar();
  if (String(S.filters.text || "").trim()) {
    search({ fresh: true });
  } else {
    renderAll();
  }
}

function isTimeoutError(e) {
  return /timeout|scaduto|tempo limite/i.test(String((e && e.message) || ""));
}

function twoYearsAgoDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function mergeRowLists(...lists) {
  const byKey = new Map();
  const out = [];
  const enrich = (touchRow, arRow) => ({
    ...touchRow,
    arRow: touchRow.arRow || arRow,
    arUrl: touchRow.arUrl || arRow.arUrl,
    fullText: touchRow.fullText || arRow.fullText,
    problem: touchRow.problem || arRow.problem,
    catalog: touchRow.catalog || arRow.catalog,
  });
  for (const list of lists) {
    for (const r of list || []) {
      if (!r || !r.id) continue;
      const key = ticketMergeKey(r);
      const idx = byKey.get(key);
      if (idx === undefined) {
        byKey.set(key, out.length);
        out.push({ ...r });
        continue;
      }
      const prev = out[idx];
      if (prev.source === "ar" && r.source !== "ar") out[idx] = enrich(r, prev);
      else if (prev.source !== "ar" && r.source === "ar") out[idx] = enrich(prev, r);
    }
  }
  return out;
}

function sortUnifiedRows(rows, exactNum = "", source = S.source) {
  if (!rows || rows.length <= 1) return rows || [];
  if (byRelevance(source) && !exactNum) return sortByRelevance(rows, rankQueryFor(source));
  const sortObj = source === "kb" ? S.kbS.sort : S.sort;
  const key = sortObj && sortObj.key && sortObj.key !== "relevance" ? sortObj.key : "date";
  const desc = !sortObj || sortObj.dir !== "ASC" || sortObj.key === "relevance";
  const dir = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (exactNum) {
      const aEx = ticketNumber(a.id) === exactNum ? 1 : 0;
      const bEx = ticketNumber(b.id) === exactNum ? 1 : 0;
      if (aEx !== bEx) return bEx - aEx;
    }
    if (key === "id") {
      if (source === "kb") return String(a.code || a.kbId || "").localeCompare(String(b.code || b.kbId || "")) * dir;
      const na = Number(String(ticketNumber(a.id)).replace(/\D/g, "")) || 0;
      const nb = Number(String(ticketNumber(b.id)).replace(/\D/g, "")) || 0;
      if (na !== nb) return (na - nb) * dir;
    } else {
      const da = a[key] instanceof Date ? a[key].getTime() : a.date instanceof Date ? a.date.getTime() : 0;
      const db = b[key] instanceof Date ? b[key].getTime() : b.date instanceof Date ? b.date.getTime() : 0;
      if (da !== db) return (da - db) * dir;
    }
    return 0;
  });
}

async function verifyTouchRowsAllWords(rows, f) {
  if (!rows || !rows.length) return [];
  const subjWords = queryTerms(f.subject || "");
  let candidates = rows;
  if (subjWords.length > 1) candidates = candidates.filter((r) => matchesAllTerms(r.subject || "", subjWords));
  const tid = ticketIdFrom(f.text);
  const textWords = tid ? [] : queryTerms(f.text || "");
  if (textWords.length <= 1) return candidates;

  const confirmedIds = new Set();
  const needConvCheck = [];
  for (const r of candidates) {
    const hay = `${r.subject || ""} ${r.problem || ""} ${r.solution || ""} ${r.catalog || ""} ${r.account || ""}`;
    if (matchesAllTerms(hay, textWords)) confirmedIds.add(r.id);
    else needConvCheck.push(r);
  }

  if (needConvCheck.length && hda) {
    const batches = [];
    for (let i = 0; i < needConvCheck.length; i += CONV_CHECK_BATCH) batches.push(needConvCheck.slice(i, i + CONV_CHECK_BATCH));
    await pool(batches, 2, async (batch) => {
      let convRows;
      try {
        convRows = await hda.projection("TicketConversationItem", [{ property: "TicketID", op: "in", value: batch.map((r) => r.id).join("|") }], ["TicketID", "Text"], CONV_CHECK_LIMIT);
      } catch (e) {
        log(`verifica parole conversazione: ${e.message}`);
        batch.forEach((r) => confirmedIds.add(r.id));
        return;
      }
      const truncated = (convRows || []).length >= CONV_CHECK_LIMIT;
      const byTicket = new Map();
      for (const c of convRows || []) {
        const k = c && c.TicketID;
        if (!k) continue;
        if (!byTicket.has(k)) byTicket.set(k, []);
        byTicket.get(k).push(String(c.Text || ""));
      }
      for (const r of batch) {
        const msgs = byTicket.get(r.id) || [];
        const fullHay = `${r.subject || ""} ${r.problem || ""} ${r.solution || ""} ${r.catalog || ""} ${r.account || ""} ${msgs.join(" ")}`;
        if (matchesAllTerms(fullHay, textWords)) {
          confirmedIds.add(r.id);
          if (!r.problem && msgs.length) {
            const hitMsg = msgs.find((m) => matchesAllTerms(m, textWords)) || msgs.find((m) => textWords.some((w) => matchesAllTerms(m, [w]))) || msgs[0];
            if (hitMsg) r.problem = hitMsg;
          }
        } else if (truncated) {
          confirmedIds.add(r.id);
        }
      }
    });
  }
  return candidates.filter((r) => confirmedIds.has(r.id));
}

const CONV_CHECK_BATCH = 40;
const CONV_CHECK_LIMIT = 1500;
const RESULT_CACHE = new Map();
const RESULT_CACHE_TTL = 2 * 60 * 1000;

function resultCacheKey(f, size) {
  return JSON.stringify([f, S.sort, size, S.arConnected === true, S.settings.autoWildcard !== false]);
}
function cacheGet(key) {
  const hit = RESULT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_CACHE_TTL) { RESULT_CACHE.delete(key); return null; }
  return hit;
}
function cachePut(key, entry) {
  RESULT_CACHE.delete(key);
  RESULT_CACHE.set(key, { ...entry, at: Date.now() });
  while (RESULT_CACHE.size > 25) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
}

function pickExactTicket(rows, typed, { allowSingle = true } = {}) {
  const tid = ticketIdFrom(typed);
  if (!tid) return null;
  const num = ticketNumber(tid);
  const typedZ = /z$/i.test(String(typed || "").trim());
  const usable = (rows || []).filter((r) => !(typedZ && r.source === "ar"));
  const exact = usable.filter((r) => ticketNumber(r.id) === num);
  if (!exact.length) return allowSingle && usable.length === 1 ? usable[0] : null;
  const same = (r) => String(r.id).toUpperCase() === tid.toUpperCase();
  return exact.find((r) => same(r) && r.source !== "ar") || exact.find(same) || exact.find((r) => r.source !== "ar") || exact[0];
}

function sameNumberNotice(rows, tid) {
  const num = ticketNumber(tid);
  const exact = (rows || []).filter((r) => ticketNumber(r.id) === num);
  if (exact.length < 2) return null;
  const labels = exact.map((r) => (r.source === "ar" ? `#${num} del Vecchio Cruscotto` : `${r.id} di HDA TOUCH`));
  return `Il numero ${num} corrisponde a ${exact.length} ticket diversi (${labels.join(", ")}): ognuno è nella scheda della sua fonte.`;
}

function textNarrowsNotice(f) {
  const what = describeFilters({ ...f, text: "" }).map((c) => c.label).join(", ");
  return {
    text: `Cerco «${f.text}» solo tra i ticket con ${what}. Per vedere tutti i ticket di questi filtri togli il testo dalla barra di ricerca.`,
    action: () => clearFilterKey("text"),
    actionLabel: "Togli il testo",
  };
}

async function search({ more = false, fresh = false } = {}) {
  if (!hda) return;
  if (searchAbort) searchAbort.abort();
  const ac = new AbortController();
  searchAbort = ac;

  const qEl = $("#q");
  if (qEl && !more && qEl.value.trim() !== S.filters.text) {
    S.filters.text = qEl.value.trim();
    refreshSidebar();
  }

  const f = S.filters;
  if (!more && f.text !== lastBoxText) {
    lastBoxText = f.text;
    pickPending = !!String(f.text || "").trim();
    listFilters.touch = listFilters.ar = listFilters.storico = listFilters.kb = "";
  }
  const size = Number(S.settings.pageSize) || 50;
  const tid = ticketIdFrom(f.text);
  const typedZ = !!tid && /z$/i.test(String(f.text || "").trim());
  const isLegacyNum = !!tid && isLegacyTicketNumber(f.text);
  const kbRef = kbCodeFrom(f.text);
  const textWords = tid || kbRef ? [] : queryTerms(f.text || "");
  const subjWords = queryTerms(f.subject || "");
  const multiWord = textWords.length > 1 || subjWords.length > 1;
  const wide = !more && (multiWord || (S.sort.key === "relevance" && textWords.length > 0));
  const fetchLimit = wide ? size * Math.ceil(150 / size) : size;

  const cacheKey = more ? null : resultCacheKey(f, size);
  if (cacheKey && !fresh) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      Object.assign(S, { page: 1, cursor: -1, error: null, loading: false, pending: new Set() });
      S.results = hit.results;
      S.total = hit.total;
      S.touchTotal = hit.touchTotal || 0;
      const stCached = runStorico();
      const arCached = runAr();
      runKb();
      stCached.then(() => { autoPickSource(); renderAll(); });
      S.notices = [...hit.notices];
      S.activeEffectiveFilters = hit.eff;
      runArchiveSearch(f.text);
      autoPickSource();
      renderAll();
      if (tid) {
        arCached.then((arFound) => {
          if (S.filters.text !== f.text || searchAbort !== ac) return;
          const exact = pickExactTicket(mergeRowLists(hit.results, arFound || []), f.text);
          if (exact) return openFound(exact);
          stCached.then((rows) => {
            const st = (rows || []).find((r) => r.id === ticketNumber(tid));
            if (st && S.filters.text === f.text && searchAbort === ac) openFound(st);
          });
        });
      }
      return;
    }
  }

  // Nota: la barra principale cerca in HDA Touch, Vecchio Cruscotto, Storico e Knowledge Base Touch.
  // NON cerca mai nelle FAQ (che hanno la propria ricerca dedicata nella scheda FAQ).
  const storicoPromise = more ? Promise.resolve(S.storico.results) : runStorico({ fresh });
  const arPromise = more ? Promise.resolve(S.arS.results) : runAr({ fresh });
  const kbPromise = more ? Promise.resolve(S.kbS.results) : runKb({ fresh });

  if (!more) {
    S.page = 1;
    S.results = [];
    S.total = 0;
    S.touchTotal = 0;
    S.touchScan = null;
    S.cursor = -1;
    S.notices = [];
    runArchiveSearch(f.text);
  } else {
    S.page += 1;
  }
  const pend = new Set();
  S.pending = pend;
  S.loading = true;
  S.error = null;
  renderAll();
  const t0 = Date.now();

  const track = (label, p) => {
    pend.add(label);
    const done = () => {
      pend.delete(label);
      if (!ac.signal.aborted && S.loading) renderAll();
    };
    return p.then((v) => (done(), v), (e) => { done(); throw e; });
  };

  const parts = new Map();
  const exactNum = tid ? ticketNumber(tid) : "";
  const show = (name, rows) => {
    parts.set(name, rows || []);
    if (ac.signal.aborted || more) return;
    S.results = sortUnifiedRows(mergeRowLists(...parts.values()), exactNum, "touch");
    S.total = S.results.length;
    renderAll();
  };

  const calibForSearch = { ...S.calib, primaryTermOnly: true };
  const sentText = touchSentText(f.text);
  const wildSent = /\*/.test(sentText);
  const nativeText = !tid && !kbRef && textWords.length > 0 && !/"/.test(f.text) && (textWords.length > 1 || wildSent);
  const calibNative = { ...S.calib, singleFullText: true, autoWildcard: S.settings.autoWildcard !== false };
  const textCalib = nativeText ? calibNative : calibForSearch;
  const checkF = (x) => (nativeText ? { ...x, text: "" } : x);

  const run = (filters, customLimit = fetchLimit, signal = ac.signal, calib = calibForSearch) =>
    hda.listData("Incidents", {
      conditions: buildConditions(filters, calib),
      page: S.page,
      start: (S.page - 1) * size,
      limit: customLimit,
      sort: sortSpec(),
      signal,
    });

  const readRawRows = (rawRows) => {
    checkReader(rawRows);
    return rawRows.map((r) => rowReader.read(r));
  };

  let touchIdle = false;
  try {
    let rows = [];
    let total = 0;
    let touchTotal = 0;

    if (more && S.activeEffectiveFilters) {
      const res = await run(S.activeEffectiveFilters, size, ac.signal, textCalib);
      if (ac.signal.aborted) return;
      rows = await verifyTouchRowsAllWords(readRawRows(res.rows), checkF(f));
      total = res.total;
      touchTotal = res.total || 0;
    } else if (isUnconstrained(f) || (kbRef && !hasNarrowingFilter(f))) {
      touchIdle = true;
      S.activeEffectiveFilters = null;
      if (kbRef) {
        const kbRows = await kbPromise.catch(() => []);
        if (!ac.signal.aborted && kbRows && kbRows.length === 1) openFound(kbRows[0]);
      }
    } else if (f.text && !tid) {
      parts.set("ft", []);
      parts.set("sub", []);
      const subF = fallbackToSubject(f);
      const subAc = new AbortController();
      ac.signal.addEventListener("abort", () => subAc.abort(), { once: true });
      const subPromise = track(
        "oggetti di Touch",
        run(subF, fetchLimit, subAc.signal)
          .then((r) => verifyTouchRowsAllWords(readRawRows(r.rows), subF))
          .catch((e) => {
            if (e.name !== "AbortError") log(`ricerca sull'oggetto: ${e.message}`);
            return [];
          }),
      );
      subPromise.then((r) => show("sub", r));

      const ftPromise = track(
        "messaggi di Touch",
        (async () => {
          try {
            const r = await run(f, fetchLimit, ac.signal, textCalib);
            S.activeEffectiveFilters = f;
            return { rows: await verifyTouchRowsAllWords(readRawRows(r.rows), checkF(f)), total: r.total, read: r.rows.length, complete: true };
          } catch (e) {
            if (e instanceof AuthError || e.name === "AbortError") throw e;
            log(`FullText su tutto lo storico (${e.message}): riprovo sugli ultimi 24 mesi / aperti`);
            const recentF = !f.dateFrom ? { ...f, dateFrom: twoYearsAgoDate() } : { ...f, statuses: OPEN_STATUS_IDS };
            try {
              const r2 = await run(recentF, fetchLimit, ac.signal, textCalib);
              S.activeEffectiveFilters = recentF;
              S.notices.push(
                !f.dateFrom
                  ? "La ricerca nei messaggi su tutto lo storico ha superato i 25 secondi: i messaggi sono cercati negli ultimi 24 mesi."
                  : "La ricerca nei messaggi ha superato i 25 secondi: i messaggi sono cercati nei ticket aperti.",
              );
              return { rows: await verifyTouchRowsAllWords(readRawRows(r2.rows), checkF(f)), total: r2.total, read: r2.rows.length };
            } catch (e2) {
              if (e2 instanceof AuthError || e2.name === "AbortError") throw e2;
              S.activeEffectiveFilters = subF;
              return { rows: [], total: 0 };
            }
          }
        })(),
      );
      ftPromise.then((r) => show("ft", r.rows), () => {});

      const ftRes = await ftPromise;
      if (ftRes.complete) subAc.abort();
      const subRows = await subPromise;
      if (ac.signal.aborted) return;
      rows = sortUnifiedRows(mergeRowLists(ftRes.rows, subRows), "", "touch");
      const portalTotal = nativeText && subjWords.length <= 1;
      total = multiWord && !portalTotal ? rows.length : Math.max(ftRes.total || 0, rows.length);
      touchTotal = multiWord && !portalTotal ? 0 : ftRes.total || 0;
      if (nativeText && !more) {
        S.touchScan = !wildSent && (ftRes.complete || ftRes.total)
          ? { native: true, filters: JSON.parse(JSON.stringify(S.activeEffectiveFilters || f)), word: primaryTerm(textWords), step: fetchLimit, examined: 0, total: null, running: false, stopped: false, error: "" }
          : null;
      } else if (multiWord && !more) noteTouchScan(ftRes.read || 0, ftRes.total || 0, fetchLimit, primaryTerm(textWords), ftRes.rows.length);
      if (hasNarrowingFilter(f) && rows.length < size) S.notices.push(textNarrowsNotice(f));
    } else if (tid) {
      parts.set("id", []);
      parts.set("ref", []);
      const variants = ticketIdVariants(f.text);
      const idPromise = track(
        "HDA TOUCH",
        Promise.all(
          variants.map((v) =>
            hda
              .listData("Incidents", { conditions: conditionsForId(v), page: 1, start: 0, limit: 5, sort: sortSpec(), signal: ac.signal })
              .then((r) => readRawRows(r.rows))
              .catch((e) => {
                if (e instanceof AuthError || e.name === "AbortError") throw e;
                log(`ticket ${v} su Touch: ${e.message}`);
                return [];
              }),
          ),
        ).then((lists) => lists.flat()),
      );
      idPromise.then((r) => show("id", r), () => {});
      const refPromise = isLegacyNum
        ? track("riferimenti in Touch", run({ ...f, text: "", subject: ticketNumber(tid) }, 20).then((r) => readRawRows(r.rows)).catch(() => []))
        : Promise.resolve([]);
      refPromise.then((r) => show("ref", r));

      const idRows = await idPromise;
      const arEarly = await Promise.race([arPromise, sleep(3000).then(() => null)]);
      if (ac.signal.aborted) return;
      const early = pickExactTicket(mergeRowLists(idRows, arEarly || []), f.text);
      let openedId = null;
      if (early && ticketNumber(early.id) === exactNum) {
        openedId = early.id;
        openFound(early);
      }

      const [arFound, refRows] = await Promise.all([arPromise, refPromise]);
      if (ac.signal.aborted) return;
      S.activeEffectiveFilters = f;
      const exactAr = arFound.filter((r) => ticketNumber(r.id) === exactNum);
      const otherAr = arFound.filter((r) => ticketNumber(r.id) !== exactNum);
      rows = sortUnifiedRows(mergeRowLists(idRows, refRows), exactNum, "touch");
      total = rows.length;
      const all = sortUnifiedRows(mergeRowLists(idRows, exactAr, refRows, otherAr), exactNum, "touch");
      const note = sameNumberNotice(all, tid);
      if (note) S.notices.push(note);
      if (hasNarrowingFilter(f)) {
        S.notices.push({
          text: `Con un numero ticket nella barra di ricerca i filtri non contano: cerco solo il ticket ${exactNum}.`,
          action: () => clearFilterKey("text"),
          actionLabel: "Togli il numero",
        });
      }
      let opened = !!openedId;
      if (!opened) {
        const exact = pickExactTicket(all, f.text);
        if (exact) { opened = true; openFound(exact); }
      }
      const stRows = isLegacyNum ? await Promise.race([storicoPromise, sleep(8000).then(() => [])]) : [];
      if (ac.signal.aborted) return;
      const stExact = (stRows || []).find((r) => r.id === exactNum);
      if (stExact && !opened) openFound(stExact);
      if (!all.length && stExact) {
        S.notices.push(`Il ticket ${exactNum} è stato trovato in Ricerca avanzata.`);
      } else if (!all.length) {
        S.notices.push(
          isLegacyNum && S.arConnected !== true
            ? `Il ticket ${exactNum} non è su HDA TOUCH. Clicca «Collega Area Riservata» nella barra sinistra per cercarlo nel Vecchio Cruscotto e in Ricerca avanzata.`
            : typedZ
              ? `Il ticket ${tid} non risulta su HDA TOUCH.`
              : `Il ticket ${exactNum} non risulta né in HDA TOUCH né nel Vecchio Cruscotto${isLegacyNum && !S.storico.error ? " né in Ricerca avanzata" : ""}.`,
        );
      }
    } else {
      parts.set("touch", []);
      let res;
      try {
        res = await track("HDA TOUCH", run(f, fetchLimit));
        S.activeEffectiveFilters = f;
      } catch (e) {
        if (!isTimeoutError(e) || f.statuses.length) throw e;
        const openF = { ...f, statuses: OPEN_STATUS_IDS };
        res = await track("HDA TOUCH (aperti)", run(openF, fetchLimit));
        S.activeEffectiveFilters = openF;
        S.notices.push("La ricerca su tutto lo storico ha superato i 25 secondi: mostro i ticket aperti. Aggiungi un filtro più specifico per includere i chiusi.");
      }
      if (ac.signal.aborted) return;
      const found = await verifyTouchRowsAllWords(readRawRows(res.rows), f);
      show("touch", found);
      if (ac.signal.aborted) return;
      rows = sortUnifiedRows(found, "", "touch");
      total = multiWord ? rows.length : Math.max(res.total || 0, rows.length);
      touchTotal = multiWord ? 0 : res.total || 0;
      if (multiWord && !more) noteTouchScan(res.rows.length, res.total || 0, fetchLimit, primaryTerm(subjWords.length > 1 ? subjWords : textWords), found.length);
    }

    if (ac.signal.aborted) return;
    if (!more && fetchLimit > size) S.page = fetchLimit / size;
    S.results = more ? sortUnifiedRows(mergeRowLists(S.results, rows), exactNum, "touch") : rows;
    S.total = Math.max(total, S.results.length);
    S.touchTotal = Math.max(touchTotal, touchRows().length);
    log(touchIdle ? "HDA Touch: nessuna parola e nessun filtro" : `ricerca Touch completata: ${S.results.length} ticket in ${Date.now() - t0} ms`);
    const firstTouch = rows.find((r) => r.source !== "ar" && r.id && r.subject);
    if (!S.sampleTicket && firstTouch) S.sampleTicket = { id: firstTouch.id, subject: firstTouch.subject };
    lookups.harvest(rows.filter((r) => r.source !== "ar"));
    harvestTypes(rows.filter((r) => r.source !== "ar"));
    if (S.connected !== true && !touchIdle) setConn(true);
    if (cacheKey && !S.touchScan) cachePut(cacheKey, { results: S.results, total: S.total, touchTotal: S.touchTotal, notices: S.notices, eff: S.activeEffectiveFilters && JSON.parse(JSON.stringify(S.activeEffectiveFilters)) });
    archivedMap(rows.map((r) => r.id))
      .then((m) => { for (const [k, v] of m) S.archived.set(k, v); renderAll(); })
      .catch(() => {});
  } catch (e) {
    if (e.name === "AbortError" || ac.signal.aborted) return;
    log("ricerca: " + e.message);
    if (more) S.page -= 1;
    S.error = e;
    if (e instanceof AuthError) setConn(false);
    const arFallback = await arPromise.catch(() => []);
    if (ac.signal.aborted) return;
    if (tid && arFallback && arFallback.length) {
      const exact = pickExactTicket(arFallback, f.text);
      if (exact) openFound(exact);
    }
  } finally {
    if (searchAbort === ac) {
      S.loading = false;
      autoPickSource();
      renderAll();
    }
  }
}

function noteTouchScan(read, total, step, word, ok) {
  S.touchScan = total > read && read > 0
    ? { filters: JSON.parse(JSON.stringify(S.activeEffectiveFilters || S.filters)), word, step, examined: read, total, running: false, stopped: false, error: "" }
    : null;
}

const TOUCH_SCAN_MAX = 1500;
async function scanTouchRest() {
  const scan = S.touchScan;
  const ac = searchAbort;
  if (!scan || scan.running || !hda || !ac) return;
  Object.assign(scan, { running: true, stopped: false, error: "" });
  renderAll();
  const startAt = scan.examined;
  const live = () => S.touchScan === scan && searchAbort === ac && !ac.signal.aborted;
  try {
    while (scan.total == null || scan.examined < scan.total) {
      if (scan.examined - startAt >= TOUCH_SCAN_MAX) { scan.stopped = true; break; }
      const res = await hda.listData("Incidents", {
        conditions: buildConditions(scan.filters, { ...S.calib, primaryTermOnly: true }),
        page: Math.floor(scan.examined / scan.step) + 1,
        start: scan.examined,
        limit: scan.step,
        sort: sortSpec(),
        signal: ac.signal,
      });
      if (!live()) return;
      if (!res.rows.length) { scan.total = scan.examined; break; }
      checkReader(res.rows);
      const ok = await verifyTouchRowsAllWords(res.rows.map((r) => rowReader.read(r)), scan.filters);
      if (!live()) return;
      scan.examined += res.rows.length;
      scan.total = Math.max(res.total || 0, scan.examined);
      S.results = sortUnifiedRows(mergeRowLists(S.results, ok), "", "touch");
      S.total = S.results.length;
      lookups.harvest(ok);
      renderAll();
    }
  } catch (e) {
    if (e.name === "AbortError" || !live()) return;
    scan.error = e.message;
  } finally {
    scan.running = false;
    if (live()) renderAll();
  }
}

function touchScanNotice(fmtN) {
  const scan = S.touchScan;
  if (!scan) return null;
  const inList = fmtN(S.results.filter((r) => r.source !== "ar").length);
  if (scan.native) {
    if (scan.running) return { text: `Ricerca estesa… controllati ${fmtN(scan.examined)}${scan.total != null ? " di " + fmtN(scan.total) : ""} ticket con «${scan.word}» (${inList} in elenco).` };
    if (!scan.examined && !scan.error) {
      return { text: `Ricerca esatta del portale. Con la ricerca estesa includo anche singolare/plurale controllando i ticket con «${scan.word}».`, action: scanTouchRest, actionLabel: "Ricerca estesa" };
    }
    const leftN = scan.total != null ? scan.total - scan.examined : 1;
    if (leftN <= 0) return { text: `Ricerca estesa completata: controllati tutti i ${fmtN(scan.total)} ticket (${inList} in elenco).` };
    return { text: `Ricerca estesa: controllati ${fmtN(scan.examined)} di ${fmtN(scan.total)} (${inList} in elenco).`, action: scanTouchRest, actionLabel: "Continua" };
  }
  const left = scan.total - scan.examined;
  if (scan.running) return { text: `Controllo gli altri ticket… ${fmtN(scan.examined)} di ${fmtN(scan.total)} (${inList} validi finora).` };
  if (left <= 0) return { text: `Controllati tutti i ${fmtN(scan.total)} ticket con «${scan.word}»: ${inList} hanno tutte le parole.` };
  return { text: `Il portale trova ${fmtN(scan.total)} ticket con «${scan.word}». Controllati ${fmtN(scan.examined)}: ${inList} validi.`, action: scanTouchRest, actionLabel: `Controlla gli altri ${fmtN(left)}` };
}

function harvestTypes(rows) {
  let changed = false;
  for (const r of rows) {
    if (r.typeId && r.typeText && S.typesSeen[r.typeId] !== r.typeText) {
      S.typesSeen[r.typeId] = r.typeText;
      changed = true;
    }
  }
  if (changed) kvSet("typesSeen", S.typesSeen);
}

let archiveSeq = 0;
async function runArchiveSearch(text) {
  const my = ++archiveSeq;
  const q = String(text || "").trim();
  if (!q || ticketIdFrom(q)) { S.archiveHits = []; return; }
  try {
    const hits = await searchArchive(q);
    if (my !== archiveSeq) return;
    S.archiveHits = hits;
    renderAll();
  } catch (e) {
    log("archivio: " + e.message);
  }
}

async function refreshArchiveCount() {
  try { S.archiveCount = await archiveInfo(); }
  catch { S.archiveCount = 0; }
}

// ---------------------------------------------------------------- conteggi e auto-switch fonti

function sourceCounts() {
  const nTouch = touchRows().length;
  return {
    touch: S.loading ? nTouch : Math.max(nTouch, S.touchTotal || 0),
    ar: arRows().length,
    storico: Math.max(S.storico.total || 0, S.storico.results.length),
    kb: Math.max(S.kbS.total || 0, S.kbS.results.length),
    faq: Math.max(S.faqS.total || 0, S.faqS.results.length),
  };
}

let pickPending = false;
let lastBoxText = null;
function autoPickSource() {
  if (!pickPending || !isResultsView() || S.source === "faq" || S.loading || S.storico.loading || S.arS.loading || S.kbS.loading) return;
  pickPending = false;
  const c = sourceCounts();
  if (c[S.source]) return;
  // Auto-switch solo tra le fonti interrogate dalla barra principale (MAI FAQ!)
  const next = ["touch", "kb", "ar", "storico"].find((k) => c[k]);
  if (next && next !== S.source) {
    S.source = next;
    S.cursor = -1;
    refreshSidebar();
  }
}

// ---------------------------------------------------------------- centro servizi Area Riservata

let centrePromise = null;
function ensureCentre() {
  if (!ar) return Promise.resolve("");
  if (S.settings.arCentro) ar.setCentre(S.settings.arCentro);
  if (ar.state.idCenSer) return Promise.resolve(ar.state.idCenSer);
  if (S.caps.arCentro) { ar.setCentre(S.caps.arCentro); return Promise.resolve(ar.state.idCenSer); }
  if (!centrePromise) {
    const g = /^G(\d+)/i.exec(String(S.caps.defaultGroupId || ""));
    centrePromise = (g ? ar.findCentre([g[1]]) : Promise.resolve(""))
      .catch((e) => (log(`centro servizi: ${e.message}`), ""))
      .then((c) => {
        centrePromise = null;
        if (c) { S.caps.arCentro = c; kvSet("caps", S.caps); warmNames(); }
        return c;
      });
  }
  return centrePromise;
}

let namesWarmed = false;
async function warmNames() {
  if (namesWarmed || !storico || Object.keys(S.stLookups.operators).length >= 15) return;
  namesWarmed = true;
  try {
    const d = new Date(Date.now() - 45 * DAY);
    const p2 = (n) => String(n).padStart(2, "0");
    const res = await storico.search({ ...emptyStoricoFilters(), dateFrom: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, dateTo: "" }, { rows: 100 });
    harvestStorico(res.rows);
    renderAll();
  } catch (e) {
    log(`nomi dallo Storico: ${e.message}`);
  }
}

function withArNames(r) {
  if (!r || r.source !== "ar") return r;
  const L = S.stLookups;
  const group = r.ownerGroupId && L.groups[r.ownerGroupId];
  const oper = r.assignedId && L.operators[r.assignedId];
  const client = r.customerCode && L.clients[r.customerCode];
  if (!group && !oper && !client) return r;
  return { ...r, ownerGroup: group || r.ownerGroup, assigned: oper || r.assigned, account: client || r.account };
}

// ---------------------------------------------------------------- Vecchio Cruscotto

function arQuery() {
  const text = String(S.filters.text || "").trim();
  if (kbCodeFrom(text)) return null;
  const tid = ticketIdFrom(text);
  if (tid) return /z$/i.test(text) ? null : { ticketId: ticketNumber(tid) };
  const filters = S.arS.filters;
  if (!text && !hasArFilter(filters)) return null;
  return { text, filters: { ...filters } };
}

const AR_RESULT_TTL = 2 * 60 * 1000;
let arSeq = 0;
let arInflight = null;
function runAr({ fresh = false } = {}) {
  const st = S.arS;
  const q = ar ? arQuery() : null;
  const key = q ? JSON.stringify(q) : "";
  const exactNum = (q && q.ticketId) || "";
  if (!q) {
    arSeq++; arInflight = null; names.queue.length = 0;
    Object.assign(st, { results: [], loading: false, error: null, key: "", notices: [] });
    return Promise.resolve([]);
  }
  if (!fresh && arInflight && arInflight.key === key) return arInflight.promise;
  if (!fresh && key === st.key && !st.error && Date.now() - st.at < (st.full ? 5 : 1) * AR_RESULT_TTL) {
    st.results = sortUnifiedRows(st.results, exactNum, "ar");
    return Promise.resolve(st.results);
  }
  const my = ++arSeq;
  names.queue.length = 0;
  Object.assign(st, { results: [], loading: true, error: null, key: "", notices: [], full: false, progress: "" });
  renderAll();
  const info = {};
  const promise = ensureCentre()
    .then(() => ar.search(q, info))
    .then((rows) => {
      if (ar.state.connected) setArConn(true);
      if (my !== arSeq) return rows || [];
      st.results = sortUnifiedRows(rows || [], exactNum, "ar");
      st.key = key;
      st.at = Date.now();
      if (!exactNum && info.max && info.raw >= info.max) {
        st.notices.push({
          text: `Il Vecchio Cruscotto restituisce al massimo ${info.max} ticket per ricerca: alcuni possono mancare.`,
          action: () => runArAll(),
          actionLabel: "Cerca tutti",
        });
      }
      if (!exactNum && ar.state.connected && !ar.state.idCenSer && st.results.length) {
        st.notices.push("Vecchio Cruscotto: centro servizi non rilevato (i risultati possono includere altri centri). Impostalo in Diagnostica → Impostazioni.");
      }
      return st.results;
    })
    .catch((e) => {
      log(`vecchio cruscotto: ${e.message}`);
      if (my === arSeq) st.error = e;
      return [];
    })
    .finally(() => {
      if (arInflight && arInflight.promise === promise) arInflight = null;
      if (my !== arSeq) return;
      st.loading = false;
      autoPickSource();
      renderAll();
    });
  arInflight = { key, promise };
  return promise;
}

async function runArAll() {
  const st = S.arS;
  const q = ar ? arQuery() : null;
  if (!q || q.ticketId) return;
  const key = JSON.stringify(q);
  const my = ++arSeq;
  arInflight = null;
  names.queue.length = 0;
  Object.assign(st, { loading: true, error: null, notices: [], progress: "" });
  renderAll();
  try {
    await ensureCentre();
    const res = await ar.searchAll(q, {
      isCancelled: () => my !== arSeq,
      onProgress: (p) => {
        if (my !== arSeq) return;
        st.progress = `${p.rows.toLocaleString("it-IT")} ticket finora · ${p.queries} richieste`;
        const n = document.querySelector("#results .loading .ar-progress");
        if (n) n.textContent = st.progress;
      },
    });
    if (my !== arSeq || res.cancelled) return;
    st.results = sortUnifiedRows(res.rows, "", "ar");
    Object.assign(st, { key, at: Date.now(), full: true });
    st.notices.push(`Ricerca completa: ${res.rows.length.toLocaleString("it-IT")} ticket in ${res.queries} periodi.`);
  } catch (e) {
    if (my === arSeq) st.error = e;
  } finally {
    if (my === arSeq) { Object.assign(st, { loading: false, progress: "" }); renderAll(); }
  }
}

function arChanged() { refreshSidebar(); runAr(); renderAll(); }
function arSetFilter(key, val) {
  if (key && typeof key === "object") Object.assign(S.arS.filters, key);
  else S.arS.filters[key] = val;
  arChanged();
}
function arReset() { S.arS.filters = emptyArFilters(); arChanged(); }

function describeAr() {
  const f = S.arS.filters;
  const text = String(S.filters.text || "").trim();
  const day = (d) => d.split("-").reverse().join("/");
  const chips = [];
  if (text && !kbCodeFrom(text)) chips.push({ key: "text", label: ticketIdFrom(text) ? `Numero ${ticketNumber(ticketIdFrom(text))}` : `Testo: “${text}”` });
  if (ticketIdFrom(text)) return chips;
  if (text && f.searchIn !== "2") chips.push({ key: "searchIn", label: f.searchIn === "1" ? "Solo oggetto" : "Solo messaggi" });
  if (f.dateFrom || f.dateTo) chips.push({ key: "period", label: `${f.dateRef === "2" ? "Apertura" : "Aggiornamento"}${f.dateFrom ? " dal " + day(f.dateFrom) : ""}${f.dateTo ? " al " + day(f.dateTo) : ""}` });
  if (f.statoBase) chips.push({ key: "statoBase", label: f.statoBase === "A" ? "Stato: aperti" : "Stato: chiusi" });
  if (f.group) chips.push({ key: "group", label: `Gruppo: ${f.groupLabel || S.stLookups.groups[f.group] || f.group}` });
  if (f.operator) chips.push({ key: "operator", label: `Operatore: ${f.operator.label || f.operator.id}` });
  if (String(f.clientCode || "").trim()) chips.push({ key: "clientCode", label: `Cliente cod. ${f.clientCode}` });
  if (f.groupIn) chips.push({ key: "groupIn", label: `Partecipante: ${f.groupInLabel || S.stLookups.groups[f.groupIn] || f.groupIn}` });
  if (f.operatorIn) chips.push({ key: "operatorIn", label: `Ha partecipato: ${f.operatorIn.label || f.operatorIn.id}` });
  return chips;
}

function clearArKey(key) {
  if (key === "text") return clearFilterKey("text");
  const e = emptyArFilters();
  if (key === "period") return arSetFilter({ dateFrom: "", dateTo: "" });
  if (key === "group") return arSetFilter({ group: "", groupLabel: "" });
  if (key === "groupIn") return arSetFilter({ groupIn: "", groupInLabel: "" });
  arSetFilter(key, e[key]);
}

// ---------------------------------------------------------------- Knowledge Base (HD Touch — KBArticles)

function kbQuery() {
  const text = String(S.filters.text || "").trim();
  const ref = kbCodeFrom(text);
  if (ref) return { text, filters: null, browseAll: false };
  // Un numero ticket puro (es. 11943797 o 9876543Z) non è una ricerca KB
  const tid = ticketIdFrom(text);
  if (tid) return hasKbFilter(S.kbS.filters) || S.kbS.browseAll ? { text: "", filters: { ...S.kbS.filters }, browseAll: S.kbS.browseAll } : null;
  const filters = S.kbS.filters;
  if (!text && !hasKbFilter(filters) && !S.kbS.browseAll) return null;
  return { text, filters: { ...filters }, browseAll: S.kbS.browseAll };
}

const KB_RESULT_TTL = 2 * 60 * 1000;
let kbSeq = 0;

async function runKb({ more = false, fresh = false } = {}) {
  const st = S.kbS;
  if (!kb) return [];
  const q = kbQuery();
  if (!q) {
    kbSeq++;
    if (kbAbort) kbAbort.abort();
    Object.assign(st, { results: [], total: 0, page: 1, loading: false, error: null, key: "", notices: [] });
    return [];
  }
  const wild = S.settings.autoWildcard !== false;
  const key = JSON.stringify([q, st.sort, wild]);
  if (!more && !fresh && key === st.key && !st.error && Date.now() - st.at < KB_RESULT_TTL) {
    st.results = sortUnifiedRows(st.results, "", "kb");
    return st.results;
  }
  if (kbAbort) kbAbort.abort();
  const ac = new AbortController();
  kbAbort = ac;
  const my = ++kbSeq;
  const nextPage = more ? st.page + 1 : 1;
  if (!more) Object.assign(st, { results: [], total: 0, page: 1, notices: [] });
  Object.assign(st, { loading: true, error: null });
  renderAll();
  try {
    const res = await kb.search({
      text: q.text,
      filters: q.filters,
      autoWildcard: wild,
      browseAll: q.browseAll,
      page: nextPage,
      limit: 100,
      sort: st.sort,
      signal: ac.signal,
    });
    if (my !== kbSeq || ac.signal.aborted) return [];
    st.page = nextPage;
    const byId = new Map((more ? st.results : []).map((r) => [r.id, r]));
    for (const r of res.rows || []) if (!byId.has(r.id)) byId.set(r.id, r);
    st.results = sortUnifiedRows([...byId.values()], "", "kb");
    st.total = Math.max(res.total || 0, st.results.length);
    st.key = key;
    st.at = Date.now();
    archivedMap(st.results.map((r) => r.id))
      .then((m) => { for (const [k, v] of m) S.archived.set(k, v); renderAll(); })
      .catch(() => {});
    return st.results;
  } catch (e) {
    if (e.name === "AbortError" || my !== kbSeq) return [];
    log(`KB Touch: ${e.message}`);
    st.error = e;
    if (e instanceof AuthError) setConn(false);
    return [];
  } finally {
    if (my === kbSeq) {
      st.loading = false;
      autoPickSource();
      renderAll();
    }
  }
}

function kbChanged() {
  S.kbS.browseAll = false;
  refreshSidebar();
  runKb();
  renderAll();
}

function kbSetFilter(key, val) {
  if (key && typeof key === "object") Object.assign(S.kbS.filters, key);
  else S.kbS.filters[key] = val;
  kbChanged();
}

function kbReset() {
  S.kbS.filters = emptyKbFilters();
  S.kbS.browseAll = false;
  kbChanged();
}

function kbBrowseAll() {
  S.kbS.browseAll = true;
  runKb({ fresh: true });
}

function describeKb() {
  const f = S.kbS.filters;
  const text = String(S.filters.text || "").trim();
  const day = (d) => d.split("-").reverse().join("/");
  const chips = [];
  const ref = kbCodeFrom(text);
  if (text && !ticketIdFrom(text)) {
    const sent = ref ? null : touchSentText(text);
    chips.push({ key: "text", label: ref ? `Articolo ${ref.code || "KB#" + ref.kbId}` : sent && sent !== text ? `Cercato come: ${sent}` : `Testo: “${text}”` });
  }
  if (ref) return chips;
  if (f.statuses.length) {
    const map = Object.fromEntries((kb ? kb.statuses : []).map((s) => [s.id, s.label]));
    chips.push({ key: "statuses", label: `Stato: ${f.statuses.map((id) => map[id] || id).join(", ")}` });
  }
  if (f.types.length) {
    const map = Object.fromEntries((kb ? kb.types : []).map((t) => [t.id, t.label]));
    chips.push({ key: "types", label: `Tipo: ${f.types.map((id) => map[id] || id).join(", ")}` });
  }
  if (f.hasAttachments) chips.push({ key: "hasAttachments", label: f.hasAttachments === "true" ? "Con allegati" : "Senza allegati" });
  if (f.products.length) chips.push({ key: "products", label: `Prodotto: ${f.products.map((x) => x.label || x.id).join(", ")}` });
  if (f.version.trim()) chips.push({ key: "version", label: `Versione: “${f.version.trim()}”` });
  if (f.topics.length) chips.push({ key: "topics", label: `Argomento: ${f.topics.map((x) => x.label || x.id).join(", ")}` });
  if (f.folders.length) chips.push({ key: "folders", label: `Cartella: ${f.folders.map((x) => x.label || x.id).join(", ")}` });
  if (f.title.trim()) chips.push({ key: "title", label: `Titolo: “${f.title.trim()}”` });
  if (f.code.trim()) chips.push({ key: "code", label: `Codice: ${f.code.trim()}` });
  if (f.languages.length) {
    const map = Object.fromEntries((kb ? kb.languages : []).map((l) => [l.id, l.label]));
    chips.push({ key: "languages", label: `Lingua: ${f.languages.map((id) => map[id] || id).join(", ")}` });
  }
  if (f.dateFrom || f.dateTo) chips.push({ key: "period", label: `Creato${f.dateFrom ? " dal " + day(f.dateFrom) : ""}${f.dateTo ? " al " + day(f.dateTo) : ""}` });
  return chips;
}

function clearKbKey(key) {
  if (key === "text") return clearFilterKey("text");
  if (key === "period") return kbSetFilter({ dateFrom: "", dateTo: "" });
  kbSetFilter(key, emptyKbFilters()[key]);
}

// ---------------------------------------------------------------- FAQ (HD Touch — ricerca dedicata!)

const FAQ_RESULT_TTL = 2 * 60 * 1000;
let faqSeq = 0;

async function runFaq({ fresh = false } = {}) {
  const st = S.faqS;
  if (!faq) return [];
  const f = { ...st.filters };
  const key = JSON.stringify([f, st.sort]);
  if (!fresh && key === st.key && !st.error && Date.now() - st.at < FAQ_RESULT_TTL) {
    return st.results;
  }
  if (faqAbort) faqAbort.abort();
  const ac = new AbortController();
  faqAbort = ac;
  const my = ++faqSeq;
  Object.assign(st, { loading: true, error: null, notices: [], loadedOnce: true });
  renderAll();
  try {
    const res = await faq.search({ filters: f, sort: st.sort, limit: 200, signal: ac.signal });
    if (my !== faqSeq || ac.signal.aborted) return [];
    st.results = res.rows || [];
    st.total = Math.max(res.total || 0, st.results.length);
    st.key = key;
    st.at = Date.now();
    archivedMap(st.results.map((r) => r.id))
      .then((m) => { for (const [k, v] of m) S.archived.set(k, v); renderAll(); })
      .catch(() => {});
    return st.results;
  } catch (e) {
    if (e.name === "AbortError" || my !== faqSeq) return [];
    log(`FAQ Touch: ${e.message}`);
    st.error = e;
    if (e instanceof AuthError) setConn(false);
    return [];
  } finally {
    if (my === faqSeq) {
      st.loading = false;
      renderAll();
    }
  }
}

function faqChanged() {
  refreshSidebar();
  syncSearchBoxes();
  runFaq();
  renderAll();
}

function faqSetFilter(key, val) {
  if (key && typeof key === "object") Object.assign(S.faqS.filters, key);
  else S.faqS.filters[key] = val;
  faqChanged();
}

function faqReset() {
  S.faqS.filters = emptyFaqFilters();
  listFilters.faq = "";
  faqChanged();
}

function describeFaq() {
  const f = S.faqS.filters;
  const day = (d) => d.split("-").reverse().join("/");
  const chips = [];
  if (f.query.trim()) chips.push({ key: "query", label: `Domanda + Risposta: “${f.query.trim()}”` });
  if (f.question.trim()) chips.push({ key: "question", label: `Domanda: “${f.question.trim()}”` });
  if (f.answer.trim()) chips.push({ key: "answer", label: `Risposta: “${f.answer.trim()}”` });
  if (f.code.trim()) chips.push({ key: "code", label: `Codice: ${f.code.trim()}` });
  if (f.statuses.length) {
    const map = Object.fromEntries((faq ? faq.statuses : []).map((s) => [s.id, s.label]));
    chips.push({ key: "statuses", label: `Stato: ${f.statuses.map((id) => map[id] || id).join(", ")}` });
  }
  if (f.folders.length) chips.push({ key: "folders", label: `Cartella: ${f.folders.map((x) => x.label || x.id).join(", ")}` });
  if (f.catalogItems.length) chips.push({ key: "catalogItems", label: `Catalogo: ${f.catalogItems.map((x) => x.label || x.id).join(", ")}` });
  if (String(f.importance ?? "").trim() !== "") chips.push({ key: "importance", label: `Importanza ≥ ${f.importance}` });
  if (f.dateFrom || f.dateTo) chips.push({ key: "period", label: `Creata${f.dateFrom ? " dal " + day(f.dateFrom) : ""}${f.dateTo ? " al " + day(f.dateTo) : ""}` });
  if (f.statusDateFrom) chips.push({ key: "statusDateFrom", label: `Cambio stato dal ${day(f.statusDateFrom)}` });
  return chips;
}

function clearFaqKey(key) {
  if (key === "period") return faqSetFilter({ dateFrom: "", dateTo: "" });
  faqSetFilter(key, emptyFaqFilters()[key]);
}

// ---------------------------------------------------------------- Storico (Area Riservata)

function storicoQuery() {
  const text = String(S.filters.text || "").trim();
  if (ticketIdFrom(text) && isLegacyTicketNumber(text)) return { ...emptyStoricoFilters(), dateTo: "", number: ticketNumber(ticketIdFrom(text)), fromBox: true };
  if (hasStoricoFilter(S.storico.filters)) return { ...S.storico.filters };
  return null;
}

let storicoSeq = 0;
async function runStorico({ more = false, fresh = false } = {}) {
  const st = S.storico;
  if (!storico) return [];
  const q = storicoQuery();
  const key = q ? JSON.stringify(q) : "";
  if (!q) {
    storicoSeq++;
    Object.assign(st, { results: [], total: 0, error: null, key: "", loading: false });
    return [];
  }
  if (!more && !fresh && key === st.key && !st.error) return st.results;
  const my = ++storicoSeq;
  if (!more) Object.assign(st, { results: [], total: 0 });
  Object.assign(st, { loading: true, error: null, key });
  renderAll();
  try {
    await ensureCentre();
    const res = await storico.search(q, { start: more ? st.results.length : 0, rows: Number(S.settings.pageSize) || 50 });
    if (my !== storicoSeq) return [];
    const seen = new Set(more ? st.results.map((r) => r.ttCodice) : []);
    const fresh_ = res.rows.filter((r) => !seen.has(r.ttCodice));
    st.results = more ? [...st.results, ...fresh_] : fresh_;
    if (res.total >= 0) st.total = res.total;
    st.total = Math.max(st.total, st.results.length);
    harvestStorico(res.rows);
    if (ar && ar.state.idCenSer && S.caps.arCentro !== ar.state.idCenSer) {
      S.caps.arCentro = ar.state.idCenSer;
      kvSet("caps", S.caps);
    }
    return st.results;
  } catch (e) {
    if (my !== storicoSeq) return [];
    st.error = e;
    st.key = "";
    log("storico: " + e.message);
    return [];
  } finally {
    if (my === storicoSeq) { st.loading = false; autoPickSource(); renderAll(); }
  }
}

const ST_CLIENTS_MAX = 8000;
let stLookupsTimer = null;
function saveStLookupsSoon() {
  if (stLookupsTimer) return;
  stLookupsTimer = setTimeout(() => { stLookupsTimer = null; kvSet("stLookups", S.stLookups); }, 1500);
}
function harvestStorico(rows) {
  let changed = false;
  const L = S.stLookups;
  for (const r of rows) {
    if (r.ownerGroupId && r.ownerGroup && L.groups[r.ownerGroupId] !== r.ownerGroup) { L.groups[r.ownerGroupId] = r.ownerGroup; changed = true; }
    if (r.assignedId && r.assigned && L.operators[r.assignedId] !== r.assigned) { L.operators[r.assignedId] = r.assigned; changed = true; }
    if (r.customerCode && r.account && L.clients[r.customerCode] !== r.account && (r.customerCode in L.clients || Object.keys(L.clients).length < ST_CLIENTS_MAX)) { L.clients[r.customerCode] = r.account; changed = true; }
  }
  if (changed) saveStLookupsSoon();
  return changed;
}
function harvestOperators(map) {
  let changed = false;
  for (const [id, name] of Object.entries(map || {})) if (S.stLookups.operators[id] !== name) { S.stLookups.operators[id] = name; changed = true; }
  if (changed) saveStLookupsSoon();
  return changed;
}

const NAMES_PARALLEL = 3;
const NAMES_LIST_MAX = 250;
const NAMES_SLOW_MS = 12000;
const names = { queue: [], active: 0, tried: new Set(), fails: 0, off: false };

function needsNames(r) {
  if (!r || r.source !== "ar") return false;
  const L = S.stLookups;
  return !!((r.customerCode && !L.clients[r.customerCode]) || (r.assignedId && !L.operators[r.assignedId]));
}
function queueArNames() {
  if (names.off || !storico || !ar || !ctx.arCentre()) return;
  const queued = new Set(names.queue.map((r) => r.id));
  for (const r of arRows().slice(0, NAMES_LIST_MAX)) {
    if (r.cenSer && r.cenSer !== ctx.arCentre()) continue;
    if (needsNames(r) && r.date && !names.tried.has(r.id) && !queued.has(r.id)) names.queue.push(r);
  }
  pumpNames();
}
function stopNames(why) {
  names.off = true;
  names.queue.length = 0;
  log(`nomi del Vecchio Cruscotto: mi fermo (${why})`);
}
function pumpNames() {
  while (!names.off && names.active < NAMES_PARALLEL && names.queue.length) {
    const r = names.queue.shift();
    if (!needsNames(r) || names.tried.has(r.id)) continue;
    names.tried.add(r.id);
    names.active++;
    const t0 = Date.now();
    storico.findTicket({ number: r.id, date: r.date, clientCode: r.customerCode })
      .then((info) => {
        names.fails = 0;
        if (info && harvestStorico([info])) refreshArNamesSoon();
        if (Date.now() - t0 > NAMES_SLOW_MS) stopNames("lo Storico risponde lentamente");
      })
      .catch((e) => { if (++names.fails >= 3) stopNames(e.message); })
      .finally(() => { names.active--; pumpNames(); });
  }
}
let namesPaint = null;
function refreshArNamesSoon() {
  if (namesPaint) return;
  namesPaint = setTimeout(() => { namesPaint = null; refreshArNames(); }, 250);
}
function refreshArNames() {
  const byId = new Map(arRows().map((r) => [r.id, r]));
  for (const n of document.querySelectorAll('#results .item[data-source="ar"]')) {
    const r = byId.get(n.dataset.id);
    if (!r) continue;
    const fresh = metaEl(withArNames(r));
    const old = n.querySelector(".item-foot .meta");
    if (!fresh || (old && old.textContent === fresh.textContent)) continue;
    if (old) old.replaceWith(fresh);
    else {
      const foot = n.querySelector(".item-foot");
      if (foot) foot.appendChild(fresh);
    }
  }
}

async function storicoLookup(kind, q) {
  const words = tokens(q);
  const match = (label, id) => words.every((w) => tokens(label + " " + id).some((t) => t.includes(w)));
  const out = new Map();
  for (const [id, label] of Object.entries(S.stLookups[kind === "groups" ? "groups" : "operators"])) if (match(label, id)) out.set(id, { id, label });
  if (kind === "groups" && lookups) {
    try {
      for (const g of await lookups.search("groups", q)) {
        const m = /^G(\d+)/i.exec(String(g.id || ""));
        if (m && !out.has(m[1])) out.set(m[1], { id: m[1], label: g.label });
      }
    } catch { /* */ }
  }
  return [...out.values()].slice(0, 20);
}

function storicoChanged() { refreshSidebar(); runStorico(); renderAll(); }
function storicoSetFilter(key, val) {
  if (key && typeof key === "object") Object.assign(S.storico.filters, key);
  else S.storico.filters[key] = val;
  storicoChanged();
}
function storicoReset() { S.storico.filters = emptyStoricoFilters(); storicoChanged(); }

function describeStorico() {
  const f = S.storico.filters;
  const q = storicoQuery();
  if (q && q.fromBox) return [{ key: "box", label: `Numero ${q.number}` }];
  const day = (d) => d.split("-").reverse().join("/");
  const chips = [];
  if (f.number) chips.push({ key: "number", label: `Numero ${f.number}` });
  if (f.dateFrom || f.dateTo) chips.push({ key: "dates", label: `${f.dateRef === "2" ? "Apertura" : "Aggiornamento"} ${f.dateFrom ? "dal " + day(f.dateFrom) : ""} ${f.dateTo ? "al " + day(f.dateTo) : ""}`.trim() });
  if (f.statoBase) chips.push({ key: "statoBase", label: f.statoBase === "A" ? "Stato: aperti" : "Stato: chiusi" });
  if (f.clientCode) chips.push({ key: "clientCode", label: `Cliente cod. ${f.clientCode}` });
  if (f.group) chips.push({ key: "group", label: `Gruppo: ${S.stLookups.groups[f.group] || f.groupLabel || f.group}` });
  if (f.operator && f.operator.id) chips.push({ key: "operator", label: `Operatore: ${f.operator.label || f.operator.id}` });
  return chips;
}

function clearStoricoKey(key) {
  if (key === "box") return clearFilterKey("text");
  const empty = emptyStoricoFilters();
  if (key === "dates") Object.assign(S.storico.filters, { dateFrom: "", dateTo: empty.dateTo });
  else if (key === "group") Object.assign(S.storico.filters, { group: "", groupLabel: "" });
  else S.storico.filters[key] = empty[key];
  storicoChanged();
}

// ---------------------------------------------------------------- navigazione (Left Rail + Workspace Header)

function pickSource(src) {
  pickPending = false;
  const changed = S.source !== src;
  S.source = src;
  S.view = "results";
  S.cursor = -1;
  if (changed) renderSidebar(ctx);
  syncSearchBoxes();
  // Prima visita alla scheda FAQ: carica automaticamente le FAQ di Touch (1 richiesta rapida)
  if (src === "faq" && !S.faqS.loadedOnce && S.connected !== false) {
    runFaq();
  }
  renderAll();
}

function pickView(view) {
  pickPending = false;
  S.view = view;
  S.cursor = -1;
  renderAll();
}

function openFound(row) {
  const src = sourceOf(row);
  if (isResultsView() && S.source !== src) {
    S.source = src;
    refreshSidebar();
  }
  openTicket(row.id, row);
}

const DATE_CHIP_KEYS = new Set(["dateFrom", "dateTo", "updFrom", "updTo", "period", "dates", "statusDateFrom"]);

function activeFilterCountFor(source = S.source) {
  const notDate = (c) => !DATE_CHIP_KEYS.has(c.key);
  if (source === "touch") return describeFilters({ ...S.filters, text: "" }).filter(notDate).length;
  if (source === "ar") return describeAr().filter((c) => c.key !== "text" && notDate(c)).length;
  if (source === "storico") return describeStorico().filter((c) => c.key !== "box" && notDate(c)).length;
  if (source === "kb") return describeKb().filter((c) => c.key !== "text" && notDate(c)).length;
  if (source === "faq") return describeFaq().filter((c) => c.key !== "query" && notDate(c)).length;
  return 0;
}

function renderNavRail() {
  const el = $("#navList");
  if (!el) return;
  clear(el);
  const c = sourceCounts();
  const busy = { touch: S.loading, ar: S.arS.loading, storico: S.storico.loading, kb: S.kbS.loading, faq: S.faqS.loading };
  const fmtN = (n) => Number(n || 0).toLocaleString("it-IT");

  el.appendChild(h("div", { class: "nav-section-lbl" }, "Fonti"));
  for (const [key, meta] of Object.entries(SOURCES)) {
    const count = c[key];
    const showBadge = busy[key] || count > 0;
    el.appendChild(
      h("button", {
        type: "button",
        class: "nav-item" + (S.source === key ? " on" : ""),
        role: "tab",
        "aria-selected": S.source === key ? "true" : "false",
        title: meta.title,
        dataset: { source: key },
        onclick: () => pickSource(key),
      },
        icon(meta.ico),
        h("span", { class: "nav-lbl" }, meta.label),
        showBadge ? h("span", { class: "nav-n" }, busy[key] && !count ? "…" : fmtN(count)) : null),
    );
  }
}

function renderWorkspaceHeader() {
  const meta = SOURCES[S.source] || SOURCES.touch;
  const titleEl = $("#wsTitle");
  const subEl = $("#wsSubtitle");
  const ctaEl = $("#wsCta");
  const tabsEl = $("#wsTabs");
  if (!titleEl || !tabsEl) return;

  titleEl.textContent = meta.label;
  if (subEl) subEl.textContent = meta.subtitle;

  // Pulsanti azione in alto a destra (come "New ticket" nello stamp)
  clear(ctaEl);
  const items = visibleItems();
  if (S.source === "touch") {
    ctaEl.append(
      h("button", { type: "button", class: "btn btn-subtle", onclick: exportCsv, disabled: !S.total || S.job ? true : null, title: "Scarica in Excel (max 1000)" }, icon("download"), "Excel"),
      h("button", { type: "button", class: "btn btn-subtle", onclick: archiveResults, disabled: !S.total || S.job ? true : null, title: "Archivia i risultati in locale" }, icon("archive"), "Archivia"),
      h("button", { type: "button", class: "btn btn-primary", onclick: saveSearchDialog, title: "Salva questi filtri" }, icon("save"), "Salva ricerca"),
    );
  } else if (S.source === "ar") {
    ctaEl.append(h("button", { type: "button", class: "btn btn-primary", onclick: exportCsv, disabled: !items.length || S.job ? true : null }, icon("download"), "Esporta Excel"));
  } else if (S.source === "kb") {
    ctaEl.append(
      h("button", { type: "button", class: "btn btn-subtle", onclick: exportCsv, disabled: !S.kbS.results.length || S.job ? true : null }, icon("download"), "Excel"),
      h("button", { type: "button", class: "btn btn-primary", onclick: kbBrowseAll, title: "Mostra tutti gli articoli KB di HD Touch" }, icon("book"), "Sfoglia tutti"),
    );
  } else if (S.source === "faq") {
    ctaEl.append(
      h("button", { type: "button", class: "btn btn-subtle", onclick: exportCsv, disabled: !S.faqS.results.length || S.job ? true : null }, icon("download"), "Excel"),
      h("button", { type: "button", class: "btn btn-primary", onclick: () => { if (hasFaqFilter(S.faqS.filters)) faqReset(); else runFaq({ fresh: true }); }, title: "Carica tutte le FAQ di HD Touch" }, icon("reload"), hasFaqFilter(S.faqS.filters) ? "Mostra tutte" : "Aggiorna FAQ"),
    );
  }

  // Schede sottolineate (Risultati | Archivio locale | Preferiti | Recenti) — stile stamp!
  clear(tabsEl);
  const counts = sourceCounts();
  const fmtN = (n) => Number(n || 0).toLocaleString("it-IT");
  const resCount = counts[S.source];
  const viewDefs = [
    ["results", "Risultati", resCount > 0 ? fmtN(resCount) : null],
    ["archive", "Archivio locale", S.filters.text && S.archiveHits.length ? fmtN(S.archiveHits.length) : S.archiveCount ? fmtN(S.archiveCount) : null],
    ["favorites", "Preferiti", S.favorites.length ? fmtN(S.favorites.length) : null],
    ["recent", "Recenti", S.recent.length ? fmtN(S.recent.length) : null],
  ];
  for (const [vKey, vLabel, badge] of viewDefs) {
    tabsEl.appendChild(
      h("button", {
        type: "button",
        class: "ws-tab" + (S.view === vKey ? " on" : ""),
        role: "tab",
        "aria-selected": S.view === vKey ? "true" : "false",
        onclick: () => pickView(vKey),
      }, vLabel, badge != null ? h("span", { class: "tab-badge" }, badge) : null),
    );
  }

  // Barra ricerca: principale vs dedicata FAQ
  const isFaq = S.source === "faq";
  const sf = $("#searchForm");
  const fsf = $("#faqSearchForm");
  if (sf) sf.hidden = isFaq;
  if (fsf) fsf.hidden = !isFaq;

  // Tasto Filtri
  const ft = $("#filterToggle");
  if (ft) {
    ft.classList.toggle("on", !!ui.showFilters);
    const nF = activeFilterCountFor();
    clear(ft);
    ft.appendChild(h("span", null, "Filtri"));
    if (nF) ft.appendChild(h("span", { class: "fbadge" }, String(nF)));
    ft.appendChild(icon("filter"));
  }
}

function renderActivityPanel() {
  const el = $("#activityCol");
  if (!el) return;
  clear(el);
  const list = S.recent.length ? S.recent.slice(0, 7) : S.favorites.slice(0, 7);
  const heading = S.recent.length || !S.favorites.length ? "Attività recente" : "Preferiti";
  const card = h("div", { class: "act-card" }, h("h2", null, heading));
  if (!list.length) {
    card.appendChild(h("div", { class: "act-empty" }, "I ticket, gli articoli Knowledge Base e le FAQ che apri compariranno qui per un accesso rapido."));
  } else {
    const items = h("div", { class: "act-list" });
    for (const x of list) {
      const r = reviveRow(x.row) || { id: x.id };
      const src = sourceOf(r);
      const sm = SOURCES[src] || SOURCES.touch;
      items.appendChild(
        h("button", {
          type: "button",
          class: `act-item src-${src}`,
          onclick: () => openTicket(r.id, r),
        },
          h("span", { class: "act-av", title: sm.label }, sm.short),
          h("span", { class: "act-body" },
            h("b", null, r.subject || numberOf(r)),
            h("span", { class: "act-meta" }, `${numberOf(r)} · ${fmtRelative(x.at) || sm.label}`))),
      );
    }
    card.appendChild(items);
    if (S.recent.length > 7) {
      card.appendChild(h("button", { type: "button", class: "btn btn-subtle act-more", onclick: () => pickView("recent") }, "Mostra tutto"));
    }
  }
  el.appendChild(card);
}

// ---------------------------------------------------------------- elenco risultati

function visibleItems() {
  if (S.view === "archive") return S.archiveHits.map((x) => ({ row: x.row, snippet: x.snippet }));
  if (S.view === "favorites") return S.favorites.map((x) => ({ row: reviveRow(x.row) || { id: x.id } }));
  if (S.view === "recent") return S.recent.map((x) => ({ row: reviveRow(x.row) || { id: x.id } }));
  if (S.source === "touch") return touchRows().map((row) => ({ row }));
  if (S.source === "ar") return arRows().map((row) => ({ row }));
  if (S.source === "storico") return S.storico.results.map((row) => ({ row }));
  if (S.source === "kb") return S.kbS.results.map((row) => ({ row }));
  if (S.source === "faq") return S.faqS.results.map((row) => ({ row }));
  return S.results.map((row) => ({ row }));
}

function metaEl(r) {
  let meta = [];
  if (r.source === "kb") {
    meta = [r.catalog, r.version && `v. ${r.version}`, r.topic, r.assigned].filter(Boolean);
  } else if (r.source === "faq") {
    const vis = r.visibleFrom || r.visibleTo ? `Valida${r.visibleFrom ? " dal " + fmtDate(r.visibleFrom) : ""}${r.visibleTo ? " al " + fmtDate(r.visibleTo) : ""}` : "";
    meta = [r.lang && r.lang !== "Default" ? r.lang : "", r.importance ? `Importanza ${r.importance}` : "", vis].filter(Boolean);
  } else {
    meta = [r.account, r.ownerGroup, r.assigned && `→ ${r.assigned}`].filter(Boolean);
  }
  return meta.length ? h("div", { class: "meta" }, meta.flatMap((m, k) => [k ? h("span", { class: "sep" }, "·") : null, h("span", { title: m }, m)])) : null;
}

function itemEl(it, i) {
  const r = withArNames(it.row);
  const src = sourceOf(r);
  const isKb = src === "kb";
  const isFaq = src === "faq";
  const fav = isFavorite(r.id);
  const seen = S.recent.some((x) => x.id === r.id);
  const arch = S.archived.get(r.id);

  const sortObj = isKb ? S.kbS.sort : isFaq ? S.faqS.sort : S.sort;
  const when = sortObj.key === "lastChange" ? r.lastChange : sortObj.key === "publishDate" ? r.publishDate || r.date : r.date;
  const snip = it.snippet || snippetOf(r, src);

  let statusPill = null;
  if (isKb) {
    const st = kbStatusInfo(r.statusId, r.statusText);
    statusPill = h("span", { class: `pill ${st.tone}` }, st.label);
  } else if (isFaq) {
    const st = faqStatusInfo(r.statusId, r.statusText);
    statusPill = h("span", { class: `pill ${st.tone}` }, st.label);
  } else if (r.statusId || r.statusText) {
    const st = statusInfo(r.statusId, r.statusText);
    statusPill = h("span", { class: `pill ${st.group}`, title: r.statusId || "" }, st.label);
  }

  const kbTypePill = isKb && r.typeText
    ? h("span", { class: r.typeText.toLowerCase().includes("error") ? "pill err" : "tag-mini" }, r.typeText)
    : null;

  return h("article", {
    class: `item src-${src}` + (r.id === S.current ? " sel" : "") + (seen ? " seen" : ""),
    tabindex: "0",
    dataset: { id: r.id, i: String(i), source: src },
    onclick: (e) => { if (e.ctrlKey || e.metaKey) return openInNewPage(r.id, r, { background: true }); S.cursor = i; openTicket(r.id, r); },
    onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
    onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); openInNewPage(r.id, r, { background: true }); } },
  },
    h("div", { class: "item-top" },
      h("div", { class: "subj", title: r.subject || "" }, r.subject || "(senza oggetto)"),
      h("div", { class: "item-right" },
        h("span", { class: "when", title: when ? fmtDateTime(when) : "" }, isKb || isFaq ? fmtDate(when) : fmtRelative(when)),
        h("button", { class: "item-open", type: "button", title: "Apri in una nuova pagina (o Ctrl+clic)", "aria-label": "Apri in una nuova pagina", onclick: (e) => { e.stopPropagation(); openInNewPage(r.id, r); } }, icon("external")))),
    snip ? h("div", { class: "snip" }, snip) : null,
    h("div", { class: "item-foot" },
      statusPill,
      kbTypePill,
      h("span", { class: "code-pill", title: `${(SOURCES[src] || SOURCES.touch).title}: ${numberOf(r)}` }, numberOf(r)),
      !isResultsView() ? h("span", { class: `src-badge src-${src}` }, (SOURCES[src] || SOURCES.touch).label) : null,
      arch ? h("span", { class: "tag-mini", title: `Nell'archivio locale (${fmtDateTime(arch.savedAt)})` }, icon("archive")) : null,
      r.hasAttachments ? h("span", { class: "tag-mini", title: "Contiene allegati" }, icon("clip")) : null,
      fav ? h("span", { class: "star-on", title: "Preferito" }, icon("star")) : null,
      metaEl(r)));
}

function filterTextOf(row) {
  const r = withArNames(row);
  if (r.source === "kb") return [numberOf(r), r.code, r.kbId, r.subject, r.problem, r.catalog, r.version, r.topic, r.typeText, r.statusText, r.assigned].filter(Boolean).join(" ");
  if (r.source === "faq") return [numberOf(r), r.code, r.faqId, r.subject, r.fullAnswer || r.problem, r.statusText, r.lang].filter(Boolean).join(" ");
  return [ticketNumber(r.id), r.subject, r.problem, r.solution, r.fullText, r.account, r.customerCode, r.contact, r.ownerGroup, r.assigned, r.catalog, r.topic, statusInfo(r.statusId, r.statusText).label].filter(Boolean).join(" ");
}

function filteredRows(rows, src = S.source) {
  const test = listFilter(listFilters[src] || "");
  return test ? rows.filter((r) => test(filterTextOf(r))) : rows;
}

function applyListFilter() {
  const box = document.querySelector("#results .list-filter");
  if (!box) return;
  const test = isResultsView() ? listFilter(listFilters[S.source] || "") : null;
  const items = visibleItems();
  let shown = 0;
  for (const n of document.querySelectorAll("#results .list > .item")) {
    const it = items[Number(n.dataset.i)];
    const ok = !test || !!(it && test(filterTextOf(it.row)));
    n.hidden = !ok;
    if (ok) shown++;
  }
  const count = box.querySelector(".lf-count");
  if (count) count.textContent = test ? `${shown.toLocaleString("it-IT")} di ${items.length.toLocaleString("it-IT")}` : "";
  box.classList.toggle("on", !!test);
  const none = document.querySelector("#results .lf-none");
  if (none) none.hidden = !(test && !shown && items.length);
}
const applyListFilterSoon = debounce(applyListFilter, 120);

function listFilterBox() {
  const inp = h("input", { type: "search", value: listFilters[S.source] || "", placeholder: "Filtra nell'elenco corrente (es. parola, -escludi)…", "aria-label": "Filtra in elenco" });
  inp.addEventListener("input", () => { listFilters[S.source] = inp.value; applyListFilterSoon(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inp.value) { e.stopPropagation(); inp.value = ""; listFilters[S.source] = ""; applyListFilter(); }
    if (e.key === "Enter") { e.preventDefault(); applyListFilter(); }
  });
  return h("div", { class: "list-filter" }, icon("filter"), inp, h("span", { class: "lf-count" }));
}

function renderAll() {
  renderNavRail();
  renderWorkspaceHeader();
  renderDateBar(ctx);
  renderResults();
  renderActivityPanel();
}

function renderResults() {
  const el = $("#results");
  if (!el) return;
  const top = el.scrollTop;
  const ae = document.activeElement;
  const typingFilter = ae && ae.closest && ae.closest("#results .list-filter") ? [ae.selectionStart, ae.selectionEnd] : null;
  clear(el);

  const fmtN = (n) => Number(n || 0).toLocaleString("it-IT");
  const onRes = isResultsView();
  const src = S.source;
  const items = visibleItems();
  const counts = sourceCounts();
  const st = S.storico;
  const arS = S.arS;
  const kbS = S.kbS;
  const faqS = S.faqS;

  const unitOf = (n) => {
    const one = Number(n) === 1;
    if (src === "kb") return one ? "articolo" : "articoli";
    if (src === "faq") return "FAQ";
    return "ticket";
  };
  const busy = onRes && (src === "storico" ? st.loading : src === "ar" ? arS.loading : src === "kb" ? kbS.loading : src === "faq" ? faqS.loading : S.loading);
  const total = onRes ? counts[src] : items.length;
  const what = { archive: "nell'archivio", favorites: "preferiti", recent: "recenti" }[S.view];
  const asked = src === "touch" ? !isUnconstrained(S.filters) : src === "ar" ? !!arQuery() : src === "storico" ? !!storicoQuery() : src === "kb" ? !!kbQuery() : true;

  const countText = onRes
    ? (busy && !items.length ? "Ricerca in corso…" : busy ? `${fmtN(items.length)} ${unitOf(items.length)} finora…` : !asked && !items.length ? "Nessuna ricerca attiva" : `${fmtN(total)} ${unitOf(total)}`)
    : `${fmtN(items.length)} ${what}`;

  // Selettore ordinamento
  let sortControls = null;
  if (onRes && src !== "storico") {
    const map = src === "kb" ? KB_SORTS : src === "faq" ? FAQ_SORTS : SORTS;
    const curSort = src === "kb" ? kbS.sort : src === "faq" ? faqS.sort : S.sort;
    const onSortChange = () => {
      if (src === "kb") runKb({ fresh: false });
      else if (src === "faq") runFaq({ fresh: false });
      else { kvSet("sort", S.sort); search(); }
    };
    const sortSel = h("select", { class: "input", title: "Ordina per", onchange: (e) => { curSort.key = e.target.value; onSortChange(); } },
      Object.entries(map).map(([k, s]) => h("option", { value: k, selected: curSort.key === k ? true : null }, s.label)));
    const dirBtn = curSort.key === "relevance"
      ? null
      : h("button", { class: "btn btn-small btn-subtle", title: "Inverti ordine", onclick: () => { curSort.dir = curSort.dir === "DESC" ? "ASC" : "DESC"; onSortChange(); } },
          icon("sort"), curSort.dir === "DESC" ? "Decrescente" : "Crescente");
    sortControls = [sortSel, dirBtn];
  }

  const refreshBtn = onRes
    ? h("button", {
        class: "btn btn-small btn-icon btn-subtle",
        title: "Aggiorna (rifà la ricerca sul portale)",
        onclick: () => (src === "storico" ? runStorico({ fresh: true }) : src === "ar" ? runAr({ fresh: true }) : src === "kb" ? runKb({ fresh: true }) : src === "faq" ? runFaq({ fresh: true }) : search({ fresh: true })),
      }, icon("reload"))
    : null;

  el.appendChild(
    h("div", { class: "res-toolbar" },
      h("div", { class: "res-count" }, countText, onRes && !busy && items.length && total > items.length ? h("small", null, ` · mostrati ${fmtN(items.length)}`) : null),
      sortControls,
      onRes && src === "storico" ? h("span", { class: "hint" }, "dal più recente") : null,
      refreshBtn),
  );

  if (onRes && (items.length > 5 || listFilters[src])) el.appendChild(listFilterBox());

  // Chip dei filtri attivi
  if (onRes) {
    const chips = src === "storico" ? describeStorico() : src === "ar" ? describeAr() : src === "kb" ? describeKb() : src === "faq" ? describeFaq() : describeFilters(S.filters);
    if (src === "touch") {
      const sent = touchSentText(S.filters.text);
      const chip = chips.find((c) => c.key === "text");
      if (chip && sent && sent !== String(S.filters.text || "").trim()) chip.label = `Cercato come: ${sent}`;
    }
    if (chips.length) {
      const drop = src === "storico" ? clearStoricoKey : src === "ar" ? clearArKey : src === "kb" ? clearKbKey : src === "faq" ? clearFaqKey : clearFilterKey;
      const clearAll = src === "storico"
        ? storicoReset
        : src === "ar"
          ? () => { arReset(); if (S.filters.text) clearFilterKey("text"); }
          : src === "kb"
            ? () => { kbReset(); if (S.filters.text) clearFilterKey("text"); }
            : src === "faq"
              ? faqReset
              : resetFilters;
      el.appendChild(
        h("div", { class: "chips" },
          chips.map((c) => h("span", { class: "chip", title: c.label }, h("span", null, c.label), h("button", { title: "Rimuovi filtro", onclick: () => drop(c.key) }, "×"))),
          chips.length > 1 ? h("button", { class: "linkbtn", onclick: clearAll }, "Azzera tutto") : null),
      );
    }
  }

  // Avvisi, lavori, errori
  if (S.job) el.appendChild(jobBox());
  const noticeEl = (n) =>
    n && typeof n === "object" && n.text
      ? h("div", { class: "notice with-action" }, h("span", null, n.text), n.action ? h("button", { class: "btn btn-small", onclick: n.action }, n.actionLabel || "Riprova") : null)
      : h("div", { class: "notice" }, n);

  if (onRes && src === "ar") {
    for (const n of arS.notices) el.appendChild(noticeEl(n));
    if (S.arConnected !== true) {
      el.appendChild(noticeEl({ text: "L'Area Riservata non è collegata: aprila ed esegui l'accesso per cercare nel Vecchio Cruscotto.", action: () => openArHome(), actionLabel: "Collega Area Riservata" }));
    } else if (arS.error) {
      el.appendChild(h("div", { class: "err-box" }, "Ricerca nel Vecchio Cruscotto non riuscita: " + arS.error.message,
        h("div", { style: { display: "flex", gap: "8px" } },
          h("button", { class: "btn", onclick: () => openArHome() }, icon("external"), "Apri Area Riservata"),
          h("button", { class: "btn", onclick: () => runAr({ fresh: true }) }, "Riprova"))));
    }
  }
  if (onRes && src === "kb") {
    for (const n of kbS.notices) el.appendChild(noticeEl(n));
    if (kbS.error) {
      const auth = kbS.error instanceof AuthError;
      el.appendChild(h("div", { class: "err-box" }, "Ricerca Knowledge Base non riuscita: " + kbS.error.message,
        h("div", { style: { display: "flex", gap: "8px" } },
          auth ? h("button", { class: "btn", onclick: openTouchHome }, icon("external"), "Apri HDA TOUCH") : null,
          h("button", { class: "btn", onclick: () => runKb({ fresh: true }) }, "Riprova"))));
    }
  }
  if (onRes && src === "faq") {
    for (const n of faqS.notices) el.appendChild(noticeEl(n));
    if (faqS.error) {
      const auth = faqS.error instanceof AuthError;
      el.appendChild(h("div", { class: "err-box" }, "Caricamento FAQ non riuscito: " + faqS.error.message,
        h("div", { style: { display: "flex", gap: "8px" } },
          auth ? h("button", { class: "btn", onclick: openTouchHome }, icon("external"), "Apri HDA TOUCH") : null,
          h("button", { class: "btn", onclick: () => runFaq({ fresh: true }) }, "Riprova"))));
    }
  }
  if (onRes && src === "touch") {
    const scanNote = touchScanNotice(fmtN);
    if (scanNote) el.appendChild(noticeEl(scanNote));
    for (const n of S.notices) el.appendChild(noticeEl(n));
    if (S.error) {
      const auth = S.error instanceof AuthError;
      el.appendChild(h("div", { class: "err-box" },
        auth ? (S.error.message || "Sessione HDA TOUCH non attiva. Apri Touch, accedi e riprova.") : "La ricerca non è riuscita: " + S.error.message,
        h("div", { style: { display: "flex", gap: "8px" } },
          auth ? h("button", { class: "btn", onclick: openTouchHome }, icon("external"), "Apri HDA TOUCH") : null,
          h("button", { class: "btn", onclick: () => search({ fresh: true }) }, "Riprova"))));
    }
  }
  if (onRes && src === "storico") {
    const text = String(S.filters.text || "").trim();
    if (text && !ticketIdFrom(text) && !storicoQuery()) {
      el.appendChild(noticeEl(`In Ricerca avanzata non si può cercare per parole («${text}»): scrivi un numero ticket, scegli un periodo qui sopra oppure usa i filtri a sinistra.`));
    }
    if (st.error) {
      el.appendChild(h("div", { class: "err-box" }, st.error.message,
        h("div", { style: { display: "flex", gap: "8px" } },
          h("button", { class: "btn", onclick: () => openArHome() }, icon("external"), "Apri Area Riservata"),
          h("button", { class: "btn", onclick: () => runStorico({ fresh: true }) }, "Riprova"))));
    }
  }
  if (S.view === "archive") {
    el.appendChild(h("div", { class: "notice" },
      S.archiveCount
        ? `Archivio locale: ${fmtN(S.archiveCount)} elementi salvati sul browser. Cerca dalla barra in alto per trovare parole dentro tutti i testi salvati.`
        : "L'archivio locale è vuoto. Ogni ticket, articolo KB o FAQ che apri viene salvato qui automaticamente."));
  }

  // Lista card
  const list = h("div", { class: "list" });
  items.forEach((it, i) => list.appendChild(itemEl(it, i)));

  const hasError = onRes && ((src === "touch" && S.error) || (src === "ar" && arS.error) || (src === "storico" && st.error) || (src === "kb" && kbS.error) || (src === "faq" && faqS.error));
  if (!items.length && !busy && !hasError) {
    let heading = "";
    let desc = "";
    let cta = null;
    if (!onRes) {
      if (S.view === "archive") { heading = S.filters.text ? "Nessun elemento nell'archivio contiene queste parole" : "Scrivi una o più parole nella barra in alto"; }
      else if (S.view === "favorites") { heading = "Nessun preferito"; desc = "Apri un ticket, un articolo KB o una FAQ e clicca la stella per ritrovarlo qui."; }
      else { heading = "Nessun elemento aperto di recente"; }
    } else if (src === "touch") {
      heading = isUnconstrained(S.filters) ? "Cerca in HDA Touch" : "Nessun ticket trovato";
      desc = isUnconstrained(S.filters)
        ? "Scrivi parole o un numero ticket nella barra in alto, scegli un periodo qui sopra oppure un filtro a sinistra."
        : "Prova a rimuovere qualche filtro o a modificare le parole cercate.";
    } else if (src === "ar") {
      heading = arQuery() ? "Nessun ticket trovato nel Vecchio Cruscotto" : "Vecchio Cruscotto (Area Riservata)";
      desc = arQuery() ? "Prova ad allargare il periodo qui sopra o a rimuovere un filtro." : "Scrivi parole o un numero ticket in alto, scegli un periodo qui sopra oppure un filtro a sinistra.";
    } else if (src === "storico") {
      heading = storicoQuery() ? "Nessun ticket trovato in Ricerca avanzata" : "Ricerca avanzata (Area Riservata)";
      desc = storicoQuery() ? "Prova ad allargare il periodo qui sopra o a cambiare i filtri." : "Scrivi un numero ticket in alto, scegli un periodo qui sopra oppure un cliente o un gruppo a sinistra.";
    } else if (src === "kb") {
      heading = kbQuery() ? "Nessun articolo Knowledge Base trovato" : "Knowledge Base di HDA Touch";
      desc = kbQuery()
        ? "Prova con altre parole oppure togli un filtro (periodo qui sopra, stato, prodotto o argomento a sinistra)."
        : "Scrivi parole o un codice (es. KB25631HR) nella barra in alto, usa i filtri di HD Touch, oppure sfoglia tutti gli articoli.";
      if (!kbQuery()) cta = h("button", { type: "button", class: "btn btn-primary", onclick: kbBrowseAll }, icon("book"), "Sfoglia tutti gli articoli KB");
    } else if (src === "faq") {
      heading = hasFaqFilter(faqS.filters) ? "Nessuna FAQ trovata" : "FAQ di HDA Touch";
      desc = hasFaqFilter(faqS.filters)
        ? "Prova a cambiare le parole nella barra FAQ o a rimuovere uno dei filtri."
        : "Usa la barra in alto per cercare insieme in Domanda e Risposta (con varianti e attinenza), oppure usa i filtri.";
      if (hasFaqFilter(faqS.filters)) cta = h("button", { type: "button", class: "btn", onclick: faqReset }, "Azzera filtri FAQ");
      else if (!faqS.loadedOnce) cta = h("button", { type: "button", class: "btn btn-primary", onclick: () => runFaq({ fresh: true }) }, "Carica le FAQ");
    }
    list.appendChild(h("div", { class: "empty-state" }, h("h3", null, heading), desc ? h("p", null, desc) : null, cta));
  }

  if (onRes && items.length) {
    list.appendChild(h("div", { class: "empty-state lf-none", hidden: true }, h("h3", null, "Nessun risultato corrisponde al filtro in elenco"), h("p", null, "Modifica o svuota la casella «Filtra nell'elenco corrente».")));
  }

  if (busy) {
    const still = src === "touch" && S.pending && S.pending.size ? [...S.pending].join(", ") : "";
    const msg = src === "storico"
      ? (items.length ? "Carico altri…" : "Cerco in Ricerca avanzata…")
      : src === "ar"
        ? ["Cerco nel Vecchio Cruscotto… ", h("span", { class: "ar-progress" }, arS.progress || "")]
        : src === "kb"
          ? "Cerco negli articoli Knowledge Base di HDA Touch…"
          : src === "faq"
            ? "Cerco nelle FAQ di HDA Touch…"
            : still
              ? (S.results.length ? `Sto ancora cercando in: ${still}…` : `Cerco in: ${still}…`)
              : S.results.length ? "Carico altri…" : "Cerco i ticket…";
    list.appendChild(h("div", { class: "loading" }, h("span", { class: "spinner" }), msg));
  }

  if (onRes && src === "touch" && !S.loading && items.length < counts.touch)
    list.appendChild(h("button", { class: "btn more", onclick: () => search({ more: true }) }, `Mostra altri (${fmtN(counts.touch - items.length)} rimanenti)`));
  if (onRes && src === "storico" && !st.loading && items.length && items.length < counts.storico)
    list.appendChild(h("button", { class: "btn more", onclick: () => runStorico({ more: true }) }, `Mostra altri (${fmtN(counts.storico - items.length)} rimanenti)`));
  if (onRes && src === "kb" && !kbS.loading && items.length && items.length < counts.kb)
    list.appendChild(h("button", { class: "btn more", onclick: () => runKb({ more: true }) }, `Mostra altri (${fmtN(counts.kb - items.length)} rimanenti)`));

  el.appendChild(list);

  // Evidenziazione parole cercate
  const qStr = onRes ? rankQueryFor(src) : S.filters.text;
  const words = tokens(qStr);
  if (onRes && src !== "storico" && words.length && !(src !== "faq" && ticketIdFrom(S.filters.text))) {
    highlight(list, highlightPatterns(qStr));
  } else if (S.view === "archive" && words.length) {
    highlight(list, words);
  }
  applyListFilter();
  if (typingFilter) {
    const inp = el.querySelector(".list-filter input");
    if (inp) {
      inp.focus();
      try { inp.setSelectionRange(typingFilter[0], typingFilter[1]); } catch { /* */ }
    }
  }
  el.scrollTop = top;
  if (onRes && src === "ar" && !S.arS.loading) queueArNames();
}

function clearFilterKey(key) {
  const empty = emptyFilters();
  if (key in empty) S.filters[key] = empty[key];
  filtersChanged(true);
}

function toggleFilters() {
  ui.showFilters = !ui.showFilters;
  $("#layout").classList.toggle("nofilters", !ui.showFilters);
  saveUi();
  renderWorkspaceHeader();
}

// ---------------------------------------------------------------- lettura (Ticket / KB / FAQ)

async function openTicket(id, row, { force = false } = {}) {
  if (!row && id) {
    const want = String(id).trim();
    row =
      S.results.find((r) => r.id === want) ||
      S.kbS.results.find((r) => r.id === want) ||
      S.faqS.results.find((r) => r.id === want) ||
      (ticketIdFrom(want) ? pickExactTicket(mergeRowLists(S.results, S.arS.results), want, { allowSingle: false }) : null) ||
      S.arS.results.find((r) => r.id === want) ||
      S.storico.results.find((r) => r.id === want) ||
      null;
  }
  id = row && row.id ? String(row.id) : isKbId(id) || isFaqId(id) ? String(id).toUpperCase() : ticketIdFrom(id) || String(id || "").trim();
  if (!id) return;
  if (!force && S.current === id && !$("#reader").hidden) return;
  row = withArNames(row);
  const my = ++openSeq;
  S.current = id;
  $("#layout").classList.add("reading");
  for (const n of document.querySelectorAll("#results .item")) n.classList.toggle("sel", n.dataset.id === id);
  ui.readerSearch = "";
  renderReaderLoading(ctx, id, row);
  try {
    const isKb = (row && row.source === "kb") || (!row && isKbId(id));
    const isFaq = (row && row.source === "faq") || (!row && isFaqId(id));
    const loaded = row && row.source === "storico"
      ? await storico.loadTicket(id, { row })
      : isKb
        ? await kb.loadDoc(id, { row })
        : isFaq
          ? await faq.loadDoc(id, { row })
          : await loadTicket(hda, id, { row, rowReader, conditionsFor: conditionsForId, caps: S.caps, ar, log });

    let full = loaded;
    if (full.source === "ar") {
      setArConn(true);
      full = await completeArTicket(full);
    }
    S.current = full.id || id;
    kvSet("caps", S.caps);
    if (!full.row && !full.ticket && !full.items.length && !(full.timeline && full.timeline.length)) {
      throw new Error("elemento non trovato o non visibile con il tuo utente");
    }
    addRecent(full.id, full.row);
    if (S.settings.archiveOnRead) {
      saveTicket(full)
        .then(() => { S.archived.set(full.id, { savedAt: Date.now(), lastChange: full.row && full.row.lastChange ? +full.row.lastChange : null }); refreshArchiveCount(); })
        .catch((e) => log("archivio: " + e.message));
    }
    if (my !== openSeq) return;
    renderReader(ctx, full);
    renderActivityPanel();
    soloTitle(full.row);
  } catch (e) {
    log(`lettura ${id}: ${e.message}`);
    if (e instanceof AuthError) setConn(false);
    if (my !== openSeq) return;
    let rec = null;
    try {
      rec = (await getTicket(id)) || (!isTouchNativeId(id) && !isKbId(id) && !isFaqId(id) && !(row && row.source === "ar") ? await getTicket(ticketNumber(id) + "Z") : null);
    } catch { /* */ }
    if (my !== openSeq) return;
    if (rec) renderReader(ctx, { id: rec.id, source: rec.row && rec.row.source, row: rec.row, ticket: null, items: [], attachments: rec.attachments || [], timeline: rec.timeline, notes: [] }, { fromArchive: rec.savedAt });
    else renderReaderError(ctx, id, row, e);
  }
}

const AR_COMPLETE_MS = 6000;
async function completeArTicket(full) {
  const row = full.row || {};
  if (!storico || !row.ttCodice) return full;
  const own = !row.cenSer || !ctx.arCentre() || row.cenSer === ctx.arCentre();
  const known = S.storico.results.find((r) => r.id === row.id && r.ttCodice === row.ttCodice) || null;
  const work = (async () => {
    const [mv, inf] = await Promise.allSettled([
      storico.loadMoves(row.ttCodice),
      known ? Promise.resolve(known) : own && ctx.arCentre() ? storico.findTicket({ number: row.id, date: row.date, clientCode: row.customerCode }) : Promise.resolve(null),
    ]);
    const moves = mv.status === "fulfilled" ? mv.value : [];
    const info = inf.status === "fulfilled" ? inf.value : null;
    let changed = harvestOperators(movePeople(moves));
    if (info) changed = harvestStorico([info]) || changed;
    if (changed) refreshArNamesSoon();
    let attachments = [];
    if (moves.length) {
      try { attachments = await storico.loadAttachments(moves, row); }
      catch (e) { log(`allegati ${row.id}: ${e.message}`); }
    }
    return enrichArTicket(full, { info, moves, attachments });
  })();
  const late = new Promise((res) => setTimeout(() => res(null), AR_COMPLETE_MS));
  const done = await Promise.race([work.catch(() => null), late]);
  const out = done || full;
  const named = withArNames(out.row);
  const timeline = named.account && named.account !== row.account
    ? (out.timeline || []).map((e) => (e.account && e.account === row.account ? { ...e, account: named.account } : e))
    : out.timeline;
  return { ...out, row: named, timeline };
}

// ---------------------------------------------------------------- Nuova pagina (Solo mode)

const OPEN_PREFIX = "rtkt-open:";
function openInNewPage(id, row, { background = false } = {}) {
  id = String((row && row.id) || id || "").trim();
  if (!id) return;
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(OPEN_PREFIX + token, JSON.stringify({ id, row: slim(row), at: Date.now() }));
  } catch (e) {
    log("nuova pagina: " + e.message);
  }
  const url = `${location.href.split("#")[0]}#open=${token}&id=${encodeURIComponent(id)}`;
  if (inExtension && chrome.tabs && chrome.tabs.create) {
    const create = (cur) =>
      chrome.tabs.create({ url, active: !background, ...(cur && cur.id != null ? { index: cur.index + 1, openerTabId: cur.id } : {}) })
        .catch((e) => toast("Non sono riuscito ad aprire la nuova pagina: " + e.message, "err", 5000));
    if (chrome.tabs.getCurrent) chrome.tabs.getCurrent((cur) => create(cur));
    else create(null);
    if (background) toast(`${numberOf(row || { id })} aperto in una nuova pagina`, "ok", 1600);
    return;
  }
  const w = window.open(url, "_blank");
  if (!w) toast("Il browser ha bloccato la nuova pagina: consenti i popup per questa pagina.", "err", 5000);
}

function closeSoloPage() {
  if (inExtension && chrome.tabs && chrome.tabs.getCurrent && chrome.tabs.remove) {
    chrome.tabs.getCurrent((cur) => {
      if (cur && cur.id != null) chrome.tabs.remove(cur.id);
      else window.close();
    });
  } else window.close();
}

function readOpenRequest() {
  const m = /[#&]open=([a-z0-9]{6,40})/i.exec(location.hash);
  const idm = /[#&]id=([A-Za-z0-9]{3,16})/.exec(location.hash);
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(OPEN_PREFIX) || (m && k === OPEN_PREFIX + m[1])) continue;
      let at = 0;
      try { at = JSON.parse(localStorage.getItem(k)).at || 0; } catch { /* */ }
      if (Date.now() - at > DAY) localStorage.removeItem(k);
    }
  } catch { /* */ }
  if (!m) return null;
  let saved = null;
  try {
    const key = OPEN_PREFIX + m[1];
    const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
    if (raw) {
      sessionStorage.setItem(key, raw);
      localStorage.removeItem(key);
      saved = JSON.parse(raw);
    }
  } catch { /* */ }
  const id = String((saved && saved.id) || (idm && idm[1]) || "").trim();
  return id ? { id, row: saved && saved.row ? reviveRow(saved.row) : null } : null;
}

function enterSolo() {
  S.solo = true;
  document.body.classList.add("solo");
}

function leaveSolo() {
  if (!S.solo) return;
  S.solo = false;
  document.body.classList.remove("solo");
  document.title = "Ricerca TKT";
  try { history.replaceState(null, "", location.pathname + location.search); } catch { /* */ }
  renderSidebar(ctx);
  renderAll();
}

function soloTitle(row) {
  if (!S.solo || !row) return;
  document.title = `${numberOf(row)}${row.subject ? " · " + row.subject : ""}`.slice(0, 120);
}

function closeReader() {
  if (S.solo) {
    closeSoloPage();
    setTimeout(() => { if (S.solo) { leaveSolo(); closeReader(); } }, 600);
    return;
  }
  openSeq++;
  S.current = null;
  const r = $("#reader");
  r.hidden = true;
  r.dataset.id = "";
  clear(r);
  $("#layout").classList.remove("reading");
  for (const n of document.querySelectorAll("#results .item.sel")) n.classList.remove("sel");
}

async function openInTouch(id, entity = "Incident", recordView = "") {
  if (!inExtension) return toast("«Apri in Touch» funziona solo nell'estensione installata", "err");
  const what = entity === "KBArticle" ? "l'articolo KB" : entity === "Faq" ? "la FAQ" : "il ticket";
  toast(`Apro ${what} in HDA TOUCH…`, "info", 1800);
  try {
    const res = await chrome.runtime.sendMessage({ type: "open-in-touch", id, entity, recordView });
    const r = res && res.result;
    if (r === "ok") return;
    if (r === "timeout") toast("Touch non è pronto: esegui l'accesso nella scheda aperta e riprova.", "err", 5000);
    else toast("Non sono riuscito ad aprirlo in Touch (" + r + ").", "err", 5000);
  } catch (e) {
    toast("Errore: " + e.message, "err");
  }
}

function isFavorite(id) { return S.favorites.some((x) => x.id === id); }

function toggleFavorite(id, row) {
  if (isFavorite(id)) S.favorites = S.favorites.filter((x) => x.id !== id);
  else S.favorites.unshift({ id, row: slim(row) || { id }, at: Date.now() });
  kvSet("favorites", S.favorites);
  renderAll();
}

function addRecent(id, row) {
  S.recent = [{ id, row: slim(row) || { id }, at: Date.now() }, ...S.recent.filter((x) => x.id !== id)].slice(0, 60);
  kvSet("recent", S.recent);
}

function saveUi() {
  const { readerSearch, ...keep } = ui;
  kvSet("ui", keep);
}

async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  await kvSet("settings", S.settings);
  if (ar && S.settings.arCentro) ar.setCentre(S.settings.arCentro);
}

// ---------------------------------------------------------------- CSV e archiviazione

function jobBox() {
  const j = S.job;
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  return h("div", { class: "notice", id: "jobBox" },
    h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
      h("span", { style: { flex: "1" } }, `${j.label}: ${j.done} di ${j.total || "?"}${j.skipped ? ` (${j.skipped} già aggiornati)` : ""}${j.errors ? ` · ${j.errors} errori` : ""}`),
      h("button", { class: "btn btn-small", onclick: () => (j.cancelled = true) }, "Annulla")),
    h("div", { class: "progress" }, h("div", { style: { width: pct + "%" } })));
}

function updateJob() {
  const old = document.getElementById("jobBox");
  if (old && S.job) old.replaceWith(jobBox());
  else renderResults();
}

async function fetchAllRows(max, job) {
  const out = [];
  const f = S.activeEffectiveFilters || S.filters;
  const conditions = buildConditions(f, { ...S.calib, singleFullText: true, autoWildcard: S.settings.autoWildcard !== false });
  const size = 200;
  for (let page = 1; out.length < max; page++) {
    if (job && job.cancelled) break;
    const { rows, total } = await hda.listData("Incidents", { conditions, page, start: (page - 1) * size, limit: size, sort: sortSpec() });
    out.push(...rows.map((r) => rowReader.read(r)));
    if (job) { job.total = Math.min(total, max); job.done = out.length; updateJob(); }
    if (!rows.length || out.length >= total) break;
    await sleep(150);
  }
  return out.slice(0, max);
}

async function exportCsv() {
  if (S.job) return;
  const src = S.source;
  const job = (S.job = { label: "Preparo il file Excel", done: 0, total: src === "touch" ? Math.min(S.total, 1000) : 1 });
  renderAll();
  try {
    let rows;
    let cols;
    let filePrefix = "ticket";
    if (src === "kb") {
      rows = filteredRows(S.kbS.results, "kb");
      filePrefix = "knowledge_base";
      cols = [
        ["Codice", (r) => r.code || r.kbId], ["Titolo", (r) => r.subject], ["Stato", (r) => r.statusText],
        ["Tipo", (r) => r.typeText], ["Prodotto", (r) => r.catalog], ["Versione", (r) => r.version],
        ["Argomento", (r) => r.topic], ["Lingua", (r) => r.lang], ["Creato il", (r) => fmtDateTime(r.date)],
        ["Pubblicato il", (r) => fmtDate(r.publishDate)], ["Ultimo operatore", (r) => r.assigned],
      ];
    } else if (src === "faq") {
      rows = filteredRows(S.faqS.results, "faq");
      filePrefix = "faq";
      cols = [
        ["Codice", (r) => r.code || r.faqId], ["Domanda", (r) => r.subject], ["Risposta (estratto)", (r) => r.fullAnswer || r.problem],
        ["Stato", (r) => r.statusText], ["Importanza", (r) => r.importance ?? ""], ["Lingua", (r) => r.lang],
        ["Creata il", (r) => fmtDateTime(r.date)], ["Pubblicata il", (r) => fmtDateTime(r.publishDate)],
        ["Visibile dal", (r) => fmtDateTime(r.visibleFrom)], ["Visibile al", (r) => fmtDateTime(r.visibleTo)],
      ];
    } else {
      rows = src === "ar" ? filteredRows(arRows(), "ar").map(withArNames) : await fetchAllRows(1000, job);
      cols = [
        ["Numero", (r) => ticketNumber(r.id)], ["Oggetto", (r) => r.subject], ["Stato", (r) => statusInfo(r.statusId, r.statusText).label],
        ["Tipo", (r) => r.typeText], ["Priorità", (r) => r.priorityText], ["Cliente", (r) => r.account], ["Codice cliente", (r) => r.customerCode],
        ["Contatto", (r) => r.contact], ["Gruppo owner", (r) => r.ownerGroup], ["Assegnato a", (r) => r.assigned], ["Owner del ticket", (r) => r.ownerUser],
        ["Prodotto", (r) => r.catalog], ["Classificazione", (r) => r.classCli], ["Aperto il", (r) => fmtDateTime(r.date)], ["Ultimo aggiornamento", (r) => fmtDateTime(r.lastChange)],
      ];
    }
    if (job.cancelled) return;
    const lines = [cols.map((c) => csvCell(c[0])).join(";"), ...rows.map((r) => cols.map((c) => csvCell(c[1](r))).join(";"))];
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${filePrefix}_${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`Esportati ${rows.length} elementi`, "ok");
  } catch (e) {
    toast("Esportazione non riuscita: " + e.message, "err", 5000);
  } finally {
    S.job = null;
    renderAll();
  }
}

async function archiveResults() {
  if (S.job) return;
  const cap = Number(S.settings.archiveCap) || 300;
  if (S.total > cap && !confirm(`La ricerca ha ${S.total} ticket: ne archivio i primi ${cap}. Continuo?`)) return;
  const job = (S.job = { label: "Elenco i ticket", done: 0, total: Math.min(S.total, cap), skipped: 0, errors: 0 });
  renderAll();
  try {
    const rows = await fetchAllRows(cap, job);
    if (job.cancelled) return;
    const known = await archivedMap(rows.map((r) => r.id));
    const todo = rows.filter((r) => {
      const k = known.get(r.id);
      const lc = r.lastChange ? r.lastChange.getTime() : null;
      if (k && lc && k.lastChange && k.lastChange >= lc) { job.skipped++; return false; }
      return true;
    });
    Object.assign(job, { label: "Archivio i ticket", done: job.skipped, total: rows.length });
    updateJob();
    await pool(todo, 2, async (row) => {
      if (job.cancelled) return;
      try {
        const full = await loadTicket(hda, row.id, { row, rowReader, conditionsFor: conditionsForId, caps: S.caps, ar, log });
        await saveTicket(full);
        S.archived.set(row.id, { savedAt: Date.now(), lastChange: row.lastChange ? row.lastChange.getTime() : null });
      } catch (e) {
        job.errors++;
        if (e instanceof AuthError) job.cancelled = true;
      }
      job.done++;
      updateJob();
      await sleep(250);
    });
    kvSet("caps", S.caps);
    await refreshArchiveCount();
    toast(job.cancelled ? "Archiviazione interrotta" : `Archiviati ${job.done - job.skipped - job.errors} ticket`, job.errors ? "err" : "ok", 4000);
  } catch (e) {
    toast("Archiviazione non riuscita: " + e.message, "err", 5000);
  } finally {
    S.job = null;
    runArchiveSearch(S.filters.text);
    renderAll();
  }
}

// ---------------------------------------------------------------- tastiera

function moveCursor(delta) {
  const items = [...document.querySelectorAll("#results .item:not([hidden])")];
  if (!items.length) return;
  const at = items.findIndex((n) => Number(n.dataset.i) === S.cursor);
  const el = items[Math.max(0, Math.min(items.length - 1, (at < 0 ? (delta > 0 ? -1 : items.length) : at) + delta))];
  S.cursor = Number(el.dataset.i);
  el.focus();
  el.scrollIntoView({ block: "nearest" });
  openSoon(S.cursor);
}

const openSoon = debounce((i) => {
  const it = visibleItems()[i];
  if (it) openTicket(it.row.id, it.row);
}, 250);

function onKey(e) {
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") {
    if (typing && (t.id === "q" || t.id === "faqQ")) return t.blur();
    if (!$("#reader").hidden && !S.solo) closeReader();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    const box = S.source === "faq" ? $("#faqQ") : $("#q");
    if (box) { box.focus(); box.select(); }
  }
  else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveCursor(1); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); moveCursor(-1); }
  else if (e.key === "Enter" && t.classList && t.classList.contains("item")) t.click();
}

// ---------------------------------------------------------------- tema scuro / chiaro (blu)

function applyTheme(theme) {
  const mode = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem("ricerca_tkt_theme", mode); } catch { /* */ }
  const isLight = mode === "light";
  const nextLabel = isLight ? "Tema scuro" : "Tema chiaro";
  const icoName = isLight ? "moon" : "sun";
  for (const id of ["#themeBtn", "#soloThemeBtn"]) {
    const btn = $(id);
    if (!btn) continue;
    clear(btn);
    btn.appendChild(icon(icoName));
    btn.appendChild(h("span", null, nextLabel));
    btn.title = isLight ? "Passa al tema scuro (blu notte)" : "Passa al tema chiaro (bianco e blu)";
  }
}

async function setTheme(theme) {
  const mode = theme === "light" ? "light" : "dark";
  applyTheme(mode);
  await saveSettings({ theme: mode });
}

async function toggleTheme() {
  const next = (S.settings.theme || document.documentElement.dataset.theme || "dark") === "light" ? "dark" : "light";
  await setTheme(next);
}

// ---------------------------------------------------------------- aggiornamenti automatici

function bgMsg(msg) {
  if (!inExtension) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp);
    });
  });
}

function renderUpdateChrome() {
  const st = S.updater;
  const verEl = $("#navVer");
  const diagBtn = $("#diagBtn");
  const bar = $("#updateBar");
  const lc = st && st.lastCheck;
  const hasUpd = !!(lc && lc.status === "update_available");

  if (verEl) {
    const curVer = (st && st.currentVersion) || (inExtension ? chrome.runtime.getManifest().version : "5.2.1");
    verEl.textContent = hasUpd ? `↑ v${lc.remoteVersion}` : `v${curVer}`;
  }
  if (diagBtn) diagBtn.classList.toggle("has-update", hasUpd);

  if (!bar) return;
  if (!hasUpd || S.updateBarDismissed || S.solo) {
    bar.hidden = true;
    clear(bar);
    return;
  }
  clear(bar);
  const helperReady = !!(st.helper && st.helper.available);
  const msg = h("div", { class: "upd-msg" },
    h("b", null, `Nuova versione disponibile: v${lc.remoteVersion}`),
    lc.commitMessage ? ` — ${lc.commitMessage}` : "");
  const actions = h("div", { class: "upd-actions" });
  if (helperReady) {
    const btn = h("button", {
      type: "button",
      class: "btn btn-small btn-primary",
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = "Aggiornamento…";
        try {
          const r = await applyUpdate();
          if (r && r.ok) toast(`Aggiornata alla v${r.version}! Riavvio automatico…`, "ok", 5000);
          else {
            toast((r && r.error) || "Aggiornamento non riuscito", "err", 6000);
            btn.disabled = false;
            btn.textContent = "Aggiorna ora";
          }
        } catch (e) {
          toast("Errore aggiornamento: " + e.message, "err", 5000);
          btn.disabled = false;
          btn.textContent = "Aggiorna ora";
        }
      },
    }, icon("download"), "Aggiorna ora");
    actions.appendChild(btn);
  } else {
    actions.appendChild(
      h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => openDiag(ctx, { focusUpdates: true }) },
        icon("update"), "Attiva aggiornamento automatico"),
    );
  }
  actions.appendChild(
    h("button", { type: "button", class: "btn btn-small btn-icon btn-subtle", title: "Nascondi avviso", onclick: () => { S.updateBarDismissed = true; renderUpdateChrome(); } }, icon("close")),
  );
  bar.appendChild(msg);
  bar.appendChild(actions);
  bar.hidden = false;
}

async function getUpdateStatus(pingHelper = false) {
  if (!inExtension) return null;
  const st = await bgMsg({ type: "updater:status", pingHelper });
  if (st && !st.error) {
    S.updater = st;
    renderUpdateChrome();
  }
  return st;
}

async function checkUpdates(autoApply = false) {
  if (!inExtension) return null;
  const st = await bgMsg({ type: "updater:check", autoApply });
  if (st && !st.error) {
    S.updater = st;
    S.updateBarDismissed = false;
    renderUpdateChrome();
  }
  return st;
}

async function applyUpdate() {
  if (!inExtension) return { ok: false, error: "Disponibile solo nell'estensione." };
  return bgMsg({ type: "updater:apply", reopenApp: true });
}

async function saveUpdaterConfig(config) {
  if (!inExtension) return null;
  const st = await bgMsg({ type: "updater:set-config", config });
  if (st && !st.error) {
    S.updater = st;
    renderUpdateChrome();
  }
  return st;
}

async function reloadExtension() {
  if (!inExtension) return;
  toast("Ricarico l'estensione…", "info", 2000);
  await bgMsg({ type: "updater:reload" });
}

async function initUpdates() {
  renderUpdateChrome();
  if (!inExtension) return;
  try {
    const just = await bgMsg({ type: "updater:consume-just-updated" });
    if (just && just.to) {
      toast(`Ricerca TKT aggiornata automaticamente alla v${just.to}!`, "ok", 5500);
      log(`aggiornamento completato: v${just.from} → v${just.to}`);
    }
    const st = await getUpdateStatus(false);
    const stale = !st || !st.lastCheck || !st.lastCheck.checkedAt || Date.now() - st.lastCheck.checkedAt > 3600_000;
    if (st && st.config && st.config.autoCheck !== false && stale) {
      checkUpdates(false).catch(() => {});
    }
  } catch (e) {
    log("updater: " + e.message);
  }
}

// ---------------------------------------------------------------- avvio

async function init() {
  const [settings, savedUi, sort, saved, favorites, recent, learned, captures, caps, typesSeen, touchLang, transportMode, stLookups] = await Promise.all([
    kvGet("settings", null), kvGet("ui", null), kvGet("sort", null), kvGet("saved", []),
    kvGet("favorites", []), kvGet("recent", []), kvGet("learned", {}), kvGet("captures", []), kvGet("caps", {}), kvGet("typesSeen", {}),
    kvGet("touchLang", null), kvGet("transportMode", null), kvGet("stLookups", null),
  ]);
  if (stLookups) S.stLookups = { groups: stLookups.groups || {}, operators: stLookups.operators || {}, clients: stLookups.clients || {} };
  Object.assign(S.settings, settings || {});
  applyTheme(S.settings.theme);
  Object.assign(ui, savedUi || {});
  ui.openSections = ui.openSections || {};
  if (sort && SORTS[sort.key]) S.sort = sort;
  Object.assign(S, { saved: saved || [], favorites: favorites || [], recent: recent || [], captures: captures || [], caps: caps || {}, typesSeen: typesSeen || {} });
  S.calib.learned = learned || {};
  if (S.caps.containsText && S.caps.containsText.wildcard) S.calib.containsText = S.caps.containsText;
  if (S.caps.fullTextRule) S.calib.overrides.text = { ...S.caps.fullTextRule, source: "calibrato" };

  transport = makeTransport({
    log,
    mode: transportMode === "proxy" ? "proxy" : "direct",
    onModeChange: (m) => {
      kvSet("transportMode", m);
      if (S.connected === true) setConn(true, `HDA Touch${m === "proxy" ? " (scheda)" : ""}`);
    },
  });
  hda = makeHda(transport, { lang: portalLang(S.settings, touchLang) });
  ar = makeAr({ log });
  storico = makeStorico({ log, request: (path, o) => ar.request(path, o), centro: () => ar.state.idCenSer || S.caps.arCentro || "" });
  kb = makeKb({ hda, log });
  faq = makeFaq({ hda, log });

  const openReq = readOpenRequest();
  if (openReq) enterSolo();
  lookups = makeLookups(hda, { kvGet, kvSet, log });
  await lookups.restore();
  refreshArchiveCount();

  onKvChange((ch) => {
    if (ch.settings && ch.settings.newValue && ch.settings.newValue.theme) {
      S.settings.theme = ch.settings.newValue.theme;
      applyTheme(S.settings.theme);
    }
    if (ch.touchLang && ch.touchLang.newValue) {
      const l = portalLang(S.settings, ch.touchLang.newValue);
      if (l !== hda.lang) hda.setLang(l);
    }
    if (ch.learned) S.calib.learned = ch.learned.newValue || {};
    if (ch.captures) S.captures = ch.captures.newValue || [];
    if (ch.learned || ch.captures) refreshSidebar();
    if (ch.recent) S.recent = ch.recent.newValue || [];
    if (ch.favorites) S.favorites = ch.favorites.newValue || [];
    if (ch.recent || ch.favorites) renderAll();
  });

  $("#layout").classList.toggle("nofilters", !ui.showFilters);
  syncSearchBoxes();
  renderSidebar(ctx);
  renderAll();
  initUpdates();

  // Barra ricerca principale (NON cerca mai nelle FAQ)
  const onSearchInput = debounce(() => {
    const v = $("#q").value.trim();
    if (v && v.length < 3 && !ticketIdFrom(v) && !kbCodeFrom(v)) return;
    if (v !== S.filters.text) {
      S.filters.text = v;
      if (S.view !== "archive") S.view = "results";
      if (S.source === "storico") { S.source = "touch"; renderSidebar(ctx); }
      filtersChanged(true);
    }
  }, 650);
  $("#q").addEventListener("input", onSearchInput);
  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    onSearchInput.cancel();
    S.filters.text = $("#q").value.trim();
    if (S.view !== "archive") S.view = "results";
    if (S.source === "storico") { S.source = "touch"; renderSidebar(ctx); }
    filtersChanged(true);
  });

  // Barra ricerca dedicata FAQ (cerca insieme in Domanda e Risposta con varianti e attinenza)
  const onFaqInput = debounce(() => {
    const v = $("#faqQ").value.trim();
    if (v !== S.faqS.filters.query) {
      S.view = "results";
      faqSetFilter("query", v);
    }
  }, 320);
  $("#faqQ").addEventListener("input", onFaqInput);
  $("#faqSearchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    onFaqInput.cancel();
    S.view = "results";
    S.faqS.filters.query = $("#faqQ").value.trim();
    runFaq({ fresh: true });
    renderAll();
  });

  $("#filterToggle").addEventListener("click", toggleFilters);
  $("#conn").addEventListener("click", () => { if (S.connected === false) openTouchHome(); });
  $("#arConn").addEventListener("click", () => openArHome());
  $("#themeBtn").addEventListener("click", toggleTheme);
  const soloThemeBtn = $("#soloThemeBtn");
  if (soloThemeBtn) soloThemeBtn.addEventListener("click", toggleTheme);
  $("#diagBtn").addEventListener("click", () => openDiag(ctx));
  const soloDiagBtn = $("#soloDiagBtn");
  if (soloDiagBtn) soloDiagBtn.addEventListener("click", () => openDiag(ctx));
  const soloBack = $("#soloBack");
  if (soloBack) soloBack.addEventListener("click", () => { leaveSolo(); const b = $("#q"); if (b) b.focus(); });

  $("#sidebar").addEventListener("focusout", (e) => {
    if (pendingSidebar && !(e.relatedTarget && $("#sidebar").contains(e.relatedTarget))) setTimeout(refreshSidebar, 0);
  });
  document.addEventListener("keydown", onKey);

  let calibrated = false;
  const start = async () => {
    if (!calibrated) {
      calibrated = true;
      await reloadCalibration();
      refreshSidebar();
    }
    const p = search();
    const m = /[#&]t=(\d{5,10})/.exec(location.hash);
    if (S.solo && openReq) await openTicket(openReq.id, openReq.row, { force: true });
    else if (m) await openTicket(m[1], null);
    await p;
  };

  window.addEventListener("focus", async () => {
    if (S.connected === false && (await checkConnection())) start();
    else if (S.arConnected !== true && (await checkArConnection())) {
      if (S.current && isLegacyTicketNumber(S.current)) openTicket(S.current, null, { force: true });
      else if (arQuery()) runAr({ fresh: true });
      if (S.storico.error) runStorico({ fresh: true });
    }
  });

  if (await checkConnection()) {
    await start();
  } else {
    if (!S.error) S.error = new AuthError();
    renderAll();
    if (S.solo && openReq) openTicket(openReq.id, openReq.row, { force: true });
  }
}

await init().catch((e) => {
  log("avvio: " + e.message);
  document.getElementById("results").appendChild(h("div", { class: "err-box" }, "Errore all'avvio: " + e.message));
});
