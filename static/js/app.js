/* Ricerca TKT — interfaccia (JavaScript senza dipendenze) */
(() => {
  "use strict";

  // ------------------------------------------------------------------ utilità
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const NF = new Intl.NumberFormat("it-IT");
  const fmtN = (n) => NF.format(n || 0);
  const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const MESI_LUNGHI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto",
    "settembre", "ottobre", "novembre", "dicembre"];

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    }
    appendAll(el, children);
    return el;
  }
  function appendAll(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function debounce(fn, ms) {
    let t = 0;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  function fmtDateTime(iso) {
    try {
      return new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
    } catch { return iso; }
  }
  function isoDate(d) {
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  function norm(s) {
    return (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function segNodes(segs, fallback) {
    if (!segs || !segs.length) return [fallback || ""];
    return segs.map(([t, hl]) => (hl ? h("mark", null, t) : t));
  }
  let toastTimer = 0;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h("textarea", { class: "offscreen" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(msg || "Copiato negli appunti");
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // ------------------------------------------------------------------ API
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", credentials: "same-origin", headers: { "X-RTKT": "1" } };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(path, init);
    if (opts.raw) return res;
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = (data && (typeof data.detail === "string" ? data.detail : "Dati non validi")) || `Errore ${res.status}`;
      if (res.status === 401 && !opts.noAuthRedirect) onSessionLost(msg);
      throw new ApiError(res.status, msg);
    }
    return data;
  }

  // ------------------------------------------------------------------ stato
  const state = {
    config: null,
    me: null,
    profile: null,
    mode: "all",
    results: [],
    keys: new Set(),
    favorites: new Map(),
    facet: { products: new Set(), year: null, month: null, tags: new Set() },
    refine: "",
    sort: "rank",
    group: "none",
    page: 1,
    pageSize: 50,
    selected: new Set(),
    searching: false,
    abort: null,
    lastSpec: null,
    stats: null,
    query: "",
    alerts: [],
    loginMethod: "password",
  };

  // ------------------------------------------------------------------ avvio
  async function boot() {
    try {
      state.config = await api("/api/config");
    } catch (e) {
      $("#boot").textContent = "Impossibile contattare il server.";
      return;
    }
    setupLogin();
    setupMain();
    try {
      const me = await api("/api/me", { noAuthRedirect: true });
      if (!me.authenticated) return showLogin();
      state.me = me;
      await enterApp();
    } catch {
      showLogin();
    }
  }

  function showLogin(message) {
    $("#boot").hidden = true;
    $("#view-main").hidden = true;
    $("#view-login").hidden = false;
    $("#login-error").textContent = message || "";
    setTimeout(() => ($("#login-user").value ? $("#login-pass") : $("#login-user")).focus(), 0);
  }

  let sessionLostShown = false;
  function onSessionLost(msg) {
    if (sessionLostShown) return;
    sessionLostShown = true;
    if (state.abort) state.abort.abort();
    showLogin(msg || "Sessione scaduta: accedi di nuovo.");
  }

  // ------------------------------------------------------------------ login
  function setupLogin() {
    const sel = $("#login-connector");
    clear(sel);
    for (const c of state.config.connectors) sel.appendChild(h("option", { value: c.id, text: c.label }));
    $("#login-connector-wrap").hidden = state.config.connectors.length < 2;
    sel.addEventListener("change", updateLoginForm);
    $$("#login-method button").forEach((b) =>
      b.addEventListener("click", () => {
        state.loginMethod = b.dataset.method;
        updateLoginForm();
      })
    );
    $("#login-form").addEventListener("submit", doLogin);
    updateLoginForm();
  }

  function updateLoginForm() {
    const c = state.config.connectors.find((x) => x.id === $("#login-connector").value) || state.config.connectors[0];
    if (!c.cookie_login) state.loginMethod = "password";
    $("#login-method").hidden = !c.cookie_login;
    $$("#login-method button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.method === state.loginMethod)));
    const cookie = state.loginMethod === "cookie";
    $("#login-pass-wrap").hidden = cookie;
    $("#login-cookie-wrap").hidden = !cookie;
    $("#login-hint").textContent = c.hint || "";
  }

  async function doLogin(ev) {
    ev.preventDefault();
    const btn = $("#login-submit");
    $("#login-error").textContent = "";
    btn.disabled = true;
    btn.textContent = "Accesso in corso…";
    try {
      const body = {
        connector: $("#login-connector").value,
        username: $("#login-user").value.trim(),
        password: state.loginMethod === "password" ? $("#login-pass").value : "",
        cookie: state.loginMethod === "cookie" ? $("#login-cookie").value.trim() : "",
      };
      await api("/api/login", { method: "POST", body, noAuthRedirect: true });
      $("#login-pass").value = "";
      $("#login-cookie").value = "";
      state.me = await api("/api/me");
      sessionLostShown = false;
      await enterApp();
    } catch (e) {
      $("#login-error").textContent = e.message || "Accesso non riuscito";
    } finally {
      btn.disabled = false;
      btn.textContent = "Accedi";
    }
  }

  async function enterApp() {
    state.profile = state.me.profile;
    $("#boot").hidden = true;
    $("#view-login").hidden = true;
    $("#view-main").hidden = false;
    $("#user-name").textContent = state.me.user;
    const badge = $("#conn-badge");
    badge.textContent = state.me.connector.id === "demo" ? "DEMO" : "Zucchetti";
    badge.className = "badge" + (state.me.connector.id === "demo" ? " demo" : "");
    $("#nav-diag").hidden = !state.me.diagnostics;
    applyProfile();
    setMode(state.mode);
    await loadFavorites();
    switchTab("search");
    if (!applyHash()) {
      updatePreview();
      $("#q").focus();
    }
  }

  // ------------------------------------------------------------------ profilo
  function applyProfile() {
    const p = state.profile;
    $$(".cap-n").forEach((el) => (el.textContent = p.cap));
    const grid = clear($("#riepilogo"));
    for (const f of p.fields.filter((x) => x.group === "riepilogo")) {
      const input = h("input", {
        id: `f-${f.key}`, "data-field": f.key, placeholder: f.hint || "",
        title: f.enabled ? f.hint || f.label : "Campo non ancora mappato: vedi config/zucchetti.json (README)",
        disabled: !f.enabled,
      });
      grid.appendChild(h("label", { class: "fld" + (f.enabled ? "" : " disabled") },
        h("span", null, f.label, f.enabled ? null : h("span", { class: "tag-off", text: "non mappato" })), input));
    }
    const enabled = (k) => (p.fields.find((x) => x.key === k) || {}).enabled;
    for (const opt of $$("#scope option")) {
      const off = (opt.value === "subject" && !enabled("subject")) || (opt.value === "text" && !enabled("text"));
      opt.disabled = off;
      opt.textContent = opt.textContent.replace(/ \(non mappato\)$/, "") + (off ? " (non mappato)" : "");
    }
    $("#core").value = p.default_core || "";
    $("#area").value = p.default_area || "";
    $("#langs").value = p.default_langs || "";
    chipsIn.setOptions(p.products || []);
    chipsOut.setOptions(p.products || []);
  }

  // ------------------------------------------------------------------ input a "chip"
  class Chips {
    constructor(root, onChange) {
      this.root = root;
      this.values_ = [];
      this.onChange = onChange;
      this.listId = `${root.id}-list`;
      this.input = h("input", { placeholder: root.dataset.placeholder || "", list: this.listId, "aria-label": root.dataset.placeholder || "" });
      this.datalist = h("datalist", { id: this.listId });
      root.append(this.input, this.datalist);
      root.addEventListener("click", () => this.input.focus());
      this.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === "Tab") {
          if (this.input.value.trim()) {
            e.preventDefault();
            this.add(this.input.value);
          }
        } else if (e.key === "Backspace" && !this.input.value && this.values_.length) {
          this.remove(this.values_[this.values_.length - 1]);
        }
      });
      this.input.addEventListener("change", () => { if (this.input.value.trim()) this.add(this.input.value); });
      this.input.addEventListener("blur", () => { if (this.input.value.trim()) this.add(this.input.value); });
    }
    setOptions(list) {
      clear(this.datalist);
      for (const v of list) this.datalist.appendChild(h("option", { value: v }));
    }
    add(raw) {
      for (const part of raw.split(/[\s,;]+/)) {
        const v = part.trim().toUpperCase();
        if (v && !this.values_.includes(v)) this.values_.push(v);
      }
      this.input.value = "";
      this.render();
      this.onChange();
    }
    remove(v) {
      this.values_ = this.values_.filter((x) => x !== v);
      this.render();
      this.onChange();
    }
    set(list) {
      this.values_ = [...new Set((list || []).map((x) => String(x).toUpperCase()))];
      this.render();
    }
    values() {
      return [...this.values_];
    }
    render() {
      $$(".chip", this.root).forEach((c) => c.remove());
      for (const v of this.values_) {
        const chip = h("span", { class: "chip" }, v,
          h("button", { type: "button", "aria-label": `Rimuovi ${v}`, onclick: (e) => { e.stopPropagation(); this.remove(v); } }, "×"));
        this.root.insertBefore(chip, this.input);
      }
    }
  }
  let chipsIn, chipsOut;

  // ------------------------------------------------------------------ form di ricerca
  function setupMain() {
    const onChange = () => { updatePreview(); updateAdvCount(); };
    chipsIn = new Chips($("#products-in"), onChange);
    chipsOut = new Chips($("#products-out"), onChange);

    $$("#nav button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("#btn-logout").addEventListener("click", logout);

    $$("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); hideSuggest(); runSearch(); });
    $("#search-form").addEventListener("input", (e) => {
      if (e.target.id === "date-from" || e.target.id === "date-to") $("#date-preset").value = "custom";
      onChange();
    });
    $("#search-form").addEventListener("change", onChange);
    $("#date-preset").addEventListener("change", () => { applyPreset($("#date-preset").value); onChange(); });

    $("#btn-copy-query").addEventListener("click", () => state.query && copyText($("#qpreview").textContent, "Query copiata"));
    $("#btn-edit-query").addEventListener("click", editAsSolr);
    $("#btn-reset").addEventListener("click", () => { applySpec({}); updatePreview(); $("#q").focus(); });
    $("#btn-save-search").addEventListener("click", openSaveDialog);
    $("#btn-stop").addEventListener("click", stopSearch);

    // suggerimenti
    const q = $("#q");
    q.addEventListener("input", debounce(fetchSuggest, 220));
    q.addEventListener("keydown", suggestKeys);
    q.addEventListener("blur", () => setTimeout(hideSuggest, 150));

    // barra risultati
    $("#refine").addEventListener("input", debounce(() => { state.refine = $("#refine").value; state.page = 1; render(); }, 150));
    $("#sort").addEventListener("change", () => { state.sort = $("#sort").value; state.page = 1; render(); });
    $("#group").addEventListener("change", () => { state.group = $("#group").value; state.page = 1; render(); });
    $("#page-size").addEventListener("change", () => { state.pageSize = +$("#page-size").value; state.page = 1; render(); });
    $("#sel-all").addEventListener("change", () => {
      for (const t of state.pageItems || []) {
        if ($("#sel-all").checked) state.selected.add(t.key); else state.selected.delete(t.key);
      }
      render();
    });
    $("#btn-export").addEventListener("click", (e) => {
      e.stopPropagation();
      const m = $("#export-menu");
      m.hidden = !m.hidden;
      $("#btn-export").setAttribute("aria-expanded", String(!m.hidden));
    });
    document.addEventListener("click", () => { $("#export-menu").hidden = true; $("#btn-export").setAttribute("aria-expanded", "false"); });
    $$("#export-menu button").forEach((b) => b.addEventListener("click", () => doExport(b.dataset.export)));

    // altre sezioni
    $("#btn-clear-history").addEventListener("click", clearHistory);
    $("#fav-filter").addEventListener("input", debounce(renderFavorites, 150));
    $("#btn-fav-export").addEventListener("click", () => {
      const items = filteredFavorites().map((f) => ({ ...f.ticket, _note: f.note, _tags: f.tags }));
      download("preferiti.csv", toCSV(items), "text/csv;charset=utf-8");
    });
    $("#note-form").addEventListener("submit", noteDialogSubmit);
    $("#save-form").addEventListener("submit", saveDialogSubmit);
    $("#diag-curl-form").addEventListener("submit", diagCurl);
    $("#diag-raw-form").addEventListener("submit", diagRaw);
    $("#diag-template-del").addEventListener("click", diagTemplateDelete);

    // scorciatoie
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
      if (e.key === "/" && !typing && !$("#view-main").hidden) {
        e.preventDefault();
        switchTab("search");
        $("#q").focus();
        $("#q").select();
      } else if (e.key === "Escape" && state.searching) {
        stopSearch();
      }
    });
    window.addEventListener("popstate", () => applyHash());
  }

  function setMode(mode) {
    state.mode = mode;
    $$("#mode button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    const solr = mode === "solr";
    $("#prefix").disabled = solr;
    $("#fuzzy").disabled = solr;
    $("#proximity").disabled = mode !== "phrase";
    $("#q").placeholder = solr
      ? '(detassazione OR "premio di risultato") AND NOT storno'
      : "Cerca nei ticket… es. detassazione premio";
    $("#q").classList.toggle("mono", solr);
    updatePreview();
  }

  function applyPreset(v) {
    const today = new Date();
    let from = null;
    let to = isoDate(today);
    const back = (days) => { const d = new Date(today); d.setDate(d.getDate() - days); return isoDate(d); };
    const backM = (m) => { const d = new Date(today); d.setMonth(d.getMonth() - m); return isoDate(d); };
    switch (v) {
      case "30d": from = back(30); break;
      case "3m": from = backM(3); break;
      case "6m": from = backM(6); break;
      case "1y": from = backM(12); break;
      case "2y": from = backM(24); break;
      case "5y": from = backM(60); break;
      case "ytd": from = `${today.getFullYear()}-01-01`; break;
      case "py": from = `${today.getFullYear() - 1}-01-01`; to = `${today.getFullYear() - 1}-12-31`; break;
      case "custom": return;
      default: to = null;
    }
    $("#date-from").value = from || "";
    $("#date-to").value = to || "";
  }

  function buildSpec() {
    const fields = {};
    for (const inp of $$("#riepilogo input")) {
      if (!inp.disabled && inp.value.trim()) fields[inp.dataset.field] = inp.value.trim();
    }
    let text = $("#q").value.trim();
    let numbers = $("#numbers").value.trim();
    if (state.mode !== "solr" && /^#\s*\d+(\s*[,;\s]\s*#?\s*\d+)*$/.test(text)) {
      numbers = [numbers, text.replace(/#/g, "")].filter(Boolean).join(", ");
      text = "";
    }
    return {
      text,
      mode: state.mode,
      exclude: $("#exclude").value.trim(),
      phrase: $("#phrase").value.trim(),
      proximity: Math.max(0, Math.min(50, parseInt($("#proximity").value, 10) || 0)),
      prefix: $("#prefix").checked,
      fuzzy: $("#fuzzy").checked,
      scope: $("#scope").value,
      numbers,
      date_from: $("#date-from").value || null,
      date_to: $("#date-to").value || null,
      products_in: chipsIn.values(),
      products_out: chipsOut.values(),
      fields,
      core: $("#core").value.trim(),
      area: $("#area").value.trim(),
      langs: $("#langs").value.trim(),
    };
  }

  function applySpec(s) {
    const p = state.profile || {};
    $("#q").value = s.text || "";
    setMode(s.mode || "all");
    $("#exclude").value = s.exclude || "";
    $("#phrase").value = s.phrase || "";
    $("#proximity").value = s.proximity || 0;
    $("#prefix").checked = !!s.prefix;
    $("#fuzzy").checked = !!s.fuzzy;
    $("#scope").value = s.scope || "all";
    $("#numbers").value = s.numbers || "";
    $("#date-from").value = s.date_from || "";
    $("#date-to").value = s.date_to || "";
    $("#date-preset").value = s.date_from || s.date_to ? "custom" : "";
    chipsIn.set(s.products_in);
    chipsOut.set(s.products_out);
    for (const inp of $$("#riepilogo input")) inp.value = (s.fields || {})[inp.dataset.field] || "";
    $("#core").value = s.core ?? p.default_core ?? "";
    $("#area").value = s.area ?? p.default_area ?? "";
    $("#langs").value = s.langs ?? p.default_langs ?? "";
    updateAdvCount();
  }

  function updateAdvCount() {
    const s = buildSpec();
    let n = 0;
    if (s.exclude) n++;
    if (s.phrase) n++;
    if (s.scope !== "all") n++;
    if (s.prefix) n++;
    if (s.fuzzy) n++;
    if (s.proximity) n++;
    if (s.products_out.length) n++;
    n += Object.keys(s.fields).length;
    $("#adv-count").textContent = n ? `(${n} attiv${n === 1 ? "a" : "e"})` : "";
  }

  const updatePreview = debounce(async () => {
    if (!state.me) return;
    const code = $("#qpreview");
    const notes = clear($("#qwarnings"));
    try {
      const r = await api("/api/query-preview", { method: "POST", body: buildSpec() });
      code.classList.toggle("err", !!r.error);
      code.textContent = r.error || r.query;
      state.query = r.error ? "" : r.query;
      for (const w of r.warnings || []) notes.appendChild(h("div", { class: "note", text: w }));
    } catch (e) {
      if (e.status !== 401) {
        code.classList.add("err");
        code.textContent = e.message;
      }
    }
  }, 250);

  function editAsSolr() {
    if (!state.query) return;
    const q = state.query;
    const keep = buildSpec();
    applySpec({ text: q, mode: "solr", core: keep.core, area: keep.area, langs: keep.langs });
    updatePreview();
    toast("Criteri convertiti in una query Solr modificabile");
    $("#q").focus();
  }

  // ------------------------------------------------------------------ suggerimenti
  let suggestIdx = -1;
  async function fetchSuggest() {
    const v = $("#q").value;
    if (state.mode === "solr" || v.trim().length < 2 || document.activeElement !== $("#q")) return hideSuggest();
    try {
      const r = await api(`/api/suggest?q=${encodeURIComponent(v)}`);
      const list = clear($("#suggest"));
      suggestIdx = -1;
      for (const s of r.suggestions || []) {
        if (s.toLowerCase() === v.trim().toLowerCase()) continue;
        list.appendChild(h("li", { role: "option", onmousedown: (e) => { e.preventDefault(); pickSuggest(s); } }, s));
      }
      list.hidden = !list.children.length;
    } catch { hideSuggest(); }
  }
  function hideSuggest() { $("#suggest").hidden = true; suggestIdx = -1; }
  function pickSuggest(s) { $("#q").value = s; hideSuggest(); updatePreview(); $("#q").focus(); }
  function suggestKeys(e) {
    const list = $("#suggest");
    if (list.hidden) return;
    const items = $$("li", list);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      suggestIdx = (suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === suggestIdx)));
    } else if (e.key === "Enter" && suggestIdx >= 0) {
      e.preventDefault();
      pickSuggest(items[suggestIdx].textContent);
    } else if (e.key === "Escape") {
      hideSuggest();
    }
  }

  // ------------------------------------------------------------------ esecuzione ricerca
  function stopSearch() {
    if (state.abort) state.abort.abort();
  }

  function setHash(spec) {
    const hash = "#s=" + b64urlEncode(JSON.stringify(spec));
    if (location.hash !== hash) history.pushState(null, "", hash);
  }

  function applyHash() {
    const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)$/);
    if (!m || !state.me) return false;
    try {
      const spec = JSON.parse(b64urlDecode(m[1]));
      switchTab("search");
      applySpec(spec);
      updatePreview();
      runSearch({ fromHash: true });
      return true;
    } catch {
      return false;
    }
  }

  async function runSearch(opts = {}) {
    const spec = buildSpec();
    if (state.abort) state.abort.abort();
    const ctrl = new AbortController();
    state.abort = ctrl;
    state.lastSpec = spec;
    if (!opts.fromHash) setHash(spec);

    // reset
    state.results = [];
    state.keys = new Set();
    state.selected.clear();
    state.facet = { products: new Set(), year: null, month: null, tags: new Set() };
    state.page = 1;
    state.stats = null;
    state.alerts = [];
    state.searching = true;
    $("#refine").value = "";
    state.refine = "";
    $("#empty-state").hidden = true;
    $("#results").hidden = false;
    $("#progress").hidden = false;
    $("#progress-bar").parentElement.classList.add("indet");
    $("#progress-text").textContent = "Ricerca in corso…";
    $("#btn-search").disabled = true;
    renderAlerts();
    render();

    let res;
    try {
      res = await api("/api/search", { method: "POST", body: spec, raw: true, signal: ctrl.signal });
    } catch (e) {
      finishSearch(ctrl);
      if (e.name !== "AbortError") pushAlert("err", "Impossibile contattare il server.");
      return;
    }
    if (!res.ok) {
      let msg = `Errore ${res.status}`;
      try { const j = await res.json(); if (typeof j.detail === "string") msg = j.detail; } catch { /* */ }
      finishSearch(ctrl);
      if (res.status === 401) return onSessionLost(msg);
      pushAlert("err", msg);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) handleEvent(JSON.parse(line));
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        if (state.abort === ctrl) pushAlert("warn", "Ricerca interrotta: sono mostrati i risultati trovati finora.");
      } else {
        pushAlert("err", "Connessione interrotta durante la ricerca.");
      }
    }
    finishSearch(ctrl);
  }

  function finishSearch(ctrl) {
    if (state.abort !== ctrl) return;
    state.searching = false;
    state.abort = null;
    $("#progress").hidden = true;
    $("#btn-search").disabled = false;
    render();
  }

  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => { renderPending = false; render(); }, 200);
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "start":
        state.query = ev.query;
        for (const w of ev.warnings || []) pushAlert("warn", w);
        break;
      case "batch":
        for (const t of ev.tickets) {
          if (state.keys.has(t.key)) continue;
          state.keys.add(t.key);
          state.results.push(t);
        }
        scheduleRender();
        break;
      case "warning":
        pushAlert("warn", ev.message);
        break;
      case "error":
        pushAlert("err", ev.message);
        if (ev.code === "session_expired") setTimeout(() => onSessionLost(ev.message), 1200);
        break;
      case "done":
        state.stats = ev.stats;
        summarizeAlerts(ev.stats);
        break;
      default:
        break;
    }
  }

  function pushAlert(kind, message, action) {
    if (state.alerts.some((a) => a.message === message)) return;
    state.alerts.push({ kind, message, action });
    renderAlerts();
  }

  function summarizeAlerts(st) {
    const cap = st.cap || state.profile.cap;
    if (st.capped) {
      pushAlert("warn", `Zucchetti mostra al massimo ${cap} risultati (i più rilevanti): restringi la ricerca con un periodo, un prodotto o parole più specifiche.`);
    }
    if (st.filtered_out > 0) {
      pushAlert("info", `${fmtN(st.filtered_out)} risultati restituiti da Zucchetti sono stati scartati perché non rispettano i filtri (periodo, numeri, prodotti).`);
    }
  }

  function renderAlerts() {
    const box = clear($("#res-alert"));
    const items = state.alerts.filter((a) => a.kind !== "info");
    box.hidden = !items.length;
    box.className = "alert" + (items.some((a) => a.kind === "err") ? " err" : "");
    for (const a of items) {
      box.appendChild(h("div", { class: "row gap wrap" }, h("span", null, a.message),
        a.action ? h("button", { type: "button", class: "btn small", onclick: a.action.run }, a.action.label) : null));
    }
  }

  // ------------------------------------------------------------------ filtri sui risultati
  function parseRefine(text) {
    const inc = [];
    const exc = [];
    for (const m of (text || "").matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
      const neg = m[1] || m[3];
      const term = norm(m[2] || m[4]);
      if (!term || term === "-") continue;
      (neg ? exc : inc).push(term);
    }
    return { inc, exc };
  }
  function haystack(t) {
    if (t._hay === undefined) {
      t._hay = norm(`#${t.number ?? ""} ${t.product} ${t.subject} ${t.snippet} ${fmtDate(t.date)} ${t.id}`);
    }
    const fav = state.favorites.get(t.key);
    return fav ? `${t._hay} ${norm(fav.note)} ${norm(fav.tags.join(" "))}` : t._hay;
  }
  function filterItems(skip) {
    const r = parseRefine(state.refine);
    const f = state.facet;
    return state.results.filter((t) => {
      if (r.inc.length || r.exc.length) {
        const hay = haystack(t);
        if (!r.inc.every((w) => hay.includes(w))) return false;
        if (r.exc.some((w) => hay.includes(w))) return false;
      }
      if (skip !== "product" && f.products.size && !f.products.has(t.product || "—")) return false;
      if (skip !== "year" && f.year && (t.date || "").slice(0, 4) !== f.year) return false;
      if (skip !== "month" && skip !== "year" && f.month && (t.date || "").slice(5, 7) !== f.month) return false;
      if (skip !== "tags" && f.tags.size) {
        const fav = state.favorites.get(t.key);
        if (!fav || !fav.tags.some((x) => f.tags.has(x))) return false;
      }
      return true;
    });
  }
  const SORTERS = {
    rank: (a, b) => a.rank - b.rank,
    date_desc: (a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0),
    date_asc: (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.number || 0) - (b.number || 0),
    num_desc: (a, b) => (b.number || 0) - (a.number || 0),
    num_asc: (a, b) => (a.number || 0) - (b.number || 0),
    subject: (a, b) => a.subject.localeCompare(b.subject, "it", { sensitivity: "base" }) || a.rank - b.rank,
  };
  function groupKey(t) {
    if (state.group === "product") return t.product || "—";
    if (state.group === "year") return (t.date || "").slice(0, 4) || "—";
    if (state.group === "month") return (t.date || "").slice(0, 7) || "—";
    return "";
  }
  function groupLabel(k) {
    if (state.group === "month" && /^\d{4}-\d{2}$/.test(k)) return `${MESI_LUNGHI[+k.slice(5) - 1]} ${k.slice(0, 4)}`;
    return k === "—" ? "Senza valore" : k;
  }
  function visibleItems() {
    const items = filterItems();
    const sorter = SORTERS[state.sort] || SORTERS.rank;
    if (state.group === "none") return items.sort(sorter);
    const dir = state.group === "product" ? 1 : -1;
    return items.sort((a, b) => {
      const ga = groupKey(a);
      const gb = groupKey(b);
      if (ga !== gb) return ga === "—" ? 1 : gb === "—" ? -1 : ga.localeCompare(gb) * dir;
      return sorter(a, b);
    });
  }

  // ------------------------------------------------------------------ rendering risultati
  function render() {
    if ($("#results").hidden) return;
    const items = visibleItems();
    state.visible = items;
    renderFacets();
    renderActiveFilters();
    renderSummary(items.length);

    const pages = Math.max(1, Math.ceil(items.length / state.pageSize));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * state.pageSize;
    const pageItems = items.slice(start, start + state.pageSize);
    state.pageItems = pageItems;

    const list = clear($("#result-list"));
    let lastGroup = null;
    for (const t of pageItems) {
      if (state.group !== "none") {
        const g = groupKey(t);
        if (g !== lastGroup) {
          const n = items.filter((x) => groupKey(x) === g).length;
          list.appendChild(h("div", { class: "group-title" }, groupLabel(g), h("span", { class: "muted", text: fmtN(n) })));
          lastGroup = g;
        }
      }
      list.appendChild(renderTicket(t));
    }
    if (!pageItems.length && !state.searching) {
      list.appendChild(h("div", { class: "card list-empty", text: state.results.length ? "Nessun risultato con i filtri attuali." : "Nessun ticket trovato." }));
    }
    $("#sel-all").checked = pageItems.length > 0 && pageItems.every((t) => state.selected.has(t.key));
    renderPager(pages);
  }

  function renderSummary(nVisible) {
    const el = clear($("#res-summary"));
    const total = state.results.length;
    const st = state.stats;
    if (!total && state.searching) {
      el.appendChild(h("span", { class: "muted", text: "Ricerca in corso…" }));
      return;
    }
    const parts = [h("b", null, fmtN(total)), total === 1 ? " ticket trovato" : " ticket trovati"];
    if (nVisible !== total) parts.push(" · ", h("b", null, fmtN(nVisible)), " dopo i filtri");
    if (st) {
      parts.push(h("span", { class: "muted" },
        st.cache_hits ? " · dalla cache" : "",
        ` · ${(st.elapsed_ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} s`,
        st.capped ? ` · limite di ${fmtN(st.cap)} raggiunto` : ""));
    }
    if (state.selected.size) {
      parts.push(" · ", h("b", null, fmtN(state.selected.size)), " selezionati ",
        h("button", { type: "button", class: "btn ghost small", onclick: () => { state.selected.clear(); render(); } }, "deseleziona"));
    }
    appendAll(el, parts);
  }

  function renderTicket(t, opts = {}) {
    const fav = state.favorites.get(t.key);
    const selected = state.selected.has(t.key);
    const numLabel = t.number != null ? `#${t.number}` : t.id || "ticket";
    const numEl = t.url
      ? h("a", { class: "num", href: t.url, target: "_blank", rel: "noopener noreferrer", title: "Apri su Zucchetti" }, numLabel)
      : h("span", { class: "num" }, numLabel);
    const head = h("div", { class: "res-head" },
      opts.noSelect ? null : h("input", {
        type: "checkbox", class: "sel", "aria-label": `Seleziona ${numLabel}`, checked: selected,
        onchange: (e) => { if (e.target.checked) state.selected.add(t.key); else state.selected.delete(t.key); render(); },
      }),
      numEl,
      h("button", { type: "button", class: "icon-btn", title: "Copia numero", "aria-label": "Copia numero",
        onclick: () => copyText(String(t.number ?? t.id), `Copiato ${numLabel}`) }, "⧉"),
      t.product ? h("span", { class: "badge", text: t.product }) : null,
      t.date ? h("time", { datetime: t.date, text: fmtDate(t.date) }) : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "icon-btn" + (fav ? " on" : ""), title: fav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti",
        "aria-pressed": String(!!fav), onclick: () => toggleFavorite(t) }, fav ? "★" : "☆"),
      h("button", { type: "button", class: "icon-btn", title: "Nota ed etichette", "aria-label": "Nota ed etichette",
        onclick: () => openNoteDialog(t) }, "✎"),
      t.url ? h("a", { class: "btn small", href: t.url, target: "_blank", rel: "noopener noreferrer" }, "Apri ↗") : null);
    const meta = [];
    if (fav) {
      for (const tag of fav.tags) meta.push(h("span", { class: "tag", text: tag }));
      if (fav.note) meta.push(h("span", { class: "note-txt", text: fav.note }));
    }
    return h("article", { class: "res" + (selected ? " selected" : "") },
      head,
      h("div", { class: "res-subject" }, segNodes(t.subject_hl, t.subject || t.title)),
      t.snippet ? h("div", { class: "res-snippet clamp" }, segNodes(t.snippet_hl, t.snippet)) : null,
      meta.length ? h("div", { class: "res-meta" }, meta) : null);
  }

  function renderPager(pages) {
    const nav = clear($("#pager"));
    if (pages <= 1) return;
    const go = (p) => { state.page = p; render(); $("#results").scrollIntoView({ behavior: "smooth", block: "start" }); };
    nav.appendChild(h("button", { type: "button", disabled: state.page === 1, onclick: () => go(state.page - 1), "aria-label": "Pagina precedente" }, "‹"));
    const shown = new Set([1, pages, state.page - 2, state.page - 1, state.page, state.page + 1, state.page + 2]);
    let last = 0;
    for (let p = 1; p <= pages; p++) {
      if (!shown.has(p)) continue;
      if (p - last > 1) nav.appendChild(h("span", { class: "gap", text: "…" }));
      nav.appendChild(h("button", { type: "button", "aria-current": p === state.page ? "page" : null, onclick: () => go(p) }, String(p)));
      last = p;
    }
    nav.appendChild(h("button", { type: "button", disabled: state.page === pages, onclick: () => go(state.page + 1), "aria-label": "Pagina successiva" }, "›"));
  }

  function countBy(items, fn) {
    const m = new Map();
    for (const t of items) {
      const k = fn(t);
      if (k === null || k === undefined || k === "") continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  function facetButton(label, n, pressed, onclick, fillPct) {
    return h("li", null, h("button", { type: "button", "aria-pressed": String(pressed), onclick },
      fillPct !== undefined ? (() => { const f = h("span", { class: "fill" }); f.style.width = `${fillPct}%`; return f; })() : null,
      h("span", null, label), h("span", { class: "n", text: fmtN(n) })));
  }

  function renderFacets() {
    const f = state.facet;
    // prodotto
    const prodCounts = countBy(filterItems("product"), (t) => t.product || "—");
    for (const p of f.products) if (!prodCounts.has(p)) prodCounts.set(p, 0);
    const pl = clear($("#facet-product"));
    [...prodCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).forEach(([p, n]) => {
      pl.appendChild(facetButton(p, n, f.products.has(p), () => {
        if (f.products.has(p)) f.products.delete(p); else f.products.add(p);
        state.page = 1; render();
      }));
    });
    if (!pl.children.length) pl.appendChild(h("li", { class: "muted small", text: "—" }));

    // anno
    const yearCounts = countBy(filterItems("year"), (t) => (t.date || "").slice(0, 4));
    const yl = clear($("#facet-year"));
    const ymax = Math.max(1, ...yearCounts.values());
    [...yearCounts.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([y, n]) => {
      yl.appendChild(facetButton(y, n, f.year === y, () => {
        f.year = f.year === y ? null : y;
        f.month = null;
        state.page = 1; render();
      }, (n / ymax) * 100));
    });
    if (!yl.children.length) yl.appendChild(h("li", { class: "muted small", text: "—" }));

    // mese
    $("#facet-month-wrap").hidden = !f.year;
    if (f.year) {
      const mc = countBy(filterItems("month"), (t) => (t.date || "").slice(5, 7));
      const ml = clear($("#facet-month"));
      const mmax = Math.max(1, ...mc.values());
      [...mc.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([m, n]) => {
        ml.appendChild(facetButton(`${MESI[+m - 1]} ${f.year}`, n, f.month === m, () => {
          f.month = f.month === m ? null : m;
          state.page = 1; render();
        }, (n / mmax) * 100));
      });
    }

    // etichette
    const tagCounts = new Map();
    for (const t of filterItems("tags")) {
      const fav = state.favorites.get(t.key);
      if (fav) for (const tag of fav.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    $("#facet-tag-wrap").hidden = !tagCounts.size && !f.tags.size;
    const tl = clear($("#facet-tag"));
    [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([tag, n]) => {
      tl.appendChild(facetButton(tag, n, f.tags.has(tag), () => {
        if (f.tags.has(tag)) f.tags.delete(tag); else f.tags.add(tag);
        state.page = 1; render();
      }));
    });
  }

  function renderActiveFilters() {
    const box = clear($("#active-filters"));
    const f = state.facet;
    const chip = (label, onRemove) => box.appendChild(h("span", { class: "chip" }, label,
      h("button", { type: "button", "aria-label": `Rimuovi filtro ${label}`, onclick: onRemove }, "×")));
    for (const p of f.products) chip(`Prodotto: ${p}`, () => { f.products.delete(p); render(); });
    if (f.year) chip(`Anno: ${f.year}`, () => { f.year = null; f.month = null; render(); });
    if (f.month) chip(`Mese: ${MESI[+f.month - 1]}`, () => { f.month = null; render(); });
    for (const tag of f.tags) chip(`Etichetta: ${tag}`, () => { f.tags.delete(tag); render(); });
    if (state.refine.trim()) chip(`Testo: ${state.refine.trim()}`, () => { $("#refine").value = ""; state.refine = ""; render(); });
    if (box.children.length > 1) {
      box.appendChild(h("button", { type: "button", class: "btn ghost small", onclick: () => {
        state.facet = { products: new Set(), year: null, month: null, tags: new Set() };
        $("#refine").value = ""; state.refine = ""; render();
      } }, "Azzera filtri"));
    }
  }

  // ------------------------------------------------------------------ esportazione
  function exportItems() {
    const items = state.visible || [];
    if (!state.selected.size) return items;
    return items.filter((t) => state.selected.has(t.key));
  }
  function csvCell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita formule in Excel
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCSV(items) {
    const head = ["Numero", "Data", "Prodotto", "Oggetto", "Estratto", "Link", "Nota", "Etichette"];
    const rows = items.map((t) => {
      const fav = state.favorites.get(t.key);
      const note = t._note ?? (fav ? fav.note : "");
      const tags = t._tags ?? (fav ? fav.tags : []);
      return [t.number ?? t.id, fmtDate(t.date), t.product, t.subject, t.snippet,
        t.url && /^https?:/.test(t.url) ? t.url : t.url ? location.origin + t.url : "", note, tags.join(", ")].map(csvCell).join(";");
    });
    return "﻿" + [head.join(";"), ...rows].join("\r\n");
  }
  function doExport(kind) {
    $("#export-menu").hidden = true;
    const items = exportItems();
    if (!items.length) return toast("Nessun risultato da esportare");
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === "csv") download(`ticket-${stamp}.csv`, toCSV(items), "text/csv;charset=utf-8");
    else if (kind === "json") {
      const clean = items.map(({ _hay, subject_hl, snippet_hl, ...rest }) => rest);
      download(`ticket-${stamp}.json`, JSON.stringify({ query: state.query, spec: state.lastSpec, tickets: clean }, null, 2), "application/json");
    } else if (kind === "numbers") {
      copyText(items.map((t) => t.number ?? t.id).join("\n"), `Copiati ${fmtN(items.length)} numeri`);
    } else if (kind === "list") {
      copyText(items.map((t) => `#${t.number ?? t.id}\t${fmtDate(t.date)}\t${t.product}\t${t.subject}`).join("\n"),
        `Copiato elenco di ${fmtN(items.length)} ticket`);
    }
  }

  // ------------------------------------------------------------------ preferiti
  function ticketSnapshot(t) {
    const { _hay, ...rest } = t;
    return rest;
  }
  async function loadFavorites() {
    try {
      const r = await api("/api/favorites");
      state.favorites = new Map(r.items.map((f) => [f.key, f]));
    } catch { state.favorites = new Map(); }
    updateFavCount();
  }
  function updateFavCount() {
    $("#fav-count").textContent = state.favorites.size ? String(state.favorites.size) : "";
  }
  async function toggleFavorite(t) {
    try {
      if (state.favorites.has(t.key)) {
        await api(`/api/favorites/${encodeURIComponent(t.key)}`, { method: "DELETE" });
        state.favorites.delete(t.key);
        toast("Rimosso dai preferiti");
      } else {
        const fav = { key: t.key, ticket: ticketSnapshot(t), note: "", tags: [] };
        await api("/api/favorites", { method: "POST", body: fav });
        state.favorites.set(t.key, fav);
        toast("Aggiunto ai preferiti");
      }
    } catch (e) { toast(e.message); }
    updateFavCount();
    rerenderCurrent();
  }
  let noteTicket = null;
  function openNoteDialog(t) {
    noteTicket = t;
    const fav = state.favorites.get(t.key);
    $("#note-title").textContent = `Nota per #${t.number ?? t.id}`;
    $("#note-text").value = fav ? fav.note : "";
    $("#note-tags").value = fav ? fav.tags.join(", ") : "";
    $("#note-remove").hidden = !fav;
    $("#dlg-note").showModal();
    $("#note-text").focus();
  }
  async function noteDialogSubmit(e) {
    const action = e.submitter ? e.submitter.value : "ok";
    if (action === "cancel" || !noteTicket) return;
    const t = noteTicket;
    try {
      if (action === "remove") {
        await api(`/api/favorites/${encodeURIComponent(t.key)}`, { method: "DELETE" });
        state.favorites.delete(t.key);
      } else {
        const tags = [...new Set($("#note-tags").value.split(",").map((x) => x.trim()).filter(Boolean))];
        const fav = { key: t.key, ticket: ticketSnapshot(t), note: $("#note-text").value.trim(), tags };
        await api("/api/favorites", { method: "POST", body: fav });
        state.favorites.set(t.key, fav);
      }
    } catch (err) { toast(err.message); }
    updateFavCount();
    rerenderCurrent();
  }
  function rerenderCurrent() {
    const tab = $("#nav button[aria-current='page']")?.dataset.tab;
    if (tab === "favorites") renderFavorites(); else render();
  }
  function filteredFavorites() {
    const r = parseRefine($("#fav-filter").value);
    return [...state.favorites.values()].filter((f) => {
      const hay = norm(`#${f.ticket.number ?? ""} ${f.ticket.product} ${f.ticket.subject} ${f.ticket.snippet} ${f.note} ${f.tags.join(" ")}`);
      return r.inc.every((w) => hay.includes(w)) && !r.exc.some((w) => hay.includes(w));
    });
  }
  function renderFavorites() {
    const box = clear($("#fav-list"));
    const items = filteredFavorites();
    if (!items.length) {
      box.appendChild(h("div", { class: "list-empty", text: state.favorites.size ? "Nessun preferito corrisponde al filtro." : "Nessun preferito: usa ☆ sui risultati per salvarli qui, con note ed etichette." }));
      return;
    }
    for (const f of items) box.appendChild(renderTicket(f.ticket, { noSelect: true }));
  }

  // ------------------------------------------------------------------ ricerche salvate e cronologia
  function describeSpec(s) {
    const parts = [];
    const modes = { all: "tutte le parole", any: "almeno una parola", phrase: "frase esatta", solr: "Solr" };
    if (s.text) parts.push(`"${s.text}" (${modes[s.mode] || s.mode})`);
    if (s.phrase) parts.push(`frase "${s.phrase}"`);
    if (s.exclude) parts.push(`senza: ${s.exclude}`);
    if (s.numbers) parts.push(`ticket: ${s.numbers}`);
    if (s.date_from || s.date_to) parts.push(`periodo ${s.date_from ? fmtDate(s.date_from) : "…"} – ${s.date_to ? fmtDate(s.date_to) : "oggi"}`);
    if (s.products_in && s.products_in.length) parts.push(`prodotti: ${s.products_in.join(", ")}`);
    if (s.products_out && s.products_out.length) parts.push(`esclusi: ${s.products_out.join(", ")}`);
    const nf = Object.keys(s.fields || {}).length;
    if (nf) parts.push(`${nf} filtr${nf === 1 ? "o" : "i"} di riepilogo`);
    return parts.join(" · ") || "(nessun criterio)";
  }
  function runSpec(spec) {
    switchTab("search");
    applySpec(spec);
    updatePreview();
    runSearch();
  }
  async function renderSaved() {
    const box = clear($("#saved-list"));
    let items = [];
    try { items = (await api("/api/saved")).items; } catch (e) { box.appendChild(h("div", { class: "list-empty", text: e.message })); return; }
    if (!items.length) {
      box.appendChild(h("div", { class: "list-empty", text: "Nessuna ricerca salvata: usa \"Salva ricerca\" sotto la barra di ricerca." }));
      return;
    }
    for (const it of items) {
      box.appendChild(h("div", { class: "list-item" },
        h("div", { class: "main" }, h("div", { class: "title", text: it.name }), h("div", { class: "sub", text: describeSpec(it.spec) })),
        h("span", { class: "muted small", text: fmtDateTime(it.updated) }),
        h("button", { type: "button", class: "btn small", onclick: () => runSpec(it.spec) }, "Esegui"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => { applySpec(it.spec); switchTab("search"); updatePreview(); } }, "Apri"),
        h("button", { type: "button", class: "btn ghost small danger", onclick: async () => {
          if (!confirm(`Eliminare la ricerca "${it.name}"?`)) return;
          await api(`/api/saved/${it.id}`, { method: "DELETE" });
          renderSaved();
        } }, "Elimina")));
    }
  }
  function openSaveDialog() {
    const s = buildSpec();
    $("#save-name").value = s.text || s.phrase || s.numbers || "";
    $("#dlg-save").showModal();
    $("#save-name").select();
  }
  async function saveDialogSubmit(e) {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const name = $("#save-name").value.trim();
    if (!name) return;
    try {
      await api("/api/saved", { method: "POST", body: { name, spec: buildSpec() } });
      toast("Ricerca salvata");
    } catch (err) { toast(err.message); }
  }
  async function renderHistory() {
    const box = clear($("#history-list"));
    let items = [];
    try { items = (await api("/api/history")).items; } catch (e) { box.appendChild(h("div", { class: "list-empty", text: e.message })); return; }
    if (!items.length) {
      box.appendChild(h("div", { class: "list-empty", text: "La cronologia è vuota." }));
      return;
    }
    for (const it of items) {
      box.appendChild(h("div", { class: "list-item" },
        h("div", { class: "main" }, h("div", { class: "title", text: describeSpec(it.spec) }),
          h("div", { class: "sub", text: `${fmtDateTime(it.created)} · ${fmtN(it.results)} risultati` })),
        h("button", { type: "button", class: "btn small", onclick: () => runSpec(it.spec) }, "Ripeti"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => { applySpec(it.spec); switchTab("search"); updatePreview(); } }, "Apri")));
    }
  }
  async function clearHistory() {
    if (!confirm("Svuotare tutta la cronologia delle ricerche?")) return;
    await api("/api/history", { method: "DELETE" });
    renderHistory();
  }

  // ------------------------------------------------------------------ diagnostica
  function pretty(el, data) {
    el.hidden = false;
    el.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }
  async function renderDiag() {
    try { pretty($("#diag-info"), await api("/api/diag")); } catch (e) { pretty($("#diag-info"), e.message); }
  }
  async function diagCurl(e) {
    e.preventDefault();
    const save = e.submitter && e.submitter.dataset.save === "1";
    try {
      const r = await api("/api/diag/import-curl", { method: "POST", body: { curl: $("#diag-curl").value, keyword: $("#diag-keyword").value, save } });
      pretty($("#diag-curl-out"), r);
      if (r.saved) { toast("Modello di richiesta salvato"); renderDiag(); }
    } catch (err) { pretty($("#diag-curl-out"), err.message); }
  }
  async function diagRaw(e) {
    e.preventDefault();
    pretty($("#diag-raw-out"), "Richiesta in corso…");
    try {
      const r = await api("/api/diag/raw", { method: "POST", body: { query: $("#diag-query").value, core: $("#core").value, area: $("#area").value, langs: $("#langs").value } });
      if (r.raw && r.raw.length > 30000) r.raw = r.raw.slice(0, 30000) + "…";
      pretty($("#diag-raw-out"), r);
    } catch (err) { pretty($("#diag-raw-out"), err.message); }
  }
  async function diagTemplateDelete() {
    try { await api("/api/diag/template", { method: "DELETE" }); toast("Modello rimosso"); renderDiag(); } catch (err) { toast(err.message); }
  }

  // ------------------------------------------------------------------ navigazione
  function switchTab(tab) {
    $$("#nav button").forEach((b) => b.toggleAttribute("aria-current", false));
    const btn = $(`#nav button[data-tab="${tab}"]`);
    if (btn) btn.setAttribute("aria-current", "page");
    for (const sec of $$(".tab")) sec.hidden = sec.id !== `tab-${tab}`;
    if (tab === "saved") renderSaved();
    else if (tab === "history") renderHistory();
    else if (tab === "favorites") renderFavorites();
    else if (tab === "diag") renderDiag();
    else if (tab === "search") render();
  }

  async function logout() {
    try { await api("/api/logout", { method: "POST", noAuthRedirect: true }); } catch { /* */ }
    state.me = null;
    state.results = [];
    history.replaceState(null, "", location.pathname);
    showLogin("");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
