// Archivio locale (IndexedDB) e impostazioni (chrome.storage.local, o localStorage fuori dall'estensione).
//
// Archivio: i ticket letti o scaricati con "Archivia" restano nel browser con tutto il testo
// della conversazione, così si può cercare anche dentro i messaggi (cosa che Touch non fa).

import { norm, tokens } from "./util.js";
import { timelineText } from "./ticket.js";

const DB_NAME = "ricerca-tkt";
// v2: oltre ai ticket completi ("tickets") c'è un indice leggero ("index": id, riga, testo normalizzato, date)
// usato per la ricerca nell'archivio e per sapere quali risultati sono già archiviati, senza leggere
// ogni volta le conversazioni complete con l'HTML.
const DB_VER = 2;

const indexRec = (rec) => ({ id: rec.id, row: rec.row, text: rec.text || "", savedAt: rec.savedAt, lastChange: rec.lastChange || null });

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (ev) => {
      const d = req.result;
      if (!d.objectStoreNames.contains("tickets")) {
        const s = d.createObjectStore("tickets", { keyPath: "id" });
        s.createIndex("savedAt", "savedAt");
      }
      if (!d.objectStoreNames.contains("index")) {
        const ix = d.createObjectStore("index", { keyPath: "id" });
        if (ev.oldVersion >= 1) {
          // archivio della versione precedente: si costruisce l'indice una volta sola
          const cur = req.transaction.objectStore("tickets").openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            ix.put(indexRec(c.value));
            c.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("archivio locale non disponibile"));
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

/** Transazione su uno o più archivi: fn riceve l'archivio (o l'elenco degli archivi, nello stesso ordine). */
function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const s = Array.isArray(store) ? store.map((n) => t.objectStore(n)) : t.objectStore(store);
        const p = Promise.resolve().then(() => fn(s));
        const fail = (ev) => reject((ev && ev.target && ev.target.error) || t.error || new Error("errore dell'archivio locale"));
        t.oncomplete = () => p.then(resolve, reject);
        t.onerror = fail;
        t.onabort = fail;
      }),
  );
}

const reqP = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error || new Error("errore dell'archivio locale")))));

// Indice in memoria (si legge una volta, poi si aggiorna a ogni salvataggio). Oltre ~30 milioni di caratteri
// non si tiene in memoria e si rilegge dall'archivio a ogni ricerca.
const INDEX_MEM_LIMIT = 30e6;
const INDEX_TTL = 5 * 60 * 1000; // un'altra scheda dell'app può aver archiviato altri ticket
let memIndex = null;
let memIndexAt = 0;

async function loadIndex() {
  if (memIndex && Date.now() - memIndexAt < INDEX_TTL) return memIndex;
  const all = await tx("index", "readonly", (s) => reqP(s.getAll()));
  const m = new Map();
  let size = 0;
  for (const r of all || []) {
    m.set(r.id, r);
    size += (r.text || "").length;
  }
  if (size <= INDEX_MEM_LIMIT) {
    memIndex = m;
    memIndexAt = Date.now();
  } else {
    memIndex = null;
  }
  return m;
}

/** Riga dell'elenco senza i dati grezzi, con le date in millisecondi */
function slimRow(row) {
  if (!row) return null;
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "raw") continue;
    o[k] = v instanceof Date ? v.getTime() : v;
  }
  return o;
}

export function reviveRow(o) {
  if (!o) return o;
  const r = { ...o };
  for (const k of ["date", "lastChange", "closureDate", "nextExpiration", "publishDate", "visibleFrom", "visibleTo"]) if (typeof r[k] === "number") r[k] = new Date(r[k]);
  return r;
}

export async function saveTicket(full) {
  const row = slimRow(full.row) || { id: full.id };
  const attachments = (full.attachments || []).map((a) => ({
    ...a,
    date: a.date instanceof Date ? a.date.getTime() : a.date || null,
  }));
  const attNames = attachments.map((a) => `${a.fileName || ""} ${a.description || ""}`).join(" ");
  const text = timelineText(
    full.timeline,
    `${full.id} ${row.subject || ""} ${row.account || ""} ${row.contact || ""} ${row.ownerGroup || ""} ${row.assigned || ""} ${row.catalog || ""} ${attNames}`,
  );
  const rec = {
    id: full.id,
    row,
    attachments,
    timeline: full.timeline.map((e) => ({
      ...e,
      date: e.date ? e.date.getTime() : null,
      attachmentItems: (e.attachmentItems || []).map((a) => ({
        ...a,
        date: a.date instanceof Date ? a.date.getTime() : a.date || null,
      })),
    })),
    text: norm(text),
    savedAt: Date.now(),
    lastChange: row.lastChange || null,
  };
  const ix = indexRec(rec);
  await tx(["tickets", "index"], "readwrite", ([s, i]) => {
    s.put(rec);
    i.put(ix);
  });
  if (memIndex) memIndex.set(ix.id, ix);
  return rec;
}

export async function getTicket(id) {
  const rec = await tx("tickets", "readonly", (s) => reqP(s.get(id)));
  if (!rec) return null;
  const reviveAtt = (a) => ({ ...a, date: typeof a.date === "number" ? new Date(a.date) : a.date || null });
  return {
    ...rec,
    row: reviveRow(rec.row),
    attachments: (rec.attachments || []).map(reviveAtt),
    timeline: rec.timeline.map((e) => ({
      ...e,
      date: e.date ? new Date(e.date) : null,
      attachmentItems: (e.attachmentItems || []).map(reviveAtt),
    })),
  };
}

export async function archiveInfo() {
  return tx("index", "readonly", (s) => reqP(s.count()));
}

/** Quali ID sono in archivio (e quando sono stati salvati) */
export async function archivedMap(ids) {
  const out = new Map();
  const index = await loadIndex();
  for (const id of ids) {
    const r = index.get(id);
    if (r) out.set(id, { savedAt: r.savedAt, lastChange: r.lastChange });
  }
  return out;
}

/**
 * Ricerca nell'archivio: tutte le parole devono comparire (senza accenti, maiuscole indifferenti).
 * Ritorna le righe con un estratto del testo intorno alla prima parola trovata.
 */
export async function searchArchive(q, { limit = 500 } = {}) {
  const words = tokens(q);
  if (!words.length) return [];
  const hits = [];
  const index = await loadIndex();
  for (const rec of index.values()) {
    const text = rec.text || "";
    if (words.every((w) => text.includes(w))) {
      const i = text.indexOf(words[0]);
      hits.push({ row: reviveRow(rec.row) || { id: rec.id }, snippet: text.slice(Math.max(0, i - 90), i + 160), savedAt: rec.savedAt });
    }
  }
  hits.sort((a, b) => (b.row.date?.getTime?.() || 0) - (a.row.date?.getTime?.() || 0));
  return hits.slice(0, limit);
}

export async function clearArchive() {
  await tx(["tickets", "index"], "readwrite", ([s, i]) => {
    s.clear();
    i.clear();
  });
  memIndex = null;
}

// ---------------------------------------------------------------- impostazioni

const hasChrome = () => typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

export async function kvGet(key, dflt = null) {
  if (hasChrome()) {
    const o = await chrome.storage.local.get(key);
    return o[key] ?? dflt;
  }
  try {
    const v = localStorage.getItem("rtkt:" + key);
    return v == null ? dflt : JSON.parse(v);
  } catch {
    return dflt;
  }
}

export async function kvSet(key, value) {
  if (hasChrome()) return chrome.storage.local.set({ [key]: value });
  localStorage.setItem("rtkt:" + key, JSON.stringify(value));
}

export function onKvChange(fn) {
  if (hasChrome()) chrome.storage.onChanged.addListener((ch, area) => area === "local" && fn(ch));
}
