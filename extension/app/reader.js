// Lettore del ticket: intestazione, scheda dei dati, timeline unica della conversazione.

import { h, clear, icon, highlight, toast } from "./dom.js";
import { fmtDateTime, fmtDate, ticketNumber, tokens, isLegacyTicketNumber } from "../lib/util.js";
import { statusInfo } from "../lib/statuses.js";
import { sanitizeHtml, textToFragment, splitQuoted, htmlToText } from "../lib/richtext.js";
import { timelineText } from "../lib/ticket.js";

const ROLE_LABEL = { customer: "Cliente", operator: "Operatore", system: "Sistema" };

function pill(statusId, text) {
  const s = statusInfo(statusId, text);
  return h("span", { class: `pill ${s.group}`, title: statusId || "" }, s.label);
}

export function renderReaderLoading(ctx, id, row) {
  const el = document.getElementById("reader");
  el.hidden = false;
  clear(el);
  el.appendChild(header(ctx, id, row, null));
  const body = h("div", { class: "rd-body" }, row ? facts(row, null) : null, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Carico la conversazione completa…"));
  el.appendChild(body);
  el.scrollTop = 0;
}

export function renderReaderError(ctx, id, row, err) {
  const el = document.getElementById("reader");
  const body = el.querySelector(".rd-body") || el.appendChild(h("div", { class: "rd-body" }));
  const ld = body.querySelector(".loading");
  if (ld) ld.remove();
  const isLegacy = (err && err.isLegacyTicket) || isLegacyTicketNumber(id) || (row && row.source === "ar");
  const num = ticketNumber(id);
  body.appendChild(
    h("div", { class: "err-box" },
      "Non riesco a leggere il ticket: " + err.message,
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } },
        isLegacy && ctx.openArHome
          ? h("button", { class: "btn btn-primary", onclick: () => ctx.openArHome(row && row.arUrl) }, icon("external"), "Apri e collega Vecchio Cruscotto")
          : null,
        isLegacy && ctx.searchLegacyRefInTouch
          ? h("button", { class: "btn", onclick: () => ctx.searchLegacyRefInTouch(num) }, `Cerca #${num} nei ticket Touch`)
          : null,
        h("button", { class: "btn", onclick: () => ctx.openTicket(id, row, { force: true }) }, "Riprova")))
  );
}

function header(ctx, id, row, full) {
  const fav = ctx.isFavorite(id);
  const isAr = (row && row.source === "ar") || (full && full.source === "ar");
  const arUrl = (full && full.arUrl) || (row && row.arUrl) || "";
  const favBtn = h("button", { class: "btn btn-icon" + (fav ? " star-on" : ""), title: fav ? "Togli dai preferiti" : "Aggiungi ai preferiti", onclick: () => { ctx.toggleFavorite(id, row); favBtn.classList.toggle("star-on"); } }, icon("star"));
  return h("div", { class: "rd-head" },
    h("div", { class: "rd-top" },
      h("span", { class: "rd-num", title: "Copia il numero", onclick: () => { navigator.clipboard.writeText(ticketNumber(id)); toast("Numero copiato", "ok", 1500); } }, "#" + ticketNumber(id)),
      row ? pill(row.statusId, row.statusText) : null,
      row && row.typeText ? h("span", { class: "tag-mini" }, row.typeText) : null,
      h("div", { class: "rd-actions" },
        favBtn,
        full ? h("button", { class: "btn", title: "Copia tutto il ticket come testo", onclick: () => { navigator.clipboard.writeText(timelineText(full.timeline, `Ticket ${ticketNumber(id)} — ${row ? row.subject : ""}`)); toast("Ticket copiato negli appunti", "ok", 1800); } }, icon("copy"), "Copia") : null,
        isAr
          ? h("button", { class: "btn", title: "Apri questo ticket nel Vecchio Cruscotto (Area Riservata)", onclick: () => ctx.openArHome && ctx.openArHome(arUrl) }, icon("external"), "Apri nel vecchio cruscotto")
          : h("button", { class: "btn", title: "Apri questo ticket in HDA TOUCH", onclick: () => ctx.openInTouch(id) }, icon("external"), "Apri in Touch"),
        h("button", { class: "btn btn-icon", title: "Chiudi (Esc)", onclick: () => ctx.closeReader() }, icon("close")))),
    h("h1", { class: "rd-title" }, (row && row.subject) || (full && full.ticket && full.ticket.Subject) || "Ticket " + ticketNumber(id)));
}

function facts(row, ticket, extraFacts = []) {
  const t = ticket || {};
  const F = [
    ["Cliente", [row.account, row.customerCode ? `(cod. ${row.customerCode})` : ""].filter(Boolean).join(" ")],
    ["Contatto", [row.contact, t.TKMAILTO ? `‹${t.TKMAILTO}›` : ""].filter(Boolean).join(" ")],
    ["Gruppo", row.ownerGroup],
    ["Assegnato a", row.assigned],
    ["Responsabile", row.ownerUser],
    ["Prodotto", t.CTITMDESC || row.catalog],
    ["Classificazione", row.classCli],
    ["Priorità", row.priorityText],
    ["Aperto il", fmtDateTime(row.date || t.Date)],
    ["Ultimo aggiornamento", fmtDateTime(row.lastChange || t.LastChange)],
    ["Chiuso il", fmtDateTime(t.ClosureDate || row.closureDate)],
    ["Scadenza SLA", row.nextExpiration && statusInfo(row.statusId).group !== "closed" ? `${fmtDateTime(row.nextExpiration)}${row.sla ? " · " + row.sla : ""}` : ""],
    ...(extraFacts || []),
  ].filter(([, v]) => v && String(v).trim());
  return h("dl", { class: "facts" }, F.map(([k, v]) => h("div", { class: "fact" }, h("dt", null, k), h("dd", null, v))));
}

function bodyOf(entry) {
  const box = h("div", { class: "msg-b" });
  if (entry.html) {
    box.appendChild(sanitizeHtml(entry.html));
    return box;
  }
  const { main, quoted } = splitQuoted(entry.text);
  box.appendChild(textToFragment(main));
  if (quoted) {
    const q = h("div", { class: "quoted", hidden: true }, textToFragment(quoted));
    const btn = h("button", { class: "linkbtn quoted-toggle", onclick: () => { q.hidden = !q.hidden; btn.textContent = q.hidden ? "Mostra il testo citato" : "Nascondi il testo citato"; } }, "Mostra il testo citato");
    box.appendChild(btn);
    box.appendChild(q);
  }
  return box;
}

function entryEl(e) {
  let cls = "msg " + (e.role || "operator");
  let role = ROLE_LABEL[e.role] || "Operatore";
  if (e.kind === "request") { cls += " request customer"; role = "Richiesta iniziale"; }
  if (e.kind === "solution") { cls = "msg solution"; role = "Soluzione"; }
  if (e.internal) { cls += " internal"; role = "Nota interna"; }
  const who = e.author || (e.kind === "request" ? "Cliente" : "");
  return h("article", { class: cls, dataset: { internal: e.internal ? "1" : "0" } },
    h("div", { class: "msg-card" },
      h("div", { class: "msg-h" },
        h("span", { class: "role" }, role),
        who ? h("span", { class: "who" }, who) : null,
        e.role === "customer" && e.account && e.account !== who ? h("span", { class: "hint" }, e.account) : null,
        e.internal ? h("span", { class: "tag-mini", title: "Non visibile al cliente" }, icon("lock"), " interna") : null,
        h("span", { class: "at", title: e.date ? e.date.toLocaleString("it-IT") : "" }, fmtDateTime(e.date))),
      bodyOf(e),
      e.truncated ? h("div", { class: "trunc" }, "Testo troncato dal portale: aprilo in Touch per leggerlo tutto.") : null,
      e.attachments ? h("div", { class: "msg-f" }, icon("clip"), `${e.attachments} allegat${e.attachments === 1 ? "o" : "i"} (si scaricano da Touch)`) : null));
}

export function renderReader(ctx, full, { fromArchive = null } = {}) {
  const el = document.getElementById("reader");
  el.hidden = false;
  const keepScroll = el.dataset.id === full.id ? el.scrollTop : 0;
  el.dataset.id = full.id;
  clear(el);
  const row = full.row || { id: full.id };
  el.appendChild(header(ctx, full.id, row, full));

  const body = h("div", { class: "rd-body" });
  el.appendChild(body);
  body.appendChild(facts(row, full.ticket, full.extraFacts));
  if (fromArchive) body.appendChild(h("div", { class: "rd-note" }, `Copia salvata nell'archivio locale il ${fmtDate(fromArchive)}: il portale non ha risposto.`));
  for (const n of full.notes || []) body.appendChild(h("div", { class: "rd-note" }, n));

  const ui = ctx.ui;
  const entries = full.timeline.slice();
  const nInternal = entries.filter((e) => e.internal).length;
  const nMsg = entries.filter((e) => e.kind === "message").length;
  const tl = h("div", { class: "timeline" });
  const search = h("input", { class: "input", type: "search", placeholder: "Cerca nel ticket…", value: ui.readerSearch || "" });

  function draw() {
    clear(tl);
    let list = entries.filter((e) => ui.showInternal || !e.internal);
    if (ui.newestFirst) list = list.slice().reverse();
    if (!list.length) tl.appendChild(h("div", { class: "empty-state" }, "Nessun messaggio."));
    for (const e of list) tl.appendChild(entryEl(e));
    const words = tokens(search.value);
    const hits = highlight(tl, words.length ? words : tokens(ctx.S.filters.text));
    if (search.value.trim()) search.title = hits ? `${hits} occorrenze` : "Nessuna occorrenza";
  }
  search.addEventListener("input", () => { ui.readerSearch = search.value; draw(); const m = tl.querySelector("mark"); if (m && search.value.trim()) m.scrollIntoView({ block: "center" }); });

  const btnInternal = h("button", { class: "btn btn-small" + (ui.showInternal ? " on" : ""), title: "Note visibili solo agli operatori", onclick: () => { ui.showInternal = !ui.showInternal; btnInternal.classList.toggle("on", ui.showInternal); ctx.saveUi(); draw(); } }, `Note interne (${nInternal})`);
  const btnOrder = h("button", { class: "btn btn-small", title: "Cambia l'ordine", onclick: () => { ui.newestFirst = !ui.newestFirst; btnOrder.textContent = ui.newestFirst ? "Dal più recente" : "Dal più vecchio"; ctx.saveUi(); draw(); } }, ui.newestFirst ? "Dal più recente" : "Dal più vecchio");

  body.appendChild(h("div", { class: "rd-tools" },
    h("h3", null, `Conversazione · ${nMsg} messaggi${entries.some((e) => e.kind === "solution") ? " + soluzione" : ""}`),
    nInternal ? btnInternal : null,
    btnOrder,
    search));
  body.appendChild(tl);
  draw();

  // numeri di ticket citati nel testo → si aprono qui
  tl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a.rt-ticket");
    if (!a) return;
    ev.preventDefault();
    ctx.openTicket(a.dataset.ticket, null);
  });
  el.scrollTop = keepScroll;
}

export { htmlToText };
