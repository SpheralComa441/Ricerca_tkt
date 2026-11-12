// Test delle librerie (node --test extension/test). Dati sintetici: nessun dato reale del portale.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMsDate, ticketIdFrom, ticketIdVariants, ticketNumber, isLegacyTicketNumber, isTouchNativeId, ticketMergeKey, tokens, queryTerms, matchesAllTokens, norm, csvCell, fmtDate } from "../lib/util.js";
import { parseListConfig } from "../lib/listconfig.js";
import { makeRowReader } from "../lib/rows.js";
import { buildConditions, emptyFilters, formatDateValue, learnFromConditions, ruleFor, DEF, describeFilters, filterPayload, pickCalibrationSample, isUnconstrained, hasNarrowingFilter, primaryTerm } from "../lib/filters.js";
import { htmlToText, splitQuoted, linkifyParts, decodeEntities, unescapeIfEscapedHtml, cleanText } from "../lib/richtext.js";
import { makeTransport, AuthError, HdaError, formBody, abortable } from "../lib/transport.js";
import { makeHda, parsePreviewAttachmentResponse, guessMimeFromName } from "../lib/hda.js";
import { buildArQuery, parseArResponse, buildArTicket, extractMcidFromHtml, extractCentreFromForm, splitArTesti, makeAr, emptyArFilters, hasArFilter } from "../lib/ar.js";
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

test("numero ticket ↔ ID HDA: 8 cifre → Z, 5-7 cifre senza Z, la Z scritta resta, varianti ID", () => {
  assert.equal(ticketIdFrom("10500123"), "10500123Z");
  assert.equal(ticketIdFrom(" #10500123 "), "10500123Z");
  assert.equal(ticketIdFrom("10500123z"), "10500123Z");
  assert.equal(ticketIdFrom("9018200"), "9018200");
  assert.equal(ticketIdFrom("9042633"), "9042633");
  // ticket nativo di Touch a 7 cifre: la Z scritta dall'utente non si perde
  assert.equal(ticketIdFrom("9042633Z"), "9042633Z");
  assert.equal(ticketIdFrom("tk 11943797"), "11943797Z");
  assert.equal(ticketIdFrom("TKT#9876543z"), "9876543Z");
  assert.equal(ticketIdFrom("ticket n. 8900042"), "8900042");
  // senza Z si provano entrambe le forme; con la Z solo quella
  assert.deepEqual(ticketIdVariants("9042633"), ["9042633", "9042633Z"]);
  assert.deepEqual(ticketIdVariants("9042633Z"), ["9042633Z"]);
  assert.deepEqual(ticketIdVariants("10500123"), ["10500123Z", "10500123"]);
  assert.deepEqual(ticketIdVariants("10500123Z"), ["10500123Z"]);
  assert.equal(ticketIdFrom("cedolino"), null);
  assert.equal(ticketIdFrom("12 34"), null);
  assert.equal(ticketIdFrom("tk"), null);
  assert.equal(ticketNumber("10500123Z"), "10500123");
  assert.equal(ticketNumber("9042633"), "9042633");
  assert.equal(isLegacyTicketNumber("9018200"), true);
  assert.equal(isLegacyTicketNumber("#8907717"), true);
  assert.equal(isLegacyTicketNumber("9018200Z"), false);
  assert.equal(isLegacyTicketNumber("11935498Z"), false);
  assert.equal(isTouchNativeId("9876543Z"), true);
  assert.equal(isTouchNativeId("9876543"), false);
});

test("ticketMergeKey: un ticket di Touch con la Z non si unisce al ticket del Vecchio Cruscotto con le stesse cifre", () => {
  assert.notEqual(ticketMergeKey({ id: "9876543Z" }), ticketMergeKey({ id: "9876543", source: "ar" }));
  // Touch migrato (senza Z) e Vecchio Cruscotto con lo stesso numero sono lo stesso ticket
  assert.equal(ticketMergeKey({ id: "9042633" }), ticketMergeKey({ id: "9042633", source: "ar" }));
  assert.equal(ticketMergeKey({ id: "11943797Z" }), ticketMergeKey({ id: "11943797z" }));
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
  const z = linkifyParts("vedi 9876543Z");
  assert.equal(z.find((x) => x.t === "ticket").id, "9876543Z");
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
  // lingua del portale come la pagina di Touch (_pl=it nelle richieste reali)
  assert.match(call.url, /^https:\/\/x\/HDAPortal\/WSCView\/ListData\/Incidents\?_pl=it&_dc=\d+$/);
  hda.setLang("en");
  await hda.listData("Incidents", {});
  assert.match(f.calls[1].url, /\?_pl=en&/);
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
    "IdCenSer:PAOW and ( Testi:(voc OR voc*) or Oggetto:(voc OR voc*) ) and ( Testi:(retributiv OR retributiv*) or Oggetto:(retributiv OR retributiv*) )"
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

// ---------------------------------------------------------------- Vecchio Cruscotto: formato reale di spsl_fquery_mc

// Elenco dei campi come nella risposta reale (42 colonne); i valori delle righe sono inventati.
const AR_FIELDS = ["type", "category", "id", "description", "altDescription", "attachmentData", "entityName", "NumTic", "IdStato", "StatoBase", "IdPriorita", "IdTipologia", "Durata", "Lavoro", "IdGruppo", "IdOperatore", "IdCliente", "IdPersCli", "IdProdotto", "IdSede", "Oggetto", "DataApe", "IdCenSer", "IdArgomenti", "IdClassificazioni", "IdRifTick", "IdRifPers", "IdRifAzi", "Testi", "IdMeseA", "IdAnnoA", "IdMeseM", "IdAnnoM", "IdOperatoreIn", "IdGruppoIn", "img", "url1", "url2", "url2lbl", "urlPublic", "mimeType", "viewFields"];
function arRow({ num, code, subject, date, testi, gruppo = "10663" }) {
  const v = Object.fromEntries(AR_FIELDS.map((f) => [f, ""]));
  Object.assign(v, {
    type: "TICKOPE003", category: "TICKOPE003", id: code, entityName: "sipv_aticketssolrTICKOPE003",
    description: `[#${num}] [PAGHEW] [${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}] <span style="font-weight:bold;" solrfound="true">${subject}</span>`,
    altDescription: `<div style="padding-top:2px;">${testi.slice(0, 60)}</div>`,
    NumTic: num, IdStato: "CLOSE", StatoBase: "C", IdPriorita: "LOW", IdTipologia: "INFO", IdGruppo: gruppo,
    IdProdotto: "PAGHEW", Oggetto: subject, DataApe: `${date} 14:14:58.0`, IdCenSer: "PAOW", Testi: testi,
    url1: `gspv_psearch_card.jsp?w_TTCODICE=${code}`,
  });
  return AR_FIELDS.map((f) => v[f]);
}
function arPage(rows) {
  const payload = { data: [...rows, "t,CCCCCCCCCCCCCCCCCCCC,-1"], maxResults: [210], fields: AR_FIELDS, facet: [["TICKOPE003", rows.length, "TICKET"]], errors: [] };
  return `<!doctype html>\n<html><body>\n<p class='TabLabel' style='margin:0'>Ok routine eseguita.</p>\n<!--\nFunction return value:${JSON.stringify(payload)}\n -->\n</body>\n</html>`;
}

test("ar: risposta nel formato reale (42 campi, riga sentinella, maxResults) e filtro gruppo/anno", () => {
  const html = arPage([
    arRow({ num: "8900042", code: "000000008903653", subject: "detassazione", date: "2026-04-21", testi: "detassazione pregresso  spiegata la detassazione" }),
    arRow({ num: "8916529", code: "000000008920147", subject: "ricalcolo detassazione", date: "2026-05-07", testi: "ricalcolo detassazione versione 26.05.00  informazioni sul ricalcolo" }),
  ]);
  const rows = parseArResponse(html);
  assert.deepEqual(rows.map((r) => r.id), ["8900042", "8916529"]);
  assert.equal(rows[0].ownerGroup, "PAOW · 10663");
  assert.equal(rows[0].statusId, "S5"); // Chiuso (S8 su Touch è uno stato aperto)
  assert.equal(rows[0].date.getFullYear(), 2026);
  assert.equal(rows[1].arUrl, "https://www.zucchetti.it/areariservata/jsp/gspv_psearch_card.jsp?w_TTCODICE=000000008920147");

  // gruppo come nella Ricerca rapida (… and IdGruppo:10663) e anni di apertura
  assert.equal(
    buildArQuery({ text: "detassazione", idCenSer: "PAOW", groups: ["10663"] }),
    "IdCenSer:PAOW and ( Testi:(detassazione OR detassazion*) or Oggetto:(detassazione OR detassazion*) ) and IdGruppo:10663"
  );
  assert.match(buildArQuery({ text: "x", groups: ["10663", "10552"] }), /\( IdGruppo:10663 or IdGruppo:10552 \)$/);
  assert.match(buildArQuery({ text: "cud", dateFrom: "2020-01-01", dateTo: "2026-12-31" }), /^\( \(IdAnnoA:2020 \) or .*\(IdAnnoA:2026 \) \) and /);
});

test("ar: loadTicket apre solo il ticket con quel numero; senza collegamento non riprova a ogni ricerca", async () => {
  const portlet = "this.splResults.m_cID='f0f7834fde6879c8685311c282f6734a';";
  const seen = [];
  let answer = arPage([arRow({ num: "8916529", code: "000000008920147", subject: "cita 8900042 nel testo", date: "2026-05-07", testi: "vedi 8900042" })]);
  const fetchImpl = async (url, init = {}) => {
    seen.push(url.replace(/^.*areariservata\//, "") + (init.body && init.body.startsWith("pKeyword=") ? " " + decodeURIComponent(init.body.split("&")[0].slice(9)) : ""));
    const body = /portlet\.jsp$/.test(url) ? portlet : /spsl_fquery_mc$/.test(url) ? answer : "<html></html>";
    return { ok: true, status: 200, text: async () => body };
  };
  const ar = makeAr({ fetch: fetchImpl });
  // la ricerca larga trova solo un ALTRO ticket che cita il numero: non va aperto al posto di 8900042
  await assert.rejects(() => ar.loadTicket("8900042"), /non trovato/);
  assert.ok(seen.some((s) => s.endsWith("NumTic:8900042")));

  answer = arPage([arRow({ num: "8900042", code: "000000008903653", subject: "detassazione", date: "2026-04-21", testi: "Richiesta  Risposta" })]);
  const full = await ar.loadTicket("8900042");
  assert.equal(full.id, "8900042");
  assert.equal(full.source, "ar");

  // nessuna sessione: il primo tentativo cerca il collegamento, quelli subito dopo no
  const calls = [];
  const offline = makeAr({ fetch: async (url) => (calls.push(url), { ok: true, status: 200, text: async () => "<html>login</html>" }) });
  await assert.rejects(() => offline.search({ text: "cud" }), /non collegato/);
  const n = calls.length;
  await assert.rejects(() => offline.search({ text: "cud" }), /non collegato/);
  assert.equal(calls.length, n, "nessuna richiesta in più entro un minuto");
});

// ---------------------------------------------------------------- correzioni della revisione

test("splitQuoted: righe citate con '>' in una sola scansione (messaggi molto lunghi restano veloci)", () => {
  const long = ["Risposta nuova", ...Array.from({ length: 20000 }, (_, i) => (i % 50 === 0 ? "" : "> riga citata " + i))].join("\n");
  const t0 = Date.now();
  const r = splitQuoted(long);
  assert.ok(Date.now() - t0 < 500, "troppo lento");
  assert.equal(r.main, "Risposta nuova");
  assert.ok(r.quoted.startsWith("> riga citata 1"));
  assert.deepEqual(splitQuoted("a\n> b\nc\n> d"), { main: "a\n> b\nc", quoted: "> d" });
});

test("stati sconosciuti: 'In attesa di chiusura' è in attesa, non chiuso", async () => {
  const { mergePortalStatuses, statusInfo } = await import("../lib/statuses.js");
  mergePortalStatuses([{ ID: "X91", Description: "In attesa di chiusura" }, { ID: "X92", Description: "Closed by customer" }]);
  assert.equal(statusInfo("X91").group, "waiting");
  assert.equal(statusInfo("X92").group, "closed");
  assert.equal(statusInfo("S5").group, "closed");
});

test("lookups: un solo caricamento dell'elenco completo alla volta e segno 'completo' salvato", async () => {
  const { makeLookups } = await import("../lib/lookups.js");
  const kv = {};
  let calls = 0;
  const hda = { async projection() { calls++; await new Promise((r) => setTimeout(r, 30)); return [{ ID: "U1", FullName: "Laura Verdi", Active: true }]; } };
  const lk = makeLookups(hda, { kvGet: async (k, d) => kv[k] ?? d, kvSet: async (k, v) => { kv[k] = v; } });
  const [a, b] = await Promise.all([lk.loadFull("users"), lk.loadFull("users")]);
  assert.equal(a && b, true);
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 1700)); // salvataggio rimandato di 1,5 s
  assert.equal(kv.lookups.full.loaded.users, true);
  const again = makeLookups(hda, { kvGet: async (k, d) => kv[k] ?? d, kvSet: async (k, v) => { kv[k] = v; } });
  await again.restore();
  await again.loadFull("users");
  assert.equal(calls, 1, "dopo il riavvio l'elenco completo non si riscarica");
});

// ---------------------------------------------------------------- trasporto: errore del collegamento del portale

const INFRA = JSON.stringify({ success: false, result: { desc: "An error occourred on the webservice underlying connection. Check webservice URL and server configuration parameters!" } });
const LOADERR = JSON.stringify({ success: false, result: { desc: "Si è verificato un errore durante il caricamento dei dati." } });
const OK = JSON.stringify({ success: true, data: [{ ID: "S1" }], total: 1 });

test("transport: errore del collegamento del portale in diretta → stessa richiesta dalla scheda di Touch, poi resta lì", async () => {
  const fetch = fakeFetch(() => ({ body: INFRA }));
  const sent = [];
  const modes = [];
  const t = makeTransport({ base: "https://x/HDAPortal", fetch, sendMessage: async (m) => (sent.push(m), { status: 200, contentType: "application/json", text: OK }), onModeChange: (m) => modes.push(m) });
  const d = await t.request({ path: "/WSCView/GetStaticList?_pl=it&entity=TicketStatuses", expect: "json" });
  assert.equal(d.data[0].ID, "S1");
  assert.equal(fetch.calls[0].init.cache, "no-store", "un errore memorizzabile 60 s non deve restare nella cache del browser");
  assert.equal(sent[0].type, "hda-proxy");
  assert.equal(t.mode, "proxy");
  assert.deepEqual(modes, ["proxy"]);
  await t.request({ path: "/WSCView/GetStaticList", expect: "json" });
  assert.equal(fetch.calls.length, 1, "le richieste successive passano subito dalla scheda");
});

test("transport: errore del collegamento senza scheda di Touch → AuthError che spiega di aprirla", async () => {
  const t = makeTransport({ base: "https://x/HDAPortal", fetch: fakeFetch(() => ({ body: INFRA })), sendMessage: async () => ({ error: "no-tab" }) });
  await assert.rejects(() => t.request({ path: "/WSCView/GetStaticList", expect: "json" }), (e) => e instanceof AuthError && /underlying connection/.test(e.message) && /Apri HDA TOUCH/.test(e.message));
  assert.equal(t.mode, "direct");
});

test("transport: errore anche dalla scheda → messaggio che dice di ricaricare Touch", async () => {
  const t = makeTransport({ base: "https://x/HDAPortal", fetch: fakeFetch(() => ({ body: INFRA })), sendMessage: async () => ({ status: 200, contentType: "application/json", text: INFRA }) });
  await assert.rejects(() => t.request({ path: "/WSCView/GetStaticList", expect: "json" }), (e) => e instanceof HdaError && /ricarica la pagina di HDA TOUCH/.test(e.message));
});

test("transport: dalla scheda (modo ricordato) ma scheda chiusa → diretta", async () => {
  const fetch = fakeFetch(() => ({ body: OK }));
  const t = makeTransport({ base: "https://x/HDAPortal", mode: "proxy", fetch, sendMessage: async () => ({ error: "no-tab" }) });
  const d = await t.request({ path: "/WSCView/GetStaticList", expect: "json" });
  assert.equal(d.total, 1);
  assert.equal(t.mode, "direct");
});

test("transport: 'errore durante il caricamento dei dati' dopo che la strada ha già funzionato è un errore della ricerca, non si ripete", async () => {
  let n = 0;
  const fetch = fakeFetch(() => ({ body: n++ === 0 ? OK : LOADERR }));
  let proxied = 0;
  const t = makeTransport({ base: "https://x/HDAPortal", fetch, sendMessage: async () => (proxied++, { status: 200, contentType: "application/json", text: OK }) });
  await t.request({ path: "/a", expect: "json" });
  await assert.rejects(() => t.request({ path: "/b", expect: "json" }), /caricamento dei dati/);
  assert.equal(proxied, 0);
});

test("transport: una richiesta dalla scheda di Touch si può annullare (non si aspetta la risposta)", async () => {
  let release;
  const slow = new Promise((r) => (release = r));
  const t = makeTransport({ base: "https://x/HDAPortal", mode: "proxy", fetch: fakeFetch(() => ({ body: OK })), sendMessage: () => slow.then(() => ({ status: 200, contentType: "application/json", text: OK })) });
  const ac = new AbortController();
  const p = t.request({ path: "/WSCView/ListData/Incidents", method: "POST", body: "a=1", expect: "json", signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  release();
  // abortable: senza segnale resta la promessa; già annullato → rifiuta subito; risultato normale passa
  assert.equal(await abortable(Promise.resolve(7)), 7);
  assert.equal(await abortable(Promise.resolve(8), new AbortController().signal), 8);
  const done = new AbortController();
  done.abort();
  await assert.rejects(abortable(new Promise(() => {}), done.signal), (e) => e.name === "AbortError");
});

test("ar: centro servizi ricavato dai ticket del proprio gruppo; le parole non si cercano fuori dal centro", async () => {
  const portlet = "this.splResults.m_cID='f0f7834fde6879c8685311c282f6734a';"; // la pagina non riporta il centro
  const queries = [];
  const fetchImpl = async (url, init = {}) => {
    let body = "<html></html>";
    if (/portlet\.jsp$/.test(url)) body = portlet;
    else if (/spsl_fquery_mc$/.test(url)) {
      const q = decodeURIComponent(init.body.split("&")[0].slice(9));
      queries.push(q);
      // ticket del gruppo 10663: tutti del centro PAOW; le parole nel proprio centro non trovano nulla
      body = q === "IdGruppo:10663"
        ? arPage([arRow({ num: "8900042", code: "000000008903653", subject: "a", date: "2026-04-21", testi: "x" }), arRow({ num: "8916529", code: "000000008920147", subject: "b", date: "2026-05-07", testi: "y" })])
        : /^IdCenSer:PAOW and /.test(q) ? arPage([]) : arPage([arRow({ num: "7000001", code: "000000007000001", subject: "ticket di un partner", date: "2026-05-07", testi: "cud" })]);
    }
    return { ok: true, status: 200, text: async () => body };
  };
  const ar = makeAr({ fetch: fetchImpl });
  await ar.checkStatus();
  assert.equal(ar.state.idCenSer, "", "dalla pagina il centro non si ricava");
  assert.equal(await ar.findCentre(["10663"]), "PAOW");
  assert.equal(ar.state.idCenSer, "PAOW");
  const rows = await ar.search({ text: "cud" });
  assert.deepEqual(rows, [], "niente nel proprio centro: non si pescano i ticket degli altri centri");
  assert.ok(queries.every((q) => q === "IdGruppo:10663" || q.startsWith("IdCenSer:PAOW and ")), queries.join(" | "));
  // un numero ticket invece si cerca anche fuori dal centro
  const byNum = await ar.search({ ticketId: "7000001" });
  assert.equal(byNum[0].id, "7000001");
  // centro scritto a mano nelle impostazioni
  const manual = makeAr({ fetch: fetchImpl });
  manual.setCentre("paox");
  assert.equal(manual.state.idCenSer, "PAOX");
  manual.setCentre("non valido!");
  assert.equal(manual.state.idCenSer, "PAOX");
});

test("ar: centro servizi letto dal modulo di ricerca del portale; i ticket degli altri centri si scartano", async () => {
  const FORM = `<script>\nDeclareWVs('PAOW','',new Date(2026,10,10,0,0,0,0),['',''],0);\n</script>
<select name='CentroServizi' id='MQCQNKQMGB' class='Combobox' title='Centro servizi'><option value=''></option>\n<option value='PAOW' >[HR] Paghe Infinity</option>\n</select>`;
  assert.equal(extractCentreFromForm(FORM), "PAOW");
  assert.equal(extractCentreFromForm("<html>login</html>"), "");
  const two = `<script>DeclareWVs('','PRES1',new Date(2026,0,1),0);</script><select name='CentroServizi'><option value=''></option><option value='PAOW'>a</option><option value='PRES1' >b</option></select>`;
  assert.equal(extractCentreFromForm(two), "PRES1", "con più centri vale quello preselezionato");
  assert.equal(extractCentreFromForm(two.replace("'PRES1',new", "'',new")), "", "più centri e nessuno preselezionato: non si tira a indovinare");

  const queries = [];
  const partner = arRow({ num: "7000001", code: "000000007000001", subject: "cud di un partner", date: "2026-05-07", testi: "cud" });
  partner[AR_FIELDS.indexOf("IdCenSer")] = "GZ067";
  const fetchImpl = async (url, init = {}) => {
    let body = "<html></html>";
    if (/gspv_winf_search/.test(url)) body = FORM;
    else if (/portlet\.jsp$/.test(url)) body = "this.splResults.m_cID='f0f7834fde6879c8685311c282f6734a';";
    else if (/spsl_fquery_mc$/.test(url)) {
      queries.push(decodeURIComponent(init.body.split("&")[0].slice(9)));
      body = arPage([arRow({ num: "8900042", code: "000000008903653", subject: "cud", date: "2026-04-21", testi: "cud" }), partner]);
    }
    return { ok: true, status: 200, text: async () => body };
  };
  const ar = makeAr({ fetch: fetchImpl });
  assert.equal(await ar.findCentre(["10663"]), "PAOW");
  assert.deepEqual(queries, [], "dal modulo: nessuna ricerca per ricavarlo");
  const rows = await ar.search({ text: "cud" });
  assert.deepEqual(rows.map((r) => r.id), ["8900042"], "il ticket del centro di un partner non compare");
  assert.match(queries[0], /^IdCenSer:PAOW and /);
});

test("ar: filtri della Ricerca rapida (gruppo, operatore, cliente, stato, chi ha partecipato, periodo) anche senza parole", async () => {
  assert.equal(hasArFilter(emptyArFilters()), false);
  assert.equal(hasArFilter({ ...emptyArFilters(), searchIn: "1", dateRef: "2" }), false, "le sole opzioni non sono un filtro");
  assert.equal(hasArFilter({ ...emptyArFilters(), groupIn: "50454" }), true);
  assert.equal(buildArQuery({ idCenSer: "PAOW" }), "", "senza parole e senza filtri non si cerca tutto il centro");

  // come nella ricerca reale del portale: … and ( Testi:(x) or Oggetto:(x) ) and IdOperatore:… and IdCliente:…
  assert.equal(
    buildArQuery({ text: "cud", idCenSer: "PAOW", operator: "000000000100001", clientCode: "1234" }),
    "IdCenSer:PAOW and ( Testi:(cud OR cud*) or Oggetto:(cud OR cud*) ) and IdOperatore:000000000100001 and IdCliente:000000000001234",
  );
  // solo filtri: il gruppo che ha partecipato si cerca nelle due forme in cui può essere scritto nell'indice
  assert.equal(buildArQuery({ idCenSer: "PAOW", groupsIn: ["50454"] }), "IdCenSer:PAOW and ( IdGruppoIn:50454 or IdGruppoIn:50454.0 )");
  assert.equal(
    buildArQuery({ idCenSer: "PAOW", groups: ["10663"], statoBase: "C", operatorIn: "100002" }),
    "IdCenSer:PAOW and IdGruppo:10663 and StatoBase:C and IdOperatoreIn:000000000100002",
  );
  // periodo: a mesi, riferito all'ultimo aggiornamento (M) o all'apertura (A)
  assert.equal(
    buildArQuery({ idCenSer: "PAOW", dateFrom: "2026-09-01", dateTo: "2026-11-30", dateRef: "1", statoBase: "A" }),
    "IdCenSer:PAOW and ( (IdMeseM:9 and IdAnnoM:2026) or (IdMeseM:10 and IdAnnoM:2026) or (IdMeseM:11 and IdAnnoM:2026) ) and StatoBase:A",
  );
  assert.match(buildArQuery({ dateFrom: "2026-09-01", dateTo: "2026-09-30", dateRef: "2" }), /^\( \(IdMeseA:9 and IdAnnoA:2026\) \)$/);
  const y = new Date().getFullYear();
  assert.match(buildArQuery({ text: "cud", dateTo: `${y}-02-10`, dateRef: "1" }), new RegExp(`^\\( \\(IdMeseM:1 and IdAnnoM:${y - 2}\\) or .*\\(IdMeseM:2 and IdAnnoM:${y}\\) \\) and `), "solo «al»: dai due anni prima");
  assert.match(buildArQuery({ text: "cud", dateFrom: `${y}-01-15` }), new RegExp(`^\\( \\(IdMeseA:1 and IdAnnoA:${y}\\)`), "solo «dal»: fino a oggi");
  // dove cercare le parole
  assert.equal(buildArQuery({ text: "cud", searchIn: "1" }), "Oggetto:(cud OR cud*)");
  assert.equal(buildArQuery({ text: "cud", searchIn: "0" }), "Testi:(cud OR cud*)");
  // con un numero ticket i filtri non contano
  assert.equal(buildArQuery({ ticketId: "8900042", idCenSer: "PAOW", statoBase: "C", groupsIn: ["50454"], dateFrom: "2026-01-01", dateTo: "2026-03-31" }), "IdCenSer:PAOW and NumTic:8900042");

  // il client: filtri → ricerca; limite di risultati del portale riportato a chi chiama
  const queries = [];
  const fetchImpl = async (url, init = {}) => {
    let body = "<html></html>";
    if (/portlet\.jsp$/.test(url)) body = "this.splResults.m_cID='f0f7834fde6879c8685311c282f6734a';";
    else if (/spsl_fquery_mc$/.test(url)) {
      queries.push(decodeURIComponent(init.body.split("&")[0].slice(9)));
      body = arPage([arRow({ num: "8900042", code: "000000008903653", subject: "cud", date: "2026-04-21", testi: "cud" })]).replace('"maxResults":[210]', '"maxResults":[1]');
    }
    return { ok: true, status: 200, text: async () => body };
  };
  const logs = [];
  const ar = makeAr({ fetch: fetchImpl, log: (m) => logs.push(m) });
  ar.setCentre("PAOW");
  const info = {};
  const rows = await ar.search({ text: "", filters: { ...emptyArFilters(), groupIn: "50454", statoBase: "C", operator: { id: "000000000100001", label: "VERDI LAURA" } } }, info);
  assert.equal(rows.length, 1);
  assert.equal(queries[0], "IdCenSer:PAOW and IdOperatore:000000000100001 and StatoBase:C and ( IdGruppoIn:50454 or IdGruppoIn:50454.0 )");
  assert.equal(info.query, queries[0]);
  assert.equal(info.max, 1);
  assert.equal(info.raw, 1);
  assert.ok(logs.some((l) => /IdOperatore:…/.test(l) && !/100001/.test(l)), "nel registro la ricerca compare senza i codici delle persone");
  // con un numero i filtri della scheda non si mandano
  await ar.search({ ticketId: "8900042", filters: { ...emptyArFilters(), statoBase: "C" } });
  assert.equal(queries[1], "IdCenSer:PAOW and NumTic:8900042");
  assert.deepEqual(await ar.search({ text: "", filters: emptyArFilters() }), [], "niente parole e niente filtri: nessuna richiesta");
  assert.equal(queries.length, 2);
});

// ---------------------------------------------------------------- attinenza (calcolata nel browser)

test("attinenza: radici italiane, tutte le parole con le varianti, fasce di attinenza, estratto, filtro dell'elenco", async () => {
  const { stem, matchesAllTerms, scoreRow, relevance, TIERS, sortByRelevance, bestSnippet, listFilter, highlightPatterns, searchTerms } = await import("../lib/relevance.js");
  for (const [a, b] of [["cedolino", "cedolini"], ["premio", "premi"], ["paga", "paghe"], ["malattia", "malattie"], ["voce", "voci"], ["detassazione", "detassazioni"]]) {
    assert.equal(stem(a), stem(b), `${a}/${b}`);
  }
  assert.equal(stem("tfr"), "tfr");
  assert.equal(stem("f24"), "f24", "le sigle con cifre restano come sono");
  assert.notEqual(stem("premio"), stem("premessa"));

  assert.equal(matchesAllTerms("abbiamo i premi e il cedolino", "premio cedolini"), true, "singolare e plurale valgono");
  assert.equal(matchesAllTerms("abbiamo i premi", "premio tfr"), false);
  assert.equal(matchesAllTerms("versione 26.05.00 installata", "26.05.00"), true, "le parole con segni si cercano così come sono");
  assert.equal(matchesAllTerms("Città di Castello", "citta"), true, "senza distinzione di accenti");
  assert.equal(matchesAllTerms("il libro unico del lavoro", '"libro unico"'), true);
  assert.equal(matchesAllTerms("unico libro", '"libro unico"'), false, "una frase tra virgolette va trovata intera");
  assert.equal(matchesAllTerms("qualsiasi", ""), true);

  // Fasce nell'ordine scelto dagli operatori: il testo conta più dell'oggetto, le parole vicine più di tutto.
  const far = " " + "bla ".repeat(30);
  const cases = {
    nearText: { subject: "Quesito", problem: "serve la detassazione del premio aziendale" },
    nearSubject: { subject: "Detassazione premio", problem: "vedi allegato" },
    allTextFar: { subject: "Quesito", problem: "detassazione" + far + "premio" },
    allSubjectFar: { subject: "Detassazione" + far + "premio", problem: "vedi allegato" },
    allSplit: { subject: "Detassazione", problem: "il premio non risulta" },
    someText: { subject: "Quesito", problem: "il premio non risulta" },
    someBoth: { subject: "Premio di produzione", problem: "il premio non risulta" },
    someSubject: { subject: "Premio di produzione", problem: "vedi allegato" },
    none: { subject: "Altro", problem: "niente" },
  };
  const tierOf = (k) => relevance(cases[k], "detassazione premio").tier;
  assert.deepEqual(
    Object.keys(cases).map(tierOf),
    [TIERS.ALL_NEAR_TEXT, TIERS.ALL_NEAR_SUBJECT, TIERS.ALL_TEXT, TIERS.ALL_SUBJECT, TIERS.ALL_SPLIT, TIERS.SOME_TEXT, TIERS.SOME_BOTH, TIERS.SOME_SUBJECT, TIERS.NONE],
  );
  const shuffled = ["someSubject", "allSplit", "none", "nearSubject", "someText", "allTextFar", "nearText", "someBoth", "allSubjectFar"].map((k) => ({ id: k, ...cases[k] }));
  assert.deepEqual(sortByRelevance(shuffled, "detassazione premio").map((r) => r.id), Object.keys(cases), "l'ordine dell'elenco segue le fasce");
  assert.equal(scoreRow(cases.none, "detassazione premio"), 0);
  // la fascia decide sempre: il testo vicino batte l'oggetto perfetto
  assert.ok(scoreRow(cases.nearText, "detassazione premio") > scoreRow({ subject: "Detassazione premio", problem: "" }, "detassazione premio"));
  // una parola sola: nel testo vale più che nel solo oggetto
  assert.ok(scoreRow({ subject: "x", problem: "la detassazione" }, "detassazione") > scoreRow({ subject: "Detassazione", problem: "vedi allegato" }, "detassazione"));
  // dentro la stessa fascia: parole più strette, parola esatta più della variante, più parole trovate
  assert.ok(scoreRow({ problem: "detassazione premio" }, "detassazione premio") > scoreRow({ problem: "detassazione applicata al solo premio" }, "detassazione premio"), "più strette");
  assert.ok(scoreRow({ problem: "detassazione dei premi" }, "detassazione premi") > scoreRow({ problem: "detassazione dei premi" }, "detassazione premio"), "esatta > variante");
  assert.ok(scoreRow({ problem: "premio e conguaglio" }, "detassazione premio conguaglio") > scoreRow({ problem: "solo premio" }, "detassazione premio conguaglio"), "più parole trovate");
  // «vicine» = entro poche parole (2 parole: 6); oltre, è la fascia «tutte ma lontane»
  assert.equal(relevance({ problem: "detassazione uno due tre quattro premio" }, "detassazione premio").tier, TIERS.ALL_NEAR_TEXT);
  assert.equal(relevance({ problem: "detassazione uno due tre quattro cinque premio" }, "detassazione premio").tier, TIERS.ALL_TEXT);
  // vicine vuol dire nello stesso pezzo di testo: richiesta e messaggi non si attaccano
  assert.equal(relevance({ problem: "chiede la detassazione", fullText: "premio di produzione" }, "detassazione premio").tier, TIERS.ALL_TEXT);
  // nel testo completo del Vecchio Cruscotto l'oggetto ripetuto all'inizio non conta come testo
  assert.equal(relevance({ subject: "Detassazione premio", fullText: "Detassazione premio  vedi allegato  risposto" }, "detassazione premio").tier, TIERS.ALL_NEAR_SUBJECT);
  // i messaggi del Vecchio Cruscotto (separati da due spazi) sono pezzi distinti; i tag HTML non sono parole
  assert.equal(relevance({ fullText: "chiede la detassazione  premio di produzione" }, "detassazione premio").tier, TIERS.ALL_TEXT);
  assert.equal(relevance({ problem: "la <b>detassazione</b><br><br><br><br><br>del <i>premio</i>" }, "detassazione premio").tier, TIERS.ALL_NEAR_TEXT);
  // una frase tra virgolette è un termine solo
  assert.equal(relevance({ problem: "il libro unico del lavoro non stampa" }, '"libro unico" stampa').tier, TIERS.ALL_NEAR_TEXT);
  assert.deepEqual(sortByRelevance(shuffled, "").map((r) => r.id), shuffled.map((r) => r.id), "senza parole l'ordine non cambia");
  // a parità di punteggio, dal più recente
  const same = [{ id: "old", subject: "premio", date: new Date(2020, 0, 1) }, { id: "new", subject: "premio", date: new Date(2026, 0, 1) }];
  assert.deepEqual(sortByRelevance(same, "premio").map((r) => r.id), ["new", "old"]);

  const long = "Buongiorno, " + "testo iniziale poco utile. ".repeat(30) + "Il cliente chiede la detassazione dei premi di risultato per il 2026. " + "altro testo. ".repeat(40);
  const snip = bestSnippet(long, "detassazione premio", 160);
  assert.match(snip, /detassazione dei premi di risultato/);
  assert.ok(snip.startsWith("… ") && snip.endsWith(" …") && snip.length <= 170);
  assert.equal(bestSnippet("breve", "x", 300), "breve");
  assert.equal(bestSnippet(long, "", 50), long.slice(0, 50));

  const f = listFilter("premio -cedolino");
  assert.equal(f("Detassazione premi"), true);
  assert.equal(f("premi sul cedolino"), false, "-parola esclude (anche le varianti)");
  assert.equal(f("altro"), false);
  assert.equal(listFilter("  "), null, "casella vuota: nessun filtro");
  assert.equal(listFilter("-uniemens")("errore uniemens"), false);
  assert.equal(listFilter("-uniemens")("stampa cedolino"), true, "solo esclusioni");

  assert.deepEqual(highlightPatterns('premio "libro unico" tfr'), [{ text: "premio", stem: "prem" }, { text: "libro unico", stem: "" }, { text: "tfr", stem: "" }]);
  assert.deepEqual(searchTerms("premio -cedolino").map((t) => t.text), ["premio"], "le esclusioni non sono parole da cercare");
});

test("ar: la ricerca usa la radice per singolare/plurale; oltre il limite del portale si divide per periodi", async () => {
  assert.equal(buildArQuery({ text: "cedolino" }), "( Testi:(cedolino OR cedolin*) or Oggetto:(cedolino OR cedolin*) )");
  assert.equal(buildArQuery({ text: "premio" }), "( Testi:(premio OR premi*) or Oggetto:(premio OR premi*) )");
  assert.equal(buildArQuery({ text: "paga" }), "( Testi:(paga OR paga*) or Oggetto:(paga OR paga*) )", "le parole corte non si allargano");
  assert.equal(buildArQuery({ text: "f24" }), "( Testi:(f24 OR f24*) or Oggetto:(f24 OR f24*) )");

  // portale finto: 9 ticket nel 2026 (3 al mese da gennaio a marzo), limite 4 per ricerca
  const y = new Date().getFullYear();
  const all = [];
  for (let m = 1; m <= 3; m++) for (let k = 0; k < 3; k++) all.push({ num: String(8800000 + m * 10 + k), m, y });
  const queries = [];
  const fetchImpl = async (url, init = {}) => {
    let body = "<html></html>";
    if (/portlet\.jsp$/.test(url)) body = "this.splResults.m_cID='f0f7834fde6879c8685311c282f6734a';";
    else if (/spsl_fquery_mc$/.test(url)) {
      const q = decodeURIComponent(init.body.split("&")[0].slice(9));
      queries.push(q);
      const months = [...q.matchAll(/IdMeseM:(\d+) and IdAnnoM:(\d+)/g)].map((x) => `${x[2]}-${x[1]}`);
      const hit = all.filter((t) => !months.length || months.includes(`${t.y}-${t.m}`)).slice(0, 4);
      body = arPage(hit.map((t) => arRow({ num: t.num, code: "0000000" + t.num, subject: "cud", date: `${t.y}-0${t.m}-10`, testi: "cud" }))).replace('"maxResults":[210]', '"maxResults":[4]');
    }
    return { ok: true, status: 200, text: async () => body };
  };
  const ar = makeAr({ fetch: fetchImpl });
  ar.setCentre("PAOW");
  const info = {};
  assert.equal((await ar.search({ text: "cud", filters: emptyArFilters() }, info)).length, 4);
  assert.equal(info.raw >= info.max, true, "la ricerca normale è troncata");
  const progress = [];
  const res = await ar.searchAll({ text: "cud", filters: { ...emptyArFilters(), dateFrom: `${y}-01-01`, dateTo: `${y}-03-31` } }, { onProgress: (p) => progress.push(p.rows) });
  assert.equal(res.rows.length, 9, "tutti i ticket, senza doppioni");
  assert.equal(new Set(res.rows.map((r) => r.id)).size, 9);
  assert.deepEqual(res.cappedMonths, []);
  assert.equal(res.stopped, false);
  assert.ok(res.queries >= 4 && res.queries <= 6, `gennaio-marzo → divisi fino al mese (${res.queries} richieste)`);
  assert.equal(progress[progress.length - 1], 9);
  // un mese che da solo supera il limite resta troncato e lo si dice
  for (let k = 3; k < 8; k++) all.push({ num: String(8800000 + 10 + k), m: 1, y });
  const res2 = await ar.searchAll({ text: "cud", filters: { ...emptyArFilters(), dateFrom: `${y}-01-01`, dateTo: `${y}-03-31` } });
  assert.deepEqual(res2.cappedMonths, [`${y}-01`]);
  // ci si ferma al tetto di richieste
  const res3 = await ar.searchAll({ text: "cud", filters: { ...emptyArFilters(), dateFrom: `${y}-01-01`, dateTo: `${y}-03-31` } }, { maxQueries: 2 });
  assert.equal(res3.stopped, true);
  assert.equal(res3.queries, 2);
  // annullata (nuova ricerca partita nel frattempo)
  const res4 = await ar.searchAll({ text: "cud", filters: emptyArFilters() }, { isCancelled: () => true });
  assert.equal(res4.cancelled, true);
});

test("ar: con più parole i ticket trovati dal portale non si scartano anche se il testo ricevuto non le contiene tutte", async () => {
  const queries = [];
  const fetchImpl = async (url, init = {}) => {
    let body = "<html></html>";
    if (/portlet\.jsp$/.test(url)) body = "this.splResults.m_cID='f0f7834fde6879c8685311c282f6734a';";
    else if (/spsl_fquery_mc$/.test(url)) {
      queries.push(decodeURIComponent(init.body.split("&")[0].slice(9)));
      body = arPage([
        arRow({ num: "8900001", code: "000000008900001", subject: "Detassazione premio di risultato", date: "2026-04-21", testi: "detassazione del premio" }),
        // il portale lo trova (riconosce «detassato», o la parola è in un pezzo di testo che la risposta non riporta)
        arRow({ num: "8900002", code: "000000008900002", subject: "Quesito premio", date: "2026-04-22", testi: "il premio va detassato" }),
        arRow({ num: "8900003", code: "000000008900003", subject: "Conguaglio", date: "2026-04-23", testi: "testo tagliato che non riporta le parole" }),
      ]);
    }
    return { ok: true, status: 200, text: async () => body };
  };
  const ar = makeAr({ fetch: fetchImpl });
  ar.setCentre("PAOW");
  const info = {};
  const rows = await ar.search({ text: "detassazione premio", filters: emptyArFilters() }, info);
  assert.match(queries[0], /Testi:\(detassazione OR detassazion\*\).* and .*Testi:\(premio OR premi\*\)/, "le parole sono già chieste tutte al portale");
  assert.deepEqual(rows.map((r) => r.id), ["8900001", "8900002", "8900003"], "restano tutti i ticket che il portale ha trovato");
  assert.equal(info.raw, 3);
  assert.equal(info.kept, 3);
  // l'attinenza li mette comunque in ordine: prima chi ha tutte le parole vicine
  const { sortByRelevance } = await import("../lib/relevance.js");
  assert.deepEqual(sortByRelevance(rows, "detassazione premio").map((r) => r.id), ["8900001", "8900002", "8900003"]);
});

test("touch: più parole vanno al portale in una sola condizione, come fa HDA Touch; la soluzione è testo del ticket", async () => {
  const { buildConditions } = await import("../lib/filters.js");
  const { makeRowReader } = await import("../lib/rows.js");
  const { relevance, TIERS } = await import("../lib/relevance.js");
  const textConds = (calib) => buildConditions({ ...emptyFilters(), text: "detassazione maggiorazione" }, calib).filter((c) => c.property === "FullText");

  // come nella richiesta reale di Touch: FullText eq «detassazione maggiorazione» [INCLUDECONVERSATIONITEM]
  const native = textConds({ singleFullText: true });
  assert.equal(native.length, 1);
  assert.equal(native[0].value, "detassazione maggiorazione");
  assert.equal(native[0].op, "eq");
  assert.equal(native[0].extKey, "INCLUDECONVERSATIONITEM");
  // ricerca estesa: la parola più lunga al portale, le altre verificate nell'app
  const wide = textConds({ primaryTermOnly: true });
  assert.equal(wide.length, 1);
  assert.equal(wide[0].value, "maggiorazione");
  // una parola sola: uguale nei due modi
  const one = (calib) => buildConditions({ ...emptyFilters(), text: "cigs" }, calib).find((c) => c.property === "FullText").value;
  assert.equal(one({ singleFullText: true }), "cigs");
  assert.equal(one({ primaryTermOnly: true }), "cigs");

  // la colonna Solution dell'elenco (c44 nella vista Default)
  const row = makeRowReader(null).read({ c23: "10500123Z", c45: "Quesito", c40: "vedi allegato", c44: "si applica la detassazione alla maggiorazione" });
  assert.equal(row.solution, "si applica la detassazione alla maggiorazione");
  assert.equal(makeRowReader({ c1: "ID", c2: "Solution" }).read({ c1: "1", c2: "testo" }).solution, "testo");
  assert.equal(relevance(row, "detassazione maggiorazione").tier, TIERS.ALL_NEAR_TEXT, "le parole nella soluzione valgono come testo");
  assert.equal(relevance({ ...row, solution: "" }, "detassazione maggiorazione").tier, TIERS.NONE);
});

test("asterisco: automatico per HDA Touch, scritto a mano ovunque", async () => {
  const { wildcardWord, wildcardText, buildConditions: bc } = await import("../lib/filters.js");
  const { searchTerms, relevance, matchesAllTerms, TIERS, highlightPatterns } = await import("../lib/relevance.js");
  const { buildArQuery } = await import("../lib/ar.js");
  const { buildKbQuery } = await import("../lib/kb.js");
  const { tokens: toks } = await import("../lib/util.js");

  // la radice più l'asterisco: singolare, plurale e parole che iniziano allo stesso modo
  assert.equal(wildcardWord("centro"), "centr*");
  assert.equal(wildcardWord("costi"), "cost*");
  assert.equal(wildcardWord("centr"), "centr*");
  assert.equal(wildcardWord("cedolino"), "cedolin*");
  assert.equal(wildcardWord("premio"), "prem*");
  assert.equal(wildcardWord("attività"), "attivit*", "senza accento: la radice vale per tutte le forme");
  assert.equal(wildcardWord("Detassazione"), "detassazion*");
  assert.equal(wildcardWord("paghe"), "pagh*", "mai meno di quattro lettere prima dell'asterisco");
  assert.equal(wildcardWord("voce"), "voce*");
  // restano come sono: asterisco già scritto, parole corte, numeri e sigle, parole di servizio
  assert.equal(wildcardWord("centr*"), "centr*");
  assert.equal(wildcardWord("di"), "di");
  assert.equal(wildcardWord("non"), "non");
  assert.equal(wildcardWord("730"), "730");
  assert.equal(wildcardWord("L307"), "L307");
  assert.equal(wildcardWord("26.05.00"), "26.05.00");
  assert.equal(wildcardWord("della"), "della");
  assert.equal(wildcardText("centro di costo"), "centr* di cost*");
  assert.equal(wildcardText("centr di cost"), "centr* di cost*");
  assert.equal(wildcardText("centr* di cost*"), "centr* di cost*");
  assert.equal(wildcardText('"centro di costo" errato'), '"centro di costo" errato', "con una frase tra virgolette non si tocca niente");
  assert.equal(wildcardText(""), "");

  // a Touch: una sola condizione FullText con il testo così trasformato (come «centr* di cost*» scritto nel portale)
  const ft = (text, calib) => bc({ ...emptyFilters(), text }, calib).filter((c) => c.property === "FullText").map((c) => c.value);
  assert.deepEqual(ft("centro di costo", { singleFullText: true, autoWildcard: true }), ["centr* di cost*"]);
  assert.deepEqual(ft("cedolino", { singleFullText: true, autoWildcard: true }), ["cedolin*"]);
  assert.deepEqual(ft("centro di costo", { singleFullText: true }), ["centro di costo"], "senza l'opzione: parole esatte");
  assert.deepEqual(ft("centr* di cost*", { singleFullText: true }), ["centr* di cost*"], "l'asterisco a mano passa sempre");
  // il numero ticket non diventa mai una parola con l'asterisco
  assert.deepEqual(ft("10500123", { singleFullText: true, autoWildcard: true }), []);

  // nel browser l'asterisco non è una lettera: «centr*» è la parola che inizia per «centr»
  assert.deepEqual(toks("centr* di cost*"), ["centr", "di", "cost"]);
  assert.deepEqual(searchTerms("centr* costo").map((t) => [t.text, t.stem, !!t.prefix]), [["centr", "centr", true], ["costo", "cost", false]]);
  assert.equal(matchesAllTerms("ripartizione per centri di costo", "centr* di cost*"), true);
  assert.equal(matchesAllTerms("centrale dei costi", "centr* cost*"), true);
  assert.equal(matchesAllTerms("nessuna delle due", "centr* cost*"), false);
  assert.equal(relevance({ subject: "x", problem: "errore sui centri di costo del cantiere" }, "centr* di cost*").tier, TIERS.ALL_NEAR_TEXT);
  assert.deepEqual(highlightPatterns("centr* di").map((p) => p.text), ["centr", "di"]);
  // senza asterisco scritto: le parole che iniziano con la radice contano, ma meno della parola o del suo plurale
  const exact = relevance({ subject: "", problem: "il centro di costo è sbagliato" }, "centro costo");
  const loose = relevance({ subject: "", problem: "la centrale dei costi è sbagliata" }, "centro costo");
  assert.equal(loose.tier, exact.tier, "tutte le parole vicine nel testo in tutti e due");
  assert.ok(exact.score > loose.score, "la parola scritta così viene prima");

  // Vecchio Cruscotto e Knowledge Base: l'asterisco scritto resta, in minuscolo (lì le varianti l'app le chiede già)
  assert.match(buildArQuery({ text: "Centr* di cost*", idCenSer: "PAOW" }), /Testi:\(centr\*\) or Oggetto:\(centr\*\)/);
  assert.match(buildArQuery({ text: "Centr* di cost*", idCenSer: "PAOW" }), /Testi:\(cost\*\) or Oggetto:\(cost\*\)/);
  assert.match(buildKbQuery({ text: "cost*", idCenSer: "PAOW" }), /altDescription:\(cost\*\) OR description:\(cost\*\)/);
});
