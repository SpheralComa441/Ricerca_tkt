// Knowledge Base dell'Area Riservata (schede «SKB»): la stessa ricerca del Vecchio Cruscotto (servlet/spsl_fquery_mc)
// con l'area TICKET-TKB. Formato della richiesta e della risposta ricavati dalle richieste reali del portale:
//
//   pKeyword = CenSer:PAOW AND ( (AnnoUlt:2025 ) OR (AnnoUlt:2026 ) ) AND Lingua:ITA
//              AND (altDescription:(parola) OR description:(parola)) AND Stato:P AND FlgDefinitivo:1 AND Visibilita:E
//   pArea    = TICKET-TKB
//
// Ogni riga della risposta è una scheda: numero (id), titolo ("[SKB#123] [PRODOTTO] [gg-mm-aaaa] oggetto"), un estratto
// del testo con le parole trovate, date di pubblicazione e di ultima modifica, visibilità (E esterna, I interna),
// prodotto, versione, autore e l'indirizzo della scheda (jsp/sipv_ptkb_card.jsp).

import { queryTerms } from "./util.js";
import { htmlToText, cleanText } from "./richtext.js";
import { extractArJson, resolveArUrl, fmtSolrTerm, AR_BASE } from "./ar.js";

export const KB_AREA = "TICKET-TKB";
/** Il primo anno che il portale propone nel modulo di ricerca della Knowledge Base. */
export const KB_FIRST_YEAR = 2007;

export const KB_VISIBILITY = { E: "Esterna", I: "Interna" };

/**
 * Filtri della scheda Knowledge Base.
 * mode: come si cercano le parole ("all" tutte, "any" almeno una, "phrase" frase esatta);
 * dateRef: a quale data si riferisce il periodo ("ult" ultima modifica, "pub" pubblicazione);
 * visibility: "" tutte, "E" esterna, "I" interna; published: solo le schede pubblicate; definitive: solo le definitive.
 */
export function emptyKbFilters() {
  return { mode: "all", dateFrom: "", dateTo: "", dateRef: "ult", visibility: "", published: true, definitive: true };
}

/** Vero se c'è almeno un filtro scelto dall'operatore: allora si può cercare anche senza parole. */
export function hasKbFilter(f) {
  if (!f) return false;
  return !!(f.dateFrom || f.dateTo || f.visibility || f.published === false || f.definitive === false);
}

/** "SKB#12345", "skb 12345", "KB12345" → "12345". Un numero da solo no: è una parola da cercare (730, 2026…). */
export function kbNumberFrom(q) {
  const m = /^(?:s?kb|tkb)\s*[#:.-]?\s*(\d{1,7})$/i.exec(String(q || "").trim());
  return m ? String(Number(m[1])) : "";
}

/** ID di una scheda nell'app ("KB12345"): distinto dai numeri dei ticket. */
export const kbRowId = (n) => `KB${String(n || "").replace(/\D/g, "")}`;
export const isKbId = (id) => /^KB\d+$/i.test(String(id || "").trim());

/** Come si scrive il numero di una scheda: "SKB#12345". */
export function kbLabel(rowOrId) {
  const r = rowOrId && typeof rowOrId === "object" ? rowOrId : { id: rowOrId };
  const n = r.kbId || String(r.id || "").replace(/\D/g, "");
  return `${r.classe || "SKB"}#${n}`;
}

const yearOf = (day) => {
  const m = /^(\d{4})-\d{2}/.exec(String(day || ""));
  return m ? Number(m[1]) : 0;
};

/**
 * Gli anni da chiedere al portale per il periodo scelto (nessuno = senza periodo).
 * Il portale filtra per anno dell'ultima modifica (AnnoUlt); il giorno esatto si controlla poi sulle righe ricevute.
 * Per la data di pubblicazione si chiedono gli anni dal primo scelto a oggi: una scheda pubblicata in un anno
 * è stata modificata in quello o in uno successivo.
 */
export function kbYears(f, now = new Date()) {
  const a = yearOf(f && f.dateFrom);
  const b = yearOf(f && f.dateTo);
  if (!a && !b) return [];
  const thisYear = now.getFullYear();
  const first = Math.max(KB_FIRST_YEAR, a || KB_FIRST_YEAR);
  const last = f.dateRef === "pub" ? thisYear : Math.min(thisYear, b || thisYear);
  const out = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

/** Vero se la scheda cade nel periodo scelto (giorno per giorno, sulla data a cui il periodo si riferisce). */
export function inKbPeriod(row, f) {
  if (!f || (!f.dateFrom && !f.dateTo)) return true;
  const d = f.dateRef === "pub" ? row.date : row.lastChange;
  if (!(d instanceof Date) || isNaN(d)) return true;
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (f.dateFrom && day < f.dateFrom) return false;
  if (f.dateTo && day > f.dateTo) return false;
  return true;
}

/**
 * La ricerca da mandare al portale (pKeyword), scritta come la scrive il modulo della Knowledge Base.
 * number: solo la scheda con quel numero (gli altri filtri non contano); years: forza gli anni (ricerca divisa per anno).
 * Parole: in «tutte» ogni parola deve comparire nel testo o nel titolo (anche una nel titolo e l'altra nel testo),
 * con singolare e plurale; in «almeno una» ne basta una; «frase esatta» cerca le parole di seguito.
 */
export function buildKbQuery({ text = "", number = "", idCenSer = "", filters = null, years = null } = {}) {
  const F = { ...emptyKbFilters(), ...(filters || {}) };
  const parts = [];
  const cen = String(idCenSer || "").trim().toUpperCase();
  if (/^[A-Z0-9_]{2,12}$/.test(cen)) parts.push(`CenSer:${cen}`);
  const both = (expr) => `(altDescription:(${expr}) OR description:(${expr}))`;

  if (number) {
    const n = String(number).replace(/\D/g, "");
    if (!n) return "";
    // il titolo indicizzato comincia con il numero: "[SKB#12345] …"
    return [...parts, "Lingua:ITA", `(description:(${n}))`].join(" AND ");
  }

  const words = queryTerms(text);
  const ys = years || kbYears(F);
  if (!words.length && !hasKbFilter(F) && !ys.length) return "";
  if (ys.length) parts.push(`( ${ys.map((y) => `(AnnoUlt:${y} )`).join(" OR ")} )`);
  parts.push("Lingua:ITA");

  if (words.length) {
    if (F.mode === "phrase") {
      const p = words.join(" ").replace(/[()"\\:]/g, " ").replace(/\s+/g, " ").trim();
      if (p) parts.push(both(/\s/.test(p) ? `"${p}"` : fmtSolrTerm(p)));
    } else {
      const terms = words.map(fmtSolrTerm).filter(Boolean);
      if (F.mode === "any") {
        if (terms.length) parts.push(both(terms.join(" OR ")));
      } else {
        for (const t of terms) parts.push(both(t));
      }
    }
  }
  if (F.published !== false) parts.push("Stato:P");
  if (F.definitive !== false) parts.push("FlgDefinitivo:1");
  if (F.visibility === "E" || F.visibility === "I") parts.push(`Visibilita:${F.visibility}`);
  return parts.join(" AND ");
}

function dateFromParts(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!y || !m || !d) return null;
  const out = new Date(y, m - 1, d);
  return isNaN(out) ? null : out;
}

/**
 * Risposta di spsl_fquery_mc per l'area TICKET-TKB → righe per l'elenco dell'app.
 * → { rows, max (quante schede al massimo restituisce il portale), errors (indici che non hanno risposto) }
 */
export function parseKbResponse(raw) {
  const json = extractArJson(raw);
  const out = { rows: [], max: 0, errors: [] };
  if (!json || typeof json !== "object") return out;
  out.max = Number(Array.isArray(json.maxResults) ? json.maxResults[0] : 0) || 0;
  out.errors = Array.isArray(json.errors) ? json.errors.map(String) : [];
  const fields = Array.isArray(json.fields) ? json.fields : [];
  const data = Array.isArray(json.data) ? json.data : [];
  const seen = new Set();
  for (const r of data) {
    // l'ultima riga è la sentinella del portale ("t,CCCC…,-1")
    if (!Array.isArray(r) || !fields.length) continue;
    const o = {};
    fields.forEach((f, i) => (o[String(f).toLowerCase()] = r[i]));
    const str = (k) => String(o[k] == null ? "" : o[k]).trim();
    const desc = cleanText(htmlToText(str("description")));
    const dm = /\[([A-Z]{2,6})#(\d+)\]\s*(?:\[([^\]]*)\])?\s*(?:\[(\d{2})-(\d{2})-(\d{4})\])?\s*(.*)/.exec(desc);
    const kbId = (/^\d+$/.test(str("id")) && String(Number(str("id")))) || (dm ? String(Number(dm[2])) : "");
    if (!kbId || seen.has(kbId)) continue;
    seen.add(kbId);
    const classe = str("classe") || (dm ? dm[1] : "") || "SKB";
    const pub = dateFromParts(str("giornopub"), str("mesepub"), str("annopub")) || (dm && dm[6] ? dateFromParts(dm[4], dm[5], dm[6]) : null);
    const ult = dateFromParts(str("giornoult"), str("meseult"), str("annoult")) || pub;
    const oper = str("operatore").replace(/\D/g, "").replace(/^0+/, "");
    const stato = str("stato").toUpperCase();
    const vis = str("visibilita").toUpperCase();
    const product = str("prodtec") || str("prodcom").replace(/^\d+\|/, "") || (dm && dm[3]) || "";
    out.rows.push({
      id: kbRowId(kbId),
      kbId,
      classe,
      source: "kb",
      arUrl: resolveArUrl(str("url1") || str("urlpublic")),
      subject: cleanText(htmlToText(str("oggetto"))) || (dm && dm[7] ? dm[7].trim() : desc) || `Scheda ${classe}#${kbId}`,
      date: pub,
      lastChange: ult,
      statusId: "",
      statusText: "",
      stato,
      published: stato === "P",
      definitive: str("flgdefinitivo") === "1",
      visibility: vis,
      hasAttachments: str("flgallegati") === "1",
      typeText: str("tipologia"),
      catalog: product,
      version: str("versioni"),
      topic: "",
      cenSer: str("censer"),
      lang: str("lingua"),
      // il portale restituisce solo un estratto del testo, con le parole trovate
      problem: cleanText(htmlToText(str("altdescription"))),
      account: "",
      contact: "",
      ownerGroup: "",
      assigned: oper ? `Op. ${oper}` : "",
      assignedId: oper ? oper.padStart(15, "0") : "",
    });
  }
  return out;
}

/**
 * Scheda della Knowledge Base per il lettore dell'app.
 * detail: quanto letto dalla pagina della scheda nel portale ({ fields, texts, tables, attachments, bodyText }), se disponibile.
 * Senza, resta l'estratto arrivato con la ricerca e l'invito ad aprire la scheda nell'Area Riservata.
 */
export function buildKbDoc({ row, detail = null } = {}) {
  const r = { ...(row || {}) };
  const timeline = [];
  const seenText = new Set();
  const push = (label, text, extra = {}) => {
    const t = cleanText(text || "");
    if (!t) return;
    const sig = t.slice(0, 200).toLowerCase();
    if (seenText.has(sig)) return;
    seenText.add(sig);
    timeline.push({ kind: "doc", role: "operator", author: label || "", date: null, text: t, ...extra });
  };
  const extraFacts = [];
  const known = new Set([r.subject, r.catalog, r.version, r.kbId].filter(Boolean).map((v) => String(v).trim().toLowerCase()));

  let read = false;
  if (detail) {
    const fields = Array.isArray(detail.fields) ? detail.fields : [];
    const atts = Array.isArray(detail.attachments) ? detail.attachments : [];
    // 1. i campi di testo lunghi della scheda (problema, soluzione…), con la loro etichetta
    for (const [label, value] of Array.isArray(detail.texts) ? detail.texts : []) push(label || "Testo", value);
    // 2. il testo scritto nella pagina e nei suoi riquadri interni (il corpo della scheda sta di solito in uno di questi).
    //    Si tolgono le righe che sono solo etichette dei campi, nomi di allegati o testi già mostrati.
    const labels = new Set([...fields.map(([k]) => k), ...(detail.texts || []).map(([k]) => k), ...atts.map((a) => a.fileName), r.subject]
      .map((v) => String(v || "").replace(/[:\s*]+$/, "").trim().toLowerCase()).filter(Boolean));
    const bodies = Array.isArray(detail.bodies) && detail.bodies.length ? detail.bodies : [detail.bodyText || ""];
    bodies.forEach((body, i) => {
      const lines = String(body || "").split("\n").map((l) => l.trim()).filter((l) => l && !labels.has(l.replace(/[:\s*]+$/, "").toLowerCase()));
      const text = lines.join("\n");
      if (text.length >= 40) push(i === 0 ? "Testo della pagina" : "Testo della scheda", text);
    });
    read = timeline.length > 0;
    if (read) {
      for (const [k, v] of fields.slice(0, 24)) {
        const val = String(v || "").trim();
        if (!k || !val || known.has(val.toLowerCase())) continue;
        known.add(val.toLowerCase());
        extraFacts.push([String(k), val]);
      }
    }
  }
  const notes = [];
  if (!read) {
    push("Estratto dalla ricerca", r.problem);
    notes.push("Dal portale è arrivato solo un estratto: per leggere tutta la scheda premi «Apri nell'Area Riservata».");
  }
  if (r.visibility === "I") notes.unshift("Scheda a visibilità interna: non è visibile al cliente.");
  const attachments = (Array.isArray(detail && detail.attachments) ? detail.attachments : []).filter((a) => a && a.url);
  return { id: r.id, source: "kb", arUrl: r.arUrl || "", row: r, ticket: null, items: [], attachments, timeline, notes, extraFacts, complete: read };
}

/**
 * Client della Knowledge Base.
 * solr(query, area) → testo della risposta di spsl_fquery_mc; readDetail(url, opts) → pagina della scheda letta dal portale;
 * centro() → centro servizi dell'operatore (es. "PAOW").
 */
export function makeKb({ solr, readDetail = async () => null, centro = () => "", log = () => {} } = {}) {
  async function raw(query, info = {}) {
    const t0 = Date.now();
    const res = parseKbResponse(await solr(query, KB_AREA));
    info.max = res.max;
    info.raw = res.rows.length;
    if (res.errors.length) log(`knowledge base: il portale segnala indici non disponibili (${res.errors.join(", ")})`);
    log(`knowledge base: ${res.rows.length} schede (${Date.now() - t0} ms)`);
    return res.rows;
  }

  /** q: { text, filters } oppure { number }. info riceve query, max, raw. */
  async function search({ text = "", number = "", filters = null, years = null } = {}, info = {}) {
    const query = buildKbQuery({ text, number, idCenSer: centro(), filters, years });
    if (!query) return [];
    info.query = query;
    log(`knowledge base, ricerca: ${query}`);
    let rows = await raw(query, info);
    if (number) {
      const exact = rows.filter((r) => r.kbId === String(Number(number)));
      return exact.length ? exact : rows;
    }
    const c = centro();
    if (c) rows = rows.filter((r) => !r.cenSer || r.cenSer === c);
    return rows.filter((r) => inKbPeriod(r, filters));
  }

  /**
   * Oltre il limite del portale (210 schede per ricerca): la stessa ricerca un anno alla volta, dal più recente.
   * → { rows, queries, cappedYears (anni ancora troncati), cancelled }
   */
  async function searchAll(opts = {}, { onProgress = () => {}, isCancelled = () => false, now = new Date() } = {}) {
    const F = { ...emptyKbFilters(), ...(opts.filters || {}) };
    let years = kbYears(F, now);
    if (!years.length) for (let y = KB_FIRST_YEAR; y <= now.getFullYear(); y++) years.push(y);
    years = years.slice().reverse();
    const found = new Map();
    const cappedYears = [];
    let queries = 0;
    for (const y of years) {
      if (isCancelled()) return { rows: [...found.values()], queries, cappedYears, cancelled: true };
      const info = {};
      const rows = await search({ ...opts, number: "", filters: F, years: [y] }, info);
      queries++;
      if (info.max > 0 && info.raw >= info.max) cappedYears.push(y);
      for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
      onProgress({ rows: found.size, queries, left: years.length - queries });
    }
    return { rows: [...found.values()], queries, cappedYears };
  }

  /** La scheda completa: la riga della ricerca più il testo letto dalla sua pagina nel portale. */
  async function loadDoc(id, { row = null } = {}) {
    if (!row || !row.arUrl) {
      const n = String((row && row.kbId) || id || "").replace(/\D/g, "");
      const found = n ? await search({ number: n }) : [];
      const exact = found.find((r) => r.kbId === String(Number(n))) || null;
      if (exact) row = { ...(row || {}), ...exact };
    }
    if (!row || !row.id) throw new Error("scheda non trovata nella Knowledge Base");
    let detail = null;
    // solo pagine dell'Area Riservata: l'indirizzo arriva dalla risposta del portale o da una riga salvata
    if (row.arUrl && String(row.arUrl).startsWith(`${AR_BASE}/`)) {
      try {
        detail = await readDetail(row.arUrl, { deep: true });
      } catch (e) {
        log(`knowledge base, scheda ${kbLabel(row)}: ${e.message}`);
      }
    }
    if (!detail) log(`knowledge base, scheda ${kbLabel(row)}: pagina non letta (serve una scheda dell'Area Riservata aperta), mostro l'estratto`);
    return buildKbDoc({ row, detail });
  }

  return { search, searchAll, loadDoc };
}
