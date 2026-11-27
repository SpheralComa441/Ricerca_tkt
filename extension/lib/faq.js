// FAQ di HDA TOUCH (entità Faqs).
//
// Verificato sulle richieste reali di HD Touch (HAR del 27/11/2026):
//   POST /WSCView/ListData/Faqs             elenco filtrato e paginato (colonne c0…c11, senza filtro Domain)
//   POST /WSCView/List?Entity=Faqs          configurazione colonne e filtri (aliasExpressionMapping)
//   GET  /WSCView/HTMLPreview/<id>?Entity=Faq   anteprima HTML completa in sola lettura (Question + AnswerHTML)
//   POST /WSCView/ListData/Attachments      allegati con ViewID=AttachmentPreview (ParentObject=Faq)
//   GET  /WSCView/GetStaticSimpleList?entity=FaqStatuses
//   POST /WSCView/TreeData?entity=CatalogFolders
//
// Nota: i filtri Categoria e Tags non funzionano in HD Touch e vengono omessi.
// Le FAQ hanno una ricerca dedicata nella propria scheda (la barra principale non interroga le FAQ):
//  - una casella combinata che cerca in Domanda + Risposta (più parole, singolare/plurale, attinenza);
//  - le due caselle separate Domanda e Risposta come nel cruscotto di Touch, più tutti i filtri di Touch.

import { parseMsDate, queryTerms } from "./util.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "./richtext.js";
import { matchesAllTerms, sortByRelevance, searchTerms } from "./relevance.js";
import { normalizePreviewAttachment } from "./hda.js";
import { formatTouchMsDate } from "./kb.js";

/** Mappa colonne di riserva verificata da WSCView/List?Entity=Faqs. */
export const FAQ_FALLBACK_MAPPING = {
  c0: "Answer",
  c1: "Code",
  c2: "FAQINDEX",
  c3: "FaqStatus.StatusType",
  c4: "FaqStatus.TranslatedDescription",
  c5: "FirstUpdate",
  c6: "ID",
  c7: "Language.Description",
  c8: "PublishDate",
  c9: "Question",
  c10: "VisibleFrom",
  c11: "VisibleTo",
};

/** Stati verificati da GetStaticSimpleList?entity=FaqStatuses. */
export const FAQ_STATUSES = {
  "1": { id: "1", label: "Pubblicato", statusType: 2, tone: "pub" },
  "2": { id: "2", label: "Pubblicato internamente", statusType: 1, tone: "int" },
  "3": { id: "3", label: "Non Pubblicato", statusType: 0, tone: "draft" },
};

export function faqStatusInfo(statusTypeOrId, statusText = "") {
  const low = String(statusText || "").trim().toLowerCase();
  if (low.includes("interna")) return { id: "2", label: statusText || "Pubblicato internamente", tone: "int" };
  if (low.includes("non pub")) return { id: "3", label: statusText || "Non Pubblicato", tone: "draft" };
  if (low.includes("pubblic")) return { id: "1", label: statusText || "Pubblicato", tone: "pub" };
  const s = String(statusTypeOrId ?? "").trim();
  if (s === "2") return FAQ_STATUSES["1"];
  if (s === "1") return FAQ_STATUSES["2"];
  if (s === "0") return FAQ_STATUSES["3"];
  return { id: "", label: statusText || "FAQ", tone: "draft" };
}

/**
 * Filtri della scheda FAQ (tutti i filtri funzionanti di HD Touch + ricerca combinata `query`).
 * Categoria e Tags sono omessi come richiesto perché non funzionanti in HD Touch.
 */
export function emptyFaqFilters() {
  return {
    query: "",          // Ricerca combinata in Domanda + Risposta (più parole, singolare/plurale, attinenza)
    question: "",       // Domanda (filtro separato di Touch: Question op "in")
    answer: "",         // Risposta (filtro separato di Touch: Answer op "in")
    code: "",           // Codice (Code op "in")
    statuses: [],       // FaqStatusID (op "eq", "1|2")
    folders: [],        // Relations.CatalogFolder.ID (op "eq", array di {id, label})
    catalogItems: [],   // Relations.CatalogItem.ID (op "eq", array di {id, label})
    importance: "",     // FAQINDEX (op "ge", numerico)
    dateFrom: "",       // FirstUpdate (op "gt", "/Date(ms)/")
    dateTo: "",         // FirstUpdate (op "le", "/Date(ms)/")
    statusDateFrom: "", // FAQDTST — Data cambio stato (Da) (op "gt", "/Date(ms)/")
  };
}

/** Vero se almeno un filtro o testo di ricerca FAQ è impostato. */
export function hasFaqFilter(f) {
  if (!f) return false;
  return !!(
    String(f.query || "").trim() ||
    String(f.question || "").trim() ||
    String(f.answer || "").trim() ||
    String(f.code || "").trim() ||
    (f.statuses && f.statuses.length) ||
    (f.folders && f.folders.length) ||
    (f.catalogItems && f.catalogItems.length) ||
    String(f.importance ?? "").trim() !== "" ||
    f.dateFrom ||
    f.dateTo ||
    f.statusDateFrom
  );
}

/** ID univoco di una riga FAQ nell'app ("FAQ5757"): distinto da ticket e KB ("KB4243"). */
export const faqRowId = (n) => `FAQ${String(n || "").replace(/\D/g, "")}`;
export const isFaqId = (id) => /^FAQ\d+$/i.test(String(id || "").trim());
export const faqNumericId = (id) => String(id || "").replace(/^FAQ/i, "").replace(/\D/g, "");

/** Etichetta leggibile della FAQ: codice ("FAQ25598HR") oppure "FAQ#5757". */
export function faqLabel(rowOrId) {
  if (rowOrId && typeof rowOrId === "object") {
    const code = String(rowOrId.code || "").trim();
    if (code) return code;
    const n = rowOrId.faqId || faqNumericId(rowOrId.id);
    return n ? `FAQ#${n}` : String(rowOrId.id || "");
  }
  const s = String(rowOrId || "").trim();
  if (/^FAQ\d+[A-Z]+$/i.test(s)) return s.toUpperCase();
  const n = faqNumericId(s);
  return n ? `FAQ#${n}` : s;
}

const idList = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => String(typeof x === "object" && x ? x.id : x || "").trim())
    .filter(Boolean);

/**
 * Costruisce le condizioni HDA per POST /WSCView/ListData/Faqs.
 * Le caselle separate Domanda e Risposta usano op "in" (verificato negli HAR): con più parole
 * (non tra virgolette) si invia una condizione per parola in AND così le trova in qualsiasi ordine.
 */
export function buildFaqConditions(filters = null, { includeSeparateText = true } = {}) {
  const f = { ...emptyFaqFilters(), ...(filters || {}) };
  const out = [];

  if (f.dateFrom) {
    const v = formatTouchMsDate(f.dateFrom, false);
    if (v) out.push({ property: "FirstUpdate", value: v, op: "gt", id: "DateFromFilter" });
  }
  if (f.dateTo) {
    const v = formatTouchMsDate(f.dateTo, true);
    if (v) out.push({ property: "FirstUpdate", value: v, op: "le", id: "DateToFilter" });
  }

  if (includeSeparateText) {
    const qVal = String(f.question || "").replace(/\*/g, "").trim();
    if (qVal) {
      const terms = queryTerms(qVal);
      for (const t of terms.length ? terms : [qVal]) {
        out.push({ property: "Question", value: t, op: "in", id: "filterQuestion" });
      }
    }
    const aVal = String(f.answer || "").replace(/\*/g, "").trim();
    if (aVal) {
      const terms = queryTerms(aVal);
      for (const t of terms.length ? terms : [aVal]) {
        out.push({ property: "Answer", value: t, op: "in", id: "filterAnswer" });
      }
    }
  }

  const codeVal = String(f.code || "").trim();
  if (codeVal) out.push({ property: "Code", value: codeVal, op: "in", id: "filterCode" });

  const statuses = idList(f.statuses);
  if (statuses.length) out.push({ property: "FaqStatusID", value: statuses.join("|"), op: "eq", id: "filterStatus" });

  const folders = idList(f.folders);
  if (folders.length) out.push({ property: "Relations.CatalogFolder.ID", value: folders.join("|"), op: "eq", id: "filterCatalogFolderID" });

  const items = idList(f.catalogItems);
  if (items.length) out.push({ property: "Relations.CatalogItem.ID", value: items.join("|"), op: "eq", id: "filterCatalogItemID" });

  const impStr = String(f.importance ?? "").trim();
  if (impStr !== "" && !isNaN(Number(impStr))) {
    out.push({ property: "FAQINDEX", value: Number(impStr), op: "ge", id: "FAQImportance" });
  }

  if (f.statusDateFrom) {
    const v = formatTouchMsDate(f.statusDateFrom, false);
    if (v) out.push({ property: "FAQDTST", value: v, op: "gt", id: "DateCambioStatoFilter" });
  }

  return out;
}

const FAQ_FIELDS = {
  answer: { re: /^Answer$/, fb: "c0" },
  code: { re: /^Code$/, fb: "c1" },
  importance: { re: /^FAQINDEX$/, fb: "c2" },
  statusType: { re: /^FaqStatus\.StatusType$/, fb: "c3" },
  statusText: { re: /^FaqStatus\.(Translated)?Description$/, fb: "c4" },
  date: { re: /^FirstUpdate$/, fb: "c5", date: true },
  faqId: { re: /^ID$/, fb: "c6" },
  lang: { re: /^Language\.(Translated)?Description$/, fb: "c7" },
  publishDate: { re: /^PublishDate$/, fb: "c8", date: true },
  question: { re: /^Question$/, fb: "c9" },
  visibleFrom: { re: /^VisibleFrom$/, fb: "c10", date: true },
  visibleTo: { re: /^VisibleTo$/, fb: "c11", date: true },
};

/** Lettore delle righe di ListData/Faqs → righe normalizzate per elenco e lettore. */
export function makeFaqRowReader(mapping = null) {
  const map = mapping && Object.keys(mapping).length ? mapping : FAQ_FALLBACK_MAPPING;
  const entries = Object.entries(map);
  const alias = {};
  for (const [field, def] of Object.entries(FAQ_FIELDS)) {
    const hit = entries.find(([, expr]) => def.re.test(expr));
    alias[field] = hit ? hit[0] : def.fb;
  }

  function read(raw) {
    if (!raw || typeof raw !== "object") return null;
    const g = (k) => raw[alias[k]];
    const faqId = String(g("faqId") != null ? g("faqId") : "").trim();
    if (!faqId) return null;
    const statusText = String(g("statusText") || "").trim();
    const st = faqStatusInfo(g("statusType"), statusText);
    const created = parseMsDate(g("date"));
    const pub = parseMsDate(g("publishDate"));
    const visFrom = parseMsDate(g("visibleFrom"));
    const visTo = parseMsDate(g("visibleTo"));
    const qRaw = cleanText(String(g("question") || ""));
    const ansRaw = String(g("answer") || "");
    const answerText = isProbablyHtml(unescapeIfEscapedHtml(ansRaw)) ? htmlToText(ansRaw) : cleanText(ansRaw);
    const code = String(g("code") || "").trim();
    const impRaw = g("importance");
    const importance = impRaw != null && impRaw !== "" && !isNaN(Number(impRaw)) ? Number(impRaw) : null;

    return {
      id: faqRowId(faqId),
      faqId,
      code,
      source: "faq",
      subject: qRaw || (code ? `FAQ ${code}` : `FAQ #${faqId}`),
      problem: answerText,
      date: created || pub,
      lastChange: created || pub,
      publishDate: pub,
      visibleFrom: visFrom,
      visibleTo: visTo,
      statusId: st.id,
      statusText: st.label,
      statusTone: st.tone,
      lang: String(g("lang") || "").trim(),
      importance,
      hasAttachments: false,
      raw,
    };
  }

  return {
    read,
    alias,
    sortAlias: (field) => alias[field] || null,
  };
}

/**
 * Costruisce il documento FAQ completo per il lettore dell'app da HTMLPreview + lista allegati.
 */
export function buildFaqDoc({ row, preview = null, attachments = [] } = {}) {
  const d = (preview && preview.data) || {};
  const r = { ...(row || {}) };
  const question = cleanText(String(d.Question || r.subject || ""));
  if (question) r.subject = question;

  const attMap = new Map();
  for (const a of attachments || []) {
    const n = a && a.fileName && a.id ? a : normalizePreviewAttachment(a, "Faq", r.faqId);
    if (n) attMap.set(n.id, n);
  }
  const previewAtts = d.Data && Array.isArray(d.Data.Attachments) ? d.Data.Attachments : [];
  for (const a of previewAtts) {
    const n = normalizePreviewAttachment(a, "Faq", r.faqId);
    if (n && !attMap.has(n.id)) attMap.set(n.id, n);
  }
  const mergedAtts = [...attMap.values()];
  if (mergedAtts.length) r.hasAttachments = true;

  const ansHtmlRaw = d.AnswerHTML ? String(d.AnswerHTML) : "";
  const ansHtml = unescapeIfEscapedHtml(ansHtmlRaw);
  const hasHtml = !!ansHtml.trim();
  const ansText = hasHtml ? htmlToText(ansHtml) : cleanText(r.problem || "");

  const timeline = [];
  if (question) {
    timeline.push({
      kind: "question",
      role: "customer",
      author: "Domanda",
      date: r.date || null,
      html: null,
      text: question,
    });
  }
  if (hasHtml || ansText) {
    timeline.push({
      kind: "doc",
      role: "operator",
      author: "Risposta",
      date: r.publishDate || r.date || null,
      html: hasHtml ? ansHtml : null,
      text: ansText,
    });
  }

  const notes = [];
  const st = faqStatusInfo(r.statusId, r.statusText);
  if (st.tone === "int") notes.push("FAQ a visibilità interna (Pubblicato internamente): non è visibile al cliente.");
  else if (st.tone === "draft") notes.push("FAQ non pubblicata.");
  if (!hasHtml && ansText) {
    notes.push("Mostro l'estratto dell'elenco: premi «Apri in Touch» per la risposta completa.");
  }

  return {
    id: r.id || faqRowId(r.faqId),
    faqId: r.faqId || faqNumericId(r.id),
    source: "faq",
    row: r,
    ticket: null,
    items: [],
    attachments: mergedAtts,
    timeline,
    notes,
    extraFacts: [],
    complete: hasHtml,
  };
}

/**
 * Filtra e ordina le righe FAQ rispetto a `query` (casella combinata Domanda + Risposta).
 * Supporta più parole in qualsiasi ordine (anche una nella Domanda e una nella Risposta),
 * singolare/plurale (radice italiana), frasi tra virgolette e attinenza a fasce.
 * `deepMatchedIds`: ID trovati dal server su Answer oltre i 500 caratteri dell'estratto.
 */
export function filterAndRankFaqs(rows, query, { sort = { key: "relevance", dir: "DESC" }, deepMatchedIds = null } = {}) {
  const q = String(query || "").trim();
  let list = rows || [];
  if (q) {
    const terms = searchTerms(q);
    if (terms.length) {
      list = list.filter((r) => {
        const hay = `${r.subject || ""} ${r.fullAnswer || r.problem || ""} ${r.code || ""}`;
        if (matchesAllTerms(hay, q)) return true;
        // Se il server ha confermato una corrispondenza nel testo Answer oltre i 500 caratteri troncati
        if (deepMatchedIds && deepMatchedIds.has(r.faqId) && !r.fullAnswer) return true;
        return false;
      });
    }
    if (!sort || sort.key === "relevance") {
      // Usa fullAnswer se presente per il punteggio di attinenza
      const scored = list.map((r) => (r.fullAnswer && r.fullAnswer !== r.problem ? { ...r, problem: r.fullAnswer } : r));
      return sortByRelevance(scored, q);
    }
  }

  const key = sort && sort.key && sort.key !== "relevance" ? sort.key : "date";
  const dir = sort && sort.dir === "ASC" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (key === "importance") {
      const ia = a.importance ?? -1;
      const ib = b.importance ?? -1;
      if (ia !== ib) return (ia - ib) * dir;
    } else if (key === "id") {
      const ca = String(a.code || a.faqId || "");
      const cb = String(b.code || b.faqId || "");
      if (ca !== cb) return ca.localeCompare(cb) * dir;
    } else {
      const fKey = key === "publishDate" ? "publishDate" : "date";
      const da = a[fKey] instanceof Date ? a[fKey].getTime() : a.date instanceof Date ? a.date.getTime() : 0;
      const db = b[fKey] instanceof Date ? b[fKey].getTime() : b.date instanceof Date ? b.date.getTime() : 0;
      if (da !== db) return (da - db) * dir;
    }
    return 0;
  });
}

/**
 * Client FAQ di HDA TOUCH.
 * Gestisce sia la ricerca combinata Domanda+Risposta (con attinenza e singolare/plurale)
 * sia le caselle separate Domanda e Risposta + tutti i filtri funzionanti di Touch.
 */
export function makeFaq({ hda, log = () => {} } = {}) {
  let reader = makeFaqRowReader(null);
  let statuses = Object.values(FAQ_STATUSES);
  let metaLoaded = false;
  let projectionWorks = null; // null = non provato, true/false = esito
  const fullAnswers = new Map(); // faqId → testo completo della risposta (se Projection è disponibile)

  async function loadConfig() {
    try {
      const cfg = await hda.listConfig("Faqs");
      if (cfg && cfg.mapping && Object.keys(cfg.mapping).length) {
        reader = makeFaqRowReader(cfg.mapping);
        log(`FAQ config: ${Object.keys(cfg.mapping).length} colonne, ${(cfg.filters || []).length} filtri`);
      }
      return cfg;
    } catch (e) {
      log(`FAQ config: ${e.message} (uso mappa verificata)`);
      return null;
    }
  }

  async function loadMeta() {
    if (metaLoaded || !hda || typeof hda.staticSimpleList !== "function") return;
    metaLoaded = true;
    try {
      const st = await hda.staticSimpleList("FaqStatuses", 50);
      if (st.length) {
        statuses = st.map((x) => {
          const id = String(x.ID || "").trim();
          const lbl = String(x.ObjectDescription || x.Description || id).trim();
          const info = faqStatusInfo(id, lbl);
          return { id, label: lbl, tone: info.tone };
        });
      }
    } catch (e) {
      log(`FAQ stati: ${e.message}`);
    }
  }

  function sortSpec(sort = { key: "date", dir: "DESC" }) {
    const field = sort && sort.key === "publishDate" ? "publishDate" : sort && sort.key === "importance" ? "importance" : sort && sort.key === "id" ? "code" : "date";
    const prop = reader.sortAlias(field) || "c5";
    const dir = sort && sort.dir === "ASC" && sort.key !== "relevance" ? "ASC" : "DESC";
    return [{ property: prop, direction: dir }];
  }

  function readRows(rawRows) {
    return (rawRows || []).map((r) => reader.read(r)).filter(Boolean);
  }

  /** Legge tutte le pagine fino a maxRows (con ~168 FAQ totali basta 1 sola richiesta). */
  async function fetchPool(conditions, sort, { maxRows = 600, pageSize = 200, signal } = {}) {
    const out = [];
    let total = 0;
    const sSpec = sortSpec(sort);
    for (let page = 1; out.length < maxRows; page++) {
      const start = (page - 1) * pageSize;
      const res = await hda.listData("Faqs", { conditions, page, start, limit: pageSize, sort: sSpec, signal });
      total = Number(res.total) || 0;
      const batch = readRows(res.rows);
      out.push(...batch);
      if (!batch.length || out.length >= total || batch.length < pageSize) break;
    }
    return { rows: out, total: Math.max(total, out.length) };
  }

  /** Prova a leggere il testo completo delle risposte via Projection (per non perdere testo oltre i 500 caratteri). */
  async function enrichFullAnswers(rows, signal) {
    if (projectionWorks === false || !hda || typeof hda.projection !== "function") return;
    const missing = rows.filter((r) => r.faqId && !fullAnswers.has(r.faqId) && String(r.problem || "").length >= 480);
    if (!missing.length) {
      for (const r of rows) if (fullAnswers.has(r.faqId)) r.fullAnswer = fullAnswers.get(r.faqId);
      return;
    }
    try {
      const ids = missing.slice(0, 250).map((r) => r.faqId);
      const res = await hda.projection("Faq", [{ property: "ID", op: "in", value: ids.join("|") }], ["ID", "Answer"], 300, signal);
      projectionWorks = true;
      for (const p of res || []) {
        const fid = String(p.ID || "").trim();
        if (!fid) continue;
        const raw = String(p.Answer || "");
        const txt = isProbablyHtml(unescapeIfEscapedHtml(raw)) ? htmlToText(raw) : cleanText(raw);
        if (txt) fullAnswers.set(fid, txt);
      }
      for (const r of rows) if (fullAnswers.has(r.faqId)) r.fullAnswer = fullAnswers.get(r.faqId);
    } catch (e) {
      if (e && (e.name === "AuthError" || e.name === "AbortError")) throw e;
      projectionWorks = false;
      log(`FAQ risposte complete (Projection): ${e.message} (uso ricerca server su Answer)`);
    }
  }

  /**
   * Ricerca FAQ completa:
   *  - applica tutti i filtri di Touch lato server (incluse Domanda e Risposta separate);
   *  - se è compilata la casella combinata `query`, cerca sia in Domanda che in Risposta
   *    con più parole, singolare/plurale e ordinamento per attinenza (controllando anche
   *    le risposte lunghe oltre i 500 caratteri).
   */
  async function search({ filters = null, sort = { key: "relevance", dir: "DESC" }, page = 1, limit = 200, signal } = {}, info = {}) {
    const f = { ...emptyFaqFilters(), ...(filters || {}) };
    const q = String(f.query || "").trim();
    const conds = buildFaqConditions(f, { includeSeparateText: true });
    info.conditions = conds;

    if (!q) {
      const res = await hda.listData("Faqs", { conditions: conds, page, start: (page - 1) * limit, limit, sort: sortSpec(sort), signal });
      let rows = readRows(res.rows);
      // Se ci sono parole in Domanda o Risposta separata, ordina per attinenza se richiesto
      const sepQuery = [f.question, f.answer].filter(Boolean).join(" ").trim();
      if (sepQuery && sort && sort.key === "relevance") rows = filterAndRankFaqs(rows, "", { sort: { key: "date", dir: "DESC" } });
      log(`FAQ Touch: ${rows.length} di ${res.total} FAQ`);
      return { rows, total: Math.max(res.total || 0, rows.length) };
    }

    // Ricerca combinata: prendiamo tutte le FAQ compatibili coi filtri di Touch (es. 168 totali → 1 richiesta)
    const poolRes = await fetchPool(conds, { key: "date", dir: "DESC" }, { maxRows: 600, pageSize: 200, signal });
    const rows = poolRes.rows;

    // Arricchiamo le risposte troncate a 500 caratteri (via Projection oppure controllo server su Answer)
    await enrichFullAnswers(rows, signal);

    let deepMatchedIds = null;
    const terms = searchTerms(q);
    if (projectionWorks === false && terms.length && rows.some((r) => String(r.problem || "").length >= 480)) {
      // Fallback se Projection non è disponibile: chiediamo al server le FAQ che hanno la radice di ogni parola in Answer
      try {
        const answerConds = [
          ...conds,
          ...terms.map((t) => ({ property: "Answer", value: t.phrase ? t.text : t.stem || t.text, op: "in", id: "filterAnswer" })),
        ];
        const deep = await hda.listData("Faqs", { conditions: answerConds, page: 1, start: 0, limit: 200, sort: sortSpec({ key: "date", dir: "DESC" }), signal });
        deepMatchedIds = new Set(readRows(deep.rows).map((r) => r.faqId));
      } catch (e) {
        if (e && (e.name === "AuthError" || e.name === "AbortError")) throw e;
        log(`FAQ controllo risposte lunghe: ${e.message}`);
      }
    }

    const ranked = filterAndRankFaqs(rows, q, { sort, deepMatchedIds });
    log(`FAQ Touch (combinata «${q}»): ${ranked.length} su ${rows.length} FAQ`);
    return { rows: ranked, total: ranked.length, scannedTotal: poolRes.total };
  }

  /** Carica la FAQ completa (HTMLPreview + allegati) in sola lettura. */
  async function loadDoc(id, { row = null, signal } = {}) {
    const numId = (row && row.faqId) || faqNumericId(id);
    if (!numId) throw new Error("ID FAQ non valido");

    const fetchRow = row
      ? Promise.resolve(row)
      : hda
          .listData("Faqs", { conditions: [{ property: "ID", value: numId, op: "eq", id: "ID" }], limit: 1, signal })
          .then((r) => readRows(r.rows)[0] || null)
          .catch(() => null);

    const fetchPreview = typeof hda.htmlPreview === "function"
      ? hda.htmlPreview("Faq", numId, signal).catch((e) => {
          if (e && (e.name === "AuthError" || e.name === "AbortError")) throw e;
          log(`FAQ preview ${numId}: ${e.message}`);
          return null;
        })
      : Promise.resolve(null);

    const fetchAtts = typeof hda.listEntityAttachments === "function"
      ? hda.listEntityAttachments("Faq", numId, signal).catch((e) => {
          log(`FAQ allegati ${numId}: ${e.message}`);
          return [];
        })
      : Promise.resolve([]);

    const [resolvedRow, preview, attachments] = await Promise.all([fetchRow, fetchPreview, fetchAtts]);
    if (!resolvedRow && !preview) throw new Error("FAQ non trovata su HDA Touch");
    const baseRow = resolvedRow || { id: faqRowId(numId), faqId: numId, source: "faq" };
    return buildFaqDoc({ row: baseRow, preview, attachments });
  }

  return {
    search,
    loadDoc,
    loadConfig,
    loadMeta,
    get statuses() { return statuses; },
    setMapping(m) {
      if (m && Object.keys(m).length) reader = makeFaqRowReader(m);
    },
  };
}
