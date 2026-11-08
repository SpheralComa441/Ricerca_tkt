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
  assert.deepEqual(calls, ["projection:Incident", "get", "projection:TicketConversationItem", "list:TicketConversationItems:ConversationHistory"]);
  assert.equal(caps.ticketVia, "get");
  assert.equal(caps.convVia, "list");
  assert.equal(full.timeline[0].kind, "request");
  assert.equal(full.timeline[1].truncated, true);
  assert.ok(full.notes.some((n) => /500 caratteri/.test(n)));
});
