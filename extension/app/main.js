// Ricerca TKT — app principale (pagina dell'estensione).
//
// Tiene lo stato (filtri, risultati, ticket aperto), parla con il portale tramite lib/hda.js
// e coordina i tre pannelli: filtri (sidebar.js), risultati (qui), lettore (reader.js).

import { h, clear, $, highlight, toast, icon } from "./dom.js";
import { renderSidebar } from "./sidebar.js";
import { renderReader, renderReaderLoading, renderReaderError } from "./reader.js";
import { openDiag } from "./diag.js";
import { makeTransport, AuthError, PORTAL_BASE } from "../lib/transport.js";
import { makeHda } from "../lib/hda.js";
import { makeAr, emptyArFilters, hasArFilter } from "../lib/ar.js";
import { sortByRelevance, matchesAllTerms, bestSnippet, searchTerms, highlightPatterns, listFilter } from "../lib/relevance.js";
import { makeStorico, emptyStoricoFilters, hasStoricoFilter, enrichArTicket, movePeople } from "../lib/storico.js";
import { makeRowReader } from "../lib/rows.js";
import { emptyFilters, buildConditions, describeFilters, ruleFor, DEF, DOMAIN_CONDITION, OPEN_STATUS_IDS, FILTER_DEFS, isEmptyFilter, isUnconstrained, hasNarrowingFilter } from "../lib/filters.js";
import { statusInfo, mergePortalStatuses } from "../lib/statuses.js";
import { loadTicket, TICKET_COLUMNS } from "../lib/ticket.js";
import { saveTicket, getTicket, searchArchive, archivedMap, archiveInfo, kvGet, kvSet, onKvChange, reviveRow } from "../lib/store.js";
import { makeLookups } from "../lib/lookups.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "../lib/richtext.js";
import { ticketIdFrom, ticketIdVariants, ticketNumber, isLegacyTicketNumber, isTouchNativeId, ticketMergeKey, fmtRelative, fmtDateTime, tokens, queryTerms, pool, sleep, csvCell, debounce } from "../lib/util.js";

const inExtension = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
const DAY = 86400000;
// portalLang "auto": la stessa lingua (_pl) che usa la pagina di Touch (registrata dal service worker)
const DEFAULT_SETTINGS = { pageSize: 50, portalLang: "auto", archiveOnRead: true, archiveCap: 300, arCentro: "" };

function portalLang(settings, touchLang) {
  const chosen = settings && settings.portalLang;
  if (chosen && chosen !== "auto") return chosen;
  return touchLang || "it";
}
const SORTS = {
  // attinenza: calcolata qui sulle parole cercate; al portale i ticket si chiedono dal più recente
  relevance: { label: "Attinenza", field: "date", fb: "c20" },
  date: { label: "Data di apertura", field: "date", fb: "c20" },
  lastChange: { label: "Ultimo aggiornamento", field: "lastChange", fb: "c26" },
  id: { label: "Numero ticket", field: "id", fb: "c23" },
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
  filters: emptyFilters(),
  activeEffectiveFilters: null,
  sort: { key: "date", dir: "DESC" },
  results: [],
  total: 0,
  page: 1,
  loading: false,
  pending: new Set(),
  error: null,
  notices: [],
  tab: "touch", // touch | ar | storico (le tre fonti) | archive | favorites | recent
  touchTotal: 0,
  // Vecchio Cruscotto: ricerca a sé, con i suoi filtri (quelli della Ricerca rapida dell'Area Riservata)
  arS: { filters: emptyArFilters(), results: [], loading: false, error: null, key: "", at: 0, notices: [] },
  storico: { filters: emptyStoricoFilters(), results: [], total: 0, loading: false, error: null, key: "" },
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
  settings: { ...DEFAULT_SETTINGS },
};
const ui = { openSections: {}, statusDetail: false, showInternal: true, newestFirst: false, readerSearch: "", showFilters: true };
// «Filtra in elenco»: per scheda, vale finché non si fa una nuova ricerca dalla casella in alto
const listFilters = { touch: "", ar: "", storico: "" };

let transport, hda, ar, storico, lookups;
let rowReader = makeRowReader(null);
let searchAbort = null;
let openSeq = 0;

const ctx = {
  S,
  ui,
  get hda() { return hda; },
  get ar() { return ar; },
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
  reloadCalibration,
  refreshArchiveCount,
  storicoSetFilter,
  storicoReset,
  storicoLookup,
  arSetFilter,
  arReset,
  arCentre: () => (ar && ar.state.idCenSer) || S.caps.arCentro || "",
};

// ---------------------------------------------------------------- utilità

/** Riga senza dati grezzi, date in millisecondi (per salvarla) */
function slim(row) {
  if (!row) return null;
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "raw") continue;
    o[k] = v instanceof Date ? v.getTime() : v;
  }
  return o;
}

/** Le parole cercate su cui si misura l'attinenza: quelle della casella in alto (non un numero ticket) e dell'oggetto. */
function rankQuery() {
  const text = String(S.filters.text || "").trim();
  return [ticketIdFrom(text) ? "" : text, S.filters.subject || ""].join(" ").trim();
}
const byRelevance = () => S.sort.key === "relevance" && searchTerms(rankQuery()).length > 0;

/** Estratto del ticket per l'elenco: con delle parole cercate, il punto del testo dove compaiono. */
const SNIPPETS = new WeakMap();
function snippetOf(row) {
  if (!row) return "";
  const q = rankQuery();
  const hit = SNIPPETS.get(row);
  if (hit && hit.q === q) return hit.s;
  const p = row.problem ? String(row.problem) : "";
  let t = p ? (isProbablyHtml(unescapeIfEscapedHtml(p)) ? htmlToText(p) : cleanText(p)).replace(/\s+/g, " ").trim() : "";
  if (q) {
    // il riepilogo non contiene tutte le parole ma il testo dei messaggi sì: l'estratto si prende da lì
    if (row.fullText && !matchesAllTerms(t, q)) t = cleanText(String(row.fullText).replace(/  +/g, " — "));
    t = bestSnippet(t, q, 300);
  } else t = t.slice(0, 300);
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
  closeReader();
  S.filters.text = "";
  S.filters.subject = clean;
  filtersChanged(true);
}

// ---------------------------------------------------------------- connessione

function setConn(state, text) {
  S.connected = state;
  const el = $("#conn");
  el.classList.toggle("ok", state === true);
  el.classList.toggle("err", state === false);
  $(".conn-text", el).textContent = text || (state ? "Connesso a Touch" : state === false ? "Touch non connesso — clicca per aprirlo" : "Verifica…");
  el.title = state === false ? "Apri HDA TOUCH ed esegui l'accesso, poi torna qui" : "Stato della connessione a HDA TOUCH";
}

function setArConn(state, text) {
  S.arConnected = state;
  const el = $("#arConn");
  if (!el) return;
  el.classList.toggle("ok", state === true);
  el.classList.toggle("err", false);
  $(".conn-text", el).textContent = text || (state === true ? "Vecchio cruscotto attivo" : "Collega vecchio cruscotto");
  el.title =
    state === true
      ? "Vecchio Cruscotto (Area Riservata Zucchetti) collegato: cerca e apre anche i ticket storici a 7 cifre"
      : "Clicca per aprire il Vecchio Cruscotto (Area Riservata Zucchetti) ed eseguire l'accesso: potrai cercare e leggere qui i ticket storici a 7 cifre";
}

async function checkArConnection() {
  if (!ar) return false;
  try {
    const st = await ar.checkStatus();
    setArConn(st.connected === true);
    if (st.connected) {
      log(`vecchio cruscotto collegato (${st.mode}${st.idCenSer ? ", centro " + st.idCenSer : ", centro non ancora noto"})`);
      // il centro servizi (e i nomi di operatori e gruppi) si cercano subito, senza aspettare la prima ricerca
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
    // GetStaticList risponde in ~150 ms (contro i 7-15 s di una query su Incident senza filtri),
    // verifica la sessione, estrae l'ID dell'operatore dal requestToken e carica gli stati del portale.
    const st = await hda.staticList("TicketStatuses");
    mergePortalStatuses(st);
    statusesLoaded = true;
    setConn(true, `Connesso a Touch${transport.mode === "proxy" ? " (tramite scheda)" : ""}`);
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
    return true;
  } catch (e) {
    log("connessione: " + e.message);
    setConn(false, e instanceof AuthError ? null : "Touch non raggiungibile — clicca per aprirlo");
    // il motivo si vede anche nell'elenco (prima restava solo nella Diagnostica)
    S.error = e;
    renderResults();
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
        log("filtri Touch: " + cfg.filters.map((f) => `${f.itemId}=${f.property || f.name || "?"}/${f.op || "?"}${f.extKey ? "[" + f.extKey + "]" : ""}`).join(", "));
      } else {
        log(`configurazione elenco senza mappa colonne (${cfg.size} caratteri): uso la mappa di riserva`);
      }
    } catch (e) {
      log("configurazione elenco: " + e.message + " (uso la mappa di riserva)");
    }
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

/** Se la mappa delle colonne non torna con i dati veri, si torna a quella di riserva */
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
  // ultima risorsa: si cerca la colonna dell'ID
  const k = Object.keys(rawRows[0]).find((c) => /^\d{6,}Z$/.test(String(rawRows[0][c])));
  if (k) {
    log(`colonna ID trovata in ${k}`);
    const base = fb;
    rowReader = { ...base, read: (raw) => ({ ...base.read(raw), id: raw[k] }) };
  }
}

// ---------------------------------------------------------------- filtri

let pendingSidebar = false;
function refreshSidebar() {
  const a = document.activeElement;
  const sb = $("#sidebar");
  // non si ridisegna mentre si scrive in una casella dei filtri (si perderebbe il cursore)
  if (a && sb.contains(a) && a.tagName === "INPUT" && /^(text|search|date)$/.test(a.type)) {
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
  syncSearchBox();
  if (immediate) search();
  else {
    S.loading = true;
    renderResults();
    searchSoon();
  }
}

/**
 * Un numero ticket nella casella di ricerca porta dritto a quel ticket e ignora tutti gli altri filtri:
 * quando si sceglie un filtro a sinistra (gruppo, stato, cliente…) il numero rimasto da una ricerca
 * precedente si toglie, altrimenti si vedrebbero sempre e solo i ticket con quel numero.
 */
function dropTicketNumberFor(keys) {
  const tid = ticketIdFrom(S.filters.text);
  if (!tid || !keys.some((k) => k !== "text" && !isEmptyFilter(S.filters[k]))) return;
  S.filters.text = "";
  const q = $("#q");
  if (q) q.value = "";
  toast(`Tolto il numero ${ticketNumber(tid)} dalla casella di ricerca: ora vedi i ticket dei filtri scelti.`, "info", 4000);
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

function syncSearchBox() {
  const q = $("#q");
  if (document.activeElement !== q) q.value = S.filters.text || "";
}

function applySaved(i) {
  const s = S.saved[i];
  if (!s) return;
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

// ---------------------------------------------------------------- ricerca

function fallbackToSubject(f) {
  return { ...f, text: "", subject: [f.subject, f.text].filter(Boolean).join(" ") };
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

/**
 * Unisce in un unico elenco i risultati di HDA TOUCH e del Vecchio Cruscotto senza doppioni.
 * I ticket nativi di Touch (con la "Z", es. 9876543Z) restano sempre distinti dai ticket del Vecchio Cruscotto
 * con le stesse cifre (es. 9876543): sono due ticket diversi. Un ticket di Touch senza "Z" (migrato dal
 * Vecchio Cruscotto) che compare anche nel Vecchio Cruscotto diventa una riga sola: resta quella di Touch,
 * arricchita con i dati del Vecchio Cruscotto (testo completo indicizzato da Solr, indirizzo della scheda).
 */
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

function sortUnifiedRows(rows, exactNum = "") {
  if (!rows || rows.length <= 1) return rows || [];
  if (byRelevance() && !exactNum) return sortByRelevance(rows, rankQuery());
  // «Attinenza» senza parole cercate: dal più recente
  const key = S.sort && S.sort.key && S.sort.key !== "relevance" ? S.sort.key : "date";
  const desc = !S.sort || S.sort.dir !== "ASC" || S.sort.key === "relevance";
  const dir = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (exactNum) {
      const aEx = ticketNumber(a.id) === exactNum ? 1 : 0;
      const bEx = ticketNumber(b.id) === exactNum ? 1 : 0;
      if (aEx !== bEx) return bEx - aEx;
    }
    if (key === "id") {
      const na = Number(ticketNumber(a.id)) || 0;
      const nb = Number(ticketNumber(b.id)) || 0;
      if (na !== nb) return (na - nb) * dir;
    } else {
      const da = a[key] instanceof Date ? a[key].getTime() : a.date instanceof Date ? a.date.getTime() : 0;
      const db = b[key] instanceof Date ? b[key].getTime() : b.date instanceof Date ? b.date.getTime() : 0;
      if (da !== db) return (da - db) * dir;
    }
    return 0;
  });
}

/**
 * Verifica che ogni ticket restituito da HDA TOUCH contenga TUTTE le parole cercate (in AND).
 * Se una parola non compare già in Oggetto o Richiesta iniziale (`problem`), legge i messaggi dei ticket
 * (`TicketConversationItem`, a gruppi di 40) per verificare che compaia nella conversazione.
 */
async function verifyTouchRowsAllWords(rows, f) {
  if (!rows || !rows.length) return [];
  const subjWords = queryTerms(f.subject || "");
  let candidates = rows;
  if (subjWords.length > 1) {
    candidates = candidates.filter((r) => matchesAllTerms(r.subject || "", subjWords));
  }
  const tid = ticketIdFrom(f.text);
  const textWords = tid ? [] : queryTerms(f.text || "");
  if (textWords.length <= 1) return candidates;

  const confirmedIds = new Set();
  const needConvCheck = [];
  for (const r of candidates) {
    const hay = `${r.subject || ""} ${r.problem || ""} ${r.catalog || ""} ${r.account || ""}`;
    if (matchesAllTerms(hay, textWords)) {
      confirmedIds.add(r.id);
    } else {
      needConvCheck.push(r);
    }
  }

  if (needConvCheck.length && hda) {
    // Tutti i candidati, a gruppi (prima si guardavano solo i primi 60 e gli altri sparivano dall'elenco).
    // Se i messaggi non si possono leggere tutti (errore o limite di righe raggiunto) il ticket resta:
    // il portale l'ha già trovato con la parola principale, meglio un ticket in più che uno perso.
    const batches = [];
    for (let i = 0; i < needConvCheck.length; i += CONV_CHECK_BATCH) batches.push(needConvCheck.slice(i, i + CONV_CHECK_BATCH));
    await pool(batches, 2, async (batch) => {
      let convRows;
      try {
        convRows = await hda.projection(
          "TicketConversationItem",
          [{ property: "TicketID", op: "in", value: batch.map((r) => r.id).join("|") }],
          ["TicketID", "Text"],
          CONV_CHECK_LIMIT,
        );
      } catch (e) {
        log(`verifica parole conversazione: ${e.message} (tengo i ${batch.length} ticket trovati dal portale)`);
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
        const fullHay = `${r.subject || ""} ${r.problem || ""} ${r.catalog || ""} ${r.account || ""} ${msgs.join(" ")}`;
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

// Risultati recenti in memoria: rifare una ricerca appena fatta (tornare indietro, togliere e rimettere
// un filtro, cancellare una lettera) è immediato. «Aggiorna» e «Riprova» rifanno sempre la ricerca.
const RESULT_CACHE = new Map();
const RESULT_CACHE_TTL = 2 * 60 * 1000;

function resultCacheKey(f, size) {
  return JSON.stringify([f, S.sort, size, S.arConnected === true]);
}

function cacheGet(key) {
  const hit = RESULT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_CACHE_TTL) {
    RESULT_CACHE.delete(key);
    return null;
  }
  return hit;
}

function cachePut(key, entry) {
  RESULT_CACHE.delete(key);
  RESULT_CACHE.set(key, { ...entry, at: Date.now() });
  while (RESULT_CACHE.size > 25) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
}

/**
 * Il ticket da aprire da solo dopo una ricerca per numero.
 * Prima la forma scritta (es. "9876543" → ticket senza Z, "9876543Z" o 8 cifre → ticket nativo di Touch),
 * poi l'altra variante di Touch, poi il Vecchio Cruscotto. Con la "Z" scritta, mai il Vecchio Cruscotto.
 */
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

/** Quando lo stesso numero corrisponde a più ticket diversi (Touch con Z, Touch migrato, Vecchio Cruscotto) lo si dice. */
function sameNumberNotice(rows, tid) {
  const num = ticketNumber(tid);
  const exact = (rows || []).filter((r) => ticketNumber(r.id) === num);
  if (exact.length < 2) return null;
  const labels = exact.map((r) => (r.source === "ar" ? `#${num} del Vecchio Cruscotto` : `${r.id} di HDA TOUCH`));
  return `Il numero ${num} corrisponde a ${exact.length} ticket diversi (${labels.join(", ")}): ognuno è nella scheda della sua fonte.`;
}

/** Testo nella casella + filtri: si cercano le parole SOLO nei ticket dei filtri. Lo si dice, con il modo per toglierlo. */
function textNarrowsNotice(f) {
  const what = describeFilters({ ...f, text: "" }).map((c) => c.label).join(", ");
  return {
    text: `Cerco «${f.text}» solo tra i ticket con ${what}. Per vedere tutti i ticket di questi filtri togli il testo dalla casella di ricerca.`,
    action: () => clearFilterKey("text"),
    actionLabel: "Togli il testo",
  };
}

async function search({ more = false, fresh = false } = {}) {
  if (!hda) return;
  if (searchAbort) searchAbort.abort();
  const ac = new AbortController();
  searchAbort = ac;

  // Se l'utente ha scritto nella casella #q senza premere Invio e ha cliccato Riprova / Aggiorna, sincronizziamo subito il testo.
  const qEl = $("#q");
  if (qEl && !more && qEl.value.trim() !== S.filters.text) {
    S.filters.text = qEl.value.trim();
    refreshSidebar();
  }

  const f = S.filters;
  // solo una nuova ricerca dalla casella in alto può far passare da sola alla scheda che ha trovato qualcosa
  if (!more && f.text !== lastBoxText) {
    lastBoxText = f.text;
    pickPending = !!String(f.text || "").trim(); // casella vuota (anche all'avvio): si resta sulla scheda aperta
    listFilters.touch = listFilters.ar = listFilters.storico = "";
  }
  const size = Number(S.settings.pageSize) || 50;
  const tid = ticketIdFrom(f.text);
  const typedZ = !!tid && /z$/i.test(String(f.text || "").trim());
  const isLegacyNum = !!tid && isLegacyTicketNumber(f.text);
  const textWords = tid ? [] : queryTerms(f.text || "");
  const subjWords = queryTerms(f.subject || "");
  const multiWord = textWords.length > 1 || subjWords.length > 1;
  // Con più parole (verificate qui) o con l'ordinamento per attinenza si chiedono più ticket insieme: almeno 150,
  // in pagine intere, così «Mostra altri» riparte dal punto giusto.
  const wide = !more && (multiWord || (S.sort.key === "relevance" && textWords.length > 0));
  const fetchLimit = wide ? size * Math.ceil(150 / size) : size;

  // stessa ricerca fatta da poco: risultati subito dalla memoria
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
      stCached.then(() => { autoPickTab(); renderResults(); });
      S.notices = [...hit.notices];
      S.activeEffectiveFilters = hit.eff;
      runArchiveSearch(f.text);
      log(`ricerca dalla memoria: ${hit.results.length} ticket`);
      autoPickTab();
      renderResults();
      if (tid) {
        arCached.then((arFound) => {
          if (S.filters.text !== f.text || searchAbort !== ac) return;
          const exact = pickExactTicket(mergeRowLists(hit.results, arFound || []), f.text);
          if (exact) return openFound(exact);
          // il ticket c'è solo nello Storico: si apre da lì, come alla prima ricerca
          stCached.then((rows) => {
            const st = (rows || []).find((r) => r.id === ticketNumber(tid));
            if (st && S.filters.text === f.text && searchAbort === ac) openFound(st);
          });
        });
      }
      return;
    }
  }

  // lo Storico cerca per conto suo (numero della casella o i suoi filtri): non rallenta le altre due fonti
  const storicoPromise = more ? Promise.resolve(S.storico.results) : runStorico({ fresh });
  // anche il Vecchio Cruscotto: parole o numero della casella in alto più i suoi filtri
  const arPromise = more ? Promise.resolve(S.arS.results) : runAr({ fresh });
  if (!more) {
    S.page = 1;
    S.results = [];
    S.total = 0;
    S.touchTotal = 0;
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
  renderResults();
  const t0 = Date.now();

  /** Segna una fonte come "in corso" finché la sua promessa non finisce (per l'indicatore sotto l'elenco). */
  const track = (label, p) => {
    pend.add(label);
    const done = () => {
      pend.delete(label);
      if (!ac.signal.aborted && S.loading) renderResults();
    };
    return p.then(
      (v) => (done(), v),
      (e) => {
        done();
        throw e;
      },
    );
  };

  // Risultati mostrati man mano che arrivano le singole fonti (Touch per numero/oggetto/messaggi, Vecchio Cruscotto)
  const parts = new Map();
  const exactNum = tid ? ticketNumber(tid) : "";
  const show = (name, rows) => {
    parts.set(name, rows || []);
    if (ac.signal.aborted || more) return;
    S.results = sortUnifiedRows(mergeRowLists(...parts.values()), exactNum);
    S.total = S.results.length;
    renderResults();
  };

  const calibForSearch = { ...S.calib, primaryTermOnly: true };

  const run = (filters, customLimit = fetchLimit, signal = ac.signal) =>
    hda.listData("Incidents", {
      conditions: buildConditions(filters, calibForSearch),
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

  let touchIdle = false; // vero se a Touch non si è chiesto niente
  try {
    let rows = [];
    let total = 0;
    let touchTotal = 0; // quanti ticket ha in tutto Touch per questa ricerca (per «Mostra altri»)

    if (more && S.activeEffectiveFilters) {
      const res = await run(S.activeEffectiveFilters, size);
      if (ac.signal.aborted) return;
      rows = await verifyTouchRowsAllWords(readRawRows(res.rows), f);
      total = res.total;
      touchTotal = res.total || 0;
    } else if (isUnconstrained(f)) {
      // Senza parole né filtri in HDA Touch non si cerca niente: l'elenco parte solo quando l'operatore chiede qualcosa
      // (prima qui si caricavano da soli tutti i ticket aperti del portale).
      touchIdle = true;
      S.activeEffectiveFilters = null;
    } else if (f.text && !tid) {
      // Ricerca nei messaggi sempre attiva. In parallelo:
      //  1) FullText/eq[INCLUDECONVERSATIONITEM] su HDA TOUCH (cerca dentro i messaggi delle conversazioni e nell'oggetto)
      //  2) Subject su HDA TOUCH (veloce: mostra subito i primi risultati mentre FullText completa la scansione dei messaggi)
      // Ogni ricerca compare nell'elenco appena risponde. (Il Vecchio Cruscotto cerca per conto suo, nella sua scheda.)
      parts.set("ft", []);
      parts.set("sub", []);
      const subF = fallbackToSubject(f);
      // La ricerca sull'oggetto serve solo a mostrare presto i primi risultati: quando quella nei messaggi
      // (che copre anche l'oggetto) ha risposto su tutto lo storico, non la si aspetta più (su tutto lo
      // storico l'oggetto "a metà parola" può arrivare al timeout di 25 s).
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
            const r = await run(f, fetchLimit);
            S.activeEffectiveFilters = f;
            return { rows: await verifyTouchRowsAllWords(readRawRows(r.rows), f), total: r.total, complete: true };
          } catch (e) {
            if (e instanceof AuthError || e.name === "AbortError") throw e;
            log(`FullText su tutto lo storico (${e.message}): riprovo sugli ultimi 24 mesi / aperti`);
            // Se SQL Server supera i 25s su 10 anni senza filtri, restringiamo automaticamente FullText agli ultimi 24 mesi (o agli aperti)
            const recentF = !f.dateFrom ? { ...f, dateFrom: twoYearsAgoDate() } : { ...f, statuses: OPEN_STATUS_IDS };
            try {
              const r2 = await run(recentF, fetchLimit);
              S.activeEffectiveFilters = recentF;
              S.notices.push(
                !f.dateFrom
                  ? "La ricerca nei messaggi su tutto lo storico ha superato il limite di 25 secondi del portale: i messaggi sono cercati negli ultimi 24 mesi (gli oggetti su tutto lo storico)."
                  : "La ricerca nei messaggi ha superato il limite di 25 secondi del portale: i messaggi sono cercati nei ticket aperti."
              );
              return { rows: await verifyTouchRowsAllWords(readRawRows(r2.rows), f), total: r2.total };
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
      rows = sortUnifiedRows(mergeRowLists(ftRes.rows, subRows));
      total = multiWord ? rows.length : Math.max(ftRes.total || 0, rows.length);
      touchTotal = multiWord ? 0 : ftRes.total || 0;
      if (hasNarrowingFilter(f) && rows.length < size) S.notices.push(textNarrowsNotice(f));
    } else if (tid) {
      // Ricerca per numero ticket: su HDA TOUCH tutte le varianti dell'ID in parallelo (es. "9876543" e "9876543Z",
      // "11943797Z" e "11943797"), nel Vecchio Cruscotto il numero (NumTic), su Touch i ticket che citano il numero
      // vecchio nell'oggetto. Il ticket esatto si apre appena Touch e il Vecchio Cruscotto hanno risposto.
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
        ? track(
            "riferimenti in Touch",
            run({ ...f, text: "", subject: ticketNumber(tid) }, 20)
              .then((r) => readRawRows(r.rows))
              .catch(() => []),
          )
        : Promise.resolve([]);
      refPromise.then((r) => show("ref", r));

      const idRows = await idPromise;
      // il Vecchio Cruscotto risponde di solito in mezzo secondo: lo si aspetta al massimo 3 s prima di aprire il ticket
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
      // in elenco qui vanno i ticket di Touch; quelli del Vecchio Cruscotto sono nella loro scheda
      rows = sortUnifiedRows(mergeRowLists(idRows, refRows), exactNum);
      total = rows.length;
      const all = sortUnifiedRows(mergeRowLists(idRows, exactAr, refRows, otherAr), exactNum);
      const note = sameNumberNotice(all, tid);
      if (note) S.notices.push(note);
      if (hasNarrowingFilter(f)) {
        S.notices.push({
          text: `Con un numero ticket nella casella di ricerca i filtri a sinistra non contano: cerco solo il ticket ${exactNum}. Per vedere i ticket dei filtri togli il numero.`,
          action: () => clearFilterKey("text"),
          actionLabel: "Togli il numero",
        });
      }
      let opened = !!openedId;
      if (!opened) {
        const exact = pickExactTicket(all, f.text);
        if (exact) {
          opened = true;
          openFound(exact);
        }
      }
      // lo Storico ha tutti i ticket del Vecchio Cruscotto, anche degli anni che lì non si cercano più:
      // se le altre due fonti non hanno il ticket, si apre quello dello Storico
      const stRows = isLegacyNum ? await Promise.race([storicoPromise, sleep(8000).then(() => [])]) : [];
      if (ac.signal.aborted) return;
      const stExact = (stRows || []).find((r) => r.id === exactNum);
      if (stExact && !opened) openFound(stExact);
      if (!all.length && stExact) {
        S.notices.push(`Il ticket ${exactNum} non è in HDA TOUCH né nella ricerca del Vecchio Cruscotto: l'ho trovato nello Storico.`);
      } else if (!all.length) {
        S.notices.push(
          isLegacyNum && S.arConnected !== true
            ? `Il ticket ${exactNum} non è su HDA TOUCH (cercati ${variants.join(" e ")}). Clicca su «Collega vecchio cruscotto» in alto a destra ed esegui l'accesso all'Area Riservata per cercarlo anche nel Vecchio Cruscotto.`
            : typedZ
              ? `Il ticket ${tid} non risulta su HDA TOUCH.`
              : `Il ticket ${exactNum} non risulta né in HDA TOUCH (cercati ${variants.join(" e ")}) né nel Vecchio Cruscotto${isLegacyNum && S.storico.error ? "" : isLegacyNum ? " né nello Storico" : ""}.`
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
        log("timeout sullo storico completo: riprovo sui ticket aperti");
        const openF = { ...f, statuses: OPEN_STATUS_IDS };
        res = await track("HDA TOUCH (aperti)", run(openF, fetchLimit));
        S.activeEffectiveFilters = openF;
        S.notices.push(
          "La ricerca su tutto lo storico ha superato il limite di 25 secondi del portale: mostro prima i ticket aperti. Aggiungi un filtro più specifico (es. Gruppo, Cliente o Data) per includere i ticket chiusi."
        );
      }
      if (ac.signal.aborted) return;
      const found = await verifyTouchRowsAllWords(readRawRows(res.rows), f);
      show("touch", found);
      if (ac.signal.aborted) return;
      rows = sortUnifiedRows(found);
      total = multiWord ? rows.length : Math.max(res.total || 0, rows.length);
      touchTotal = multiWord ? 0 : res.total || 0;
    }

    if (ac.signal.aborted) return;
    if (!more && fetchLimit > size) S.page = fetchLimit / size; // pagine già lette
    S.results = more ? sortUnifiedRows(mergeRowLists(S.results, rows), exactNum) : rows;
    S.total = Math.max(total, S.results.length);
    S.touchTotal = Math.max(touchTotal, touchRows().length);
    log(touchIdle ? "HDA Touch: nessuna parola e nessun filtro, non cerco" : `ricerca completata: ${S.results.length} ticket in ${Date.now() - t0} ms`);
    const firstTouch = rows.find((r) => r.source !== "ar" && r.id && r.subject);
    if (!S.sampleTicket && firstTouch) {
      S.sampleTicket = { id: firstTouch.id, subject: firstTouch.subject };
    }
    lookups.harvest(rows.filter((r) => r.source !== "ar"));
    harvestTypes(rows.filter((r) => r.source !== "ar"));
    if (S.connected !== true && !touchIdle) setConn(true);
    if (cacheKey) cachePut(cacheKey, { results: S.results, total: S.total, touchTotal: S.touchTotal, notices: S.notices, eff: S.activeEffectiveFilters && JSON.parse(JSON.stringify(S.activeEffectiveFilters)) });
    archivedMap(rows.map((r) => r.id))
      .then((m) => { for (const [k, v] of m) S.archived.set(k, v); renderResults(); })
      .catch(() => {});
  } catch (e) {
    if (e.name === "AbortError" || ac.signal.aborted) return;
    log("ricerca: " + e.message);
    if (more) S.page -= 1;
    S.error = e;
    if (e instanceof AuthError) setConn(false);
    // Touch è andato in errore: il Vecchio Cruscotto ha comunque la sua scheda; un numero trovato lì si apre lo stesso
    const arFallback = await arPromise.catch(() => []);
    if (ac.signal.aborted) return;
    if (tid && arFallback && arFallback.length) {
      const exact = pickExactTicket(arFallback, f.text);
      if (exact) openFound(exact);
    }
  } finally {
    if (searchAbort === ac) {
      S.loading = false;
      autoPickTab();
      renderResults();
    }
  }
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
  if (!q || ticketIdFrom(q)) {
    S.archiveHits = [];
    return;
  }
  try {
    const hits = await searchArchive(q);
    if (my !== archiveSeq) return;
    S.archiveHits = hits;
    renderResults();
  } catch (e) {
    log("archivio: " + e.message);
  }
}

async function refreshArchiveCount() {
  try {
    S.archiveCount = await archiveInfo();
  } catch {
    S.archiveCount = 0;
  }
}

// ---------------------------------------------------------------- le tre fonti

const SOURCES = {
  touch: { label: "HDA Touch", title: "Ticket di HDA TOUCH" },
  ar: { label: "Vecchio Cruscotto", title: "Ticket del Vecchio Cruscotto (Area Riservata), cercati per parole: anni recenti" },
  storico: { label: "Storico", title: "Ricerca avanzata dell'Area Riservata: tutti i ticket, anche prima del 2024 (senza ricerca per parole)" },
};
const isSourceTab = (t = S.tab) => t === "touch" || t === "ar" || t === "storico";
const sourceOf = (r) => (r && (r.source === "ar" || r.source === "storico") ? r.source : "touch");
const touchRows = () => S.results.filter((r) => r.source !== "ar");
const arRows = () => S.arS.results;

/** Ticket trovati per fonte (per le schede): di Touch il totale del portale, non solo quelli già caricati. */
function sourceCounts() {
  const nTouch = touchRows().length;
  return {
    touch: S.loading ? nTouch : Math.max(nTouch, S.touchTotal || 0),
    ar: arRows().length,
    storico: Math.max(S.storico.total || 0, S.storico.results.length),
  };
}

/**
 * Dopo una nuova ricerca dalla casella in alto: se la scheda aperta è rimasta vuota e un'altra fonte ha trovato
 * qualcosa, si passa a quella. Cambiando un filtro dentro una scheda, invece, si resta dove si è.
 */
let pickPending = false;
let lastBoxText = null;
function autoPickTab() {
  if (!pickPending || !isSourceTab() || S.loading || S.storico.loading || S.arS.loading) return;
  pickPending = false;
  const c = sourceCounts();
  if (c[S.tab]) return;
  const next = ["touch", "ar", "storico"].find((k) => c[k]);
  if (next && next !== S.tab) {
    S.tab = next;
    S.cursor = -1;
    refreshSidebar();
  }
}

// ---------------------------------------------------------------- centro servizi dell'Area Riservata

/**
 * Il centro servizi dell'operatore (es. "PAOW") serve al Vecchio Cruscotto e allo Storico per cercare solo tra i
 * ticket del proprio centro: senza, la ricerca per parole pesca anche i ticket degli altri centri (partner compresi).
 * In ordine: quello scritto nelle Impostazioni, quello letto dalla pagina del cruscotto, quello già trovato in
 * passato, quello ricavato dai ticket del proprio gruppo di Touch ("G10663HR" → gruppo 10663).
 */
let centrePromise = null;
function ensureCentre() {
  if (!ar) return Promise.resolve("");
  if (S.settings.arCentro) ar.setCentre(S.settings.arCentro);
  if (ar.state.idCenSer) return Promise.resolve(ar.state.idCenSer);
  if (S.caps.arCentro) {
    ar.setCentre(S.caps.arCentro);
    return Promise.resolve(ar.state.idCenSer);
  }
  if (!centrePromise) {
    const g = /^G(\d+)/i.exec(String(S.caps.defaultGroupId || ""));
    centrePromise = (g ? ar.findCentre([g[1]]) : Promise.resolve(""))
      .catch((e) => (log(`centro servizi: ${e.message}`), ""))
      .then((c) => {
        centrePromise = null;
        if (c) {
          S.caps.arCentro = c;
          kvSet("caps", S.caps);
          warmNames();
        }
        return c;
      });
  }
  return centrePromise;
}

/** Nomi di operatori, gruppi e clienti per le righe del Vecchio Cruscotto (che riporta solo i codici): dagli ultimi ticket dello Storico. */
let namesWarmed = false;
async function warmNames() {
  if (namesWarmed || !storico || Object.keys(S.stLookups.operators).length >= 15) return;
  namesWarmed = true;
  try {
    const d = new Date(Date.now() - 45 * DAY);
    const p2 = (n) => String(n).padStart(2, "0");
    const res = await storico.search({ ...emptyStoricoFilters(), dateFrom: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, dateTo: "" }, { rows: 100 });
    harvestStorico(res.rows);
    renderResults();
  } catch (e) {
    log(`nomi dallo Storico: ${e.message}`);
  }
}

/** Riga del Vecchio Cruscotto con i nomi al posto dei codici, dove li conosciamo. */
function withArNames(r) {
  if (!r || r.source !== "ar") return r;
  const L = S.stLookups;
  const group = r.ownerGroupId && L.groups[r.ownerGroupId];
  const oper = r.assignedId && L.operators[r.assignedId];
  const client = r.customerCode && L.clients[r.customerCode];
  if (!group && !oper && !client) return r;
  return { ...r, ownerGroup: group || r.ownerGroup, assigned: oper || r.assigned, account: client || r.account };
}

// ---------------------------------------------------------------- Vecchio Cruscotto (ricerca rapida dell'Area Riservata)

/**
 * Cosa cercare nel Vecchio Cruscotto: il numero o le parole della casella in alto, più i filtri della sua scheda.
 * Con un numero i filtri non contano; con la "Z" scritta si vuole il ticket nativo di Touch e qui non si cerca.
 */
function arQuery() {
  const text = String(S.filters.text || "").trim();
  const tid = ticketIdFrom(text);
  if (tid) return /z$/i.test(text) ? null : { ticketId: ticketNumber(tid) };
  const filters = S.arS.filters;
  if (!text && !hasArFilter(filters)) return null;
  return { text, filters: { ...filters } };
}

const AR_RESULT_TTL = 2 * 60 * 1000;
let arSeq = 0;
let arInflight = null; // { key, promise }: la stessa ricerca non si rifà mentre è in corso
function runAr({ fresh = false } = {}) {
  const st = S.arS;
  const q = ar ? arQuery() : null;
  const key = q ? JSON.stringify(q) : "";
  const exactNum = (q && q.ticketId) || "";
  if (!q) {
    arSeq++;
    arInflight = null;
    names.queue.length = 0;
    Object.assign(st, { results: [], loading: false, error: null, key: "", notices: [] });
    return Promise.resolve([]);
  }
  if (!fresh && arInflight && arInflight.key === key) return arInflight.promise;
  if (!fresh && key === st.key && !st.error && Date.now() - st.at < (st.full ? 5 : 1) * AR_RESULT_TTL) {
    st.results = sortUnifiedRows(st.results, exactNum); // l'ordinamento può essere cambiato
    return Promise.resolve(st.results);
  }
  const my = ++arSeq;
  names.queue.length = 0; // i nomi in coda erano per l'elenco di prima
  Object.assign(st, { results: [], loading: true, error: null, key: "", notices: [], full: false, progress: "" });
  renderResults();
  const info = {};
  const promise = ensureCentre()
    .then(() => ar.search(q, info))
    .then((rows) => {
      if (ar.state.connected) setArConn(true);
      if (my !== arSeq) return rows || [];
      st.results = sortUnifiedRows(rows || [], exactNum);
      st.key = key;
      st.at = Date.now();
      if (!exactNum && info.max && info.raw >= info.max) {
        st.notices.push({
          text: `Il Vecchio Cruscotto restituisce al massimo ${info.max} ticket per ricerca: qui ne mancano. Posso cercarli tutti dividendo la ricerca per periodi (più richieste al portale), oppure restringi tu con un filtro.`,
          action: () => runArAll(),
          actionLabel: "Cerca tutti",
        });
      }
      // senza centro servizi si cerca in tutti i centri: lo si dice
      if (!exactNum && ar.state.connected && !ar.state.idCenSer && st.results.length) {
        st.notices.push("Vecchio Cruscotto: non conosco il tuo centro servizi, quindi questi risultati comprendono anche i ticket degli altri centri (partner compresi). Scrivilo in Diagnostica → Impostazioni → «Centro servizi dell'Area Riservata».");
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
      autoPickTab();
      renderResults();
    });
  arInflight = { key, promise };
  return promise;
}

/**
 * La ricerca in corso, completa: oltre il limite del portale, divisa per periodi (anno, poi metà, fino al mese).
 * I ticket già in elenco restano visibili mentre arrivano gli altri.
 */
async function runArAll() {
  const st = S.arS;
  const q = ar ? arQuery() : null;
  if (!q || q.ticketId) return;
  const key = JSON.stringify(q);
  const my = ++arSeq;
  arInflight = null;
  names.queue.length = 0;
  Object.assign(st, { loading: true, error: null, notices: [], progress: "" });
  renderResults();
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
    st.results = sortUnifiedRows(res.rows);
    Object.assign(st, { key, at: Date.now(), full: true });
    const n = res.rows.length.toLocaleString("it-IT");
    st.notices.push(`Ricerca completa: ${n} ticket, trovati dividendo la ricerca in ${res.queries} periodi.`);
    if (res.cappedMonths.length) st.notices.push(`In ${res.cappedMonths.length === 1 ? "un mese" : res.cappedMonths.length + " mesi"} (${res.cappedMonths.slice(0, 6).join(", ")}${res.cappedMonths.length > 6 ? "…" : ""}) il portale ha troncato comunque: lì può mancare qualche ticket. Aggiungi un filtro per vederli tutti.`);
    if (res.stopped) st.notices.push(`Mi sono fermato a ${n} ticket per non caricare troppo il portale: i periodi più vecchi non sono stati cercati. Restringi con un filtro o con il periodo.`);
    log(`vecchio cruscotto, ricerca completa: ${res.rows.length} ticket in ${res.queries} richieste`);
  } catch (e) {
    log(`vecchio cruscotto, ricerca completa: ${e.message}`);
    if (my === arSeq) st.error = e;
  } finally {
    if (my === arSeq) {
      Object.assign(st, { loading: false, progress: "" });
      renderResults();
    }
  }
}

// I filtri del Vecchio Cruscotto valgono finché l'app resta aperta: alla riapertura si riparte senza,
// così un filtro dimenticato non restringe di nascosto le ricerche per parole.
function arChanged() {
  refreshSidebar();
  runAr();
  renderResults();
}

/** arSetFilter("statoBase", "C") oppure arSetFilter({ group: "10663", groupLabel: "Paghe Web P" }) */
function arSetFilter(key, val) {
  if (key && typeof key === "object") Object.assign(S.arS.filters, key);
  else S.arS.filters[key] = val;
  arChanged();
}

function arReset() {
  S.arS.filters = emptyArFilters();
  arChanged();
}

/** Etichette dei filtri attivi nella scheda Vecchio Cruscotto. */
function describeAr() {
  const f = S.arS.filters;
  const text = String(S.filters.text || "").trim();
  const day = (d) => d.split("-").reverse().join("/");
  const chips = [];
  if (text) chips.push({ key: "text", label: ticketIdFrom(text) ? `Numero ${ticketNumber(ticketIdFrom(text))}` : `Testo: “${text}”` });
  if (ticketIdFrom(text)) return chips; // con un numero i filtri non contano
  if (text && f.searchIn !== "2") chips.push({ key: "searchIn", label: f.searchIn === "1" ? "Solo nell'oggetto" : "Solo nel testo dei messaggi" });
  if (f.dateFrom || f.dateTo) {
    chips.push({ key: "period", label: `${f.dateRef === "2" ? "Apertura" : "Ultimo aggiornamento"}${f.dateFrom ? " dal " + day(f.dateFrom) : ""}${f.dateTo ? " al " + day(f.dateTo) : ""}` });
  }
  if (f.statoBase) chips.push({ key: "statoBase", label: f.statoBase === "A" ? "Stato: aperti" : "Stato: chiusi" });
  if (f.group) chips.push({ key: "group", label: `Gruppo: ${f.groupLabel || S.stLookups.groups[f.group] || f.group}` });
  if (f.operator) chips.push({ key: "operator", label: `Operatore: ${f.operator.label || f.operator.id}` });
  if (String(f.clientCode || "").trim()) chips.push({ key: "clientCode", label: `Cliente cod. ${f.clientCode}${S.stLookups.clients[f.clientCode] ? " (" + S.stLookups.clients[f.clientCode] + ")" : ""}` });
  if (f.groupIn) chips.push({ key: "groupIn", label: `Ha partecipato il gruppo: ${f.groupInLabel || S.stLookups.groups[f.groupIn] || f.groupIn}` });
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

// ---------------------------------------------------------------- Storico (ricerca avanzata dell'Area Riservata)

/** Cosa cercare nello Storico: il numero scritto nella casella in alto, altrimenti i filtri della scheda Storico. */
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
  renderResults();
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
    if (my === storicoSeq) {
      st.loading = false;
      autoPickTab();
      renderResults();
    }
  }
}

/** Gruppi, operatori e clienti visti nei risultati dello Storico: suggerimenti dei suoi filtri e nomi per il Vecchio Cruscotto. */
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
/** Operatori letti dai movimenti di un ticket: { id: nome }. */
function harvestOperators(map) {
  let changed = false;
  for (const [id, name] of Object.entries(map || {})) if (S.stLookups.operators[id] !== name) { S.stLookups.operators[id] = name; changed = true; }
  if (changed) saveStLookupsSoon();
  return changed;
}

// ---------------------------------------------------------------- nomi per il Vecchio Cruscotto
// La ricerca per parole del Vecchio Cruscotto riporta solo i codici di cliente e operatore. I nomi si chiedono allo Storico,
// un ticket alla volta (numero + giorno di apertura: richiesta stretta), partendo dall'alto dell'elenco; ogni nome trovato
// resta in memoria, quindi lo stesso cliente o operatore non si richiede più.
const NAMES_PARALLEL = 3;
const NAMES_LIST_MAX = 250;
const NAMES_SLOW_MS = 12000;
const names = { queue: [], active: 0, tried: new Set(), fails: 0, off: false };

function needsNames(r) {
  if (!r || r.source !== "ar") return false;
  const L = S.stLookups;
  return !!((r.customerCode && !L.clients[r.customerCode]) || (r.assignedId && !L.operators[r.assignedId]));
}

/** Mette in coda i ticket del Vecchio Cruscotto visibili che hanno ancora un codice al posto del nome. */
function queueArNames() {
  if (names.off || !storico || !ar || !ctx.arCentre()) return;
  const queued = new Set(names.queue.map((r) => r.id));
  // solo i primi dell'elenco: con centinaia di ticket non si fa una richiesta per ognuno
  for (const r of arRows().slice(0, NAMES_LIST_MAX)) {
    // i ticket di un altro centro (trovati per numero) non sono nello Storico del proprio centro
    if (r.cenSer && r.cenSer !== ctx.arCentre()) continue;
    if (needsNames(r) && r.date && !names.tried.has(r.id) && !queued.has(r.id)) names.queue.push(r);
  }
  pumpNames();
}

function stopNames(why) {
  names.off = true;
  names.queue.length = 0;
  log(`nomi del Vecchio Cruscotto: mi fermo (${why}); riprovo alla prossima apertura dell'app`);
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
        // uno Storico lento non va caricato con una richiesta per ticket
        if (Date.now() - t0 > NAMES_SLOW_MS) stopNames("lo Storico risponde lentamente");
      })
      .catch((e) => {
        if (++names.fails >= 3) stopNames(e.message);
      })
      .finally(() => {
        names.active--;
        pumpNames();
      });
  }
}

let namesPaint = null;
function refreshArNamesSoon() {
  if (namesPaint) return;
  namesPaint = setTimeout(() => { namesPaint = null; refreshArNames(); }, 250);
}

/** Aggiorna sul posto la riga "cliente · gruppo → operatore" dei ticket del Vecchio Cruscotto già in elenco (senza ridisegnare tutto). */
function refreshArNames() {
  const byId = new Map(arRows().map((r) => [r.id, r]));
  for (const n of document.querySelectorAll('#results .item[data-source="ar"]')) {
    const r = byId.get(n.dataset.id);
    if (!r) continue;
    const fresh = metaEl(withArNames(r));
    const old = n.querySelector(":scope > .meta");
    if (!fresh || (old && old.textContent === fresh.textContent)) continue;
    if (old) old.replaceWith(fresh);
    else n.querySelector(".item-l1").after(fresh);
  }
}

/** Suggerimenti per i filtri dello Storico. I gruppi di Touch "G10663HR" sono i gruppi 10663 dell'Area Riservata. */
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
    } catch {
      /* elenco di Touch non disponibile: restano i gruppi visti nello Storico */
    }
  }
  return [...out.values()].slice(0, 20);
}

function storicoChanged() {
  refreshSidebar();
  runStorico();
  renderResults();
}

/** storicoSetFilter("group", "10663") oppure storicoSetFilter({ group: "10663", groupLabel: "Paghe Web P" }) */
function storicoSetFilter(key, val) {
  if (key && typeof key === "object") Object.assign(S.storico.filters, key);
  else S.storico.filters[key] = val;
  storicoChanged();
}

function storicoReset() {
  S.storico.filters = emptyStoricoFilters();
  storicoChanged();
}

function describeStorico() {
  const f = S.storico.filters;
  const q = storicoQuery();
  if (q && q.fromBox) return [{ key: "box", label: `Numero ${q.number} (dalla casella di ricerca)` }];
  const day = (d) => d.split("-").reverse().join("/");
  const chips = [];
  if (f.number) chips.push({ key: "number", label: `Numero ${f.number}` });
  if (f.dateFrom || f.dateTo) chips.push({ key: "dates", label: `${f.dateRef === "2" ? "Apertura" : "Ultimo aggiornamento"} ${f.dateFrom ? "dal " + day(f.dateFrom) : "dall'inizio"} ${f.dateTo ? "al " + day(f.dateTo) : "a oggi"}` });
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

// ---------------------------------------------------------------- elenco risultati

function visibleItems() {
  if (S.tab === "touch") return touchRows().map((row) => ({ row }));
  if (S.tab === "ar") return arRows().map((row) => ({ row }));
  if (S.tab === "storico") return S.storico.results.map((row) => ({ row }));
  if (S.tab === "archive") return S.archiveHits.map((x) => ({ row: x.row, snippet: x.snippet }));
  if (S.tab === "favorites") return S.favorites.map((x) => ({ row: reviveRow(x.row) || { id: x.id } }));
  if (S.tab === "recent") return S.recent.map((x) => ({ row: reviveRow(x.row) || { id: x.id } }));
  return S.results.map((row) => ({ row }));
}

function itemEl(it, i) {
  const r = withArNames(it.row);
  const st = statusInfo(r.statusId, r.statusText);
  const fav = isFavorite(r.id);
  const seen = S.recent.some((x) => x.id === r.id);
  const arch = S.archived.get(r.id);
  const when = S.sort.key === "lastChange" ? r.lastChange : r.date;
  const snip = it.snippet || snippetOf(r);
  const el = h("div", {
    class: `item src-${sourceOf(r)}` + (r.id === S.current ? " sel" : "") + (seen ? " seen" : ""),
    tabindex: "0",
    dataset: { id: r.id, i: String(i), source: sourceOf(r) },
    onclick: () => { S.cursor = i; openTicket(r.id, r); },
  },
    h("div", { class: "item-l1" },
      r.statusId || r.statusText ? h("span", { class: `pill ${st.group}`, title: r.statusId || "" }, st.label) : null,
      h("span", { class: "num", title: `${SOURCES[sourceOf(r)].title}: ${r.id}` }, ticketNumber(r.id)),
      // nelle schede miste (archivio, preferiti, recenti) ogni riga dice da dove viene
      !isSourceTab() ? h("span", { class: `src-badge src-${sourceOf(r)}`, title: SOURCES[sourceOf(r)].title }, SOURCES[sourceOf(r)].label) : null,
      h("span", { class: "subj", title: r.subject || "" }, r.subject || "(senza oggetto)"),
      arch ? h("span", { class: "tag-mini", title: `Nell'archivio locale (salvato il ${fmtDateTime(arch.savedAt)})` }, icon("archive")) : null,
      fav ? h("span", { class: "star-on", title: "Preferito" }, icon("star")) : null,
      h("span", { class: "when", title: when ? fmtDateTime(when) : "" }, fmtRelative(when))),
    metaEl(r),
    snip ? h("div", { class: "snip" }, snip) : null);
  return el;
}

/** La riga «cliente · gruppo · → operatore» di un ticket in elenco. */
function metaEl(r) {
  const meta = [r.account, r.ownerGroup, r.assigned && `→ ${r.assigned}`].filter(Boolean);
  return meta.length ? h("div", { class: "meta" }, meta.flatMap((m, k) => [k ? h("span", { class: "sep" }, "·") : null, h("span", { title: m }, m)])) : null;
}

/** Tutto il testo di un ticket su cui agisce «Filtra in elenco» (con i nomi al posto dei codici, dove si conoscono). */
function filterTextOf(row) {
  const r = withArNames(row);
  return [ticketNumber(r.id), r.subject, r.problem, r.fullText, r.account, r.customerCode, r.contact, r.ownerGroup, r.assigned, r.catalog, r.topic, statusInfo(r.statusId, r.statusText).label].filter(Boolean).join(" ");
}

/** I ticket della scheda che passano «Filtra in elenco» (tutti, se la casella è vuota). */
function filteredRows(rows, tab = S.tab) {
  const test = listFilter(listFilters[tab] || "");
  return test ? rows.filter((r) => test(filterTextOf(r))) : rows;
}

/** Nasconde sul posto le righe che non passano il filtro: niente richieste al portale, l'elenco non si ridisegna. */
function applyListFilter() {
  const box = document.querySelector("#results .list-filter");
  if (!box) return;
  const test = isSourceTab() ? listFilter(listFilters[S.tab] || "") : null;
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

/** La casella «Filtra in elenco» sopra i risultati delle tre fonti. */
function listFilterBox() {
  const inp = h("input", { class: "input", type: "search", value: listFilters[S.tab] || "", placeholder: "Filtra in elenco: parole, -parola per escludere", "aria-label": "Filtra in elenco", title: "Restringe i ticket già trovati, senza interrogare il portale. Tutte le parole devono comparire; con il segno meno davanti (-parola) i ticket che la contengono spariscono." });
  inp.addEventListener("input", () => { listFilters[S.tab] = inp.value; applyListFilterSoon(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inp.value) { e.stopPropagation(); inp.value = ""; listFilters[S.tab] = ""; applyListFilter(); }
    if (e.key === "Enter") { e.preventDefault(); applyListFilter(); }
  });
  return h("div", { class: "list-filter" }, icon("filter"), inp, h("span", { class: "lf-count" }));
}

function tabBtn(key, label, n) {
  return h("button", { class: "tab" + (S.tab === key ? " on" : ""), onclick: () => pickTab(key) }, label, n != null ? h("span", { class: "n" }, String(n)) : null);
}

/** Cercando dalla casella in alto si torna alle schede delle fonti (nello Storico le parole non si cercano). */
function leaveTabForSearch(text) {
  if (S.tab === "archive") return;
  // dallo Storico si riparte da Touch: se il ticket o i risultati sono altrove, la scheda giusta si apre da sola
  if (!isSourceTab() || S.tab === "storico") S.tab = "touch";
}

const sidebarMode = (t) => (t === "storico" || t === "ar" ? t : "touch");

function pickTab(key) {
  pickPending = false; // la scheda l'ha scelta l'operatore
  const sidebarChanges = sidebarMode(S.tab) !== sidebarMode(key);
  S.tab = key;
  S.cursor = -1;
  if (sidebarChanges) renderSidebar(ctx);
  renderResults();
}

/** Apre da solo il ticket cercato per numero e porta sulla scheda della sua fonte. */
function openFound(row) {
  if (isSourceTab() && S.tab !== sourceOf(row)) {
    S.tab = sourceOf(row);
    refreshSidebar();
  }
  openTicket(row.id, row);
}

/** Le tre schede delle fonti: ognuna con il suo colore e il numero di ticket trovati. */
function sourceTabs(fmtN) {
  const c = sourceCounts();
  const busy = { touch: S.loading, ar: S.arS.loading, storico: S.storico.loading };
  return h("div", { class: "src-tabs", role: "tablist" },
    Object.entries(SOURCES).map(([key, src]) =>
      h("button", { class: `src-tab src-${key}` + (S.tab === key ? " on" : ""), role: "tab", title: src.title, dataset: { source: key }, onclick: () => pickTab(key) },
        h("span", { class: "lbl" }, src.label),
        h("span", { class: "n" }, busy[key] && !c[key] ? "…" : fmtN(c[key])))));
}

function renderResults() {
  const el = $("#results");
  const top = el.scrollTop;
  // se si sta scrivendo in «Filtra in elenco» il cursore deve restare lì anche quando l'elenco si ridisegna
  const ae = document.activeElement;
  const typingFilter = ae && ae.closest && ae.closest("#results .list-filter") ? [ae.selectionStart, ae.selectionEnd] : null;
  clear(el);
  const fmtN = (n) => Number(n || 0).toLocaleString("it-IT");
  const src = isSourceTab();
  const st = S.storico;
  const items = visibleItems();
  const counts = sourceCounts();
  const arS = S.arS;
  const busy = S.tab === "storico" ? st.loading : S.tab === "ar" ? arS.loading : src && S.loading;

  // intestazione
  const sortSel = h("select", { class: "input", title: "Ordina per", onchange: (e) => { S.sort.key = e.target.value; kvSet("sort", S.sort); search(); } },
    Object.entries(SORTS).map(([k, s]) => h("option", { value: k, selected: S.sort.key === k ? true : null }, s.label)));
  const dirBtn = h("button", { class: "btn btn-small", title: S.sort.dir === "DESC" ? "Dal più recente (clicca per invertire)" : "Dal più vecchio (clicca per invertire)", onclick: () => { S.sort.dir = S.sort.dir === "DESC" ? "ASC" : "DESC"; kvSet("sort", S.sort); search(); } },
    icon("sort"), S.sort.dir === "DESC" ? "Recenti" : "Vecchi");
  const total = src ? counts[S.tab] : items.length;
  const what = { archive: "nell'archivio", favorites: "preferiti", recent: "recenti" }[S.tab];
  // una scheda a cui non si è chiesto niente non dice «0 ticket»
  const asked = S.tab === "touch" ? !isUnconstrained(S.filters) : S.tab === "ar" ? !!arQuery() : S.tab === "storico" ? !!storicoQuery() : true;
  const countText = src
    ? (busy && !items.length ? "Cerco…" : busy ? `${fmtN(items.length)} ticket finora…` : !asked && !items.length ? "Nessuna ricerca" : `${fmtN(total)} ticket`)
    : `${fmtN(items.length)} ${what}`;

  const head = h("div", { class: "res-head" },
    sourceTabs(fmtN),
    h("div", { class: "res-top" },
      h("button", { class: "btn btn-small" + (ui.showFilters ? " on" : ""), title: "Mostra/nascondi i filtri", onclick: toggleFilters }, icon("filter"), "Filtri"),
      h("div", { class: "res-count" }, countText,
        src && !busy && items.length && total > items.length ? h("small", null, ` · ne vedi ${fmtN(items.length)}`) : null),
      S.tab === "touch" || S.tab === "ar" ? [sortSel, S.sort.key === "relevance" ? null : dirBtn] : null,
      S.tab === "storico" ? h("span", { class: "hint" }, "dal più recente") : null,
      src ? h("button", { class: "btn btn-small btn-icon", onclick: () => (S.tab === "storico" ? runStorico({ fresh: true }) : S.tab === "ar" ? runAr({ fresh: true }) : search({ fresh: true })), title: "Aggiorna (rifà la ricerca sul portale)" }, icon("reload")) : null),
    h("div", { class: "res-tools" },
      S.tab === "touch"
        ? [
            h("button", { class: "linkbtn", onclick: saveSearchDialog, title: "Salva questi filtri per riusarli" }, icon("save"), "Salva ricerca"),
            h("button", { class: "linkbtn", onclick: exportCsv, disabled: !S.total || S.job ? true : null, title: "Scarica i risultati in un file per Excel (max 1000)" }, icon("download"), "Excel"),
            h("button", { class: "linkbtn", onclick: archiveResults, disabled: !S.total || S.job ? true : null, title: "Salva nel browser i ticket trovati con tutta la conversazione, per cercare nel testo dei messaggi" }, icon("archive"), "Archivia risultati"),
          ]
        : S.tab === "ar"
          ? h("button", { class: "linkbtn", onclick: exportCsv, disabled: !items.length || S.job ? true : null, title: "Scarica in un file per Excel i ticket del Vecchio Cruscotto in elenco" }, icon("download"), "Excel")
          : null,
      h("span", { class: "grow" }),
      h("div", { class: "tabs" },
        tabBtn("archive", "Archivio locale", S.filters.text ? S.archiveHits.length : null),
        tabBtn("favorites", "Preferiti", S.favorites.length || null),
        tabBtn("recent", "Recenti", S.recent.length || null))));

  if (src && (items.length > 5 || listFilters[S.tab])) head.appendChild(listFilterBox());
  const chips = S.tab === "storico" ? describeStorico() : S.tab === "ar" ? describeAr() : describeFilters(S.filters);
  if (chips.length && (src || S.tab === "archive")) {
    const drop = S.tab === "storico" ? clearStoricoKey : S.tab === "ar" ? clearArKey : clearFilterKey;
    head.appendChild(h("div", { class: "chips" },
      chips.map((c) => h("span", { class: "chip", title: c.label }, h("span", null, c.label),
        h("button", { title: "Togli questo filtro", onclick: () => drop(c.key) }, "×"))),
      chips.length > 1 ? h("button", { class: "linkbtn", onclick: S.tab === "storico" ? storicoReset : S.tab === "ar" ? () => { arReset(); if (S.filters.text) clearFilterKey("text"); } : resetFilters }, "Azzera tutto") : null));
  }
  el.appendChild(head);

  // avvisi, lavori in corso, errori
  if (S.job) el.appendChild(jobBox());
  const noticeEl = (n) =>
    n && typeof n === "object" && n.text
      ? h("div", { class: "notice with-action" }, h("span", null, n.text), n.action ? h("button", { class: "btn btn-small", onclick: n.action }, n.actionLabel || "Riprova") : null)
      : h("div", { class: "notice" }, n);
  if (S.tab === "ar") {
    for (const n of arS.notices) el.appendChild(noticeEl(n));
    if (S.arConnected !== true) {
      el.appendChild(noticeEl({ text: "Il Vecchio Cruscotto non è collegato: apri l'Area Riservata ed esegui l'accesso, poi torna qui.", action: () => openArHome(), actionLabel: "Collega vecchio cruscotto" }));
    } else if (arS.error) {
      el.appendChild(h("div", { class: "err-box" }, "La ricerca nel Vecchio Cruscotto non è riuscita: " + arS.error.message,
        h("div", null,
          h("button", { class: "btn", onclick: () => openArHome() }, icon("external"), "Apri l'Area Riservata"), " ",
          h("button", { class: "btn", onclick: () => runAr({ fresh: true }) }, "Riprova"))));
    }
  }
  if (S.tab === "touch") {
    for (const n of S.notices) el.appendChild(noticeEl(n));
    if (S.error) {
      const auth = S.error instanceof AuthError;
      el.appendChild(h("div", { class: "err-box" },
        auth
          ? (S.error.message && S.error.message !== new AuthError().message ? S.error.message : "Non vedo una sessione attiva di HDA TOUCH. Apri il portale, esegui l'accesso e poi premi Riprova.")
          : "La ricerca non è riuscita: " + S.error.message,
        h("div", null,
          auth ? h("button", { class: "btn", onclick: openTouchHome }, icon("external"), "Apri HDA TOUCH") : null, " ",
          h("button", { class: "btn", onclick: () => search({ fresh: true }) }, "Riprova"))));
    }
  }
  if (S.tab === "storico") {
    const text = String(S.filters.text || "").trim();
    if (text && !ticketIdFrom(text) && !storicoQuery()) {
      el.appendChild(noticeEl(`Nello Storico non si può cercare per parole («${text}»): scrivi un numero ticket nella casella in alto oppure usa i filtri a sinistra.`));
    }
    if (st.error) {
      el.appendChild(h("div", { class: "err-box" }, st.error.message,
        h("div", null,
          h("button", { class: "btn", onclick: () => openArHome() }, icon("external"), "Apri l'Area Riservata"), " ",
          h("button", { class: "btn", onclick: () => runStorico({ fresh: true }) }, "Riprova"))));
    }
  }
  if (S.tab === "archive") {
    el.appendChild(h("div", { class: "notice" },
      S.archiveCount
        ? `L'archivio locale contiene ${fmtN(S.archiveCount)} ticket letti o archiviati, con tutto il testo delle conversazioni. La ricerca qui usa solo le parole scritte nella casella in alto (tutte devono comparire).`
        : "L'archivio locale è vuoto. Ogni ticket che apri viene salvato qui con tutta la conversazione; con «Archivia risultati» puoi salvarne molti insieme. Poi puoi cercare dentro il testo dei messaggi."));
  }

  const list = h("div", { class: "list" });
  items.forEach((it, i) => list.appendChild(itemEl(it, i)));
  if (!items.length && !busy && !(S.tab === "touch" && S.error) && !(S.tab === "ar" && arS.error) && !(S.tab === "storico" && st.error)) {
    const empty = {
      touch: isUnconstrained(S.filters)
        ? ["HDA Touch: scrivi cosa cercare", "Scrivi delle parole o un numero ticket nella casella in alto, oppure scegli un filtro a sinistra (per esempio lo stato «Aperti» o il tuo gruppo). Senza una richiesta qui non si carica nessun ticket."]
        : ["Nessun ticket trovato in HDA Touch", "Prova a togliere qualche filtro o a cambiare le parole."],
      ar: arQuery()
        ? ["Nessun ticket trovato nel Vecchio Cruscotto", "Prova a togliere un filtro o ad allargare il periodo. Qui ci sono solo gli anni più recenti: per i ticket più vecchi guarda la scheda Storico."]
        : ["Vecchio Cruscotto: la Ricerca rapida dell'Area Riservata", "Scrivi delle parole o un numero ticket nella casella in alto, oppure scegli a sinistra un filtro (gruppo, operatore, cliente, stato, periodo): si può cercare anche senza parole."],
      storico: storicoQuery()
        ? ["Nessun ticket trovato nello Storico", "Prova ad allargare il periodo o a togliere un filtro."]
        : ["Storico: tutti i ticket del Vecchio Cruscotto, anche prima del 2024", "Qui non si cerca per parole. Scrivi un numero ticket nella casella in alto, oppure scegli a sinistra un periodo, un cliente, un gruppo o un operatore."],
      archive: [S.filters.text ? "Nessun ticket dell'archivio contiene queste parole" : "Scrivi una o più parole nella casella in alto", ""],
      favorites: ["Nessun preferito", "Apri un ticket e premi la stella per ritrovarlo qui."],
      recent: ["Nessun ticket aperto di recente", ""],
    }[S.tab];
    list.appendChild(h("div", { class: "empty-state" }, h("h3", null, empty[0]), empty[1]));
  }
  if (src && items.length) {
    list.appendChild(h("div", { class: "empty-state lf-none", hidden: true }, h("h3", null, "Nessun ticket dell'elenco passa il filtro"),
      "Togli una parola dalla casella «Filtra in elenco»: i ticket trovati sono ancora tutti qui."));
  }
  if (busy) {
    const still = S.tab === "touch" && S.pending && S.pending.size ? [...S.pending].join(", ") : "";
    const msg = S.tab === "storico"
      ? (items.length ? "Carico altri…" : "Cerco nello Storico…")
      : S.tab === "ar"
        ? ["Cerco nel Vecchio Cruscotto… ", h("span", { class: "ar-progress" }, arS.progress || "")]
        : still
        ? (S.results.length ? `Sto ancora cercando in: ${still}…` : `Cerco in: ${still}…`)
        : S.results.length ? "Carico altri…" : "Cerco i ticket…";
    list.appendChild(h("div", { class: "loading" }, h("span", { class: "spinner" }), msg));
  }
  if (S.tab === "touch" && !S.loading && items.length < counts.touch)
    list.appendChild(h("button", { class: "btn more", onclick: () => search({ more: true }) }, `Mostra altri (${fmtN(counts.touch - items.length)} rimanenti)`));
  if (S.tab === "storico" && !st.loading && items.length && items.length < counts.storico)
    list.appendChild(h("button", { class: "btn more", onclick: () => runStorico({ more: true }) }, `Mostra altri (${fmtN(counts.storico - items.length)} rimanenti)`));
  el.appendChild(list);

  const words = tokens(S.filters.text);
  if (src && S.tab !== "storico" && words.length && !ticketIdFrom(S.filters.text)) highlight(list, highlightPatterns(rankQuery()));
  else if (S.tab === "archive" && words.length) highlight(list, words);
  applyListFilter();
  if (typingFilter) {
    const inp = el.querySelector(".list-filter input");
    if (inp) {
      inp.focus();
      try { inp.setSelectionRange(typingFilter[0], typingFilter[1]); } catch { /* tipo di casella senza selezione */ }
    }
  }
  el.scrollTop = top;
  if (S.tab === "ar" && !S.arS.loading) queueArNames();
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
  renderResults();
}

// ---------------------------------------------------------------- lettura del ticket

async function openTicket(id, row, { force = false } = {}) {
  if (!row && id) {
    // prima la riga con lo stesso ID esatto, poi quella con lo stesso numero (mai un ticket con la Z al posto di uno senza)
    const want = String(id).trim();
    row = S.results.find((r) => r.id === want) || (ticketIdFrom(want) ? pickExactTicket(mergeRowLists(S.results, S.arS.results), want, { allowSingle: false }) : null) || S.arS.results.find((r) => r.id === want) || S.storico.results.find((r) => r.id === want) || null;
  }
  id = row && row.id ? String(row.id) : ticketIdFrom(id) || String(id || "").trim();
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
    const loaded = row && row.source === "storico"
      ? await storico.loadTicket(id, { row })
      : await loadTicket(hda, id, { row, rowReader, conditionsFor: conditionsForId, caps: S.caps, ar, log });
    let full = loaded;
    if (full.source === "ar") {
      setArConn(true);
      full = await completeArTicket(full);
    }
    S.current = full.id || id;
    kvSet("caps", S.caps);
    if (!full.row && !full.ticket && !full.items.length && !(full.timeline && full.timeline.length)) {
      throw new Error("ticket non trovato o non visibile con il tuo utente");
    }
    addRecent(full.id, full.row);
    if (S.settings.archiveOnRead) {
      saveTicket(full)
        .then(() => { S.archived.set(full.id, { savedAt: Date.now(), lastChange: full.row && full.row.lastChange ? +full.row.lastChange : null }); refreshArchiveCount(); })
        .catch((e) => log("archivio: " + e.message));
    }
    if (my !== openSeq) return;
    renderReader(ctx, full);
  } catch (e) {
    log(`ticket ${id}: ${e.message}`);
    if (e instanceof AuthError) setConn(false);
    if (my !== openSeq) return;
    let rec = null;
    try {
      // stesso ticket nell'archivio locale: l'ID esatto oppure, per un numero senza "Z", la forma con la "Z"
      rec = (await getTicket(id)) || (!isTouchNativeId(id) && !(row && row.source === "ar") ? await getTicket(ticketNumber(id) + "Z") : null);
    } catch {
      /* archivio non disponibile */
    }
    if (my !== openSeq) return;
    if (rec) renderReader(ctx, { id: rec.id, row: rec.row, ticket: null, items: [], attachments: rec.attachments || [], timeline: rec.timeline, notes: [] }, { fromArchive: rec.savedAt });
    else renderReaderError(ctx, id, row, e);
  }
}

/**
 * Ticket del Vecchio Cruscotto appena letto → con i nomi veri: dalla scheda del ticket (chi ha scritto ogni messaggio)
 * e dallo Storico (cliente, contatto, gruppo, operatore). Se il portale non risponde in tempo resta com'è.
 */
const AR_COMPLETE_MS = 6000;
async function completeArTicket(full) {
  const row = full.row || {};
  if (!storico || !row.ttCodice) return full;
  const own = !row.cenSer || !ctx.arCentre() || row.cenSer === ctx.arCentre();
  const known = S.storico.results.find((r) => r.id === row.id && r.ttCodice === row.ttCodice) || null;
  const work = (async () => {
    const [mv, inf] = await Promise.allSettled([
      storico.loadMoves(row.ttCodice),
      // se lo Storico ha già trovato questo ticket (ricerca per numero) la sua riga basta
      known ? Promise.resolve(known) : own && ctx.arCentre() ? storico.findTicket({ number: row.id, date: row.date, clientCode: row.customerCode }) : Promise.resolve(null),
    ]);
    const moves = mv.status === "fulfilled" ? mv.value : [];
    const info = inf.status === "fulfilled" ? inf.value : null;
    if (mv.status === "rejected") log(`scheda del ticket ${row.id}: ${mv.reason.message}`);
    if (inf.status === "rejected") log(`nomi del ticket ${row.id}: ${inf.reason.message}`);
    let changed = harvestOperators(movePeople(moves));
    if (info) changed = harvestStorico([info]) || changed;
    if (changed) refreshArNamesSoon();
    let attachments = [];
    if (moves.length) {
      try {
        attachments = await storico.loadAttachments(moves, row);
      } catch (e) {
        log(`allegati del ticket ${row.id}: ${e.message}`);
      }
    }
    return enrichArTicket(full, { info, moves, attachments });
  })();
  const late = new Promise((res) => setTimeout(() => res(null), AR_COMPLETE_MS));
  const done = await Promise.race([work.catch((e) => (log(`ticket ${row.id}: ${e.message}`), null)), late]);
  const out = done || full;
  const named = withArNames(out.row);
  // nella conversazione ricostruita dal testo il cliente compare con il codice: si mette il nome appena lo si conosce
  const timeline = named.account && named.account !== row.account
    ? (out.timeline || []).map((e) => (e.account && e.account === row.account ? { ...e, account: named.account } : e))
    : out.timeline;
  return { ...out, row: named, timeline };
}

function closeReader() {
  openSeq++;
  S.current = null;
  const r = $("#reader");
  r.hidden = true;
  r.dataset.id = "";
  clear(r);
  $("#layout").classList.remove("reading");
  for (const n of document.querySelectorAll("#results .item.sel")) n.classList.remove("sel");
}

async function openInTouch(id) {
  if (!inExtension) return toast("«Apri in Touch» funziona solo nell'estensione installata", "err");
  toast("Apro il ticket in HDA TOUCH…", "info", 1800);
  try {
    const res = await chrome.runtime.sendMessage({ type: "open-in-touch", id });
    const r = res && res.result;
    if (r === "ok") return;
    if (r === "timeout") toast("Touch non è pronto: esegui l'accesso nella scheda aperta e riprova.", "err", 5000);
    else toast("Non sono riuscito ad aprirlo in Touch (" + r + "). Cerca il numero " + ticketNumber(id) + " nel portale.", "err", 6000);
  } catch (e) {
    toast("Errore: " + e.message, "err");
  }
}

function isFavorite(id) {
  return S.favorites.some((x) => x.id === id);
}

function toggleFavorite(id, row) {
  if (isFavorite(id)) S.favorites = S.favorites.filter((x) => x.id !== id);
  else S.favorites.unshift({ id, row: slim(row) || { id }, at: Date.now() });
  kvSet("favorites", S.favorites);
  renderResults();
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

// ---------------------------------------------------------------- lavori lunghi: CSV e archiviazione

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

/** Tutte le righe della ricerca corrente (a pagine), fino a max */
async function fetchAllRows(max, job) {
  const out = [];
  const f = S.activeEffectiveFilters || S.filters;
  const conditions = buildConditions(f, S.calib);
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
  const fromAr = S.tab === "ar";
  const job = (S.job = { label: "Preparo il file", done: 0, total: Math.min(fromAr ? arRows().length : S.total, 1000) });
  renderResults();
  try {
    const rows = fromAr ? filteredRows(arRows(), "ar").map(withArNames) : await fetchAllRows(1000, job);
    if (job.cancelled) return;
    const cols = [
      ["Numero", (r) => ticketNumber(r.id)], ["Oggetto", (r) => r.subject], ["Stato", (r) => statusInfo(r.statusId, r.statusText).label],
      ["Tipo", (r) => r.typeText], ["Priorità", (r) => r.priorityText], ["Cliente", (r) => r.account], ["Codice cliente", (r) => r.customerCode],
      ["Contatto", (r) => r.contact], ["Gruppo", (r) => r.ownerGroup], ["Assegnato a", (r) => r.assigned], ["Responsabile", (r) => r.ownerUser],
      ["Prodotto", (r) => r.catalog], ["Classificazione", (r) => r.classCli], ["Aperto il", (r) => fmtDateTime(r.date)], ["Ultimo aggiornamento", (r) => fmtDateTime(r.lastChange)],
    ];
    const lines = [cols.map((c) => csvCell(c[0])).join(";"), ...rows.map((r) => cols.map((c) => csvCell(c[1](r))).join(";"))];
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `ticket_${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`File con ${rows.length} ticket scaricato${!fromAr && S.total > 1000 ? " (limite 1000)" : ""}`, "ok");
  } catch (e) {
    toast("Esportazione non riuscita: " + e.message, "err", 5000);
  } finally {
    S.job = null;
    renderResults();
  }
}

async function archiveResults() {
  if (S.job) return;
  const cap = Number(S.settings.archiveCap) || 300;
  if (S.total > cap && !confirm(`La ricerca ha ${S.total} ticket: ne archivio i primi ${cap} (si può cambiare nelle impostazioni). Continuo?`)) return;
  const job = (S.job = { label: "Elenco i ticket", done: 0, total: Math.min(S.total, cap), skipped: 0, errors: 0 });
  renderResults();
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
        log(`archivio ${row.id}: ${e.message}`);
        if (e instanceof AuthError) job.cancelled = true;
      }
      job.done++;
      updateJob();
      await sleep(250);
    });
    kvSet("caps", S.caps);
    await refreshArchiveCount();
    toast(job.cancelled ? "Archiviazione interrotta" : `Archiviati ${job.done - job.skipped - job.errors} ticket${job.errors ? `, ${job.errors} errori` : ""}`, job.errors ? "err" : "ok", 4000);
  } catch (e) {
    toast("Archiviazione non riuscita: " + e.message, "err", 5000);
  } finally {
    S.job = null;
    runArchiveSearch(S.filters.text);
    renderResults();
  }
}

// ---------------------------------------------------------------- tastiera

function moveCursor(delta) {
  const items = [...document.querySelectorAll("#results .item:not([hidden])")];
  if (!items.length) return;
  // S.cursor è la posizione nell'elenco completo; con «Filtra in elenco» ci si muove tra le righe rimaste visibili
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
    if (typing && t.id === "q") return t.blur();
    if (!$("#reader").hidden) closeReader();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveCursor(1); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); moveCursor(-1); }
  else if (e.key === "Enter" && t.classList && t.classList.contains("item")) t.click();
}

// ---------------------------------------------------------------- avvio

async function init() {
  // Parole e filtri dell'ultima volta non si rileggono: l'app si apre sempre vuota (le ricerche da ritrovare sono quelle salvate).
  const [settings, savedUi, sort, saved, favorites, recent, learned, captures, caps, typesSeen, touchLang, transportMode, stLookups] = await Promise.all([
    kvGet("settings", null), kvGet("ui", null), kvGet("sort", null), kvGet("saved", []),
    kvGet("favorites", []), kvGet("recent", []), kvGet("learned", {}), kvGet("captures", []), kvGet("caps", {}), kvGet("typesSeen", {}),
    kvGet("touchLang", null), kvGet("transportMode", null), kvGet("stLookups", null),
  ]);
  if (stLookups) S.stLookups = { groups: stLookups.groups || {}, operators: stLookups.operators || {}, clients: stLookups.clients || {} };
  Object.assign(S.settings, settings || {});
  Object.assign(ui, savedUi || {});
  ui.openSections = ui.openSections || {};
  if (sort && SORTS[sort.key]) S.sort = sort;
  if (!(await kvGet("sortRelevanceOffered", false))) {
    S.sort = { key: "relevance", dir: "DESC" };
    kvSet("sort", S.sort);
    kvSet("sortRelevanceOffered", true);
  }
  Object.assign(S, { saved: saved || [], favorites: favorites || [], recent: recent || [], captures: captures || [], caps: caps || {}, typesSeen: typesSeen || {} });
  S.calib.learned = learned || {};
  if (S.caps.containsText && S.caps.containsText.wildcard) {
    S.calib.containsText = S.caps.containsText;
  } else if (S.caps.containsText) {
    delete S.caps.containsText;
    kvSet("caps", S.caps);
  }
  if (S.caps.fullTextRule) S.calib.overrides.text = { ...S.caps.fullTextRule, source: "calibrato" };

  // strada che ha funzionato l'ultima volta (diretta o dalla scheda di Touch): si riparte da quella
  transport = makeTransport({
    log,
    mode: transportMode === "proxy" ? "proxy" : "direct",
    onModeChange: (m) => {
      kvSet("transportMode", m);
      if (S.connected === true) setConn(true, `Connesso a Touch${m === "proxy" ? " (tramite scheda)" : ""}`);
    },
  });
  hda = makeHda(transport, { lang: portalLang(S.settings, touchLang) });
  log(`lingua del portale: ${hda.lang}${touchLang ? " (come Touch)" : ""}, richieste ${transport.mode === "proxy" ? "dalla scheda di Touch" : "dirette"}`);
  ar = makeAr({ log });
  storico = makeStorico({ log, request: (path, o) => ar.request(path, o), centro: () => ar.state.idCenSer || S.caps.arCentro || "" });
  lookups = makeLookups(hda, { kvGet, kvSet, log });
  await lookups.restore();
  refreshArchiveCount();

  onKvChange((ch) => {
    if (ch.touchLang && ch.touchLang.newValue) {
      const l = portalLang(S.settings, ch.touchLang.newValue);
      if (l !== hda.lang) {
        hda.setLang(l);
        log(`lingua del portale: ${l} (come Touch)`);
      }
    }
    if (ch.learned) S.calib.learned = ch.learned.newValue || {};
    if (ch.captures) S.captures = ch.captures.newValue || [];
    if (ch.learned || ch.captures) refreshSidebar();
  });

  $("#layout").classList.toggle("nofilters", !ui.showFilters);
  syncSearchBox();
  renderSidebar(ctx);
  renderResults();

  // Ricerca mentre si scrive: solo dopo una pausa e con almeno 3 caratteri (o un numero ticket completo),
  // così il portale non riceve una ricerca nei messaggi per ogni lettera. Invio cerca sempre.
  const onSearchInput = debounce(() => {
    const v = $("#q").value.trim();
    if (v && v.length < 3 && !ticketIdFrom(v)) return;
    if (v !== S.filters.text) {
      S.filters.text = v;
      leaveTabForSearch(v);
      filtersChanged(true);
    }
  }, 700);
  $("#q").addEventListener("input", onSearchInput);
  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    S.filters.text = $("#q").value.trim();
    leaveTabForSearch(S.filters.text);
    filtersChanged(true);
  });
  $("#conn").addEventListener("click", () => { if (S.connected === false) openTouchHome(); });
  const arConnEl = $("#arConn");
  if (arConnEl) arConnEl.addEventListener("click", () => openArHome());
  $("#diagBtn").addEventListener("click", () => openDiag(ctx));
  $("#sidebar").addEventListener("focusout", (e) => {
    if (pendingSidebar && !(e.relatedTarget && $("#sidebar").contains(e.relatedTarget))) setTimeout(refreshSidebar, 0);
  });
  document.addEventListener("keydown", onKey);
  // tornando sulla scheda dopo aver fatto l'accesso a Touch o al Vecchio Cruscotto si riprova da soli
  let calibrated = false;
  const start = async () => {
    if (!calibrated) {
      calibrated = true;
      await reloadCalibration();
      refreshSidebar();
    }
    const p = search();
    // collegamento diretto: index.html#t=10500123 apre quel ticket
    const m = /[#&]t=(\d{5,10})/.exec(location.hash);
    if (m) await openTicket(m[1], null);
    await p;
  };
  window.addEventListener("focus", async () => {
    if (S.connected === false && (await checkConnection())) start();
    else if (S.arConnected !== true && (await checkArConnection())) {
      if (S.current && isLegacyTicketNumber(S.current)) openTicket(S.current, null, { force: true });
      else if (arQuery()) runAr({ fresh: true }); // parole, numero o filtri del Vecchio Cruscotto: si rifà la sua ricerca
      if (S.storico.error) runStorico({ fresh: true });
    }
  });

  if (await checkConnection()) {
    await start();
  } else {
    if (!S.error) S.error = new AuthError();
    renderResults();
  }
}

await init().catch((e) => {
  log("avvio: " + e.message);
  document.getElementById("results").appendChild(h("div", { class: "err-box" }, "Errore all'avvio: " + e.message));
});
