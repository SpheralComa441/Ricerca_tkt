// Testo dei ticket: pulizia dell'HTML del portale e del testo semplice delle conversazioni.
//
// Le funzioni "a stringa" (decodeEntities, htmlToText, splitQuoted, linkifyParts) non usano il DOM
// e sono testate con node. sanitizeHtml / textToFragment costruiscono nodi DOM sicuri: niente
// innerHTML con dati del portale, solo un elenco chiuso di tag e attributi.

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", egrave: "è", eacute: "é", agrave: "à", ograve: "ò", ugrave: "ù", igrave: "ì", Egrave: "È", euro: "€", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", ndash: "–", mdash: "—", deg: "°" };

export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

/** HTML scritto come testo ("&lt;p&gt;ciao&lt;/p&gt;") → HTML vero */
export function unescapeIfEscapedHtml(s) {
  const t = String(s ?? "");
  if (/&lt;\/?(p|div|br|span|table|b|strong|ul|ol|li|font|em|i|u)\b/i.test(t) && !/<\/?(p|div|br|span)\b/i.test(t)) return decodeEntities(t);
  return t;
}

export function isProbablyHtml(s) {
  return /<\/?(p|div|br|span|table|b|strong|ul|ol|li|font|em|i|u|h[1-6]|img|a)\b[^>]*>/i.test(String(s ?? ""));
}

/** HTML → testo semplice leggibile (per ricerca, anteprime, copia) */
export function htmlToText(html) {
  let s = unescapeIfEscapedHtml(html);
  s = s.replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n• ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, "\n");
  s = s.replace(/<(p|div|tr|h[1-6]|blockquote|pre|table|ul|ol)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  return cleanText(s);
}

/** Entità HTML, spazi, righe vuote multiple, caratteri invisibili */
export function cleanText(s) {
  return decodeEntities(String(s ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+(?=\S)/g, (m) => (m.includes("\t") ? "\n" : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUOTE_START = [
  /^-{2,}\s*(original message|messaggio originale|forwarded message|messaggio inoltrato)?\s*-*\s*$/i,
  /^(il giorno|in data)\b.{0,200}\bha scritto:?\s*$/i,
  /^on\b.{0,200}\bwrote:?\s*$/i,
  /^(da|from):\s.+$/i,
  /^_{5,}\s*$/,
];

/**
 * Separa il testo nuovo da quello citato (risposte precedenti riportate sotto).
 * Ritorna { main, quoted } — quoted è "" se non c'è.
 */
export function splitQuoted(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (QUOTE_START.some((re) => re.test(l))) {
      // "Da:" conta solo se seguito a breve da "Inviato:/Sent:/Oggetto:/A:"
      if (/^(da|from):/i.test(l) && !lines.slice(i + 1, i + 5).some((x) => /^(inviato|sent|oggetto|subject|a|to|data|date):/i.test(x.trim()))) continue;
      const main = lines.slice(0, i).join("\n").trim();
      if (main.length < 3) continue;
      return { main, quoted: lines.slice(i).join("\n").trim() };
    }
  }
  // righe che iniziano con ">" fino alla fine (una sola scansione dal fondo: i messaggi lunghi restano veloci)
  let k = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i].trim()) continue;
    if (!/^\s*>/.test(lines[i])) break;
    k = i;
  }
  if (k > 0) return { main: lines.slice(0, k).join("\n").trim(), quoted: lines.slice(k).join("\n").trim() };
  return { main: String(text ?? "").trim(), quoted: "" };
}

/**
 * Divide una riga di testo in parti: testo, link, numeri di ticket (7-8 cifre, eventualmente
 * preceduti da "tk", "ticket", "#").
 */
export function linkifyParts(s) {
  const out = [];
  // numeri di ticket HDA: 7 cifre (5000000-9999999) o 8 cifre che iniziano con 1 (10000000-19999999)
  const re = /(https?:\/\/[^\s<>"')\]]+)|(?:\b(?:tk|tkt|ticket|segnalazione)\.?\s*(?:n\.?|nr\.?|num\.?)?\s*#?|#)?\b([5-9]\d{6}|1\d{7})(Z)?\b/gi;
  let last = 0;
  for (const m of String(s ?? "").matchAll(re)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1]) out.push({ t: "url", v: m[1] });
    else out.push({ t: "ticket", v: m[0], id: m[3] || m[2].length >= 8 ? m[2] + "Z" : m[2] });
    last = m.index + m[0].length;
  }
  if (last < String(s ?? "").length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

// ---------------------------------------------------------------- DOM (solo nel browser)

const ALLOWED = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "sub", "sup", "div", "span", "a", "font", "center", "small", "big"]);
const BLOCKISH = new Set(["div", "center"]);
const DROP = new Set(["script", "style", "head", "title", "meta", "link", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "svg", "math", "noscript"]);

/**
 * HTML del portale → DocumentFragment pulito.
 * I numeri di ticket trovati nel testo diventano <a class="rt-ticket" data-ticket="…">.
 */
export function sanitizeHtml(html, doc = document, opts = {}) {
  const src = unescapeIfEscapedHtml(html);
  const parsed = new DOMParser().parseFromString(`<body>${src}</body>`, "text/html");
  const frag = doc.createDocumentFragment();
  const walk = (node, parent, inLink) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) {
        appendLinkified(ch.nodeValue, parent, doc, inLink);
      } else if (ch.nodeType === 1) {
        const tag = ch.tagName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (tag === "img") {
          const alt = ch.getAttribute("alt");
          const ph = doc.createElement("span");
          ph.className = "rt-img";
          ph.textContent = alt ? `[immagine: ${alt}]` : "[immagine]";
          parent.appendChild(ph);
          continue;
        }
        if (!ALLOWED.has(tag) || (tag === "a" && inLink)) {
          walk(ch, parent, inLink);
          continue;
        }
        const outTag = tag === "font" || tag === "big" || tag === "small" ? "span" : BLOCKISH.has(tag) ? "div" : tag;
        const el = doc.createElement(outTag);
        if (tag === "a") {
          const href = ch.getAttribute("href") || "";
          if (/^(https?:|mailto:)/i.test(href)) {
            el.setAttribute("href", href);
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
        }
        if ((tag === "td" || tag === "th") && ch.getAttribute("colspan")) el.setAttribute("colspan", String(parseInt(ch.getAttribute("colspan"), 10) || 1));
        if ((tag === "td" || tag === "th") && ch.getAttribute("rowspan")) el.setAttribute("rowspan", String(parseInt(ch.getAttribute("rowspan"), 10) || 1));
        walk(ch, el, inLink || tag === "a");
        parent.appendChild(el);
      }
    }
  };
  walk(parsed.body, frag, false);
  // paragrafi vuoti in fondo e in testa (frequenti nell'HTML dell'editor)
  const isEmpty = (n) => n && n.nodeType === 1 && /^(p|div|br)$/i.test(n.tagName) && !n.textContent.trim() && !n.querySelector("table,li");
  while (isEmpty(frag.firstChild)) frag.removeChild(frag.firstChild);
  while (isEmpty(frag.lastChild)) frag.removeChild(frag.lastChild);
  return frag;
}

function appendLinkified(text, parent, doc, inLink) {
  if (inLink) {
    parent.appendChild(doc.createTextNode(text));
    return;
  }
  for (const p of linkifyParts(text)) {
    if (p.t === "text") parent.appendChild(doc.createTextNode(p.v));
    else if (p.t === "url") {
      const a = doc.createElement("a");
      a.href = p.v;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.v;
      parent.appendChild(a);
    } else {
      const a = doc.createElement("a");
      a.href = "#";
      a.className = "rt-ticket";
      a.dataset.ticket = p.id;
      a.title = "Apri il ticket " + p.id.replace(/Z$/, "");
      a.textContent = p.v;
      parent.appendChild(a);
    }
  }
}

/** Testo semplice → frammento con paragrafi, a capo, link e numeri di ticket cliccabili */
export function textToFragment(text, doc = document, opts = {}) {
  const frag = doc.createDocumentFragment();
  const paras = cleanText(text).split(/\n{2,}/);
  for (const para of paras) {
    if (!para.trim()) continue;
    const p = doc.createElement("p");
    para.split("\n").forEach((line, i) => {
      if (i) p.appendChild(doc.createElement("br"));
      appendLinkified(line, p, doc, false);
    });
    frag.appendChild(p);
  }
  return frag;
}
