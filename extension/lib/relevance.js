// Attinenza di un ticket rispetto alle parole cercate, calcolata nel browser (nessun dato esce dal PC).
//
// Conta: dove compare la parola (oggetto più del testo), se è la parola esatta o una sua variante
// (cedolino/cedolini), se le parole stanno vicine o formano la frase scritta, quante parole su quante.
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

/** Quante volte il termine compare tra le parole. */
function countOf(term, words, plain) {
  if (term.phrase) return plain.split(term.text).length - 1;
  let n = 0;
  for (const w of words) if (wordMatches(term, w)) n++;
  return n;
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

/** La finestra di parole più corta che contiene tutti i termini (Infinity se non ci sono tutti). */
function smallestWindow(terms, words) {
  const single = terms.filter((t) => !t.phrase);
  if (single.length < 2) return single.length ? 1 : Infinity;
  const last = new Array(single.length).fill(-1);
  let best = Infinity;
  for (let i = 0; i < words.length; i++) {
    let hit = false;
    for (let k = 0; k < single.length; k++) {
      if (wordMatches(single[k], words[i])) {
        last[k] = i;
        hit = true;
      }
    }
    if (!hit) continue;
    let min = i;
    for (const p of last) {
      if (p < 0) { min = -1; break; }
      if (p < min) min = p;
    }
    if (min >= 0 && i - min + 1 < best) best = i - min + 1;
  }
  return best;
}

/** Vero se i termini compaiono uno dopo l'altro, nell'ordine scritto. */
function inOrder(terms, words) {
  const single = terms.filter((t) => !t.phrase);
  if (single.length < 2) return false;
  for (let i = 0; i + single.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < single.length; k++) {
      if (!wordMatches(single[k], words[i + k])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

const FIELD_WEIGHT = { subject: 6, problem: 2.5, text: 1.5, extra: 0.6 };

/**
 * Punteggio di attinenza di un ticket (0 = nessuna parola trovata). Campi letti: subject (oggetto), problem
 * (richiesta o estratto), fullText (testo dei messaggi, quando c'è), account/catalog/topic.
 */
export function scoreRow(row, termsOrQuery) {
  const terms = Array.isArray(termsOrQuery) && termsOrQuery.length && typeof termsOrQuery[0] === "object" ? termsOrQuery : searchTerms(termsOrQuery);
  if (!row || !terms.length) return 0;
  const fields = [
    ["subject", row.subject],
    ["problem", row.problem],
    ["text", row.fullText],
    ["extra", [row.account, row.catalog, row.topic].filter(Boolean).join(" ")],
  ]
    .filter(([, v]) => v)
    .map(([name, v]) => {
      const plain = norm(v);
      return { name, plain, words: wordsOf(plain) };
    });
  if (!fields.length) return 0;

  let score = 0;
  let found = 0;
  let inSubject = 0;
  for (const t of terms) {
    let best = 0;
    for (const f of fields) {
      const kind = matchKind(t, f.words, f.plain);
      if (!kind) continue;
      // più occorrenze contano poco di più (un messaggio lungo non deve vincere solo perché ripete la parola)
      const repeat = f.name === "subject" ? 1 : 1 + Math.min(countOf(t, f.words, f.plain) - 1, 4) * 0.12;
      best = Math.max(best, FIELD_WEIGHT[f.name] * kind * repeat);
      if (f.name === "subject") inSubject++;
    }
    if (best) found++;
    score += best;
  }
  if (!found) return 0;

  if (terms.length > 1) {
    const subj = fields.find((f) => f.name === "subject");
    if (subj && inSubject === terms.length) score += 4; // tutte le parole nell'oggetto
    for (const f of fields) {
      if (f.name === "extra") continue;
      const w = FIELD_WEIGHT[f.name] / FIELD_WEIGHT.subject;
      if (inOrder(terms, f.words)) score += 6 * w; // la frase così com'è scritta
      else {
        const win = smallestWindow(terms, f.words);
        if (win <= terms.length + 3) score += (3 - 0.5 * (win - terms.length)) * w; // parole vicine: più sono strette, più vale
        else if (win <= 15) score += 1.2 * w;
      }
    }
  }
  // un ticket con tutte le parole vale più di uno che ne ha solo alcune
  return score * (found / terms.length) ** 2;
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
