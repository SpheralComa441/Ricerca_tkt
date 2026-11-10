// Test della costruzione del ticket (timeline) con dati sintetici.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeItem, buildTimeline, timelineText, loadTicket, CONV_ALIAS } from "../lib/ticket.js";

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
