// Archivio locale (IndexedDB) e impostazioni (chrome.storage.local, o localStorage fuori dall'estensione).
//
// Archivio: i ticket letti o scaricati con "Archivia" restano nel browser con tutto il testo
// della conversazione, così si può cercare anche dentro i messaggi (cosa che Touch non fa).

import { norm, tokens } from "./util.js";
import { timelineText } from "./ticket.js";

const DB_NAME = "ricerca-tkt";
const DB_VER = 1;

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("tickets")) {
        const s = d.createObjectStore("tickets", { keyPath: "id" });
        s.createIndex("savedAt", "savedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const s = t.objectStore(store);
        const p = Promise.resolve().then(() => fn(s));
        t.oncomplete = () => p.then(resolve, reject);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const reqP = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

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
  for (const k of ["date", "lastChange", "closureDate", "nextExpiration"]) if (typeof r[k] === "number") r[k] = new Date(r[k]);
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
  await tx("tickets", "readwrite", (s) => s.put(rec));
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
  return tx("tickets", "readonly", (s) => reqP(s.count()));
}

/** Quali ID sono in archivio (e quando sono stati salvati) */
export async function archivedMap(ids) {
  const out = new Map();
  await tx("tickets", "readonly", async (s) => {
    for (const id of ids) {
      const r = await reqP(s.get(id));
      if (r) out.set(id, { savedAt: r.savedAt, lastChange: r.lastChange });
    }
  });
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
  await tx("tickets", "readonly", (s) => {
    return new Promise((resolve) => {
      const cur = s.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const rec = c.value;
        if (words.every((w) => rec.text.includes(w))) {
          const i = rec.text.indexOf(words[0]);
          hits.push({ row: reviveRow(rec.row), snippet: rec.text.slice(Math.max(0, i - 90), i + 160), savedAt: rec.savedAt });
        }
        c.continue();
      };
      cur.onerror = () => resolve();
    });
  });
  hits.sort((a, b) => (b.row.date?.getTime?.() || 0) - (a.row.date?.getTime?.() || 0));
  return hits.slice(0, limit);
}

export async function clearArchive() {
  await tx("tickets", "readwrite", (s) => s.clear());
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
