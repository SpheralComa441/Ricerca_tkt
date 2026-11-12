// Piccolo aiuto per costruire il DOM senza innerHTML (i dati del portale non diventano mai HTML).

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "text") el.textContent = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Evidenzia le parole cercate nei nodi di testo di un elemento */
/**
 * words: parole da evidenziare (stringhe) oppure { text, stem }: con `stem` si evidenziano anche le varianti
 * della parola (cedolino → cedolini), cioè la radice seguita da una desinenza breve.
 */
export function highlight(root, words) {
  const ws = (words || []).map((w) => (typeof w === "string" ? { text: w, stem: "" } : w)).filter((w) => w && w.text && w.text.length >= 2);
  if (!ws.length) return 0;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // confronto senza accenti: si cerca sulla forma normalizzata carattere per carattere
  const alts = [...ws.filter((w) => w.prefix).map((w) => `\\b${esc(w.text)}[a-z]*`), ...ws.map((w) => esc(w.text)), ...ws.filter((w) => w.stem).map((w) => `\\b${esc(w.stem)}[a-z]{0,3}\\b`)];
  const re = new RegExp(alts.join("|"), "gi");
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest("mark,script,style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const plain = n.nodeValue.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (plain.length !== n.nodeValue.length) continue; // caratteri composti: si salta per non sfasare
    re.lastIndex = 0;
    if (!re.test(plain)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of plain.matchAll(re)) {
      if (m.index > last) frag.appendChild(document.createTextNode(n.nodeValue.slice(last, m.index)));
      const mk = document.createElement("mark");
      mk.textContent = n.nodeValue.slice(m.index, m.index + m[0].length);
      frag.appendChild(mk);
      count++;
      last = m.index + m[0].length;
    }
    if (last < n.nodeValue.length) frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }
  return count;
}

export function toast(msg, kind = "info", ms = 3500) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts" });
    document.body.appendChild(box);
  }
  const t = h("div", { class: `toast toast-${kind}`, role: "status" }, msg);
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function icon(name) {
  const paths = {
    search: "M11 4a7 7 0 1 0 4.24 12.57l4.6 4.6 1.41-1.41-4.6-4.6A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
    close: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z",
    star: "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z",
    external: "M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14zM5 6h6v2H6v10h10v-5h2v6H5z",
    copy: "M8 3h11v13h-2V5H8zM5 7h11v14H5zm2 2v10h7V9z",
    clip: "M16.5 6.5v10a4.5 4.5 0 0 1-9 0V6a3 3 0 0 1 6 0v9.5a1.5 1.5 0 0 1-3 0V7h-1.5v8.5a3 3 0 0 0 6 0V6a4.5 4.5 0 0 0-9 0v10.5a6 6 0 0 0 12 0v-10z",
    filter: "M3 5h18l-7 8.5V19l-4 2v-7.5z",
    archive: "M3 4h18v4H3zm1 5h16v11H4zm5 2v2h6v-2z",
    download: "M11 4h2v9.6l3.3-3.3 1.4 1.4L12 17.4l-5.7-5.7 1.4-1.4 3.3 3.3zM5 19h14v2H5z",
    sort: "M7 4l4 4H8v12H6V8H3zm10 16l-4-4h3V4h2v12h3z",
    gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.6 5.3-.1-2.6 2-1.6-2-3.4-2.4.8-2.2-1.3L15.4 2h-3.9l-.5 2.6-2.2 1.3-2.4-.8-2 3.4 2 1.6-.1 2.6-2 1.6 2 3.4 2.4-.8 2.2 1.3.5 2.6h3.9l.5-2.6 2.2-1.3 2.4.8 2-3.4z",
    chevron: "M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z",
    lock: "M7 10V8a5 5 0 0 1 10 0v2h1v11H6V10zm2 0h6V8a3 3 0 0 0-6 0z",
    save: "M5 3h11l3 3v15H5zm2 2v5h8V5zm5 9a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
    reload: "M12 5a7 7 0 1 0 6.9 8h-2.05A5 5 0 1 1 12 7c1.4 0 2.6.6 3.5 1.5L13 11h7V4l-2.6 2.6A7 7 0 0 0 12 5z",
    eye: "M12 5c-5 0-9.27 3.11-11 7.5C2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", paths[name] || "");
  svg.appendChild(p);
  return svg;
}
