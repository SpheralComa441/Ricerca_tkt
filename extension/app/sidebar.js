// Pannello dei filtri (Opzione B: visibile di default accanto ai risultati, richiudibile dal tasto Filtri).

import { h, clear, icon } from "./dom.js";
import { STATUS_GROUPS, STATUSES, statusesOfGroup, PRIORITIES } from "../lib/statuses.js";
import { isoDay, debounce } from "../lib/util.js";
import { DEF, ruleFor } from "../lib/filters.js";

/** Casella con suggerimenti e valori scelti come "gettoni" */
function tokenInput({ values, onChange, search, placeholder }) {
  let items = (values || []).slice();
  let opts = [];
  let active = -1;
  let seq = 0;
  const input = h("input", { type: "text", placeholder: items.length ? "" : placeholder, "aria-autocomplete": "list" });
  const box = h("div", { class: "tokens" });
  const sug = h("div", { class: "suggest", hidden: true, role: "listbox" });

  function draw() {
    clear(box);
    for (const it of items) {
      box.appendChild(
        h("span", { class: "token", title: it.label + (it.id ? ` (${it.id})` : "") },
          h("span", null, it.label || it.id),
          h("button", { type: "button", "aria-label": "Togli " + (it.label || it.id), onclick: (e) => { e.stopPropagation(); items = items.filter((x) => x.id !== it.id); draw(); onChange(items); } }, "×")),
      );
    }
    input.placeholder = items.length ? "" : placeholder;
    box.appendChild(input);
    box.appendChild(sug);
  }
  function drawSug(loading) {
    clear(sug);
    // risposta arrivata dopo che si è cliccato altrove: l'elenco non deve riaprirsi da solo
    if (document.activeElement !== input) {
      sug.hidden = true;
      return;
    }
    sug.hidden = false;
    if (loading && !opts.length) {
      sug.appendChild(h("div", { class: "empty" }, "Cerco…"));
      return;
    }
    if (!opts.length) {
      sug.appendChild(h("div", { class: "empty" }, input.value.trim() ? "Nessun risultato" : "Scrivi per cercare"));
      return;
    }
    opts.forEach((o, i) => {
      sug.appendChild(
        h("div", { class: "opt" + (i === active ? " active" : ""), role: "option", onmousedown: (e) => { e.preventDefault(); pick(o); } },
          h("span", null, o.label),
          o.type || o.code || o.city ? h("small", null, [o.type, o.code, o.city].filter(Boolean).join(" · ")) : null),
      );
    });
  }
  function pick(o) {
    if (!items.some((x) => x.id === o.id)) items.push({ id: o.id, label: o.label });
    input.value = "";
    opts = [];
    sug.hidden = true;
    draw();
    onChange(items);
    input.focus();
  }
  const run = debounce(async () => {
    const my = ++seq;
    drawSug(true);
    try {
      const res = await search(input.value.trim());
      if (my !== seq) return;
      opts = res.filter((o) => !items.some((x) => x.id === o.id));
      active = opts.length ? 0 : -1;
      drawSug(false);
    } catch (e) {
      if (my !== seq) return;
      clear(sug).appendChild(h("div", { class: "empty" }, "Errore: " + e.message));
    }
  }, 200);
  input.addEventListener("input", run);
  input.addEventListener("focus", run);
  input.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(opts.length - 1, active + 1); drawSug(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); drawSug(); e.preventDefault(); }
    else if (e.key === "Enter") { if (opts[active]) { pick(opts[active]); e.preventDefault(); } }
    else if (e.key === "Escape") { sug.hidden = true; }
    else if (e.key === "Backspace" && !input.value && items.length) { items.pop(); draw(); onChange(items); }
  });
  box.addEventListener("click", () => input.focus());
  draw();
  return box;
}

function section(id, title, count, open, body, ctx) {
  const d = h("details", { class: "fsec", open: open ? true : null, dataset: { sec: id } },
    h("summary", null, icon("chevron"), title, count ? h("span", { class: "count" }, String(count)) : null),
    h("div", { class: "fbody" }, body));
  d.addEventListener("toggle", () => (ctx.ui.openSections[id] = d.open));
  return d;
}

function field(label, control, hint) {
  return h("div", { class: "field" }, h("div", { class: "flabel" }, label), control, hint ? h("div", { class: "hint" }, hint) : null);
}

function textField(ctx, key, placeholder) {
  const inp = h("input", { class: "input", type: "text", value: ctx.S.filters[key] || "", placeholder });
  const apply = debounce(() => ctx.setFilter(key, inp.value), 600);
  inp.addEventListener("input", apply);
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    apply.cancel();
    ctx.setFilter(key, inp.value, true);
  });
  return inp;
}

function liveTextInput(value, placeholder, onApply, { delay = 500, inputmode = null } = {}) {
  const inp = h("input", { class: "input", type: "text", inputmode, value: value || "", placeholder });
  const apply = debounce(() => onApply(inp.value), delay);
  inp.addEventListener("input", apply);
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    apply.cancel();
    onApply(inp.value, true);
  });
  return inp;
}

const okDay = (v) => !v || /^(19[89]\d|20\d\d)-\d\d-\d\d$/.test(v);

function standardDatePresets() {
  const now = new Date();
  const y = now.getFullYear();
  return [
    ["7 giorni", isoDay(new Date(now.getTime() - 7 * 864e5)), ""],
    ["30 giorni", isoDay(new Date(now.getTime() - 30 * 864e5)), ""],
    ["12 mesi", isoDay(new Date(y - 1, now.getMonth(), now.getDate())), ""],
    ["Quest'anno", `${y}-01-01`, ""],
    ["Anno scorso", `${y - 1}-01-01`, `${y - 1}-12-31`],
  ];
}

function multiPills(selected, options, onChange) {
  const sel = new Set((selected || []).map(String));
  return h("div", { class: "seg" },
    options.map((o) => {
      const id = String(o.id);
      const on = sel.has(id);
      return h("button", {
        type: "button",
        class: "preset" + (on ? " on" : ""),
        "aria-pressed": on ? "true" : "false",
        onclick: () => {
          const next = new Set(sel);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          onChange([...next]);
        },
      }, o.label);
    }));
}

function statusBlock(ctx) {
  const sel = new Set(ctx.S.filters.statuses);
  const groups = h("div", { class: "status-groups" });
  for (const g of STATUS_GROUPS) {
    const ids = statusesOfGroup(g.key);
    const n = ids.filter((i) => sel.has(i)).length;
    const btn = h("button", {
      type: "button",
      class: `sg ${g.key}` + (n === ids.length ? " on" : n ? " on partial" : ""),
      "aria-pressed": n === ids.length ? "true" : "false",
      title: n === ids.length ? "Togli " + g.label : "Mostra solo/aggiungi " + g.label,
      onclick: () => {
        const s = new Set(ctx.S.filters.statuses);
        if (n === ids.length) ids.forEach((i) => s.delete(i));
        else ids.forEach((i) => s.add(i));
        ctx.setFilter("statuses", [...s]);
      },
    }, g.label);
    groups.appendChild(btn);
  }
  const list = h("div", { class: "status-list", hidden: !ctx.ui.statusDetail });
  for (const g of STATUS_GROUPS) {
    list.appendChild(h("h4", null, g.label));
    for (const id of statusesOfGroup(g.key)) {
      const cb = h("input", { type: "checkbox", checked: sel.has(id) ? true : null });
      cb.addEventListener("change", () => {
        const s = new Set(ctx.S.filters.statuses);
        cb.checked ? s.add(id) : s.delete(id);
        ctx.setFilter("statuses", [...s]);
      });
      list.appendChild(h("label", { class: "check" }, cb, STATUSES[id].it));
    }
  }
  const toggle = h("button", { type: "button", class: "linkbtn", onclick: () => { ctx.ui.statusDetail = !ctx.ui.statusDetail; list.hidden = !ctx.ui.statusDetail; toggle.textContent = ctx.ui.statusDetail ? "Nascondi i singoli stati" : "Scegli i singoli stati"; } }, ctx.ui.statusDetail ? "Nascondi i singoli stati" : "Scegli i singoli stati");
  return h("div", null, groups, h("div", { class: "hint", style: { marginTop: "6px" } }, sel.size ? "" : "Nessuno scelto = tutti gli stati, anche i ticket chiusi."), toggle, list);
}

function checks(ctx, key, entries) {
  const sel = new Set(ctx.S.filters[key]);
  return h("div", null, entries.map(([id, label]) => {
    const cb = h("input", { type: "checkbox", checked: sel.has(id) ? true : null });
    cb.addEventListener("change", () => {
      const s = new Set(ctx.S.filters[key]);
      cb.checked ? s.add(id) : s.delete(id);
      ctx.setFilter(key, [...s]);
    });
    return h("label", { class: "check" }, cb, label);
  }));
}

function uncertain(ctx, key) {
  const r = ruleFor(DEF[key], ctx.S.calib);
  if (r.source === "predefinito") return "Formato da confermare: usalo una volta in Touch e l'estensione lo imparerà.";
  return null;
}

/** Filtri della scheda Ricerca avanzata (Area Riservata — archivio completo, non cerca per parole). */
function renderStoricoSidebar(ctx) {
  const f = ctx.S.storico.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = "storico";
  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri Ricerca avanzata"), h("button", { class: "linkbtn", onclick: () => ctx.storicoReset() }, "Azzera tutto")));
  el.appendChild(h("div", { class: "side-note src-storico" },
    "Ricerca avanzata dell'Area Riservata: contiene tutti i ticket storici, anche prima del 2024. Non cerca per parole; scegli il periodo nella barra sopra i risultati."));

  const text = (key, placeholder, clean = (v) => v.trim()) => {
    const inp = h("input", { class: "input", type: "text", inputmode: key === "number" || key === "clientCode" ? "numeric" : null, value: f[key] || "", placeholder });
    const apply = () => clean(inp.value) !== (f[key] || "") && ctx.storicoSetFilter(key, clean(inp.value));
    inp.addEventListener("change", apply);
    inp.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), apply()));
    return inp;
  };
  const one = (v) => (v ? [v] : []);

  el.appendChild(h("div", { class: "fbody plain" },
    field("Numero ticket", text("number", "es. 5123456", (v) => v.replace(/\D/g, ""))),
    field("Stato", h("div", { class: "seg" },
      [["", "Tutti"], ["A", "Aperti"], ["C", "Chiusi"]].map(([v, name]) =>
        h("button", { type: "button", class: "preset" + ((f.statoBase || "") === v ? " on" : ""), onclick: () => (f.statoBase || "") !== v && ctx.storicoSetFilter("statoBase", v) }, name)))),
    field("Cliente (codice)", text("clientCode", "es. 1234", (v) => v.replace(/\D/g, "")), "Il codice del cliente, come nella Ricerca avanzata del portale."),
    field("Gruppo", tokenInput({
      values: one(f.group ? { id: f.group, label: ctx.S.stLookups.groups[f.group] || f.groupLabel || f.group } : null),
      placeholder: "es. Paghe Web P…",
      onChange: (v) => { const g = v[v.length - 1]; ctx.storicoSetFilter({ group: g ? g.id : "", groupLabel: g ? g.label : "" }); },
      search: (q) => ctx.storicoLookup("groups", q),
    })),
    field("Operatore", tokenInput({
      values: one(f.operator),
      placeholder: "Nome operatore…",
      onChange: (v) => ctx.storicoSetFilter("operator", v[v.length - 1] || null),
      search: (q) => ctx.storicoLookup("operators", q),
    }), "Operatori già comparsi nei risultati di Ricerca avanzata.")));
}

/** Filtri della scheda Vecchio Cruscotto: quelli della «Ricerca rapida» dell'Area Riservata. */
function renderArSidebar(ctx) {
  const f = ctx.S.arS.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = "ar";
  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri Vecchio Cruscotto"), h("button", { class: "linkbtn", onclick: () => ctx.arReset() }, "Azzera tutto")));
  el.appendChild(h("div", { class: "side-note src-ar" },
    "Filtri della Ricerca rapida dell'Area Riservata. Le parole si scrivono nella barra in alto e il periodo nella barra sopra i risultati."));

  const seg = (key, options, def) => h("div", { class: "seg" },
    options.map(([v, name]) => h("button", { type: "button", class: "preset" + ((f[key] || def) === v ? " on" : ""), onclick: () => (f[key] || def) !== v && ctx.arSetFilter(key, v) }, name)));
  const one = (v) => (v ? [v] : []);
  const groupField = (key, labelKey, placeholder) => tokenInput({
    values: one(f[key] ? { id: f[key], label: f[labelKey] || ctx.S.stLookups.groups[f[key]] || f[key] } : null),
    placeholder,
    onChange: (v) => { const g = v[v.length - 1]; ctx.arSetFilter({ [key]: g ? g.id : "", [labelKey]: g ? g.label : "" }); },
    search: (q) => ctx.storicoLookup("groups", q),
  });
  const operatorField = (key) => tokenInput({
    values: one(f[key]),
    placeholder: "Nome operatore…",
    onChange: (v) => ctx.arSetFilter(key, v[v.length - 1] || null),
    search: (q) => ctx.storicoLookup("operators", q),
  });
  const client = h("input", { class: "input", type: "text", inputmode: "numeric", value: f.clientCode || "", placeholder: "es. 1234" });
  const applyClient = () => client.value.replace(/\D/g, "") !== (f.clientCode || "") && ctx.arSetFilter("clientCode", client.value.replace(/\D/g, ""));
  client.addEventListener("change", applyClient);
  client.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), applyClient()));

  el.appendChild(h("div", { class: "fbody plain" },
    field("Stato", seg("statoBase", [["", "Tutti"], ["A", "Aperti"], ["C", "Chiusi"]], "")),
    field("Gruppo in carico", groupField("group", "groupLabel", "es. Paghe Infinity…")),
    field("Operatore in carico", operatorField("operator")),
    field("Cliente (codice)", client),
    field("Gruppo partecipante", groupField("groupIn", "groupInLabel", "es. Paghe Infinity - Test…")),
    field("Operatore partecipante", operatorField("operatorIn")),
    field("Dove cercare le parole", seg("searchIn", [["2", "Testo e oggetto"], ["0", "Solo testo"], ["1", "Solo oggetto"]], "2"))));
}

/** Filtri della scheda Knowledge Base (HD Touch — Articoli Knowledge Base). */
function renderKbSidebar(ctx) {
  const f = ctx.S.kbS.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = "kb";
  const ui = ctx.ui;
  const n = (...keys) => keys.reduce((a, k) => a + (Array.isArray(f[k]) ? f[k].length : f[k] ? 1 : 0), 0);

  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri Knowledge Base"), h("button", { class: "linkbtn", onclick: () => ctx.kbReset() }, "Azzera tutto")));
  el.appendChild(h("div", { class: "side-note src-kb" },
    "Articoli Knowledge Base aggiornati di HDA Touch. Scrivi parole o un codice (es. KB25631HR) nella barra in alto, oppure filtra qui sotto."));

  const wild = ctx.S.settings.autoWildcard !== false;
  el.appendChild(h("div", { class: "fbody plain", style: { marginBottom: "10px" } },
    field("Parole della casella in alto",
      h("div", { class: "seg" },
        h("button", { type: "button", class: "preset" + (wild ? " on" : ""), onclick: () => ctx.setAutoWildcard(true) }, "Con varianti (*)"),
        h("button", { type: "button", class: "preset" + (!wild ? " on" : ""), onclick: () => ctx.setAutoWildcard(false) }, "Esatte")))));

  const kbStatuses = ctx.kb ? ctx.kb.statuses : [];
  const kbTypes = ctx.kb ? ctx.kb.types : [];
  const kbLanguages = ctx.kb ? ctx.kb.languages : [];

  el.appendChild(section("kbStatus", "Stato, tipo e allegati", n("statuses", "types", "hasAttachments"), ui.openSections.kbStatus ?? true, [
    field("Stato", multiPills(f.statuses, kbStatuses, (v) => ctx.kbSetFilter("statuses", v)),
      f.statuses.length ? null : "Nessuno scelto = tutti gli stati."),
    field("Tipo", multiPills(f.types, kbTypes, (v) => ctx.kbSetFilter("types", v))),
    field("Allegati", h("div", { class: "seg" },
      [["", "Tutti"], ["true", "Con allegati"], ["false", "Senza allegati"]].map(([v, label]) =>
        h("button", { type: "button", class: "preset" + ((f.hasAttachments || "") === v ? " on" : ""), onclick: () => (f.hasAttachments || "") !== v && ctx.kbSetFilter("hasAttachments", v) }, label)))),
  ], ctx));

  el.appendChild(section("kbClass", "Prodotto e classificazione", n("products", "version", "topics", "folders"), ui.openSections.kbClass ?? true, [
    field("Prodotto", tokenInput({
      values: f.products,
      placeholder: "es. Paghe Infinity…",
      onChange: (v) => ctx.kbSetFilter("products", v),
      search: (q) => ctx.lookups.search("services", q),
    })),
    field("Versione Prodotto", liveTextInput(f.version, "es. 26.12.00", (v) => ctx.kbSetFilter("version", v))),
    field("Argomento", tokenInput({
      values: f.topics,
      placeholder: "Cerca argomento…",
      onChange: (v) => ctx.kbSetFilter("topics", v),
      search: (q) => ctx.lookups.search("catalogItems", q),
    })),
    field("Cartella", tokenInput({
      values: f.folders,
      placeholder: "es. HR › Paghe…",
      onChange: (v) => ctx.kbSetFilter("folders", v),
      search: (q) => ctx.lookups.search("catalogFolders", q),
    })),
  ], ctx));

  el.appendChild(section("kbText", "Titolo, codice e lingua", n("title", "code", "languages"), ui.openSections.kbText ?? false, [
    field("Titolo contiene", liveTextInput(f.title, "parole del titolo…", (v) => ctx.kbSetFilter("title", v))),
    field("Codice articolo", liveTextInput(f.code, "es. KB25631HR", (v) => ctx.kbSetFilter("code", v))),
    field("Lingua", multiPills(f.languages, kbLanguages.slice(0, 8), (v) => ctx.kbSetFilter("languages", v))),
  ], ctx));
}

/** Filtri della scheda FAQ (HD Touch — Faqs; Categoria e Tags omessi perché non funzionanti in Touch). */
function renderFaqSidebar(ctx) {
  const f = ctx.S.faqS.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = "faq";
  const ui = ctx.ui;
  const n = (...keys) => keys.reduce((a, k) => a + (Array.isArray(f[k]) ? f[k].length : String(f[k] ?? "").trim() !== "" ? 1 : 0), 0);

  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri FAQ"), h("button", { class: "linkbtn", onclick: () => ctx.faqReset() }, "Azzera tutto")));
  el.appendChild(h("div", { class: "side-note src-faq" },
    "La barra in alto cerca in Domanda e Risposta insieme (con più parole, singolare/plurale e attinenza). Qui sotto trovi anche i campi separati di HD Touch."));

  const faqStatuses = ctx.faq ? ctx.faq.statuses : [];

  el.appendChild(section("faqText", "Domanda, Risposta e Codice", n("question", "answer", "code"), ui.openSections.faqText ?? true, [
    field("Domanda", liveTextInput(f.question, "Parole nella domanda…", (v) => ctx.faqSetFilter("question", v)),
      "Filtro separato di HD Touch sul campo Domanda."),
    field("Risposta", liveTextInput(f.answer, "Parole nella risposta…", (v) => ctx.faqSetFilter("answer", v)),
      "Filtro separato di HD Touch sul campo Risposta."),
    field("Codice", liveTextInput(f.code, "es. FAQ25598HR", (v) => ctx.faqSetFilter("code", v))),
  ], ctx));

  el.appendChild(section("faqClass", "Stato, cartella e catalogo", n("statuses", "folders", "catalogItems", "importance"), ui.openSections.faqClass ?? true, [
    field("Stato", multiPills(f.statuses, faqStatuses, (v) => ctx.faqSetFilter("statuses", v)),
      f.statuses.length ? null : "Nessuno scelto = tutti gli stati."),
    field("Cartella", tokenInput({
      values: f.folders,
      placeholder: "es. HR › Paghe…",
      onChange: (v) => ctx.faqSetFilter("folders", v),
      search: (q) => ctx.lookups.search("catalogFolders", q),
    })),
    field("Elemento di catalogo", tokenInput({
      values: f.catalogItems,
      placeholder: "Cerca elemento…",
      onChange: (v) => ctx.faqSetFilter("catalogItems", v),
      search: (q) => ctx.lookups.search("catalogItems", q),
    })),
    field("Importanza (minima)", (() => {
      const inp = h("input", { class: "input", type: "number", min: "0", step: "1", value: f.importance ?? "", placeholder: "es. 1" });
      const apply = debounce(() => ctx.faqSetFilter("importance", inp.value.trim()), 450);
      inp.addEventListener("input", apply);
      inp.addEventListener("change", () => { apply.cancel(); ctx.faqSetFilter("importance", inp.value.trim()); });
      return inp;
    })()),
  ], ctx));
}

export function renderSidebar(ctx) {
  const { S, ui } = ctx;
  if (S.source === "storico") return renderStoricoSidebar(ctx);
  if (S.source === "ar") return renderArSidebar(ctx);
  if (S.source === "kb") return renderKbSidebar(ctx);
  if (S.source === "faq") return renderFaqSidebar(ctx);

  const f = S.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = "touch";
  const n = (...keys) => keys.reduce((a, k) => a + (Array.isArray(f[k]) ? f[k].length : f[k] ? 1 : 0), 0);

  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri HDA Touch"), h("button", { class: "linkbtn", onclick: () => ctx.resetFilters() }, "Azzera tutto")));
  if (S.saved.length) {
    el.appendChild(section("saved", "Ricerche salvate", 0, ui.openSections.saved ?? true,
      h("div", { class: "presets" }, S.saved.map((s, i) => h("span", { class: "chip" },
        h("span", { style: { cursor: "pointer" }, title: "Applica", onclick: () => ctx.applySaved(i) }, s.name),
        h("button", { title: "Elimina", onclick: () => ctx.deleteSaved(i) }, "×")))), ctx));
  }

  const wild = S.settings.autoWildcard !== false;
  el.appendChild(h("div", { class: "fbody plain", style: { marginBottom: "10px" } },
    field("Parole della casella in alto",
      h("div", { class: "seg" },
        h("button", { type: "button", class: "preset" + (wild ? " on" : ""), title: "Ogni parola vale anche al plurale e per le parole che iniziano allo stesso modo: «centro di costo» si cerca come «centr* di cost*»", onclick: () => ctx.setAutoWildcard(true) }, "Con varianti (*)"),
        h("button", { type: "button", class: "preset" + (!wild ? " on" : ""), title: "Le parole si cercano scritte esattamente così. Puoi sempre mettere l'asterisco a mano dove serve.", onclick: () => ctx.setAutoWildcard(false) }, "Esatte")),
      wild ? "L'asterisco lo mette l'app: «centro di costo» → centr* di cost*." : "Si cercano le parole esatte. Puoi mettere l'asterisco a mano.")));

  el.appendChild(section("status", "Stato", n("statuses"), ui.openSections.status ?? true, statusBlock(ctx), ctx));

  const me = ctx.hda.currentUserId;
  el.appendChild(section("people", "Gruppi e persone", n("ownerGroups", "assigned", "ownerUsers", "modifiedBy"), ui.openSections.people ?? true, [
    field("Gruppo di lavoro (Gruppo owner)", tokenInput({ values: f.ownerGroups, placeholder: "es. Paghe Infinity…", onChange: (v) => ctx.setFilter("ownerGroups", v), search: (q) => ctx.lookups.search("groups", q) }),
      "Il «Gruppo owner» del ticket in Touch."),
    field("Assegnato a (in carico ora)", tokenInput({ values: f.assigned, placeholder: "Operatore o gruppo…", onChange: (v) => ctx.setFilter("assigned", v), search: (q) => ctx.lookups.search("people", q) }),
      h("div", { class: "hint-row" },
        h("span", null, "Chi ha in lavorazione il ticket adesso (operatore o gruppo)."),
        me ? h("button", { type: "button", class: "linkbtn", onclick: () => ctx.setFilter("assigned", [{ id: me, label: ctx.lookups.label("users", me) || "Io" }]) }, "Solo i miei") : null)),
    field("Owner del ticket (titolare)", tokenInput({ values: f.ownerUsers, placeholder: "Operatore owner…", onChange: (v) => ctx.setFilter("ownerUsers", v), search: (q) => ctx.lookups.search("users", q) }),
      "L'operatore «Owner» titolare del ticket in Touch (può differire da Assegnato a se il ticket è stato girato)."),
    field("Modificato da", tokenInput({ values: f.modifiedBy, placeholder: "Nome operatore…", onChange: (v) => ctx.setFilter("modifiedBy", v), search: (q) => ctx.lookups.search("users", q) }),
      uncertain(ctx, "modifiedBy") || "Operatore che ha modificato o lavorato il ticket."),
  ], ctx));

  el.appendChild(section("customer", "Cliente e prodotto", n("accounts", "catalog", "classCli"), ui.openSections.customer ?? true, [
    field("Cliente", tokenInput({ values: f.accounts, placeholder: "Ragione sociale o codice…", onChange: (v) => ctx.setFilter("accounts", v), search: (q) => ctx.lookups.search("accounts", q) })),
    field("Prodotto", tokenInput({ values: f.catalog, placeholder: "es. Paghe Infinity…", onChange: (v) => ctx.setFilter("catalog", v), search: (q) => ctx.lookups.search("catalog", q) })),
    field("Classificazione cliente", textField(ctx, "classCli", "es. Pro, Infinity Business Partner"), uncertain(ctx, "classCli")),
  ], ctx));

  const types = { ...(S.typesSeen || {}) };
  for (const id of f.types) if (!types[id]) types[id] = id;
  const typeEntries = Object.entries(types).sort((a, b) => a[1].localeCompare(b[1]));

  el.appendChild(section("text", "Testo, tipo e priorità", n("subject", "tag", "priorities", "types"), ui.openSections.text ?? false, [
    field("L'oggetto contiene", textField(ctx, "subject", "parole dell'oggetto"), uncertain(ctx, "subject")),
    field("Tag", textField(ctx, "tag", "tag del ticket"), uncertain(ctx, "tag")),
    field("Tipo di ticket", typeEntries.length ? checks(ctx, "types", typeEntries) : h("div", { class: "hint" }, "I tipi compaiono qui dopo la prima ricerca.")),
    field("Priorità", checks(ctx, "priorities", Object.entries(PRIORITIES)), uncertain(ctx, "priorities")),
  ], ctx));

  const caps = (S.captures || []).filter((c) => c.collection === "Incidents" && c.conditions && c.conditions.some((x) => !x.lock && x.id !== "Domain"));
  if (caps.length) {
    el.appendChild(section("touch", "Filtri usati in Touch", n("touch"), ui.openSections.touch ?? false, [
      h("div", { class: "hint" }, "Le ultime ricerche fatte nel portale."),
      h("div", { class: "learned" }, caps.slice(0, 6).map((c) => {
        const conds = c.conditions.filter((x) => !x.lock && x.id !== "Domain");
        return h("div", { class: "lrow" },
          h("code", null, conds.map((x) => `${x.id || x.property} ${x.op} ${String(x.value).slice(0, 40)}`).join(" · ")),
          h("div", null, h("button", { class: "btn btn-small", onclick: () => ctx.setFilter("touch", conds) }, "Applica"), " ",
            h("span", { class: "hint" }, new Date(c.at).toLocaleString("it-IT"))));
      })),
      f.touch.length ? h("button", { class: "linkbtn", onclick: () => ctx.setFilter("touch", []) }, "Togli i filtri di Touch") : null,
    ], ctx));
  }
}

/** Barra compatta dei filtri Date posizionata subito sopra l'elenco dei risultati per ogni fonte. */
export function renderDateBar(ctx) {
  const el = document.getElementById("dateBar");
  if (!el) return;
  const { S, ui } = ctx;
  if (S.solo || S.view !== "results") {
    el.hidden = true;
    clear(el);
    return;
  }

  clear(el);
  el.hidden = false;
  el.dataset.source = S.source;

  const makeDayInput = (val, label, onVal) => {
    const inp = h("input", { class: "input db-date", type: "date", value: val || "", "aria-label": label, title: label });
    inp.addEventListener("change", () => okDay(inp.value) && inp.value !== (val || "") && onVal(inp.value));
    return inp;
  };

  const makeRangeControls = (fromVal, toVal, onSet, presets, { showClear = true, clearLabel = "Qualsiasi" } = {}) => {
    const inputs = h("div", { class: "db-range" },
      makeDayInput(fromVal, "Dal", (v) => onSet(v, toVal)),
      h("span", { class: "db-dash", "aria-hidden": "true" }, "–"),
      makeDayInput(toVal, "Al", (v) => onSet(fromVal, v)));
    const pills = h("div", { class: "db-presets" },
      presets.map(([name, a, b]) => {
        const active = (fromVal || "") === (a || "") && (toVal || "") === (b || "");
        return h("button", { type: "button", class: "preset" + (active ? " on" : ""), onclick: () => onSet(a, b) }, name);
      }),
      showClear && (fromVal || toVal)
        ? h("button", { type: "button", class: "preset db-clear", title: "Rimuovi filtro data", onclick: () => onSet("", "") }, clearLabel)
        : null);
    return [inputs, pills];
  };

  if (S.source === "touch") {
    const f = S.filters;
    const mode = ui.touchDateMode === "updated" ? "updated" : "open";
    const hasOpen = !!(f.dateFrom || f.dateTo);
    const hasUpd = !!(f.updFrom || f.updTo);
    const kFrom = mode === "updated" ? "updFrom" : "dateFrom";
    const kTo = mode === "updated" ? "updTo" : "dateTo";
    const seg = h("div", { class: "db-seg", role: "group", "aria-label": "Campo data HDA Touch" },
      h("button", {
        type: "button",
        class: "db-seg-btn" + (mode === "open" ? " on" : ""),
        onclick: () => { ui.touchDateMode = "open"; renderDateBar(ctx); },
      }, "Aperto", hasOpen ? h("span", { class: "db-dot", title: "Filtro attivo su Aperto" }) : null),
      h("button", {
        type: "button",
        class: "db-seg-btn" + (mode === "updated" ? " on" : ""),
        onclick: () => { ui.touchDateMode = "updated"; renderDateBar(ctx); },
      }, "Aggiornato", hasUpd ? h("span", { class: "db-dot", title: "Filtro attivo su Ultimo aggiornamento" }) : null));
    const [inputs, pills] = makeRangeControls(
      f[kFrom],
      f[kTo],
      (a, b) => ctx.setFilters({ [kFrom]: a, [kTo]: b }),
      standardDatePresets(),
    );
    el.append(h("span", { class: "db-lbl" }, icon("calendar")), seg, inputs, pills);
    return;
  }

  if (S.source === "ar") {
    const f = S.arS.filters;
    const now = new Date();
    const y = now.getFullYear();
    const p2 = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const presets = [
      ["Ultimi 3 mesi", iso(new Date(y, now.getMonth() - 2, 1)), iso(new Date(y, now.getMonth() + 1, 0))],
      [String(y), `${y}-01-01`, `${y}-12-31`],
      [String(y - 1), `${y - 1}-01-01`, `${y - 1}-12-31`],
      ["Tutto", "", ""],
    ];
    const ref = f.dateRef || "1";
    const seg = h("div", { class: "db-seg", role: "group", "aria-label": "Riferimento periodo" },
      [["1", "Ultimo aggiornamento"], ["2", "Apertura"]].map(([v, name]) =>
        h("button", { type: "button", class: "db-seg-btn" + (ref === v ? " on" : ""), onclick: () => ref !== v && ctx.arSetFilter("dateRef", v) }, name)));
    const [inputs, pills] = makeRangeControls(
      f.dateFrom,
      f.dateTo,
      (a, b) => ctx.arSetFilter({ dateFrom: a, dateTo: b }),
      presets,
      { showClear: false },
    );
    el.append(h("span", { class: "db-lbl", title: "Il portale ragiona a mesi interi" }, icon("calendar")), seg, inputs, pills);
    return;
  }

  if (S.source === "storico") {
    const f = S.storico.filters;
    const year = new Date().getFullYear();
    const presets = [
      ["Fino al 2023", "", "2023-12-31"],
      ...[2023, 2022, 2021, 2020].map((y) => [String(y), `${y}-01-01`, `${y}-12-31`]),
      ["Tutti gli anni", "", `${year}-12-31`],
    ];
    const ref = f.dateRef || "1";
    const seg = h("div", { class: "db-seg", role: "group", "aria-label": "Riferimento periodo" },
      [["1", "Ultimo aggiornamento"], ["2", "Apertura"]].map(([v, name]) =>
        h("button", { type: "button", class: "db-seg-btn" + (ref === v ? " on" : ""), onclick: () => ref !== v && ctx.storicoSetFilter("dateRef", v) }, name)));
    const [inputs, pills] = makeRangeControls(
      f.dateFrom,
      f.dateTo,
      (a, b) => ctx.storicoSetFilter({ dateFrom: a, dateTo: b }),
      presets,
      { showClear: false },
    );
    el.append(h("span", { class: "db-lbl" }, icon("calendar")), seg, inputs, pills);
    return;
  }

  if (S.source === "kb") {
    const f = S.kbS.filters;
    const [inputs, pills] = makeRangeControls(
      f.dateFrom,
      f.dateTo,
      (a, b) => ctx.kbSetFilter({ dateFrom: a, dateTo: b }),
      standardDatePresets(),
    );
    el.append(h("span", { class: "db-lbl" }, icon("calendar"), h("span", null, "Creato")), inputs, pills);
    return;
  }

  if (S.source === "faq") {
    const f = S.faqS.filters;
    const [inputs, pills] = makeRangeControls(
      f.dateFrom,
      f.dateTo,
      (a, b) => ctx.faqSetFilter({ dateFrom: a, dateTo: b }),
      standardDatePresets(),
    );
    const statusDate = makeDayInput(f.statusDateFrom, "Data cambio stato da", (v) => ctx.faqSetFilter("statusDateFrom", v));
    const statusGroup = h("div", { class: "db-extra" },
      h("span", { class: "db-lbl" }, icon("calendar"), h("span", null, "Cambio stato da")),
      statusDate,
      f.statusDateFrom ? h("button", { type: "button", class: "preset db-clear", title: "Togli data cambio stato", onclick: () => ctx.faqSetFilter("statusDateFrom", "") }, "×") : null);
    el.append(h("span", { class: "db-lbl" }, icon("calendar"), h("span", null, "Creata")), inputs, pills, statusGroup);
  }
}
