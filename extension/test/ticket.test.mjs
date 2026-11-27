// Test della costruzione del ticket (timeline) con dati sintetici.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeItem, buildTimeline, timelineText, formatTicketTxt, ticketTxtFilename, loadTicket, CONV_ALIAS, CONV_COLUMNS, CONV_COLUMNS_CORE } from "../lib/ticket.js";

const D = (iso) => `/Date(${new Date(iso).getTime()})/`;

test("normalizeItem: ruoli, nota interna, creazione", () => {
  const sys = normalizeItem({ ID: "1", UserID: "#HDASRV#", Text: "Ticket creato", FirstUpdate: D("2026-01-01T10:00:00"), SiteVisible: true });
  assert.equal(sys.role, "system");
  assert.equal(sys.author, "Sistema");
  const mail = normalizeItem({ ID: "2", UserID: "#HDAMAIL#", "Contact.FirstName": "Anna", "Contact.LastName": "Bianchi", Text: "Risposta via email" });
  assert.equal(mail.role, "customer");
  assert.equal(mail.author, "Anna Bianchi");
  const op = normalizeItem({ ID: "3", UserID: "U9", "User.FullName": "Operatore Nove", Text: "<p>Nota</p>", SiteVisible: false });
  assert.equal(op.role, "operator");
  assert.equal(op.internal, true);
  assert.equal(op.text, "Nota");
  assert.ok(op.html);
  const cr = normalizeItem({ ID: "4", MSGDIR: "CREATION", ContactID: "C1", Text: "x" });
  assert.equal(cr.creation, true);
  assert.equal(cr.role, "customer");
});

test("normalizeItem: testo troncato solo se viene dall'elenco", () => {
  const long = "a".repeat(500);
  assert.equal(normalizeItem({ Text: long, _fromList: true }).truncated, true);
  assert.equal(normalizeItem({ Text: long }).truncated, false);
});

test("buildTimeline: richiesta → messaggi in ordine → soluzione, senza doppioni", () => {
  const problem = "Il cedolino di gennaio riporta un importo errato nella voce straordinari del dipendente.";
  const items = [
    { ID: "c", UserID: "U1", "User.FullName": "Op", Text: "Seconda risposta", FirstUpdate: D("2026-01-03T09:00:00") },
    { ID: "a", UserID: "#HDASRV#", MSGDIR: "CREATION", Text: problem, FirstUpdate: D("2026-01-01T10:00:00") },
    { ID: "b", UserID: "U1", "User.FullName": "Op", Text: "Prima risposta", FirstUpdate: D("2026-01-02T09:00:00") },
    { ID: "b2", UserID: "U1", "User.FullName": "Op", Text: "Prima risposta", FirstUpdate: D("2026-01-02T09:00:20") },
  ];
  const tl = buildTimeline({ ticket: { ProblemHTML: `<p>${problem}</p>`, SolutionHTML: "<p>Corretto</p>", Date: D("2026-01-01T10:00:00"), ClosureDate: D("2026-01-04T10:00:00") }, row: { contact: "Anna B", account: "Ditta" }, items });
  assert.deepEqual(tl.map((e) => e.kind), ["request", "message", "message", "solution"]);
  assert.deepEqual(tl.filter((e) => e.kind === "message").map((e) => e.text), ["Prima risposta", "Seconda risposta"]);
  assert.equal(tl[0].author, "Anna B");
  assert.equal(tl[3].text, "Corretto");
  const txt = timelineText(tl, "Ticket 1");
  assert.match(txt, /^Ticket 1\n\n— RICHIESTA · Anna B/);
  assert.match(txt, /— SOLUZIONE/);
});

test("buildTimeline: le note interne restano (il lettore le può nascondere)", () => {
  const tl = buildTimeline({ ticket: {}, row: {}, items: [{ ID: "x", UserID: "U1", Text: "interna", SiteVisible: false, FirstUpdate: D("2026-01-01T00:00:00") }] });
  assert.equal(tl.length, 1);
  assert.equal(tl[0].internal, true);
});

test("loadTicket: Projection non disponibile → elenco Storico conversazioni", async () => {
  const calls = [];
  const hda = {
    async projection(entity) {
      calls.push("projection:" + entity);
      throw new Error("non consentito");
    },
    async wscGet() {
      calls.push("get");
      return { ID: "1Z", ProblemHTML: "<p>Richiesta</p>", Subject: "Oggetto" };
    },
    async listData(coll, opts) {
      calls.push("list:" + coll + ":" + opts.viewId);
      const rev = Object.fromEntries(Object.entries(CONV_ALIAS).map(([a, e]) => [e, a]));
      return { rows: [{ [rev.ID]: "m1", [rev.Text]: "x".repeat(500), [rev.UserID]: "U1", [rev["User.FullName"]]: "Op", [rev.FirstUpdate]: D("2026-02-01T08:00:00"), [rev.SiteVisible]: true }], total: 1 };
    },
  };
  const caps = {};
  const full = await loadTicket(hda, "1Z", { row: { id: "1Z", subject: "Oggetto" }, caps });
  // ID certo (riga dall'elenco): dati del ticket e conversazione partono insieme
  assert.deepEqual([...calls].sort(), ["get", "list:TicketConversationItems:ConversationHistory", "projection:Incident", "projection:TicketConversationItem"]);
  assert.ok(calls.indexOf("projection:TicketConversationItem") < calls.indexOf("get"), "conversazione in parallelo, non dopo il ticket");
  assert.equal(caps.ticketVia, "get");
  assert.equal(caps.convVia, "list");
  assert.equal(full.timeline[0].kind, "request");
  assert.equal(full.timeline[1].truncated, true);
  assert.ok(full.notes.some((n) => /500 caratteri/.test(n)));
});

// ---------------------------------------------------------------- numeri ticket nei due cruscotti

/** Portale finto: tickets = { ID: riga Incident }, ogni chiamata è registrata */
function fakePortal(tickets) {
  const calls = [];
  const hda = {
    async listData(coll, opts) {
      const idc = (opts.conditions || []).find((c) => c.property === "ID");
      calls.push(`list:${coll}:${idc ? idc.value : ""}`);
      if (coll === "Incidents" && idc && tickets[idc.value]) return { rows: [{ c23: idc.value, c45: tickets[idc.value].Subject }], total: 1 };
      return { rows: [], total: 0 };
    },
    async projection(entity, conditions) {
      const v = conditions[0].value;
      calls.push(`projection:${entity}:${v}`);
      if (entity === "Incident") return tickets[v] ? [tickets[v]] : [];
      return [];
    },
    async wscGet(_e, id) {
      calls.push("get:" + id);
      throw new Error("Object Not Found");
    },
  };
  return { hda, calls };
}
const rowReader = { read: (raw) => ({ id: raw.c23, subject: raw.c45 }) };
const conditionsFor = (id) => [{ property: "ID", value: id, op: "eq" }];

test("loadTicket: una riga del Vecchio Cruscotto non apre il ticket di Touch con le stesse cifre + Z", async () => {
  const { hda, calls } = fakePortal({ "8900042Z": { ID: "8900042Z", Subject: "Altro ticket di Touch" } });
  const arRow = { id: "8900042", source: "ar", subject: "detassazione", fullText: "Richiesta del cliente  Risposta dell'operatore" };
  const ar = { state: { connected: true }, async loadTicket(id, { row }) { return { id, source: "ar", row, timeline: [{ kind: "request", text: row.fullText }], items: [], notes: [] }; } };
  const full = await loadTicket(hda, "8900042", { row: arRow, rowReader, conditionsFor, ar });
  assert.equal(full.source, "ar");
  assert.equal(full.id, "8900042");
  assert.deepEqual(calls, [], "nessuna richiesta a Touch per un ticket del Vecchio Cruscotto");
});

test("loadTicket: numero a 7 cifre senza riga → varianti con e senza Z in parallelo, trova il ticket nativo 9876543Z", async () => {
  const { hda, calls } = fakePortal({ "9876543Z": { ID: "9876543Z", Subject: "Ticket nativo Touch", ProblemHTML: "<p>Richiesta</p>" } });
  const full = await loadTicket(hda, "9876543", { rowReader, conditionsFor, caps: {} });
  assert.equal(full.id, "9876543Z");
  assert.equal(full.row.id, "9876543Z");
  assert.equal(full.timeline[0].kind, "request");
  assert.deepEqual(calls.slice(0, 2), ["list:Incidents:9876543", "list:Incidents:9876543Z"]);
  assert.ok(calls.includes("projection:TicketConversationItem:9876543Z"));
});

test("loadTicket: 7 cifre trovato su Touch solo con la Z ma presente nel Vecchio Cruscotto → si apre quello del Vecchio Cruscotto (forma scritta)", async () => {
  const { hda } = fakePortal({ "9876543Z": { ID: "9876543Z", Subject: "Ticket nativo Touch" } });
  const ar = { state: { connected: true }, async loadTicket(id) { return { id, source: "ar", row: { id, source: "ar" }, timeline: [], items: [], notes: [] }; } };
  const full = await loadTicket(hda, "9876543", { rowReader, conditionsFor, ar, caps: {} });
  assert.equal(full.source, "ar");
  assert.equal(full.id, "9876543");
});

test("loadTicket: con la Z scritta si cerca solo su Touch, mai nel Vecchio Cruscotto", async () => {
  const { hda, calls } = fakePortal({});
  let arCalled = false;
  const ar = { state: { connected: true }, async loadTicket() { arCalled = true; throw new Error("non deve servire"); } };
  await assert.rejects(() => loadTicket(hda, "9876543Z", { rowReader, conditionsFor, ar, caps: {} }), /non trovato/);
  assert.equal(arCalled, false);
  assert.deepEqual(calls.filter((c) => c.startsWith("list:")), ["list:Incidents:9876543Z"]);
});

test("loadTicket: numero non su Touch e senza Z → Vecchio Cruscotto", async () => {
  const { hda } = fakePortal({});
  const ar = { state: { connected: false }, async loadTicket(id) { return { id, source: "ar", row: { id }, timeline: [], items: [], notes: [] }; } };
  const full = await loadTicket(hda, "8900042", { rowReader, conditionsFor, ar, caps: {} });
  assert.equal(full.source, "ar");
});

test("loadTicket: se Projection rifiuta le colonne estese OTHERDEPT/REMOTETKT, riprova con CONV_COLUMNS_CORE senza perdere TextHTML", async () => {
  const triedCols = [];
  const hda = {
    async projection(entity, _cond, cols) {
      if (entity === "Incident") return [{ ID: "11Z", Subject: "Prova", ProblemHTML: "<p>Richiesta</p>", Date: D("2026-03-01T09:00:00") }];
      triedCols.push([...cols]);
      if (cols.includes("OTHERDEPT")) throw new Error("Invalid column OTHERDEPT");
      return [{ ID: "m1", UserID: "U1", "User.FullName": "Laura Verdi", TextHTML: "<p>Risposta completa oltre 500 caratteri</p>", FirstUpdate: D("2026-03-01T10:00:00"), SiteVisible: false }];
    },
  };
  const caps = {};
  const full = await loadTicket(hda, "11Z", { row: { id: "11Z", subject: "Prova" }, caps });
  assert.equal(triedCols.length, 2);
  assert.deepEqual(triedCols[0], CONV_COLUMNS);
  assert.deepEqual(triedCols[1], CONV_COLUMNS_CORE);
  assert.equal(caps.convCoreOnly, true);
  assert.equal(caps.convVia, "projection");
  assert.equal(full.timeline[1].internal, true);
  assert.match(full.timeline[1].text, /oltre 500 caratteri/);
});

test("formatTicketTxt: estrazione cronologica completa con note interne, 2° livello (OTHERDEPT/REMOTETKT), partner, gruppo, data/ora e allegati", () => {
  const items = [
    // volutamente fuori ordine per verificare il riordino cronologico
    {
      ID: "m3",
      UserID: "U1",
      "User.FullName": "Laura Verdi",
      Text: "Confermiamo la correzione sulla versione 26.12.",
      FirstUpdate: D("2026-11-20T15:40:00"),
      SiteVisible: true,
    },
    {
      ID: "m2",
      UserID: "U9",
      "User.FullName": "Marco Fontana",
      Text: "Analisi 2° livello: anomalia riprodotta su SQL.",
      FirstUpdate: D("2026-11-19T11:25:00"),
      SiteVisible: false,
      OTHERDEPT: true,
      REMOTETKT: "2L-9941",
    },
    {
      ID: "m1",
      UserID: "U1",
      "User.FullName": "Laura Verdi",
      Text: "Nota interna di presa in carico.",
      FirstUpdate: D("2026-11-18T10:05:00"),
      SiteVisible: false,
    },
    {
      ID: "m1b",
      UserID: "#HDAMAIL#",
      "Contact.FirstName": "Mario",
      "Contact.LastName": "Rossi",
      "Account.CompanyName": "PARTNER ALFA SRL",
      Text: "Allego il file di log richiesto.",
      FirstUpdate: D("2026-11-18T14:15:00"),
      SiteVisible: true,
    },
  ];
  const row = {
    id: "11973804Z",
    source: "touch",
    subject: "Detassazione premi di risultato",
    statusId: "S6",
    statusText: "Risolto",
    typeText: "Assistenza",
    priorityText: "P2 - Alta",
    account: "PARTNER ALFA SRL",
    customerCode: "100234",
    originalClient: "BETA MECCANICA SPA",
    contact: "Mario Rossi",
    ownerGroup: "Paghe 1° Livello",
    ownerUser: "Laura Verdi",
    assignedGroup: "Paghe 2° Livello",
    assigned: "Laura Verdi",
    catalog: "Paghe Infinity",
    date: new Date(2026, 10, 18, 9, 15),
    lastChange: new Date(2026, 10, 20, 16, 0),
  };
  const attachments = [
    { id: "A1", fileName: "log_errore.txt", sizeKb: 12.4, author: "Mario Rossi", date: new Date(2026, 10, 18, 14, 15), parentObject: "TicketConversationItem", parentObjectId: "m1b" },
  ];
  const timeline = buildTimeline({
    ticket: {
      ID: "11973804Z",
      Subject: row.subject,
      ProblemHTML: "<p>Nel cedolino manca la detassazione.</p>",
      SolutionHTML: "<p>Aggiornato parametro voce.</p>",
      Date: D("2026-11-18T09:15:00"),
      ClosureDate: D("2026-11-20T16:00:00"),
    },
    row,
    items,
    attachments,
  });

  // Anche se passiamo la timeline invertita, formatTicketTxt la ristampa sempre in ordine cronologico
  const reversedFull = { id: "11973804Z", source: "touch", row, ticket: { TKMAILTO: "m.rossi@alfa.it" }, attachments, timeline: timeline.slice().reverse() };
  assert.equal(ticketTxtFilename(reversedFull), "ticket_11973804.txt");

  const txt = formatTicketTxt(reversedFull, { exportedAt: new Date(2026, 10, 27, 17, 50) });
  assert.match(txt, /TICKET #11973804 — Detassazione premi di risultato/);
  assert.match(txt, /Cliente \/ Partner:\s+PARTNER ALFA SRL \(cod\. 100234\)/);
  assert.match(txt, /Cliente originale:\s+BETA MECCANICA SPA/);
  assert.match(txt, /Gruppo owner:\s+Paghe 1° Livello/);
  assert.match(txt, /Totale scambi:\s+6 \(di cui 2 note interne \/ 2° livello\)/);
  assert.match(txt, /log_errore\.txt \(12,4 KB/);

  // Verifica ordine cronologico e contenuti chiave di ogni scambio
  const i1 = txt.indexOf("[1] RICHIESTA INIZIALE");
  const i2 = txt.indexOf("[2] NOTA INTERNA\n");
  const i3 = txt.indexOf("[3] MESSAGGIO CLIENTE / PARTNER");
  const i4 = txt.indexOf("[4] NOTA INTERNA / SCAMBIO 2° LIVELLO");
  const i5 = txt.indexOf("[5] RISPOSTA OPERATORE");
  const i6 = txt.indexOf("[6] SOLUZIONE");
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2 && i4 > i3 && i5 > i4 && i6 > i5, "tutti i 6 scambi presenti in ordine cronologico");

  assert.match(txt.slice(i1, i2), /Data e ora:\s+18\/11\/2026 09:15[\s\S]*Chi scrive:\s+Mario Rossi \(Cliente \/ Partner\)[\s\S]*Gruppo \/ Partner:\s+PARTNER ALFA SRL \(cod\. 100234\) — Cliente originale: BETA MECCANICA SPA/);
  assert.match(txt.slice(i2, i3), /Data e ora:\s+18\/11\/2026 10:05[\s\S]*Chi scrive:\s+Laura Verdi \(Operatore\)[\s\S]*Visibilità:\s+NON visibile a clienti e partner \(Nota interna\)/);
  assert.match(txt.slice(i3, i4), /Data e ora:\s+18\/11\/2026 14:15[\s\S]*Allegati messaggio:\s+log_errore\.txt \(12,4 KB\)/);
  assert.match(txt.slice(i4, i5), /Data e ora:\s+19\/11\/2026 11:25[\s\S]*Chi scrive:\s+Marco Fontana \(Operatore\)[\s\S]*Gruppo \/ Partner:\s+Altro reparto \/ 2° livello \(rif\. 2L-9941\)[\s\S]*Rif\. 2° livello:\s+Ticket remoto: 2L-9941[\s\S]*Visibilità:\s+NON visibile a clienti e partner \(Nota interna \/ scambio 2° livello\)/);
  assert.match(txt.slice(i6), /Data e ora:\s+20\/11\/2026 16:00[\s\S]*Aggiornato parametro voce\./);
});

