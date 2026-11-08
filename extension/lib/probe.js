// Diagnostica: prova sul portale vero ogni funzione usata dall'app e produce un rapporto
// senza dati personali (solo esiti, nomi di campi, operatori, conteggi e lunghezze).

import { DOMAIN_CONDITION } from "./filters.js";
import { CONV_COLUMNS, TICKET_COLUMNS } from "./ticket.js";

export async function runProbe(hda, { onStep = () => {}, sampleTicketId = null, learned = {}, captures = [] } = {}) {
  const steps = [];
  const step = async (name, fn) => {
    const s = { name, ok: false, detail: "" };
    steps.push(s);
    onStep(steps);
    const t0 = Date.now();
    try {
      const d = await fn();
      s.ok = true;
      s.detail = d || "";
    } catch (e) {
      s.detail = e.message + (e.info && e.info.sample ? " — " + String(e.info.sample).slice(0, 160) : "");
    }
    s.ms = Date.now() - t0;
    onStep(steps);
    return s;
  };

  let ticketId = sampleTicketId;
  await step("Elenco ticket (ListData)", async () => {
    const { rows, total } = await hda.listData("Incidents", { conditions: [DOMAIN_CONDITION], limit: 3, sort: [{ property: "c20", direction: "DESC" }] });
    if (!rows.length) throw new Error("nessuna riga");
    const idKey = Object.keys(rows[0]).find((k) => /^\d{6,}Z$/.test(String(rows[0][k])));
    if (!ticketId && idKey) ticketId = rows[0][idKey];
    return `${total} ticket visibili; colonne: ${Object.keys(rows[0]).length}`;
  });

  let cfg = null;
  await step("Configurazione elenco ticket (colonne e filtri)", async () => {
    cfg = await hda.listConfig("Incidents");
    const n = Object.keys(cfg.mapping).length;
    if (!n) throw new Error(`mappa colonne non trovata (risposta di ${cfg.size} caratteri)`);
    return `${n} colonne, ${cfg.filters.length} filtri`;
  });

  await step("Testo completo del ticket (Projection)", async () => {
    if (!ticketId) throw new Error("nessun ticket di prova");
    const rows = await hda.projection("Incident", [{ property: "ID", op: "eq", value: ticketId }], TICKET_COLUMNS, 1);
    if (!rows[0]) throw new Error("nessuna riga");
    return `richiesta: ${String(rows[0].ProblemHTML || rows[0].Problem || "").length} caratteri`;
  });

  await step("Ticket completo (WSC/Get)", async () => {
    if (!ticketId) throw new Error("nessun ticket di prova");
    const d = await hda.wscGet("Incident", ticketId);
    return `${Object.keys(d).length} campi`;
  });

  await step("Conversazione completa (Projection)", async () => {
    if (!ticketId) throw new Error("nessun ticket di prova");
    const rows = await hda.projection("TicketConversationItem", [{ property: "TicketID", op: "eq", value: ticketId }], CONV_COLUMNS, 200);
    const max = Math.max(0, ...rows.map((r) => String(r.Text || "").length));
    return `${rows.length} messaggi, il più lungo ${max} caratteri`;
  });

  await step("Conversazione (elenco Storico conversazioni)", async () => {
    if (!ticketId) throw new Error("nessun ticket di prova");
    const { rows } = await hda.listData("TicketConversationItems", { viewId: "ConversationHistory", conditions: [{ property: "TicketID", value: ticketId, op: "eq" }], limit: 50 });
    return `${rows.length} messaggi`;
  });

  await step("Testo HTML dei messaggi (TextHTML)", async () => {
    if (!ticketId) throw new Error("nessun ticket di prova");
    const rows = await hda.projection("TicketConversationItem", [{ property: "TicketID", op: "eq", value: ticketId }], ["ID", "TextHTML"], 5);
    return `${rows.length} messaggi`;
  });

  for (const [ent, cols] of [["UserGroup", ["ID", "Description"]], ["User", ["ID", "FullName"]], ["CatalogItem", ["ID", "Description"]]]) {
    await step(`Elenco ${ent} (Projection)`, async () => {
      const rows = await hda.projection(ent, [], cols, 3);
      return `${rows.length} righe di prova`;
    });
  }

  for (const op of ["sw", "like", "ct"]) {
    await step(`Operatore testo "${op}" su Subject`, async () => {
      const { total } = await hda.listData("Incidents", { conditions: [DOMAIN_CONDITION, { property: "Subject", op, value: "pag" }], limit: 1 });
      return `${total} ticket`;
    });
  }

  await step("Stati (GetStaticList)", async () => {
    const rows = await hda.staticList("TicketStatuses");
    return `${rows.length} stati`;
  });

  const report = {
    version: typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "dev",
    at: new Date().toISOString(),
    steps: steps.map(({ name, ok, detail, ms }) => ({ name, ok, detail, ms })),
    columns: cfg ? cfg.mapping : null,
    filters: cfg ? cfg.filters.map(({ itemId, op, xtype, label, name, extKey, property, hidden }) => ({ itemId, op, xtype, label, name, extKey, property, hidden })) : null,
    // dei filtri appresi si riportano solo forma e formato del valore, non i valori
    learned: Object.fromEntries(Object.entries(learned).map(([k, v]) => [k, { property: v.property, op: v.op, extKey: v.extKey, valueShape: shape(v.value) }])),
    captures: captures.slice(0, 15).map((c) => ({ collection: c.collection, viewId: c.viewId, conditions: (c.conditions || []).map((x) => ({ id: x.id, property: x.property, op: x.op, extKey: x.extKey, lock: x.lock, valueShape: shape(x.value) })) })),
  };
  return { steps, report, config: cfg };
}

/** Forma del valore senza il contenuto: "/Date(13 cifre)/", "testo(12)", "lista(3)" */
function shape(v) {
  if (v == null) return String(v);
  if (typeof v === "boolean" || typeof v === "number") return typeof v;
  const s = String(v);
  if (/^\/?Date\(-?\d+\)\/?$/.test(s)) return "/Date(ms)/";
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return "ISO " + s.replace(/\d/g, "9");
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) return "data " + s.replace(/\d/g, "9");
  if (s.includes("|")) return `lista(${s.split("|").length})`;
  return `testo(${s.length})`;
}
