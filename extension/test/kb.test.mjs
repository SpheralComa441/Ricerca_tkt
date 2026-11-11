// Knowledge Base dell'Area Riservata: ricerca, lettura della risposta, scheda per il lettore. Dati inventati.
import test from "node:test";
import assert from "node:assert/strict";
import { KB_AREA, emptyKbFilters, hasKbFilter, kbNumberFrom, kbRowId, isKbId, kbLabel, kbYears, inKbPeriod, buildKbQuery, parseKbResponse, buildKbDoc, makeKb } from "../lib/kb.js";
import { ticketIdFrom, ticketNumber } from "../lib/util.js";
import { relevance, TIERS } from "../lib/relevance.js";

const FIELDS = ["type", "category", "id", "description", "altDescription", "attachmentData", "entityName", "CenSer", "Tipologia", "Stato", "GiornoPub", "MesePub", "AnnoPub", "Oggetto", "GiornoUlt", "MeseUlt", "AnnoUlt", "Operatore", "FlgAllegati", "FlgDefinitivo", "Lingua", "Classe", "Argomento", "Visibilita", "ProdCom", "ProdTec", "Versioni", "Sistemi", "Testi", "mimeType", "ClasseBase", "img", "url1", "url2", "url2lbl", "urlPublic", "viewFields"];
const B = (s) => `<span style="font-weight:bold;" solrfound="true">${s}</span>`;
function kbRow(over = {}) {
  const v = Object.fromEntries(FIELDS.map((f) => [f, ""]));
  Object.assign(v, {
    type: "TICKTKB002", category: "TICKTKB002", id: "9101", description: `[SKB#9101] [PAGHEW] [07-08-${B("2026")}] Paghe: errore nel calcolo del`,
    altDescription: `<div style="padding-top:2px;">nel calcolo della ${B("detassazione")} manca la voce ...</div>`, entityName: "sipv_asolr_kb_mTICKTKB002", CenSer: "PAOW", Tipologia: "INCID", Stato: "P",
    GiornoPub: "7", MesePub: "8", AnnoPub: "2026", Oggetto: "Paghe: errore nel calcolo del cedolino", GiornoUlt: "9", MeseUlt: "9", AnnoUlt: "2026", Operatore: "000000000100001", FlgAllegati: "1", FlgDefinitivo: "1",
    Lingua: "ITA", Classe: "SKB", Argomento: "00000000000000000001", Visibilita: "E", ProdCom: "1|PAGHEW", ProdTec: "PAGHEW", Versioni: "26.08.00", mimeType: "../images/crmpov/scheda_tkb.png", ClasseBase: "S",
    img: "call:getImage('%mimeType%')", url1: "../jsp/sipv_ptkb_card.jsp?pIDTKB=9101&pCenSer=PAOW ", ...over,
  });
  return FIELDS.map((f) => v[f]);
}
/** La risposta del portale: una pagina con il risultato in un commento, come quella vera. */
const page = (rows, max = 210) => `<!doctype html>\n<html><body>\n<p class='TabLabel'>Ok routine eseguita.</p>\n<!--\nFunction return value:${JSON.stringify({ data: [...rows, "t,CCCC,-1"], maxResults: [max], fields: FIELDS, facet: [["TICKTKB002", rows.length, "KNOWLEDGE BASE"]], errors: [] })}\n -->\n</body>\n</html>`;

test("knowledge base: la ricerca si scrive come quella del portale", () => {
  assert.equal(KB_AREA, "TICKET-TKB");
  // senza parole e senza filtri non si cerca
  assert.equal(buildKbQuery({ idCenSer: "PAOW" }), "");
  assert.equal(hasKbFilter(emptyKbFilters()), false);

  // una parola: nel testo o nel titolo, pubblicate e definitive (come il modulo del portale), anche singolare e plurale
  const q1 = buildKbQuery({ text: "detassazione", idCenSer: "PAOW" });
  assert.equal(q1, "CenSer:PAOW AND Lingua:ITA AND (altDescription:(detassazione OR detassazion*) OR description:(detassazione OR detassazion*)) AND Stato:P AND FlgDefinitivo:1");
  // visibilità e periodo: gli anni dell'ultima modifica, scritti come li scrive il portale
  const q2 = buildKbQuery({ text: "cedolino", idCenSer: "PAOW", filters: { ...emptyKbFilters(), visibility: "E", dateFrom: "2025-03-01", dateTo: "2026-02-28" } });
  assert.match(q2, /^CenSer:PAOW AND \( \(AnnoUlt:2025 \) OR \(AnnoUlt:2026 \) \) AND Lingua:ITA AND \(altDescription:\(cedolino OR cedolin\*\) OR description:\(cedolino OR cedolin\*\)\) AND Stato:P AND FlgDefinitivo:1 AND Visibilita:E$/);
  assert.match(buildKbQuery({ text: "x1", filters: { ...emptyKbFilters(), visibility: "I" } }), /AND Visibilita:I$/);
  // senza centro servizi la condizione non c'è
  assert.ok(!/CenSer/.test(buildKbQuery({ text: "cedolino" })));

  // più parole
  const all = buildKbQuery({ text: "detassazione premi", idCenSer: "PAOW" });
  assert.match(all, /\(altDescription:\(detassazione OR detassazion\*\) OR description:\(detassazione OR detassazion\*\)\) AND \(altDescription:\(premi OR premi\*\) OR description:\(premi OR premi\*\)\)/, "tutte: una condizione per parola");
  const any = buildKbQuery({ text: "detassazione premi", idCenSer: "PAOW", filters: { ...emptyKbFilters(), mode: "any" } });
  assert.match(any, /\(altDescription:\(detassazione OR detassazion\* OR premi OR premi\*\) OR description:\(detassazione OR detassazion\* OR premi OR premi\*\)\)/, "almeno una: tutte in «OR»");
  const phrase = buildKbQuery({ text: "premi di risultato", idCenSer: "PAOW", filters: { ...emptyKbFilters(), mode: "phrase" } });
  assert.match(phrase, /\(altDescription:\("premi di risultato"\) OR description:\("premi di risultato"\)\)/);
  // i caratteri della sintassi non passano nella ricerca
  assert.equal(buildKbQuery({ text: 'a(b) "c:d' }), 'Lingua:ITA AND (altDescription:("a b") OR description:("a b")) AND (altDescription:("c d") OR description:("c d")) AND Stato:P AND FlgDefinitivo:1');

  // anche non pubblicate / non definitive: le condizioni spariscono, e così si può cercare senza parole
  const f = { ...emptyKbFilters(), published: false, definitive: false };
  assert.equal(hasKbFilter(f), true);
  assert.equal(buildKbQuery({ idCenSer: "PAOW", filters: f }), "CenSer:PAOW AND Lingua:ITA");
  assert.equal(buildKbQuery({ idCenSer: "PAOW", filters: { ...emptyKbFilters(), visibility: "I" } }), "CenSer:PAOW AND Lingua:ITA AND Stato:P AND FlgDefinitivo:1 AND Visibilita:I");

  // una scheda per numero: i filtri non contano
  assert.equal(buildKbQuery({ number: "9101", idCenSer: "PAOW", filters: { ...emptyKbFilters(), visibility: "I" } }), "CenSer:PAOW AND Lingua:ITA AND (description:(9101))");
});

test("knowledge base: numeri di scheda e numeri di ticket non si confondono", () => {
  assert.equal(kbNumberFrom("SKB#9101"), "9101");
  assert.equal(kbNumberFrom("skb 9101"), "9101");
  assert.equal(kbNumberFrom("KB9101"), "9101");
  assert.equal(kbNumberFrom("9101"), "", "un numero da solo è una parola (730, 2026…)");
  assert.equal(kbNumberFrom("skb detassazione"), "");
  assert.equal(kbRowId("9101"), "KB9101");
  assert.equal(isKbId("KB9101"), true);
  assert.equal(isKbId("9101"), false);
  assert.equal(isKbId("10500123Z"), false);
  assert.equal(kbLabel({ id: "KB9101", kbId: "9101", classe: "SKB" }), "SKB#9101");
  assert.equal(kbLabel("KB9101"), "SKB#9101");
  // l'ID di una scheda non viene mai letto come numero di ticket
  assert.equal(ticketIdFrom("KB9101"), null);
  assert.equal(ticketNumber("KB9101"), "KB9101");
});

test("knowledge base: periodo → anni chiesti al portale e controllo del giorno sulle righe", () => {
  const now = new Date(2026, 10, 11);
  assert.deepEqual(kbYears(emptyKbFilters(), now), []);
  assert.deepEqual(kbYears({ dateFrom: "2024-06-01", dateTo: "2025-01-31", dateRef: "ult" }, now), [2024, 2025]);
  assert.deepEqual(kbYears({ dateFrom: "2025-06-01", dateTo: "", dateRef: "ult" }, now), [2025, 2026]);
  assert.deepEqual(kbYears({ dateFrom: "", dateTo: "2008-12-31", dateRef: "ult" }, now), [2007, 2008]);
  // pubblicazione: una scheda pubblicata nel 2024 può essere stata modificata dopo, quindi si chiede fino a oggi
  assert.deepEqual(kbYears({ dateFrom: "2024-01-01", dateTo: "2024-12-31", dateRef: "pub" }, now), [2024, 2025, 2026]);

  const row = { date: new Date(2024, 4, 20), lastChange: new Date(2026, 1, 3) };
  assert.equal(inKbPeriod(row, { dateFrom: "2024-01-01", dateTo: "2024-12-31", dateRef: "pub" }), true);
  assert.equal(inKbPeriod(row, { dateFrom: "2024-01-01", dateTo: "2024-12-31", dateRef: "ult" }), false);
  assert.equal(inKbPeriod(row, { dateFrom: "2026-02-03", dateTo: "2026-02-03", dateRef: "ult" }), true);
  assert.equal(inKbPeriod(row, { dateFrom: "2026-02-04", dateTo: "", dateRef: "ult" }), false);
  assert.equal(inKbPeriod(row, emptyKbFilters()), true);
});

test("knowledge base: la risposta del portale diventa righe dell'elenco", () => {
  const res = parseKbResponse(page([kbRow(), kbRow({ id: "9102", description: "[SKB#9102] [PAGHEW] [18-05-2026] Nota interna", Oggetto: "Nota interna per gli operatori", Visibilita: "I", Tipologia: "INFO", FlgAllegati: "0", GiornoPub: "18", MesePub: "5", GiornoUlt: "18", MeseUlt: "5" }), kbRow()]));
  assert.equal(res.max, 210);
  assert.equal(res.rows.length, 2, "la riga sentinella e i doppioni si scartano");
  const [a, b] = res.rows;
  assert.equal(a.id, "KB9101");
  assert.equal(a.kbId, "9101");
  assert.equal(a.source, "kb");
  assert.equal(a.classe, "SKB");
  assert.equal(a.subject, "Paghe: errore nel calcolo del cedolino", "l'oggetto intero, non il titolo troncato");
  assert.equal(a.problem, "nel calcolo della detassazione manca la voce ...", "l'estratto senza i segni di evidenziazione");
  assert.equal(a.arUrl, "https://www.zucchetti.it/areariservata/jsp/sipv_ptkb_card.jsp?pIDTKB=9101&pCenSer=PAOW");
  assert.deepEqual([a.date.getFullYear(), a.date.getMonth() + 1, a.date.getDate()], [2026, 8, 7]);
  assert.deepEqual([a.lastChange.getFullYear(), a.lastChange.getMonth() + 1, a.lastChange.getDate()], [2026, 9, 9]);
  assert.equal(a.visibility, "E");
  assert.equal(a.published && a.definitive && a.hasAttachments, true);
  assert.equal(a.catalog, "PAGHEW");
  assert.equal(a.version, "26.08.00");
  assert.equal(a.typeText, "INCID");
  assert.equal(a.assigned, "Op. 100001");
  assert.equal(a.assignedId, "000000000100001");
  assert.equal(b.visibility, "I");
  assert.equal(b.hasAttachments, false);
  // l'attinenza lavora su oggetto ed estratto
  assert.equal(relevance(a, "detassazione").tier, TIERS.ALL_NEAR_TEXT);
  assert.equal(relevance(a, "cedolino").tier, TIERS.ALL_NEAR_SUBJECT);
  // risposte vuote o rovinate non rompono niente
  assert.deepEqual(parseKbResponse("<html>sessione scaduta</html>").rows, []);
  assert.deepEqual(parseKbResponse(page([])).rows, []);
});

test("knowledge base: la scheda per il lettore", () => {
  const row = parseKbResponse(page([kbRow({ Visibilita: "I" })])).rows[0];
  // senza la pagina del portale: l'estratto e l'invito ad aprirla
  const poor = buildKbDoc({ row });
  assert.equal(poor.source, "kb");
  assert.equal(poor.complete, false);
  assert.equal(poor.timeline.length, 1);
  assert.equal(poor.timeline[0].kind, "doc");
  assert.match(poor.timeline[0].text, /detassazione/);
  assert.match(poor.notes[0], /visibilità interna/);
  assert.match(poor.notes[1], /solo un estratto/);

  // con la pagina letta dal portale: campi di testo, testo dei riquadri interni, altri dati, allegati
  const detail = {
    fields: [["Oggetto", "Paghe: errore nel calcolo del cedolino"], ["Sistema operativo", "Tutti"]],
    texts: [["Problema", "Il calcolo del cedolino si ferma quando manca la voce della detassazione nel mese di competenza."]],
    bodies: ["Oggetto:\nSistema operativo:\nProblema\nmanuale.pdf", "Soluzione\nInserire la voce nella tabella e rielaborare il cedolino del mese.", "ok"],
    bodyText: "…",
    attachments: [{ id: "ar-att-1", fileName: "manuale.pdf", url: "https://www.zucchetti.it/areariservata/servlet/x?id=1" }, { id: "x", fileName: "senza indirizzo" }],
  };
  const full = buildKbDoc({ row, detail });
  assert.equal(full.complete, true);
  assert.deepEqual(full.timeline.map((e) => e.author), ["Problema", "Testo della scheda"], "le sole etichette della pagina non fanno testo");
  assert.match(full.timeline[1].text, /^Soluzione\nInserire la voce/);
  assert.deepEqual(full.extraFacts, [["Sistema operativo", "Tutti"]], "l'oggetto è già nel titolo");
  assert.equal(full.attachments.length, 1);
  assert.equal(full.notes.length, 1, "resta solo l'avviso di visibilità interna");
  // pagina letta ma vuota: si torna all'estratto
  assert.equal(buildKbDoc({ row, detail: { fields: [], texts: [], bodies: ["", "ok"], bodyText: "ok", attachments: [] } }).complete, false);
});

test("knowledge base: ricerca, limite del portale e lettura della scheda", async () => {
  const asked = [];
  const docs = [
    kbRow(),
    kbRow({ id: "9102", Oggetto: "Seconda scheda", description: "[SKB#9102] [PAGHEW] [01-02-2025] Seconda scheda", GiornoPub: "1", MesePub: "2", AnnoPub: "2025", GiornoUlt: "3", MeseUlt: "2", AnnoUlt: "2025" }),
    kbRow({ id: "9103", Oggetto: "Scheda di un altro centro", description: "[SKB#9103] [X] [01-02-2026] Scheda di un altro centro", CenSer: "ALTR" }),
  ];
  let max = 210;
  const solr = async (query, area) => {
    asked.push({ query, area });
    const years = [...query.matchAll(/AnnoUlt:(\d{4})/g)].map((m) => m[1]);
    const num = (/\(description:\((\d+)\)\)/.exec(query) || [])[1];
    const rows = docs.filter((d) => (num ? d[2] === num : !years.length || years.includes(d[FIELDS.indexOf("AnnoUlt")])));
    return page(rows.slice(0, max), max);
  };
  const read = [];
  const kb = makeKb({ solr, centro: () => "PAOW", readDetail: async (url, o) => { read.push([url, o]); return { fields: [], texts: [["Soluzione", "Rielaborare il cedolino dopo aver corretto la tabella delle voci retributive."]], bodies: [], bodyText: "", attachments: [] }; } });

  const info = {};
  const rows = await kb.search({ text: "cedolino", filters: emptyKbFilters() }, info);
  assert.equal(asked[0].area, "TICKET-TKB");
  assert.deepEqual(rows.map((r) => r.id), ["KB9101", "KB9102"], "le schede degli altri centri restano fuori");
  assert.equal(info.max, 210);
  assert.equal(info.raw, 3);
  // periodo: l'anno al portale, il giorno controllato qui
  const feb = await kb.search({ text: "cedolino", filters: { ...emptyKbFilters(), dateFrom: "2025-02-01", dateTo: "2025-02-02" } });
  assert.match(asked.at(-1).query, /\(AnnoUlt:2025 \)/);
  assert.deepEqual(feb.map((r) => r.id), [], "modificata il 3 febbraio: fuori dal periodo 1-2 febbraio");
  assert.deepEqual((await kb.search({ text: "cedolino", filters: { ...emptyKbFilters(), dateFrom: "2025-02-01", dateTo: "2025-02-03" } })).map((r) => r.id), ["KB9102"]);
  // per numero
  assert.deepEqual((await kb.search({ number: "9102" })).map((r) => r.id), ["KB9102"]);

  // oltre il limite: un anno alla volta
  max = 1;
  asked.length = 0;
  const all = await kb.searchAll({ text: "cedolino", filters: { ...emptyKbFilters(), dateFrom: "2025-01-01", dateTo: "2026-12-31" } }, { now: new Date(2026, 10, 11) });
  assert.equal(all.queries, 2);
  assert.deepEqual(asked.map((a) => (/AnnoUlt:(\d{4})/.exec(a.query) || [])[1]), ["2026", "2025"], "dal più recente");
  assert.deepEqual(all.rows.map((r) => r.id).sort(), ["KB9101", "KB9102"]);
  assert.deepEqual(all.cappedYears, [2026, 2025]);
  max = 210;

  // lettura: la riga dell'elenco più la pagina della scheda
  const full = await kb.loadDoc("KB9101", { row: rows[0] });
  assert.deepEqual(read[0], ["https://www.zucchetti.it/areariservata/jsp/sipv_ptkb_card.jsp?pIDTKB=9101&pCenSer=PAOW", { deep: true }]);
  assert.equal(full.id, "KB9101");
  assert.equal(full.complete, true);
  assert.match(full.timeline[0].text, /Rielaborare il cedolino/);
  // solo l'ID (pagina aperta da un collegamento): la scheda si ritrova per numero
  const byId = await kb.loadDoc("KB9102", {});
  assert.equal(byId.row.subject, "Seconda scheda");
  await assert.rejects(() => kb.loadDoc("KB7777", {}), /non trovata/);
  // un indirizzo che non è dell'Area Riservata non si legge
  const before = read.length;
  assert.equal((await kb.loadDoc("KB9101", { row: { ...rows[0], arUrl: "https://esempio.invalid/scheda" } })).complete, false);
  assert.equal(read.length, before);
  // la pagina del portale non si riesce a leggere: resta l'estratto
  const kb2 = makeKb({ solr, centro: () => "PAOW", readDetail: async () => { throw new Error("scheda non aperta"); } });
  assert.equal((await kb2.loadDoc("KB9101", { row: rows[0] })).complete, false);
});
