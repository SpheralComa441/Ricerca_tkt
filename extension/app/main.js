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
import { makeRowReader } from "../lib/rows.js";
import { emptyFilters, buildConditions, describeFilters, ruleFor, DEF, DOMAIN_CONDITION, OPEN_STATUS_IDS, isUnconstrained, hasNarrowingFilter } from "../lib/filters.js";
import { statusInfo, mergePortalStatuses } from "../lib/statuses.js";
import { loadTicket } from "../lib/ticket.js";
import { saveTicket, getTicket, searchArchive, archivedMap, archiveInfo, kvGet, kvSet, onKvChange, reviveRow } from "../lib/store.js";
import { makeLookups } from "../lib/lookups.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "../lib/richtext.js";
import { ticketIdFrom, ticketNumber, fmtRelative, fmtDateTime, tokens, pool, sleep, csvCell, debounce } from "../lib/util.js";

const inExtension = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
const DAY = 86400000;
const DEFAULT_SETTINGS = { pageSize: 50, lang: "en", archiveOnRead: true, archiveCap: 300 };
const SORTS = {
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
  error: null,
  notices: [],
  tab: "results",
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
  job: null,
  settings: { ...DEFAULT_SETTINGS },
};
const ui = { openSections: {}, statusDetail: false, showInternal: true, newestFirst: false, readerSearch: "", showFilters: true };

let transport, hda, lookups;
let rowReader = makeRowReader(null);
let searchAbort = null;
let openSeq = 0;

const ctx = {
  S,
  ui,
  get hda() { return hda; },
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
  isFavorite,
  toggleFavorite,
  saveUi,
  saveSettings,
  reloadCalibration,
  refreshArchiveCount,
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

function snippetOf(row) {
  const p = row && row.problem ? String(row.problem) : "";
  if (!p) return "";
  const t = isProbablyHtml(unescapeIfEscapedHtml(p)) ? htmlToText(p) : cleanText(p);
  return t.replace(/\s+/g, " ").trim().slice(0, 300);
}

function sortSpec() {
  const s = SORTS[S.sort.key] || SORTS.date;
  return [{ property: rowReader.sortAlias(s.field) || s.fb, direction: S.sort.dir }];
}

const conditionsForId = (id) => [{ ...DOMAIN_CONDITION }, { property: "ID", value: id, op: "eq", id: "ID" }];

function openTouchHome() {
  if (inExtension && chrome.tabs) chrome.tabs.create({ url: PORTAL_BASE + "/" });
  else window.open(PORTAL_BASE + "/", "_blank");
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

let statusesLoaded = false;

async function checkConnection() {
  setConn(null);
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
  if (a && sb.contains(a) && a.tagName === "INPUT" && /^(text|search)$/.test(a.type)) {
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
  kvSet("lastFilters", S.filters);
  refreshSidebar();
  syncSearchBox();
  if (immediate) search();
  else {
    S.loading = true;
    renderResults();
    searchSoon();
  }
}

function setFilter(key, val, immediate = false) {
  S.filters[key] = val;
  filtersChanged(immediate);
}

function setFilters(obj) {
  Object.assign(S.filters, obj);
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

function userGroupOrAssignedFallback(f) {
  const gId =
    S.caps.defaultGroupId ||
    (S.calib.learned.OwnerUserGroupID && String(S.calib.learned.OwnerUserGroupID.value || "").split("|")[0]);
  if (gId) return { ...f, statuses: OPEN_STATUS_IDS, ownerGroups: [{ id: gId, label: gId }] };
  if (hda && hda.currentUserId) {
    return { ...f, statuses: OPEN_STATUS_IDS, assigned: [{ id: hda.currentUserId, label: S.caps.userFullName || hda.currentUserId }] };
  }
  return null;
}

async function search({ more = false, forceFullText = false } = {}) {
  if (!hda) return;
  if (searchAbort) searchAbort.abort();
  const ac = new AbortController();
  searchAbort = ac;

  // Se l'utente ha scritto nella casella #q senza premere Invio e ha cliccato Riprova / Aggiorna, sincronizziamo subito il testo.
  const qEl = $("#q");
  if (qEl && !more && qEl.value.trim() !== S.filters.text) {
    S.filters.text = qEl.value.trim();
    kvSet("lastFilters", S.filters);
    refreshSidebar();
  }

  const f = S.filters;
  const size = Number(S.settings.pageSize) || 50;
  const tid = ticketIdFrom(f.text);
  const prevResults = S.results;
  const prevTotal = S.total;
  const prevEff = S.activeEffectiveFilters;

  if (!more) {
    S.page = 1;
    if (!forceFullText) {
      S.results = [];
      S.total = 0;
    }
    S.cursor = -1;
    S.notices = [];
    runArchiveSearch(f.text);
  } else {
    S.page += 1;
  }
  S.loading = true;
  S.error = null;
  renderResults();

  const run = (filters) =>
    hda.listData("Incidents", {
      conditions: buildConditions(filters, S.calib),
      page: S.page,
      start: (S.page - 1) * size,
      limit: size,
      sort: sortSpec(),
      signal: ac.signal,
    });

  try {
    let res;
    if (more && S.activeEffectiveFilters) {
      res = await run(S.activeEffectiveFilters);
    } else if (isUnconstrained(f)) {
      // Un'interrogazione senza alcun filtro su 10+ anni di storico scade a 25s su SQL Server nelle ore di punta:
      // mostriamo i ticket negli stati aperti (come fa Touch all'avvio) e, se anche quello andasse in timeout, restringiamo al gruppo dell'operatore.
      const openF = { ...f, statuses: OPEN_STATUS_IDS };
      try {
        res = await run(openF);
        S.activeEffectiveFilters = openF;
        S.notices.push(
          "Vista iniziale: mostro i ticket aperti per evitare il timeout del portale (25 s). Scrivi nella casella di ricerca o scegli un filtro a sinistra per cercare automaticamente anche in tutti i ticket chiusi."
        );
      } catch (e) {
        const fb = isTimeoutError(e) && userGroupOrAssignedFallback(f);
        if (!fb) throw e;
        log("timeout anche sugli aperti di tutti i gruppi: restringo al gruppo/operatore");
        res = await run(fb);
        S.activeEffectiveFilters = fb;
        S.notices.push(
          "Vista iniziale: il portale era sovraccarico su tutti i gruppi, mostro i ticket aperti del tuo gruppo. Usa la ricerca o i filtri a sinistra per cercare su tutti i gruppi e nei ticket chiusi."
        );
      }
    } else if (f.text && !tid) {
      if (hasNarrowingFilter(f) || forceFullText) {
        // C'è già un filtro (es. Gruppo, Cliente, Stato, Data) oppure l'utente ha chiesto esplicitamente di cercare nei messaggi sul portale:
        // usiamo FullText/eq[INCLUDECONVERSATIONITEM] che cerca anche dentro i messaggi delle conversazioni.
        try {
          res = await run(f);
          S.activeEffectiveFilters = f;
          if (forceFullText) {
            S.notices.push(`Ricerca di «${f.text}» completata anche dentro i messaggi delle conversazioni sul portale.`);
          }
        } catch (e) {
          if (e instanceof AuthError || e.name === "AbortError") throw e;
          log(`ricerca FullText (${e.message}): ripiego sull'oggetto`);
          if (forceFullText && prevResults.length) {
            S.results = prevResults;
            S.total = prevTotal;
            S.activeEffectiveFilters = prevEff;
            S.notices.push(
              "La ricerca dentro tutti i messaggi di tutti gli anni ha superato il limite di 25 secondi del portale. Scegli almeno un filtro a sinistra (es. Gruppo, Cliente o Aperto dal) per cercare nei messaggi in meno di un secondo."
            );
            return;
          }
          const subF = fallbackToSubject(f);
          try {
            res = await run(subF);
            S.activeEffectiveFilters = subF;
            S.notices.push(
              `La ricerca nei messaggi sul portale ha impiegato troppo tempo: ho cercato «${f.text}» nell'oggetto dei ticket (e nell'Archivio locale).`
            );
          } catch (e2) {
            if (!isTimeoutError(e2) || subF.statuses.length) throw e2;
            const subOpen = { ...subF, statuses: OPEN_STATUS_IDS };
            res = await run(subOpen);
            S.activeEffectiveFilters = subOpen;
            S.notices.push(
              `Il portale ha superato i 25 secondi sullo storico completo: mostro i ticket aperti con «${f.text}». Aggiungi un filtro (Gruppo, Cliente o Data) per cercare anche nei chiusi.`
            );
          }
        }
      } else {
        // Solo testo libero senza altri filtri: cerchiamo subito nell'Oggetto su TUTTI i ticket (aperti e chiusi) per rispondere in pochi secondi senza incorrere nel timeout di 25s sulle conversazioni storiche.
        const subF = fallbackToSubject(f);
        try {
          res = await run(subF);
          S.activeEffectiveFilters = subF;
          S.notices.push({
            text: `Ho cercato «${f.text}» nell'oggetto di tutti i ticket (aperti e chiusi) e nei messaggi dell'archivio locale. Se scegli un Gruppo, Cliente o Data a sinistra cerco automaticamente anche dentro i messaggi sul portale.`,
            actionLabel: "Cerca anche nei messaggi sul portale",
            action: () => search({ forceFullText: true }),
          });
        } catch (e) {
          if (!isTimeoutError(e) || subF.statuses.length) throw e;
          log("timeout sull'oggetto su tutto lo storico: riprovo sui ticket aperti");
          const subOpen = { ...subF, statuses: OPEN_STATUS_IDS };
          res = await run(subOpen);
          S.activeEffectiveFilters = subOpen;
          S.notices.push(
            `Il portale ha superato i 25 secondi sullo storico completo: mostro i ticket aperti con «${f.text}». Scegli un Gruppo, Cliente o periodo a sinistra per cercare anche in tutti i ticket chiusi.`
          );
        }
      }
    } else {
      try {
        res = await run(f);
        S.activeEffectiveFilters = f;
      } catch (e) {
        if (!isTimeoutError(e) || f.statuses.length) throw e;
        log("timeout sullo storico completo: riprovo sui ticket aperti");
        const openF = { ...f, statuses: OPEN_STATUS_IDS };
        res = await run(openF);
        S.activeEffectiveFilters = openF;
        S.notices.push(
          "La ricerca su tutto lo storico ha superato il limite di 25 secondi del portale: mostro prima i ticket aperti. Aggiungi un filtro più specifico (es. Gruppo, Cliente o Data) per includere i ticket chiusi."
        );
      }
    }
    if (ac.signal.aborted) return;
    checkReader(res.rows);
    const rows = res.rows.map((r) => rowReader.read(r));
    S.results = more ? S.results.concat(rows) : rows;
    S.total = res.total;
    if (!S.sampleTicket && rows[0] && rows[0].id && rows[0].subject) {
      S.sampleTicket = { id: rows[0].id, subject: rows[0].subject };
    }
    lookups.harvest(rows);
    harvestTypes(rows);
    if (S.connected !== true) setConn(true);
    if (!more && tid && rows.length === 1) openTicket(rows[0].id, rows[0]);
    if (!more && tid && !rows.length) S.notices.push(`Il ticket ${ticketNumber(tid)} non risulta tra quelli che puoi vedere in Touch (o il numero è errato).`);
    archivedMap(rows.map((r) => r.id))
      .then((m) => { for (const [k, v] of m) S.archived.set(k, v); renderResults(); })
      .catch(() => {});
  } catch (e) {
    if (e.name === "AbortError" || ac.signal.aborted) return;
    log("ricerca: " + e.message);
    if (more) S.page -= 1;
    S.error = e;
    if (e instanceof AuthError) setConn(false);
  } finally {
    if (searchAbort === ac) {
      S.loading = false;
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

// ---------------------------------------------------------------- elenco risultati

function visibleItems() {
  if (S.tab === "archive") return S.archiveHits.map((x) => ({ row: x.row, snippet: x.snippet }));
  if (S.tab === "favorites") return S.favorites.map((x) => ({ row: reviveRow(x.row) || { id: x.id } }));
  if (S.tab === "recent") return S.recent.map((x) => ({ row: reviveRow(x.row) || { id: x.id } }));
  return S.results.map((row) => ({ row }));
}

function itemEl(it, i) {
  const r = it.row;
  const st = statusInfo(r.statusId, r.statusText);
  const fav = isFavorite(r.id);
  const seen = S.recent.some((x) => x.id === r.id);
  const arch = S.archived.get(r.id);
  const when = S.sort.key === "lastChange" ? r.lastChange : r.date;
  const meta = [r.account, r.ownerGroup, r.assigned && `→ ${r.assigned}`].filter(Boolean);
  const snip = it.snippet || snippetOf(r);
  const el = h("div", {
    class: "item" + (r.id === S.current ? " sel" : "") + (seen ? " seen" : ""),
    tabindex: "0",
    dataset: { id: r.id, i: String(i) },
    onclick: () => { S.cursor = i; openTicket(r.id, r); },
  },
    h("div", { class: "item-l1" },
      r.statusId || r.statusText ? h("span", { class: `pill ${st.group}`, title: r.statusId || "" }, st.label) : null,
      h("span", { class: "num" }, ticketNumber(r.id)),
      h("span", { class: "subj", title: r.subject || "" }, r.subject || "(senza oggetto)"),
      arch ? h("span", { class: "tag-mini", title: `Nell'archivio locale (salvato il ${fmtDateTime(arch.savedAt)})` }, icon("archive")) : null,
      fav ? h("span", { class: "star-on", title: "Preferito" }, icon("star")) : null,
      h("span", { class: "when", title: when ? fmtDateTime(when) : "" }, fmtRelative(when))),
    meta.length ? h("div", { class: "meta" }, meta.flatMap((m, k) => [k ? h("span", { class: "sep" }, "·") : null, h("span", { title: m }, m)])) : null,
    snip ? h("div", { class: "snip" }, snip) : null);
  return el;
}

function tabBtn(key, label, n) {
  return h("button", { class: "tab" + (S.tab === key ? " on" : ""), onclick: () => { S.tab = key; S.cursor = -1; renderResults(); } }, label, n != null ? h("span", { class: "n" }, String(n)) : null);
}

function renderResults() {
  const el = $("#results");
  const top = el.scrollTop;
  clear(el);
  const fmtN = (n) => Number(n || 0).toLocaleString("it-IT");

  // intestazione
  const sortSel = h("select", { class: "input", title: "Ordina per", onchange: (e) => { S.sort.key = e.target.value; kvSet("sort", S.sort); search(); } },
    Object.entries(SORTS).map(([k, s]) => h("option", { value: k, selected: S.sort.key === k ? true : null }, s.label)));
  const dirBtn = h("button", { class: "btn btn-small", title: "Inverti l'ordine", onclick: () => { S.sort.dir = S.sort.dir === "DESC" ? "ASC" : "DESC"; kvSet("sort", S.sort); search(); } },
    icon("sort"), S.sort.dir === "DESC" ? "Dal più recente" : "Dal più vecchio");
  const countText = S.tab === "results"
    ? (S.loading && !S.results.length ? "Cerco…" : `${fmtN(S.total)} ticket`)
    : S.tab === "archive" ? `${fmtN(S.archiveHits.length)} nell'archivio` : S.tab === "favorites" ? `${S.favorites.length} preferiti` : `${S.recent.length} recenti`;

  const head = h("div", { class: "res-head" },
    h("div", { class: "res-top" },
      h("button", { class: "btn btn-small" + (ui.showFilters ? " on" : ""), title: "Mostra/nascondi i filtri", onclick: toggleFilters }, icon("filter"), "Filtri"),
      h("div", { class: "res-count" }, countText,
        S.tab === "results" && S.results.length && S.total > S.results.length ? h("small", null, ` · ne vedi ${fmtN(S.results.length)}`) : null),
      S.tab === "results" ? [sortSel, dirBtn] : null),
    h("div", { class: "res-top", style: { marginTop: "6px" } },
      h("button", { class: "btn btn-small", onclick: saveSearchDialog, title: "Salva questi filtri per riusarli" }, icon("save"), "Salva ricerca"),
      h("button", { class: "btn btn-small", onclick: exportCsv, disabled: !S.total || S.job ? true : null, title: "Scarica i risultati in un file per Excel (max 1000)" }, icon("download"), "Excel (CSV)"),
      h("button", { class: "btn btn-small", onclick: archiveResults, disabled: !S.total || S.job ? true : null, title: "Salva nel browser i ticket trovati con tutta la conversazione, per cercare nel testo dei messaggi" }, icon("archive"), "Archivia risultati"),
      h("button", { class: "btn btn-small", onclick: () => search(), title: "Aggiorna" }, icon("reload"))),
    h("div", { class: "tabs" },
      tabBtn("results", "Risultati", S.total ? fmtN(S.total) : null),
      tabBtn("archive", "Archivio locale", S.filters.text ? S.archiveHits.length : null),
      tabBtn("favorites", "Preferiti", S.favorites.length || null),
      tabBtn("recent", "Recenti", S.recent.length || null)));

  const chips = describeFilters(S.filters);
  if (chips.length && (S.tab === "results" || S.tab === "archive")) {
    head.appendChild(h("div", { class: "chips" },
      chips.map((c) => h("span", { class: "chip", title: c.label }, h("span", null, c.label),
        h("button", { title: "Togli questo filtro", onclick: () => clearFilterKey(c.key) }, "×"))),
      chips.length > 1 ? h("button", { class: "linkbtn", onclick: resetFilters }, "Azzera tutto") : null));
  }
  el.appendChild(head);

  // avvisi, lavori in corso, errori
  if (S.job) el.appendChild(jobBox());
  if (S.tab === "results") {
    for (const n of S.notices) {
      if (n && typeof n === "object" && n.text) {
        el.appendChild(
          h("div", { class: "notice", style: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" } },
            h("span", { style: { flex: "1", minWidth: "200px" } }, n.text),
            n.action ? h("button", { class: "btn btn-small", onclick: n.action }, n.actionLabel || "Riprova") : null)
        );
      } else {
        el.appendChild(h("div", { class: "notice" }, n));
      }
    }
    if (S.error) {
      const auth = S.error instanceof AuthError;
      el.appendChild(h("div", { class: "err-box" },
        auth ? "Non vedo una sessione attiva di HDA TOUCH. Apri il portale, esegui l'accesso e poi premi Riprova." : "La ricerca non è riuscita: " + S.error.message,
        h("div", null,
          auth ? h("button", { class: "btn", onclick: openTouchHome }, icon("external"), "Apri HDA TOUCH") : null, " ",
          h("button", { class: "btn", onclick: () => search() }, "Riprova"))));
    }
  }
  if (S.tab === "archive") {
    el.appendChild(h("div", { class: "notice" },
      S.archiveCount
        ? `L'archivio locale contiene ${fmtN(S.archiveCount)} ticket letti o archiviati, con tutto il testo delle conversazioni. La ricerca qui usa solo le parole scritte nella casella in alto (tutte devono comparire).`
        : "L'archivio locale è vuoto. Ogni ticket che apri viene salvato qui con tutta la conversazione; con «Archivia risultati» puoi salvarne molti insieme. Poi puoi cercare dentro il testo dei messaggi."));
  }

  const items = visibleItems();
  const list = h("div", { class: "list" });
  items.forEach((it, i) => list.appendChild(itemEl(it, i)));
  if (!items.length && !S.loading && !S.error) {
    const empty = {
      results: ["Nessun ticket trovato", "Prova a togliere qualche filtro o a cambiare le parole."],
      archive: [S.filters.text ? "Nessun ticket dell'archivio contiene queste parole" : "Scrivi una o più parole nella casella in alto", ""],
      favorites: ["Nessun preferito", "Apri un ticket e premi la stella per ritrovarlo qui."],
      recent: ["Nessun ticket aperto di recente", ""],
    }[S.tab];
    list.appendChild(h("div", { class: "empty-state" }, h("h3", null, empty[0]), empty[1]));
  }
  if (S.loading && S.tab === "results") list.appendChild(h("div", { class: "loading" }, h("span", { class: "spinner" }), S.results.length ? "Carico altri…" : "Cerco i ticket…"));
  if (S.tab === "results" && !S.loading && S.results.length < S.total)
    list.appendChild(h("button", { class: "btn more", onclick: () => search({ more: true }) }, `Mostra altri (${fmtN(S.total - S.results.length)} rimanenti)`));
  el.appendChild(list);

  const words = tokens(S.filters.text);
  if (words.length && !ticketIdFrom(S.filters.text)) highlight(list, words);
  el.scrollTop = top;
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
  id = ticketIdFrom(id) || String(id || "");
  if (!id) return;
  if (!force && S.current === id && !$("#reader").hidden) return;
  const my = ++openSeq;
  S.current = id;
  if (!row) row = S.results.find((r) => r.id === id) || null;
  $("#layout").classList.add("reading");
  for (const n of document.querySelectorAll("#results .item")) n.classList.toggle("sel", n.dataset.id === id);
  ui.readerSearch = "";
  renderReaderLoading(ctx, id, row);
  try {
    const full = await loadTicket(hda, id, { row, rowReader, conditionsFor: conditionsForId, caps: S.caps, log });
    kvSet("caps", S.caps);
    if (!full.row && !full.ticket && !full.items.length) throw new Error("ticket non trovato o non visibile con il tuo utente");
    addRecent(id, full.row);
    if (S.settings.archiveOnRead) {
      saveTicket(full)
        .then(() => { S.archived.set(id, { savedAt: Date.now(), lastChange: full.row && full.row.lastChange ? +full.row.lastChange : null }); refreshArchiveCount(); })
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
      rec = await getTicket(id);
    } catch {
      /* archivio non disponibile */
    }
    if (my !== openSeq) return;
    if (rec) renderReader(ctx, { id, row: rec.row, ticket: null, items: [], timeline: rec.timeline, notes: [] }, { fromArchive: rec.savedAt });
    else renderReaderError(ctx, id, row, e);
  }
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
  const f = S.activeEffectiveFilters || (isUnconstrained(S.filters) ? { ...S.filters, statuses: OPEN_STATUS_IDS } : S.filters);
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
  const job = (S.job = { label: "Preparo il file", done: 0, total: Math.min(S.total, 1000) });
  renderResults();
  try {
    const rows = await fetchAllRows(1000, job);
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
    toast(`File con ${rows.length} ticket scaricato${S.total > 1000 ? " (limite 1000)" : ""}`, "ok");
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
        const full = await loadTicket(hda, row.id, { row, rowReader, conditionsFor: conditionsForId, caps: S.caps, log });
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
  const items = [...document.querySelectorAll("#results .item")];
  if (!items.length) return;
  S.cursor = Math.max(0, Math.min(items.length - 1, (S.cursor < 0 ? (delta > 0 ? -1 : items.length) : S.cursor) + delta));
  const el = items[S.cursor];
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
  const [settings, savedUi, lastFilters, sort, saved, favorites, recent, learned, captures, caps, typesSeen] = await Promise.all([
    kvGet("settings", null), kvGet("ui", null), kvGet("lastFilters", null), kvGet("sort", null), kvGet("saved", []),
    kvGet("favorites", []), kvGet("recent", []), kvGet("learned", {}), kvGet("captures", []), kvGet("caps", {}), kvGet("typesSeen", {}),
  ]);
  Object.assign(S.settings, settings || {});
  Object.assign(ui, savedUi || {});
  ui.openSections = ui.openSections || {};
  if (lastFilters) S.filters = { ...emptyFilters(), ...lastFilters };
  if (sort && SORTS[sort.key]) S.sort = sort;
  Object.assign(S, { saved: saved || [], favorites: favorites || [], recent: recent || [], captures: captures || [], caps: caps || {}, typesSeen: typesSeen || {} });
  S.calib.learned = learned || {};
  if (S.caps.containsText) S.calib.containsText = S.caps.containsText;
  if (S.caps.fullTextRule) S.calib.overrides.text = { ...S.caps.fullTextRule, source: "calibrato" };

  transport = makeTransport({ log });
  hda = makeHda(transport, { lang: S.settings.lang });
  lookups = makeLookups(hda, { kvGet, kvSet, log });
  await lookups.restore();
  refreshArchiveCount();

  onKvChange((ch) => {
    if (ch.learned) S.calib.learned = ch.learned.newValue || {};
    if (ch.captures) S.captures = ch.captures.newValue || [];
    if (ch.learned || ch.captures) refreshSidebar();
  });

  $("#layout").classList.toggle("nofilters", !ui.showFilters);
  syncSearchBox();
  renderSidebar(ctx);
  renderResults();

  const onSearchInput = debounce(() => {
    const v = $("#q").value.trim();
    if (v !== S.filters.text) {
      S.filters.text = v;
      if (S.tab !== "results" && S.tab !== "archive") S.tab = "results";
      filtersChanged(true);
    }
  }, 550);
  $("#q").addEventListener("input", onSearchInput);
  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    S.filters.text = $("#q").value.trim();
    if (S.tab !== "results" && S.tab !== "archive") S.tab = "results";
    filtersChanged(true);
  });
  $("#conn").addEventListener("click", () => { if (S.connected === false) openTouchHome(); });
  $("#diagBtn").addEventListener("click", () => openDiag(ctx));
  $("#sidebar").addEventListener("focusout", (e) => {
    if (pendingSidebar && !(e.relatedTarget && $("#sidebar").contains(e.relatedTarget))) setTimeout(refreshSidebar, 0);
  });
  document.addEventListener("keydown", onKey);
  // tornando sulla scheda dopo aver fatto l'accesso a Touch si riprova da soli
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
  });

  if (await checkConnection()) {
    await start();
  } else {
    S.error = new AuthError();
    renderResults();
  }
}

await init().catch((e) => {
  log("avvio: " + e.message);
  document.getElementById("results").appendChild(h("div", { class: "err-box" }, "Errore all'avvio: " + e.message));
});
