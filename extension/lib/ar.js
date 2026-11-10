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
  const cen =
    /\bw_IdCenSer\s*=\s*['"]([A-Z0-9_]{2,12})['"]/.exec(s) ||
    /\bIdCenSer:([A-Z0-9_]{2,12})\b/.exec(s);
  const area = /\bw_pArea\s*=\s*['"]([A-Z0-9_]{3,20})['"]/.exec(s);
  const m =
    /splResults\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s) ||
    /['"]spsl_fquery_mc['"][\s\S]{0,400}?\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s) ||
    (!s.includes("sipv_ffilters_search_testo") && /\bm_cID\s*[=:]\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s));
  return {
    mcid: m ? m[1] : null,
    idCenSer: cen ? cen[1] : "",
    pArea: area ? area[1] : "",
  };
}

function fmtSolrTerm(w) {
  const clean = String(w || "").replace(/[()"\\:]/g, " ").trim();
  if (!clean) return "";
  if (/\s/.test(clean)) return `"${clean}"`;
  if (/^[A-Za-z0-9\u00C0-\u017F]{3,}$/.test(clean)) return `${clean} or ${clean}*`;
  return clean;
}

/**
 * Costruisce la query Solr per servlet/spsl_fquery_mc (sintassi verificata dal portale Zucchetti).
 * Tutte le parole inserite sono concatenate con `and` così vengono trovati solo i ticket che le contengono tutte.
 * Per le parole singole di almeno 3 caratteri include anche il prefisso `parola*` (es. `voc` → `voc or voc*`),
 * così radici o parole troncate (es. "voc retributiv") trovano anche "voce", "voci", "retributiva", ecc.
 */
export function buildArQuery({
  text = "",
  subject = "",
  ticketId = "",
  dateFrom = "",
  dateTo = "",
  idCenSer = "",
  groups = [],
  defaultYears = false,
  wideTicketId = false,
} = {}) {
  const parts = [];
  const safe = (w) => String(w || "").replace(/[()"\\:]/g, " ").trim();

  if (idCenSer) {
    parts.push(`IdCenSer:${safe(idCenSer)}`);
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
    } else if (yStart && yEnd && yEnd >= yStart) {
      // periodo lungo: si filtra per anno di apertura (IdAnnoA), come i mesi qui sopra (IdMeseA/IdAnnoA)
      const yParts = [];
      for (let y = Math.max(2015, yStart); y <= yEnd; y++) yParts.push(`(IdAnnoA:${y} )`);
      if (yParts.length) parts.push(`( ${yParts.join(" or ")} )`);
    }
  } else if (defaultYears && !ticketId) {
    const cy = new Date().getFullYear();
    parts.push(`( (IdAnnoM:${cy - 2} ) or (IdAnnoM:${cy - 1} ) or (IdAnnoM:${cy} ) )`);
  }

  const contentParts = [];
  if (ticketId) {
    const num = safe(ticketNumber(ticketId));
    if (num) {
      contentParts.push(wideTicketId ? `( NumTic:${num} or Testi:(${num}) or Oggetto:(${num}) )` : `NumTic:${num}`);
    }
  } else if (text) {
    for (const w of queryTerms(text)) {
      const sw = fmtSolrTerm(w);
      if (sw) contentParts.push(`( Testi:(${sw}) or Oggetto:(${sw}) )`);
    }
  }

  if (subject) {
    for (const w of queryTerms(subject)) {
      const sw = fmtSolrTerm(w);
      if (sw) contentParts.push(`Oggetto:(${sw})`);
    }
  }

  if (!contentParts.length) return "";
  // gruppo (es. "IdGruppo:10663", lo stesso filtro che usa la Ricerca rapida dell'Area Riservata)
  const grp = (groups || []).map((g) => String(g || "").replace(/\D/g, "")).filter(Boolean);
  if (grp.length === 1) contentParts.push(`IdGruppo:${grp[0]}`);
  else if (grp.length > 1) contentParts.push(`( ${grp.map((g) => `IdGruppo:${g}`).join(" or ")} )`);
  return [...parts, ...contentParts].join(" and ");
}

function parseArDate(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  // Formato DataApe: "2026-09-02 15:30:31.0"
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(s);
  if (iso) {
    const d = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] || 12),
      Number(iso[5] || 0),
      Number(iso[6] || 0),
    );
    return isNaN(d) ? null : d;
  }
  // Formato description: "02-09-2026"
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0);
    return isNaN(d) ? null : d;
  }
  return null;
}

/**
 * Estrae il payload JSON da `spsl_fquery_mc`, che può essere sia una pagina HTML
 * con commento `<!-- Function return value:{"data":[...],"fields":[...]} -->` sia JSON puro.
 */
export function extractArJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  const s = String(raw);
  // Regex greedy `[\s\S]*` così eventuali `-->` scritti dentro il testo di un ticket non troncano il JSON
  const m = /Function return value:\s*(\{[\s\S]*\})\s*-->/.exec(s);
  const candidate = m ? m[1].trim() : s.trim();
  if (!candidate || (!candidate.startsWith("{") && !candidate.startsWith("["))) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Converte la risposta di `spsl_fquery_mc` in righe compatibili con l'elenco di Ricerca TKT.
 */
export function parseArResponse(raw) {
  const json = extractArJson(raw);
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
        obj[String(f).toLowerCase()] = r[idx];
      });
    } else if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const [k, v] of Object.entries(r)) {
        obj[k] = v;
        obj[k.toLowerCase()] = v;
      }
    } else {
      // Scarta la riga sentinella finale di SitePainter ("t,CCCCCCCC..., -1")
      continue;
    }

    const desc = cleanText(htmlToText(String(obj.description || "")));
    const altDesc = cleanText(htmlToText(String(obj.altdescription || "")));
    const fullText = String(obj.testi || "");
    const url = obj.url1 || obj.urlpublic || "";
    const dm = /\[#(\d+)\]\s*(?:\[([^\]]*)\])?\s*(?:\[(\d{2}-\d{2}-\d{4})\])?\s*(.*)/.exec(desc);

    const numTic = String(obj.numtic || "").trim();
    const id =
      (/^\d+$/.test(numTic) && numTic) ||
      (dm ? dm[1] : (String(obj.id || "").replace(/^0+/, "").match(/^\d{5,8}$/) || [])[0] || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const product = String(obj.idprodotto || (dm && dm[2]) || "").trim();
    const date = parseArDate(obj.dataape) || (dm && dm[3] ? parseArDate(dm[3]) : null);
    const rawOggetto = cleanText(htmlToText(String(obj.oggetto || "")));
    const subject = rawOggetto || (dm && dm[4] ? dm[4].trim() : desc) || `Ticket #${id}`;
    const statoRaw = String(obj.idstato || "").trim().toUpperCase();
    const isClosed = statoRaw === "CLOSE" || String(obj.statobase || "").trim().toUpperCase() === "C";
    const statusText = isClosed
      ? "Chiuso (Vecchio cruscotto)"
      : statoRaw
        ? `${statoRaw} (Vecchio cruscotto)`
        : "Vecchio cruscotto";
    const tipologia = String(obj.idtipologia || obj.type || "").trim();
    const cenSer = String(obj.idcenser || "").trim();
    const gruppo = String(obj.idgruppo || "").trim();
    const ownerGroup = [cenSer, gruppo].filter(Boolean).join(" · ");
    const operatore = String(obj.idoperatore || "").replace(/^0+/, "").trim();
    const cliente = String(obj.idcliente || "").replace(/^0+/, "").trim();

    out.push({
      id,
      ttCodice: String(obj.id || "").trim(),
      source: "ar",
      arUrl: resolveArUrl(url),
      subject,
      catalog: product,
      date,
      lastChange: date,
      // S5 = "Chiuso" di Touch (S8 è "Feedback/Risposta ricevuta", uno stato aperto)
      statusId: isClosed ? "S5" : "AR",
      statusText,
      typeId: tipologia || "AR",
      typeText: tipologia ? `${tipologia} · Vecchio cruscotto` : "Vecchio cruscotto",
      priority: String(obj.idpriorita || "").trim(),
      problem: altDesc || cleanText(fullText.replace(/  +/g, " — ")),
      fullText,
      account: cliente ? `Cliente ${cliente}` : "",
      contact: "",
      ownerGroup,
      assigned: operatore ? `Op. ${operatore}` : "",
    });
  }
  return out;
}

/**
 * Divide il campo `Testi` di `spsl_fquery_mc` (dove Solr concatena i singoli messaggi del ticket
 * separandoli con doppi spazi ASCII `"  "`) in messaggi distinti per la conversazione.
 */
export function splitArTesti(fullText, subject = "") {
  const raw = String(fullText || "");
  if (!raw.trim()) return [];
  const rawParts = raw
    .split(/  +/)
    .map((p) => cleanText(p.replace(/\u00a0/g, " ")))
    .filter(Boolean);
  if (!rawParts.length) return [];

  const subjLow = String(subject || "").trim().toLowerCase();
  // Se il primo frammento ripete solo l'oggetto del ticket e ci sono altri messaggi, lo saltiamo
  const parts =
    rawParts.length > 1 && subjLow && rawParts[0].toLowerCase() === subjLow ? rawParts.slice(1) : rawParts;

  const isDispatcher = (t) => /^Ticket (?:pre)?assegnato dal dispatcher/i.test(t);
  const isAutoClose = (t) => /^Gentile cliente,\s*In riferimento alla richiesta di assistenza/i.test(t);

  // Troviamo l'indice del primo e dell'ultimo messaggio sostanziale (non di sistema)
  const substantiveIdxs = [];
  parts.forEach((p, idx) => {
    if (!isDispatcher(p) && !isAutoClose(p)) substantiveIdxs.push(idx);
  });
  const firstSub = substantiveIdxs.length ? substantiveIdxs[0] : -1;
  const lastSub = substantiveIdxs.length > 1 ? substantiveIdxs[substantiveIdxs.length - 1] : -1;

  const entries = [];
  let lastWasDispatcher = false;
  parts.forEach((p, idx) => {
    if (isDispatcher(p)) {
      if (lastWasDispatcher) return;
      lastWasDispatcher = true;
      entries.push({
        kind: "message",
        role: "system",
        internal: true,
        author: "Dispatcher automatico",
        text: p,
      });
      return;
    }
    lastWasDispatcher = false;
    if (isAutoClose(p)) {
      entries.push({
        kind: "message",
        role: "system",
        internal: true,
        author: "Chiusura automatica",
        text: p,
      });
      return;
    }
    if (idx === firstSub) {
      entries.push({
        kind: "request",
        role: "customer",
        author: "Richiesta iniziale",
        text: p,
      });
    } else if (idx === lastSub) {
      entries.push({
        kind: "solution",
        role: "operator",
        author: "Risposta / Soluzione",
        text: p,
      });
    } else {
      const posInSub = substantiveIdxs.indexOf(idx);
      const isCustomerReply = posInSub > 0 && posInSub % 2 === 0;
      entries.push({
        kind: "message",
        role: isCustomerReply ? "customer" : "operator",
        author: isCustomerReply ? "Replica cliente" : "Risposta operatore",
        text: p,
      });
    }
  });
  return entries;
}

/**
 * Combina la riga Solr e gli eventuali dati estratti dalla pagina JSP del vecchio cruscotto
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
    typeId: (row && row.typeId) || "AR",
    typeText: (row && row.typeText) || "Vecchio cruscotto",
    priority: (row && row.priority) || "",
    problem: (row && row.problem) || "",
    fullText: (row && row.fullText) || "",
    account: (row && row.account) || "",
    contact: (row && row.contact) || "",
    ownerGroup: (row && row.ownerGroup) || "",
    assigned: (row && row.assigned) || "",
  };

  const extraFacts = [];
  if (r.priority) extraFacts.push(["Priorità", r.priority]);
  if (row && row.ttCodice) extraFacts.push(["Codice scheda", row.ttCodice]);

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

  // 1. Se abbiamo il testo completo della conversazione da Solr (`Testi` in spsl_fquery_mc), lo dividiamo nei vari messaggi
  if (r.fullText) {
    for (const entry of splitArTesti(r.fullText, r.subject)) {
      pushEntry({
        ...entry,
        date: entry.kind === "request" ? r.date : null,
        account: r.account,
      });
    }
  }

  // 2. Eventuali campi testuali aggiuntivi dalla scheda JSP
  if (detail && Array.isArray(detail.texts) && detail.texts.length) {
    detail.texts.forEach(([label, val], idx) => {
      const ll = String(label || "").toLowerCase();
      let kind = "message";
      let role = "operator";
      if ((idx === 0 && !timeline.length) || /richiesta|problema|domanda|segnalazione|descrizione/.test(ll)) {
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

  // 3. Fallback sul riepilogo `problem` se non c'era `fullText`
  if (!timeline.length && r.problem) {
    pushEntry({
      kind: "request",
      date: r.date,
      role: "customer",
      author: r.contact || r.account || "Testo dal vecchio cruscotto",
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
  const attachments = Array.isArray(detail && detail.attachments) ? detail.attachments : [];
  return {
    id: cleanId,
    source: "ar",
    arUrl: r.arUrl,
    row: r,
    ticket: null,
    items: [],
    attachments,
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
  // dopo un collegamento diretto fallito non si riprova a ogni ricerca (sono 2-4 richieste in più):
  // si riprova dopo un minuto, o subito con checkStatus (al ritorno sulla scheda dell'app)
  const DIRECT_RETRY_MS = 60 * 1000;
  let directFailedAt = 0;

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
    // 1. La chiamata POST a spsl_wsolrresultsgrid_portlet.jsp con clientsideinclusion=true
    //    inizializza la portlet in sessione e restituisce `this.splResults.m_cID='...'`
    for (const portlet of ["spsl_wsolrresultsgrid_portlet.jsp", "gspl_wsolrresultsgrid_portlet.jsp"]) {
      try {
        const r = await fetchImpl(`${AR_BASE}/jsp/${portlet}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "clientsideinclusion=true",
        });
        if (!r.ok) continue;
        const info = extractMcidFromHtml(await r.text());
        if (info.idCenSer) state.idCenSer = info.idCenSer;
        if (info.pArea) state.pArea = info.pArea;
        if (info.mcid) {
          state.mcid = info.mcid;
          state.connected = true;
        }
      } catch {
        /* */
      }
    }
    // 2. Legge anche la pagina contenitore per eventuale w_IdCenSer / w_pArea
    if (!state.idCenSer || !state.mcid) {
      for (const url of [`${AR_BASE}/jsp/sipv_psearch_infi.jsp`, `${AR_BASE}/jsp/gspv_psearch.jsp`]) {
        try {
          const r = await fetchImpl(url, { credentials: "include" });
          if (!r.ok) continue;
          const info = extractMcidFromHtml(await r.text());
          if (info.idCenSer) state.idCenSer = info.idCenSer;
          if (info.pArea) state.pArea = info.pArea;
          if (info.mcid && !state.mcid) state.mcid = info.mcid;
        } catch {
          /* */
        }
      }
    }
    if (state.mcid) {
      state.connected = true;
      directFailedAt = 0;
      return true;
    }
    directFailedAt = Date.now();
    return false;
  }

  async function checkStatus() {
    directFailedAt = 0;
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

    if (!state.mcid && (!directFailedAt || Date.now() - directFailedAt > DIRECT_RETRY_MS)) await discoverDirect();
    if (!state.mcid || !fetchImpl) {
      state.connected = false;
      throw new Error("Vecchio cruscotto non collegato");
    }

    const doDirectPost = async () => {
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
      return await r.text();
    };

    let text = await doDirectPost();
    if (!extractArJson(text)) {
      state.mcid = null;
      if (await discoverDirect()) text = await doDirectPost();
    }
    const rows = parseArResponse(text);
    state.connected = true;
    log(`vecchio cruscotto: ${rows.length} risultati (${Date.now() - t0} ms, direct)`);
    return rows;
  }

  async function search({ text = "", subject = "", ticketId = "", dateFrom = "", dateTo = "", groups = [] } = {}) {
    const q1 = buildArQuery({
      text,
      subject,
      ticketId,
      dateFrom,
      dateTo,
      groups,
      idCenSer: state.idCenSer,
      defaultYears: false,
    });
    if (!q1) return [];
    let rows = await rawQuery(q1);
    if (!rows.length && (state.idCenSer || ticketId)) {
      // Riprova senza vincolo di centro di servizio o cercando il numero anche nel testo dei messaggi
      const q2 = buildArQuery({
        text,
        subject,
        ticketId,
        dateFrom,
        dateTo,
        groups,
        idCenSer: "",
        defaultYears: false,
        wideTicketId: !!ticketId,
      });
      if (q2 && q2 !== q1) rows = await rawQuery(q2);
    }
    // Se si cercano più parole, verifichiamo che TUTTE le parole compaiano nel ticket (oggetto, testo completo o riepilogo)
    const allWords = [...queryTerms(text), ...queryTerms(subject)];
    if (!ticketId && allWords.length > 1) {
      rows = rows.filter((r) =>
        matchesAllTokens(`${r.subject || ""} ${r.fullText || ""} ${r.problem || ""} ${r.catalog || ""}`, allWords),
      );
    }
    if (ticketId) {
      const num = ticketNumber(ticketId);
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
    if (!row || (!row.fullText && !row.arUrl && !row.problem)) {
      // solo il ticket con quel numero: gli altri risultati (che citano il numero nel testo) sono ticket diversi
      const found = await search({ ticketId: num });
      const exact = found.find((r) => r.id === num) || null;
      if (exact) row = { ...(row || {}), ...exact };
    }
    if (!row) throw new Error(`Ticket #${num} non trovato nel Vecchio Cruscotto`);
    let detail = null;
    // Se spsl_fquery_mc ci ha già restituito l'intera conversazione in `fullText` (colonna Testi),
    // mostriamo subito il ticket senza attendere il caricamento dell'iframe JSP.
    if (!row.fullText && row.arUrl) {
      try {
        detail = await readDetail(row.arUrl);
      } catch (e) {
        log(`dettaglio vecchio cruscotto #${num}: ${e.message}`);
      }
    }
    return buildArTicket({ id: num, row, detail });
  }

  /**
   * Richiesta di sola lettura a una pagina dell'Area Riservata (usata dallo Storico): prima dalla scheda
   * dell'Area Riservata aperta (stessa sessione del portale), altrimenti direttamente dall'estensione.
   * path: "/jsp/…" o "/servlet/…". Ritorna il testo della risposta.
   */
  async function request(path, { method = "GET", body = null } = {}) {
    if (!/^\/(jsp|servlet)\//.test(String(path || ""))) throw new Error("Percorso non ammesso");
    const viaTab = await sendBridge({ cmd: "fetch", path, method, body });
    if (viaTab && viaTab.ok && typeof viaTab.text === "string" && viaTab.status < 400) return viaTab.text;
    if (!fetchImpl) throw new Error("Area Riservata non raggiungibile");
    const r = await fetchImpl(`${AR_BASE}${path}`, {
      method,
      credentials: "include",
      headers: body != null ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {},
      body: body != null ? body : undefined,
    });
    if (!r.ok) throw new Error(`L'Area Riservata ha risposto ${r.status}`);
    return await r.text();
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
    request,
    openHome,
  };
}
