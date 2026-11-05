/*
 * Ricerca TKT — versione "segnalibro" (bookmarklet).
 *
 * Si avvia dentro l'Area Riservata Zucchetti, già aperta e con l'utente
 * collegato: usa la sessione del browser, quindi non servono password, server
 * o installazioni. Le ricerche passano dalla stessa routine Solr della pagina
 * (spsl_fquery_mc), una richiesta per ricerca, con il limite di risultati di
 * Zucchetti. Preferiti, note, ricerche salvate e cronologia restano nel browser
 * (localStorage del sito Zucchetti).
 */
(() => {
  "use strict";
  const NS = "__RicercaTKT__";
  const VERSION = "1.0.2";
  if (window[NS]) { window[NS].toggle(); return; }
  try {

  // ===================================================================== funzioni native
  // Le pagine Zucchetti (controls.js, MooTools) ridefiniscono alcune funzioni globali del
  // browser, ad esempio Set. Usiamo quelle originali, prese da un riquadro nascosto e pulito.
  const PRISTINE = (() => {
    let fw = null;
    const frameWin = () => {
      if (!fw) {
        const f = document.createElement("iframe");
        f.id = "ricerca-tkt-realm";
        f.setAttribute("aria-hidden", "true");
        f.tabIndex = -1;
        f.style.cssText = "display:none!important";
        document.documentElement.appendChild(f);
        fw = f.contentWindow;
      }
      return fw;
    };
    const isNative = (v) => {
      try { return typeof v === "function" && /\{\s*\[native code\]\s*\}\s*$/.test(frameWin().Function.prototype.toString.call(v)); } catch { return false; }
    };
    const pick = (name) => (isNative(window[name]) ? window[name] : frameWin()[name]);
    const nativeFetch = isNative(window.fetch);
    return {
      Set: pick("Set"), Map: pick("Map"), URL: pick("URL"), URLSearchParams: pick("URLSearchParams"),
      DOMParser: pick("DOMParser"), Blob: pick("Blob"), AbortController: pick("AbortController"),
      DOMException: pick("DOMException"), Promise: pick("Promise"),
      Intl: frameWin().Intl,
      JSON: window.JSON && isNative(window.JSON.parse) && isNative(window.JSON.stringify) ? window.JSON : frameWin().JSON,
      fetch: nativeFetch ? (...a) => window.fetch(...a) : (...a) => frameWin().fetch(...a),
    };
  })();
  // eslint-disable-next-line no-shadow
  const { Set, Map, URL, URLSearchParams, DOMParser, Blob, AbortController, DOMException, Promise, Intl, JSON, fetch } = PRISTINE;

  // ===================================================================== ambiente
  function findRoot() {
    const p = location.pathname;
    const i = p.toLowerCase().indexOf("/areariservata/");
    if (i >= 0) return location.origin + p.slice(0, i + "/areariservata/".length);
    const m = p.match(/^(.*\/)(jsp|servlet)\//i);
    return m ? location.origin + m[1] : null;
  }
  const ROOT = findRoot();
  if (!ROOT) {
    alert("Ricerca TKT: apri prima l'Area Riservata Zucchetti (dopo aver fatto l'accesso) e poi clicca di nuovo il segnalibro.");
    return;
  }

  function sameOriginWindows(win, depth, out) {
    out.push(win);
    if (depth > 3) return out;
    for (let i = 0; i < win.frames.length; i++) {
      try {
        const f = win.frames[i];
        void f.location.href; // eccezione se di un'altra origine
        sameOriginWindows(f, depth + 1, out);
      } catch { /* frame di altra origine */ }
    }
    return out;
  }

  const PORTLETS = [
    { name: "spsl_wsolrresultsgrid", kind: "grid" },
    { name: "spsl_wfast_search", kind: "fast" },
  ];
  function findPortlet() {
    for (const w of sameOriginWindows(window, 0, [])) {
      let V;
      try { V = w.ZtVWeb; } catch { continue; }
      if (!V || typeof V.getPortlet !== "function") continue;
      for (const def of PORTLETS) {
        let p = null;
        try { p = V.getPortlet(def.name); } catch { p = null; }
        if (p && p.splResults && typeof p.splResults.Link === "function") return { p, w, kind: def.kind };
      }
    }
    return null;
  }

  // ===================================================================== archivio locale
  const store = {
    get(key, def) {
      try { const v = localStorage.getItem("rtkt:" + key); return v === null ? def : JSON.parse(v); } catch { return def; }
    },
    set(key, value) {
      try { localStorage.setItem("rtkt:" + key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };
  const FIELD_DEFS = [
    ["number", "Numero ticket", "core"], ["subject", "Oggetto", "core"], ["text", "Testo", "core"],
    ["date", "Data", "core"], ["product", "Prodotto", "core"],
    ["centro_servizi", "Centro servizi"], ["stato", "Stato tickets"], ["stato_base", "Stato base"],
    ["priorita", "Priorità"], ["tipologia", "Tipologia"],
    ["gruppo", "Gruppo", "", "Gruppo di assistenza che ha in carico il ticket"],
    ["operatore", "Operatore", "", "Operatore di assistenza che ha in carico il ticket"],
    ["azienda", "Azienda"], ["persona", "Persona", "", "Persona dell'azienda richiedente"],
    ["operatore_partecipante", "Operatore partecipante", "", "Operatore che ha partecipato al ticket"],
    ["gruppo_partecipante", "Gruppo partecipante", "", "Gruppo di assistenza che ha partecipato al ticket"],
    ["classificazione", "Classificazione"], ["argomento", "Argomento"],
  ].map(([key, label, group, hint]) => ({ key, label, group: group || "riepilogo", hint: hint || "" }));
  // Lingua "ITA" come la ricerca veloce della testata Zucchetti (pLangs=g_UserLang): con pLangs
  // vuoto la routine risponde {"errors":["TICKET"]} e nessun risultato.
  const DEFAULT_SETTINGS = { v: 2, core: "TICKET", area: "", langs: "ITA", mapping: {}, cap: 210, earliestYear: 2010 };
  const storedSettings = store.get("settings", {}) || {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings);
  settings.mapping = Object.assign({}, settings.mapping || {});
  if (!(storedSettings.v >= 2) && Object.keys(storedSettings).length) {
    if (!settings.langs) settings.langs = "ITA";
    settings.v = 2;
    store.set("settings", settings);
  }
  const TITLE_RE = /^\s*\[#(\d+)\]\s*\[([^\]]*)\]\s*\[(\d{1,2})-(\d{1,2})-(\d{4})\]\s*/;

  // ===================================================================== query Solr
  const SPECIAL = /([+\-&|!(){}[\]^"~*?:\\/])/g;
  const BOOL = new Set(["AND", "OR", "NOT", "TO"]);
  const EDGE = /^[.,;:!?()[\]{}<>\u00ab\u00bb"'`]+|[.,;:!?()[\]{}<>\u00ab\u00bb"'`]+$/g;
  class QueryError extends Error {}

  const solrField = (key) => (settings.mapping[key] || "").trim() || null;
  function escapeTerm(t) {
    t = t.replace(SPECIAL, "\\$1");
    return BOOL.has(t.toUpperCase()) ? t.toLowerCase() : t;
  }
  function quotePhrase(t) {
    return '"' + t.split(/\s+/).filter(Boolean).join(" ").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  function splitUserText(text) {
    const out = [];
    for (const m of (text || "").matchAll(/"([^"]*)"|(\S+)/g)) {
      if (m[1] !== undefined) {
        const v = m[1].split(/\s+/).filter(Boolean).join(" ");
        if (v) out.push(["phrase", v]);
      } else {
        const v = m[2].replace(EDGE, "");
        if (v) out.push(["term", v]);
      }
    }
    return out;
  }
  function termClause(term, prefix, fuzzy) {
    const esc = escapeTerm(term);
    const word = /^\p{L}+$/u.test(term);
    const p = prefix && word && term.length >= 3;
    const f = fuzzy && word && term.length >= 4;
    if (p && f) return `(${esc}* OR ${esc}~1)`;
    if (p) return `${esc}*`;
    if (f) return `${esc}~1`;
    return esc;
  }
  function orGroup(items) { return items.length === 1 ? items[0] : "(" + items.join(" OR ") + ")"; }
  function parseNumbers(text) {
    const singles = [];
    const ranges = [];
    for (let chunk of (text || "").replace(/#/g, " ").split(/[\s,;]+/)) {
      chunk = chunk.trim();
      if (!chunk) continue;
      const m = chunk.match(/^(\d{1,12})(?:-|\.\.)(\d{1,12})$/);
      if (m) { const a = +m[1], b = +m[2]; ranges.push([Math.min(a, b), Math.max(a, b)]); continue; }
      if (!/^\d+$/.test(chunk)) throw new QueryError(`Numero ticket non valido: "${chunk}"`);
      if (!singles.includes(+chunk)) singles.push(+chunk);
    }
    if (singles.length > 1000) throw new QueryError("Troppi numeri ticket (massimo 1000)");
    return { singles, ranges };
  }
  function fieldValue(v) {
    v = v.trim();
    if (/[*?]/.test(v)) return v.replace(/([+\-&|!(){}[\]^"~:\\/])/g, "\\$1").replace(/ /g, "\\ ");
    return quotePhrase(v);
  }
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  const cmpDate = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
  function nextDay(d) {
    return d.d < lastDay(d.y, d.m) ? { y: d.y, m: d.m, d: d.d + 1 }
      : d.m < 12 ? { y: d.y, m: d.m + 1, d: 1 } : { y: d.y + 1, m: 1, d: 1 };
  }
  function datePhraseClause(start, end) {
    const build = (years) => {
      const parts = [];
      let d = start;
      while (cmpDate(d, end) <= 0) {
        if (years && d.m === 1 && d.d === 1 && cmpDate({ y: d.y, m: 12, d: 31 }, end) <= 0) {
          parts.push(String(d.y)); d = { y: d.y + 1, m: 1, d: 1 }; continue;
        }
        const ld = lastDay(d.y, d.m);
        if (d.d === 1 && cmpDate({ y: d.y, m: d.m, d: ld }, end) <= 0) {
          parts.push(quotePhrase(`${pad(d.m)}-${d.y}`));
          d = d.m < 12 ? { y: d.y, m: d.m + 1, d: 1 } : { y: d.y + 1, m: 1, d: 1 };
        } else {
          parts.push(quotePhrase(`${pad(d.d)}-${pad(d.m)}-${d.y}`)); d = nextDay(d);
        }
        if (parts.length > 5000) break;
      }
      return parts;
    };
    let parts = build(false);
    if (parts.length > 400) parts = build(true);
    return orGroup(parts);
  }
  function wrap(c) {
    if (c.startsWith("(") && c.endsWith(")")) {
      let depth = 0, q = false, esc = false, ok = true;
      for (let i = 0; i < c.length; i++) {
        const ch = c[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { q = !q; continue; }
        if (q) continue;
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0 && i !== c.length - 1) { ok = false; break; } }
      }
      if (ok && depth === 0) return c;
    }
    return `(${c})`;
  }
  function todayParts() { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }; }

  function buildQuery(s) {
    const clauses = [];
    const negatives = [];
    const warnings = [];
    const post = { from: null, to: null, numbers: [], ranges: [], pin: [], pout: [] };
    const text = (s.text || "").trim();
    let tc = null;
    if (text) {
      if (s.mode === "solr") tc = text;
      else if (s.mode === "phrase") tc = quotePhrase(text.replace(/"/g, " ")) + (s.proximity ? `~${s.proximity}` : "");
      else {
        const parts = splitUserText(text).map(([k, v]) => (k === "phrase" ? quotePhrase(v) : termClause(v, s.prefix, s.fuzzy)));
        if (parts.length) tc = parts.join(s.mode === "all" ? " AND " : " OR ");
      }
    }
    if ((s.phrase || "").trim()) {
      const p = quotePhrase(s.phrase.replace(/"/g, " "));
      tc = tc ? `(${tc}) AND ${p}` : p;
    }
    if (tc) {
      const sf = s.scope === "subject" ? solrField("subject") : s.scope === "text" ? solrField("text") : null;
      if (s.scope !== "all" && !sf) warnings.push("Il campo per 'Cerca in' non è mappato (Impostazioni): la ricerca è su tutti i campi.");
      clauses.push(sf ? `${sf}:(${tc})` : tc);
    }
    const excl = splitUserText(s.exclude).map(([k, v]) => (k === "phrase" ? quotePhrase(v) : escapeTerm(v)));
    if (excl.length) negatives.push(`NOT ${orGroup(excl)}`);

    const { singles, ranges } = parseNumbers(s.numbers);
    if (singles.length || ranges.length) {
      post.numbers = singles; post.ranges = ranges;
      const nf = solrField("number");
      if (nf) clauses.push(`${nf}:${orGroup([...singles.map(String), ...ranges.map(([a, b]) => `[${a} TO ${b}]`)])}`);
      else {
        if (singles.length && !ranges.length) clauses.push(orGroup(singles.map(String)));
        if (ranges.length) warnings.push("Gli intervalli di numeri ticket sono applicati solo ai risultati restituiti (campo 'Numero ticket' non mappato).");
      }
    }
    const pf = solrField("product");
    if (s.products_in.length) {
      post.pin = s.products_in.slice();
      clauses.push(pf ? `${pf}:${orGroup(s.products_in.map(quotePhrase))}` : orGroup(s.products_in.map(escapeTerm)));
    }
    if (s.products_out.length) {
      post.pout = s.products_out.slice();
      if (pf) negatives.push(`NOT ${pf}:${orGroup(s.products_out.map(quotePhrase))}`);
    }
    for (const [key, raw] of Object.entries(s.fields || {})) {
      const fname = solrField(key);
      const def = FIELD_DEFS.find((f) => f.key === key);
      if (!def) continue;
      if (!fname) { warnings.push(`Il filtro '${def.label}' non è mappato ed è stato ignorato.`); continue; }
      const pos = [], neg = [];
      for (let v of raw.split(/[;,\n]+/)) {
        v = v.trim();
        if (!v) continue;
        if ((v[0] === "-" || v[0] === "!") && v.length > 1) neg.push(v.slice(1).trim()); else pos.push(v);
      }
      if (pos.length) clauses.push(`${fname}:${orGroup(pos.map(fieldValue))}`);
      if (neg.length) negatives.push(`NOT ${fname}:${orGroup(neg.map(fieldValue))}`);
    }
    const from = parseISO(s.date_from), to = parseISO(s.date_to);
    if (from && to && cmpDate(from, to) > 0) throw new QueryError("La data iniziale è successiva a quella finale");
    if (from || to) {
      const df = solrField("date");
      if (df) {
        const lo = from ? `${from.y}-${pad(from.m)}-${pad(from.d)}T00:00:00Z` : "*";
        const hi = to ? `${to.y}-${pad(to.m)}-${pad(to.d)}T23:59:59Z` : "*";
        clauses.push(`${df}:[${lo} TO ${hi}]`);
      } else {
        clauses.push(datePhraseClause(from || { y: settings.earliestYear, m: 1, d: 1 }, to || todayParts()));
        post.from = s.date_from || null; post.to = s.date_to || null;
      }
    }
    if (!clauses.length && !negatives.length) {
      if (post.ranges.length) throw new QueryError("Gli intervalli di numeri ticket vanno combinati con un testo o un altro criterio (campo 'Numero ticket' non mappato).");
      throw new QueryError("Inserisci almeno un criterio di ricerca.");
    }
    const positives = clauses.length ? clauses : ["*:*"];
    const mustWrap = positives.length > 1 || negatives.length > 0;
    let q = positives.map((p) => (mustWrap && p !== "*:*" ? wrap(p) : p)).join(" AND ");
    for (const n of negatives) q += ` AND ${n}`;
    return { query: q, warnings, post };
  }
  function acceptsPost(post, t) {
    if (post.from || post.to) {
      if (!t.date) return false;
      if (post.from && t.date < post.from) return false;
      if (post.to && t.date > post.to) return false;
    }
    if (post.numbers.length || post.ranges.length) {
      if (t.number == null) return false;
      if (!post.numbers.includes(t.number) && !post.ranges.some(([a, b]) => t.number >= a && t.number <= b)) return false;
    }
    const prod = (t.product || "").toUpperCase();
    if (post.pin.length && !post.pin.includes(prod)) return false;
    if (post.pout.length && post.pout.includes(prod)) return false;
    return true;
  }

  // ===================================================================== risposta
  function htmlSegments(html) {
    if (html === null || html === undefined) return [];
    const src = String(html);
    const segs = [];
    const push = (t, hl) => {
      if (!t) return;
      const last = segs[segs.length - 1];
      if (last && last[1] === hl) last[0] += t; else segs.push([t, hl]);
    };
    if (!/[<&]/.test(src)) push(src, false);
    else {
      const doc = new DOMParser().parseFromString(`<body>${src}</body>`, "text/html");
      const walk = (node, hl) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) push(c.nodeValue, hl);
          else if (c.nodeType === 1) {
            const tag = c.tagName.toLowerCase();
            if (tag === "script" || tag === "style") continue;
            if (tag === "br" || tag === "p" || tag === "div" || tag === "li") push(" ", hl);
            const on = hl || (c.getAttribute("solrfound") || "").toLowerCase() === "true" || /^(em|b|strong|mark)$/.test(tag);
            walk(c, on);
          }
        }
      };
      walk(doc.body, false);
    }
    const out = [];
    for (const [t, hl] of segs) {
      const v = t.replace(/\s+/g, " ");
      const last = out[out.length - 1];
      if (last && last[1] === hl) last[0] += v; else out.push([v, hl]);
    }
    if (out.length) { out[0][0] = out[0][0].replace(/^ +/, ""); out[out.length - 1][0] = out[out.length - 1][0].replace(/ +$/, ""); }
    return out.filter((s) => s[0]).map((s) => [s[0].replace(/ {2,}/g, " "), s[1]]);
  }
  const segText = (segs) => segs.map((s) => s[0]).join("");
  function sliceSegs(segs, start) {
    const out = [];
    let pos = 0;
    for (const [t, hl] of segs) {
      const a = pos, b = pos + t.length;
      pos = b;
      if (b <= start) continue;
      out.push([t.slice(Math.max(0, start - a)), hl]);
    }
    return out;
  }
  function ci(obj, ...names) {
    for (const k of Object.keys(obj)) if (names.includes(k.toLowerCase())) return obj[k];
    return undefined;
  }
  function resolveUrl(url) {
    if (!url) return null;
    url = String(url).trim();
    if (!url || /^(function:|javascript:)/i.test(url)) return null;
    const m = url.match(/^\[\s*target:[^\]]*\]\s*(.*)$/i);
    if (m) url = m[1].trim();
    try {
      const u = new URL(url, ROOT + "jsp/");
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch { return null; }
  }
  function parseResponse(raw) {
    let payload;
    try {
      payload = typeof raw === "string" ? JSON.parse(raw.replace(/^\ufeff/, "").trim()) : raw;
    } catch {
      const err = new Error("La risposta di Zucchetti non è nel formato atteso (forse la sessione è scaduta: ricarica la pagina e accedi di nuovo).");
      err.sample = String(raw).slice(0, 500);
      throw err;
    }
    if (!payload || typeof payload !== "object") throw new Error("Risposta di Zucchetti vuota o inattesa.");
    const fields = (ci(payload, "fields") || []).map(String);
    const data = ci(payload, "data") || [];
    const rows = [];
    for (const r of data) {
      if (Array.isArray(r) && r.length >= fields.length && fields.length) {
        const o = {};
        fields.forEach((f, i) => { o[f] = r[i]; });
        rows.push(o);
      } else if (r && typeof r === "object" && !Array.isArray(r)) rows.push(r);
    }
    let mr = ci(payload, "maxresults");
    if (Array.isArray(mr)) mr = mr[0];
    const maxResults = parseInt(mr, 10) || null;
    let errors = ci(payload, "errors") || [];
    if (!Array.isArray(errors)) errors = [String(errors)];
    const tickets = rows.map((row, i) => {
      const titleSegs = htmlSegments(ci(row, "description"));
      const title = segText(titleSegs);
      const m = TITLE_RE.exec(title);
      const t = {
        key: "", id: String(ci(row, "id") ?? "").trim(), number: null, product: "", date: null,
        title, subject: title, subject_hl: titleSegs, rank: i,
        rawUrl: String(ci(row, "url1") ?? ""), type: String(ci(row, "type") ?? ""), row,
      };
      if (m) {
        t.number = parseInt(m[1], 10);
        t.product = m[2].trim();
        const d = +m[3], mo = +m[4], y = +m[5];
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= lastDay(y, mo)) t.date = `${y}-${pad(mo)}-${pad(d)}`;
        t.subject_hl = sliceSegs(titleSegs, m[0].length);
        t.subject = segText(t.subject_hl).trim();
      }
      t.snippet_hl = htmlSegments(ci(row, "altdescription"));
      t.snippet = segText(t.snippet_hl);
      t.url = resolveUrl(t.rawUrl);
      t.key = t.number != null ? `n${t.number}` : t.id ? `i${t.id}` : `t${title}`;
      return t;
    });
    const cap = maxResults || settings.cap;
    return { tickets, rawCount: rows.length, dataLength: data.length, fields, maxResults, capped: rows.length >= cap, errors, facet: ci(payload, "facet") || [] };
  }

  // ===================================================================== connessione a Zucchetti
  const conn = {
    found: null, template: null, templateOk: true, mcid: null, mode: "", lastRequest: null, lastRaw: "", lastSummary: null,
    inNative: false, pageRequests: [], seenFields: new Set(store.get("seenFields", [])), onPageSearch: null,
  };

  function requestParams(r) {
    const out = {};
    try { for (const [k, v] of new URL(r.url, r.base || location.href).searchParams) out[k] = v; } catch { /* */ }
    if (r.body && r.body.includes("=")) for (const [k, v] of new URLSearchParams(r.body)) out[k] = v;
    return out;
  }

  /** Osserva (senza modificarle) le ricerche fatte dalla pagina Zucchetti: parametri reali e nomi dei campi Solr. */
  function observeWindow(w) {
    try {
      const proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
      if (!proto || proto.__rtktObserved) return;
      const o = proto.open, snd = proto.send, hdr = proto.setRequestHeader;
      proto.open = function (method, url) {
        try { this.__rtktObs = { method: String(method || "GET").toUpperCase(), url: String(url), headers: {}, base: w.location.href }; } catch { /* */ }
        return o.apply(this, arguments);
      };
      proto.setRequestHeader = function (k, v) { try { if (this.__rtktObs) this.__rtktObs.headers[k] = v; } catch { /* */ } return hdr.apply(this, arguments); };
      proto.send = function (body) {
        try {
          const r = this.__rtktObs;
          if (r && /spsl_fquery_mc/i.test(r.url) && !conn.inNative) {
            r.body = typeof body === "string" ? body : "";
            r.at = new Date().toISOString();
            pageSearchSeen(r);
          }
        } catch { /* */ }
        return snd.apply(this, arguments);
      };
      Object.defineProperty(proto, "__rtktObserved", { value: true });
    } catch { /* finestra non accessibile */ }
  }
  function pageSearchSeen(r) {
    const p = requestParams(r);
    const kw = p.pKeyword || "";
    conn.pageRequests.unshift({ at: r.at, method: r.method, url: r.url, body: r.body, params: p });
    conn.pageRequests.length = Math.min(conn.pageRequests.length, 10);
    for (const m of kw.matchAll(/(^|[\s(+\-!])([A-Za-z_][A-Za-z0-9_.]*):/g)) conn.seenFields.add(m[2]);
    store.set("seenFields", [...conn.seenFields]);
    store.set("pageParams", { pArea: p.pArea ?? null, pLangs: p.pLangs ?? null, pCore: p.pCore ?? null, at: r.at });
    if (kw && !conn.template && conn.found) learnTemplate(r, kw);
    if (conn.onPageSearch) try { conn.onPageSearch(p); } catch { /* */ }
  }
  for (const w of sameOriginWindows(window, 0, [])) observeWindow(w);
  conn.found = findPortlet();

  function pageLang() {
    for (const w of sameOriginWindows(window, 0, [])) {
      try {
        for (const name of ["gspv_fheader_search", "spsl_wfast_search"]) {
          const p = w.ZtVWeb && w.ZtVWeb.getPortlet(name);
          const v = p && p.g_UserLang && p.g_UserLang.Value();
          if (v) return String(v);
        }
      } catch { /* */ }
    }
    return "";
  }

  function captureXHR(win) {
    const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    const reqs = [];
    if (!proto) return { reqs, restore() {} };
    const o = proto.open, s = proto.send, h = proto.setRequestHeader;
    proto.open = function (method, url) { this.__rtkt = { method: String(method || "GET").toUpperCase(), url: String(url), headers: {} }; return o.apply(this, arguments); };
    proto.setRequestHeader = function (k, v) { if (this.__rtkt) this.__rtkt.headers[k] = v; return h.apply(this, arguments); };
    proto.send = function (body) { if (this.__rtkt) { this.__rtkt.body = typeof body === "string" ? body : ""; reqs.push(this.__rtkt); } return s.apply(this, arguments); };
    return { reqs, restore() { proto.open = o; proto.send = s; proto.setRequestHeader = h; } };
  }

  function learnTemplate(req, q) {
    let url;
    try { url = new URL(req.url, conn.found.w.location.href); } catch { return; }
    const body = req.body && req.body.includes("=") ? new URLSearchParams(req.body) : new URLSearchParams();
    const where = [...body.entries()].some(([, v]) => v === q) ? "body" : [...url.searchParams.entries()].some(([, v]) => v === q) ? "query" : null;
    if (!where) return;
    const params = where === "body" ? body : url.searchParams;
    const kw = [...params.entries()].find(([, v]) => v === q)[0];
    conn.template = { method: req.method, url: url.href, body: req.body || "", headers: req.headers, where, kw, kind: conn.found.kind };
    const mc = (where === "body" ? body : url.searchParams).get("m_cID") || url.searchParams.get("m_cID");
    if (mc) conn.mcid = mc;
  }

  function nativeCall(q, opt) {
    const { p, w, kind } = conn.found;
    const restores = [];
    const set = (name, value) => {
      const c = p[name];
      if (!c || typeof c.Value !== "function") return;
      const old = c.Value();
      c.Value(value);
      restores.push(() => { try { c.Value(old); } catch { /* */ } });
    };
    if (kind === "grid") { set("userInput", q); set("area", opt.area); set("pCore", opt.core); set("langs", opt.langs); }
    else { set("input", q); set("pCore", opt.core); if (opt.langs) set("g_UserLang", opt.langs); }
    const cap = captureXHR(w);
    let raw;
    conn.inNative = true;
    try { raw = p.splResults.Link(); } finally { conn.inNative = false; cap.restore(); restores.reverse().forEach((r) => r()); }
    const req = cap.reqs.find((r) => /spsl_fquery_mc/i.test(r.url)) || cap.reqs[cap.reqs.length - 1];
    if (req) { conn.lastRequest = req; learnTemplate(req, q); }
    conn.mode = "native";
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  }

  async function templateCall(q, opt, signal) {
    const t = conn.template;
    const url = new URL(t.url);
    const params = t.where === "body" ? new URLSearchParams(t.body) : url.searchParams;
    params.set(t.kw, q);
    if (params.has("pCore")) params.set("pCore", opt.core);
    if (params.has("pArea")) params.set("pArea", opt.area);
    if (params.has("pLangs") && (t.kind === "grid" || opt.langs)) params.set("pLangs", opt.langs);
    const headers = Object.assign({}, t.headers);
    const init = { method: t.method, credentials: "same-origin", headers, signal };
    if (t.where === "body") init.body = params.toString();
    if (init.body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    conn.lastRequest = { method: t.method, url: url.href, body: init.body || "", headers };
    const res = await fetch(url.href, init);
    if (!res.ok) throw new Error(`Zucchetti ha risposto con errore HTTP ${res.status}`);
    conn.mode = "template";
    return res.text();
  }

  async function discoverMcid() {
    if (conn.mcid) return conn.mcid;
    for (const src of ["jsp/spsl_wsolrresultsgrid_portlet.jsp", "jsp/spsl_wfast_search_portlet.jsp"]) {
      try {
        const r = await fetch(ROOT + src, { credentials: "same-origin" });
        const m = /splResults\.m_cID\s*=\s*'([0-9a-fA-F]{16,64})'/.exec(await r.text());
        if (m) { conn.mcid = m[1]; return m[1]; }
      } catch { /* prossima fonte */ }
    }
    conn.mcid = "1ef51ea72b7e79d713e5b1b42030dfa2";
    return conn.mcid;
  }

  async function directCall(q, opt, signal) {
    const mcid = await discoverMcid();
    const body = new URLSearchParams({ m_cID: mcid, pKeyword: q, pArea: opt.area, pCore: opt.core, pLangs: opt.langs, cs_SITE: "" });
    const url = ROOT + "servlet/spsl_fquery_mc";
    const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" };
    conn.lastRequest = { method: "POST", url, body: body.toString(), headers };
    const res = await fetch(url, { method: "POST", body, headers, credentials: "same-origin", signal });
    if (!res.ok) throw new Error(`Zucchetti ha risposto con errore HTTP ${res.status}`);
    conn.mode = "direct";
    return res.text();
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

  /**
   * Una richiesta per ricerca; solo se Zucchetti risponde con un errore e nessun risultato se ne fa
   * una seconda con parametri alternativi (quelli dell'ultima ricerca della pagina, o lingua ITA),
   * che vengono poi memorizzati.
   */
  async function zSearchWithFallback(q, opt, signal) {
    const r = await zSearch(q, opt, signal);
    if (r.rawCount || !r.errors.length) return r;
    const pp = store.get("pageParams", null);
    const cands = [];
    if (pp && (pp.pLangs !== null || pp.pArea !== null)) cands.push({ core: pp.pCore || opt.core, area: pp.pArea ?? opt.area, langs: pp.pLangs ?? opt.langs });
    const pl = pageLang() || "ITA";
    cands.push({ core: opt.core, area: opt.area, langs: pl });
    const alt = cands.find((c) => c.core !== opt.core || c.area !== opt.area || c.langs !== opt.langs);
    if (!alt) return r;
    const r2 = await zSearch(q, alt, signal);
    if (r2.rawCount || !r2.errors.length) {
      Object.assign(settings, { core: alt.core, area: alt.area, langs: alt.langs });
      store.set("settings", settings);
      r2.fixed = alt;
      return r2;
    }
    return r;
  }

  /** Una sola richiesta: prima il modello appreso, poi il portlet della pagina, poi la chiamata diretta. */
  async function zSearch(q, opt, signal) {
    if (!conn.found) conn.found = findPortlet();
    let raw;
    const ascii = /^[\x20-\x7e]*$/.test(q);
    if (conn.template && conn.templateOk && ascii) {
      raw = await templateCall(q, opt, signal);
      try { const r = parseResponse(raw); conn.lastRaw = raw; return r; } catch (e) {
        conn.templateOk = false;
        if (!conn.found) throw e;
      }
    }
    if (conn.found) {
      await nextFrame(); // lascia disegnare "Ricerca in corso…" (la chiamata della pagina è sincrona)
      if (signal && signal.aborted) throw new DOMException("interrotta", "AbortError");
      raw = nativeCall(q, opt);
    } else {
      raw = await directCall(q, opt, signal);
    }
    conn.lastRaw = raw;
    return parseResponse(raw);
  }

  // ===================================================================== utilità UI
  const NF = new Intl.NumberFormat("it-IT");
  const fmtN = (n) => NF.format(n || 0);
  const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const MESI_L = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const fmtDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  const fmtDT = (iso) => { try { return new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }); } catch { return iso; } };
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const norm = (s) => (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    add(el, children);
    return el;
  }
  function add(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    }
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const segNodes = (segs, fb) => (segs && segs.length ? segs.map(([t, hl]) => (hl ? h("mark", null, t) : t)) : [fb || ""]);

  // ===================================================================== stile
  const CSS = `
:host{all:initial}
.ov{--bg:#f4f6f9;--sf:#fff;--sf2:#f0f3f7;--bd:#dde3ea;--bd2:#c3ccd7;--tx:#1c2430;--mu:#5d6b7c;--ac:#1f5fbf;--ac2:#194f9f;--acs:#e3edfb;--act:#fff;--mk:#fff1a8;--mkt:#2a2200;--wb:#fff6e0;--wbd:#f0cf7a;--wt:#5c4300;--er:#b42318;--eb:#fdecea;--st:#e0a100;--sh:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
position:fixed;inset:0;z-index:2147483646;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased;text-align:left;color-scheme:light}
@media (prefers-color-scheme:dark){.ov{--bg:#0f141b;--sf:#161d26;--sf2:#1c2530;--bd:#2a3542;--bd2:#3a4757;--tx:#e4e9f0;--mu:#9aa8b8;--ac:#5b9bff;--ac2:#7aafff;--acs:#1b2b44;--act:#0b1220;--mk:#5a4a00;--mkt:#fff4c2;--wb:#2d2610;--wbd:#6b5617;--wt:#f3dc9b;--er:#ff8a80;--eb:#3a1714;--st:#ffc940;--sh:0 1px 2px rgba(0,0,0,.4);color-scheme:dark}}
*{box-sizing:border-box}[hidden]{display:none!important}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}code{background:var(--sf2);padding:1px 5px;border-radius:4px}
h2{font-size:18px;margin:0 0 .6em}h3{font-size:14px;margin:0 0 .5em}
.mu{color:var(--mu)}.sm{font-size:12.5px}
input,select,textarea,button{font:inherit;color:inherit;margin:0}
input:not([type=checkbox]):not([type=file]),select,textarea{background:var(--sf);border:1px solid var(--bd2);border-radius:6px;padding:6px 9px;min-height:34px;width:100%}
textarea{resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
input:disabled{opacity:.55;background:var(--sf2);cursor:not-allowed}
.fld{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--mu)}.fld>*:not(span){color:var(--tx);font-size:14px}
.ck{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer}.ck input{width:16px;height:16px;accent-color:var(--ac)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--bd2);background:var(--sf);border-radius:6px;padding:6px 14px;min-height:34px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--sf2);text-decoration:none}.btn.pri{background:var(--ac);border-color:var(--ac);color:var(--act);font-weight:600}.btn.pri:hover{background:var(--ac2)}
.btn.gh{background:transparent;border-color:transparent;color:var(--ac)}.btn.gh:hover{background:var(--acs)}.btn.s{min-height:28px;padding:3px 9px;font-size:13px}.btn.dg{color:var(--er)}.btn:disabled{opacity:.55;cursor:default}
.ib{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:0;background:transparent;color:var(--mu);cursor:pointer;font-size:15px;line-height:1}.ib:hover{background:var(--sf2);color:var(--tx)}.ib.on{color:var(--st)}
.seg{display:inline-flex;flex-wrap:wrap;background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:2px}
.seg button{border:0;background:transparent;padding:5px 11px;border-radius:6px;cursor:pointer;color:var(--mu);font-size:13px}.seg button[aria-checked=true]{background:var(--sf);color:var(--tx);box-shadow:var(--sh);font-weight:600}
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--acs);color:var(--ac)}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;box-shadow:var(--sh);padding:16px}.card+.card{margin-top:14px}
.top{display:flex;align-items:center;gap:16px;padding:8px 18px;background:var(--sf);border-bottom:1px solid var(--bd);flex:none}
#close{margin-left:auto}.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;white-space:nowrap}
.mark{width:26px;height:26px;border-radius:7px;background:var(--ac);position:relative;flex:none}.mark:before{content:"";position:absolute;left:6px;top:6px;width:10px;height:10px;border:2.5px solid #fff;border-radius:50%}.mark:after{content:"";position:absolute;left:17px;top:16px;width:6px;height:2.5px;background:#fff;transform:rotate(45deg);border-radius:2px}
.tabs{display:flex;gap:2px;flex:1;overflow-x:auto}.tabs button{border:0;background:transparent;padding:8px 12px;border-radius:6px;cursor:pointer;color:var(--mu);white-space:nowrap}.tabs button:hover{background:var(--sf2);color:var(--tx)}.tabs button[aria-current=page]{color:var(--ac);background:var(--acs);font-weight:600}
.cnt:not(:empty){font-size:11px;background:var(--sf2);border-radius:999px;padding:0 6px;margin-left:2px}
.body{flex:1;overflow:auto}.page{max-width:1440px;margin:0 auto;padding:16px 18px 60px}
.panel{display:flex;flex-direction:column;gap:12px}
.sbar{display:flex;gap:8px}.sbar input{min-height:44px;font-size:16px}.sbar .btn.pri{min-height:44px;padding:0 22px;font-size:15px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.between{justify-content:space-between}.end{justify-content:flex-end}
.quick{display:grid;grid-template-columns:170px 150px 150px minmax(170px,1fr) minmax(200px,1.4fr);gap:10px;align-items:end}
details.adv{border-top:1px solid var(--bd);padding-top:10px}details.adv summary{cursor:pointer;font-weight:600;color:var(--ac)}
.ag{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
fieldset{border:1px solid var(--bd);border-radius:8px;padding:10px 12px 12px;margin:0;display:flex;flex-direction:column;gap:9px;min-width:0}legend{font-weight:600;font-size:13px;padding:0 4px}.full{grid-column:1/-1}
.fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px 12px}.off{font-size:10.5px;margin-left:4px}
.qp{display:flex;align-items:center;gap:10px;background:var(--sf2);border-radius:8px;padding:6px 10px;flex-wrap:wrap}.qp code{flex:1;min-width:200px;background:transparent;padding:0;word-break:break-all;white-space:pre-wrap;max-height:4.5em;overflow:auto}.qp code.err{color:var(--er);font-family:inherit}
.note{font-size:12.5px;color:var(--wt);background:var(--wb);border:1px solid var(--wbd);border-radius:6px;padding:4px 9px}
.chips-in{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-height:34px;padding:3px 6px;border:1px solid var(--bd2);border-radius:6px;background:var(--sf);cursor:text}.chips-in:focus-within{outline:2px solid var(--ac);outline-offset:1px}
.chips-in input{border:0!important;outline:none!important;min-height:26px!important;padding:0 4px!important;flex:1;min-width:80px;width:auto!important;background:transparent!important}
.chip{display:inline-flex;align-items:center;gap:3px;background:var(--acs);color:var(--ac);border-radius:999px;padding:1px 4px 1px 9px;font-size:12.5px;font-weight:600}.chip button{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 3px;font-size:14px;line-height:1;border-radius:50%}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips:empty{display:none}
.tips{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:var(--mu)}.tips b{color:var(--tx)}
.res-grid{display:grid;grid-template-columns:240px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}
.facets{position:sticky;top:0;padding:12px;display:flex;flex-direction:column;gap:16px}
.facet h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu);margin-bottom:6px}.facet ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.facet li button{width:100%;display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;border:0;background:transparent;text-align:left;padding:4px 6px;border-radius:5px;cursor:pointer;font-size:13px;position:relative}
.facet li button:hover{background:var(--sf2)}.facet li button[aria-pressed=true]{background:var(--acs);color:var(--ac);font-weight:600}.facet .n{color:var(--mu);font-size:12px}
.facet li button .fill{position:absolute;left:0;top:2px;bottom:2px;background:var(--acs);border-radius:4px}.facet li button>span:not(.fill){position:relative}.facet li button[aria-pressed=true] .fill{background:transparent}
.prog{padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px}.bar{flex:1;height:6px;background:var(--sf2);border-radius:3px;overflow:hidden}.bar span{display:block;height:100%;width:30%;background:var(--ac);animation:ind 1.1s infinite ease-in-out}@keyframes ind{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
.alert{border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:13.5px;display:flex;flex-direction:column;gap:4px;background:var(--wb);border:1px solid var(--wbd);color:var(--wt)}.alert.err{background:var(--eb);border-color:var(--er);color:var(--er)}
.sum{margin-bottom:8px}.tb{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.tb .rf{flex:1;min-width:220px;width:auto}.tb select{width:auto}
.menu{position:relative}.ml{position:absolute;right:0;top:calc(100% + 4px);z-index:5;background:var(--sf);border:1px solid var(--bd2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:4px;display:flex;flex-direction:column;min-width:190px}.ml button{border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:5px;cursor:pointer}.ml button:hover{background:var(--acs)}
.list{display:flex;flex-direction:column;gap:8px}.gt{font-size:12.5px;font-weight:700;color:var(--mu);text-transform:uppercase;letter-spacing:.05em;margin:10px 2px 0;display:flex;gap:8px}
.res{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:10px 14px;display:flex;flex-direction:column;gap:4px}.res.sel{border-color:var(--ac);box-shadow:0 0 0 1px var(--ac) inset}
.rh{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}.rh input[type=checkbox]{width:16px;height:16px;accent-color:var(--ac)}.num{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:13.5px}.sp{flex:1}
.subj{font-size:15.5px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}.snip{color:var(--mu);font-size:13.5px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12.5px}.tag{background:var(--sf2);border:1px solid var(--bd);border-radius:999px;padding:0 8px}.nt{font-style:italic;white-space:pre-wrap;overflow-wrap:anywhere}
mark{background:var(--mk);color:var(--mkt);border-radius:2px;padding:0 1px}
.pager{display:flex;gap:4px;justify-content:center;margin-top:14px;flex-wrap:wrap}.pager button{min-width:34px;height:32px;border:1px solid var(--bd);background:var(--sf);border-radius:6px;cursor:pointer;padding:0 8px}.pager button[aria-current=page]{background:var(--ac);color:var(--act);border-color:var(--ac);font-weight:600}.pager button:disabled{opacity:.45}
.li{display:flex;align-items:center;gap:12px;padding:10px 4px;border-top:1px solid var(--bd);flex-wrap:wrap}.li:first-child{border-top:0}.li .m{flex:1;min-width:200px}.li .t{font-weight:600;overflow-wrap:anywhere}.li .s{font-size:12.5px;color:var(--mu);overflow-wrap:anywhere}.empty{color:var(--mu);padding:18px 4px}
.pre{background:var(--sf2);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;max-height:360px;overflow:auto;margin:10px 0 0}
dialog{border:1px solid var(--bd2);border-radius:12px;padding:20px;width:min(480px,calc(100vw - 32px));background:var(--sf);color:var(--tx);box-shadow:0 20px 50px rgba(0,0,0,.25)}dialog::backdrop{background:rgba(10,15,25,.45)}dialog form{display:flex;flex-direction:column;gap:10px}dialog h3{margin:0;font-size:16px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--tx);color:var(--bg);padding:9px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:13.5px;z-index:3}
@media (max-width:1100px){.quick{grid-template-columns:repeat(3,minmax(0,1fr))}.quick>:nth-child(4),.quick>:nth-child(5){grid-column:span 3}}
@media (max-width:820px){.res-grid{grid-template-columns:1fr}.facets{position:static;flex-direction:row;flex-wrap:wrap}.facet{flex:1 1 200px}.ag{grid-template-columns:1fr}.top{flex-wrap:wrap;gap:8px}.tabs{order:3;flex-basis:100%}}
@media (max-width:560px){.quick{grid-template-columns:1fr 1fr}.quick>:nth-child(1),.quick>:nth-child(4),.quick>:nth-child(5){grid-column:span 2}}
`;

  // ===================================================================== struttura
  const MARKUP = `
<div class="ov" role="dialog" aria-label="Ricerca TKT" aria-modal="true">
 <header class="top">
  <div class="brand"><span class="mark" aria-hidden="true"></span>Ricerca TKT</div>
  <nav class="tabs" id="nav">
   <button type="button" data-tab="search" aria-current="page">Cerca</button>
   <button type="button" data-tab="saved">Salvate</button>
   <button type="button" data-tab="history">Cronologia</button>
   <button type="button" data-tab="favorites">Preferiti <span class="cnt" id="fav-count"></span></button>
   <button type="button" data-tab="settings">Impostazioni</button>
  </nav>
  <button type="button" class="btn gh s" id="close" title="Chiudi (Esc): torni alla pagina Zucchetti">Chiudi ✕</button>
 </header>
 <div class="body" id="scroller"><div class="page">
  <section id="tab-search">
   <form id="sf" class="card panel" autocomplete="off">
    <div class="sbar"><input id="q" type="search" placeholder="Cerca nei ticket… es. detassazione premio" aria-label="Testo da cercare" spellcheck="false" list="hist-list"><datalist id="hist-list"></datalist><button type="submit" class="btn pri" id="go">Cerca</button></div>
    <div class="row">
     <div class="seg" id="mode" role="radiogroup" aria-label="Modalità">
      <button type="button" role="radio" data-mode="all" aria-checked="true" title="Il ticket deve contenere tutte le parole">Tutte le parole</button>
      <button type="button" role="radio" data-mode="any" aria-checked="false" title="Basta una delle parole">Almeno una</button>
      <button type="button" role="radio" data-mode="phrase" aria-checked="false" title="Le parole esattamente in quest'ordine">Frase esatta</button>
      <button type="button" role="radio" data-mode="solr" aria-checked="false" title='Sintassi Lucene/Solr: AND OR NOT ( ) "frase"~N parola* parola~'>Sintassi Solr</button>
     </div>
    </div>
    <div class="quick">
     <label class="fld">Periodo<select id="preset"><option value="">Qualsiasi</option><option value="30d">Ultimi 30 giorni</option><option value="3m">Ultimi 3 mesi</option><option value="6m">Ultimi 6 mesi</option><option value="1y">Ultimi 12 mesi</option><option value="ytd">Anno corrente</option><option value="py">Anno scorso</option><option value="2y">Ultimi 2 anni</option><option value="5y">Ultimi 5 anni</option><option value="custom">Personalizzato</option></select></label>
     <label class="fld">Dal<input type="date" id="dfrom"></label>
     <label class="fld">Al<input type="date" id="dto"></label>
     <label class="fld">Numero ticket<input id="numbers" placeholder="8900042, 8900000-8910000" inputmode="numeric"></label>
     <div class="fld">Prodotti<div class="chips-in" id="pin" data-ph="es. PAGHEW"></div></div>
    </div>
    <details class="adv" id="adv"><summary>Opzioni avanzate <span class="mu sm" id="adv-n"></span></summary>
     <div class="ag">
      <fieldset><legend>Testo</legend>
       <label class="fld">Escludi parole<input id="exclude" placeholder='es. storno "cassa integrazione"'></label>
       <label class="fld">Deve contenere la frase<input id="phrase" placeholder="es. premio di risultato"></label>
       <label class="fld">Cerca in<select id="scope"><option value="all">Testo e oggetto</option><option value="subject">Solo oggetto</option><option value="text">Solo testo</option></select></label>
       <label class="fld">Distanza massima tra le parole (frase esatta)<input id="prox" type="number" min="0" max="50" value="0"></label>
       <label class="ck"><input type="checkbox" id="prefix"> Corrispondenza parziale (detass… trova detassazione)</label>
       <label class="ck"><input type="checkbox" id="fuzzy"> Tolleranza errori di battitura</label>
      </fieldset>
      <fieldset><legend>Prodotti da escludere</legend>
       <div class="chips-in" id="pout" data-ph="es. HRPORTAL"></div>
       <legend>Indice di ricerca</legend>
       <label class="fld">Indice (core)<input id="core"></label>
       <label class="fld">Area<input id="area"></label>
       <label class="fld">Lingue<input id="langs"></label>
      </fieldset>
      <fieldset class="full"><legend>Filtri su dati di riepilogo tickets</legend><div class="fg" id="rie"></div>
       <p class="mu sm" style="margin:0">Più valori separati da virgola; anteponi <code>-</code> per escludere; <code>*</code> come jolly. I campi "non mappati" si attivano da Impostazioni.</p></fieldset>
     </div>
    </details>
    <div class="qp"><span class="mu sm">Query Solr</span><code id="qprev" class="mono"></code>
     <div class="row" style="gap:2px"><button type="button" class="btn gh s" id="qcopy">Copia</button><button type="button" class="btn gh s" id="qedit">Modifica</button><button type="button" class="btn gh s" id="qsave">Salva ricerca</button><button type="button" class="btn gh s" id="qreset">Azzera</button></div></div>
    <div id="qwarn" class="list" style="gap:4px"></div>
   </form>
   <div id="emptyst" class="card" style="margin-top:16px"><h2>Come cercare</h2><ul class="tips">
    <li><b>Tutte le parole</b>: <code>detassazione premio</code> trova i ticket che contengono entrambe.</li>
    <li>Virgolette per una frase: <code>"premio di risultato" conguaglio</code>.</li>
    <li><b>Sintassi Solr</b>: <code>(detassazione OR "premio di risultato") AND NOT storno</code>, <code>detass*</code>, <code>conguaglo~</code>.</li>
    <li><code>#8900042</code> nel campo di ricerca cerca direttamente quel ticket.</li>
    <li>Zucchetti restituisce al massimo <span class="capn">210</span> risultati, i più rilevanti: usa periodo, prodotti e filtri per restringere. Poi affina con i filtri a sinistra dei risultati.</li>
    <li><kbd>/</kbd> per cercare, <kbd>Esc</kbd> per chiudere e tornare alla pagina Zucchetti. Riclicca il segnalibro per riaprire.</li></ul></div>
   <div id="results" class="res-grid" hidden>
    <aside class="card facets"><div class="facet"><h3>Prodotto</h3><ul id="f-prod"></ul></div><div class="facet"><h3>Anno</h3><ul id="f-year"></ul></div><div class="facet" id="f-month-w" hidden><h3>Mese</h3><ul id="f-month"></ul></div><div class="facet" id="f-tag-w" hidden><h3>Etichette</h3><ul id="f-tag"></ul></div></aside>
    <div>
     <div class="card prog" id="prog" hidden><div class="bar"><span></span></div><span class="sm">Ricerca in corso…</span><button type="button" class="btn gh s" id="stop">Interrompi</button></div>
     <div id="alert" class="alert" hidden></div>
     <div class="sum" id="sum"></div>
     <div class="tb">
      <input id="refine" class="rf" type="search" placeholder='Filtra nei risultati… (parole, -escludi, "frase")'>
      <select id="sort" aria-label="Ordinamento"><option value="rank">Rilevanza</option><option value="date_desc">Data: più recenti</option><option value="date_asc">Data: meno recenti</option><option value="num_desc">Numero: decrescente</option><option value="num_asc">Numero: crescente</option><option value="subject">Oggetto A→Z</option></select>
      <select id="group" aria-label="Raggruppamento"><option value="none">Nessun raggruppamento</option><option value="product">Per prodotto</option><option value="month">Per mese</option><option value="year">Per anno</option></select>
      <select id="psize" aria-label="Risultati per pagina"><option>25</option><option selected>50</option><option>100</option><option>250</option></select>
      <div class="menu"><button type="button" class="btn gh s" id="exp">Esporta ▾</button><div class="ml" id="expm" hidden><button type="button" data-x="csv">CSV (Excel)</button><button type="button" data-x="json">JSON</button><button type="button" data-x="numbers">Copia numeri ticket</button><button type="button" data-x="list">Copia elenco</button></div></div>
      <label class="ck sm"><input type="checkbox" id="selall"> Seleziona pagina</label>
     </div>
     <div id="active" class="chips" style="margin-bottom:8px"></div>
     <div id="list" class="list"></div>
     <nav id="pager" class="pager"></nav>
    </div>
   </div>
  </section>
  <section id="tab-saved" hidden><div class="card"><h2>Ricerche salvate</h2><div id="saved"></div></div></section>
  <section id="tab-history" hidden><div class="card"><div class="row between"><h2>Cronologia</h2><button type="button" class="btn gh s" id="hclear">Svuota cronologia</button></div><div id="hist"></div></div></section>
  <section id="tab-favorites" hidden><div class="card"><div class="row between"><h2>Preferiti</h2><div class="row"><input id="ffilter" type="search" placeholder="Filtra per testo o etichetta…" style="width:260px"><button type="button" class="btn gh s" id="fexp">Esporta CSV</button></div></div><div id="favs" class="list"></div></div></section>
  <section id="tab-settings" hidden>
   <div class="card"><h2>Connessione a Zucchetti</h2><pre class="pre mono" id="conninfo"></pre>
    <div class="row" style="margin-top:10px"><button type="button" class="btn" id="usepage">Usa i parametri dell'ultima ricerca della pagina</button><button type="button" class="btn" id="tcopy">Copia dati tecnici</button><button type="button" class="btn gh" id="tdl">Scarica dati tecnici</button></div>
    <p class="mu sm">I dati tecnici servono a completare la configurazione (nomi dei campi dei filtri, formato dei link): contengono la richiesta inviata (senza cookie), un esempio di risposta con alcuni risultati e il modulo "Filtri" della pagina, se aperta. Controllali prima di condividerli.</p></div>
   <div class="card"><h2>Valori predefiniti</h2><div class="fg"><label class="fld">Indice (core)<input id="s-core"></label><label class="fld">Area<input id="s-area"></label><label class="fld">Lingue<input id="s-langs"></label><label class="fld">Massimo risultati di Zucchetti<input id="s-cap" type="number" min="1"></label></div></div>
   <div class="card"><h2>Mappatura dei campi Solr</h2><p class="mu sm">Una riga per campo, nel formato <code>chiave = NOMECAMPO</code>. Lascia vuoto ciò che non conosci. Chiavi disponibili: <span id="keys"></span>.</p><textarea id="s-map" rows="8" class="mono" placeholder="stato = NOMECAMPO_STATO"></textarea></div>
   <div class="card"><h2>Dati personali</h2><p class="mu sm">Preferiti, note, ricerche salvate e cronologia sono salvati solo in questo browser.</p>
    <div class="row"><button type="button" class="btn" id="pexp">Esporta</button><label class="btn">Importa<input type="file" id="pimp" accept="application/json,.json" hidden></label><button type="button" class="btn gh dg" id="pdel">Cancella tutto</button></div></div>
   <div class="row end" style="margin-top:14px"><button type="button" class="btn pri" id="ssave">Salva impostazioni</button></div>
   <div class="card"><h2>Prova una query</h2><form id="rawf" class="row"><input id="rawq" class="mono" value="detassazione" style="flex:1"><button type="submit" class="btn">Esegui</button></form><pre class="pre mono" id="rawout" hidden></pre></div>
   <p class="mu sm">Ricerca TKT ${VERSION} · versione segnalibro</p>
  </section>
 </div></div>
 <dialog id="dnote"><form method="dialog"><h3 id="ntitle">Nota</h3><label class="fld">Nota personale<textarea id="ntext" rows="5"></textarea></label><label class="fld">Etichette (separate da virgola)<input id="ntags" placeholder="es. da verificare, normativa"></label><div class="row end"><button value="cancel" class="btn gh" formnovalidate>Annulla</button><button value="remove" class="btn gh dg" id="nrem">Rimuovi dai preferiti</button><button value="ok" class="btn pri">Salva</button></div></form></dialog>
 <dialog id="dsave"><form method="dialog"><h3>Salva ricerca</h3><label class="fld">Nome<input id="sname" maxlength="200"></label><div class="row end"><button value="cancel" class="btn gh" formnovalidate>Annulla</button><button value="ok" class="btn pri">Salva</button></div></form></dialog>
 <div class="toast" id="toast" role="status" hidden></div>
</div>`;

  const host = document.createElement("div");
  host.id = "ricerca-tkt-host";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);
  const tpl = document.createElement("template");
  tpl.innerHTML = MARKUP; // markup costante, nessun dato esterno
  root.appendChild(tpl.content);
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";

  // ===================================================================== stato
  const S = {
    mode: "all", results: [], keys: new Set(), facet: { prod: new Set(), year: null, month: null, tags: new Set() },
    refine: "", sort: "rank", group: "none", page: 1, size: 50, selected: new Set(), searching: false, abort: null,
    last: null, query: "", alerts: [], visible: [], pageItems: [], favorites: new Map(), info: null,
  };
  for (const f of store.get("favorites", [])) S.favorites.set(f.key, f);
  const saveFavs = () => store.set("favorites", [...S.favorites.values()]);

  let toastT = 0;
  function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:0";
      root.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch { /* */ } ta.remove();
    }
    toast(msg || "Copiato negli appunti");
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = h("a", { href: url, download: name });
    root.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // ===================================================================== chip
  class Chips {
    constructor(el, onChange) {
      this.el = el; this.v = []; this.onChange = onChange;
      this.inp = h("input", { placeholder: el.dataset.ph || "", "aria-label": el.dataset.ph || "" });
      el.appendChild(this.inp);
      el.addEventListener("click", () => this.inp.focus());
      this.inp.addEventListener("keydown", (e) => {
        if (["Enter", ",", " ", "Tab"].includes(e.key) && this.inp.value.trim()) { e.preventDefault(); this.add(this.inp.value); }
        else if (e.key === "Backspace" && !this.inp.value && this.v.length) this.remove(this.v[this.v.length - 1]);
      });
      this.inp.addEventListener("blur", () => { if (this.inp.value.trim()) this.add(this.inp.value); });
    }
    add(raw) { for (let p of raw.split(/[\s,;]+/)) { p = p.trim().toUpperCase(); if (p && !this.v.includes(p)) this.v.push(p); } this.inp.value = ""; this.render(); this.onChange(); }
    remove(x) { this.v = this.v.filter((y) => y !== x); this.render(); this.onChange(); }
    set(list) { this.v = [...new Set((list || []).map((x) => String(x).toUpperCase()))]; this.render(); }
    values() { return this.v.slice(); }
    render() {
      this.el.querySelectorAll(".chip").forEach((c) => c.remove());
      for (const x of this.v) this.el.insertBefore(h("span", { class: "chip" }, x, h("button", { type: "button", "aria-label": `Rimuovi ${x}`, onclick: (e) => { e.stopPropagation(); this.remove(x); } }, "×")), this.inp);
    }
  }
  const onFormChange = () => { preview(); advCount(); };
  const chipsIn = new Chips($("#pin"), onFormChange);
  const chipsOut = new Chips($("#pout"), onFormChange);

  // ===================================================================== form
  function renderFieldInputs() {
    const grid = clear($("#rie"));
    for (const f of FIELD_DEFS.filter((x) => x.group === "riepilogo")) {
      const on = !!solrField(f.key);
      const prev = (S.fieldValues || {})[f.key] || "";
      const inp = h("input", { "data-f": f.key, placeholder: f.hint, disabled: !on, title: on ? f.hint || f.label : "Campo non mappato: configuralo in Impostazioni" });
      inp.value = prev;
      grid.appendChild(h("label", { class: "fld" }, h("span", null, f.label, on ? null : h("span", { class: "off mu", text: "non mappato" })), inp));
    }
    for (const o of $$("#scope option")) {
      const off = (o.value === "subject" && !solrField("subject")) || (o.value === "text" && !solrField("text"));
      o.disabled = off;
      o.textContent = o.textContent.replace(/ \(non mappato\)$/, "") + (off ? " (non mappato)" : "");
    }
  }
  function setMode(m) {
    S.mode = m;
    $$("#mode button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === m)));
    $("#prefix").disabled = $("#fuzzy").disabled = m === "solr";
    $("#prox").disabled = m !== "phrase";
    $("#q").placeholder = m === "solr" ? '(detassazione OR "premio di risultato") AND NOT storno' : "Cerca nei ticket… es. detassazione premio";
    preview();
  }
  function preset(v) {
    const t = new Date();
    const back = (days, months) => { const d = new Date(t); if (days) d.setDate(d.getDate() - days); if (months) d.setMonth(d.getMonth() - months); return isoOf(d); };
    let from = null, to = isoOf(t);
    switch (v) {
      case "30d": from = back(30); break; case "3m": from = back(0, 3); break; case "6m": from = back(0, 6); break;
      case "1y": from = back(0, 12); break; case "2y": from = back(0, 24); break; case "5y": from = back(0, 60); break;
      case "ytd": from = `${t.getFullYear()}-01-01`; break;
      case "py": from = `${t.getFullYear() - 1}-01-01`; to = `${t.getFullYear() - 1}-12-31`; break;
      case "custom": return;
      default: to = null;
    }
    $("#dfrom").value = from || ""; $("#dto").value = to || "";
  }
  function spec() {
    const fields = {};
    for (const i of $$("#rie input")) if (!i.disabled && i.value.trim()) fields[i.dataset.f] = i.value.trim();
    let text = $("#q").value.trim();
    let numbers = $("#numbers").value.trim();
    if (S.mode !== "solr" && /^#\s*\d+(\s*[,;\s]\s*#?\s*\d+)*$/.test(text)) { numbers = [numbers, text.replace(/#/g, "")].filter(Boolean).join(", "); text = ""; }
    return {
      text, mode: S.mode, exclude: $("#exclude").value.trim(), phrase: $("#phrase").value.trim(),
      proximity: Math.max(0, Math.min(50, parseInt($("#prox").value, 10) || 0)), prefix: $("#prefix").checked, fuzzy: $("#fuzzy").checked,
      scope: $("#scope").value, numbers, date_from: $("#dfrom").value || null, date_to: $("#dto").value || null,
      products_in: chipsIn.values(), products_out: chipsOut.values(), fields,
      core: $("#core").value.trim(), area: $("#area").value.trim(), langs: $("#langs").value.trim(),
    };
  }
  function applySpec(s) {
    $("#q").value = s.text || ""; setMode(s.mode || "all");
    $("#exclude").value = s.exclude || ""; $("#phrase").value = s.phrase || ""; $("#prox").value = s.proximity || 0;
    $("#prefix").checked = !!s.prefix; $("#fuzzy").checked = !!s.fuzzy; $("#scope").value = s.scope || "all";
    $("#numbers").value = s.numbers || ""; $("#dfrom").value = s.date_from || ""; $("#dto").value = s.date_to || "";
    $("#preset").value = s.date_from || s.date_to ? "custom" : "";
    chipsIn.set(s.products_in); chipsOut.set(s.products_out);
    for (const i of $$("#rie input")) i.value = (s.fields || {})[i.dataset.f] || "";
    $("#core").value = s.core ?? settings.core; $("#area").value = s.area ?? settings.area; $("#langs").value = s.langs ?? settings.langs;
    advCount(); preview();
  }
  function advCount() {
    const s = spec();
    const n = [s.exclude, s.phrase, s.scope !== "all", s.prefix, s.fuzzy, s.proximity, s.products_out.length].filter(Boolean).length + Object.keys(s.fields).length;
    $("#adv-n").textContent = n ? `(${n} attiv${n === 1 ? "a" : "e"})` : "";
  }
  const preview = debounce(() => {
    const code = $("#qprev");
    const box = clear($("#qwarn"));
    try {
      const b = buildQuery(spec());
      code.classList.remove("err"); code.textContent = b.query; S.query = b.query;
      for (const w of b.warnings) box.appendChild(h("div", { class: "note", text: w }));
    } catch (e) { code.classList.add("err"); code.textContent = e.message; S.query = ""; }
  }, 150);
  function refreshHistList() {
    const dl = clear($("#hist-list"));
    const seen = new Set();
    for (const it of store.get("history", [])) { const t = it.spec.text; if (t && !seen.has(t)) { seen.add(t); dl.appendChild(h("option", { value: t })); } if (seen.size >= 15) break; }
  }

  // ===================================================================== ricerca
  async function runSearch() {
    const s = spec();
    let built;
    try { built = buildQuery(s); } catch (e) { preview(); toast(e.message); return; }
    if (S.abort) S.abort.abort();
    const ctrl = new AbortController();
    S.abort = ctrl; S.last = s; S.query = built.query;
    Object.assign(S, { results: [], keys: new Set(), page: 1, alerts: [], info: null, refine: "" });
    S.selected.clear(); S.facet = { prod: new Set(), year: null, month: null, tags: new Set() };
    $("#refine").value = ""; $("#emptyst").hidden = true; $("#results").hidden = false; $("#prog").hidden = false; $("#go").disabled = true;
    S.searching = true;
    for (const w of built.warnings) pushAlert("warn", w);
    render();
    const t0 = performance.now();
    try {
      const opt = { core: s.core, area: s.area, langs: s.langs };
      const r = await zSearchWithFallback(built.query, opt, ctrl.signal);
      if (S.abort !== ctrl) return;
      let filtered = 0;
      for (const t of r.tickets) {
        if (S.keys.has(t.key)) continue;
        if (!acceptsPost(built.post, t)) { filtered++; continue; }
        S.keys.add(t.key); t.rank = S.results.length; S.results.push(t);
      }
      S.info = { raw: r.rawCount, capped: r.capped, cap: r.maxResults || settings.cap, filtered, ms: Math.round(performance.now() - t0) };
      conn.lastSummary = { fields: r.fields, rawCount: r.rawCount, dataLength: r.dataLength, maxResults: r.maxResults, facet: r.facet, errors: r.errors };
      if (r.fixed) {
        $("#core").value = r.fixed.core; $("#area").value = r.fixed.area; $("#langs").value = r.fixed.langs;
        toast(`Parametri corretti e salvati: lingue "${r.fixed.langs}", area "${r.fixed.area}"`);
      }
      if (r.errors.length && !r.rawCount) {
        pushAlert("err", `Zucchetti non è riuscito a cercare nell'indice ${r.errors.join(", ")}. Chiudi Ricerca TKT (Esc), fai una ricerca normale dalla scheda Filtri della pagina Zucchetti e riapri il segnalibro: userò gli stessi parametri. Se non basta, manda i dati tecnici da Impostazioni.`);
      } else for (const e of r.errors) pushAlert("warn", `Zucchetti non ha cercato nell'indice: ${e}`);
      if (r.capped) pushAlert("warn", `Zucchetti mostra al massimo ${S.info.cap} risultati (i più rilevanti): restringi la ricerca con un periodo, un prodotto o parole più specifiche.`);
      if (filtered) pushAlert("info", `${fmtN(filtered)} risultati scartati perché fuori dai filtri (periodo, numeri, prodotti).`);
      if (!r.rawCount && r.dataLength) pushAlert("warn", "La risposta contiene dati che non riesco a leggere: usa Impostazioni → Copia dati tecnici e invialo per la configurazione.");
      const hist = store.get("history", []);
      hist.unshift({ spec: s, results: S.results.length, created: new Date().toISOString() });
      store.set("history", hist.slice(0, 200));
      refreshHistList();
    } catch (e) {
      if (e && e.name === "AbortError") pushAlert("warn", "Ricerca interrotta.");
      else { pushAlert("err", e && e.message ? e.message : "Errore durante la ricerca"); if (e && e.sample) conn.lastRaw = e.sample; }
    } finally {
      if (S.abort === ctrl) { S.abort = null; S.searching = false; $("#prog").hidden = true; $("#go").disabled = false; render(); }
    }
  }
  function pushAlert(kind, message) {
    if (!S.alerts.some((a) => a.message === message)) S.alerts.push({ kind, message });
    const box = clear($("#alert"));
    const items = S.alerts.filter((a) => a.kind !== "info");
    box.hidden = !items.length;
    box.className = "alert" + (items.some((a) => a.kind === "err") ? " err" : "");
    for (const a of items) box.appendChild(h("div", null, a.message));
  }

  // ===================================================================== risultati
  function parseRefine(text) {
    const inc = [], exc = [];
    for (const m of (text || "").matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
      const t = norm(m[2] || m[4]);
      if (!t || t === "-") continue;
      (m[1] || m[3] ? exc : inc).push(t);
    }
    return { inc, exc };
  }
  function hay(t) {
    if (t._hay === undefined) t._hay = norm(`#${t.number ?? ""} ${t.product} ${t.subject} ${t.snippet} ${fmtDate(t.date)} ${t.id}`);
    const f = S.favorites.get(t.key);
    return f ? `${t._hay} ${norm(f.note)} ${norm(f.tags.join(" "))}` : t._hay;
  }
  function filterItems(skip) {
    const r = parseRefine(S.refine), f = S.facet;
    return S.results.filter((t) => {
      if (r.inc.length || r.exc.length) { const x = hay(t); if (!r.inc.every((w) => x.includes(w)) || r.exc.some((w) => x.includes(w))) return false; }
      if (skip !== "prod" && f.prod.size && !f.prod.has(t.product || "—")) return false;
      if (skip !== "year" && f.year && (t.date || "").slice(0, 4) !== f.year) return false;
      if (skip !== "month" && skip !== "year" && f.month && (t.date || "").slice(5, 7) !== f.month) return false;
      if (skip !== "tags" && f.tags.size) { const fv = S.favorites.get(t.key); if (!fv || !fv.tags.some((x) => f.tags.has(x))) return false; }
      return true;
    });
  }
  const SORT = {
    rank: (a, b) => a.rank - b.rank,
    date_desc: (a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0),
    date_asc: (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.number || 0) - (b.number || 0),
    num_desc: (a, b) => (b.number || 0) - (a.number || 0),
    num_asc: (a, b) => (a.number || 0) - (b.number || 0),
    subject: (a, b) => a.subject.localeCompare(b.subject, "it", { sensitivity: "base" }) || a.rank - b.rank,
  };
  const gkey = (t) => (S.group === "product" ? t.product || "—" : S.group === "year" ? (t.date || "").slice(0, 4) || "—" : S.group === "month" ? (t.date || "").slice(0, 7) || "—" : "");
  const glabel = (k) => (S.group === "month" && /^\d{4}-\d{2}$/.test(k) ? `${MESI_L[+k.slice(5) - 1]} ${k.slice(0, 4)}` : k === "—" ? "Senza valore" : k);
  function visible() {
    const items = filterItems();
    const so = SORT[S.sort] || SORT.rank;
    if (S.group === "none") return items.sort(so);
    const dir = S.group === "product" ? 1 : -1;
    return items.sort((a, b) => { const ga = gkey(a), gb = gkey(b); if (ga !== gb) return ga === "—" ? 1 : gb === "—" ? -1 : ga.localeCompare(gb) * dir; return so(a, b); });
  }
  function render() {
    if ($("#results").hidden) return;
    const items = visible();
    S.visible = items;
    renderFacets(); renderActive(); renderSummary(items.length);
    const pages = Math.max(1, Math.ceil(items.length / S.size));
    S.page = Math.min(S.page, pages);
    const pageItems = items.slice((S.page - 1) * S.size, S.page * S.size);
    S.pageItems = pageItems;
    const list = clear($("#list"));
    let lg = null;
    for (const t of pageItems) {
      if (S.group !== "none") {
        const g = gkey(t);
        if (g !== lg) { list.appendChild(h("div", { class: "gt" }, glabel(g), h("span", { class: "mu", text: fmtN(items.filter((x) => gkey(x) === g).length) }))); lg = g; }
      }
      list.appendChild(ticketEl(t));
    }
    if (!pageItems.length && !S.searching) list.appendChild(h("div", { class: "card empty", text: S.results.length ? "Nessun risultato con i filtri attuali." : "Nessun ticket trovato." }));
    $("#selall").checked = pageItems.length > 0 && pageItems.every((t) => S.selected.has(t.key));
    renderPager(pages);
  }
  function renderSummary(nv) {
    const el = clear($("#sum"));
    if (S.searching) { el.appendChild(h("span", { class: "mu", text: "Ricerca in corso…" })); return; }
    const total = S.results.length;
    const parts = [h("b", null, fmtN(total)), total === 1 ? " ticket trovato" : " ticket trovati"];
    if (nv !== total) parts.push(" · ", h("b", null, fmtN(nv)), " dopo i filtri");
    if (S.info) parts.push(h("span", { class: "mu" }, ` · ${(S.info.ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} s`, S.info.capped ? ` · limite di ${S.info.cap} raggiunto` : ""));
    if (S.selected.size) parts.push(" · ", h("b", null, fmtN(S.selected.size)), " selezionati ", h("button", { type: "button", class: "btn gh s", onclick: () => { S.selected.clear(); render(); } }, "deseleziona"));
    add(el, parts);
  }
  function openTicket(t) {
    if (t.url) { window.open(t.url, "_blank", "noopener"); return; }
    const f = conn.found || findPortlet();
    if (f && /^function:/i.test(t.rawUrl || "")) {
      const holder = f.kind === "grid" ? f.p.doResults : f.p.doSearch;
      if (holder && typeof f.p.click === "function") {
        const old = holder.rs;
        try { holder.rs = Object.assign({}, t.row); f.p.click(); return; } catch { /* sotto */ } finally { holder.rs = old; }
      }
    }
    copyText(String(t.number ?? t.id), `Link non disponibile: copiato il numero ${t.number ?? t.id}`);
  }
  function ticketEl(t, noSel) {
    const fav = S.favorites.get(t.key);
    const sel = S.selected.has(t.key);
    const label = t.number != null ? `#${t.number}` : t.id || "ticket";
    const canOpen = !!t.url || /^function:/i.test(t.rawUrl || "");
    const meta = [];
    if (fav) { for (const g of fav.tags) meta.push(h("span", { class: "tag", text: g })); if (fav.note) meta.push(h("span", { class: "nt", text: fav.note })); }
    return h("article", { class: "res" + (sel ? " sel" : "") },
      h("div", { class: "rh" },
        noSel ? null : h("input", { type: "checkbox", "aria-label": `Seleziona ${label}`, checked: sel, onchange: (e) => { if (e.target.checked) S.selected.add(t.key); else S.selected.delete(t.key); render(); } }),
        canOpen ? h("a", { class: "num", href: t.url || "#", title: "Apri il ticket", onclick: (e) => { e.preventDefault(); openTicket(t); } }, label) : h("span", { class: "num" }, label),
        h("button", { type: "button", class: "ib", title: "Copia numero", "aria-label": "Copia numero", onclick: () => copyText(String(t.number ?? t.id), `Copiato ${label}`) }, "⧉"),
        t.product ? h("span", { class: "badge", text: t.product }) : null,
        t.date ? h("time", { class: "mu", text: fmtDate(t.date) }) : null,
        h("span", { class: "sp" }),
        h("button", { type: "button", class: "ib" + (fav ? " on" : ""), "aria-pressed": String(!!fav), title: fav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti", onclick: () => toggleFav(t) }, fav ? "★" : "☆"),
        h("button", { type: "button", class: "ib", title: "Nota ed etichette", "aria-label": "Nota ed etichette", onclick: () => openNote(t) }, "✎"),
        canOpen ? h("button", { type: "button", class: "btn s", onclick: () => openTicket(t) }, "Apri ↗") : null),
      h("div", { class: "subj" }, segNodes(t.subject_hl, t.subject || t.title)),
      t.snippet ? h("div", { class: "snip" }, segNodes(t.snippet_hl, t.snippet)) : null,
      meta.length ? h("div", { class: "meta" }, meta) : null);
  }
  function renderPager(pages) {
    const nav = clear($("#pager"));
    if (pages <= 1) return;
    const go = (p) => { S.page = p; render(); $("#results").scrollIntoView({ block: "start" }); };
    nav.appendChild(h("button", { type: "button", disabled: S.page === 1, onclick: () => go(S.page - 1), "aria-label": "Pagina precedente" }, "‹"));
    const show = new Set([1, pages, S.page - 2, S.page - 1, S.page, S.page + 1, S.page + 2]);
    let last = 0;
    for (let p = 1; p <= pages; p++) {
      if (!show.has(p)) continue;
      if (p - last > 1) nav.appendChild(h("span", { class: "mu", text: "…" }));
      nav.appendChild(h("button", { type: "button", "aria-current": p === S.page ? "page" : null, onclick: () => go(p) }, String(p)));
      last = p;
    }
    nav.appendChild(h("button", { type: "button", disabled: S.page === pages, onclick: () => go(S.page + 1), "aria-label": "Pagina successiva" }, "›"));
  }
  function countBy(items, fn) { const m = new Map(); for (const t of items) { const k = fn(t); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; }
  function facetBtn(label, n, pressed, onclick, pct) {
    const fill = pct === undefined ? null : h("span", { class: "fill" });
    if (fill) fill.style.width = `${pct}%`;
    return h("li", null, h("button", { type: "button", "aria-pressed": String(pressed), onclick }, fill, h("span", null, label), h("span", { class: "n", text: fmtN(n) })));
  }
  function renderFacets() {
    const f = S.facet;
    const pc = countBy(filterItems("prod"), (t) => t.product || "—");
    for (const p of f.prod) if (!pc.has(p)) pc.set(p, 0);
    const pl = clear($("#f-prod"));
    [...pc.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).forEach(([p, n]) =>
      pl.appendChild(facetBtn(p, n, f.prod.has(p), () => { if (f.prod.has(p)) f.prod.delete(p); else f.prod.add(p); S.page = 1; render(); })));
    const yc = countBy(filterItems("year"), (t) => (t.date || "").slice(0, 4));
    const yl = clear($("#f-year"));
    const ymax = Math.max(1, ...yc.values());
    [...yc.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([y, n]) =>
      yl.appendChild(facetBtn(y, n, f.year === y, () => { f.year = f.year === y ? null : y; f.month = null; S.page = 1; render(); }, (n / ymax) * 100)));
    $("#f-month-w").hidden = !f.year;
    if (f.year) {
      const mc = countBy(filterItems("month"), (t) => (t.date || "").slice(5, 7));
      const ml = clear($("#f-month"));
      const mmax = Math.max(1, ...mc.values());
      [...mc.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([m, n]) =>
        ml.appendChild(facetBtn(`${MESI[+m - 1]} ${f.year}`, n, f.month === m, () => { f.month = f.month === m ? null : m; S.page = 1; render(); }, (n / mmax) * 100)));
    }
    const tc = new Map();
    for (const t of filterItems("tags")) { const fv = S.favorites.get(t.key); if (fv) for (const g of fv.tags) tc.set(g, (tc.get(g) || 0) + 1); }
    $("#f-tag-w").hidden = !tc.size && !f.tags.size;
    const tl = clear($("#f-tag"));
    [...tc.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) =>
      tl.appendChild(facetBtn(g, n, f.tags.has(g), () => { if (f.tags.has(g)) f.tags.delete(g); else f.tags.add(g); S.page = 1; render(); })));
  }
  function renderActive() {
    const box = clear($("#active"));
    const f = S.facet;
    const chip = (label, rm) => box.appendChild(h("span", { class: "chip" }, label, h("button", { type: "button", "aria-label": `Rimuovi ${label}`, onclick: rm }, "×")));
    for (const p of f.prod) chip(`Prodotto: ${p}`, () => { f.prod.delete(p); render(); });
    if (f.year) chip(`Anno: ${f.year}`, () => { f.year = null; f.month = null; render(); });
    if (f.month) chip(`Mese: ${MESI[+f.month - 1]}`, () => { f.month = null; render(); });
    for (const g of f.tags) chip(`Etichetta: ${g}`, () => { f.tags.delete(g); render(); });
    if (S.refine.trim()) chip(`Testo: ${S.refine.trim()}`, () => { $("#refine").value = ""; S.refine = ""; render(); });
    if (box.children.length > 1) box.appendChild(h("button", { type: "button", class: "btn gh s", onclick: () => { S.facet = { prod: new Set(), year: null, month: null, tags: new Set() }; $("#refine").value = ""; S.refine = ""; render(); } }, "Azzera filtri"));
  }

  // ===================================================================== esportazione
  function cell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCSV(items) {
    const rows = items.map((t) => {
      const f = S.favorites.get(t.key);
      return [t.number ?? t.id, fmtDate(t.date), t.product, t.subject, t.snippet, t.url || "", f ? f.note : "", f ? f.tags.join(", ") : ""].map(cell).join(";");
    });
    return "\ufeff" + ["Numero;Data;Prodotto;Oggetto;Estratto;Link;Nota;Etichette", ...rows].join("\r\n");
  }
  const clean = (t) => { const { _hay, row, subject_hl, snippet_hl, ...rest } = t; return rest; };
  function doExport(kind) {
    $("#expm").hidden = true;
    const items = S.selected.size ? S.visible.filter((t) => S.selected.has(t.key)) : S.visible;
    if (!items.length) { toast("Nessun risultato da esportare"); return; }
    const stamp = isoOf(new Date());
    if (kind === "csv") download(`ticket-${stamp}.csv`, toCSV(items), "text/csv;charset=utf-8");
    else if (kind === "json") download(`ticket-${stamp}.json`, JSON.stringify({ query: S.query, spec: S.last, tickets: items.map(clean) }, null, 2), "application/json");
    else if (kind === "numbers") copyText(items.map((t) => t.number ?? t.id).join("\n"), `Copiati ${fmtN(items.length)} numeri`);
    else copyText(items.map((t) => `#${t.number ?? t.id}\t${fmtDate(t.date)}\t${t.product}\t${t.subject}`).join("\n"), `Copiato elenco di ${fmtN(items.length)} ticket`);
  }

  // ===================================================================== preferiti, salvate, cronologia
  function updateFavCount() { $("#fav-count").textContent = S.favorites.size ? String(S.favorites.size) : ""; }
  function rerender() { if (!$("#tab-favorites").hidden) renderFavs(); else render(); }
  function toggleFav(t) {
    if (S.favorites.has(t.key)) { S.favorites.delete(t.key); toast("Rimosso dai preferiti"); }
    else { S.favorites.set(t.key, { key: t.key, ticket: clean(t), note: "", tags: [], updated: new Date().toISOString() }); toast("Aggiunto ai preferiti"); }
    saveFavs(); updateFavCount(); rerender();
  }
  let noteT = null;
  function openNote(t) {
    noteT = t;
    const f = S.favorites.get(t.key);
    $("#ntitle").textContent = `Nota per #${t.number ?? t.id}`;
    $("#ntext").value = f ? f.note : ""; $("#ntags").value = f ? f.tags.join(", ") : ""; $("#nrem").hidden = !f;
    $("#dnote").showModal(); $("#ntext").focus();
  }
  $("#dnote form").addEventListener("submit", (e) => {
    const action = e.submitter ? e.submitter.value : "ok";
    if (action === "cancel" || !noteT) return;
    if (action === "remove") S.favorites.delete(noteT.key);
    else S.favorites.set(noteT.key, { key: noteT.key, ticket: clean(noteT), note: $("#ntext").value.trim(), tags: [...new Set($("#ntags").value.split(",").map((x) => x.trim()).filter(Boolean))], updated: new Date().toISOString() });
    saveFavs(); updateFavCount(); rerender();
  });
  function favItems() {
    const r = parseRefine($("#ffilter").value);
    return [...S.favorites.values()].sort((a, b) => (b.updated || "").localeCompare(a.updated || "")).filter((f) => {
      const x = norm(`#${f.ticket.number ?? ""} ${f.ticket.product} ${f.ticket.subject} ${f.ticket.snippet} ${f.note} ${f.tags.join(" ")}`);
      return r.inc.every((w) => x.includes(w)) && !r.exc.some((w) => x.includes(w));
    });
  }
  function renderFavs() {
    const box = clear($("#favs"));
    const items = favItems();
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: S.favorites.size ? "Nessun preferito corrisponde al filtro." : "Nessun preferito: usa ☆ sui risultati per salvarli qui, con note ed etichette." })); return; }
    for (const f of items) box.appendChild(ticketEl(f.ticket, true));
  }
  function describe(s) {
    const modes = { all: "tutte le parole", any: "almeno una parola", phrase: "frase esatta", solr: "Solr" };
    const p = [];
    if (s.text) p.push(`"${s.text}" (${modes[s.mode] || s.mode})`);
    if (s.phrase) p.push(`frase "${s.phrase}"`);
    if (s.exclude) p.push(`senza: ${s.exclude}`);
    if (s.numbers) p.push(`ticket: ${s.numbers}`);
    if (s.date_from || s.date_to) p.push(`periodo ${s.date_from ? fmtDate(s.date_from) : "…"} – ${s.date_to ? fmtDate(s.date_to) : "oggi"}`);
    if ((s.products_in || []).length) p.push(`prodotti: ${s.products_in.join(", ")}`);
    if ((s.products_out || []).length) p.push(`esclusi: ${s.products_out.join(", ")}`);
    const nf = Object.keys(s.fields || {}).length;
    if (nf) p.push(`${nf} filtr${nf === 1 ? "o" : "i"} di riepilogo`);
    return p.join(" · ") || "(nessun criterio)";
  }
  function runSpec(s) { tab("search"); applySpec(s); runSearch(); }
  function renderSaved() {
    const box = clear($("#saved"));
    const items = store.get("saved", []);
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: 'Nessuna ricerca salvata: usa "Salva ricerca" sotto la barra di ricerca.' })); return; }
    items.forEach((it, i) => box.appendChild(h("div", { class: "li" },
      h("div", { class: "m" }, h("div", { class: "t", text: it.name }), h("div", { class: "s", text: describe(it.spec) })),
      h("span", { class: "mu sm", text: fmtDT(it.created) }),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec) }, "Esegui"),
      h("button", { type: "button", class: "btn gh s", onclick: () => { tab("search"); applySpec(it.spec); } }, "Apri"),
      h("button", { type: "button", class: "btn gh s dg", onclick: () => { if (!confirm(`Eliminare la ricerca "${it.name}"?`)) return; const all = store.get("saved", []); all.splice(i, 1); store.set("saved", all); renderSaved(); } }, "Elimina"))));
  }
  function renderHistory() {
    const box = clear($("#hist"));
    const items = store.get("history", []);
    if (!items.length) { box.appendChild(h("div", { class: "empty", text: "La cronologia è vuota." })); return; }
    for (const it of items) box.appendChild(h("div", { class: "li" },
      h("div", { class: "m" }, h("div", { class: "t", text: describe(it.spec) }), h("div", { class: "s", text: `${fmtDT(it.created)} · ${fmtN(it.results)} risultati` })),
      h("button", { type: "button", class: "btn s", onclick: () => runSpec(it.spec) }, "Ripeti"),
      h("button", { type: "button", class: "btn gh s", onclick: () => { tab("search"); applySpec(it.spec); } }, "Apri")));
  }
  $("#dsave form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const name = $("#sname").value.trim();
    if (!name) return;
    const all = store.get("saved", []);
    all.push({ name, spec: spec(), created: new Date().toISOString() });
    all.sort((a, b) => a.name.localeCompare(b.name, "it"));
    store.set("saved", all) ? toast("Ricerca salvata") : toast("Impossibile salvare (spazio del browser esaurito?)");
  });

  // ===================================================================== impostazioni e dati tecnici
  function techData() {
    const strip = (r) => (r ? { method: r.method, url: r.url, body: r.body, headers: r.headers } : null);
    let filters = null;
    for (const w of sameOriginWindows(window, 0, [])) {
      try {
        const fr = w.document.querySelector("iframe[name=gspv_winf_search], iframe[id$=gspv_winf_search]");
        if (fr && fr.contentDocument) { filters = fr.contentDocument.documentElement.outerHTML.slice(0, 400000); break; }
      } catch { /* */ }
    }
    let sample = null;
    try {
      const p = JSON.parse(conn.lastRaw);
      sample = Object.assign({}, p, { data: Array.isArray(p.data) ? p.data.slice(0, 3) : p.data });
    } catch { sample = (conn.lastRaw || "").slice(0, 3000); }
    return {
      tool: `Ricerca TKT ${VERSION} (segnalibro)`, page: location.origin + location.pathname, root: ROOT,
      mode: conn.mode || "(nessuna ricerca eseguita)", portlet: conn.found ? conn.found.kind : null,
      m_cID: conn.mcid, template: conn.template ? { method: conn.template.method, url: conn.template.url, body: conn.template.body, keywordParam: conn.template.kw, where: conn.template.where } : null,
      lastRequest: strip(conn.lastRequest), lastQuery: S.query, responseSummary: conn.lastSummary, responseSample: sample,
      pageSearches: conn.pageRequests, pageParams: store.get("pageParams", null), solrFieldsSeen: [...conn.seenFields], settings,
      filtersFormHtml: filters,
    };
  }
  function renderSettings() {
    const d = techData();
    const modes = { native: "componente di ricerca della pagina (portlet)", template: "richiesta appresa dalla pagina", direct: "richiesta diretta alla routine" };
    $("#conninfo").textContent = [
      `Area Riservata: ${ROOT}`,
      `Componente di ricerca nella pagina: ${(conn.found || findPortlet()) ? "trovato" : "non trovato (verrà usata la richiesta diretta)"}`,
      `Ultima ricerca tramite: ${modes[conn.mode] || "—"}`,
      `Codice m_cID: ${conn.mcid || "—"}`,
      `Modulo "Filtri" leggibile: ${d.filtersFormHtml ? "sì" : "no (apri la pagina di ricerca Zucchetti)"}`,
      `Ultima ricerca fatta dalla pagina: ${(() => { const pp = store.get("pageParams", null); return pp ? `lingue "${pp.pLangs ?? "—"}", area "${pp.pArea ?? "—"}", indice "${pp.pCore ?? "—"}" (${fmtDT(pp.at)})` : "nessuna osservata (chiudi il pannello e cerca dalla scheda Filtri)"; })()}`,
      `Campi Solr visti nelle ricerche della pagina: ${conn.seenFields.size ? [...conn.seenFields].join(", ") : "—"}`,
    ].join("\n");
    $("#s-core").value = settings.core; $("#s-area").value = settings.area; $("#s-langs").value = settings.langs; $("#s-cap").value = settings.cap;
    $("#s-map").value = Object.entries(settings.mapping).filter(([, v]) => v).map(([k, v]) => `${k} = ${v}`).join("\n");
    $("#keys").textContent = FIELD_DEFS.map((f) => f.key).join(", ");
  }
  $("#ssave").addEventListener("click", () => {
    const mapping = {};
    const bad = [];
    for (const line of $("#s-map").value.split("\n")) {
      const m = line.match(/^\s*([a-z_]+)\s*[=:]\s*([A-Za-z_][A-Za-z0-9_.]*)\s*$/);
      if (m && FIELD_DEFS.some((f) => f.key === m[1])) mapping[m[1]] = m[2];
      else if (line.trim()) bad.push(line.trim());
    }
    Object.assign(settings, { core: $("#s-core").value.trim(), area: $("#s-area").value.trim(), langs: $("#s-langs").value.trim(), cap: Math.max(1, parseInt($("#s-cap").value, 10) || 210), mapping });
    store.set("settings", settings);
    S.fieldValues = {};
    for (const i of $$("#rie input")) S.fieldValues[i.dataset.f] = i.value;
    renderFieldInputs();
    $("#core").value = settings.core; $("#area").value = settings.area; $("#langs").value = settings.langs;
    $$(".capn").forEach((x) => { x.textContent = settings.cap; });
    preview();
    toast(bad.length ? `Impostazioni salvate; righe ignorate: ${bad.join(" | ")}` : "Impostazioni salvate");
  });
  $("#usepage").addEventListener("click", () => {
    const pp = store.get("pageParams", null);
    if (!pp) { toast("Nessuna ricerca della pagina osservata: chiudi il pannello, cerca dalla scheda Filtri e riapri il segnalibro"); return; }
    if (pp.pCore) settings.core = pp.pCore;
    if (pp.pArea !== null) settings.area = pp.pArea;
    if (pp.pLangs !== null) settings.langs = pp.pLangs;
    store.set("settings", settings);
    $("#core").value = settings.core; $("#area").value = settings.area; $("#langs").value = settings.langs;
    renderSettings();
    toast("Parametri della pagina salvati");
  });
  $("#tcopy").addEventListener("click", () => copyText(JSON.stringify(techData(), null, 2), "Dati tecnici copiati"));
  $("#tdl").addEventListener("click", () => download("ricerca-tkt-dati-tecnici.json", JSON.stringify(techData(), null, 2), "application/json"));
  $("#pexp").addEventListener("click", () => download("ricerca-tkt-dati-personali.json", JSON.stringify({ favorites: [...S.favorites.values()], saved: store.get("saved", []), history: store.get("history", []), settings }, null, 2), "application/json"));
  $("#pimp").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (Array.isArray(d.favorites)) { for (const f of d.favorites) if (f && f.key && f.ticket) S.favorites.set(f.key, f); saveFavs(); }
      if (Array.isArray(d.saved)) store.set("saved", [...store.get("saved", []), ...d.saved.filter((x) => x && x.name && x.spec)]);
      if (Array.isArray(d.history)) store.set("history", [...d.history, ...store.get("history", [])].slice(0, 200));
      updateFavCount(); toast("Dati importati");
    } catch { toast("File non valido"); }
    e.target.value = "";
  });
  $("#pdel").addEventListener("click", () => {
    if (!confirm("Cancellare preferiti, note, ricerche salvate e cronologia da questo browser?")) return;
    S.favorites.clear(); saveFavs(); store.set("saved", []); store.set("history", []); updateFavCount(); refreshHistList(); toast("Dati personali cancellati");
  });
  $("#rawf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#rawout");
    out.hidden = false; out.textContent = "Richiesta in corso…";
    try {
      const r = await zSearch($("#rawq").value, { core: settings.core, area: settings.area, langs: settings.langs });
      out.textContent = JSON.stringify({ tramite: conn.mode, risultati: r.rawCount, limite: r.maxResults, errori: r.errors, primo: r.tickets[0] ? clean(r.tickets[0]) : null, rispostaGrezza: conn.lastRaw.slice(0, 4000) }, null, 2);
    } catch (err) { out.textContent = `${err.message}\n${err.sample || ""}`; }
    renderSettings();
  });

  // ===================================================================== navigazione ed eventi
  function tab(name) {
    $$("#nav button").forEach((b) => (b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    for (const sec of $$("section[id^=tab-]")) sec.hidden = sec.id !== `tab-${name}`;
    if (name === "saved") renderSaved(); else if (name === "history") renderHistory(); else if (name === "favorites") renderFavs(); else if (name === "settings") renderSettings(); else render();
  }
  $$("#nav button").forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab)));
  $$("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#sf").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
  $("#sf").addEventListener("input", (e) => { if (e.target.id === "dfrom" || e.target.id === "dto") $("#preset").value = "custom"; onFormChange(); });
  $("#sf").addEventListener("change", onFormChange);
  $("#preset").addEventListener("change", () => { preset($("#preset").value); onFormChange(); });
  $("#qcopy").addEventListener("click", () => S.query && copyText(S.query, "Query copiata"));
  $("#qedit").addEventListener("click", () => { if (!S.query) return; const k = spec(); applySpec({ text: S.query, mode: "solr", core: k.core, area: k.area, langs: k.langs }); toast("Criteri convertiti in una query Solr modificabile"); $("#q").focus(); });
  $("#qreset").addEventListener("click", () => { applySpec({}); $("#q").focus(); });
  $("#qsave").addEventListener("click", () => { const s = spec(); $("#sname").value = s.text || s.phrase || s.numbers || ""; $("#dsave").showModal(); $("#sname").select(); });
  $("#stop").addEventListener("click", () => S.abort && S.abort.abort());
  $("#refine").addEventListener("input", debounce(() => { S.refine = $("#refine").value; S.page = 1; render(); }, 150));
  $("#sort").addEventListener("change", () => { S.sort = $("#sort").value; S.page = 1; render(); });
  $("#group").addEventListener("change", () => { S.group = $("#group").value; S.page = 1; render(); });
  $("#psize").addEventListener("change", () => { S.size = +$("#psize").value; S.page = 1; render(); });
  $("#selall").addEventListener("change", () => { for (const t of S.pageItems) { if ($("#selall").checked) S.selected.add(t.key); else S.selected.delete(t.key); } render(); });
  $("#exp").addEventListener("click", (e) => { e.stopPropagation(); $("#expm").hidden = !$("#expm").hidden; });
  root.addEventListener("click", () => { $("#expm").hidden = true; });
  $$("#expm button").forEach((b) => b.addEventListener("click", () => doExport(b.dataset.x)));
  $("#hclear").addEventListener("click", () => { if (confirm("Svuotare la cronologia?")) { store.set("history", []); renderHistory(); refreshHistList(); } });
  $("#ffilter").addEventListener("input", debounce(renderFavs, 150));
  $("#fexp").addEventListener("click", () => {
    const items = favItems();
    const rows = items.map((f) => [f.ticket.number ?? f.ticket.id, fmtDate(f.ticket.date), f.ticket.product, f.ticket.subject, f.ticket.snippet, f.ticket.url || "", f.note, f.tags.join(", ")].map(cell).join(";"));
    download("preferiti.csv", "\ufeff" + ["Numero;Data;Prodotto;Oggetto;Estratto;Link;Nota;Etichette", ...rows].join("\r\n"), "text/csv;charset=utf-8");
  });

  let lastSeenAt = (store.get("pageParams", null) || {}).at || "";
  function show() {
    host.style.display = ""; document.documentElement.style.overflow = "hidden"; setTimeout(() => $("#q").focus(), 0);
    const pp = store.get("pageParams", null);
    if (pp && pp.at && pp.at !== lastSeenAt) { lastSeenAt = pp.at; toast(`Vista una ricerca della pagina Zucchetti (lingue "${pp.pLangs ?? "—"}"): dettagli in Impostazioni`); }
  }
  conn.onPageSearch = () => { if (!$("#tab-settings").hidden) renderSettings(); };
  function hide() { if (S.abort) S.abort.abort(); host.style.display = "none"; document.documentElement.style.overflow = prevOverflow; }
  $("#close").addEventListener("click", hide);
  // eventi da tastiera: restano dentro il pannello (non arrivano alla pagina Zucchetti)
  const keyHandler = (e) => {
    if (host.style.display === "none") return;
    const inner = e.composedPath()[0] || e.target;
    const tag = (inner.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape" && !root.querySelector("dialog[open]")) { e.preventDefault(); if (S.searching && S.abort) S.abort.abort(); else hide(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); tab("search"); $("#q").focus(); $("#q").select(); }
    e.stopPropagation();
  };
  host.addEventListener("keydown", keyHandler);
  document.addEventListener("keydown", (e) => { if (host.style.display !== "none" && e.key === "Escape" && e.target === document.body) keyHandler(e); }, true);

  window[NS] = { toggle() { if (host.style.display === "none") show(); else hide(); }, version: VERSION };

  // avvio
  renderFieldInputs();
  $("#core").value = settings.core; $("#area").value = settings.area; $("#langs").value = settings.langs;
  $$(".capn").forEach((x) => { x.textContent = settings.cap; });
  setMode("all");
  updateFavCount();
  refreshHistList();
  show();

  } catch (err) {
    try { console.error("Ricerca TKT", err); } catch { /* */ }
    alert(`Ricerca TKT non è riuscito ad avviarsi su questa pagina.\n\n${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n") : err}\n\nCopia questo messaggio e invialo per la correzione.`);
  }
})();
