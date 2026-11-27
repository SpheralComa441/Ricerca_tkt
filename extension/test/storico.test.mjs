// Test dello Storico (Ricerca avanzata dell'Area Riservata). Dati sintetici nel formato reale del portale.
// Esecuzione: node --test extension/test/

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildArTicket } from "../lib/ar.js";

import {
  buildStoricoParams, encodeParams, companyId, nextDay, extractCmdHash, parseSqlData, parseSqlDate, storicoRow,
  unescapeJs, parsePreview, previewTimeline, parsePreviewDate, buildStoricoTicket, makeStorico, emptyStoricoFilters, hasStoricoFilter, ST_DEFAULT_TO,
  ticketLookupFilters, shiftDay, movePeople, enrichArTicket,
} from "../lib/storico.js";

const HASH = "0123456789abcdef0123456789abcdef";
const RES_PAGE = `<script>this.doPreview=new ZtVWeb._SQP(this,'doPreview','gsdm_qfiles_preview','p_VFCODICEID','10',' ','true','false','false','ffffffffffffffffffffffffffffffff');
this.povDataObject=new ZtVWeb._SQP(this,'povDataObject','gspv_qsearch_tickets','p_CentroServizi,p_DatIni,p_DatFin','20',' ','true','true','false','${HASH}');</script>`;

const FIELDS = ["CODICE_UTENTE", "TTCODICE", "TTCODCEN", "TTNUMTIC", "TTALFTIC", "TT_STATO", "STDESCRI", "TTSHOTXT", "TTDATAPE", "TTDATULT", "TTCODCOM", "TTCODCOM_DES", "TTULTCLI_DES", "TTULTREG", "TTULTREG_DES", "TTULTREO", "TTULTREO_DES", "TTTIPTIC", "TTTIPTIC_DES", "TTPRIORI_DES", "TTCODART", "TTCODART_DES", "TTARGUMENT_DES", "FLGSTORICO"];
const sqlRow = (num, subj, opened) => ["1", "00000000" + num, "PAOW ", num, "     ", "CLOSE", "Chiuso                        ", subj.padEnd(60), opened + " 11:42:28.0", opened + " 17:18:06.0", "000000000001234", "ALFA MECCANICA SRL          ", "ROSSI ANNA   ", "10663", "Paghe Web P       ", "000000000100001", "VERDI LAURA     ", "INFO ", "Informazioni   ", "Bassa", "PAGHEW", "PAGHE INFINITY", "Elaborazione cedolino", "0"];
const sqlResponse = (rows, total) => JSON.stringify({ Fields: FIELDS, Data: [...rows, `tt,${"C".repeat(FIELDS.length)},${total}`] });

const move = (id, o) => `<div id='${id}' class='portlet'></div><script>
/*JS_MARKER_START*/
ZtVWeb.addPortlet('${id}','gspv_preview_ticket_d');
window.${id}=new function(){
this.DTDATA=new ZtVWeb._VC(this,'DTDATA',null,'character','${o.date}');
this.CRDESCRI=new ZtVWeb._VC(this,'CRDESCRI',null,'character','${o.cause}');
this.DTSERIAL=new ZtVWeb._VC(this,'DTSERIAL',null,'character','${o.serial}');
this.DTCODTIC=new ZtVWeb._VC(this,'DTCODTIC',null,'character','000000005123456');
this.DTTIPMIT=new ZtVWeb._VC(this,'DTTIPMIT',null,'character','${o.mit}.0');
this.DTTIPDES=new ZtVWeb._VC(this,'DTTIPDES',null,'character','${o.des}.0');
this.DTMITPER_DESC=new ZtVWeb._VC(this,'DTMITPER_DESC',null,'character','${o.from}');
this.MITGRU_DES=new ZtVWeb._VC(this,'MITGRU_DES',null,'character','${o.fromGroup || ""}');
this.DTDESPER_DESC=new ZtVWeb._VC(this,'DTDESPER_DESC',null,'character','${o.to || ""}');
this.DESGRU_DES=new ZtVWeb._VC(this,'DESGRU_DES',null,'character','');
this.dtjAttach=new ZtVWeb._SQP(this,'dtjAttach','gspv_qviewallegati_ope','w_TTCODICE=DTCODTIC,w_TASERIALE=DTSERIAL','10',' ','true','false','false','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
this.VFSIZE=new ZtVWeb._VC(this,'VFSIZE',null,'numeric',0.0);
this.STDESCRI=new ZtVWeb._VC(this,'STDESCRI',null,'character','Chiuso');
this.DT_TESTO=new ZtVWeb._VC(this,'DT_TESTO',null,'character','${o.text}');
this.TOTALLEGSER=new ZtVWeb._VC(this,'TOTALLEGSER',null,'numeric',${o.files || 0}.0);
}
</script>`;
const PREVIEW = `<!DOCTYPE html><html><head><script src='x.js'></script></head><body>
${move("aaaaa", { date: "22-02-2021 11:42", cause: "Nuovo ticket", serial: "000000000000001", mit: 2, des: 1, from: "ROSSI ANNA", to: "Paghe Web P", text: "Errore nell\\'invio Uniemens: vedi http:\\x2f\\x2fesempio.it\\x2fa\\nSeconda riga" })}
${move("bbbbb", { date: "22-02-2021 12:05", cause: "Presa in carico", serial: "000000000000002", mit: 1, des: 1, from: "VERDI LAURA", fromGroup: "Paghe Web P", to: "VERDI LAURA", text: "" })}
${move("ccccc", { date: "23-02-2021 09:30", cause: "Risposta a cliente", serial: "000000000000003", mit: 1, des: 2, from: "VERDI LAURA", fromGroup: "Paghe Web P", to: "ROSSI ANNA", text: "&lt;p&gt;Buongiorno,&lt;br&gt;basta rigenerare il flusso.&lt;\\x2fp&gt;", files: 1 })}
<script>ZtVWeb.addPortlet('zzzzz','gspv_preview_ticket_frame');</script></body></html>`;

test("storico: parametri della ricerca identici a quelli del portale (cliente + periodo)", () => {
  const body = encodeParams(buildStoricoParams({ dateFrom: "2026-10-01", dateTo: "2026-11-06", clientCode: "1234" }, { centro: "PAOW", rows: 20, cmdhash: HASH, count: true }));
  assert.equal(
    body,
    `rows=20&startrow=0&count=true&cmdhash=${HASH}&sqlcmd=gspv_qsearch_tickets&orderby=TTDATULT%20desc&p_CentroServizi=PAOW&p_DatIni=2026-10-01&p_DatFin=2026-11-07&p_StatoDett=&p_StatoBase=&p_Priorita=&p_Tipologia=&p_DurataTot=0&p_LavoroTot=0&p_Azienda=000000000001234&p_Persona=&p_Argomento=&p_FlgArt=0&p_GuidArt=&p_Operatore=&p_NumIni=0&p_AlfTic=&p_Class=&p_RicercaPer=3&p_Matricola=&w_SelCentre=PAOW&p_Gruppo=0&p_DataRiferimento=1&p_PersonaRif=&p_AziendaRif=&p_TicketRif=0&p_TipoRif=&p_DatIniRif=null&p_DatFinRif=null&p_AliasFqSec=&p_AliasFqPri=&p_CodComm=&p_CodAttiv=&p_CenSerRif=&orderby=TTDATULT%20desc`,
  );
});

test("storico: con il numero ticket si cerca su tutti gli anni; gruppo e operatore; filtri vuoti", () => {
  const p = Object.fromEntries(buildStoricoParams({ ...emptyStoricoFilters(), number: "#5123456" }, { centro: "PAOW" }));
  assert.equal(p.p_NumIni, "5123456");
  assert.equal(p.p_DatIni, "2000-01-01");
  assert.ok(p.p_DatFin > "2026-01-01", "fino a oggi, non fino al 2023");
  const q = Object.fromEntries(buildStoricoParams({ group: "10663", operator: { id: "000000000100001", label: "x" }, dateTo: ST_DEFAULT_TO }, { centro: "PAOW", start: 50 }));
  assert.equal(q.p_Gruppo, "10663");
  assert.equal(q.p_Operatore, "000000000100001");
  assert.equal(q.p_DatFin, "2024-01-01");
  assert.equal(q.startrow, 50);
  // stato di base e data di riferimento, come nel modulo del portale (A/C; 1 = ultimo aggiornamento, 2 = apertura)
  const sb = Object.fromEntries(buildStoricoParams({ ...emptyStoricoFilters(), statoBase: "C", dateRef: "2" }, { centro: "PAOW" }));
  assert.equal(sb.p_StatoBase, "C");
  assert.equal(sb.p_DataRiferimento, 2);
  assert.equal(Object.fromEntries(buildStoricoParams({ ...emptyStoricoFilters(), statoBase: "X" }, { centro: "PAOW" })).p_StatoBase, "");
  assert.equal(Object.fromEntries(buildStoricoParams({ ...emptyStoricoFilters(), statoBase: "A", number: "5123456" }, { centro: "PAOW" })).p_StatoBase, "", "con il numero lo stato non conta");
  assert.equal(hasStoricoFilter({ ...emptyStoricoFilters(), statoBase: "A" }), true);
  assert.equal(companyId("1234"), "000000000001234");
  assert.equal(companyId(""), "");
  assert.equal(nextDay("2023-12-31"), "2024-01-01");
  assert.equal(nextDay("2024-02-28"), "2024-02-29");
  assert.equal(hasStoricoFilter(emptyStoricoFilters()), false, "il solo periodo predefinito non fa partire una ricerca su tutto lo storico");
  assert.equal(hasStoricoFilter({ ...emptyStoricoFilters(), clientCode: "1234" }), true);
  assert.equal(hasStoricoFilter({ ...emptyStoricoFilters(), dateFrom: "2021-01-01", dateTo: "2021-12-31" }), true);
});

test("storico: firma della query dalla pagina, righe e totale dalla risposta", () => {
  assert.equal(extractCmdHash(RES_PAGE), HASH);
  assert.equal(extractCmdHash("<html>login</html>"), "");
  const d = parseSqlData(sqlResponse([sqlRow("5123456", "Errore Uniemens", "2021-02-22"), sqlRow("5123457", "Altro", "2021-02-23")], 600123));
  assert.equal(d.rows.length, 2);
  assert.equal(d.total, 600123);
  assert.equal(parseSqlData("<html>non json</html>"), null);
  const r = storicoRow(d.rows[0]);
  assert.equal(r.id, "5123456");
  assert.equal(r.source, "storico");
  assert.equal(r.ttCodice, "000000005123456");
  assert.equal(r.subject, "Errore Uniemens");
  assert.equal(r.statusId, "S5");
  assert.equal(r.statusText, "Chiuso");
  assert.equal(r.account, "ALFA MECCANICA SRL");
  assert.equal(r.customerCode, "1234");
  assert.equal(r.ownerGroup, "Paghe Web P");
  assert.equal(r.ownerGroupId, "10663");
  assert.equal(r.assigned, "VERDI LAURA");
  assert.equal(r.date.getFullYear(), 2021);
  assert.equal(r.date.getHours(), 11);
  assert.match(r.arUrl, /gspv_psearch_card\.jsp\?w_TTCODICE=000000005123456$/);
  assert.equal(parseSqlDate("0100-01-01 00:00:00.0"), null);
});

test("storico: anteprima del ticket → conversazione (cliente, operatore, movimenti interni, HTML)", () => {
  assert.equal(unescapeJs("a\\x2fb\\'c\\\\d\\ne"), "a/b'c\\d\ne");
  assert.equal(parsePreviewDate("22-02-2021 11:42").getMonth(), 1);
  const moves = parsePreview(PREVIEW);
  assert.equal(moves.length, 3, "solo i riquadri dei movimenti, non la cornice");
  assert.equal(moves[0].attachHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const tl = previewTimeline(moves, { account: "ALFA MECCANICA SRL" });
  assert.equal(tl[0].kind, "request");
  assert.equal(tl[0].role, "customer");
  assert.equal(tl[0].author, "ROSSI ANNA");
  assert.equal(tl[0].text, "Errore nell'invio Uniemens: vedi http://esempio.it/a\nSeconda riga");
  assert.equal(tl[0].internal, false);
  assert.equal(tl[1].internal, true, "centro servizi → centro servizi: non lo vede il cliente");
  assert.equal(tl[1].label, "Presa in carico");
  assert.equal(tl[1].text, "(Presa in carico)");
  assert.equal(tl[2].role, "operator");
  assert.equal(tl[2].internal, false);
  assert.equal(tl[2].author, "VERDI LAURA (Paghe Web P)");
  assert.match(tl[2].html, /<p>Buongiorno,<br>basta rigenerare il flusso\.<\/p>/);
  assert.match(tl[2].text, /basta rigenerare il flusso/);
  assert.equal(tl[2].attachments, 1);
  assert.equal(tl[2].date.getDate(), 23);
});

test("storico: ricerca e lettura del ticket; firma scaduta → si rilegge; senza centro o senza sessione → errore chiaro", async () => {
  const calls = [];
  let staleOnce = true;
  const request = async (path, { body } = {}) => {
    calls.push(path + (body ? " " + body.slice(0, 60) : ""));
    if (path === "/jsp/gspv_psearch_res.jsp") return RES_PAGE;
    if (path === "/servlet/SQLDataProviderServer" && /sqlcmd=gspv_qsearch_tickets/.test(body)) {
      if (staleOnce) { staleOnce = false; return "<html>errore</html>"; }
      return sqlResponse(/p_NumIni=5123456/.test(body) ? [sqlRow("5123456", "Errore Uniemens", "2021-02-22")] : [sqlRow("5123456", "Errore Uniemens", "2021-02-22"), sqlRow("5123457", "Altro", "2021-02-23")], 2);
    }
    if (path === "/servlet/SQLDataProviderServer" && /gspv_qviewallegati_ope/.test(body)) {
      return JSON.stringify({ Fields: ["TANOMEFILE", "TACODFILE", "DT__DATA"], Data: [["flusso.xml", "30000001", "2021-02-23 09:30:00.0"], "tf,CCT,1"] });
    }
    if (path.startsWith("/jsp/gspv_preview_ticket_frame_portlet.jsp?w_TTCODICE=000000005123456")) return PREVIEW;
    throw new Error("richiesta inattesa: " + path);
  };
  const st = makeStorico({ request, centro: () => "PAOW" });
  const res = await st.search({ ...emptyStoricoFilters(), clientCode: "1234" });
  assert.equal(res.rows.length, 2);
  assert.equal(res.total, 2);
  assert.equal(calls.filter((c) => c.startsWith("/jsp/gspv_psearch_res.jsp")).length, 2, "risposta non valida: la firma si rilegge una volta");
  assert.equal(st.state.connected, true);

  const full = await st.loadTicket("5123456");
  assert.equal(full.source, "storico");
  assert.equal(full.id, "5123456");
  assert.equal(full.timeline.length, 3);
  assert.equal(full.attachments.length, 1);
  assert.equal(full.attachments[0].fileName, "flusso.xml");
  assert.match(full.attachments[0].url, /gspv_psearch_card/);
  assert.match(full.row.problem, /Errore nell'invio Uniemens/);
  assert.equal(buildStoricoTicket({ row: res.rows[0], moves: [] }).timeline.length, 0);

  await assert.rejects(makeStorico({ request, centro: () => "" }).search({ number: "1" }), /centro servizi/);
  await assert.rejects(makeStorico({ request: async () => "<html>login</html>", centro: () => "PAOW" }).search({ number: "1" }), /Storico non collegato/);
});

// ---------------------------------------------------------------- nomi per il Vecchio Cruscotto

test("nomi: un ticket di cui si conoscono numero e giorno si chiede allo Storico con una richiesta stretta", async () => {
  assert.equal(shiftDay(new Date(2026, 2, 1), -1), "2026-02-28");
  assert.equal(shiftDay(null, 1), "");
  const f = ticketLookupFilters({ number: "5123456", date: new Date(2021, 1, 22, 11, 42), clientCode: "1234" });
  const p = Object.fromEntries(buildStoricoParams(f, { centro: "PAOW", cmdhash: HASH, count: false, rows: 5 }));
  assert.equal(p.p_NumIni, "5123456");
  assert.equal(p.p_DatIni, "2021-02-21", "dal giorno prima dell'apertura…");
  assert.equal(p.p_DatFin, "2021-02-24", "…al giorno dopo (il portale manda come fine il giorno seguente)");
  assert.equal(p.p_DataRiferimento, 2, "il periodo si riferisce alla data di apertura");
  assert.equal(p.p_Azienda, "000000000001234");
  assert.equal(p.count, "false");
  // senza data resta la ricerca del numero su tutti gli anni
  const all = Object.fromEntries(buildStoricoParams(ticketLookupFilters({ number: "5123456" }), { centro: "PAOW" }));
  assert.equal(all.p_DatIni, "2000-01-01");
  assert.equal(all.p_DataRiferimento, 1);

  const bodies = [];
  const request = async (path, { body } = {}) => {
    if (path === "/jsp/gspv_psearch_res.jsp") return RES_PAGE;
    bodies.push(body);
    return sqlResponse(/p_NumIni=5123456/.test(body) ? [sqlRow("5123456", "Errore Uniemens", "2021-02-22")] : [], -1);
  };
  const st = makeStorico({ request, centro: () => "PAOW" });
  const row = await st.findTicket({ number: "5123456", date: new Date(2021, 1, 22), clientCode: "1234" });
  assert.equal(row.account, "ALFA MECCANICA SRL");
  assert.equal(row.assigned, "VERDI LAURA");
  assert.equal(row.assignedId, "000000000100001");
  assert.match(bodies[0], /count=false/);
  assert.match(bodies[0], /p_DatIni=2021-02-21/);
  assert.equal(await st.findTicket({ number: "5999999", date: new Date(2021, 1, 22) }), null, "ticket che lo Storico non riporta");
});

test("nomi: ticket del Vecchio Cruscotto completato con la scheda (chi scrive) e con lo Storico (cliente, operatore)", () => {
  const arRow = {
    id: "5123456", source: "ar", ttCodice: "000000005123456", subject: "Errore Uniemens", date: new Date(2021, 1, 22), statusId: "S5", statusText: "Chiuso (Vecchio cruscotto)",
    fullText: "Errore nell'invio  basta rigenerare il flusso", account: "Cliente 1234", customerCode: "1234", ownerGroup: "PAOW · 10663", ownerGroupId: "10663",
    assigned: "Op. 100001", assignedId: "000000000100001", cenSer: "PAOW", priority: "",
  };
  const full = buildArTicket({ id: "5123456", row: arRow });
  assert.equal(full.row.ttCodice, "000000005123456", "la riga del ticket conserva i codici");
  assert.equal(full.row.customerCode, "1234");
  assert.equal(full.timeline[0].account, "Cliente 1234");
  assert.equal(enrichArTicket(full, {}), full, "senza dati in più resta com'è");

  const moves = parsePreview(PREVIEW).map((m, i) => ({ ...m, DTMITPER: i === 0 ? "000000000555555" : "000000000100001", DTDESPER: "" }));
  assert.deepEqual(movePeople(moves), { "000000000100001": "VERDI LAURA" }, "solo chi scrive dal centro servizi, non il cliente");

  const st = makeStorico({ request: async () => "", centro: () => "PAOW" });
  assert.equal(typeof st.loadMoves, "function");
  const info = storicoRow(Object.fromEntries(FIELDS.map((k, i) => [k, String(sqlRow("5123456", "Errore Uniemens", "2021-02-22")[i]).trim()])));
  const rich = enrichArTicket(full, { info, moves, attachments: [{ id: "st-1", fileName: "flusso.xml" }] });
  assert.equal(rich.source, "ar", "resta un ticket del Vecchio Cruscotto");
  assert.equal(rich.row.account, "ALFA MECCANICA SRL");
  assert.equal(rich.row.contact, "ROSSI ANNA");
  assert.equal(rich.row.assigned, "VERDI LAURA");
  assert.equal(rich.row.ownerGroup, "Paghe Web P");
  assert.equal(rich.row.statusText, "Chiuso");
  assert.equal(rich.row.fullText, arRow.fullText, "il testo per la ricerca resta");
  assert.equal(rich.timeline.length, 3);
  assert.equal(rich.timeline[0].author, "ROSSI ANNA");
  assert.equal(rich.timeline[0].account, "ALFA MECCANICA SRL");
  assert.equal(rich.timeline[2].author, "VERDI LAURA (Paghe Web P)");
  assert.equal(rich.attachments.length, 1);
  assert.match(rich.notes[0], /scheda del ticket/);

  // solo la scheda (lo Storico non riporta il ticket): i nomi di chi scrive ci sono comunque
  const onlyMoves = enrichArTicket(full, { moves });
  assert.equal(onlyMoves.row.account, "Cliente 1234");
  assert.equal(onlyMoves.row.contact, "ROSSI ANNA");
  assert.equal(onlyMoves.timeline[2].author, "VERDI LAURA (Paghe Web P)");
  // solo lo Storico (scheda non leggibile): nomi nei dati del ticket, conversazione ricostruita dal testo
  const onlyInfo = enrichArTicket(full, { info });
  assert.equal(onlyInfo.row.account, "ALFA MECCANICA SRL");
  assert.equal(onlyInfo.timeline, full.timeline);
});

test("storico/ar: allegati Area Riservata con VFCODICEID + VFAUTHCODE → percorso diretto gsdm_btlk_openfile e download binario", async () => {
  const { storicoAttachmentPath, parseArSizeKb } = await import("../lib/storico.js");
  const { makeAr } = await import("../lib/ar.js");

  assert.equal(
    storicoAttachmentPath("30993517", "iqmzdmdyvw"),
    "/servlet/gsdm_btlk_openfile?p_VFCODICEID=30993517&p_VFAUTHCODE=iqmzdmdyvw",
  );
  assert.equal(storicoAttachmentPath("30993517", ""), "");
  assert.equal(parseArSizeKb("125,5 KB"), 125.5);
  assert.equal(parseArSizeKb("2 MB"), 2048);

  const request = async (path, { body } = {}) => {
    if (path === "/jsp/gspv_psearch_res.jsp") return RES_PAGE;
    if (path === "/servlet/SQLDataProviderServer" && /sqlcmd=gspv_qsearch_tickets/.test(body)) {
      return sqlResponse([sqlRow("5123456", "Errore Uniemens", "2021-02-22")], 1);
    }
    if (path === "/servlet/SQLDataProviderServer" && /gspv_qviewallegati_ope/.test(body)) {
      return JSON.stringify({
        Fields: ["TANOMEFILE", "TACODFILE", "VFCODICEID", "VFAUTHCODE", "VFSIZE", "TASERIALE", "DT__DATA"],
        Data: [["cedolino.pdf", "30993517", "30993517", "iqmzdmdyvw", "125,5 KB", "000000000000003", "2021-02-23 09:30:00.0"], "tf,CCCCCC,1"],
      });
    }
    if (path.startsWith("/jsp/gspv_preview_ticket_frame_portlet.jsp")) return PREVIEW;
    throw new Error("richiesta inattesa: " + path);
  };
  const st = makeStorico({ request, centro: () => "PAOW" });
  const full = await st.loadTicket("5123456");
  assert.equal(full.attachments.length, 1);
  assert.equal(full.attachments[0].fileName, "cedolino.pdf");
  assert.equal(full.attachments[0].arPath, "/servlet/gsdm_btlk_openfile?p_VFCODICEID=30993517&p_VFAUTHCODE=iqmzdmdyvw");
  assert.equal(full.attachments[0].url, "");
  assert.equal(full.attachments[0].sizeKb, 125.5);
  assert.equal(full.timeline[2].attachmentItems.length, 1);
  assert.equal(full.timeline[2].attachmentItems[0].fileName, "cedolino.pdf");

  // requestBinary scarica i byte reali e rifiuta una eventuale pagina HTML di login
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const arClient = makeAr({
    fetch: async (url) => {
      assert.match(url, /\/areariservata\/servlet\/gsdm_btlk_openfile\?p_VFCODICEID=30993517&p_VFAUTHCODE=iqmzdmdyvw$/);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf", "content-disposition": 'attachment; filename="cedolino.pdf"' }),
        arrayBuffer: async () => pdfBytes.buffer,
      };
    },
  });
  const bin = await arClient.requestBinary(full.attachments[0].arPath, { fileName: "cedolino.pdf" });
  assert.equal(bin.contentType, "application/pdf");
  assert.equal(bin.fileName, "cedolino.pdf");
  assert.deepEqual([...bin.bytes], [0x25, 0x50, 0x44, 0x46, 0x2d]);

  const arLogin = makeAr({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      arrayBuffer: async () => new TextEncoder().encode("<html><body>Login Area Riservata</body></html>").buffer,
    }),
  });
  await assert.rejects(() => arLogin.requestBinary(full.attachments[0].arPath, { fileName: "cedolino.pdf" }), /Sessione Area Riservata scaduta/);
});

test("storico: estrazione TXT include tutti i movimenti cronologici con gruppo mittente, destinatario 2° livello e nome partner", async () => {
  const { formatTicketTxt, ticketTxtFilename } = await import("../lib/ticket.js");
  const html2L = `<!DOCTYPE html><html><body>
${move("m1", { date: "10-03-2026 09:10", cause: "Nuovo ticket", serial: "000000000000001", mit: 2, des: 1, from: "BIANCHI MARIO", to: "Paghe 1° Livello", text: "Anomalia calcolo TFR." })}
${move("m2", { date: "10-03-2026 10:25", cause: "Passaggio 2° livello", serial: "000000000000002", mit: 1, des: 1, from: "VERDI LAURA", fromGroup: "Paghe 1° Livello", to: "FONTANA MARCO", text: "Inoltro al 2° livello per analisi SQL." }).replace("this.DESGRU_DES=new ZtVWeb._VC(this,'DESGRU_DES',null,'character','')", "this.DESGRU_DES=new ZtVWeb._VC(this,'DESGRU_DES',null,'character','Sviluppo 2° Livello')")}
${move("m3", { date: "10-03-2026 14:00", cause: "Risposta interna", serial: "000000000000003", mit: 1, des: 1, from: "FONTANA MARCO", fromGroup: "Sviluppo 2° Livello", to: "VERDI LAURA", text: "Confermato bug nella procedura." }).replace("this.DESGRU_DES=new ZtVWeb._VC(this,'DESGRU_DES',null,'character','')", "this.DESGRU_DES=new ZtVWeb._VC(this,'DESGRU_DES',null,'character','Paghe 1° Livello')")}
${move("m4", { date: "10-03-2026 16:45", cause: "Risposta a cliente", serial: "000000000000004", mit: 1, des: 2, from: "VERDI LAURA", fromGroup: "Paghe 1° Livello", to: "BIANCHI MARIO", text: "Fix rilasciato, rielaborare." })}
</body></html>`;
  const moves = parsePreview(html2L);
  const full = buildStoricoTicket({
    row: { id: "8901234", source: "storico", subject: "Anomalia TFR", account: "STUDIO PARTNER SRL", customerCode: "4567", ownerGroup: "Paghe 1° Livello", assigned: "VERDI LAURA", date: new Date(2026, 2, 10, 9, 10) },
    moves,
    attachments: [{ id: "st-1", fileName: "tracciato.txt", sizeKb: 4.5, serial: "000000000000001" }],
  });
  assert.equal(full.timeline[1].internal, true);
  assert.equal(full.timeline[1].secondLevel, true);
  assert.equal(full.timeline[1].group, "Paghe 1° Livello");
  assert.equal(full.timeline[1].toGroup, "Sviluppo 2° Livello");
  assert.equal(full.timeline[2].group, "Sviluppo 2° Livello");

  assert.equal(ticketTxtFilename(full), "ticket_8901234.txt");
  const txt = formatTicketTxt(full, { exportedAt: new Date(2026, 10, 27, 17, 55) });
  assert.match(txt, /TICKET #8901234 — Anomalia TFR/);
  assert.match(txt, /\[1\] RICHIESTA INIZIALE[\s\S]*Data e ora:\s+10\/03\/2026 09:10[\s\S]*Chi scrive:\s+BIANCHI MARIO \(Cliente \/ Partner\)[\s\S]*Gruppo \/ Partner:\s+STUDIO PARTNER SRL \(cod\. 4567\)/);
  assert.match(txt, /\[2\] NOTA INTERNA \/ SCAMBIO 2° LIVELLO[\s\S]*Chi scrive:\s+VERDI LAURA \(Operatore\)[\s\S]*Gruppo \/ Partner:\s+Paghe 1° Livello[\s\S]*Destinatario:\s+FONTANA MARCO \(Sviluppo 2° Livello\)[\s\S]*Visibilità:\s+NON visibile a clienti e partner/);
  assert.match(txt, /\[3\] NOTA INTERNA \/ SCAMBIO 2° LIVELLO[\s\S]*Chi scrive:\s+FONTANA MARCO \(Operatore\)[\s\S]*Gruppo \/ Partner:\s+Sviluppo 2° Livello/);
  assert.match(txt, /\[4\] RISPOSTA OPERATORE[\s\S]*Data e ora:\s+10\/03\/2026 16:45[\s\S]*Fix rilasciato, rielaborare\./);
});

