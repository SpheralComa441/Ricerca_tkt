// Script di contenuto nelle pagine del Vecchio Cruscotto (Area Riservata Zucchetti: www.zucchetti.it/areariservata).
// Funziona solo in lettura: interroga la ricerca Solr (servlet/spsl_fquery_mc) e legge il dettaglio dei ticket storici.

(() => {
  if (window.__rtktArBridge) return;
  window.__rtktArBridge = true;

  const state = (window.__rtktArState = window.__rtktArState || {
    mcid: null,
    pArea: "TICKOPEXXX",
    idCenSer: "",
  });

  const MCID_PATTERNS = [
    /splResults\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/,
    /['"]spsl_fquery_mc['"][\s\S]{0,400}?\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/,
  ];

  function extractFromHtml(html) {
    if (!html) return null;
    const cen =
      /\bw_IdCenSer\s*=\s*['"]([A-Z0-9_]{2,12})['"]/.exec(html) ||
      /\bIdCenSer:([A-Z0-9_]{2,12})\b/.exec(html);
    if (cen && cen[1]) state.idCenSer = cen[1];
    const area = /\bw_pArea\s*=\s*['"]([A-Z0-9_]{3,20})['"]/.exec(html);
    if (area && area[1]) state.pArea = area[1];
    for (const re of MCID_PATTERNS) {
      const m = re.exec(html);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function scanDoc(doc) {
    if (!doc) return null;
    try {
      for (const s of doc.querySelectorAll("script")) {
        const id = extractFromHtml(s.textContent || "");
        if (id) return id;
      }
      return extractFromHtml(doc.documentElement ? doc.documentElement.innerHTML : "");
    } catch {
      return null;
    }
  }

  async function fetchPortletMcid(base) {
    for (const portlet of ["spsl_wsolrresultsgrid_portlet.jsp", "gspl_wsolrresultsgrid_portlet.jsp"]) {
      try {
        const r = await fetch(`${base}/jsp/${portlet}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "clientsideinclusion=true",
        });
        if (!r.ok) continue;
        const id = extractFromHtml(await r.text());
        if (id) return id;
      } catch {
        /* */
      }
    }
    return null;
  }

  async function discover(hint = {}) {
    if (hint.idCenSer) state.idCenSer = hint.idCenSer;
    if (hint.pArea) state.pArea = hint.pArea;
    if (hint.mcid && !hint.force) {
      state.mcid = hint.mcid;
      return state;
    }
    if (state.mcid && !hint.force) return state;

    if (!hint.force) {
      const fromMain = scanDoc(document);
      if (fromMain) {
        state.mcid = fromMain;
        return state;
      }
      try {
        for (let i = 0; i < window.frames.length; i++) {
          try {
            const id = scanDoc(window.frames[i].document);
            if (id) {
              state.mcid = id;
              return state;
            }
          } catch {
            /* frame di altra origine */
          }
        }
      } catch {
        /* */
      }
    }

    const base = location.origin + "/areariservata";
    const portletId = await fetchPortletMcid(base);
    if (portletId) {
      state.mcid = portletId;
    }

    if (!state.idCenSer || !state.mcid) {
      const pages = [`${base}/jsp/sipv_psearch_infi.jsp`, `${base}/jsp/gspv_psearch.jsp`];
      for (const url of pages) {
        try {
          const r = await fetch(url, { credentials: "same-origin" });
          if (!r.ok) continue;
          const html = await r.text();
          const id = extractFromHtml(html);
          if (id && !state.mcid) state.mcid = id;
          if (state.mcid && state.idCenSer) break;
        } catch {
          /* */
        }
      }
    }
    return state;
  }

  function hasValidArPayload(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/Function return value:\s*\{[\s\S]*\}\s*-->/.test(t)) return true;
    return t.startsWith("{") || t.startsWith("[");
  }

  async function runSearch(msg) {
    await discover(msg.hint || {});
    if (!state.mcid) return { error: "no-mcid" };
    const doPost = async (mcid) => {
      const body =
        `pKeyword=${encodeURIComponent(msg.query || "")}` +
        `&pArea=${encodeURIComponent(msg.pArea || state.pArea || "TICKOPEXXX")}` +
        `&pCore=&pLangs=ITA&cs_SITE=&m_cID=${encodeURIComponent(mcid)}`;
      const r = await fetch(location.origin + "/areariservata/servlet/spsl_fquery_mc", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body,
      });
      return { status: r.status, text: await r.text() };
    };
    let res = await doPost(state.mcid);
    if (!hasValidArPayload(res.text)) {
      await discover({ ...(msg.hint || {}), force: true });
      if (state.mcid) res = await doPost(state.mcid);
    }
    return { ok: true, status: res.status, text: res.text, mcid: state.mcid, pArea: state.pArea, idCenSer: state.idCenSer };
  }

  // La pagina e i suoi riquadri (anche annidati: le schede del portale sono fatte di riquadri dentro riquadri)
  function collectDocs(doc, depth = 0, out = []) {
    out.push(doc);
    if (depth >= 3) return out;
    try {
      for (const f of doc.querySelectorAll("iframe, frame")) {
        try {
          if (f.contentDocument && f.contentDocument.body) collectDocs(f.contentDocument, depth + 1, out);
        } catch {
          /* riquadro di altra origine */
        }
      }
    } catch {
      /* */
    }
    return out;
  }

  function extractFromDocument(doc) {
    const allDocs = collectDocs(doc);

    const fields = [];
    const texts = [];
    const tables = [];
    const seen = new Set();

    for (const d of allDocs) {
      for (const el of d.querySelectorAll("input, textarea, select")) {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") continue;
        let val = "";
        if (el.tagName === "SELECT") {
          const opt = el.options && el.options[el.selectedIndex];
          val = opt ? opt.text.trim() : el.value || "";
        } else {
          val = (el.value || el.textContent || "").trim();
        }
        if (!val || val.length < 2) continue;
        const nameId = (el.name || el.id || "").toLowerCase();
        if (/^(m_c|w_m_|form|token|cmd|page)/.test(nameId)) continue;

        let label = "";
        if (el.id) {
          try {
            const lbl = d.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) label = lbl.textContent.trim();
          } catch {
            /* */
          }
        }
        if (!label) {
          let prev = el.previousElementSibling;
          if (!prev && el.parentElement) prev = el.parentElement.previousElementSibling;
          if (prev && /^(LABEL|SPAN|TD|TH|DIV|B|STRONG)$/.test(prev.tagName)) {
            const t = prev.textContent.trim();
            if (t.length > 0 && t.length < 55) label = t;
          }
        }
        if (!label && el.closest) {
          const row = el.closest("tr, .field, .form-group, div");
          if (row) {
            const lbl = row.querySelector("label, .field-label, .caption, td:first-child, th");
            if (lbl && lbl !== el && !lbl.contains(el)) {
              const t = lbl.textContent.trim();
              if (t.length > 0 && t.length < 55) label = t;
            }
          }
        }
        if (!label) label = el.getAttribute("placeholder") || el.getAttribute("title") || el.name || el.id || "";
        label = String(label).replace(/[:\s*]+$/, "").trim();

        const key = `${label}|${val}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (el.tagName === "TEXTAREA" || val.length > 100) {
          texts.push([label || "Testo", val]);
        } else {
          fields.push([label || "Campo", val]);
        }
      }

      for (const tbl of d.querySelectorAll("table")) {
        const trs = tbl.querySelectorAll("tr");
        if (trs.length <= 1) continue;
        const headers = [...trs[0].querySelectorAll("th, td")].map((c) => c.textContent.trim());
        const rows = [];
        for (let r = 1; r < Math.min(trs.length, 60); r++) {
          const cells = [...trs[r].querySelectorAll("td")].map((c) => c.textContent.trim());
          if (cells.some((c) => c.length > 0)) rows.push(cells);
        }
        if (rows.length > 0) tables.push({ headers, rows });
      }
    }

    const attachments = [];
    const seenAtt = new Set();
    for (const d of allDocs) {
      for (const a of d.querySelectorAll("a[href]")) {
        const href = (a.getAttribute("href") || "").trim();
        if (!href || /^javascript:|^#/i.test(href)) continue;
        const text = (a.textContent || a.getAttribute("title") || "").trim();
        if (
          /\.(pdf|zip|7z|rar|xlsx?|csv|docx?|txt|log|xml|json|png|jpe?g|gif|bmp|tif|eml|msg|p7m)(\b|$)/i.test(href) ||
          /\.(pdf|zip|7z|rar|xlsx?|csv|docx?|txt|log|xml|json|png|jpe?g|gif|bmp|tif|eml|msg|p7m)(\b|$)/i.test(text) ||
          /download|allegat|attach/i.test(href)
        ) {
          const fullHref = a.href || href;
          if (seenAtt.has(fullHref)) continue;
          seenAtt.add(fullHref);
          attachments.push({
            id: `ar-att-${attachments.length + 1}`,
            fileName: text || href.split("/").pop() || `Allegato ${attachments.length + 1}`,
            url: fullHref,
          });
        }
      }
    }

    // il testo di ogni riquadro, pulito; il primo è la pagina, gli altri i riquadri interni nell'ordine in cui compaiono
    const bodies = allDocs
      .map((d) => (d.body ? d.body.innerText || d.body.textContent || "" : "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000))
      .slice(0, 12);
    const bodyText = bodies.filter(Boolean).join("\n").slice(0, 20000);

    return {
      title: doc.title || "",
      fields,
      texts,
      tables,
      attachments,
      bodyText,
      bodies,
    };
  }

  async function readDetail(rawUrl, deep = false) {
    let fullUrl = String(rawUrl || "").trim();
    if (!fullUrl) return { error: "url-vuoto" };
    if (!/^https?:\/\//i.test(fullUrl)) {
      if (fullUrl.startsWith("../")) fullUrl = location.origin + "/areariservata/" + fullUrl.slice(3);
      else if (fullUrl.startsWith("/")) fullUrl = location.origin + fullUrl;
      else fullUrl = location.origin + "/areariservata/jsp/" + fullUrl;
    }

    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1024px;height:800px;opacity:0;pointer-events:none;";
    document.body.appendChild(iframe);
    try {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        iframe.onload = () => {
          clearTimeout(t);
          resolve();
        };
        iframe.onerror = () => {
          clearTimeout(t);
          resolve();
        };
        iframe.src = fullUrl;
      });
      if (deep) {
        // Scheda fatta di più riquadri che si riempiono uno dopo l'altro: si aspetta che il contenuto resti fermo (al massimo ~8 s)
        let last = "";
        let stable = 0;
        let best = null;
        for (let i = 0; i < 32 && stable < 3; i++) {
          await new Promise((r) => setTimeout(r, 250));
          try {
            const doc = iframe.contentDocument;
            if (!doc || !doc.body) continue;
            const ex = extractFromDocument(doc);
            const sig = `${ex.bodyText.length}:${ex.fields.length}:${ex.texts.length}`;
            stable = sig === last && ex.bodyText.length > 80 ? stable + 1 : 0;
            last = sig;
            best = ex;
          } catch {
            /* */
          }
        }
        if (!best) return { error: "pagina-non-leggibile", url: fullUrl };
        return { ok: true, data: { ...best, url: fullUrl } };
      }
      // SitePainter popola i controlli via JS dopo l'evento load: attendiamo che compaiano valori nei campi
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const doc = iframe.contentDocument;
          if (doc && doc.body) {
            const extracted = extractFromDocument(doc);
            if (extracted.texts.length || extracted.fields.length >= 3 || (i >= 5 && extracted.bodyText.length > 80)) {
              return { ok: true, data: { ...extracted, url: fullUrl } };
            }
          }
        } catch {
          /* */
        }
      }
      const doc = iframe.contentDocument;
      if (!doc || !doc.body) return { error: "pagina-non-leggibile", url: fullUrl };
      return { ok: true, data: { ...extractFromDocument(doc), url: fullUrl } };
    } finally {
      iframe.remove();
    }
  }

  // Richiesta di sola lettura a una pagina dell'Area Riservata (Storico): stessa sessione della scheda
  async function plainFetch({ path, method = "GET", body = null }) {
    if (!/^\/(jsp|servlet)\//.test(String(path || ""))) return { error: "percorso-non-ammesso" };
    const base = location.origin + "/areariservata";
    const r = await fetch(base + path, {
      method,
      credentials: "include",
      headers: body != null ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {},
      body: body != null ? body : undefined,
    });
    return { ok: true, status: r.status, text: await r.text() };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "ar-cmd") return;
    const run = async () => {
      if (msg.cmd === "status") {
        const st = await discover(msg.hint || {});
        return { ok: !!st.mcid, mcid: st.mcid, pArea: st.pArea, idCenSer: st.idCenSer, url: location.href };
      }
      if (msg.cmd === "search") return await runSearch(msg);
      if (msg.cmd === "read") return await readDetail(msg.url, msg.deep === true);
      if (msg.cmd === "fetch") return await plainFetch(msg);
      return { error: "comando-sconosciuto" };
    };
    run().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  });
})();
