// Storico (Ricerca avanzata dell'Area Riservata): tutti i ticket del Vecchio Cruscotto, anche degli anni
// che la ricerca per parole non copre più.
//
// Il portale la interroga così (richieste reali di gspv_psearch.jsp):
//   POST jsp/gspv_psearch_res.jsp  clientsideinclusion=true        → pagina con la "firma" (cmdhash) della query
//   POST servlet/SQLDataProviderServer  sqlcmd=gspv_qsearch_tickets&cmdhash=…&p_NumIni=…&p_DatIni=…  → righe JSON
//   GET  jsp/gspv_preview_ticket_frame_portlet.jsp?w_TTCODICE=…    → la conversazione del ticket
// Sola lettura. La ricerca avanzata NON cerca per parole (nel portale i campi oggetto/testo sono disattivati):
// si filtra per numero, periodo, cliente, gruppo e operatore.

import { AR_BASE } from "./ar.js";
import { cleanText, htmlToText, isProbablyHtml, unescapeIfEscapedHtml } from "./richtext.js";
import { ticketNumber } from "./util.js";

export const ST_QUERY = "gspv_qsearch_tickets";
export const ST_PAGE_SIZE = 50;
/** La scheda Storico parte dai ticket che il Vecchio Cruscotto non mostra più (fino a tutto il 2023). */
export const ST_DEFAULT_TO = "2023-12-31";
const ST_FIRST_DAY = "2000-01-01";

export function emptyStoricoFilters() {
  // dateRef: a quale data si riferisce il periodo ("1" ultimo aggiornamento, "2" apertura); statoBase: "" tutti, "A" aperti, "C" chiusi
  return { number: "", dateFrom: "", dateTo: ST_DEFAULT_TO, dateRef: "1", statoBase: "", clientCode: "", group: "", operator: null };
}

/** Vero se c'è almeno un filtro che restringe davvero (il solo periodo predefinito non basta). */
export function hasStoricoFilter(f) {
  if (!f) return false;
  return !!(String(f.number || "").trim() || f.dateFrom || String(f.clientCode || "").trim() || f.group || (f.operator && f.operator.id) || f.statoBase || (f.dateTo && f.dateTo !== ST_DEFAULT_TO));
}

const pad = (n) => String(n).padStart(2, "0");

/** "2023-12-31" → "2024-01-01": il portale manda come data finale il giorno dopo quello scelto. */
export function nextDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Codice cliente scritto a mano ("1234") → identificativo del portale ("000000000001234"). */
export function companyId(code) {
  const s = String(code || "").replace(/\D/g, "");
  return s ? s.padStart(15, "0").slice(-15) : "";
}

/** La firma della query dentro la pagina: new ZtVWeb._SQP(this,'nome','gspv_qsearch_tickets', …, '<hash>'); */
export function extractCmdHash(html, sqlcmd = ST_QUERY) {
  const re = new RegExp(`_SQP\\(this,'[^']*','${sqlcmd}'(?:,'[^']*')*?,'([0-9a-f]{20,40})'\\)`);
  const m = re.exec(String(html || ""));
  return m ? m[1] : "";
}

/**
 * Parametri della ricerca, nell'ordine e con i nomi usati dal portale.
 * Con il numero ticket il periodo non conta: si cerca su tutti gli anni.
 */
export function buildStoricoParams(f = {}, { centro = "", start = 0, rows = ST_PAGE_SIZE, cmdhash = "", count = true } = {}) {
  const num = ticketNumber(String(f.number || "").trim()).replace(/\D/g, "");
  // f.narrow: si conosce già il giorno del ticket (ricerca dei nomi per il Vecchio Cruscotto), quindi il periodo resta stretto
  const allYears = num && !f.narrow;
  const from = allYears ? ST_FIRST_DAY : f.dateFrom || ST_FIRST_DAY;
  const to = allYears ? today() : f.dateTo || today();
  return [
    ["rows", rows],
    ["startrow", start],
    ["count", count ? "true" : "false"],
    ["cmdhash", cmdhash],
    ["sqlcmd", ST_QUERY],
    ["orderby", "TTDATULT desc"],
    ["p_CentroServizi", centro],
    ["p_DatIni", from],
    ["p_DatFin", nextDay(to)],
    ["p_StatoDett", ""],
    ["p_StatoBase", num ? "" : f.statoBase === "A" || f.statoBase === "C" ? f.statoBase : ""],
    ["p_Priorita", ""],
    ["p_Tipologia", ""],
    ["p_DurataTot", 0],
    ["p_LavoroTot", 0],
    ["p_Azienda", companyId(f.clientCode)],
    ["p_Persona", ""],
    ["p_Argomento", ""],
    ["p_FlgArt", 0],
    ["p_GuidArt", ""],
    ["p_Operatore", (f.operator && f.operator.id) || ""],
    ["p_NumIni", num || 0],
    ["p_AlfTic", ""],
    ["p_Class", ""],
    ["p_RicercaPer", 3],
    ["p_Matricola", ""],
    ["w_SelCentre", centro],
    ["p_Gruppo", String(f.group || "").replace(/\D/g, "") || 0],
    ["p_DataRiferimento", f.dateRef === "2" ? 2 : 1],
    ["p_PersonaRif", ""],
    ["p_AziendaRif", ""],
    ["p_TicketRif", 0],
    ["p_TipoRif", ""],
    ["p_DatIniRif", "null"],
    ["p_DatFinRif", "null"],
    ["p_AliasFqSec", ""],
    ["p_AliasFqPri", ""],
    ["p_CodComm", ""],
    ["p_CodAttiv", ""],
    ["p_CenSerRif", ""],
    ["orderby", "TTDATULT desc"],
  ];
}

export function encodeParams(pairs) {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

/** "2026-10-08 12:19:23.0" → Date */
export function parseSqlDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  return isNaN(d) || d.getFullYear() < 1990 ? null : d;
}

/**
 * Risposta di SQLDataProviderServer: {"Fields":[…],"Data":[[…],[…],"tt,CCCN…,600123"]}.
 * L'ultima voce è una riga di servizio: in fondo c'è il totale (quando richiesto con count=true).
 */
export function parseSqlData(text) {
  let json;
  try {
    json = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!json || !Array.isArray(json.Fields) || !Array.isArray(json.Data)) return null;
  const rows = [];
  let total = -1;
  for (const r of json.Data) {
    if (Array.isArray(r)) {
      const o = {};
      json.Fields.forEach((f, i) => (o[f] = typeof r[i] === "string" ? r[i].trim() : r[i]));
      rows.push(o);
    } else if (typeof r === "string") {
      const m = /,(-?\d+)$/.exec(r);
      if (m) total = Number(m[1]);
    }
  }
  return { rows, total };
}

export function storicoCardUrl(ttCodice) {
  return ttCodice ? `${AR_BASE}/jsp/gspv_psearch_card.jsp?w_TTCODICE=${encodeURIComponent(ttCodice)}` : "";
}

/** Riga della ricerca avanzata → riga dell'elenco dell'app. */
export function storicoRow(o) {
  const id = String(o.TTNUMTIC || "").trim() + String(o.TTALFTIC || "").trim();
  if (!id) return null;
  const closed = String(o.TT_STATO || "").toUpperCase() === "CLOSE";
  const code = String(o.TTCODCOM || "").replace(/^0+/, "");
  return {
    id,
    ttCodice: String(o.TTCODICE || ""),
    source: "storico",
    arUrl: storicoCardUrl(o.TTCODICE),
    subject: cleanText(String(o.TTSHOTXT || "")) || `Ticket #${id}`,
    catalog: String(o.TTCODART_DES || o.TTCODART || ""),
    date: parseSqlDate(o.TTDATAPE),
    lastChange: parseSqlDate(o.TTDATULT) || parseSqlDate(o.TTDATAPE),
    // S5 = "Chiuso" negli stati dell'app; gli altri stati dello storico si mostrano con la loro descrizione
    statusId: closed ? "S5" : "AR",
    statusText: String(o.STDESCRI || (closed ? "Chiuso" : "")),
    typeId: String(o.TTTIPTIC || "ST"),
    typeText: String(o.TTTIPTIC_DES || ""),
    priority: String(o.TTPRIORI_DES || ""),
    problem: "",
    account: String(o.TTCODCOM_DES || ""),
    customerCode: code,
    contact: String(o.TTULTCLI_DES || ""),
    ownerGroup: String(o.TTULTREG_DES || ""),
    ownerGroupId: String(o.TTULTREG || ""),
    assigned: String(o.TTULTREO_DES || ""),
    assignedId: String(o.TTULTREO || ""),
    topic: String(o.TTARGUMENT_DES || ""),
    archivedFlag: String(o.FLGSTORICO || "0") !== "0",
  };
}

// ---------------------------------------------------------------- lettura del ticket

/** Stringa letterale JavaScript (tra apici) → testo: \x2f, \', \\, \n, \uXXXX … */
export function unescapeJs(s) {
  return String(s || "").replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, e) => {
    if (e[0] === "x" || e[0] === "u") return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t", b: "", f: "", v: "", 0: "" }[e] ?? e;
  });
}

const VC_RE = /this\.(\w+)=new ZtVWeb\._VC\(this,'\w+',null,'(\w+)',(?:'((?:[^'\\]|\\[\s\S])*)'|([^)]*))\)/g;

/** "19-06-2025 17:50" → Date */
export function parsePreviewDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  return isNaN(d) ? null : d;
}

/**
 * Pagina di anteprima del ticket → i suoi movimenti. Ogni movimento è un riquadro "gspv_preview_ticket_d"
 * con le sue variabili: this.DT_TESTO=new ZtVWeb._VC(this,'DT_TESTO',null,'character','…').
 */
export function parsePreview(html) {
  const out = [];
  const scripts = String(html || "").split(/<script[^>]*>/i).slice(1);
  for (const chunk of scripts) {
    const s = chunk.split(/<\/script>/i)[0];
    if (!/addPortlet\('\w+','gspv_preview_ticket_d'\)/.test(s)) continue;
    const v = {};
    for (const m of s.matchAll(VC_RE)) v[m[1]] = m[3] != null ? unescapeJs(m[3]) : String(m[4] || "").trim();
    if (!v.DTSERIAL && !v.DTDATA) continue;
    const hash = (/_SQP\(this,'dtjAttach','gspv_qviewallegati_ope'(?:,'[^']*')*?,'([0-9a-f]{20,40})'\)/.exec(s) || [])[1] || "";
    out.push({ ...v, attachHash: hash });
  }
  return out;
}

/** Percorso servlet Area Riservata per anteprima/download diretto di un allegato (verificato da gspv_qviewallegati_ope). */
export function storicoAttachmentPath(vfId, vfAuth) {
  const id = String(vfId || "").trim();
  const auth = String(vfAuth || "").trim();
  return id && auth ? `/servlet/gsdm_btlk_openfile?p_VFCODICEID=${encodeURIComponent(id)}&p_VFAUTHCODE=${encodeURIComponent(auth)}` : "";
}

/** Converte VFSIZE dell'Area Riservata ("123,4 KB", "1,2 MB" o byte numerici) in KB. */
export function parseArSizeKb(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /^([\d.,]+)\s*(kb|mb|b)?$/i.exec(s);
  if (!m) return null;
  const num = Number(m[1].replace(/\./g, (d, off, str) => (str.includes(",") ? "" : d)).replace(",", "."));
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "mb") return num * 1024;
  if (unit === "kb") return num;
  if (unit === "b") return num / 1024;
  return num > 1024 ? num / 1024 : num;
}

/** Movimenti dell'anteprima → conversazione nel formato del lettore (con allegati associati al singolo movimento). */
export function previewTimeline(moves, row = {}, attachments = []) {
  const bySerial = new Map();
  for (const a of attachments || []) {
    if (!a || !a.serial) continue;
    const key = String(a.serial).trim();
    if (!bySerial.has(key)) bySerial.set(key, []);
    bySerial.get(key).push(a);
  }
  const timeline = [];
  moves.forEach((v, i) => {
    const mit = Number(v.DTTIPMIT) || 0; // 1 = centro servizi, 2 = cliente
    const des = Number(v.DTTIPDES) || 0;
    const fromCustomer = mit === 2;
    const sender = [v.DTMITPER_DESC, !fromCustomer && v.MITGRU_DES && v.MITGRU_DES !== v.DTMITPER_DESC ? `(${v.MITGRU_DES})` : ""].filter(Boolean).join(" ").trim();
    const dest = [v.DTDESPER_DESC, v.DESGRU_DES && v.DESGRU_DES !== v.DTDESPER_DESC ? `(${v.DESGRU_DES})` : ""].filter(Boolean).join(" ").trim();
    const raw = String(v.DT_TESTO || "").trim();
    // le risposte arrivate per posta sono HTML (a volte con i tag scritti come &lt;p&gt;)
    const asHtml = raw && isProbablyHtml(unescapeIfEscapedHtml(raw)) ? unescapeIfEscapedHtml(raw) : null;
    const text = asHtml ? htmlToText(asHtml) : raw;
    const cause = String(v.CRDESCRI || "").trim();
    const internal = !fromCustomer && des !== 2;
    const serial = String(v.DTSERIAL || "").trim();
    const msgAtts = serial ? bySerial.get(serial) || [] : [];
    timeline.push({
      kind: i === 0 ? "request" : "message",
      date: parsePreviewDate(v.DTDATA),
      role: fromCustomer ? "customer" : "operator",
      internal: i === 0 ? false : internal,
      author: sender || (fromCustomer ? row.contact || row.account || "Cliente" : "Operatore"),
      account: fromCustomer ? row.account || "" : "",
      label: cause,
      to: dest,
      html: asHtml,
      text: text || (cause ? `(${cause})` : ""),
      attachments: msgAtts.length || (Number(v.TOTALLEGSER) > 0 ? Number(v.TOTALLEGSER) : 0),
      attachmentItems: msgAtts,
      serial,
    });
  });
  return timeline;
}

export function buildStoricoTicket({ row, moves = [], attachments = [] }) {
  const last = moves[moves.length - 1] || {};
  const r = {
    ...row,
    statusText: row.statusText || last.STDESCRI || "",
    typeText: row.typeText || last.TRDESCRI || "",
    priority: row.priority || last.PRDESCRI || "",
  };
  const timeline = previewTimeline(moves, r, attachments);
  if (timeline.length && !r.problem) r.problem = cleanText(String(timeline[0].text || "")).slice(0, 500);
  const extraFacts = [];
  if (r.topic) extraFacts.push(["Argomento", r.topic]);
  if (r.customerCode) extraFacts.push(["Codice cliente", r.customerCode]);
  return {
    id: r.id,
    source: "storico",
    arUrl: r.arUrl,
    row: r,
    ticket: null,
    items: [],
    attachments,
    timeline,
    notes: ["Ticket letto dallo Storico (Ricerca avanzata dell'Area Riservata Zucchetti)."],
    extraFacts,
  };
}

/** Giorno "AAAA-MM-GG" spostato di n giorni. */
export function shiftDay(date, n) {
  const d = date instanceof Date ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + n) : null;
  return d && !isNaN(d) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "";
}

/** Filtri per ritrovare nello Storico un ticket di cui si conoscono numero e giorno di apertura (e, se c'è, il cliente). */
export function ticketLookupFilters({ number, date = null, clientCode = "" } = {}) {
  const f = { ...emptyStoricoFilters(), dateTo: "", number: String(number || ""), clientCode: String(clientCode || "") };
  const from = shiftDay(date, -1);
  if (!from) return f; // senza data si cerca il numero su tutti gli anni
  return { ...f, dateFrom: from, dateTo: shiftDay(date, 1), dateRef: "2", narrow: true };
}

/** Operatori del centro che compaiono nei movimenti: { "<id a 15 cifre>": "COGNOME NOME" }. */
export function movePeople(moves) {
  const out = {};
  const add = (id, name) => {
    const i = String(id || "").trim();
    const n = String(name || "").trim();
    if (/^\d{15}$/.test(i) && n) out[i] = n;
  };
  for (const v of moves || []) {
    if (Number(v.DTTIPMIT) === 1) add(v.DTMITPER, v.DTMITPER_DESC);
    if (Number(v.DTTIPDES) === 1) add(v.DTDESPER, v.DTDESPER_DESC);
  }
  return out;
}

/**
 * Ticket del Vecchio Cruscotto (letto dalla ricerca per parole, che riporta solo codici e il testo tutto attaccato)
 * completato con i dati veri del portale: `info` è la riga dello Storico (nomi di cliente, contatto, gruppo, operatore),
 * `moves` i movimenti della scheda (chi ha scritto ogni messaggio, a chi, quando).
 */
export function enrichArTicket(full, { info = null, moves = [], attachments = [] } = {}) {
  if (!full || (!info && !moves.length)) return full;
  const base = full.row || {};
  const firstCustomer = moves.find((v) => Number(v.DTTIPMIT) === 2);
  const last = moves[moves.length - 1] || {};
  const row = {
    ...base,
    account: (info && info.account) || base.account || "",
    contact: (info && info.contact) || base.contact || (firstCustomer && firstCustomer.DTMITPER_DESC) || "",
    ownerGroup: (info && info.ownerGroup) || base.ownerGroup || "",
    assigned: (info && info.assigned) || base.assigned || "",
    statusText: (info && info.statusText) || last.STDESCRI || base.statusText || "",
    typeText: (info && info.typeText) || last.TRDESCRI || base.typeText || "",
    priority: (info && info.priority) || last.PRDESCRI || base.priority || "",
    catalog: base.catalog || (info && info.catalog) || "",
    lastChange: (info && info.lastChange) || base.lastChange || null,
    topic: (info && info.topic) || base.topic || "",
  };
  const mergedAtts = attachments.length ? attachments : full.attachments || [];
  const timeline = moves.length ? previewTimeline(moves, row, mergedAtts) : full.timeline;
  const extraFacts = (full.extraFacts || []).filter(([k]) => k !== "Priorità" && k !== "Argomento");
  if (row.topic) extraFacts.unshift(["Argomento", row.topic]);
  return {
    ...full,
    row,
    timeline,
    attachments: mergedAtts,
    extraFacts,
    notes: moves.length
      ? ["Ticket del Vecchio Cruscotto (Area Riservata Zucchetti): conversazione letta dalla scheda del ticket."]
      : full.notes,
  };
}

// ---------------------------------------------------------------- client

export class StoricoError extends Error {}

/**
 * opts.request(path, { method, body }) → testo della risposta (dalla scheda dell'Area Riservata o diretta).
 * opts.centro() → centro servizi dell'operatore (es. "PAOW"), letto dal Vecchio Cruscotto.
 */
export function makeStorico({ log = () => {}, request, centro = () => "" } = {}) {
  const state = { connected: null, cmdhash: "" };

  async function ensureHash(force = false) {
    if (state.cmdhash && !force) return state.cmdhash;
    const html = await request("/jsp/gspv_psearch_res.jsp", { method: "POST", body: "clientsideinclusion=true" });
    const h = extractCmdHash(html);
    if (!h) {
      state.connected = false;
      throw new StoricoError("Storico non collegato: apri l'Area Riservata (Vecchio Cruscotto), esegui l'accesso e riprova.");
    }
    state.cmdhash = h;
    return h;
  }

  async function query(f, { start = 0, rows = ST_PAGE_SIZE, count = start === 0 } = {}) {
    const c = centro();
    if (!c) throw new StoricoError("Storico: non conosco il tuo centro servizi. Scrivilo in Diagnostica → Impostazioni → «Centro servizi dell'Area Riservata» (es. PAOW) e riprova.");
    const run = async (force) => {
      const cmdhash = await ensureHash(force);
      const body = encodeParams(buildStoricoParams(f, { centro: c, start, rows, cmdhash, count }));
      return parseSqlData(await request("/servlet/SQLDataProviderServer", { method: "POST", body }));
    };
    let data = await run(false);
    if (!data) data = await run(true); // firma scaduta o sessione nuova: si rilegge dalla pagina
    if (!data) {
      state.connected = false;
      throw new StoricoError("Lo Storico non ha risposto: apri l'Area Riservata, esegui l'accesso e riprova.");
    }
    state.connected = true;
    return data;
  }

  /** → { rows, total } (total = -1 se il portale non lo dice, cioè dalla seconda pagina in poi) */
  async function search(f, { start = 0, rows = ST_PAGE_SIZE } = {}) {
    const t0 = Date.now();
    const data = await query(f, { start, rows });
    const out = data.rows.map(storicoRow).filter(Boolean);
    log(`storico: ${out.length} righe${data.total >= 0 ? " su " + data.total : ""} (${Date.now() - t0} ms)`);
    return { rows: out, total: data.total };
  }

  async function loadAttachments(moves, row) {
    const withFiles = moves.filter((m) => Number(m.TOTALLEGSER) > 0 && m.attachHash && m.DTSERIAL).slice(0, 12);
    const seen = new Set();
    const out = [];
    for (const m of withFiles) {
      try {
        const body = encodeParams([
          ["rows", 20], ["startrow", 0], ["count", "false"], ["cmdhash", m.attachHash], ["sqlcmd", "gspv_qviewallegati_ope"],
          ["w_TTCODICE", m.DTCODTIC || row.ttCodice], ["w_TASERIALE", m.DTSERIAL],
        ]);
        const data = parseSqlData(await request("/servlet/SQLDataProviderServer", { method: "POST", body }));
        for (const a of (data && data.rows) || []) {
          const vfId = String(a.VFCODICEID || a.TACODFILE || "").trim();
          const vfAuth = String(a.VFAUTHCODE || "").trim();
          const key = vfId || String(a.TANOMEFILE || "").trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const arPath = storicoAttachmentPath(vfId, vfAuth);
          out.push({
            id: `st-${key}`,
            fileName: String(a.TANOMEFILE || `Allegato ${key}`).trim(),
            description: arPath ? "" : "Si apre dalla scheda del ticket nell'Area Riservata",
            contentType: "",
            author: "",
            sizeKb: parseArSizeKb(a.VFSIZE),
            date: parseSqlDate(a.DT__DATA),
            parentObject: "Storico",
            parentObjectId: row.id,
            serial: String(a.TASERIALE || m.DTSERIAL || "").trim(),
            arPath,
            url: arPath ? "" : row.arUrl,
          });
        }
      } catch (e) {
        log(`storico, allegati del movimento ${m.DTSERIAL}: ${e.message}`);
      }
    }
    return out;
  }

  /** I movimenti di un ticket dalla sua scheda (vale per ogni ticket del portale, anche quelli recenti del Vecchio Cruscotto). */
  async function loadMoves(ttCodice) {
    const html = await request(`/jsp/gspv_preview_ticket_frame_portlet.jsp?w_TTCODICE=${encodeURIComponent(ttCodice)}&OrderBy=${encodeURIComponent("DT__DATA ASC")}`, { method: "GET" });
    const moves = parsePreview(html);
    if (!moves.length && !/gspv_preview_ticket/.test(html)) {
      throw new StoricoError("Non riesco a leggere il ticket dallo Storico: apri l'Area Riservata, esegui l'accesso e riprova.");
    }
    return moves;
  }

  /**
   * La riga dello Storico di un ticket di cui si conoscono numero e giorno di apertura: una richiesta sola e stretta
   * (numero + giorno + cliente), senza conteggio. → riga oppure null se lo Storico non lo riporta.
   */
  async function findTicket({ number, date = null, clientCode = "" } = {}) {
    const num = ticketNumber(number);
    if (!num) return null;
    const data = await query(ticketLookupFilters({ number: num, date, clientCode }), { rows: 5, count: false });
    return data.rows.map(storicoRow).filter(Boolean).find((r) => r.id === num) || null;
  }

  async function loadTicket(id, { row = null } = {}) {
    const num = ticketNumber(id);
    if (!row || !row.ttCodice) {
      const found = await search({ ...emptyStoricoFilters(), number: num }, { rows: 5 });
      row = found.rows.find((r) => r.id === num) || null;
      if (!row) throw new StoricoError(`Ticket #${num} non trovato nello Storico`);
    }
    const moves = await loadMoves(row.ttCodice);
    const attachments = await loadAttachments(moves, row);
    state.connected = true;
    return buildStoricoTicket({ row, moves, attachments });
  }

  return {
    get state() { return state; },
    search,
    loadTicket,
    loadMoves,
    loadAttachments,
    findTicket,
  };
}
