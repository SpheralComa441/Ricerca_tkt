// Connettore per il Vecchio Cruscotto (Area Riservata Zucchetti: www.zucchetti.it/areariservata).
// Permette di cercare e leggere i ticket storici a 5-7 cifre (es. 9018200, 8907717) direttamente in Ricerca TKT.

import { queryTerms, matchesAllTokens, ticketNumber } from "./util.js";
import { htmlToText, cleanText } from "./richtext.js";

export const AR_ORIGIN = "https://www.zucchetti.it";
export const AR_BASE = "https://www.zucchetti.it/areariservata";
export const AR_SEARCH_URL = "https://www.zucchetti.it/areariservata/jsp/sipv_psearch_infi.jsp";

export function resolveArUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("../")) return `${AR_BASE}/${s.slice(3)}`;
  if (s.startsWith("/")) return `${AR_ORIGIN}${s}`;
  return `${AR_BASE}/jsp/${s}`;
}

export function extractMcidFromHtml(html) {
  const s = String(html || "");
  const cen = /\bw_IdCenSer\s*=\s*['"]([A-Z0-9_]{2,12})['"]/.exec(s);
  const area = /\bw_pArea\s*=\s*['"]([A-Z0-9_]{3,20})['"]/.exec(s);
  const m =
    /splResults\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s) ||
    /\bm_cID\s*[=:]\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s);
  return {
    mcid: m ? m[1] : null,
    idCenSer: cen ? cen[1] : "",
    pArea: area ? area[1] : "",
  };
}

/**
 * Costruisce la query Solr per servlet/spsl_fquery_mc.
 * Tutte le parole inserite sono concatenate con `and` così vengono trovati solo i ticket che le contengono tutte.
 */
export function buildArQuery({ text = "", subject = "", ticketId = "", dateFrom = "", dateTo = "", idCenSer = "" } = {}) {
  const parts = [];
  const safe = (w) => String(w || "").replace(/"/g, "").trim();

  if (ticketId) {
    const num = safe(ticketNumber(ticketId));
    if (num) parts.push(`( Testi:("${num}") or Oggetto:("${num}") )`);
  } else if (text) {
    for (const w of queryTerms(text)) {
      const sw = safe(w);
      if (sw) parts.push(`( Testi:("${sw}") or Oggetto:("${sw}") )`);
    }
  }

  if (subject) {
    for (const w of queryTerms(subject)) {
      const sw = safe(w);
      if (sw) parts.push(`Oggetto:("${sw}")`);
    }
  }

  if (dateFrom || dateTo) {
    const df = dateFrom ? new Date(dateFrom) : null;
    const dt = dateTo ? new Date(dateTo) : null;
    const yStart = df && !isNaN(df) ? df.getFullYear() : dt && !isNaN(dt) ? dt.getFullYear() : null;
    const mStart = df && !isNaN(df) ? df.getMonth() + 1 : 1;
    const yEnd = dt && !isNaN(dt) ? dt.getFullYear() : df && !isNaN(df) ? df.getFullYear() : null;
    const mEnd = dt && !isNaN(dt) ? dt.getMonth() + 1 : 12;
    if (yStart && yEnd && (yEnd - yStart) * 12 + (mEnd - mStart) <= 36) {
      const mParts = [];
      for (let y = yStart; y <= yEnd; y++) {
        const m1 = y === yStart ? mStart : 1;
        const m2 = y === yEnd ? mEnd : 12;
        for (let m = m1; m <= m2; m++) mParts.push(`(IdMeseA:${m} and IdAnnoA:${y})`);
      }
      if (mParts.length) parts.push(`( ${mParts.join(" or ")} )`);
    }
  }

  if (!parts.length) return "";
  if (idCenSer && !ticketId) parts.push(`(IdCenSer:${safe(idCenSer)})`);
  return parts.join(" and ");
}

function parseArDate(ddmmyyyy) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(ddmmyyyy || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
  return isNaN(d) ? null : d;
}

/**
 * Converte la risposta JSON di `spsl_fquery_mc` in righe compatibili con l'elenco di Ricerca TKT.
 */
export function parseArResponse(raw) {
  let json = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t || (!t.startsWith("{") && !t.startsWith("["))) return [];
    try {
      json = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (!json || typeof json !== "object") return [];
  const fields = Array.isArray(json.fields) ? json.fields : [];
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  const out = [];
  const seen = new Set();

  for (const r of data) {
    let obj = {};
    if (Array.isArray(r) && fields.length) {
      fields.forEach((f, idx) => {
        obj[f] = r[idx];
      });
    } else if (r && typeof r === "object") {
      obj = r;
    } else {
      continue;
    }

    const desc = cleanText(htmlToText(String(obj.description || "")));
    const altDesc = cleanText(htmlToText(String(obj.altdescription || "")));
    const url = obj.url1 || obj.urlpublic || "";
    const dm = /\[#(\d+)\]\s*(?:\[([^\]]*)\])?\s*(?:\[(\d{2}-\d{2}-\d{4})\])?\s*(.*)/.exec(desc);

    const id = dm ? dm[1] : (String(obj.id || "").match(/\d{5,8}/) || [String(obj.id || "")])[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const product = dm && dm[2] ? dm[2].trim() : "";
    const date = dm && dm[3] ? parseArDate(dm[3]) : null;
    const subject = (dm && dm[4] ? dm[4].trim() : desc) || `Ticket #${id}`;

    out.push({
      id,
      source: "ar",
      arUrl: resolveArUrl(url),
      subject,
      catalog: product,
      date,
      lastChange: date,
      statusId: "AR",
      statusText: "Vecchio cruscotto",
      typeId: "AR",
      typeText: String(obj.type || "Vecchio cruscotto").trim(),
      problem: altDesc,
      account: "",
      contact: "",
      ownerGroup: "",
      assigned: "",
    });
  }
  return out;
}

/**
 * Combina la riga Solr e i dati estratti dalla pagina JSP del vecchio cruscotto
 * nel formato `{ id, row, ticket, items, timeline, notes, source: "ar", arUrl, extraFacts }` per il lettore.
 */
export function buildArTicket({ id, row = null, detail = null } = {}) {
  const cleanId = ticketNumber(id || (row && row.id) || "");
  const r = {
    id: cleanId,
    source: "ar",
    arUrl: (detail && detail.url) || (row && row.arUrl) || "",
    subject: (row && row.subject) || (detail && detail.title) || `Ticket #${cleanId}`,
    catalog: (row && row.catalog) || "",
    date: (row && row.date) || null,
    lastChange: (row && row.lastChange) || (row && row.date) || null,
    statusId: (row && row.statusId) || "AR",
    statusText: (row && row.statusText) || "Vecchio cruscotto",
    typeId: "AR",
    typeText: (row && row.typeText) || "Vecchio cruscotto",
    problem: (row && row.problem) || "",
    account: (row && row.account) || "",
    contact: (row && row.contact) || "",
    ownerGroup: (row && row.ownerGroup) || "",
    assigned: (row && row.assigned) || "",
  };

  const extraFacts = [];
  if (detail && Array.isArray(detail.fields)) {
    for (const [k, v] of detail.fields) {
      const lk = String(k || "").toLowerCase();
      if (!r.account && /cliente|ragione\s*sociale|azienda|ditta/.test(lk)) r.account = v;
      else if (!r.contact && /contatto|riferimento|utente|richiedente/.test(lk)) r.contact = v;
      else if (!r.catalog && /prodotto|applicativo|modulo|procedura/.test(lk)) r.catalog = v;
      else if (!r.ownerGroup && /gruppo|centro|reparto/.test(lk)) r.ownerGroup = v;
      else if (!r.assigned && /operatore|assegnat|incaricat|analista/.test(lk)) r.assigned = v;
      else if (/^stato\b/.test(lk)) r.statusText = v;
      else if (/oggetto|titolo/.test(lk) && (!r.subject || r.subject === `Ticket #${cleanId}`)) r.subject = v;
      else extraFacts.push([k, v]);
    }
  }

  const timeline = [];
  const seenText = new Set();
  const pushEntry = (entry) => {
    const t = cleanText(entry.text || "");
    if (!t) return;
    const sig = t.slice(0, 160).toLowerCase();
    if (seenText.has(sig)) return;
    seenText.add(sig);
    timeline.push({ ...entry, text: t });
  };

  if (detail && Array.isArray(detail.texts) && detail.texts.length) {
    detail.texts.forEach(([label, val], idx) => {
      const ll = String(label || "").toLowerCase();
      let kind = "message";
      let role = "operator";
      if (idx === 0 || /richiesta|problema|domanda|segnalazione|descrizione/.test(ll)) {
        kind = "request";
        role = "customer";
      } else if (/soluzione|risposta|esito|chiusura/.test(ll)) {
        kind = "solution";
        role = "operator";
      }
      pushEntry({
        kind,
        date: kind === "request" ? r.date : null,
        role,
        author: label || (kind === "request" ? r.contact || r.account || "Cliente" : "Vecchio cruscotto"),
        account: r.account,
        text: val,
      });
    });
  }

  if (r.problem) {
    pushEntry({
      kind: timeline.length === 0 ? "request" : "message",
      date: r.date,
      role: timeline.length === 0 ? "customer" : "operator",
      author: timeline.length === 0 ? r.contact || r.account || "Testo dal vecchio cruscotto" : "Riepilogo Solr (Vecchio cruscotto)",
      account: r.account,
      text: r.problem,
    });
  }

  if (detail && Array.isArray(detail.tables)) {
    for (const tbl of detail.tables) {
      const lines = [];
      if (tbl.headers && tbl.headers.some(Boolean)) lines.push(tbl.headers.filter(Boolean).join(" · "));
      for (const tr of tbl.rows || []) {
        const line = tr.filter(Boolean).join(" — ");
        if (line) lines.push(line);
      }
      if (lines.length) {
        pushEntry({
          kind: "message",
          date: null,
          role: "system",
          author: "Tabella / Storico",
          text: lines.join("\n"),
        });
      }
    }
  }

  if (!timeline.length && detail && detail.bodyText) {
    pushEntry({
      kind: "request",
      date: r.date,
      role: "customer",
      author: r.contact || r.account || "Vecchio cruscotto",
      text: detail.bodyText,
    });
  }

  const notes = ["Ticket storico dal Vecchio Cruscotto (Area Riservata Zucchetti)."];
  return {
    id: cleanId,
    source: "ar",
    arUrl: r.arUrl,
    row: r,
    ticket: null,
    items: [],
    timeline,
    notes,
    extraFacts,
  };
}

/**
 * Client per il Vecchio Cruscotto: usa in priorità la scheda Area Riservata aperta tramite background.js,
 * con fallback a fetch diretto dall'estensione.
 */
export function makeAr({ log = () => {}, fetch: fetchImpl = globalThis.fetch } = {}) {
  const inExt = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
  const state = { connected: null, mcid: null, pArea: "TICKOPEXXX", idCenSer: "" };

  async function sendBridge(payload) {
    if (!inExt) return { error: "no-ext" };
    try {
      return (await chrome.runtime.sendMessage({ type: "ar-proxy", ...payload })) || { error: "empty" };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  async function discoverDirect() {
    if (!fetchImpl) return false;
    const pages = [
      `${AR_BASE}/jsp/sipv_psearch_infi.jsp`,
      `${AR_BASE}/jsp/gspv_psearch.jsp`,
      `${AR_BASE}/jsp/gspl_wsolrresultsgrid_portlet.jsp`,
    ];
    for (const url of pages) {
      try {
        const r = await fetchImpl(url, { credentials: "include" });
        if (!r.ok) continue;
        const info = extractMcidFromHtml(await r.text());
        if (info.idCenSer) state.idCenSer = info.idCenSer;
        if (info.pArea) state.pArea = info.pArea;
        if (info.mcid) {
          state.mcid = info.mcid;
          state.connected = true;
          return true;
        }
      } catch {
        /* */
      }
    }
    return false;
  }

  async function checkStatus() {
    const res = await sendBridge({ cmd: "status" });
    if (res && res.ok && res.mcid) {
      state.mcid = res.mcid;
      if (res.pArea) state.pArea = res.pArea;
      if (res.idCenSer) state.idCenSer = res.idCenSer;
      state.connected = true;
      return { connected: true, mode: "tab", idCenSer: state.idCenSer };
    }
    if (await discoverDirect()) {
      return { connected: true, mode: "direct", idCenSer: state.idCenSer };
    }
    state.connected = false;
    return { connected: false };
  }

  async function rawQuery(query) {
    if (!query) return [];
    const t0 = Date.now();
    const viaTab = await sendBridge({ cmd: "search", query, pArea: state.pArea });
    if (viaTab && viaTab.ok && viaTab.text) {
      if (viaTab.mcid) state.mcid = viaTab.mcid;
      if (viaTab.pArea) state.pArea = viaTab.pArea;
      if (viaTab.idCenSer) state.idCenSer = viaTab.idCenSer;
      const rows = parseArResponse(viaTab.text);
      state.connected = true;
      log(`vecchio cruscotto: ${rows.length} risultati (${Date.now() - t0} ms, scheda)`);
      return rows;
    }

    if (!state.mcid) await discoverDirect();
    if (!state.mcid || !fetchImpl) {
      state.connected = false;
      throw new Error("Vecchio cruscotto non collegato");
    }

    const body =
      `pKeyword=${encodeURIComponent(query)}` +
      `&pArea=${encodeURIComponent(state.pArea || "TICKOPEXXX")}` +
      `&pCore=&pLangs=ITA&cs_SITE=&m_cID=${encodeURIComponent(state.mcid)}`;
    const r = await fetchImpl(`${AR_BASE}/servlet/spsl_fquery_mc`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
    });
    const text = await r.text();
    const rows = parseArResponse(text);
    state.connected = true;
    log(`vecchio cruscotto: ${rows.length} risultati (${Date.now() - t0} ms, direct)`);
    return rows;
  }

  async function search({ text = "", subject = "", ticketId = "", dateFrom = "", dateTo = "" } = {}) {
    const q1 = buildArQuery({ text, subject, ticketId, dateFrom, dateTo, idCenSer: state.idCenSer });
    if (!q1) return [];
    let rows = await rawQuery(q1);
    if (!rows.length && state.idCenSer && !ticketId) {
      const q2 = buildArQuery({ text, subject, ticketId, dateFrom, dateTo, idCenSer: "" });
      if (q2 && q2 !== q1) rows = await rawQuery(q2);
    }
    // Se si cercano più parole, verifichiamo che tutte le parole compaiano nel risultato
    const allWords = [...queryTerms(text), ...queryTerms(subject)];
    if (!ticketId && allWords.length > 1) {
      rows = rows.filter((r) => matchesAllTokens(`${r.subject || ""} ${r.problem || ""} ${r.catalog || ""}`, allWords));
    }
    if (ticketId) {
      const num = ticketNumber(ticketId);
      // Mettiamo in cima il ticket con numero esatto
      rows.sort((a, b) => (a.id === num ? -1 : b.id === num ? 1 : 0));
    }
    return rows;
  }

  async function readDetail(url) {
    if (!url) return null;
    const res = await sendBridge({ cmd: "read", url });
    if (res && res.ok && res.data) return res.data;
    return null;
  }

  async function loadTicket(id, { row = null } = {}) {
    const num = ticketNumber(id);
    if (!row || (!row.arUrl && !row.problem)) {
      const found = await search({ ticketId: num });
      const exact = found.find((r) => r.id === num) || found[0] || null;
      if (exact) row = { ...(row || {}), ...exact };
    }
    if (!row) throw new Error(`Ticket #${num} non trovato nel Vecchio Cruscotto`);
    let detail = null;
    if (row.arUrl) {
      try {
        detail = await readDetail(row.arUrl);
      } catch (e) {
        log(`dettaglio vecchio cruscotto #${num}: ${e.message}`);
      }
    }
    return buildArTicket({ id: num, row, detail });
  }

  function openHome(url) {
    const target = resolveArUrl(url) || AR_SEARCH_URL;
    if (inExt && chrome.tabs) chrome.tabs.create({ url: target });
    else window.open(target, "_blank");
  }

  return {
    get state() {
      return state;
    },
    checkStatus,
    search,
    loadTicket,
    openHome,
  };
}
