// Utility comuni (nessuna dipendenza dal DOM: testabili con node --test).

/** "/Date(1793889412543)/" o "\/Date(...)\/" → Date (o null). Accetta anche ISO e millisecondi. */
export function parseMsDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "number") return new Date(v);
  const s = String(v);
  const m = /\/?Date\((-?\d+)(?:[+-]\d{4})?\)\/?/.exec(s);
  if (m) {
    const ms = Number(m[1]);
    // HDA usa -2208992400000 (anno 1900) come "nessuna data"
    if (ms < -2000000000000) return null;
    return new Date(ms);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

/** 06/11/2026 */
export function fmtDate(d) {
  d = parseMsDate(d);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "";
}

/** 06/11/2026 16:57 */
export function fmtDateTime(d) {
  d = parseMsDate(d);
  return d ? `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}

/** "oggi 16:57", "ieri 09:10", "3 giorni fa", altrimenti data. */
export function fmtRelative(d, now = new Date()) {
  d = parseMsDate(d);
  if (!d) return "";
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `oggi ${hm}`;
  if (diff === 1) return `ieri ${hm}`;
  if (diff > 1 && diff < 7) return `${diff} giorni fa`;
  return fmtDate(d);
}

/** yyyy-mm-dd (valore degli input type=date) */
export function isoDay(d) {
  d = parseMsDate(d);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "";
}

/** testo → forma confrontabile: minuscolo, senza accenti, spazi singoli */
export function norm(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** parole di una ricerca: "frase tra virgolette" resta intera (normalizzata senza accenti) */
export function tokens(q) {
  const out = [];
  for (const m of String(q || "").matchAll(/"([^"]+)"|(\S+)/g)) {
    // l'asterisco («centr*») vale per il portale: qui si confronta la parte scritta
    const w = norm(String(m[1] || m[2]).replace(/\*/g, ""));
    if (w) out.push(w);
  }
  return out;
}

/** Parole o "frasi tra virgolette" di una ricerca, mantenendo gli accenti originali per le query al server. */
export function queryTerms(q) {
  const out = [];
  for (const m of String(q || "").matchAll(/"([^"]+)"|(\S+)/g)) {
    const w = String(m[1] || m[2] || "").replace(/\s+/g, " ").trim();
    if (w) out.push(w);
  }
  return out;
}

/** Vero se tutte le parole di `qOrWords` compaiono in `haystack` (senza distinzione di maiuscole/accenti). */
export function matchesAllTokens(haystack, qOrWords) {
  const words = Array.isArray(qOrWords) ? qOrWords.map(norm).filter(Boolean) : tokens(qOrWords);
  if (!words.length) return true;
  const h = norm(haystack);
  return words.every((w) => h.includes(w));
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Toglie i prefissi con cui si scrive a mano un numero ticket: "#", "tk", "tkt", "ticket", "n.", "nr." e combinazioni. */
function stripTicketPrefix(q) {
  return String(q || "")
    .trim()
    .replace(/^(?:(?:tkt?|ticket|segnalazione)\.?\s*)?(?:(?:n|nr|num)\.?\s*)?[:#-]?\s*(?=\d)/i, "")
    .trim();
}

/**
 * Numero ticket scritto dall'utente → ID principale.
 * Su HDA TOUCH i ticket nativi hanno il suffisso "Z" (8 cifre come "11943209Z", ma anche i più vecchi a
 * 7 cifre come "9876543Z"); i ticket migrati dal Vecchio Cruscotto hanno l'ID numerico puro (es. "9042633").
 *  - "11943209" (8+ cifre senza Z)  → "11943209Z"
 *  - "9042633"  (5-7 cifre senza Z) → "9042633" (si provano comunque anche "9042633Z" e il Vecchio Cruscotto)
 *  - "9876543Z" (Z scritta)         → "9876543Z" (la Z scritta dall'utente non si perde)
 */
export function ticketIdFrom(q) {
  const s = stripTicketPrefix(q);
  const m = /^(\d{5,10})([A-Za-z]?)$/.exec(s);
  if (!m) return null;
  const suffix = m[2].toUpperCase();
  if (suffix) return m[1] + suffix;
  return m[1].length >= 8 ? m[1] + "Z" : m[1];
}

/** "10500123Z" → "10500123" (come lo scrivono le persone) */
export function ticketNumber(id) {
  return stripTicketPrefix(id).replace(/Z$/i, "");
}

/** Vero se l'ID è quello di un ticket nativo di HDA TOUCH (cifre + "Z"). */
export function isTouchNativeId(id) {
  return /^\d{5,10}Z$/i.test(String(id || "").trim());
}

/**
 * Varianti dell'ID da provare su HDA TOUCH, nell'ordine di preferenza.
 * Senza "Z" scritta si provano sia "num" sia "numZ" (i ticket Touch a 7 cifre esistono in entrambe le forme);
 * con la "Z" scritta dall'utente si cerca solo quella (chi la scrive vuole il ticket nativo di Touch).
 */
export function ticketIdVariants(idOrQuery) {
  const tid = ticketIdFrom(idOrQuery);
  if (!tid) return [];
  const typed = stripTicketPrefix(idOrQuery);
  const num = ticketNumber(tid);
  const withZ = `${num}Z`;
  if (/z$/i.test(typed)) return [withZ];
  if (!/^\d+$/.test(num) || /[A-Y]$/i.test(tid)) return [tid];
  return tid === withZ ? [withZ, num] : [num, withZ];
}

/**
 * Vero se il numero (senza "Z") può essere un ticket storico del Vecchio Cruscotto: 5-7 cifre (es. "8900042").
 * Un numero con la "Z" (es. "9876543Z") è invece un ticket nativo di HDA TOUCH.
 */
export function isLegacyTicketNumber(idOrQuery) {
  return /^\d{5,7}$/.test(stripTicketPrefix(idOrQuery));
}

/**
 * Chiave per riconoscere lo stesso ticket nei due cruscotti: i ticket con la "Z" sono nativi di Touch e
 * restano distinti; un numero puro (Touch migrato o Vecchio Cruscotto) si unisce per numero.
 */
export function ticketMergeKey(row) {
  const id = String((row && row.id) || "").trim();
  if (!id) return "";
  if (row && row.source !== "ar" && isTouchNativeId(id)) return "touch:" + id.toUpperCase();
  return "num:" + ticketNumber(id);
}

/** Rimanda fn finché non passano ms senza chiamate; .cancel() annulla quella in attesa. */
export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Esegue fn su ogni elemento con al massimo `n` in parallelo. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

export function csvCell(v) {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
