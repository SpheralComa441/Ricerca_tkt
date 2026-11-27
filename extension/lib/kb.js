// Knowledge Base di HDA TOUCH (entità KBArticles).
//
// Verificato sulle richieste reali di HD Touch (HAR del 27/11/2026):
//   POST /WSCView/ListData/KBArticles       elenco filtrato e paginato (colonne c0…c15, senza filtro Domain)
//   POST /WSCView/List?Entity=KBArticles    configurazione colonne e filtri (aliasExpressionMapping)
//   GET  /WSCView/HTMLPreview/<id>?Entity=KBArticle   anteprima HTML completa in sola lettura (non blocca il record)
//   POST /WSCView/ListData/Attachments      allegati con ViewID=AttachmentPreview (ParentObject=KBArticle)
//   GET  /WSCView/GetStaticSimpleList?entity=KBArticleStatuses | KBArticleTypes | Languages
//   POST /WSCView/TreeData?entity=CatalogFolders

import { parseMsDate, queryTerms } from "./util.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "./richtext.js";
import { wildcardText } from "./filters.js";
import { normalizePreviewAttachment } from "./hda.js";

/** Mappa colonne di riserva verificata da WSCView/List?Entity=KBArticles. */
export const KB_FALLBACK_MAPPING = {
  c0: "Abstract",
  c1: "Code",
  c2: "FirstUpdate",
  c3: "ID",
  c4: "KB01.Name",
  c5: "KB02.Name",
  c6: "KB04.Description",
  c7: "KB07",
  c8: "KB11",
  c9: "KBArticleStatus",
  c10: "KBArticleStatus.ID",
  c11: "KBArticleStatus.TranslatedDescription",
  c12: "KBArticleType.Description",
  c13: "Language.Description",
  c14: "LastupdateUser.FullName",
  c15: "Title",
};

/** Stati verificati da GetStaticSimpleList?entity=KBArticleStatuses. */
export const KB_STATUSES = {
  "1": { id: "1", label: "Pubblicato", tone: "pub" },
  "3": { id: "3", label: "Pubblicato Internamente", tone: "int" },
  "2": { id: "2", label: "Non Pubblicato", tone: "draft" },
  "4": { id: "4", label: "Archiviato", tone: "arch" },
};

/** Tipi verificati da GetStaticSimpleList?entity=KBArticleTypes. */
export const KB_TYPES = {
  "1": "Informazione",
  "2": "Errore",
};

/** Lingue principali (verificate da GetStaticSimpleList?entity=Languages). */
export const KB_LANGUAGES_FALLBACK = [
  { id: "0", label: "Default" },
  { id: "1", label: "Italiano" },
  { id: "2", label: "English" },
  { id: "3", label: "Deutsch" },
  { id: "4", label: "Francais" },
  { id: "5", label: "Espanol" },
];

export function kbStatusInfo(statusId, statusText = "") {
  const sid = statusId != null ? String(statusId).trim() : "";
  if (sid && KB_STATUSES[sid]) return KB_STATUSES[sid];
  const low = String(statusText || "").trim().toLowerCase();
  if (low.includes("interna")) return { id: sid || "3", label: statusText || "Pubblicato Internamente", tone: "int" };
  if (low.includes("non pub")) return { id: sid || "2", label: statusText || "Non Pubblicato", tone: "draft" };
  if (low.includes("archiv")) return { id: sid || "4", label: statusText || "Archiviato", tone: "arch" };
  if (low.includes("pubblic")) return { id: sid || "1", label: statusText || "Pubblicato", tone: "pub" };
  return { id: sid, label: statusText || "Articolo", tone: "draft" };
}

/**
 * Filtri della scheda Knowledge Base (tutti i filtri funzionanti di HD Touch).
 * Tags è omesso perché vuoto/non editabile in HD Touch.
 */
export function emptyKbFilters() {
  return {
    title: "",          // Title (op: "in")
    code: "",           // Code (op: "eq")
    statuses: [],       // KBArticleStatusID (op: "eq", "1|3")
    types: [],          // KBArticleTypeID (op: "eq", "1|2")
    folders: [],        // Relations.CatalogFolder.ID (op: "eq", array di {id, label})
    topics: [],         // KB04 — Argomento / CatalogItem (op: "eq", array di {id, label})
    languages: [],      // LanguageID (op: "eq", array di ID)
    products: [],       // KB01 — Prodotto / Service (op: "eq", array di {id, label})
    version: "",        // KB02 — Versione Prodotto (op: "in")
    dateFrom: "",       // FirstUpdate (op: "gt", "/Date(ms)/")
    dateTo: "",         // FirstUpdate (op: "le", "/Date(ms)/")
    hasAttachments: "", // Object.HASATTACH (op: "eq", "" | "true" | "false")
  };
}

/** Vero se almeno un filtro KB è impostato. */
export function hasKbFilter(f) {
  if (!f) return false;
  return !!(
    String(f.title || "").trim() ||
    String(f.code || "").trim() ||
    (f.statuses && f.statuses.length) ||
    (f.types && f.types.length) ||
    (f.folders && f.folders.length) ||
    (f.topics && f.topics.length) ||
    (f.languages && f.languages.length) ||
    (f.products && f.products.length) ||
    String(f.version || "").trim() ||
    f.dateFrom ||
    f.dateTo ||
    f.hasAttachments
  );
}

/**
 * Riconosce un codice o ID articolo KB nella casella di ricerca:
 *  - "KB12051HR", "KB4335Z", "KB25631HR" → { code: "KB12051HR" }
 *  - "KB#1102", "SKB#1102", "KB 1102"    → { kbId: "1102" }
 * Un numero puro (es. "730", "2026") NON è riconosciuto come KB: resta testo da cercare.
 */
export function kbCodeFrom(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  const code = /^(KB\d{2,8}[A-Z]{0,4})$/i.exec(s);
  if (code) return { code: code[1].toUpperCase() };
  const num = /^(?:s?kb|tkb)\s*[#:.-]\s*(\d{1,7})$/i.exec(s) || /^(?:s?kb|tkb)\s+(\d{1,7})$/i.exec(s);
  if (num) return { kbId: String(Number(num[1])) };
  return null;
}

/** ID univoco di una riga KB nell'app ("KB4243"): distinto dai numeri ticket e dalle FAQ ("FAQ5757"). */
export const kbRowId = (n) => `KB${String(n || "").replace(/\D/g, "")}`;
export const isKbId = (id) => /^KB\d+$/i.test(String(id || "").trim());
export const kbNumericId = (id) => String(id || "").replace(/^KB/i, "").replace(/\D/g, "");

/** Etichetta visibile del codice articolo: "KB25631HR" (o "KB#4243" se senza codice). */
export function kbLabel(rowOrId) {
  if (rowOrId && typeof rowOrId === "object") {
    const code = String(rowOrId.code || "").trim();
    if (code) return code;
    const n = rowOrId.kbId || kbNumericId(rowOrId.id);
    return n ? `KB#${n}` : String(rowOrId.id || "");
  }
  const s = String(rowOrId || "").trim();
  if (/^KB\d+[A-Z]+$/i.test(s)) return s.toUpperCase();
  const n = kbNumericId(s);
  return n ? `KB#${n}` : s;
}

/** Formato data "/Date(ms)/" usato da HD Touch per KBArticles e Faqs (verificato negli HAR). */
export function formatTouchMsDate(day, endOfDay = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || "").trim());
  if (!m) return "";
  const dt = endOfDay
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  return `/Date(${dt.getTime()})/`;
}

const idList = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => String(typeof x === "object" && x ? x.id : x || "").trim())
    .filter(Boolean);

/**
 * Costruisce le condizioni HDA per POST /WSCView/ListData/KBArticles.
 * textMode: "fulltext" (ricerca testo completo FullText op "eq") | "title" (Titolo op "in", senza asterisco) | "none".
 */
export function buildKbConditions({ text = "", filters = null, autoWildcard = true, textMode = "fulltext" } = {}) {
  const f = { ...emptyKbFilters(), ...(filters || {}) };
  const out = [];
  const rawText = String(text || "").trim();
  const ref = kbCodeFrom(rawText);

  // Codice articolo scritto nella barra in alto: cerca quell'articolo (ignora i filtri)
  if (ref && textMode !== "none") {
    if (ref.code) out.push({ property: "Code", value: ref.code, op: "eq", id: "CodeFilter" });
    else if (ref.kbId) out.push({ property: "ID", value: ref.kbId, op: "eq", id: "ID" });
    return out;
  }

  if (rawText && textMode === "fulltext") {
    const val = autoWildcard ? wildcardText(rawText) : rawText;
    if (val) out.push({ property: "FullText", value: val, op: "eq", id: "FullText" });
  } else if (rawText && textMode === "title") {
    // In Title (op: "in" = LIKE %val%) l'asterisco è letterale e non va inviato
    const cleaned = rawText.replace(/\*/g, "").trim();
    const terms = queryTerms(cleaned);
    for (const t of terms.length ? terms : cleaned ? [cleaned] : []) {
      out.push({ property: "Title", value: t, op: "in", id: "TitleFilter" });
    }
  }

  const titleVal = String(f.title || "").replace(/\*/g, "").trim();
  if (titleVal) {
    const terms = queryTerms(titleVal);
    for (const t of terms.length ? terms : [titleVal]) {
      out.push({ property: "Title", value: t, op: "in", id: "TitleFilter" });
    }
  }
  const codeVal = String(f.code || "").trim();
  if (codeVal) out.push({ property: "Code", value: codeVal, op: "eq", id: "CodeFilter" });

  const statuses = idList(f.statuses);
  if (statuses.length) out.push({ property: "KBArticleStatusID", value: statuses.join("|"), op: "eq", id: "StatusFilter" });

  const types = idList(f.types);
  if (types.length) out.push({ property: "KBArticleTypeID", value: types.join("|"), op: "eq", id: "TypeFilter" });

  const folders = idList(f.folders);
  if (folders.length) out.push({ property: "Relations.CatalogFolder.ID", value: folders.join("|"), op: "eq", id: "filterCatalogFolderIDKB" });

  const topics = idList(f.topics);
  if (topics.length) out.push({ property: "KB04", value: topics.join("|"), op: "eq", id: "filterCatalogItemIDKB" });

  const languages = idList(f.languages);
  if (languages.length) out.push({ property: "LanguageID", value: languages.join("|"), op: "eq", id: "LanguageIDFilter" });

  const products = idList(f.products);
  if (products.length) out.push({ property: "KB01", value: products.join("|"), op: "eq", id: "ServiceFilter" });

  const versionVal = String(f.version || "").trim();
  if (versionVal) out.push({ property: "KB02", value: versionVal, op: "in", id: "ServiceVerFilter" });

  if (f.dateFrom) {
    const v = formatTouchMsDate(f.dateFrom, false);
    if (v) out.push({ property: "FirstUpdate", value: v, op: "gt", id: "DateFromFilter" });
  }
  if (f.dateTo) {
    const v = formatTouchMsDate(f.dateTo, true);
    if (v) out.push({ property: "FirstUpdate", value: v, op: "le", id: "DateToFilter" });
  }
  if (f.hasAttachments === "true" || f.hasAttachments === "false") {
    out.push({ property: "Object.HASATTACH", value: f.hasAttachments, op: "eq", id: "HasAttachments" });
  }

  return out;
}

const KB_FIELDS = {
  abstract: { re: /^Abstract$/, fb: "c0" },
  code: { re: /^Code$/, fb: "c1" },
  date: { re: /^FirstUpdate$/, fb: "c2", date: true },
  kbId: { re: /^ID$/, fb: "c3" },
  product: { re: /^KB01(\.Name|\.TranslatedName)?$/, fb: "c4" },
  version: { re: /^KB02(\.Name)?$/, fb: "c5" },
  topic: { re: /^KB04(\.Description|\.TranslatedDescription)?$/, fb: "c6" },
  publishDate: { re: /^KB07$/, fb: "c7", date: true },
  kb11: { re: /^KB11$/, fb: "c8" },
  statusFallback: { re: /^KBArticleStatus$/, fb: "c9" },
  statusId: { re: /^KBArticleStatus\.ID$/, fb: "c10" },
  statusText: { re: /^KBArticleStatus\.(Translated)?Description$/, fb: "c11" },
  typeText: { re: /^KBArticleType\.(Translated)?Description$/, fb: "c12" },
  lang: { re: /^Language\.(Translated)?Description$/, fb: "c13" },
  assigned: { re: /^LastupdateUser\.FullName$/, fb: "c14" },
  subject: { re: /^Title$/, fb: "c15" },
};

/** Lettore delle righe di ListData/KBArticles → righe normalizzate per elenco e lettore. */
export function makeKbRowReader(mapping = null) {
  const map = mapping && Object.keys(mapping).length ? mapping : KB_FALLBACK_MAPPING;
  const entries = Object.entries(map);
  const alias = {};
  for (const [field, def] of Object.entries(KB_FIELDS)) {
    const hit = entries.find(([, expr]) => def.re.test(expr));
    alias[field] = hit ? hit[0] : def.fb;
  }

  function read(raw) {
    if (!raw || typeof raw !== "object") return null;
    const g = (k) => raw[alias[k]];
    const kbId = String(g("kbId") != null ? g("kbId") : "").trim();
    if (!kbId) return null;
    const statusId = g("statusId") != null ? String(g("statusId")).trim() : "";
    const statusText = String(g("statusText") || g("statusFallback") || "").trim();
    const st = kbStatusInfo(statusId, statusText);
    const created = parseMsDate(g("date"));
    const pub = parseMsDate(g("publishDate"));
    const absRaw = String(g("abstract") || "");
    const problem = isProbablyHtml(unescapeIfEscapedHtml(absRaw)) ? htmlToText(absRaw) : cleanText(absRaw);
    const code = String(g("code") || "").trim();
    const subject = cleanText(String(g("subject") || "")) || (code ? `Articolo ${code}` : `Articolo KB#${kbId}`);

    return {
      id: kbRowId(kbId),
      kbId,
      code,
      source: "kb",
      subject,
      problem,
      date: created || pub,
      lastChange: created || pub,
      publishDate: pub,
      statusId: st.id,
      statusText: st.label,
      statusTone: st.tone,
      typeText: String(g("typeText") || "").trim(),
      catalog: String(g("product") || "").trim(),
      version: String(g("version") || "").trim(),
      topic: String(g("topic") || "").trim(),
      lang: String(g("lang") || "").trim(),
      assigned: String(g("assigned") || "").trim(),
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
 * Costruisce il documento KB completo per il lettore dell'app da HTMLPreview + lista allegati.
 */
export function buildKbDoc({ row, preview = null, attachments = [] } = {}) {
  const d = (preview && preview.data) || {};
  const r = { ...(row || {}) };
  if (d.Title && !r.subject) r.subject = cleanText(String(d.Title));
  if (d.Code && !r.code) r.code = String(d.Code).trim();
  if (d.KB01name && !r.catalog) r.catalog = String(d.KB01name).trim();
  if (d.KB02 && !r.version) r.version = String(d.KB02).trim();
  if (d.KB04description && !r.topic) r.topic = String(d.KB04description).trim();
  if (d.KB07 && !r.publishDate) r.publishDate = parseMsDate(d.KB07);
  if (!r.date && r.publishDate) r.date = r.publishDate;
  if (!r.typeText && d.ObjectTypeID && KB_TYPES[String(d.ObjectTypeID)]) r.typeText = KB_TYPES[String(d.ObjectTypeID)];

  // Allegati: unione tra quelli completi di ListData/Attachments (con ContentType, dimensione, autore)
  // e quelli eventualmente elencati in HTMLPreview.data.Data.Attachments
  const attMap = new Map();
  for (const a of attachments || []) {
    const n = a && a.fileName && a.id ? a : normalizePreviewAttachment(a, "KBArticle", r.kbId);
    if (n) attMap.set(n.id, n);
  }
  const previewAtts = (d.Data && Array.isArray(d.Data.Attachments) ? d.Data.Attachments : []);
  for (const a of previewAtts) {
    const n = normalizePreviewAttachment(a, "KBArticle", r.kbId);
    if (n && !attMap.has(n.id)) attMap.set(n.id, n);
  }
  const mergedAtts = [...attMap.values()];
  if (mergedAtts.length) r.hasAttachments = true;

  // Articoli correlati da HTMLPreview (se presenti)
  const related = (d.Data && Array.isArray(d.Data.RelatedKBArticles) ? d.Data.RelatedKBArticles : [])
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const rid = String(x.ID || x.id || "").trim();
      if (!rid) return null;
      return { id: kbRowId(rid), kbId: rid, code: String(x.Code || "").trim(), title: cleanText(String(x.Title || x.ObjectDescription || `KB#${rid}`)) };
    })
    .filter(Boolean);

  const absHtml = d.AbstractHTML ? String(d.AbstractHTML) : "";
  const hasHtml = !!absHtml.trim();
  const text = hasHtml ? htmlToText(absHtml) : cleanText(r.problem || "");

  const timeline = [];
  if (hasHtml || text) {
    timeline.push({
      kind: "doc",
      role: "operator",
      author: "Articolo Knowledge Base",
      date: r.publishDate || r.date || null,
      html: hasHtml ? absHtml : null,
      text,
    });
  }

  const notes = [];
  const st = kbStatusInfo(r.statusId, r.statusText);
  if (st.tone === "int") notes.push("Articolo a visibilità interna (Pubblicato Internamente): non è visibile al cliente.");
  else if (st.tone === "draft") notes.push("Articolo non pubblicato.");
  else if (st.tone === "arch") notes.push("Articolo archiviato.");
  if (!hasHtml && text) {
    notes.push("Mostro l'anteprima dell'elenco: premi «Apri in Touch» se il testo risulta incompleto.");
  }

  return {
    id: r.id || kbRowId(r.kbId),
    kbId: r.kbId || kbNumericId(r.id),
    source: "kb",
    row: r,
    ticket: null,
    items: [],
    attachments: mergedAtts,
    related,
    timeline,
    notes,
    extraFacts: [],
    complete: hasHtml,
  };
}

/**
 * Client Knowledge Base di HDA TOUCH.
 * Usa solo servizi in sola lettura: ListData/KBArticles, List?Entity=KBArticles, HTMLPreview, ListData/Attachments.
 */
export function makeKb({ hda, log = () => {} } = {}) {
  let reader = makeKbRowReader(null);
  let statuses = Object.values(KB_STATUSES);
  let types = Object.entries(KB_TYPES).map(([id, label]) => ({ id, label }));
  let languages = [...KB_LANGUAGES_FALLBACK];
  let metaLoaded = false;

  async function loadConfig() {
    try {
      const cfg = await hda.listConfig("KBArticles");
      if (cfg && cfg.mapping && Object.keys(cfg.mapping).length) {
        reader = makeKbRowReader(cfg.mapping);
        log(`KB config: ${Object.keys(cfg.mapping).length} colonne, ${(cfg.filters || []).length} filtri`);
      }
      return cfg;
    } catch (e) {
      log(`KB config: ${e.message} (uso mappa verificata)`);
      return null;
    }
  }

  async function loadMeta() {
    if (metaLoaded || !hda || typeof hda.staticSimpleList !== "function") return;
    metaLoaded = true;
    const [st, ty, lg] = await Promise.allSettled([
      hda.staticSimpleList("KBArticleStatuses", 50),
      hda.staticSimpleList("KBArticleTypes", 50),
      hda.staticSimpleList("Languages", 50),
    ]);
    if (st.status === "fulfilled" && st.value.length) {
      statuses = st.value.map((x) => {
        const id = String(x.ID || "").trim();
        const lbl = String(x.ObjectDescription || x.Description || id).trim();
        const info = kbStatusInfo(id, lbl);
        return { id, label: lbl, tone: info.tone };
      });
    }
    if (ty.status === "fulfilled" && ty.value.length) {
      types = ty.value.map((x) => ({ id: String(x.ID || "").trim(), label: String(x.ObjectDescription || x.Description || x.ID).trim() }));
    }
    if (lg.status === "fulfilled" && lg.value.length) {
      languages = lg.value
        .map((x) => ({ id: String(x.ID ?? "").trim(), label: String(x.ObjectDescription || x.Description || x.ID).trim() }))
        .filter((x) => x.id !== "" && x.label);
    }
  }

  function sortSpec(sort = { key: "date", dir: "DESC" }) {
    const field = sort && sort.key === "publishDate" ? "publishDate" : sort && sort.key === "id" ? "code" : "date";
    const prop = reader.sortAlias(field) || "c2";
    const dir = sort && sort.dir === "ASC" && sort.key !== "relevance" ? "ASC" : "DESC";
    return [{ property: prop, direction: dir }];
  }

  function readRows(rawRows) {
    return (rawRows || []).map((r) => reader.read(r)).filter(Boolean);
  }

  /**
   * Ricerca KB su HDA Touch.
   * Con parole: cerca in parallelo su FullText (testo completo, con asterisco automatico se attivo)
   * e su Title (sottostringa), poi unisce senza doppioni così non si perde nessun articolo.
   */
  async function search({ text = "", filters = null, autoWildcard = true, browseAll = false, page = 1, limit = 100, sort = null, signal } = {}, info = {}) {
    const rawText = String(text || "").trim();
    const ref = kbCodeFrom(rawText);
    if (!rawText && !hasKbFilter(filters) && !browseAll) return { rows: [], total: 0 };

    const sSpec = sortSpec(sort);
    const start = (page - 1) * limit;

    if (ref) {
      const conds = buildKbConditions({ text: rawText, filters: null, textMode: "fulltext" });
      info.conditions = conds;
      const res = await hda.listData("KBArticles", { conditions: conds, page: 1, start: 0, limit: 25, sort: sSpec, signal });
      let rows = readRows(res.rows);
      if (!rows.length && ref.code) {
        // se il codice non corrisponde esattamente, proviamo come testo libero
        const ft = await hda.listData("KBArticles", {
          conditions: [{ property: "FullText", value: ref.code, op: "eq", id: "FullText" }],
          page: 1,
          start: 0,
          limit: 25,
          sort: sSpec,
          signal,
        });
        rows = readRows(ft.rows);
        return { rows, total: Math.max(ft.total || 0, rows.length) };
      }
      return { rows, total: Math.max(res.total || 0, rows.length) };
    }

    if (rawText && page === 1) {
      const ftConds = buildKbConditions({ text: rawText, filters, autoWildcard, textMode: "fulltext" });
      const titleConds = buildKbConditions({ text: rawText, filters, autoWildcard: false, textMode: "title" });
      info.conditions = ftConds;
      const [ftRes, titleRes] = await Promise.all([
        hda.listData("KBArticles", { conditions: ftConds, page: 1, start: 0, limit, sort: sSpec, signal }).catch((e) => {
          if (e && (e.name === "AuthError" || e.name === "AbortError")) throw e;
          log(`KB FullText: ${e.message}`);
          return { rows: [], total: 0 };
        }),
        hda.listData("KBArticles", { conditions: titleConds, page: 1, start: 0, limit, sort: sSpec, signal }).catch((e) => {
          if (e && (e.name === "AuthError" || e.name === "AbortError")) throw e;
          log(`KB Title: ${e.message}`);
          return { rows: [], total: 0 };
        }),
      ]);
      const byId = new Map();
      for (const r of [...readRows(ftRes.rows), ...readRows(titleRes.rows)]) {
        if (!byId.has(r.id)) byId.set(r.id, r);
      }
      const rows = [...byId.values()];
      const total = Math.max(ftRes.total || 0, titleRes.total || 0, rows.length);
      log(`KB Touch: ${rows.length} articoli (totale ${total})`);
      return { rows, total };
    }

    const conds = buildKbConditions({ text: rawText, filters, autoWildcard, textMode: rawText ? "fulltext" : "none" });
    info.conditions = conds;
    const res = await hda.listData("KBArticles", { conditions: conds, page, start, limit, sort: sSpec, signal });
    const rows = readRows(res.rows);
    log(`KB Touch: ${rows.length} di ${res.total} articoli`);
    return { rows, total: Math.max(res.total || 0, rows.length) };
  }

  /** Carica l'articolo completo (HTMLPreview + allegati) in sola lettura. */
  async function loadDoc(id, { row = null, signal } = {}) {
    const numId = (row && row.kbId) || kbNumericId(id);
    if (!numId) throw new Error("ID articolo Knowledge Base non valido");

    const fetchRow = row
      ? Promise.resolve(row)
      : hda
          .listData("KBArticles", { conditions: [{ property: "ID", value: numId, op: "eq", id: "ID" }], limit: 1, signal })
          .then((r) => readRows(r.rows)[0] || null)
          .catch(() => null);

    const fetchPreview = typeof hda.htmlPreview === "function"
      ? hda.htmlPreview("KBArticle", numId, signal).catch((e) => {
          if (e && (e.name === "AuthError" || e.name === "AbortError")) throw e;
          log(`KB preview ${numId}: ${e.message}`);
          return null;
        })
      : Promise.resolve(null);

    const fetchAtts = typeof hda.listEntityAttachments === "function"
      ? hda.listEntityAttachments("KBArticle", numId, signal).catch((e) => {
          log(`KB allegati ${numId}: ${e.message}`);
          return [];
        })
      : Promise.resolve([]);

    const [resolvedRow, preview, attachments] = await Promise.all([fetchRow, fetchPreview, fetchAtts]);
    if (!resolvedRow && !preview) throw new Error("Articolo non trovato nella Knowledge Base di HDA Touch");
    const baseRow = resolvedRow || { id: kbRowId(numId), kbId: numId, source: "kb" };
    return buildKbDoc({ row: baseRow, preview, attachments });
  }

  return {
    search,
    loadDoc,
    loadConfig,
    loadMeta,
    get statuses() { return statuses; },
    get types() { return types; },
    get languages() { return languages; },
    setMapping(m) {
      if (m && Object.keys(m).length) reader = makeKbRowReader(m);
    },
  };
}
