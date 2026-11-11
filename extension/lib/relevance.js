// Attinenza di un ticket rispetto alle parole cercate, calcolata nel browser (nessun dato esce dal PC).
//
// L'ordine è a fasce, come lavorano gli operatori (dalla più alta):
//   1. tutte le parole vicine nel testo      2. tutte le parole vicine nell'oggetto
//   3. alcune parole nel testo               4. alcune nell'oggetto e nel testo      5. alcune solo nell'oggetto
// Tra la 2 e la 3 stanno i ticket che hanno tutte le parole ma non vicine (nel testo, nell'oggetto, divise tra i due).
// Singolare e plurale valgono come la stessa parola (cedolino/cedolini).
// Nessuna dipendenza dal DOM: testabile con node --test.

import { norm, tokens } from "./util.js";

/**
 * Radice "leggera" di una parola italiana già normalizzata (minuscola, senza accenti): toglie la desinenza
 * così singolare e plurale coincidono (cedolino/cedolini → cedolin, premio/premi → prem, paga/paghe → pag).
 * Parole fino a tre lettere, numeri e sigle con cifre restano come sono.
 */
export function stem(word) {
  const w = String(word || "");
  if (w.length < 4 || /[^a-z]/.test(w)) return w;
  let s = w;
  if (/io$/.test(s)) s = s.slice(0, -2);
  else if (/[aeio]$/.test(s)) s = s.slice(0, -1);
  if (/[cg]h$/.test(s)) s = s.slice(0, -1);
  return s.length >= 3 ? s : w;
}

const WORD_RE = /[a-z0-9]+/g;

/** Testo → parole normalizzate con la loro posizione. */
function wordsOf(text) {
  const out = [];
  for (const m of norm(text).matchAll(WORD_RE)) out.push(m[0]);
  return out;
}

/**
 * Parole cercate → termini: { text, phrase, stem }. Una "frase tra virgolette" resta intera.
 * Le parole che iniziano con "-" non sono termini da cercare (servono solo al filtro dell'elenco).
 */
export function searchTerms(q) {
  const list = Array.isArray(q) ? q.map(norm).filter(Boolean) : tokens(q);
  return list
    .filter((t) => !t.startsWith("-"))
    // "phrase": frasi tra virgolette e parole con segni (26.05.00, f24/ep): si cercano così come sono scritte
    .map((t) => ({ text: t, phrase: /[^a-z0-9]/.test(t), stem: /[^a-z0-9]/.test(t) ? t : stem(t) }));
}

/**
 * Come un termine compare in un testo: 1 parola esatta, 0.8 variante (stessa radice), 0.5 dentro una parola più lunga,
 * 0 assente. `words` sono le parole del testo, `plain` il testo normalizzato.
 */
function matchKind(term, words, plain) {
  if (term.phrase) return plain.includes(term.text) ? 1 : 0;
  let best = 0;
  for (const w of words) {
    if (w === term.text) return 1;
    if (best < 0.8 && term.stem.length >= 3 && stem(w) === term.stem) best = 0.8;
    else if (best < 0.5 && w.includes(term.text)) best = 0.5;
  }
  return best;
}

/** Vero se la parola del testo `w` vale per il termine (esatta, variante o che la contiene). */
function wordMatches(term, w) {
  return w === term.text || w.includes(term.text) || (term.stem.length >= 3 && stem(w) === term.stem);
}

/**
 * Vero se TUTTE le parole compaiono nel testo, contando anche le varianti della parola (plurale/singolare).
 * È più largo di un confronto lettera per lettera: "premio" trova anche "premi".
 */
export function matchesAllTerms(haystack, qOrWords) {
  const terms = searchTerms(qOrWords);
  if (!terms.length) return true;
  const plain = norm(haystack);
  let words = null;
  return terms.every((t) => {
    if (plain.includes(t.text)) return true;
    if (t.phrase) return false;
    words = words || wordsOf(plain);
    return matchKind(t, words, plain) > 0;
  });
}

/** Posizioni (indice di parola) in cui un termine compare. Una frase vale dove comincia, parola per parola. */
function positionsOf(term, words) {
  const out = [];
  if (!term.phrase) {
    for (let i = 0; i < words.length; i++) if (wordMatches(term, words[i])) out.push(i);
    return out;
  }
  const pw = term.text.match(WORD_RE) || [];
  if (!pw.length) return out;
  for (let i = 0; i + pw.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < pw.length; k++) if (words[i + k] !== pw[k]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

/** Il tratto di testo più corto (in parole) che contiene tutti i termini. `pos` = posizioni per termine, tutte non vuote. */
function smallestWindow(pos) {
  if (pos.length === 1) return 1;
  const ev = [];
  pos.forEach((list, k) => list.forEach((at) => ev.push([at, k])));
  ev.sort((x, y) => x[0] - y[0]);
  const have = new Array(pos.length).fill(0);
  let missing = pos.length;
  let best = Infinity;
  let left = 0;
  for (let right = 0; right < ev.length; right++) {
    if (have[ev[right][1]]++ === 0) missing--;
    while (!missing) {
      best = Math.min(best, ev[right][0] - ev[left][0] + 1);
      if (--have[ev[left][1]] === 0) missing++;
      left++;
    }
  }
  return best;
}

/** Vero se i termini compaiono uno dopo l'altro, nell'ordine scritto. */
function inOrder(pos) {
  if (pos.length < 2) return false;
  const sets = pos.map((l) => new Set(l));
  return pos[0].some((at) => sets.every((set, k) => set.has(at + k)));
}

/** Come le parole cercate compaiono in un pezzo di testo. */
function analyse(text, terms) {
  // la richiesta di Touch può essere HTML: i tag non sono parole
  const plain = norm(/<\w/.test(text) ? String(text).replace(/<[^>]+>/g, " ") : text);
  const words = wordsOf(plain);
  const pos = terms.map((t) => positionsOf(t, words));
  const hits = pos.map((l) => l.length > 0);
  const found = hits.filter(Boolean).length;
  const all = found === terms.length;
  let kind = 0;
  terms.forEach((t, k) => { if (hits[k]) kind += matchKind(t, words, plain) || 0.5; });
  return {
    hits,
    found,
    window: all ? smallestWindow(pos) : Infinity,
    ordered: all && inOrder(pos),
    kind: found ? kind / found : 0, // 1 = parole esatte, meno = varianti
    count: pos.reduce((n, l) => n + l.length, 0),
  };
}

/** Più pezzi di testo (richiesta, messaggi) visti come uno solo: le parole sono «vicine» se lo sono dentro un pezzo. */
function mergeParts(parts, n) {
  const out = { hits: new Array(n).fill(false), found: 0, window: Infinity, ordered: false, kind: 0, count: 0 };
  for (const p of parts) {
    p.hits.forEach((h, k) => { if (h) out.hits[k] = true; });
    out.window = Math.min(out.window, p.window);
    out.ordered = out.ordered || p.ordered;
    out.kind = Math.max(out.kind, p.kind);
    out.count += p.count;
  }
  out.found = out.hits.filter(Boolean).length;
  return out;
}

/** Quante parole di distanza valgono ancora come «vicine» per n parole cercate (2 parole: entro 6; 3: entro 8). */
const nearSpan = (n) => (n <= 1 ? 1 : n * 2 + 2);

/**
 * Fasce di attinenza, dalla più alta. L'ordine è quello scelto dagli operatori: il testo dei messaggi conta più
 * dell'oggetto, e avere tutte le parole vicine conta più di tutto.
 */
export const TIERS = {
  ALL_NEAR_TEXT: 8, // tutte le parole vicine nel testo
  ALL_NEAR_SUBJECT: 7, // tutte le parole vicine nell'oggetto
  ALL_TEXT: 6, // tutte nel testo, ma lontane tra loro
  ALL_SUBJECT: 5, // tutte nell'oggetto, ma lontane tra loro
  ALL_SPLIT: 4, // tutte, divise tra oggetto e testo
  SOME_TEXT: 3, // alcune parole, solo nel testo
  SOME_BOTH: 2, // alcune parole, nell'oggetto e nel testo
  SOME_SUBJECT: 1, // alcune parole, solo nell'oggetto
  NONE: 0,
};

/**
 * Attinenza di un ticket: { tier, score }. `score` = fascia × 1000 + dettaglio (0-999), così la fascia decide sempre
 * e il dettaglio ordina dentro la fascia (parole più strette, in ordine, esatte, più parole trovate).
 * Campi letti: subject (oggetto); il testo è problem (richiesta o estratto) più fullText (messaggi, quando ci sono).
 */
export function relevance(row, termsOrQuery) {
  const terms = Array.isArray(termsOrQuery) && termsOrQuery.length && typeof termsOrQuery[0] === "object" ? termsOrQuery : searchTerms(termsOrQuery);
  if (!row || !terms.length) return { tier: 0, score: 0 };
  const n = terms.length;
  const subjNorm = norm(row.subject);
  // Il testo completo del Vecchio Cruscotto è fatto dei messaggi separati da due spazi: ogni messaggio è un pezzo
  // (le parole sono «vicine» solo dentro lo stesso messaggio). Il pezzo che ripete l'oggetto non è «testo».
  const messages = row.fullText ? String(row.fullText).split(/ {2,}/).filter((m) => m.trim() && norm(m) !== subjNorm) : [];
  const S = analyse(row.subject || "", terms);
  const T = mergeParts([row.problem, ...messages].filter(Boolean).map((t) => analyse(t, terms)), n);
  const union = S.hits.filter((h, k) => h || T.hits[k]).length;
  if (!union) return { tier: 0, score: 0 };

  const span = nearSpan(n);
  const allT = T.found === n;
  const allS = S.found === n;
  let tier;
  if (allT && T.window <= span) tier = TIERS.ALL_NEAR_TEXT;
  else if (allS && S.window <= span) tier = TIERS.ALL_NEAR_SUBJECT;
  else if (allT) tier = TIERS.ALL_TEXT;
  else if (allS) tier = TIERS.ALL_SUBJECT;
  else if (union === n) tier = TIERS.ALL_SPLIT;
  else if (T.found && !S.found) tier = TIERS.SOME_TEXT;
  else if (T.found && S.found) tier = TIERS.SOME_BOTH;
  else tier = TIERS.SOME_SUBJECT;

  // dettaglio dentro la fascia
  const main = tier === TIERS.ALL_NEAR_SUBJECT || tier === TIERS.ALL_SUBJECT || tier === TIERS.SOME_SUBJECT ? S : T;
  const other = main === S ? T : S;
  let fine = 0;
  if (tier >= TIERS.ALL_SUBJECT) {
    fine += (n / main.window) * 400; // più strette sono le parole, meglio è
    if (main.ordered) fine += 150; // la frase così com'è scritta
    if (other.found === n) fine += other.window <= span ? 200 : 120; // tutte anche nell'altro campo
  } else {
    fine += (union / n) * 450; // più parole trovate, meglio è
    fine += (T.found / n) * 100;
  }
  fine += Math.max(main.kind, 0) * 150; // parole esatte più delle varianti
  fine += Math.min(T.count, 10) * 5; // qualche ripetizione nel testo conta poco
  return { tier, score: tier * 1000 + Math.min(Math.round(fine), 999) };
}

/** Punteggio di attinenza (0 = nessuna parola trovata). */
export function scoreRow(row, termsOrQuery) {
  return relevance(row, termsOrQuery).score;
}

/**
 * Ordina per attinenza (dal più attinente); a parità, dal più recente. I punteggi si tengono in memoria
 * per riga e ricerca: riordinare lo stesso elenco non ricalcola.
 */
const SCORES = new WeakMap();
export function rowScore(row, query) {
  const hit = SCORES.get(row);
  if (hit && hit.q === query) return hit.s;
  const s = scoreRow(row, query);
  SCORES.set(row, { q: query, s });
  return s;
}

export function sortByRelevance(rows, query) {
  const terms = searchTerms(query);
  if (!terms.length) return rows;
  const t = (r) => (r.date instanceof Date ? r.date.getTime() : 0);
  return [...rows].sort((a, b) => rowScore(b, query) - rowScore(a, query) || t(b) - t(a));
}

/**
 * Estratto del testo attorno al punto dove compaiono più parole cercate (non l'inizio del messaggio).
 * `text` è testo semplice; ritorna al massimo `len` caratteri, con "…" dove è tagliato.
 */
export function bestSnippet(text, termsOrQuery, len = 300) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (src.length <= len) return src;
  const terms = Array.isArray(termsOrQuery) && termsOrQuery.length && typeof termsOrQuery[0] === "object" ? termsOrQuery : searchTerms(termsOrQuery);
  if (!terms.length) return src.slice(0, len);
  // posizioni (nel testo originale) delle parole che valgono per un termine
  const hits = [];
  for (const m of src.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = norm(m[0]);
    terms.forEach((t, k) => {
      if (t.phrase ? false : wordMatches(t, w)) hits.push({ at: m.index, k });
    });
  }
  const plain = src.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (plain.length === src.length) {
    terms.forEach((t, k) => {
      if (!t.phrase) return;
      for (let i = plain.indexOf(t.text); i >= 0; i = plain.indexOf(t.text, i + 1)) hits.push({ at: i, k });
    });
  }
  if (!hits.length) return src.slice(0, len);
  hits.sort((a, b) => a.at - b.at);
  // la finestra di `len` caratteri con più termini diversi (e, a parità, più occorrenze)
  let best = { score: -1, at: 0 };
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set();
    let n = 0;
    for (let j = i; j < hits.length && hits[j].at - hits[i].at < len - 60; j++) {
      seen.add(hits[j].k);
      n++;
    }
    const sc = seen.size * 100 + Math.min(n, 20);
    if (sc > best.score) best = { score: sc, at: hits[i].at };
  }
  let start = Math.max(0, best.at - 60);
  if (start > 0) {
    const sp = src.indexOf(" ", start);
    if (sp >= 0 && sp < best.at) start = sp + 1;
  }
  let end = Math.min(src.length, start + len);
  if (end < src.length) {
    const sp = src.lastIndexOf(" ", end);
    if (sp > start + len * 0.6) end = sp;
  }
  return (start > 0 ? "… " : "") + src.slice(start, end).trim() + (end < src.length ? " …" : "");
}

/**
 * Filtro dell'elenco scritto a mano: parole da avere (tutte) e "-parola" da escludere.
 * → funzione (testo del ticket) → vero se il ticket resta in elenco.
 */
export function listFilter(q) {
  const all = tokens(q);
  const must = searchTerms(all.filter((t) => !t.startsWith("-")));
  const not = searchTerms(all.filter((t) => t.startsWith("-") && t.length > 1).map((t) => t.slice(1)));
  if (!must.length && !not.length) return null;
  return (haystack) => {
    const plain = norm(haystack);
    const words = wordsOf(plain);
    const has = (t) => plain.includes(t.text) || (!t.phrase && matchKind(t, words, plain) > 0);
    return must.every(has) && !not.some(has);
  };
}

/** Varianti da evidenziare per una parola cercata: la parola e le sue forme con la stessa radice. */
export function highlightPatterns(words) {
  const out = [];
  for (const t of searchTerms(words)) {
    if (t.text.length < 2) continue;
    out.push({ text: t.text, stem: !t.phrase && t.stem !== t.text && t.stem.length >= 4 ? t.stem : "" });
  }
  return out;
}
