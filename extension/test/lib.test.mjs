// Test delle librerie (node --test extension/test). Dati sintetici: nessun dato reale del portale.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMsDate, ticketIdFrom, ticketIdVariants, ticketNumber, isLegacyTicketNumber, tokens, queryTerms, matchesAllTokens, norm, csvCell, fmtDate } from "../lib/util.js";
import { parseListConfig } from "../lib/listconfig.js";
import { makeRowReader } from "../lib/rows.js";
import { buildConditions, emptyFilters, formatDateValue, learnFromConditions, ruleFor, DEF, describeFilters, filterPayload, pickCalibrationSample, isUnconstrained, hasNarrowingFilter, primaryTerm } from "../lib/filters.js";
import { htmlToText, splitQuoted, linkifyParts, decodeEntities, unescapeIfEscapedHtml, cleanText } from "../lib/richtext.js";
import { makeTransport, AuthError, HdaError, formBody } from "../lib/transport.js";
import { makeHda, parsePreviewAttachmentResponse, guessMimeFromName } from "../lib/hda.js";
import { buildArQuery, parseArResponse, buildArTicket, extractMcidFromHtml, splitArTesti } from "../lib/ar.js";
import { loadTicket, normalizeAttachment } from "../lib/ticket.js";

// ---------------------------------------------------------------- util

test("parseMsDate: formato /Date(ms)/, data nulla HDA, ISO", () => {
  assert.equal(parseMsDate("/Date(1700000000000)/").getTime(), 1700000000000);
  assert.equal(parseMsDate("\\/Date(1700000000000+0100)\\/").getTime(), 1700000000000);
  assert.equal(parseMsDate("/Date(-2208992400000)/"), null);
  assert.equal(parseMsDate(""), null);
  assert.equal(parseMsDate(null), null);
  assert.equal(fmtDate(new Date(2026, 10, 6)), "06/11/2026");
});

test("numero ticket ↔ ID HDA (8 cifre con Z, 5-7 cifre senza Z) e varianti ID", () => {
  assert.equal(ticketIdFrom("10500123"), "10500123Z");
  assert.equal(ticketIdFrom(" #10500123 "), "10500123Z");
  assert.equal(ticketIdFrom("10500123z"), "10500123Z");
  assert.equal(ticketIdFrom("9018200"), "9018200");
  assert.equal(ticketIdFrom("9042633"), "9042633");
  assert.equal(ticketIdFrom("9042633Z"), "9042633");
  assert.deepEqual(ticketIdVariants("9042633"), ["9042633", "9042633Z"]);
  assert.deepEqual(ticketIdVariants("10500123"), ["10500123Z", "10500123"]);
  assert.equal(ticketIdFrom("cedolino"), null);
  assert.equal(ticketIdFrom("12 34"), null);
  assert.equal(ticketNumber("10500123Z"), "10500123");
  assert.equal(ticketNumber("9042633"), "9042633");
  assert.equal(isLegacyTicketNumber("9018200"), true);
  assert.equal(isLegacyTicketNumber("9018200Z"), true);
  assert.equal(isLegacyTicketNumber("#8907717"), true);
  assert.equal(isLegacyTicketNumber("11935498Z"), false);
});

test("tokens, queryTerms, matchesAllTokens e norm: frasi tra virgolette, accenti", () => {
  assert.deepEqual(tokens('Perché "cedolino errato" TFR'), ["perche", "cedolino errato", "tfr"]);
  assert.deepEqual(queryTerms('Perché "cedolino errato" TFR'), ["Perché", "cedolino errato", "TFR"]);
  assert.equal(matchesAllTokens("Calcolo detassazione su cedolino", "cedolino detassazione"), true);
  assert.equal(matchesAllTokens("Calcolo detassazione su cedolino", "cedolino ferie"), false);
  assert.equal(norm("  Città   Più "), "citta piu");
});

test("csvCell", () => {
  assert.equal(csvCell("a;b"), '"a;b"');
  assert.equal(csvCell('x"y'), '"x""y"');
  assert.equal(csvCell(null), "");
});

// ---------------------------------------------------------------- configurazione elenco

const CFG_SRC = [
  'Ext.define("x",{store:{proxy:{url:"/HDAPortal/WSCView/ListData/TicketConversationItems?_pl=en"},',
  'aliasExpressionMapping:{"c0":"Account.CompanyName","c1":"ID","c2":"Text","c3":"User.FullName"},',
  '"ViewID":"Default"},columns:[{dataIndex:"c2",text:"Detail",flex:1},{dataIndex:"c3",text:"User"}],',
  'items:[{id:"App_UC_defaultFilter_Default_filterText",itemId:"filterText","isFilter":true,"isDefaultFilter":true,hidden:true,"filterOperator":"sw",xtype:"textfield",emptyText:"Detail",name:"Text"},',
  '{id:"App_UC_filter_Default_filterText",itemId:"filterText","isFilter":true,"filterOperator":"sw",xtype:"textfield",fieldLabel:"Detail",name:"Text",listeners:{change:function(){const s=`{}`;if(a){b()}}},"filterExtensionKey":"FT_EXT"},',
  '{id:"App_UC_filter_Default_ModifiedBy",itemId:"ModifiedBy","isFilter":true,"filterOperator":"eq",xtype:"objectlink",fieldLabel:"Modified by",triggers:{"clear":{hidden:true}},listeners:{change:{fn:function(){}}},valueHiddenName:"id","filterExtensionKey":"MOD_EXT"},',
  '{id:"App_UC_filter_Default_AssignedUserOrGroupFilter",itemId:"AssignedUserOrGroupFilter",bin:[{id:"App_UC_filter_Default_AssignedUserOrGroupFilter_settingTriggerMenu",itemId:"settingTriggerMenu"}],"isFilter":true,"filterOperator":"eq",xtype:"objectlink",fieldLabel:"Assigned to",valueHiddenName:"AssignedUserOrGroupID"},',
  '{id:"App_UC_filter_Default_filterUserID",itemId:"filterUserID","isFilter":true,"filterOperator":"eq",xtype:"combo",fieldLabel:"User",name:"UserID",hidden:true}]});',
].join("");

test("parseListConfig: mappa colonne, colonne, filtri con filterExtensionKey, valueHiddenName e menu annidato", () => {
  const cfg = parseListConfig(CFG_SRC);
  assert.deepEqual(cfg.mapping, { c0: "Account.CompanyName", c1: "ID", c2: "Text", c3: "User.FullName" });
  assert.equal(cfg.reverse.ID, "c1");
  assert.equal(cfg.columns.c2, "Detail");
  assert.equal(cfg.viewId, "Default");
  assert.equal(cfg.storeUrl, "/HDAPortal/WSCView/ListData/TicketConversationItems?_pl=en");
  const byId = Object.fromEntries(cfg.filters.map((f) => [f.itemId, f]));
  assert.equal(byId.settingTriggerMenu, undefined);
  assert.equal(byId.AssignedUserOrGroupFilter.name, "AssignedUserOrGroupID");
  assert.equal(byId.AssignedUserOrGroupFilter.op, "eq");
  assert.equal(byId.filterText.op, "sw");
  assert.equal(byId.filterText.name, "Text");
  assert.equal(byId.filterText.label, "Detail");
  assert.equal(byId.filterText.hidden, false);
  assert.equal(byId.filterText.extKey, "FT_EXT");
  assert.equal(byId.ModifiedBy.name, "id");
  assert.equal(byId.ModifiedBy.extKey, "MOD_EXT");
  assert.equal(byId.ModifiedBy.hidden, false);
  assert.equal(byId.filterUserID.op, "eq");
  assert.equal(byId.filterUserID.hidden, true);
});

// ---------------------------------------------------------------- righe

test("makeRowReader: mappa di riserva (nessuna configurazione)", () => {
  const rr = makeRowReader(null);
  const r = rr.read({ c23: "12345678Z", c45: "Oggetto prova", c59: "S1", c20: "/Date(1700000000000)/", c16: "Mario", c17: "Rossi", c1: "Ditta Prova Srl" });
  assert.equal(r.id, "12345678Z");
  assert.equal(r.subject, "Oggetto prova");
  assert.equal(r.statusId, "S1");
  assert.equal(r.date.getTime(), 1700000000000);
  assert.equal(r.contact, "Mario Rossi");
  assert.equal(r.account, "Ditta Prova Srl");
  assert.equal(rr.sortAlias("date"), "c20");
});

test("makeRowReader: mappa dalla configurazione", () => {
  const rr = makeRowReader({ c0: "ID", c1: "Subject", c2: "Date", c3: "OwnerUserGroup.Description" });
  const r = rr.read({ c0: "22222222Z", c1: "Altro", c2: "/Date(1600000000000)/", c3: "Gruppo X" });
  assert.equal(r.id, "22222222Z");
  assert.equal(r.subject, "Altro");
  assert.equal(r.ownerGroup, "Gruppo X");
  assert.equal(rr.sortAlias("date"), "c2");
  assert.equal(rr.sortAlias("lastChange"), null);
});

// ---------------------------------------------------------------- filtri

test("buildConditions: formato verificato (Domain, eq con id, in con |)", () => {
  const f = { ...emptyFilters(), statuses: ["S1", "S2"], ownerGroups: [{ id: "G1", label: "Gruppo 1" }] };
  const c = buildConditions(f, {});
  assert.deepEqual(c[0], { property: "id", value: "1", op: "eq", extKey: "TICKETDOMAIN", id: "Domain" });
  assert.deepEqual(c.find((x) => x.property === "TicketStatusID"), { property: "TicketStatusID", value: "S1|S2", op: "in", id: "StatusFilter" });
  assert.deepEqual(c.find((x) => x.property === "OwnerUserGroupID"), { property: "OwnerUserGroupID", value: "G1", op: "eq", id: "OwnerUserGroupID" });
  const json = JSON.stringify(filterPayload(c));
  assert.match(json, /^\{"type":"AND","conditions":\[.*\],"subfilters":\[\]\}$/);
});

test("buildConditions: più gruppi → in; numero ticket → ID eq senza testo", () => {
  const f = { ...emptyFilters(), text: "10500123", ownerGroups: [{ id: "G1" }, { id: "G2" }] };
  const c = buildConditions(f, {});
  assert.deepEqual(c.find((x) => x.property === "OwnerUserGroupID"), { property: "OwnerUserGroupID", value: "G1|G2", op: "in", id: "OwnerUserGroupID" });
  assert.deepEqual(c.find((x) => x.id === "ID"), { property: "ID", value: "10500123Z", op: "eq", id: "ID" });
  assert.equal(c.some((x) => x.id === "FullText"), false);
});

test("ruleFor, isUnconstrained, hasNarrowingFilter, primaryTerm e condizioni per parole cercate", () => {
  assert.equal(primaryTerm(["info", "detassazione", "premi"]), "detassazione");
  const defText = ruleFor(DEF.text, {});
  assert.equal(defText.source, "verificato");
  assert.equal(defText.op, "eq");
  assert.equal(defText.extKey, "INCLUDECONVERSATIONITEM");
  const cfg = {
    config: [{ itemId: "FullText", op: "ct", name: "FullTextField" }, { itemId: "Subject", op: "in", name: "Subject" }],
    // una calibrazione errata senza wildcard (es. ct senza %) viene ignorata per non rompere la ricerca nell'oggetto
    containsText: { op: "ct", wildcard: false },
  };
  const r1 = ruleFor(DEF.text, cfg);
  assert.equal(r1.op, "ct");
  assert.equal(r1.property, "FullTextField");
  assert.equal(r1.source, "configurazione Touch");
  // Subject conserva "like" con "%…%"
  const rSub = ruleFor(DEF.subject, cfg);
  assert.equal(rSub.op, "like");
  assert.equal(rSub.wildcard, true);
  const cSub = buildConditions({ ...emptyFilters(), subject: "ricalcolo detassazione" }, cfg);
  assert.deepEqual(
    cSub.filter((x) => x.id === "Subject"),
    [
      { property: "Subject", value: "%ricalcolo%", op: "like", id: "Subject" },
      { property: "Subject", value: "%detassazione%", op: "like", id: "Subject" },
    ]
  );
  // Con primaryTermOnly invia a SQL Server il termine più selettivo (evitando l'OR lato server di Touch)
  const cPrimary = buildConditions(
    { ...emptyFilters(), text: "info detassazione", subject: "info detassazione" },
    { primaryTermOnly: true }
  );
  assert.deepEqual(
    cPrimary.filter((x) => x.id === "FullText"),
    [{ property: "FullText", value: "detassazione", op: "eq", extKey: "INCLUDECONVERSATIONITEM", id: "FullText" }]
  );
  assert.deepEqual(
    cPrimary.filter((x) => x.id === "Subject"),
    [{ property: "Subject", value: "%detassazione%", op: "like", id: "Subject" }]
  );

  const r2 = ruleFor(DEF.text, { ...cfg, learned: { FullText: { property: "FT", op: "like", value: "x" } } });
  assert.deepEqual([r2.property, r2.op, r2.source], ["FT", "like", "appreso da Touch"]);

  assert.equal(isUnconstrained(emptyFilters()), true);
  assert.equal(isUnconstrained({ ...emptyFilters(), text: "detassazione" }), false);
  assert.equal(hasNarrowingFilter({ ...emptyFilters(), text: "detassazione" }), false);
  assert.equal(hasNarrowingFilter({ ...emptyFilters(), text: "detassazione", ownerGroups: [{ id: "G1" }] }), true);
});

test("pickCalibrationSample estrae una parola non iniziale dall'oggetto", () => {
  const s = pickCalibrationSample("Notifica di creazione nuovo ticket - RICALCOLO DETASSAZIONE [11939865Z]");
  assert.equal(s.word, "Notifica");
  assert.equal(s.mid, "creazione");
  const s2 = pickCalibrationSample("Detassazione");
  assert.equal(s2.mid, "etassazione");
});

test("formatDateValue imita il formato appreso", () => {
  const ms = new Date(2026, 0, 15, 0, 0, 0).getTime();
  assert.equal(formatDateValue("2026-01-15", "/Date(1600000000000)/"), `/Date(${ms})/`);
  assert.equal(formatDateValue("2026-01-15", "01/02/2025"), "15/01/2026");
  assert.equal(formatDateValue("2026-01-15", "01/02/2025 10:00:00", true), "15/01/2026 23:59:59");
  assert.equal(formatDateValue("2026-01-15", "2025-02-01"), "2026-01-15");
  assert.equal(formatDateValue("2026-01-15", undefined), "2026-01-15T00:00:00");
  assert.equal(formatDateValue("2026-01-15", undefined, true), "2026-01-15T23:59:59");
});

test("learnFromConditions: salta Domain e filtri bloccati", () => {
  const L = learnFromConditions([
    { property: "id", value: "1", op: "eq", extKey: "TICKETDOMAIN", id: "Domain" },
    { property: "TicketStatusID", value: "S1|S2", op: "in", lock: true },
    { property: "Date", value: "/Date(1700000000000)/", op: "ge", id: "DateFromFilter" },
  ]);
  assert.deepEqual(Object.keys(L), ["DateFromFilter"]);
  assert.equal(L.DateFromFilter.op, "ge");
  // e la data successiva usa lo stesso formato
  const c = buildConditions({ ...emptyFilters(), dateFrom: "2026-03-01" }, { learned: L });
  assert.match(c.find((x) => x.id === "DateFromFilter").value, /^\/Date\(\d+\)\/$/);
});

test("describeFilters: gruppo di stati con il nome del gruppo", () => {
  const chips = describeFilters({ ...emptyFilters(), text: "cedolino", accounts: [{ id: "A1", label: "Ditta" }] });
  assert.deepEqual(chips.map((c) => c.key), ["text", "accounts"]);
  assert.match(chips[1].label, /Cliente: Ditta/);
});

// ---------------------------------------------------------------- testo ricco

test("htmlToText: paragrafi, a capo, entità, HTML codificato", () => {
  assert.equal(htmlToText("<p>Buongiorno,</p><p>il cedolino &egrave; errato<br>grazie</p>"), "Buongiorno,\n\nil cedolino è errato\ngrazie");
  assert.equal(htmlToText("&lt;p&gt;Ciao &amp;amp; arrivederci&lt;/p&gt;"), "Ciao & arrivederci");
  assert.equal(decodeEntities("&#8364; &#x41; &nbsp;"), "€ A \u00a0");
  assert.equal(unescapeIfEscapedHtml("a &lt; b"), "a &lt; b");
  assert.equal(cleanText("a\u200b\r\n\n\n\nb"), "a\n\nb");
});

test("splitQuoted: risposte citate in italiano e inglese", () => {
  const t = "Ecco la risposta.\n\nIl giorno 3 nov 2026, Mario ha scritto:\n> testo vecchio";
  assert.deepEqual(splitQuoted(t), { main: "Ecco la risposta.", quoted: "Il giorno 3 nov 2026, Mario ha scritto:\n> testo vecchio" });
  const t2 = "Ok grazie\nDa: Assistenza\nInviato: lunedì\nOggetto: prova\ncorpo";
  assert.equal(splitQuoted(t2).main, "Ok grazie");
  const t3 = "Da: qui inizia il testo ma non è una citazione\nfine";
  assert.equal(splitQuoted(t3).quoted, "");
});

test("linkifyParts: URL e numeri di ticket (8 cifre con Z, 7 cifre senza Z)", () => {
  const p = linkifyParts("vedi tk 10500123, #9042633 e https://example.com/x?y=1 non 2026 né 12345");
  assert.deepEqual(p.filter((x) => x.t !== "text").map((x) => x.t), ["ticket", "ticket", "url"]);
  assert.equal(p.filter((x) => x.t === "ticket")[0].id, "10500123Z");
  assert.equal(p.filter((x) => x.t === "ticket")[1].id, "9042633");
  assert.ok(p.find((x) => x.t === "url").v.startsWith("https://example.com/x?y=1"));
  assert.equal(p.filter((x) => x.t === "ticket").length, 2);
});

// ---------------------------------------------------------------- trasporto

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      status: r.status || 200,
      url,
      redirected: false,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? r.type || "application/json" : null) },
      text: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test("transport: JSON ok, invio form con cookie", () => {
  return (async () => {
    const f = fakeFetch(() => ({ body: JSON.stringify({ success: true, data: [1, 2], total: 2 }) }));
    const t = makeTransport({ base: "https://x/HDAPortal", fetch: f });
    const d = await t.request({ path: "/WSCView/ListData/Incidents", method: "POST", body: formBody({ a: 1, b: { c: 2 } }), expect: "json" });
    assert.deepEqual(d.data, [1, 2]);
    assert.equal(f.calls[0].init.credentials, "include");
    assert.equal(f.calls[0].init.body, "a=1&b=%7B%22c%22%3A2%7D");
  })();
});

test("transport: pagina di login → AuthError; success:false → HdaError", async () => {
  const login = fakeFetch(() => ({ type: "text/html", body: '<html><form action="/login"><input type="password"></form></html>' }));
  await assert.rejects(makeTransport({ base: "https://x", fetch: login }).request({ path: "/a", expect: "json" }), AuthError);
  const ko = fakeFetch(() => ({ body: JSON.stringify({ success: false, result: { desc: "campo sconosciuto" } }) }));
  await assert.rejects(makeTransport({ base: "https://x", fetch: ko }).request({ path: "/a", expect: "json" }), (e) => e instanceof HdaError && /campo sconosciuto/.test(e.message));
  const s401 = fakeFetch(() => ({ status: 401, body: "" }));
  await assert.rejects(makeTransport({ base: "https://x", fetch: s401 }).request({ path: "/a", expect: "json" }), AuthError);
});

test("hda: listData invia il formato verificato e legge l'utente dal token", async () => {
  const payload = Buffer.from(JSON.stringify({ wsc_uid: "U123" })).toString("base64url");
  const token = Buffer.from(`xx.${payload}.yy`).toString("base64");
  const f = fakeFetch(() => ({ body: JSON.stringify({ success: true, data: [{ c0: "a" }], total: 7, requestToken: token }) }));
  const hda = makeHda(makeTransport({ base: "https://x/HDAPortal", fetch: f }));
  const { rows, total } = await hda.listData("Incidents", { conditions: [{ property: "ID", value: "1Z", op: "eq" }], limit: 50, sort: [{ property: "c20", direction: "DESC" }] });
  assert.equal(total, 7);
  assert.equal(rows.length, 1);
  assert.equal(hda.currentUserId, "U123");
  const call = f.calls[0];
  assert.match(call.url, /^https:\/\/x\/HDAPortal\/WSCView\/ListData\/Incidents\?_pl=en&_dc=\d+$/);
  const body = new URLSearchParams(call.init.body);
  assert.equal(body.get("ViewID"), "Default");
  assert.equal(body.get("limit"), "50");
  assert.deepEqual(JSON.parse(body.get("filter")), { type: "AND", conditions: [{ property: "ID", value: "1Z", op: "eq" }], subfilters: [] });
  assert.deepEqual(JSON.parse(body.get("sort")), [{ property: "c20", direction: "DESC" }]);
});

test("hda: projection rimappa le colonne sulle espressioni", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ success: true, data: [{ ID: "1", User_FullName: "Op Uno" }] }) }));
  const hda = makeHda(makeTransport({ base: "https://x/HDAPortal", fetch: f }));
  const rows = await hda.projection("TicketConversationItem", [], ["ID", "User.FullName"], 10);
  assert.deepEqual(rows, [{ ID: "1", "User.FullName": "Op Uno" }]);
  const body = new URLSearchParams(f.calls[0].init.body);
  assert.equal(body.get("entity"), "TicketConversationItem");
  assert.deepEqual(JSON.parse(body.get("columnNames")), ["ID", "User_FullName"]);
  assert.deepEqual(JSON.parse(body.get("columnExpressions")), ["ID", "User.FullName"]);
});

// ---------------------------------------------------------------- vecchio cruscotto (Area Riservata)

test("ar: extractMcidFromHtml, buildArQuery (NumTic, prefissi * e AND tra parole), parseArResponse (HTML comment) e splitArTesti", () => {
  const info = extractMcidFromHtml('var w_IdCenSer="PAOW"; var w_pArea="TICKOPEXXX"; this.splResults.m_cID = "869b6b5acf5d583993b21322b693202a";');
  assert.deepEqual(info, { mcid: "869b6b5acf5d583993b21322b693202a", idCenSer: "PAOW", pArea: "TICKOPEXXX" });

  // Ricerca per più parole/radici concatenate in AND (formato reale di spsl_fquery_mc con prefisso parola*)
  const qWords = buildArQuery({ text: "voc retributiv", idCenSer: "PAOW" });
  assert.equal(
    qWords,
    "IdCenSer:PAOW and ( Testi:(voc or voc*) or Oggetto:(voc or voc*) ) and ( Testi:(retributiv or retributiv*) or Oggetto:(retributiv or retributiv*) )"
  );

  // Ricerca per numero ticket a 7 cifre tramite il campo Solr NumTic
  const qTid = buildArQuery({ ticketId: "9018200Z", idCenSer: "PAOW" });
  assert.equal(qTid, "IdCenSer:PAOW and NumTic:9018200");

  // Risposta HTML reale di spsl_fquery_mc con commento `<!-- Function return value:{...} -->` e riga sentinella finale
  const sampleHtml = [
    "<!doctype html><html><body><p class='TabLabel'>Ok routine eseguita.</p><!--",
    "Function return value:" +
      JSON.stringify({
        fields: ["id", "type", "description", "altDescription", "NumTic", "IdStato", "StatoBase", "IdProdotto", "Oggetto", "DataApe", "IdCenSer", "IdGruppo", "Testi", "url1"],
        data: [
          [
            "000000009021830",
            "TICKOPE003",
            "[#9018200] [PAGHEW] [02-09-2026] Gestione contrattuale festività cadenti di domenica",
            "<div>Buongiorno, il cliente ha una ditta...</div>",
            "9018200",
            "CLOSE",
            "C",
            "PAGHEW",
            "Gestione contrattuale festività cadenti di domenica",
            "2026-09-02 15:30:31.0",
            "PAOW",
            "10663",
            "Buongiorno, richiesta del cliente con freccia --> interna.  Ticket preassegnato dal dispatcher automatico alla coda operatore.  Ticket preassegnato dal dispatcher automatico alla coda operatore.  Buongiorno, ecco la prima risposta operatore.  Ciao, replica del cliente.  Ciao, ecco la soluzione finale.  Gentile cliente, In riferimento alla richiesta di assistenza in oggetto, procediamo alla chiusura.",
            "gspv_psearch_card.jsp?w_TTCODICE=000000009021830",
          ],
          "t,CCCCCCCCCCCCCC,-1",
        ],
      }),
    "--></body></html>",
  ].join("\n");

  const rows = parseArResponse(sampleHtml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "9018200");
  assert.equal(rows[0].source, "ar");
  assert.equal(rows[0].catalog, "PAGHEW");
  assert.equal(rows[0].ownerGroup, "PAOW · 10663");
  assert.equal(rows[0].subject, "Gestione contrattuale festività cadenti di domenica");
  assert.equal(rows[0].arUrl, "https://www.zucchetti.it/areariservata/jsp/gspv_psearch_card.jsp?w_TTCODICE=000000009021830");

  const full = buildArTicket({ id: "9018200", row: rows[0] });
  assert.equal(full.id, "9018200");
  assert.equal(full.source, "ar");
  assert.equal(full.timeline.length, 6);
  assert.equal(full.timeline[0].kind, "request");
  assert.equal(full.timeline[1].internal, true);
  assert.equal(full.timeline[4].kind, "solution");
  assert.equal(full.timeline[5].internal, true);
});

test("loadTicket: risolve i ticket a 7 cifre senza Z su HDA TOUCH (es. 9042633) anche se aperti dalla ricerca per parole", async () => {
  const fakeHda = {
    async projection(entity, conditions) {
      const idVal = conditions && conditions[0] && conditions[0].value;
      if (entity === "Incident") {
        // Su HDA TOUCH i ticket a 7 cifre hanno ID = "9042633" (senza Z)
        if (idVal === "9042633") {
          return [{ ID: "9042633", Subject: "Allineamento voci retributive", Problem: "Richiesta completa del cliente", Solution: "Soluzione applicata" }];
        }
        return [];
      }
      if (entity === "TicketConversationItem") {
        if (idVal === "9042633") {
          return [{ ID: "C1", CreationDate: "/Date(1700000000000)/", Text: "Risposta completa operatore", Type: 4, Visibility: true, "User.FullName": "Mario Rossi" }];
        }
        return [];
      }
      return [];
    },
    async get() {
      throw new Error("Object Not Found");
    },
    async listData() {
      return { rows: [], total: 0 };
    },
  };
  const rowFromList = { id: "9042633", subject: "Allineamento voci retributive", problem: "Anteprima" };
  const full = await loadTicket(fakeHda, "9042633", { row: rowFromList });
  assert.equal(full.id, "9042633");
  assert.ok(full.ticket);
  assert.equal(full.ticket.Problem, "Richiesta completa del cliente");
  assert.equal(full.notes.length, 0);
  assert.equal(full.timeline.length, 3);
});

test("allegati: normalizeAttachment, parsePreviewAttachmentResponse e hda.listAttachments / previewAttachment", async () => {
  const rawRow = {
    c7: "11944440Z",
    c3: "Customer Portal",
    c4: "A7593422Z",
    c0: "application/pdf",
    c5: "/Date(1794228998220)/",
    c1: "retribuzione lavoratore a chiamata.pdf",
    c6: "Incident",
    c2: "retribuzione lavoratore a chiamata.pdf",
  };
  const att = normalizeAttachment(rawRow, "11944440Z");
  assert.equal(att.id, "A7593422Z");
  assert.equal(att.fileName, "retribuzione lavoratore a chiamata.pdf");
  assert.equal(att.contentType, "application/pdf");
  assert.equal(att.author, "Customer Portal");
  assert.equal(att.parentObject, "Incident");
  assert.equal(att.parentObjectId, "11944440Z");
  assert.equal(att.date.getTime(), 1794228998220);
  assert.equal(guessMimeFromName("stampa.csv"), "text/csv");

  // Risposta reale Ext.NET di /WSCView/PreviewAttachment
  const extNetScript =
    'Ext.ComponentManager.onAvailable("window-3813",function(){Ext.getCmp("window-3813").add({bin:[{"ConfigurationHolder":true,"model":"{\\"contentType\\":\\"application/pdf\\",\\"content\\":\\"JVBERi0xLjQK\\",\\"fileName\\":\\"retribuzione lavoratore a chiamata.pdf\\"}"}]});});';
  const parsed = parsePreviewAttachmentResponse(extNetScript);
  assert.deepEqual(parsed, {
    contentType: "application/pdf",
    content: "JVBERi0xLjQK",
    fileName: "retribuzione lavoratore a chiamata.pdf",
  });

  const f = fakeFetch((url) => {
    if (url.includes("/WSCView/ListData/Attachments")) {
      return { body: JSON.stringify({ success: true, data: [rawRow], total: 1 }) };
    }
    if (url.includes("/WSCView/PreviewAttachment")) {
      return { type: "application/javascript", body: extNetScript };
    }
    return { body: JSON.stringify({ success: true, data: [] }) };
  });
  const hda = makeHda(makeTransport({ base: "https://x/HDAPortal", fetch: f }));
  const list = await hda.listAttachments("11944440Z");
  assert.equal(list.length, 1);
  const filterSent = JSON.parse(new URLSearchParams(f.calls[0].init.body).get("filter"));
  assert.equal(filterSent.conditions[0].property, "ParentObjectID");
  assert.equal(filterSent.conditions[0].value, "11944440Z");
  assert.equal(filterSent.conditions[0].extKey, "EXTEND_TICKET_ATTACHMENT");

  const prev = await hda.previewAttachment("A7593422Z", {
    parentObject: "Incident",
    parentObjectId: "11944440Z",
    contentType: "application/pdf",
    fileName: "retribuzione lavoratore a chiamata.pdf",
  });
  assert.equal(prev.content, "JVBERi0xLjQK");
  assert.equal(prev.fileName, "retribuzione lavoratore a chiamata.pdf");
});
