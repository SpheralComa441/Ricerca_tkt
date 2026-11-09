// Ticket completo: dati, richiesta, conversazione, soluzione → una sola timeline ordinata.

import { parseMsDate, norm, ticketNumber, isLegacyTicketNumber } from "./util.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "./richtext.js";

// Colonne della conversazione (nomi verificati dalla configurazione "Storico conversazioni" + TextHTML verificato via Projection)
export const CONV_COLUMNS = ["ID", "Text", "TextHTML", "FirstUpdate", "UserID", "User.FullName", "ContactID", "Contact.FirstName", "Contact.LastName", "Account.CompanyName", "SiteVisible", "MSGDIR", "TicketConversationItemStat.AttachmentCount"];
// Alias della vista ConversationHistory di ListData (verificati)
export const CONV_ALIAS = { c0: "Account.CompanyName", c1: "AccountID", c2: "Contact.FirstName", c3: "Contact.LastName", c4: "ContactID", c5: "FirstUpdate", c6: "FROMMAJINC", c7: "ID", c8: "MSGDIR", c9: "OTHERDEPT", c10: "REMOTETKT", c11: "SiteVisible", c12: "Text", c13: "TicketConversationItemStat.AttachmentCount", c14: "User.FullName", c15: "UserID" };
// Campi del ticket (nomi verificati nei dati del dettaglio)
export const TICKET_COLUMNS = ["ID", "Subject", "ProblemHTML", "Problem", "SolutionHTML", "Solution", "Date", "ClosureDate", "LastChange", "TicketStatusID", "TicketTypeID", "TicketPriorityID", "AccountID", "ContactID", "OwnerUserGroupID", "OwnerUserID", "AssignedUserID", "AssignedUserGroupID", "CTITMDESC", "CLASSCLI", "TKMAILTO", "TicketSourceID", "ParentTicketID", "Tag"];

const LIST_TRUNC = 500; // l'elenco della conversazione tronca il testo a 500 caratteri

/** Riga grezza della conversazione (Projection o ListData) → messaggio normalizzato */
export function normalizeItem(r) {
  const userId = r.UserID || "";
  const contactName = [r["Contact.FirstName"], r["Contact.LastName"]].filter(Boolean).join(" ");
  let role = "operator";
  let author = r["User.FullName"] || "";
  if (userId === "#HDASRV#") {
    role = "system";
    author = "Sistema";
  } else if (userId === "#HDAMAIL#") {
    role = "customer";
    author = contactName || r["Account.CompanyName"] || "Email del cliente";
  } else if (userId === "CP" || (!userId && r.ContactID) || (r.ContactID && /customer portal/i.test(author))) {
    role = "customer";
    author = contactName || r["Account.CompanyName"] || "Cliente";
  }
  const raw = r.TextHTML || r.Text || "";
  const html = isProbablyHtml(unescapeIfEscapedHtml(raw)) ? raw : null;
  const text = html ? htmlToText(html) : cleanText(raw);
  return {
    id: r.ID,
    date: parseMsDate(r.FirstUpdate),
    role,
    author,
    account: r["Account.CompanyName"] || "",
    internal: r.SiteVisible === false || r.SiteVisible === 0 || r.SiteVisible === "0",
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
 * - toglie i messaggi identici ripetuti.
 */
export function buildTimeline({ ticket = {}, row = {}, items = [] }) {
  const out = [];
  const problemHtml = ticket.ProblemHTML || "";
  const problemText = problemHtml ? htmlToText(problemHtml) : cleanText(ticket.Problem || row.problem || "");
  const reqDate = parseMsDate(ticket.Date) || row.date || null;
  if (problemText) {
    out.push({
      kind: "request",
      date: reqDate,
      role: "customer",
      author: row.contact || row.account || "Cliente",
      account: row.account || "",
      html: problemHtml || null,
      text: problemText,
      truncated: !problemHtml && !ticket.Problem && String(row.problem || "").length >= LIST_TRUNC,
    });
  }
  const seen = new Set();
  const ph = head(problemText);
  const msgs = items
    .map((it) => (it && it.role ? it : normalizeItem(it)))
    .filter((m) => m.text || m.attachments)
    .sort((a, b) => (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0));
  for (const m of msgs) {
    const h = head(m.text);
    if (ph && h && (m.creation || m.role === "system") && (ph.startsWith(h.slice(0, 120)) || h.startsWith(ph.slice(0, 120)))) continue;
    const key = h + "|" + (m.date ? Math.round(m.date.getTime() / 60000) : "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "message", ...m });
  }
  const solHtml = ticket.SolutionHTML || "";
  const solText = solHtml ? htmlToText(solHtml) : cleanText(ticket.Solution || "");
  if (solText) {
    out.push({ kind: "solution", date: parseMsDate(ticket.ClosureDate) || null, role: "operator", author: row.assigned || "", html: solHtml || null, text: solText });
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

/**
 * Carica tutto ciò che serve per leggere un ticket.
 * hda = client; rowReader = lettore delle righe di Incidents; row = riga già nota (dall'elenco)
 * caps = capacità scoperte (si aggiornano qui: quale metodo ha funzionato)
 */
export async function loadTicket(hda, id, { row = null, rowReader, conditionsFor, caps = {}, ar = null, log = () => {} } = {}) {
  if (row && row.source === "ar" && ar) {
    return await ar.loadTicket(id, { row });
  }
  const notes = [];
  // 1. riga con le descrizioni (cliente, gruppo, stato…) se non già nota
  if (!row && rowReader) {
    const { rows } = await hda.listData("Incidents", { conditions: conditionsFor(id), limit: 1 });
    if (rows[0]) row = rowReader.read(rows[0]);
  }
  // 2. dati completi del ticket (richiesta e soluzione intere)
  let ticket = null;
  const tryProjection = async () => {
    const rows = await hda.projection("Incident", [{ property: "ID", op: "eq", value: id }], TICKET_COLUMNS, 1);
    if (!rows[0]) throw new Error("ticket non trovato");
    return rows[0];
  };
  const tryGet = () => hda.wscGet("Incident", id);
  const order = caps.ticketVia === "get" ? [["get", tryGet], ["projection", tryProjection]] : [["projection", tryProjection], ["get", tryGet]];
  for (const [name, fn] of order) {
    try {
      ticket = await fn();
      caps.ticketVia = name;
      break;
    } catch (e) {
      log(`ticket via ${name}: ${e.message}`);
    }
  }
  // Se il ticket non esiste su HDA TOUCH, proviamo sul Vecchio Cruscotto (Area Riservata)
  if (!row && !ticket) {
    if (ar) {
      try {
        return await ar.loadTicket(ticketNumber(id), { row: null });
      } catch (arErr) {
        log(`ticket vecchio cruscotto #${ticketNumber(id)}: ${arErr.message}`);
      }
    }
    if (isLegacyTicketNumber(id)) {
      const err = new Error(
        `Il ticket #${ticketNumber(id)} appartiene al Vecchio Cruscotto (Area Riservata Zucchetti). Apri e collega il Vecchio Cruscotto per leggerlo qui, oppure cerca i ticket Touch che lo richiamano.`
      );
      err.isLegacyTicket = true;
      err.ticketNum = ticketNumber(id);
      throw err;
    }
    throw new Error("ticket non trovato o non visibile con il tuo utente");
  }
  if (!ticket) notes.push("Testo completo della richiesta non disponibile: mostro l'anteprima dell'elenco.");
  // 3. conversazione completa
  let items = null;
  const cond = [{ property: "TicketID", op: "eq", value: id }];
  if (caps.convVia !== "list") {
    try {
      const rows = await hda.projection("TicketConversationItem", cond, CONV_COLUMNS, 1000);
      items = rows.map(normalizeItem);
      caps.convVia = "projection";
    } catch (e) {
      log("conversazione via Projection: " + e.message);
    }
  }
  if (!items) {
    const { rows } = await hda.listData("TicketConversationItems", { viewId: "ConversationHistory", conditions: cond, limit: 500, sort: [{ property: "c5", direction: "ASC" }] });
    items = rows.map((r) => normalizeItem({ ...Object.fromEntries(Object.entries(CONV_ALIAS).map(([a, e]) => [e, r[a]])), _fromList: true }));
    caps.convVia = "list";
    if (items.some((m) => m.truncated)) notes.push("Alcuni messaggi lunghi sono troncati a 500 caratteri (limite dell'elenco di Touch).");
  }
  const timeline = buildTimeline({ ticket: ticket || {}, row: row || {}, items });
  return { id, row, ticket, items, timeline, notes };
}
