// Diagnostica: prova sul portale vero ogni funzione usata dall'app e produce un rapporto
// senza dati personali (solo esiti, nomi di campi, operatori, conteggi e lunghezze).

import { DOMAIN_CONDITION, pickCalibrationSample } from "./filters.js";
import { CONV_COLUMNS, TICKET_COLUMNS } from "./ticket.js";

export async function runProbe(hda, { onStep = () => {}, sampleTicketId = null, learned = {}, captures = [], log = () => {} } = {}) {
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
    log(`diagnostica ${s.ok ? "✓" : "✗"} ${name}: ${s.detail} (${s.ms} ms)`);
    onStep(steps);
    return s;
  };

  let ticketId = sampleTicketId;
  let sampleSubject = "";

  await step("Stati (GetStaticList)", async () => {
    const rows = await hda.staticList("TicketStatuses");
    return `${rows.length} stati`;
  });

  await step("Ticket di prova (Projection rapida)", async () => {
    let rows = await hda.projection(
      "Incident",
      ticketId ? [{ property: "ID", op: "eq", value: ticketId }] : [{ property: "TicketStatusID", op: "eq", value: "S1" }],
      TICKET_COLUMNS,
      1
    );
    if (!rows[0] && !ticketId) rows = await hda.projection("Incident", [], TICKET_COLUMNS, 1);
    if (!rows[0]) throw new Error("nessuna riga");
    if (!ticketId) ticketId = rows[0].ID;
    sampleSubject = rows[0].Subject || "";
    return `ID ${ticketId}, richiesta: ${String(rows[0].ProblemHTML || rows[0].Problem || "").length} caratteri`;
  });

  await step("Elenco ticket (ListData su 1 ticket)", async () => {
    const conds = ticketId
      ? [DOMAIN_CONDITION, { property: "ID", op: "eq", value: ticketId, id: "ID" }]
      : [DOMAIN_CONDITION, { property: "TicketStatusID", op: "in", value: "S1|S2|S3|S4|S5|S6|S7", id: "StatusFilter" }];
    const { rows, total } = await hda.listData("Incidents", { conditions: conds, limit: 1, sort: [{ property: "c20", direction: "DESC" }] });
    if (!rows.length) throw new Error("nessuna riga");
    return `${total} riga, ${Object.keys(rows[0]).length} colonne`;
  });

  let cfg = null;
  await step("Configurazione elenco ticket (colonne e filtri)", async () => {
    cfg = await hda.listConfig("Incidents");
    const n = Object.keys(cfg.mapping).length;
    if (!n) throw new Error(`mappa colonne non trovata (risposta di ${cfg.size} caratteri)`);
    const summary = cfg.filters.map((f) => `${f.itemId}=${f.property || f.name || "?"}/${f.op || "?"}${f.extKey ? "[" + f.extKey + "]" : ""}`).join(", ");
    log("filtri configurazione Touch: " + summary);
    return `${n} colonne, ${cfg.filters.length} filtri`;
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

  const { word, mid } = pickCalibrationSample(sampleSubject);
  const idCond = ticketId ? { property: "ID", op: "eq", value: ticketId, id: "ID" } : null;
  let workingContains = null;
  let workingFullText = null;

  const ftCfg = (cfg && cfg.filters || []).find((f) => f.itemId === "FullText") || {};
  const ftProp = ftCfg.property || ftCfg.name || "FullText";
  const ftCandidates = [
    { op: ftCfg.op || "sw", extKey: ftCfg.extKey || undefined, label: `${ftProp}/${ftCfg.op || "sw"}${ftCfg.extKey ? "[" + ftCfg.extKey + "]" : ""}` },
    { op: "in", extKey: ftCfg.extKey || undefined, label: `${ftProp}/in` },
    { op: "like", extKey: ftCfg.extKey || undefined, label: `${ftProp}/like` },
  ];
  for (const cand of ftCandidates) {
    const s = await step(`Filtro FullText (${cand.label})`, async () => {
      const c = { property: ftProp, op: cand.op, value: word || "a", id: "FullText" };
      if (cand.extKey) c.extKey = cand.extKey;
      const conds = idCond ? [DOMAIN_CONDITION, idCond, c] : [DOMAIN_CONDITION, c];
      const { total } = await hda.listData("Incidents", { conditions: conds, limit: 1 });
      if (idCond && word && !total) throw new Error("0 righe (non trova la parola)");
      return `${total} righe`;
    });
    if (s.ok && !workingFullText) workingFullText = { property: ftProp, op: cand.op, extKey: cand.extKey };
  }

  for (const [op, wildcard, label] of [
    ["ct", false, 'ct senza "%"'],
    ["like", true, 'like con "%…%"'],
    ["sw", true, 'sw con "%…%"'],
    ["like", false, 'like senza "%"'],
  ]) {
    const s = await step(`Ricerca nell'oggetto (${label})`, async () => {
      const q = mid || word || "a";
      const val = wildcard ? `%${q}%` : q;
      const conds = idCond ? [DOMAIN_CONDITION, idCond, { property: "Subject", op, value: val, id: "Subject" }] : [DOMAIN_CONDITION, { property: "Subject", op, value: val, id: "Subject" }];
      const { total } = await hda.listData("Incidents", { conditions: conds, limit: 1 });
      if (idCond && (mid || word) && !total) throw new Error("0 righe (non trova a metà oggetto)");
      return `trova sottostringa (${total} righe)`;
    });
    if (s.ok && !workingContains) workingContains = { op, wildcard };
  }

  const report = {
    version: typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "dev",
    at: new Date().toISOString(),
    steps: steps.map(({ name, ok, detail, ms }) => ({ name, ok, detail, ms })),
    workingContains,
    workingFullText,
    columns: cfg ? cfg.mapping : null,
    filters: cfg ? cfg.filters.map(({ itemId, op, xtype, label, name, extKey, property, hidden }) => ({ itemId, op, xtype, label, name, extKey, property, hidden })) : null,
    // dei filtri appresi si riportano solo forma e formato del valore, non i valori
    learned: Object.fromEntries(Object.entries(learned).map(([k, v]) => [k, { property: v.property, op: v.op, extKey: v.extKey, valueShape: shape(v.value) }])),
    captures: captures.slice(0, 15).map((c) => ({ collection: c.collection, viewId: c.viewId, conditions: (c.conditions || []).map((x) => ({ id: x.id, property: x.property, op: x.op, extKey: x.extKey, lock: x.lock, valueShape: shape(x.value) })) })),
  };
  return { steps, report, config: cfg, workingContains, workingFullText };
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
