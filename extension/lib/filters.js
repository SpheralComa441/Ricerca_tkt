// Filtri della ricerca: stato dell'interfaccia → condizioni HDA per ListData/Incidents.
//
// Formato verificato sul portale (richieste reali di "All tickets"):
//   {"type":"AND","conditions":[{"property":"OwnerUserGroupID","value":"G00001","op":"eq","id":"OwnerUserGroupID"},
//                               {"property":"TicketStatusID","value":"S1|S2|S5","op":"in"}],"subfilters":[]}
// Proprietà e operatori dei filtri non ancora visti vengono presi, in ordine di affidabilità, da:
//   1. le richieste vere di Touch registrate dall'estensione ("filtri appresi");
//   2. la configurazione dell'elenco (campi "isFilter" con "filterOperator");
//   3. i valori predefiniti qui sotto.

import { ticketIdFrom } from "./util.js";
import { statusInfo, STATUS_GROUPS, statusesOfGroup } from "./statuses.js";

export const DOMAIN_CONDITION = { property: "id", value: "1", op: "eq", extKey: "TICKETDOMAIN", id: "Domain" };

/** I 7 stati "aperti / in lavorazione" che Touch preimposta quando non ci sono altri filtri. */
export const OPEN_STATUS_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];

// key: chiave nello stato dell'interfaccia; touchId: itemId del filtro nell'elenco Touch
export const FILTER_DEFS = [
  { key: "statuses", touchId: "StatusFilter", property: "TicketStatusID", op: "in", kind: "multi", verified: true, label: "Stato" },
  { key: "types", touchId: "ObjectTypeFilter", property: "TicketTypeID", op: "in", kind: "multi", verified: true, label: "Tipo" },
  { key: "priorities", touchId: "PriorityFilter", property: "TicketPriorityID", op: "in", kind: "multi", verified: true, label: "Priorità" },
  { key: "ownerGroups", touchId: "OwnerUserGroupID", property: "OwnerUserGroupID", op: "eq", kind: "objects", verified: true, label: "Gruppo" },
  { key: "assigned", touchId: "AssignedUserOrGroupFilter", property: "AssignedUserOrGroupID", op: "eq", kind: "objects", verified: true, label: "Assegnato a" },
  { key: "ownerUsers", touchId: "OwnerUserID", property: "OwnerUserID", op: "eq", kind: "objects", verified: true, label: "Responsabile" },
  { key: "modifiedBy", touchId: "ModifiedBy", property: "id", op: "eq", extKey: "MODIFIEDTICKET", kind: "objects", verified: true, label: "Modificato da" },
  { key: "accounts", touchId: "AccountID", property: "AccountID", op: "eq", kind: "objects", verified: true, label: "Cliente" },
  { key: "contacts", touchId: "ContactFilter", property: "ContactID", op: "eq", kind: "objects", verified: true, label: "Contatto" },
  { key: "catalog", touchId: "CatalogItem", property: "CTITM", op: "eq", kind: "objects", verified: true, label: "Prodotto" },
  { key: "subject", touchId: "Subject", property: "Subject", op: "like", wildcard: true, kind: "text", verified: true, label: "Oggetto" },
  { key: "text", touchId: "FullText", property: "FullText", op: "eq", extKey: "INCLUDECONVERSATIONITEM", kind: "text", verified: true, label: "Testo" },
  { key: "classCli", touchId: "ClassCliTxt", property: "CLASSCLI.TranslatedDescription", op: "like", wildcard: true, kind: "text", verified: true, label: "Classificazione cliente" },
  { key: "tag", touchId: "TagFilter", property: "Relations.ObjectTag.ID", op: "eq", kind: "text", verified: true, label: "Tag" },
  { key: "dateFrom", touchId: "DateFromFilter", property: "Date", op: "gt", kind: "date", verified: true, label: "Aperto dal" },
  { key: "dateTo", touchId: "DateToFilter", property: "Date", op: "le", kind: "date", endOfDay: true, verified: true, label: "Aperto fino al" },
  { key: "updFrom", touchId: "LastUpdateDateFromFilter", property: "LastChange", op: "gt", kind: "date", verified: true, label: "Aggiornato dal" },
  { key: "updTo", touchId: "LastUpdateDateToFilter", property: "LastChange", op: "le", kind: "date", endOfDay: true, verified: true, label: "Aggiornato fino al" },
];

export const DEF = Object.fromEntries(FILTER_DEFS.map((d) => [d.key, d]));

export function emptyFilters() {
  return {
    text: "", subject: "", classCli: "", tag: "",
    statuses: [], types: [], priorities: [],
    ownerGroups: [], assigned: [], ownerUsers: [], modifiedBy: [], accounts: [], contacts: [], catalog: [],
    dateFrom: "", dateTo: "", updFrom: "", updTo: "",
    touch: [], // condizioni importate così come le ha mandate Touch
  };
}

export function isEmptyFilter(v) {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Vero se nessun filtro è impostato (un'interrogazione senza vincoli su tutti gli anni scade per timeout a 25s su SQL Server). */
export function isUnconstrained(f) {
  if (!f) return true;
  return FILTER_DEFS.every((d) => isEmptyFilter(f[d.key])) && isEmptyFilter(f.touch);
}

/** Vero se oltre al testo libero c'è almeno un filtro che restringe l'insieme (gruppo, cliente, stato, data, ecc.). */
export function hasNarrowingFilter(f) {
  if (!f) return false;
  return FILTER_DEFS.some((d) => d.key !== "text" && d.key !== "subject" && !isEmptyFilter(f[d.key])) || !isEmptyFilter(f.touch);
}

/** Formato data: imita quello visto nelle richieste vere (se c'è), altrimenti ISO locale. */
export function formatDateValue(day, sample, endOfDay) {
  // day = "yyyy-mm-dd"
  const [y, m, d] = day.split("-").map(Number);
  const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
  const p = (n) => String(n).padStart(2, "0");
  const iso = `${y}-${p(m)}-${p(d)}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
  const s = sample == null ? "" : String(sample);
  if (/Date\(/.test(s)) return `/Date(${dt.getTime()})/`;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) return `${p(d)}/${p(m)}/${y}` + (/\d:\d/.test(s) ? ` ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}` : "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${y}-${p(m)}-${p(d)}`;
  if (/Z$/.test(s)) return dt.toISOString();
  return iso;
}

/**
 * Regola effettiva di un filtro: proprietà, operatore, extKey, valore d'esempio.
 * calib = { learned: {touchId: cond}, config: [filtri da listconfig], overrides: {key: rule}, containsText: {op, wildcard} }
 */
export function ruleFor(def, calib = {}) {
  const learned = calib.learned && calib.learned[def.touchId];
  const cfg = (calib.config || []).find((f) => f.itemId === def.touchId);
  const ov = calib.overrides && calib.overrides[def.key];
  const rule = {
    property: def.property,
    op: def.op,
    extKey: def.extKey,
    wildcard: !!def.wildcard,
    sample: undefined,
    source: def.verified ? "verificato" : "predefinito",
  };
  if (cfg) {
    if (cfg.property) rule.property = cfg.property;
    else if (cfg.name && !/filter$/i.test(cfg.name)) rule.property = cfg.name;
    // Per Oggetto e Classificazione cliente, l'operatore "like" con "%…%" è stato verificato sul server per cercare anche a metà testo (mentre Touch espone "in" o "sw").
    if (cfg.op && !(def.key === "subject" || def.key === "classCli")) rule.op = cfg.op;
    if (cfg.extKey) rule.extKey = cfg.extKey;
    rule.source = "configurazione Touch";
  }
  if ((def.key === "subject" || def.key === "classCli") && calib.containsText && calib.containsText.op) {
    rule.op = calib.containsText.op;
    rule.wildcard = !!calib.containsText.wildcard;
    rule.source = "calibrato";
  }
  if (ov) {
    if (ov.property) rule.property = ov.property;
    if (ov.op) rule.op = ov.op;
    if (ov.extKey !== undefined) rule.extKey = ov.extKey || undefined;
    if (ov.wildcard !== undefined) rule.wildcard = !!ov.wildcard;
    if (ov.source) rule.source = ov.source;
  }
  if (learned) {
    rule.property = learned.property;
    rule.op = learned.op;
    rule.extKey = learned.extKey ?? rule.extKey;
    rule.sample = learned.value;
    rule.source = "appreso da Touch";
  }
  return rule;
}

function cond(def, rule, value) {
  const c = { property: rule.property, value, op: rule.op, id: def.touchId };
  if (rule.extKey) c.extKey = rule.extKey;
  return c;
}

/** Stato dei filtri → elenco di condizioni */
export function buildConditions(f, calib = {}) {
  const out = [{ ...DOMAIN_CONDITION }];
  const text = String(f.text || "").trim();
  const tid = ticketIdFrom(text);
  for (const def of FILTER_DEFS) {
    let v = f[def.key];
    if (def.key === "text" && tid) continue;
    if (isEmptyFilter(v)) continue;
    const rule = ruleFor(def, calib);
    if (def.kind === "multi" || def.kind === "objects") {
      const ids = v.map((x) => (typeof x === "object" ? x.id : x)).filter(Boolean);
      if (!ids.length) continue;
      if (ids.length === 1 && rule.op !== "in") out.push(cond(def, rule, ids[0]));
      else out.push(cond(def, { ...rule, op: "in" }, ids.join("|")));
    } else if (def.kind === "date") {
      out.push(cond(def, rule, formatDateValue(v, rule.sample, def.endOfDay)));
    } else {
      let s = String(v).trim();
      if (rule.wildcard && !s.includes("%")) {
        s = "%" + s.split(/\s+/).filter(Boolean).join("%") + "%";
      }
      out.push(cond(def, rule, s));
    }
  }
  if (tid) out.push({ property: "ID", value: tid, op: "eq", id: "ID" });
  for (const c of f.touch || []) {
    if (c && c.property && !out.some((o) => o.id && o.id === c.id)) out.push({ ...c, lock: undefined });
  }
  return out;
}

export function filterPayload(conditions) {
  return { type: "AND", conditions, subfilters: [] };
}

/** Etichette leggibili dei filtri attivi (per i "chip") */
export function describeFilters(f) {
  const chips = [];
  const text = String(f.text || "").trim();
  if (text) {
    const tid = ticketIdFrom(text);
    chips.push({ key: "text", label: tid ? `Ticket n. ${tid.replace(/Z$/, "")}` : `Testo: “${text}”` });
  }
  if (f.statuses && f.statuses.length) {
    // se gli stati scelti sono esattamente un gruppo, si mostra il nome del gruppo
    const set = new Set(f.statuses);
    const names = [];
    const rest = new Set(f.statuses);
    for (const g of STATUS_GROUPS) {
      const ids = statusesOfGroup(g.key);
      if (ids.length && ids.every((i) => set.has(i))) {
        names.push(g.label);
        ids.forEach((i) => rest.delete(i));
      }
    }
    for (const id of rest) names.push(statusInfo(id).label);
    chips.push({ key: "statuses", label: `Stato: ${names.join(", ")}` });
  }
  for (const def of FILTER_DEFS) {
    if (["text", "statuses"].includes(def.key)) continue;
    const v = f[def.key];
    if (isEmptyFilter(v)) continue;
    let val;
    if (Array.isArray(v)) val = v.map((x) => (typeof x === "object" ? x.label || x.id : x)).join(", ");
    else if (def.kind === "date") val = v.split("-").reverse().join("/");
    else val = `“${v}”`;
    chips.push({ key: def.key, label: `${def.label}: ${val}` });
  }
  if (f.touch && f.touch.length) chips.push({ key: "touch", label: `Filtri da Touch (${f.touch.length})` });
  return chips;
}

/** Converte una richiesta registrata da Touch nei filtri "appresi" (per touchId) */
export function learnFromConditions(conditions, learned = {}) {
  for (const c of conditions || []) {
    if (!c || !c.property || !c.op) continue;
    const id = c.id || c.property;
    if (id === "Domain") continue;
    if (c.lock) continue; // filtri bloccati del modulo, non scelti dall'utente
    learned[id] = { property: c.property, op: c.op, extKey: c.extKey || null, value: c.value, at: Date.now() };
  }
  return learned;
}

/**
 * Estrae da un oggetto (Subject) una parola intera e una sottostringa non iniziale,
 * per verificare in una sola riga quale operatore trova le parole in mezzo al testo.
 */
export function pickCalibrationSample(subject) {
  const s = String(subject || "").trim();
  const low = s.toLowerCase();
  const words = s.match(/[A-Za-z]{4,14}/g) || [];
  const word = words[0] || null;
  let mid = words.find((w) => !low.startsWith(w.toLowerCase())) || null;
  if (!mid && word && word.length >= 4) {
    const sub = word.slice(1);
    if (!low.startsWith(sub.toLowerCase())) mid = sub;
  }
  return { word, mid };
}

