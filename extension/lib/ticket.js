// Ticket completo: dati, richiesta, conversazione, soluzione, allegati → una sola timeline ordinata.

import { parseMsDate, fmtDateTime, norm, ticketNumber, ticketIdVariants, isLegacyTicketNumber, isTouchNativeId } from "./util.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "./richtext.js";
import { guessMimeFromName } from "./hda.js";
import { statusInfo } from "./statuses.js";
import { buildArTicket } from "./ar.js";

// Colonne base della conversazione (verificate via Projection su Touch)
export const CONV_COLUMNS_CORE = ["ID", "Text", "TextHTML", "FirstUpdate", "UserID", "User.FullName", "ContactID", "Contact.FirstName", "Contact.LastName", "Account.CompanyName", "SiteVisible", "MSGDIR", "TicketConversationItemStat.AttachmentCount"];
// Colonne complete della conversazione (include i campi verificati da ConversationHistory: altro reparto / 2° livello, ticket remoto, major incident)
export const CONV_COLUMNS = [...CONV_COLUMNS_CORE, "OTHERDEPT", "REMOTETKT", "FROMMAJINC"];
// Alias della vista ConversationHistory di ListData (verificati)
export const CONV_ALIAS = { c0: "Account.CompanyName", c1: "AccountID", c2: "Contact.FirstName", c3: "Contact.LastName", c4: "ContactID", c5: "FirstUpdate", c6: "FROMMAJINC", c7: "ID", c8: "MSGDIR", c9: "OTHERDEPT", c10: "REMOTETKT", c11: "SiteVisible", c12: "Text", c13: "TicketConversationItemStat.AttachmentCount", c14: "User.FullName", c15: "UserID" };
// Alias della vista AttachmentPreview di ListData/Attachments (verificati: c5 = KBSize introdotto da Touch)
export const ATTACH_ALIAS = { c0: "ContentType", c1: "Description", c2: "FileName", c3: "FirstUpdateUser.FullName", c4: "ID", c5: "KBSize", c6: "LastUpdate", c7: "ParentObject", c8: "ParentObjectID" };
// Campi del ticket (nomi verificati nei dati del dettaglio)
export const TICKET_COLUMNS = ["ID", "Subject", "ProblemHTML", "Problem", "SolutionHTML", "Solution", "Date", "ClosureDate", "LastChange", "TicketStatusID", "TicketTypeID", "TicketPriorityID", "AccountID", "ContactID", "OwnerUserGroupID", "OwnerUserID", "AssignedUserID", "AssignedUserGroupID", "CTITMDESC", "CLASSCLI", "TKMAILTO", "TicketSourceID", "ParentTicketID", "Tag"];

const LIST_TRUNC = 500; // l'elenco della conversazione tronca il testo a 500 caratteri

/** Interpreta un campo flag/descrittivo del portale (es. OTHERDEPT, REMOTETKT, FROMMAJINC). */
function parseFlagOrText(v) {
  if (v == null || v === false || v === 0) return false;
  if (v === true || v === 1) return true;
  const s = String(v).trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (low === "0" || low === "false" || low === "no" || low === "n") return false;
  if (low === "1" || low === "true" || low === "yes" || low === "si" || low === "sì" || low === "s" || low === "y") return true;
  return s;
}

/** Riga grezza di ListData/Attachments (schema 9 colonne con c5=KBSize o legacy 8 colonne) → allegato normalizzato */
export function normalizeAttachment(r, ticketId = "") {
  if (!r) return null;
  const id = String(r.ID || r.c4 || r.id || "").trim();
  if (!id) return null;
  const fileName = String(r.FileName || r.c2 || r.fileName || r.Description || r.c1 || id).trim();
  const desc = String(r.Description || r.c1 || r.description || "").trim();
  const contentType = String(r.ContentType || r.c0 || r.contentType || guessMimeFromName(fileName)).trim();
  const author = String(r["FirstUpdateUser.FullName"] || r.c3 || r.author || "").trim();
  // HDA Touch ha aggiunto c5 = KBSize spostando di +1 LastUpdate (c6), ParentObject (c7) e ParentObjectID (c8).
  const hasKbSizeCol = r.c8 !== undefined || typeof r.c5 === "number" || /^\/Date\(/.test(String(r.c6 || ""));
  const rawSize = r.KBSize != null ? r.KBSize : hasKbSizeCol ? r.c5 : r.sizeKb;
  const sizeKb = rawSize != null && rawSize !== "" ? Number(rawSize) : null;
  const date = parseMsDate(r.LastUpdate || (hasKbSizeCol ? r.c6 : r.c5) || r.date);
  const rawParentObj = String(r.ParentObject || (hasKbSizeCol ? r.c7 : r.c6) || r.parentObject || "").trim();
  const parentObject = rawParentObj && !/^\/Date\(/.test(rawParentObj) ? rawParentObj : "Incident";
  const parentObjectId = String(r.ParentObjectID || (hasKbSizeCol ? r.c8 : r.c7) || r.parentObjectId || ticketId || "").trim();
  return {
    id,
    fileName,
    description: desc && desc !== fileName ? desc : "",
    contentType: contentType || guessMimeFromName(fileName),
    author,
    sizeKb: Number.isFinite(sizeKb) && sizeKb > 0 ? sizeKb : null,
    date,
    parentObject,
    parentObjectId,
    url: r.url || "",
  };
}

/** Riga grezza della conversazione (Projection o ListData) → messaggio normalizzato */
export function normalizeItem(r) {
  const userId = String(r.UserID || "").trim();
  const contactName = [r["Contact.FirstName"], r["Contact.LastName"]].filter(Boolean).join(" ").trim();
  let role = "operator";
  let author = String(r["User.FullName"] || "").trim();
  if (userId === "#HDASRV#") {
    role = "system";
    author = "Sistema";
  } else if (userId === "#HDAMAIL#") {
    role = "customer";
    author = contactName || String(r["Account.CompanyName"] || "").trim() || "Email del cliente";
  } else if (userId === "CP" || (!userId && r.ContactID) || (r.ContactID && /customer portal/i.test(author))) {
    role = "customer";
    author = contactName || String(r["Account.CompanyName"] || "").trim() || "Cliente";
  }
  const otherDept = parseFlagOrText(r.OTHERDEPT);
  const remoteTicket = parseFlagOrText(r.REMOTETKT);
  const fromMajorIncident = Boolean(parseFlagOrText(r.FROMMAJINC));
  const secondLevel = !!(otherDept || remoteTicket);
  const group = String(r.group || r["UserGroup.Description"] || "").trim();
  const raw = r.TextHTML || r.Text || "";
  const html = isProbablyHtml(unescapeIfEscapedHtml(raw)) ? raw : null;
  const text = html ? htmlToText(html) : cleanText(raw);
  return {
    id: r.ID,
    date: parseMsDate(r.FirstUpdate),
    role,
    userId,
    author,
    group,
    account: String(r["Account.CompanyName"] || "").trim(),
    internal: r.SiteVisible === false || r.SiteVisible === 0 || r.SiteVisible === "0",
    secondLevel,
    otherDept,
    remoteTicket,
    fromMajorIncident,
    msgDir: String(r.MSGDIR || "").trim(),
    creation: r.MSGDIR === "CREATION",
    attachments: Number(r["TicketConversationItemStat.AttachmentCount"]) || 0,
    html,
    text,
    truncated: !r.TextHTML && String(r.Text || "").length >= LIST_TRUNC && r._fromList === true,
  };
}

/** Prime parole confrontabili (per riconoscere i doppioni) */
function head(s, n = 160) {
  return norm(s).replace(/[^a-z0-9 ]/g, "").slice(0, n);
}

/**
 * Costruisce la timeline: richiesta iniziale → messaggi in ordine di data → soluzione.
 * - toglie il messaggio di creazione automatico se ripete la richiesta;
 * - toglie i messaggi identici ripetuti;
 * - collega gli allegati ai singoli messaggi (`attachmentItems`) e alla richiesta iniziale.
 */
export function buildTimeline({ ticket = {}, row = {}, items = [], attachments = [] }) {
  const out = [];
  const normAtts = (attachments || []).map((a) => (a && a.fileName ? a : normalizeAttachment(a, ticket.ID || row.id))).filter(Boolean);
  const byParentId = new Map();
  const incidentAtts = [];
  for (const a of normAtts) {
    if (a.parentObject === "TicketConversationItem" && a.parentObjectId) {
      if (!byParentId.has(a.parentObjectId)) byParentId.set(a.parentObjectId, []);
      byParentId.get(a.parentObjectId).push(a);
    } else {
      incidentAtts.push(a);
    }
  }

  const problemHtml = ticket.ProblemHTML || "";
  const problemText = problemHtml ? htmlToText(problemHtml) : cleanText(ticket.Problem || row.problem || "");
  const reqDate = parseMsDate(ticket.Date) || row.date || null;
  if (problemText || incidentAtts.length) {
    out.push({
      kind: "request",
      date: reqDate,
      role: "customer",
      author: row.contact || row.account || "Cliente",
      account: row.account || "",
      originalClient: row.originalClient || "",
      customerCode: row.customerCode || "",
      html: problemHtml || null,
      text: problemText,
      attachments: incidentAtts.length,
      attachmentItems: incidentAtts,
      truncated: !problemHtml && !ticket.Problem && String(row.problem || "").length >= LIST_TRUNC,
    });
  }
  const seen = new Set();
  const ph = head(problemText);
  const msgs = items
    .map((it) => (it && it.role ? it : normalizeItem(it)))
    .filter((m) => m.text || m.attachments || (m.id && byParentId.has(m.id)))
    .sort((a, b) => (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0));
  for (const m of msgs) {
    const h = head(m.text);
    const msgAtts = (m.id && byParentId.get(m.id)) || m.attachmentItems || [];
    if (ph && h && !msgAtts.length && (m.creation || m.role === "system") && (ph.startsWith(h.slice(0, 120)) || h.startsWith(ph.slice(0, 120)))) continue;
    const key = h + "|" + (m.date ? Math.round(m.date.getTime() / 60000) : "");
    if (seen.has(key) && !msgAtts.length) continue;
    seen.add(key);
    out.push({
      kind: "message",
      ...m,
      attachments: Math.max(Number(m.attachments) || 0, msgAtts.length),
      attachmentItems: msgAtts,
    });
  }
  const solHtml = ticket.SolutionHTML || "";
  const solText = solHtml ? htmlToText(solHtml) : cleanText(ticket.Solution || "");
  if (solText) {
    out.push({
      kind: "solution",
      date: parseMsDate(ticket.ClosureDate) || null,
      role: "operator",
      author: row.assigned || "",
      group: row.assignedGroup || row.ownerGroup || "",
      html: solHtml || null,
      text: solText,
    });
  }
  return out;
}

/** Testo semplice di tutto il ticket (copia negli appunti, archivio locale, ricerca) */
export function timelineText(entries, header = "") {
  const lines = header ? [header, ""] : [];
  for (const e of entries) {
    const when = e.date ? e.date.toLocaleString("it-IT") : "";
    const who = e.kind === "request" ? "RICHIESTA" : e.kind === "solution" ? "SOLUZIONE" : e.internal ? "NOTA INTERNA" : e.role === "customer" ? "CLIENTE" : e.role === "system" ? "SISTEMA" : "OPERATORE";
    lines.push(`— ${who}${e.author ? " · " + e.author : ""}${when ? " · " + when : ""}`);
    lines.push(e.text, "");
  }
  return lines.join("\n").trim();
}

const SOURCE_LABELS = {
  touch: "HDA Touch",
  ar: "Vecchio Cruscotto (Area Riservata)",
  storico: "Ricerca avanzata (Area Riservata)",
};

function fmtKb(sizeKb) {
  const n = Number(sizeKb);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 1024 ? `${(n / 1024).toFixed(2).replace(".", ",")} MB` : `${n.toFixed(1).replace(".", ",")} KB`;
}

function sortEntriesChronologically(entries) {
  return (entries || [])
    .filter(Boolean)
    .map((e, idx) => {
      const dt = parseMsDate(e.date);
      return { e, idx, t: dt ? dt.getTime() : null };
    })
    .sort((a, b) => {
      const rank = (x) => (x.t != null ? 0 : x.e.kind === "request" ? -1 : x.e.kind === "solution" ? 1 : 0);
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.t != null && b.t != null && a.t !== b.t) return a.t - b.t;
      return a.idx - b.idx;
    })
    .map((x) => x.e);
}

function cleanAuthorForTxt(e) {
  if (e.authorName) return String(e.authorName).trim();
  let name = String(e.author || "").trim();
  const grp = String(e.group || "").trim();
  if (name && grp) {
    const suffix = `(${grp})`;
    if (name.endsWith(suffix)) name = name.slice(0, -suffix.length).trim();
  }
  if (name) return name;
  if (e.kind === "request" || e.role === "customer") return "Cliente / Partner";
  if (e.role === "system") return "Sistema";
  return "Operatore";
}

function roleSuffixForTxt(e) {
  if (e.kind === "request" || e.role === "customer") return "Cliente / Partner";
  if (e.role === "system") return "Sistema";
  return "Operatore";
}

function resolveGroupOrPartner(e, row) {
  const r = row || {};
  const isCust = e.kind === "request" || e.role === "customer";
  if (isCust) {
    const acct = String(e.account || r.account || "").trim();
    const code = String(e.customerCode || r.customerCode || "").trim();
    const orig = String(e.originalClient || r.originalClient || "").trim();
    const parts = [];
    if (acct) parts.push(code && !acct.includes(code) ? `${acct} (cod. ${code})` : acct);
    else if (code) parts.push(`Codice cliente ${code}`);
    if (orig && orig !== acct) parts.push(`Cliente originale: ${orig}`);
    if (parts.length) return parts.join(" — ");
    return String(e.group || "").trim() || "Cliente / Partner";
  }
  if (e.role === "system") {
    const g = String(e.group || "").trim();
    if (g) return g;
    return r.ownerGroup ? `Sistema (gruppo ticket: ${r.ownerGroup})` : "Sistema";
  }
  const explicitGroup = String(e.group || "").trim();
  if (explicitGroup) return explicitGroup;
  if (typeof e.otherDept === "string" && e.otherDept.trim()) return `${e.otherDept.trim()} (2° livello / altro reparto)`;
  const msgAcct = String(e.account || "").trim();
  if (msgAcct) return msgAcct;
  if (e.secondLevel) {
    return typeof e.remoteTicket === "string" && e.remoteTicket.trim()
      ? `Altro reparto / 2° livello (rif. ${e.remoteTicket.trim()})`
      : "Altro reparto / 2° livello";
  }
  const authorLow = norm(cleanAuthorForTxt(e));
  if (authorLow && r.assigned && r.assignedGroup && norm(r.assigned) === authorLow) return String(r.assignedGroup).trim();
  if (authorLow && r.ownerUser && r.ownerGroup && norm(r.ownerUser) === authorLow) return String(r.ownerGroup).trim();
  const og = String(r.ownerGroup || "").trim();
  const ag = String(r.assignedGroup || "").trim();
  if (og && ag && og !== ag) return `${og} / ${ag} (gruppi ticket)`;
  if (og || ag) return `${og || ag} (gruppo ticket)`;
  return "Supporto / Operatore";
}

function exchangeBanner(e) {
  if (e.kind === "request") return "RICHIESTA INIZIALE";
  if (e.kind === "solution") return "SOLUZIONE";
  if (e.internal && e.secondLevel) return "NOTA INTERNA / SCAMBIO 2° LIVELLO";
  if (e.secondLevel) return "SCAMBIO 2° LIVELLO / ALTRO REPARTO";
  if (e.internal) return "NOTA INTERNA";
  if (e.role === "customer") return "MESSAGGIO CLIENTE / PARTNER";
  if (e.role === "system") return "SISTEMA";
  return "RISPOSTA OPERATORE";
}

function visibilityLabel(e) {
  if (e.internal && e.secondLevel) return "NON visibile a clienti e partner (Nota interna / scambio 2° livello)";
  if (e.internal) return "NON visibile a clienti e partner (Nota interna)";
  if (e.secondLevel) return "Scambio con altro reparto / 2° livello";
  return "Visibile al cliente / partner";
}

/** Nome file pulito per il download dell'estrazione testuale di un ticket. */
export function ticketTxtFilename(full) {
  const raw = ticketNumber((full && full.id) || (full && full.row && full.row.id) || "ticket");
  const safe = String(raw || "ticket").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "ticket";
  return `ticket_${safe}.txt`;
}

/**
 * Genera l'estrazione completa di un ticket in formato TXT leggibile:
 *  - metadati completi del ticket e elenco allegati;
 *  - TUTTI gli scambi in ordine cronologico (incluse note interne e scambi con 2° livelli non visibili);
 *  - per ogni scambio: data e ora, chi scrive, gruppo di appartenenza / nome partner, destinatario, visibilità e testo completo.
 */
export function formatTicketTxt(full, { exportedAt = new Date() } = {}) {
  const f = full || {};
  const row = f.row || {};
  const ticket = f.ticket || {};
  const id = String(f.id || row.id || "").trim();
  const num = ticketNumber(id);
  const source = f.source || row.source || "touch";
  const subject = cleanText(row.subject || ticket.Subject || "") || (num ? `Ticket #${num}` : "Ticket");
  const statusId = row.statusId || ticket.TicketStatusID || "";
  const statusLabel = statusId || row.statusText ? statusInfo(statusId, row.statusText).label : "";
  const entries = sortEntriesChronologically(f.timeline || []);
  const internalCount = entries.filter((e) => e.internal || e.secondLevel).length;
  const attachments = Array.isArray(f.attachments) ? f.attachments : [];

  const SEP_HEAVY = "=".repeat(80);
  const SEP_LIGHT = "-".repeat(80);
  const kv = (label, val) => {
    const v = String(val ?? "").trim();
    if (!v) return null;
    return `${(label + ":").padEnd(23, " ")}${v}`;
  };

  const lines = [
    SEP_HEAVY,
    `TICKET #${num || id} — ${subject}`,
    SEP_HEAVY,
  ];

  const meta = [
    ["Fonte", SOURCE_LABELS[source] || source],
    ["Numero ticket", id && id !== num ? `#${num} (ID portale: ${id})` : `#${num || id}`],
    ["Stato", statusLabel],
    ["Tipo", row.typeText],
    ["Priorità", row.priorityText || row.priority],
    ["Cliente / Partner", [row.account, row.customerCode && !String(row.account || "").includes(row.customerCode) ? `(cod. ${row.customerCode})` : ""].filter(Boolean).join(" ")],
    ["Cliente originale", row.originalClient && row.originalClient !== row.account ? row.originalClient : ""],
    ["Contatto", [row.contact, ticket.TKMAILTO ? `<${ticket.TKMAILTO}>` : ""].filter(Boolean).join(" ")],
    ["Prodotto", ticket.CTITMDESC || row.catalog],
    ["Classificazione", row.classCli],
    ["Fornitore", row.supplier],
    ["Gruppo owner", row.ownerGroup],
    ["Owner del ticket", row.ownerUser],
    ["Gruppo assegnato", row.assignedGroup && row.assignedGroup !== row.ownerGroup ? row.assignedGroup : ""],
    ["Assegnato a", row.assigned],
    ["Ticket collegato", ticket.ParentTicketID],
    ["Aperto il", fmtDateTime(row.date || ticket.Date)],
    ["Ultimo aggiornamento", fmtDateTime(row.lastChange || ticket.LastChange)],
    ["Chiuso il", fmtDateTime(ticket.ClosureDate || row.closureDate)],
    ["Scadenza SLA", row.nextExpiration && statusInfo(statusId).group !== "closed" ? `${fmtDateTime(row.nextExpiration)}${row.sla ? " · " + row.sla : ""}` : ""],
    ...(Array.isArray(f.extraFacts) ? f.extraFacts : []),
    [
      "Totale scambi",
      entries.length
        ? `${entries.length}${internalCount ? ` (di cui ${internalCount} ${internalCount === 1 ? "nota interna / 2° livello" : "note interne / 2° livello"})` : ""}`
        : "0",
    ],
  ];

  const seenMeta = new Set();
  for (const [k, v] of meta) {
    if (!k || seenMeta.has(k)) continue;
    const line = kv(k, v);
    if (line) {
      seenMeta.add(k);
      lines.push(line);
    }
  }

  if (attachments.length) {
    lines.push(kv("Allegati del ticket", String(attachments.length)));
    for (const att of attachments) {
      const attMeta = [fmtKb(att.sizeKb), att.author, att.date ? fmtDateTime(att.date) : ""].filter(Boolean).join(" — ");
      lines.push(`  - ${att.fileName || att.id}${attMeta ? ` (${attMeta})` : ""}`);
    }
  }

  const expStr = fmtDateTime(exportedAt);
  if (expStr) lines.push(kv("Esportato il", expStr));

  lines.push(
    "",
    SEP_HEAVY,
    "CRONOLOGIA COMPLETA DEGLI SCAMBI (ordine cronologico: dal più vecchio al più recente)",
    SEP_HEAVY,
    "",
  );

  if (!entries.length) {
    lines.push("Nessuno scambio presente nella cronologia del ticket.");
    return lines.join("\n").trim() + "\n";
  }

  entries.forEach((e, idx) => {
    const dt = fmtDateTime(e.date);
    const author = cleanAuthorForTxt(e);
    const roleLbl = roleSuffixForTxt(e);
    const whoStr = norm(author) === norm(roleLbl) ? author : `${author} (${roleLbl})`;
    const grpPartner = resolveGroupOrPartner(e, row);
    const destStr = e.to || [e.toName, e.toGroup && e.toGroup !== e.toName ? `(${e.toGroup})` : ""].filter(Boolean).join(" ");
    const msgAtts = Array.isArray(e.attachmentItems) && e.attachmentItems.length
      ? e.attachmentItems.map((a) => `${a.fileName || a.id}${fmtKb(a.sizeKb) ? ` (${fmtKb(a.sizeKb)})` : ""}`).join(", ")
      : e.attachments > 0
        ? `${e.attachments} allegat${e.attachments === 1 ? "o" : "i"}`
        : "";
    const secondLevelRef = [
      typeof e.remoteTicket === "string" && e.remoteTicket.trim() ? `Ticket remoto: ${e.remoteTicket.trim()}` : "",
      e.fromMajorIncident ? "Da Major Incident" : "",
    ].filter(Boolean).join(" · ");

    lines.push(SEP_LIGHT);
    lines.push(`[${idx + 1}] ${exchangeBanner(e)}`);
    lines.push(kv("Data e ora", dt || "Non disponibile"));
    lines.push(kv("Chi scrive", whoStr));
    lines.push(kv("Gruppo / Partner", grpPartner));
    if (destStr) lines.push(kv("Destinatario", destStr));
    if (e.label) lines.push(kv("Causale", e.label));
    if (secondLevelRef) lines.push(kv("Rif. 2° livello", secondLevelRef));
    lines.push(kv("Visibilità", visibilityLabel(e)));
    if (msgAtts) lines.push(kv("Allegati messaggio", msgAtts));
    lines.push(SEP_LIGHT);

    const body = cleanText(e.text || (e.html ? htmlToText(e.html) : "")) || "(nessun testo)";
    lines.push(body);
    if (e.truncated) lines.push("", "[Nota: testo troncato dal portale in modalità elenco]");
    lines.push("");
  });

  return lines.join("\n").trim() + "\n";
}

/**
 * Carica tutto ciò che serve per leggere un ticket.
 *  - riga del Vecchio Cruscotto (source "ar") → si legge dal Vecchio Cruscotto: lo stesso numero con la "Z"
 *    su HDA TOUCH è un ALTRO ticket, quindi non si cercano varianti su Touch;
 *  - riga di Touch già nota (dall'elenco) → ID certo: dati del ticket, conversazione e allegati in parallelo
 *    (una sola attesa invece di due in fila);
 *  - solo il numero (link, numero citato nel testo) → si provano in parallelo le varianti con/senza "Z"
 *    e, se su Touch non c'è e il numero non ha la "Z", il Vecchio Cruscotto.
 */
export async function loadTicket(hda, id, { row = null, rowReader, conditionsFor, caps = {}, ar = null, log = () => {} } = {}) {
  const arRowSeed = (row && row.source === "ar" ? row : row && row.arRow) || null;
  if (row && row.source === "ar") {
    if (ar) return await ar.loadTicket(id, { row });
    return buildArTicket({ id, row });
  }

  const notes = [];
  const typedNativeZ = isTouchNativeId(id);
  let candidates = row && row.id ? [String(row.id)] : ticketIdVariants(id);
  if (!candidates.length) candidates = [String(id || "").trim()].filter(Boolean);

  // 1. solo il numero: quale variante esiste su Touch? (richieste in parallelo, vince l'ordine di preferenza)
  if (!row && rowReader && conditionsFor && hda) {
    const found = await Promise.all(
      candidates.map((c) =>
        hda
          .listData("Incidents", { conditions: conditionsFor(c), limit: 1 })
          .then((r) => (r.rows && r.rows[0] ? rowReader.read(r.rows[0]) : null))
          .catch((e) => {
            if (e && e.name === "AuthError") throw e;
            return null;
          }),
      ),
    );
    const k = found.findIndex(Boolean);
    // numero a 5-7 cifre senza "Z" che su Touch esiste solo con la "Z": prima si guarda se è un ticket del
    // Vecchio Cruscotto con lo stesso numero (la forma scritta), poi si apre quello di Touch con la "Z"
    if (k > 0 && ar && !typedNativeZ && isLegacyTicketNumber(id) && ar.state && ar.state.connected === true) {
      try {
        return await ar.loadTicket(ticketNumber(id), { row: null });
      } catch (arErr) {
        log(`ticket vecchio cruscotto #${ticketNumber(id)}: ${arErr.message}`);
      }
    }
    if (k >= 0) {
      row = found[k];
      candidates = [String(row.id || candidates[k])];
    }
  }

  const fetchTicket = async (candId) => {
    const tryProjection = async () => {
      const rows = await hda.projection("Incident", [{ property: "ID", op: "eq", value: candId }], TICKET_COLUMNS, 1);
      if (!rows[0]) throw new Error("ticket non trovato");
      return rows[0];
    };
    const tryGet = () => hda.wscGet("Incident", candId);
    const order = caps.ticketVia === "get" ? [["get", tryGet], ["projection", tryProjection]] : [["projection", tryProjection], ["get", tryGet]];
    for (const [name, fn] of order) {
      try {
        const t = await fn();
        caps.ticketVia = name;
        return t;
      } catch (e) {
        if (e && e.name === "AuthError") throw e;
        log(`ticket ${candId} via ${name}: ${e.message}`);
      }
    }
    return null;
  };

  const fetchConversation = async (ticketId) => {
    const cond = [{ property: "TicketID", op: "eq", value: ticketId }];
    if (caps.convVia !== "list") {
      const cols = caps.convCoreOnly ? CONV_COLUMNS_CORE : CONV_COLUMNS;
      try {
        const rows = await hda.projection("TicketConversationItem", cond, cols, 1000);
        caps.convVia = "projection";
        return rows.map(normalizeItem);
      } catch (e) {
        if (e && e.name === "AuthError") throw e;
        if (!caps.convCoreOnly && /column|property|field|expression|invalid|unknown|otherdept|remotetkt|frommajinc/i.test(String(e.message || ""))) {
          log("conversazione via Projection (colonne estese non supportate): riprovo con colonne base");
          try {
            const rows = await hda.projection("TicketConversationItem", cond, CONV_COLUMNS_CORE, 1000);
            caps.convCoreOnly = true;
            caps.convVia = "projection";
            return rows.map(normalizeItem);
          } catch (e2) {
            if (e2 && e2.name === "AuthError") throw e2;
            log("conversazione via Projection: " + e2.message);
          }
        } else {
          log("conversazione via Projection: " + e.message);
        }
      }
    }
    const { rows } = await hda.listData("TicketConversationItems", {
      viewId: "ConversationHistory",
      conditions: cond,
      limit: 500,
      sort: [{ property: "c5", direction: "ASC" }],
    });
    const items = rows.map((r) => normalizeItem({ ...Object.fromEntries(Object.entries(CONV_ALIAS).map(([a, e]) => [e, r[a]])), _fromList: true }));
    caps.convVia = "list";
    if (items.some((m) => m.truncated)) notes.push("Alcuni messaggi lunghi sono troncati a 500 caratteri (limite dell'elenco di Touch).");
    return items;
  };

  const fetchAttachments = (ticketId) =>
    typeof hda.listAttachments === "function"
      ? hda
          .listAttachments(ticketId)
          .then((rawAtts) => (rawAtts || []).map((r) => normalizeAttachment(r, ticketId)).filter(Boolean))
          .catch((e) => {
            log("allegati: " + e.message);
            return [];
          })
      : Promise.resolve([]);

  // 2. dati completi del ticket (richiesta e soluzione intere), conversazione e allegati
  let ticket = null;
  let items = [];
  let attachments = [];
  let resolvedId = candidates[0] || String(id || "");
  if (row && candidates.length === 1) {
    // ID certo (riga di Touch): tutto in parallelo
    [ticket, items, attachments] = await Promise.all([fetchTicket(resolvedId), fetchConversation(resolvedId), fetchAttachments(resolvedId)]);
  } else {
    const tickets = await Promise.all(candidates.map((c) => fetchTicket(c)));
    const k = tickets.findIndex(Boolean);
    if (k >= 0) {
      ticket = tickets[k];
      resolvedId = String(ticket.ID || candidates[k]);
    }
    if (ticket || row) [items, attachments] = await Promise.all([fetchConversation(resolvedId), fetchAttachments(resolvedId)]);
  }

  // 3. non su Touch: Vecchio Cruscotto, ma solo per numeri senza "Z" (con la "Z" è un ticket nativo di Touch)
  if (!ticket && !row && ar && !typedNativeZ) {
    try {
      return await ar.loadTicket(ticketNumber(id), { row: arRowSeed });
    } catch (arErr) {
      log(`ticket vecchio cruscotto #${ticketNumber(id)}: ${arErr.message}`);
    }
  }
  // riga di Touch senza "Z" (ticket migrato) ma dettaglio non leggibile: si prova il testo del Vecchio Cruscotto
  if (!ticket && row && ar && arRowSeed && !isTouchNativeId(row.id)) {
    try {
      return await ar.loadTicket(ticketNumber(id), { row: arRowSeed });
    } catch (arErr) {
      log(`ticket vecchio cruscotto #${ticketNumber(id)}: ${arErr.message}`);
    }
  }

  if (!row && !ticket) {
    if (isLegacyTicketNumber(id)) {
      const err = new Error(
        `Il ticket #${ticketNumber(id)} non è su HDA TOUCH e potrebbe appartenere al Vecchio Cruscotto (Area Riservata Zucchetti). Collega il Vecchio Cruscotto per leggerlo qui, oppure cerca i ticket Touch che lo richiamano.`
      );
      err.isLegacyTicket = true;
      err.ticketNum = ticketNumber(id);
      throw err;
    }
    throw new Error("ticket non trovato o non visibile con il tuo utente");
  }

  if (row && resolvedId) row = { ...row, id: resolvedId };
  if (!ticket) notes.push("Testo completo della richiesta non disponibile: mostro l'anteprima dell'elenco.");

  const timeline = buildTimeline({ ticket: ticket || {}, row: row || {}, items, attachments });
  return {
    id: resolvedId,
    row,
    ticket,
    items,
    attachments,
    timeline,
    notes,
    arUrl: (row && row.arUrl) || (arRowSeed && arRowSeed.arUrl) || "",
  };
}
