// Pannello dei filtri.

import { h, clear, icon } from "./dom.js";
import { STATUS_GROUPS, STATUSES, statusesOfGroup, PRIORITIES } from "../lib/statuses.js";
import { isoDay, debounce } from "../lib/util.js";
import { DEF, ruleFor } from "../lib/filters.js";

/** Casella con suggerimenti e valori scelti come "gettoni" */
function tokenInput({ values, onChange, search, placeholder }) {
  let items = values.slice();
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
  }, 220);
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
    apply.cancel(); // altrimenti la stessa ricerca ripartirebbe dopo 600 ms
    ctx.setFilter(key, inp.value, true);
  });
  return inp;
}

function dateRange(ctx, kFrom, kTo, presets) {
  const f = ctx.S.filters;
  const a = h("input", { class: "input", type: "date", value: f[kFrom] || "", "aria-label": "dal" });
  const b = h("input", { class: "input", type: "date", value: f[kTo] || "", "aria-label": "al" });
  // Chrome manda "change" a ogni cifra dell'anno: si cerca solo con una data completa (anno 1990-2099) o vuota
  const okDay = (v) => !v || /^(19[89]\d|20\d\d)-\d\d-\d\d$/.test(v);
  a.addEventListener("change", () => okDay(a.value) && a.value !== (ctx.S.filters[kFrom] || "") && ctx.setFilter(kFrom, a.value));
  b.addEventListener("change", () => okDay(b.value) && b.value !== (ctx.S.filters[kTo] || "") && ctx.setFilter(kTo, b.value));
  const now = new Date();
  const P = {
    "7 giorni": () => [isoDay(new Date(now.getTime() - 7 * 864e5)), ""],
    "30 giorni": () => [isoDay(new Date(now.getTime() - 30 * 864e5)), ""],
    "12 mesi": () => [isoDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())), ""],
    "Quest'anno": () => [`${now.getFullYear()}-01-01`, ""],
    "Anno scorso": () => [`${now.getFullYear() - 1}-01-01`, `${now.getFullYear() - 1}-12-31`],
  };
  return h("div", null,
    h("div", { class: "row2" }, a, b),
    presets ? h("div", { class: "presets" },
      Object.entries(P).map(([name, fn]) => h("button", { type: "button", class: "preset", onclick: () => { const [x, y] = fn(); ctx.setFilters({ [kFrom]: x, [kTo]: y }); } }, name)),
      f[kFrom] || f[kTo] ? h("button", { type: "button", class: "preset", onclick: () => ctx.setFilters({ [kFrom]: "", [kTo]: "" }) }, "Qualsiasi") : null) : null);
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
  // avviso discreto se il filtro non è ancora verificato sul portale
  const r = ruleFor(DEF[key], ctx.S.calib);
  if (r.source === "predefinito") return "Formato da confermare: usalo una volta in Touch e l'estensione lo imparerà.";
  return null;
}

/** Filtri della scheda Storico: quelli della Ricerca avanzata dell'Area Riservata (che non cerca per parole). */
function renderStoricoSidebar(ctx) {
  const f = ctx.S.storico.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = "storico";
  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri dello Storico"), h("button", { class: "linkbtn", onclick: () => ctx.storicoReset() }, "Azzera tutto")));
  el.appendChild(h("div", { class: "side-note src-storico" },
    "Lo Storico è la Ricerca avanzata dell'Area Riservata: contiene tutti i ticket del Vecchio Cruscotto, anche prima del 2024. Non cerca per parole."));

  const text = (key, placeholder, clean = (v) => v.trim()) => {
    const inp = h("input", { class: "input", type: "text", inputmode: key === "number" || key === "clientCode" ? "numeric" : null, value: f[key] || "", placeholder });
    const apply = () => clean(inp.value) !== (f[key] || "") && ctx.storicoSetFilter(key, clean(inp.value));
    inp.addEventListener("change", apply);
    inp.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), apply()));
    return inp;
  };
  const okDay = (v) => v === "" || /^(19[89]\d|20\d\d)-\d\d-\d\d$/.test(v);
  const day = (key, label) => {
    const inp = h("input", { class: "input", type: "date", value: f[key] || "", "aria-label": label });
    inp.addEventListener("change", () => okDay(inp.value) && inp.value !== (f[key] || "") && ctx.storicoSetFilter(key, inp.value));
    return inp;
  };
  const year = new Date().getFullYear();
  const presets = [
    ["Fino al 2023", { dateFrom: "", dateTo: "2023-12-31" }],
    ...[2023, 2022, 2021, 2020].map((y) => [String(y), { dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` }]),
    ["Tutti gli anni", { dateFrom: "", dateTo: `${year}-12-31` }],
  ];
  const one = (v) => (v ? [v] : []);

  el.appendChild(h("div", { class: "fbody plain" },
    field("Numero ticket", text("number", "es. 5123456", (v) => v.replace(/\D/g, ""))),
    field("Periodo (dal – al)",
      h("div", null,
        h("div", { class: "row2" }, day("dateFrom", "dal"), day("dateTo", "al")),
        h("div", { class: "presets" }, presets.map(([name, val]) =>
          h("button", { type: "button", class: "preset" + (f.dateFrom === val.dateFrom && f.dateTo === val.dateTo ? " on" : ""), onclick: () => ctx.storicoSetFilter(val) }, name))))),
    field("Il periodo si riferisce a", h("div", { class: "seg" },
      [["1", "Ultimo aggiornamento"], ["2", "Apertura"]].map(([v, name]) =>
        h("button", { type: "button", class: "preset" + ((f.dateRef || "1") === v ? " on" : ""), onclick: () => (f.dateRef || "1") !== v && ctx.storicoSetFilter("dateRef", v) }, name)))),
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
    }), "Si possono scegliere gli operatori già comparsi nei risultati dello Storico.")));
}

export function renderSidebar(ctx) {
  const { S, ui } = ctx;
  if (S.tab === "storico") return renderStoricoSidebar(ctx);
  const f = S.filters;
  const el = clear(document.getElementById("sidebar"));
  el.dataset.source = S.tab === "ar" ? "ar" : "touch";
  const n = (...keys) => keys.reduce((a, k) => a + (Array.isArray(f[k]) ? f[k].length : f[k] ? 1 : 0), 0);

  el.appendChild(h("div", { class: "side-head" }, h("h2", null, "Filtri"), h("button", { class: "linkbtn", onclick: () => ctx.resetFilters() }, "Azzera tutto")));
  if (S.tab === "ar") {
    el.appendChild(h("div", { class: "side-note src-ar" },
      "Nel Vecchio Cruscotto valgono le parole della casella in alto, «L'oggetto contiene», la data di apertura e il Gruppo di lavoro. Gli altri filtri esistono solo in HDA Touch."));
  }

  if (S.saved.length) {
    el.appendChild(section("saved", "Ricerche salvate", 0, ui.openSections.saved ?? true,
      h("div", { class: "presets" }, S.saved.map((s, i) => h("span", { class: "chip" },
        h("span", { style: { cursor: "pointer" }, title: "Applica", onclick: () => ctx.applySaved(i) }, s.name),
        h("button", { title: "Elimina", onclick: () => ctx.deleteSaved(i) }, "×")))), ctx));
  }

  el.appendChild(section("status", "Stato", n("statuses"), ui.openSections.status ?? true, statusBlock(ctx), ctx));

  const me = ctx.hda.currentUserId;
  el.appendChild(section("people", "Gruppi e persone", n("ownerGroups", "assigned", "ownerUsers", "modifiedBy"), ui.openSections.people ?? true, [
    field("Gruppo di lavoro", tokenInput({ values: f.ownerGroups, placeholder: "es. Paghe Infinity…", onChange: (v) => ctx.setFilter("ownerGroups", v), search: (q) => ctx.lookups.search("groups", q) }),
      "Il «Gruppo owner» del ticket in Touch. Per i ticket assegnati a un gruppo usa «Assegnato a»."),
    field("Assegnato a (operatore o gruppo)", tokenInput({ values: f.assigned, placeholder: "Nome operatore o gruppo…", onChange: (v) => ctx.setFilter("assigned", v), search: (q) => ctx.lookups.search("people", q) }),
      me ? h("button", { type: "button", class: "linkbtn", onclick: () => ctx.setFilter("assigned", [{ id: me, label: ctx.lookups.label("users", me) || "Io" }]) }, "Solo i miei") : null),
    field("Responsabile del ticket", tokenInput({ values: f.ownerUsers, placeholder: "Nome operatore…", onChange: (v) => ctx.setFilter("ownerUsers", v), search: (q) => ctx.lookups.search("users", q) })),
    field("Ultima modifica di", tokenInput({ values: f.modifiedBy, placeholder: "Nome operatore…", onChange: (v) => ctx.setFilter("modifiedBy", v), search: (q) => ctx.lookups.search("users", q) }), uncertain(ctx, "modifiedBy")),
  ], ctx));

  el.appendChild(section("customer", "Cliente e prodotto", n("accounts", "catalog", "classCli"), ui.openSections.customer ?? true, [
    field("Cliente", tokenInput({ values: f.accounts, placeholder: "Ragione sociale o codice…", onChange: (v) => ctx.setFilter("accounts", v), search: (q) => ctx.lookups.search("accounts", q) })),
    field("Prodotto", tokenInput({ values: f.catalog, placeholder: "es. Paghe Infinity…", onChange: (v) => ctx.setFilter("catalog", v), search: (q) => ctx.lookups.search("catalog", q) })),
    field("Classificazione cliente", textField(ctx, "classCli", "es. Pro, Infinity Business Partner"), uncertain(ctx, "classCli")),
  ], ctx));

  el.appendChild(section("dates", "Date", n("dateFrom", "dateTo", "updFrom", "updTo"), ui.openSections.dates ?? true, [
    field("Aperto (dal – al)", dateRange(ctx, "dateFrom", "dateTo", true), uncertain(ctx, "dateFrom")),
    field("Ultimo aggiornamento (dal – al)", dateRange(ctx, "updFrom", "updTo", true), uncertain(ctx, "updFrom")),
  ], ctx));

  // tipi di ticket: quelli visti nei risultati (le descrizioni arrivano dal portale)
  const types = { ...(S.typesSeen || {}) };
  for (const id of f.types) if (!types[id]) types[id] = id;
  const typeEntries = Object.entries(types).sort((a, b) => a[1].localeCompare(b[1]));

  el.appendChild(section("text", "Testo, tipo e priorità", n("subject", "tag", "priorities", "types"), ui.openSections.text ?? false, [
    field("L'oggetto contiene", textField(ctx, "subject", "parole dell'oggetto"), uncertain(ctx, "subject")),
    field("Tag", textField(ctx, "tag", "tag del ticket"), uncertain(ctx, "tag")),
    field("Tipo di ticket", typeEntries.length ? checks(ctx, "types", typeEntries) : h("div", { class: "hint" }, "I tipi compaiono qui dopo la prima ricerca.")),
    field("Priorità", checks(ctx, "priorities", Object.entries(PRIORITIES)), uncertain(ctx, "priorities")),
  ], ctx));

  // filtri visti in Touch e non ancora gestiti dal pannello: si possono riusare così come sono
  const caps = (S.captures || []).filter((c) => c.collection === "Incidents" && c.conditions && c.conditions.some((x) => !x.lock && x.id !== "Domain"));
  if (caps.length) {
    el.appendChild(section("touch", "Filtri usati in Touch", n("touch"), ui.openSections.touch ?? false, [
      h("div", { class: "hint" }, "Le ultime ricerche fatte nel portale. Applicale qui per riusarle con la lettura chiara."),
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
