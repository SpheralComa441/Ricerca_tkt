// Ticket completo: dati, richiesta, conversazione, soluzione, allegati → una sola timeline ordinata.

import { parseMsDate, norm, ticketNumber, ticketIdVariants, isLegacyTicketNumber } from "./util.js";
import { htmlToText, cleanText, isProbablyHtml, unescapeIfEscapedHtml } from "./richtext.js";
import { guessMimeFromName } from "./hda.js";

// Colonne della conversazione (nomi verificati dalla configurazione "Storico conversazioni" + TextHTML verificato via Projection)
export const CONV_COLUMNS = ["ID", "Text", "TextHTML", "FirstUpdate", "UserID", "User.FullName", "ContactID", "Contact.FirstName", "Contact.LastName", "Account.CompanyName", "SiteVisible", "MSGDIR", "TicketConversationItemStat.AttachmentCount"];
// Alias della vista ConversationHistory di ListData (verificati)
export const CONV_ALIAS = { c0: "Account.CompanyName", c1: "AccountID", c2: "Contact.FirstName", c3: "Contact.LastName", c4: "ContactID", c5: "FirstUpdate", c6: "FROMMAJINC", c7: "ID", c8: "MSGDIR", c9: "OTHERDEPT", c10: "REMOTETKT", c11: "SiteVisible", c12: "Text", c13: "TicketConversationItemStat.AttachmentCount", c14: "User.FullName", c15: "UserID" };
// Alias della vista Default di ListData/Attachments (verificati da List_Attachments_Default)
export const ATTACH_ALIAS = { c0: "ContentType", c1: "Description", c2: "FileName", c3: "FirstUpdateUser.FullName", c4: "ID", c5: "LastUpdate", c6: "ParentObject", c7: "ParentObjectID" };
// Campi del ticket (nomi verificati nei dati del dettaglio)
export const TICKET_COLUMNS = ["ID", "Subject", "ProblemHTML", "Problem", "SolutionHTML", "Solution", "Date", "ClosureDate", "LastChange", "TicketStatusID", "TicketTypeID", "TicketPriorityID", "AccountID", "ContactID", "OwnerUserGroupID", "OwnerUserID", "AssignedUserID", "AssignedUserGroupID", "CTITMDESC", "CLASSCLI", "TKMAILTO", "TicketSourceID", "ParentTicketID", "Tag"];

const LIST_TRUNC = 500; // l'elenco della conversazione tronca il testo a 500 caratteri

/** Riga grezza di ListData/Attachments → allegato normalizzato */
export function normalizeAttachment(r, ticketId = "") {
  if (!r) return null;
  const id = String(r.ID || r.c4 || r.id || "").trim();
  if (!id) return null;
  const fileName = String(r.FileName || r.c2 || r.fileName || r.Description || r.c1 || id).trim();
  const desc = String(r.Description || r.c1 || r.description || "").trim();
  const contentType = String(r.ContentType || r.c0 || r.contentType || guessMimeFromName(fileName)).trim();
  const author = String(r["FirstUpdateUser.FullName"] || r.c3 || r.author || "").trim();
  const date = parseMsDate(r.LastUpdate || r.c5 || r.date);
  const parentObject = String(r.ParentObject || r.c6 || r.parentObject || "Incident").trim();
  const parentObjectId = String(r.ParentObjectID || r.c7 || r.parentObjectId || ticketId || "").trim();
  return {
    id,
    fileName,
    description: desc && desc !== fileName ? desc : "",
    contentType,
    author,
    date,
    parentObject,
    parentObjectId,
    url: r.url || "",
  };
}

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
 * Prova entrambe le varianti dell'ID su HDA TOUCH (es. "9042633" senza Z per i 7 cifre e "11943209Z" con Z per gli 8 cifre)
 * e, se il dettaglio completo non è disponibile su HDA TOUCH, interroga automaticamente il Vecchio Cruscotto.
 */
export async function loadTicket(hda, id, { row = null, rowReader, conditionsFor, caps = {}, ar = null, log = () => {} } = {}) {
  const arRowSeed = (row && row.source === "ar" ? row : row && row.arRow) || null;
  if (row && row.source === "ar" && ar && !hda) {
    return await ar.loadTicket(id, { row });
  }

  // Costruisce la lista ordinata di ID da provare su HDA TOUCH: prima l'ID esatto della riga (se proviene da Touch), poi le varianti senza/con Z.
  const idCandidates = [];
  const pushCand = (c) => {
    const s = String(c || "").trim();
    if (s && !idCandidates.includes(s)) idCandidates.push(s);
  };
  if (row && row.id && row.source !== "ar") pushCand(row.id);
  for (const v of ticketIdVariants(id)) pushCand(v);
  pushCand(id);

  const notes = [];
  // 1. riga con le descrizioni (cliente, gruppo, stato…) se non già nota da HDA TOUCH
  if ((!row || row.source === "ar") && rowReader && conditionsFor) {
    for (const candId of idCandidates) {
      try {
        const { rows } = await hda.listData("Incidents", { conditions: conditionsFor(candId), limit: 1 });
        if (rows[0]) {
          const touchRow = rowReader.read(rows[0]);
          row = arRowSeed ? { ...touchRow, arRow: arRowSeed, arUrl: arRowSeed.arUrl } : touchRow;
          break;
        }
      } catch {
        /* */
      }
    }
  }

  // 2. dati completi del ticket (richiesta e soluzione intere) provando le varianti dell'ID (es. "9042633" e "9042633Z")
  let ticket = null;
  let resolvedId = (row && row.source !== "ar" && row.id) || idCandidates[0] || id;
  for (const candId of idCandidates) {
    const tryProjection = async () => {
      const rows = await hda.projection("Incident", [{ property: "ID", op: "eq", value: candId }], TICKET_COLUMNS, 1);
      if (!rows[0]) throw new Error("ticket non trovato");
      return rows[0];
    };
    const tryGet = () => hda.wscGet("Incident", candId);
    const order = caps.ticketVia === "get" ? [["get", tryGet], ["projection", tryProjection]] : [["projection", tryProjection], ["get", tryGet]];
    for (const [name, fn] of order) {
      try {
        ticket = await fn();
        caps.ticketVia = name;
        resolvedId = (ticket && ticket.ID) || candId;
        break;
      } catch (e) {
        log(`ticket ${candId} via ${name}: ${e.message}`);
      }
    }
    if (ticket) break;
  }

  // Se il dettaglio completo del ticket non è disponibile su HDA TOUCH, carichiamo dal Vecchio Cruscotto (Area Riservata)
  if (!ticket && ar) {
    try {
      return await ar.loadTicket(ticketNumber(id), { row: arRowSeed });
    } catch (arErr) {
      log(`ticket vecchio cruscotto #${ticketNumber(id)}: ${arErr.message}`);
    }
  }

  if (!row && !ticket) {
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

  if (row && resolvedId && row.source !== "ar") {
    row = { ...row, id: resolvedId };
  }
  if (!ticket) notes.push("Testo completo della richiesta non disponibile: mostro l'anteprima dell'elenco.");

  // 3. conversazione completa e allegati in parallelo usando l'ID effettivo risolto su HDA TOUCH
  const cond = [{ property: "TicketID", op: "eq", value: resolvedId }];
  const attPromise =
    typeof hda.listAttachments === "function"
      ? hda
          .listAttachments(resolvedId)
          .then((rawAtts) => (rawAtts || []).map((r) => normalizeAttachment(r, resolvedId)).filter(Boolean))
          .catch((e) => {
            log("allegati: " + e.message);
            return [];
          })
      : Promise.resolve([]);

  const convPromise = (async () => {
    let convItems = null;
    if (caps.convVia !== "list") {
      try {
        const rows = await hda.projection("TicketConversationItem", cond, CONV_COLUMNS, 1000);
        convItems = rows.map(normalizeItem);
        caps.convVia = "projection";
      } catch (e) {
        log("conversazione via Projection: " + e.message);
      }
    }
    if (!convItems) {
      const { rows } = await hda.listData("TicketConversationItems", {
        viewId: "ConversationHistory",
        conditions: cond,
        limit: 500,
        sort: [{ property: "c5", direction: "ASC" }],
      });
      convItems = rows.map((r) =>
        normalizeItem({ ...Object.fromEntries(Object.entries(CONV_ALIAS).map(([a, e]) => [e, r[a]])), _fromList: true }),
      );
      caps.convVia = "list";
      if (convItems.some((m) => m.truncated)) notes.push("Alcuni messaggi lunghi sono troncati a 500 caratteri (limite dell'elenco di Touch).");
    }
    return convItems;
  })();

  const [items, attachments] = await Promise.all([convPromise, attPromise]);
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
