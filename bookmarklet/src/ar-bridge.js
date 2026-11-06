  // ===================================================================== modalità Area Riservata (ponte)
  // Il segnalibro cliccato nella vecchia «Ricerca rapida» dell'Area Riservata (www.zucchetti.it/areariservata):
  // non apre il pannello di ricerca ma fa da ponte per Ricerca TKT nel portale Touch, che ha aperto questa
  // scheda. Le ricerche le fa questa pagina, con la sessione dell'utente, nel formato delle sue ricerche:
  //   pKeyword = IdCenSer:<centro> and ( (IdMeseM:9 and IdAnnoM:2026 ) or ... ) and ( Testi:("x") or Oggetto:("x") )
  //   pArea = TICKOPEXXX, pCore = "", pLangs = ITA, cs_SITE = "", m_cID = codice letto dalla pagina
  // La risposta ha al massimo maxResults righe (210): per averle tutte si cerca un mese alla volta.
  function arBridgeMain() {
    const ROOT = (() => { const x = /^(.*?\/areariservata\/)/i.exec(location.href); return x ? x[1] : new URL("../", location.href).href; })();
    // fetch originale (la pagina carica MooTools e ridefinisce funzioni globali)
    const fetchN = (() => {
      try { const f = window.fetch; if (/\{\s*\[native code\]\s*\}\s*$/.test(String(f))) return (...a) => f.apply(window, a); } catch { /* */ }
      return (...a) => { const r = document.getElementById("ricerca-tkt-realm"); const f = r && r.contentWindow && r.contentWindow.fetch; return f ? f.apply(r.contentWindow, a) : window.fetch(...a); };
    })();
    const st2 = {
      get(k, d) { try { const v = localStorage.getItem("rtkt2:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
      set(k, v) { try { localStorage.setItem("rtkt2:" + k, JSON.stringify(v)); } catch { /* */ } },
    };
    const BR = { origin: "", src: null, n: 0, aborted: new Set(), observed: null, fields: null, queue: Promise.resolve(), log: [] };
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const strip = (html) => {
      const s = String(html ?? "");
      if (!/[<&]/.test(s)) return s.replace(/\s+/g, " ").trim();
      const d = new DOMParser().parseFromString(`<body>${s}`, "text/html");
      return (d.body.textContent || "").replace(/\s+/g, " ").trim();
    };
    const pad2 = (n) => String(n).padStart(2, "0");

    // ---- le ricerche fatte dalla pagina insegnano area, lingue, centro servizi e m_cID
    try {
      const XP = XMLHttpRequest.prototype;
      if (!XP.__rtktAR) {
        XP.__rtktAR = true;
        const open = XP.open, send = XP.send;
        XP.open = function (m, u) { try { this.__rtktU = String(u); } catch { /* */ } return open.apply(this, arguments); };
        XP.send = function (b) {
          try {
            if (/spsl_fquery_mc/i.test(this.__rtktU || "") && typeof b === "string" && /pArea=/.test(b)) {
              const p = {};
              for (const part of b.split("&")) { const i = part.indexOf("="); if (i > 0) { try { p[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, " ")); } catch { /* */ } } }
              BR.observed = { pArea: p.pArea, pLangs: p.pLangs, m_cID: p.m_cID, cenSer: (/\bIdCenSer:("?)([A-Za-z0-9_.]+)\1/.exec(p.pKeyword || "") || [])[2] || "" };
            }
          } catch { /* */ }
          return send.apply(this, arguments);
        };
      }
    } catch { /* */ }
    const portlet = (name) => { try { return window.ZtVWeb && typeof window.ZtVWeb.getPortlet === "function" ? window.ZtVWeb.getPortlet(name) : null; } catch { return null; } };
    const val = (c) => { try { return c && typeof c.Value === "function" ? c.Value() : undefined; } catch { return undefined; } };
    async function mcid() {
      for (const name of ["spsl_wsolrresultsgrid", "spsl_wfast_search"]) {
        const p = portlet(name);
        const id = p && p.splResults && p.splResults.m_cID;
        if (/^[0-9a-f]{32}$/i.test(id || "")) return id;
      }
      if (BR.observed && /^[0-9a-f]{32}$/i.test(BR.observed.m_cID || "")) return BR.observed.m_cID;
      for (const jsp of ["jsp/spsl_wfast_search_portlet.jsp", "jsp/spsl_wsolrresultsgrid_portlet.jsp"]) {
        try {
          const r = await fetchN(ROOT + jsp, { credentials: "same-origin" });
          const x = /splResults\.m_cID\s*=\s*['"]([0-9a-f]{32})['"]/i.exec(await r.text());
          if (x) return x[1];
        } catch { /* */ }
      }
      throw new Error("Non trovo il codice di ricerca dell'Area Riservata: ricarica la pagina «Ricerca rapida» e premi di nuovo il segnalibro.");
    }
    const filtersWin = () => { try { const f = document.querySelector('iframe[name="gspv_winf_search"]'); return f && f.contentWindow && f.contentWindow.document ? f.contentWindow : null; } catch { return null; } };
    // centro servizi: quello scelto nei filtri della pagina, o la prima voce, o quello delle ricerche osservate
    async function cenSer() {
      const fw = filtersWin();
      if (fw) {
        try { const v = String(fw.w_CentroServizi || "").trim(); if (v) return v; } catch { /* */ }
        try { const o = [...fw.document.querySelectorAll('select[name="CentroServizi"] option')].find((x) => x.value.trim()); if (o) return o.value.trim(); } catch { /* */ }
      }
      if (BR.observed && BR.observed.cenSer) return BR.observed.cenSer;
      try {
        const r = await fetchN(ROOT + "servlet/gspv_winf_search?m_cDecoration=none", { credentials: "same-origin" });
        const d = new DOMParser().parseFromString(await r.text(), "text/html");
        const o = [...d.querySelectorAll('select[name="CentroServizi"] option')].find((x) => x.value.trim());
        if (o) return o.value.trim();
      } catch { /* */ }
      return "";
    }
    const area = () => String(val(portlet("spsl_wsolrresultsgrid") && portlet("spsl_wsolrresultsgrid").area) || (BR.observed && BR.observed.pArea) || "TICKOPEXXX");
    const langs = () => { const f = portlet("spsl_wfast_search"); return String(val(f && f.g_UserLang) || (BR.observed && BR.observed.pLangs) || "ITA"); };

    // ---- campi del mese/anno per la data di apertura: si chiedono alla pagina (sipv_ffilters_search), una volta
    function learnFields() {
      if (BR.fields) return BR.fields;
      const out = { upd: ["IdMeseM", "IdAnnoM"], open: null, how: "predefiniti" };
      const fw = filtersWin();
      try {
        if (fw && typeof fw.sipv_ffilters_search === "function") {
          const names = ["DataRiferimento", "SceltaData", "MeseDa", "MeseA", "AnnoDa", "AnnoA", "TestoSearch"];
          const saved = {};
          for (const n of names) saved[n] = fw["w_" + n];
          const set = (n, v) => { try { if (typeof fw["Set_" + n] === "function") fw["Set_" + n](v); else fw["w_" + n] = v; } catch { fw["w_" + n] = v; } };
          const y = new Date().getFullYear();
          try {
            for (const ref of [1, 2]) {
              set("DataRiferimento", ref); set("SceltaData", 0); set("AnnoDa", y); set("AnnoA", y); set("MeseDa", 3); set("MeseA", 3); set("TestoSearch", "");
              const kw = String(fw.sipv_ffilters_search() || "");
              const x = /\(\s*(\w+)\s*:\s*3\s+and\s+(\w+)\s*:\s*\d{4}\s*\)/i.exec(kw);
              if (x) { if (ref === 1) out.upd = [x[1], x[2]]; else out.open = [x[1], x[2]]; out.how = "dalla pagina"; }
            }
          } finally { for (const n of names) { try { if (typeof fw["Set_" + n] === "function") fw["Set_" + n](saved[n]); else fw["w_" + n] = saved[n]; } catch { fw["w_" + n] = saved[n]; } } }
        }
      } catch { /* campi predefiniti */ }
      BR.fields = out;
      return out;
    }

    // ---- parole → clausole nel formato della pagina
    function words(text) {
      const out = [];
      for (const x of String(text || "").matchAll(/"([^"]+)"|(\S+)/g)) {
        const w = (x[1] || x[2] || "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
        if (w && !/^(and|or|not|e|o)$/i.test(w)) out.push(w);
      }
      return out.slice(0, 12);
    }
    function months(dfrom, dto) {
      const now = new Date();
      const a = /^(\d{4})-(\d{2})/.exec(dfrom || ""), b = /^(\d{4})-(\d{2})/.exec(dto || "");
      let y = a ? +a[1] : Math.max(2000, (b ? +b[1] : now.getFullYear()) - 15), m = a ? +a[2] : 1;
      const y2 = b ? +b[1] : now.getFullYear(), m2 = b ? +b[2] : b ? 12 : now.getMonth() + 1;
      const out = [];
      while ((y < y2 || (y === y2 && m <= m2)) && out.length < 240) { out.push([m, y]); m++; if (m > 12) { m = 1; y++; } }
      return out;
    }
    async function keyword(spec) {
      const parts = [];
      const cs = await cenSer();
      if (cs) parts.push(`IdCenSer:${cs}`);
      if (spec.dfrom || spec.dto) {
        const f = learnFields();
        const [mf, yf] = f.open || f.upd;
        const ms = months(spec.dfrom, spec.dto);
        if (ms.length) parts.push(`( ${ms.map(([m, y]) => `(${mf}:${m} and ${yf}:${y} )`).join(" or ")}  )`);
      }
      for (const w of words(spec.text)) parts.push(`( Testi:("${w}") or Oggetto:("${w}") )`);
      for (const w of words(spec.subject)) parts.push(`Oggetto:("${w}")`);
      if (!parts.some((p) => /Testi:|Oggetto:/.test(p)) && !(spec.dfrom || spec.dto)) throw new Error("Scrivi un testo o scegli un periodo.");
      return parts.join("  and ");
    }
    // ---- risposta → righe
    const TITLE = /^\s*\[#(\d+)\]\s*\[([^\]]*)\]\s*\[(\d{1,2})-(\d{1,2})-(\d{4})\]\s*(.*)$/;
    function resolveUrl(u) {
      let s = String(u || "").trim();
      if (!s || /^(function:|javascript:)/i.test(s)) return null; // mai eseguire codice preso dai dati
      const t = /^\[\s*target:[^\]]*\]\s*(.*)$/i.exec(s);
      if (t) s = t[1].trim();
      try { const x = new URL(s, ROOT + "jsp/"); return /^https?:$/.test(x.protocol) && x.origin === location.origin ? x.href : null; } catch { return null; }
    }
    function parse(raw) {
      let p;
      try { p = JSON.parse(String(raw).replace(/^\ufeff/, "").trim()); } catch {
        if (/password|login|accedi|m_cPassword/i.test(String(raw).slice(0, 4000))) throw new Error("La sessione dell'Area Riservata è scaduta: accedi di nuovo in quella scheda e premi il segnalibro.");
        throw new Error("Risposta dell'Area Riservata non riconosciuta.");
      }
      const errors = Array.isArray(p.errors) ? p.errors : p.errors ? [String(p.errors)] : [];
      if (errors.length) throw new Error(`L'Area Riservata non ha cercato negli indici: ${errors.join(", ")}`);
      const fields = (Array.isArray(p.fields) ? p.fields : []).map((x) => String(x).toLowerCase());
      const idx = (n) => fields.indexOf(n);
      const rows = (Array.isArray(p.data) ? p.data : []).filter((r) => Array.isArray(r));
      const max = parseInt(Array.isArray(p.maxResults) ? p.maxResults[0] : p.maxResults, 10) || null;
      const tickets = [];
      for (const r of rows) {
        const get = (n) => (idx(n) >= 0 ? r[idx(n)] : "");
        const type = String(get("type") || "");
        if (type && !/ticket/i.test(type)) continue;
        const title = strip(get("description"));
        const x = TITLE.exec(title);
        const url = resolveUrl(get("urlpublic")) || resolveUrl(get("url1"));
        const t = { number: x ? x[1] : String(get("id") || "").replace(/\D/g, ""), product: x ? x[2].trim() : "", date: x ? `${x[5]}-${pad2(x[4])}-${pad2(x[3])}` : "", subject: x ? x[6].trim() : title, snippet: strip(get("altdescription")).slice(0, 3000), url };
        if (t.date && !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(t.date)) t.date = "";
        tickets.push(t);
      }
      return { tickets, rows: rows.length, max, capped: !!max && rows.length >= max };
    }
    async function search(spec, signal) {
      const t0 = performance.now();
      const kw = await keyword(spec || {});
      const body = [["pKeyword", kw], ["pArea", area()], ["pCore", ""], ["pLangs", langs()], ["cs_SITE", ""], ["m_cID", await mcid()]]
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      const r = await fetchN(ROOT + "servlet/spsl_fquery_mc", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal });
      if (r.status === 401 || r.status === 403) throw new Error("L'Area Riservata ha rifiutato la richiesta: accedi di nuovo in quella scheda e premi il segnalibro.");
      const out = parse(await r.text());
      BR.log.push({ at: new Date().toISOString(), ms: Math.round(performance.now() - t0), rows: out.rows, capped: out.capped, months: (kw.match(/ and \w+:\d{4}/g) || []).length, words: words(spec.text).length + words(spec.subject).length });
      if (BR.log.length > 30) BR.log.shift();
      return out;
    }

    // ---- lettura di un ticket: la sua pagina in una cornice nascosta di questa scheda
    async function read(ticket) {
      const url = ticket && resolveUrl(ticket.url);
      if (!url) throw new Error("Questo ticket dell'Area Riservata non ha un indirizzo da leggere: aprilo da lì.");
      const fr = document.createElement("iframe");
      fr.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms");
      fr.style.cssText = "position:fixed;left:-12000px;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none";
      fr.setAttribute("aria-hidden", "true");
      fr.src = url;
      document.documentElement.appendChild(fr);
      try {
        let last = -1, since = 0;
        const end = performance.now() + 25000;
        for (;;) {
          await sleep2(200);
          let doc = null;
          try { doc = fr.contentWindow.document; } catch { throw new Error("La pagina del ticket non si può leggere da qui: aprila con il collegamento."); }
          if (doc && doc.readyState === "complete" && fr.contentWindow.location.href !== "about:blank") {
            const len = ((doc.body && doc.body.innerText) || "").length;
            if (len !== last) { last = len; since = performance.now(); } else if (len > 0 && performance.now() - since > 900) break;
          }
          if (performance.now() > end) throw new Error("La pagina del ticket non ha finito di caricarsi.");
        }
        const doc = fr.contentWindow.document;
        const fields = [], texts = [];
        for (const el of doc.querySelectorAll("input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=password]), textarea, select")) {
          const v = (el.tagName === "SELECT" ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : "") : el.value || "").trim();
          if (!v) continue;
          const lab = (el.labels && el.labels[0] ? el.labels[0].textContent : "") || el.title || el.getAttribute("aria-label") || el.name || "";
          (el.tagName === "TEXTAREA" || v.length > 160 || v.includes("\n") ? texts : fields).push({ label: lab.replace(/\s+/g, " ").trim().replace(/:$/, ""), value: v.slice(0, 20000) });
        }
        const body = ((doc.body && doc.body.innerText) || "").replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (body) texts.push({ label: fields.length || texts.length ? "Testo della pagina" : "", value: body.slice(0, 40000) });
        return { title: (doc.title || "").trim(), fields: fields.slice(0, 80), texts: texts.slice(0, 40), tables: [], url };
      } finally { setTimeout(() => fr.remove(), 0); }
    }

    // ---- pannello del ponte (in basso a destra)
    const host2 = document.createElement("div");
    host2.id = "ricerca-tkt-ponte";
    const root2 = host2.attachShadow({ mode: "open" });
    root2.innerHTML = `<style>:host{all:initial}.c{position:fixed;right:16px;bottom:16px;z-index:2147483646;max-width:min(420px,calc(100vw - 32px));font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;background:#fff;color:#1c2430;border:1px solid #c9d2dd;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:12px 14px}
      .h{display:flex;justify-content:space-between;gap:8px;align-items:center;font-weight:700}.s{margin:6px 0 0}.mu{color:#5d6b7c;font-size:12.5px}.ok{color:#1d7a3a}.wn{color:#8a5a00}
      button{font:inherit;border:1px solid #c9d2dd;background:#f4f6f9;border-radius:6px;padding:3px 10px;cursor:pointer}</style>
      <div class="c" role="status"><div class="h"><span>Ricerca TKT · Area Riservata</span><button type="button" id="x" aria-label="Nascondi">×</button></div><p class="s" id="t"></p><p class="s mu" id="d"></p><div class="s" id="a"></div></div>`;
    document.documentElement.appendChild(host2);
    const q2 = (s) => root2.querySelector(s);
    q2("#x").onclick = () => { host2.style.display = "none"; };
    function status(kind, text, detail) {
      q2("#t").className = "s " + (kind === "ok" ? "ok" : kind === "wait" ? "wn" : "");
      q2("#t").textContent = text;
      q2("#d").textContent = detail || "";
      const a = q2("#a");
      a.textContent = "";
      if (BR.origin) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = "Scollega";
        b.onclick = () => { post({ type: "bye" }); BR.origin = ""; BR.src = null; status("", "Scollegata dal portale Touch.", "Per ricollegarla premi «Collega l'Area Riservata» in Ricerca TKT nel portale Touch."); };
        a.appendChild(b);
      }
    }
    const trusted = () => st2.get("arTrusted", []);
    const post = (m) => { try { if (BR.src && BR.origin) BR.src.postMessage(Object.assign({ ns: "rtkt", v: 1 }, m), BR.origin); } catch { /* */ } };
    // operazioni una alla volta (una richiesta per volta all'Area Riservata)
    const run = (fn) => { const p = BR.queue.then(fn, fn); BR.queue = p.catch(() => {}); return p; };
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || d.ns !== "rtkt" || d.v !== 1) return;
      let okOrigin = false;
      try { okOrigin = /^https?:$/.test(new URL(e.origin).protocol); } catch { okOrigin = false; }
      if (!okOrigin) return;
      if (d.type === "hello") {
        // solo dalla scheda che ha aperto questa (Ricerca TKT nel portale Touch), con il consenso dell'utente
        if (!window.opener || e.source !== window.opener) return;
        if (BR.origin && BR.origin !== e.origin) return;
        if (!BR.origin) {
          if (!trusted().includes(e.origin)) {
            if (!confirm(`Collegare questa scheda dell'Area Riservata a Ricerca TKT su ${e.origin}?\n\nLe ricerche fatte lì cercheranno anche qui, con il tuo accesso all'Area Riservata. Puoi scollegarla quando vuoi.`)) { status("", "Collegamento non autorizzato.", ""); return; }
            st2.set("arTrusted", [...trusted(), e.origin].slice(-5));
          }
          BR.origin = e.origin; BR.src = e.source;
          status("ok", "Collegata al portale Touch: lascia aperta questa scheda.", `Le ricerche di Ricerca TKT su ${e.origin} cercano anche qui.`);
        }
        post({ type: "ready", nonce: String(d.nonce || "").slice(0, 80), version: VERSION, page: document.title.slice(0, 120) });
        return;
      }
      if (e.origin !== BR.origin || e.source !== BR.src) return;
      const id = typeof d.id === "string" ? d.id.slice(0, 120) : "";
      if (d.type === "abort") { BR.aborted.add(id); return; }
      if (d.type === "bye") { BR.origin = ""; BR.src = null; status("", "Scollegata dal portale Touch.", ""); return; }
      if (d.type === "search") {
        run(async () => {
          if (BR.aborted.has(id)) return;
          try {
            const sp = d.spec && typeof d.spec === "object" ? d.spec : {};
            const spec = { text: String(sp.text || "").slice(0, 500), subject: String(sp.subject || "").slice(0, 500), dfrom: /^\d{4}-\d{2}-\d{2}$/.test(sp.dfrom || "") ? sp.dfrom : "", dto: /^\d{4}-\d{2}-\d{2}$/.test(sp.dto || "") ? sp.dto : "" };
            const r = await search(spec);
            BR.n++;
            status("ok", "Collegata al portale Touch: lascia aperta questa scheda.", `${BR.n} ricerch${BR.n === 1 ? "a" : "e"} fatt${BR.n === 1 ? "a" : "e"} da Ricerca TKT.`);
            if (BR.aborted.has(id)) return;
            post(d.countOnly ? { type: "result", id, ok: true, count: r.rows, capped: r.capped, max: r.max } : { type: "result", id, ok: true, tickets: r.tickets, count: r.rows, capped: r.capped, max: r.max });
          } catch (err) { post({ type: "result", id, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
        });
        return;
      }
      if (d.type === "read") {
        run(async () => {
          try { const c = await read(d.ticket || {}); post({ type: "ticket", id, ok: true, content: c, url: c.url }); } catch (err) { post({ type: "ticket", id, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
        });
        return;
      }
      if (d.type === "info") post({ type: "info", id, ok: true, fields: learnFields(), observed: !!BR.observed, log: BR.log.slice(-10) });
    });
    window.addEventListener("pagehide", () => post({ type: "bye" }));
    window[NS] = { toggle() { host2.style.display = host2.style.display === "none" ? "" : "none"; }, version: VERSION };
    if (window.opener) status("wait", "In attesa di Ricerca TKT nel portale Touch…", "Se non succede nulla, nel portale Touch premi «Collega l'Area Riservata» e poi di nuovo il segnalibro qui.");
    else status("", "Per cercare anche nell'Area Riservata apri Ricerca TKT nel portale Touch e premi «Collega l'Area Riservata».", "Si aprirà questa pagina in una nuova scheda: lì premi il segnalibro.");
  }
