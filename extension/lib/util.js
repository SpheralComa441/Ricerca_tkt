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
    const w = norm(m[1] || m[2]);
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

/** Numero ticket scritto dall'utente → ID HDA ("10500123" → "10500123Z"). null se non è un numero. */
export function ticketIdFrom(q) {
  const s = String(q || "").trim().replace(/^#/, "");
  const m = /^(\d{5,10})([A-Za-z]?)$/.exec(s);
  if (!m) return null;
  return m[1] + (m[2] ? m[2].toUpperCase() : "Z");
}

/** "10500123Z" → "10500123" (come lo scrivono le persone) */
export function ticketNumber(id) {
  return String(id || "").replace(/Z$/i, "");
}

/** Vero se il numero di ticket ha 5-7 cifre (tipico del vecchio cruscotto / Area Riservata). */
export function isLegacyTicketNumber(idOrQuery) {
  const s = String(idOrQuery || "").trim().replace(/^#/, "");
  const m = /^(\d{5,7})([Zz]?)$/.exec(s);
  return !!m;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
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
