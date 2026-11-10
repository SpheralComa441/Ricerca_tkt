// Prova completa del segnalibro sul finto portale ticket (bookmarklet/test/fake_hdaportal.py).
//   BASE=http://127.0.0.1:8770 node bookmarklet/test/e2e.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:8770";
// finta Area Riservata su un'altra porta (un altro sito, come nella realtà)
const BASE_AR = process.env.BASE_AR || "http://127.0.0.1:8772";
const AR_PAGE = BASE_AR + "/areariservata/jsp/sipv_psearch_infi.jsp";
const SHOTS = process.env.SHOTS || "";
const HREF = fs.readFileSync(path.join(__dirname, "..", "dist", "bookmarklet.txt"), "utf8").trim();
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function portal(page, query) {
  await page.goto(BASE + "/HDAPortal/" + (query || ""));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(600); // primo caricamento dell'elenco All tickets
}
async function clickBookmarklet(page) {
  await page.evaluate((href) => {
    const a = document.createElement("a");
    a.id = "__bm";
    a.href = href;
    a.textContent = "bm";
    a.style.cssText = "position:fixed;left:0;top:0;z-index:99999";
    document.body.appendChild(a);
  }, HREF);
  await page.click("#__bm", { force: true });
  await page.evaluate(() => { const a = document.getElementById("__bm"); if (a) a.remove(); });
  await page.locator("#q").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
}
// registro delle richieste di questa prova soltanto (più prove possono usare lo stesso finto portale)
const RUN = `${process.pid}-${Date.now()}`;
const log = async (page) => (await (await page.request.get(`${BASE}/__log?run=${RUN}`)).json());
const resetLog = (page) => page.request.post(`${BASE}/__reset?run=${RUN}`);
const sh = (page, fn, arg) => page.evaluate(fn, arg);
const P0 = "id0a9c7e5b3d1f2468_UC_";
const lastList = (l) => [...l].reverse().find((x) => x.params) || {};
const fval = (entry, name) => ((entry.filters || []).find((f) => f.name === name) || {}).value;
async function waitDone(page) {
  await page.waitForFunction(() => {
    const r = document.getElementById("ricerca-tkt-host").shadowRoot;
    return r.querySelector("#prog").hidden && !r.querySelector("#go").disabled;
  }, null, { timeout: 30000 });
}
async function search(page, text) {
  await page.fill("#q", text);
  await page.click("#go");
  await waitDone(page);
}
const txt = (page, sel) => page.locator(sel).first().innerText();
const host = (page) => page.locator("#ricerca-tkt-host");
const isOpen = async (page) => host(page).evaluate((e) => e.style.display !== "none");

(async () => {
  const browser = await chromium.launch();
  const ctxOpts = { viewport: { width: 1400, height: 950 }, acceptDownloads: true, extraHTTPHeaders: { "x-e2e-run": RUN } };
  const ctx = await browser.newContext(ctxOpts);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  const errors = [];
  const expected = (t) => /status of 401|Failed to load resource/.test(t);
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !expected(m.text())) errors.push(m.text()); });

  // ---- pagina "ostile" (Set, Map, Array.from, Intl ridefiniti) con il segnalibro già nella pagina --
  {
    const hp = await ctx.newPage();
    const herr = [];
    hp.on("pageerror", (e) => herr.push(e.message));
    let dialog = "";
    hp.on("dialog", async (d) => { dialog = d.message(); await d.dismiss(); });
    await hp.goto(BASE + "/HDAPortal/?ostile=1&tab=all");
    await hp.waitForTimeout(1500);
    await hp.click("#__bm");
    const opened = await hp.locator("#q").waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    check(opened, `si apre anche se la pagina ridefinisce Set/Map/Array.from/Intl ${dialog ? "(" + dialog.slice(0, 120) + ")" : ""}`);
    if (opened) {
      await hp.fill("#q", "detassazione");
      await hp.click("#go");
      await hp.locator("#prog").waitFor({ state: "hidden", timeout: 30000 });
      check((await hp.locator(".res").count()) === 50, "ricerca e risultati sulla pagina ostile");
      await hp.click("#f-status li:first-child button");
      check((await hp.locator("#sum").innerText()).includes("dopo i filtri"), "faccette sulla pagina ostile");
      await hp.click(".res .ib[aria-pressed]");
      check((await hp.locator("#fav-count").innerText()) === "1", "preferiti sulla pagina ostile");
      await hp.click(".res .ib[aria-pressed]");
    }
    check(herr.length === 0, `nessun errore sulla pagina ostile ${herr.length ? JSON.stringify(herr) : ""}`);
    await hp.close();
  }

  // ---- vecchia Area Riservata aperta da sola: il segnalibro spiega come collegarla ----------
  {
    const op = await ctx.newPage();
    let alerted = "";
    op.on("dialog", async (d) => { alerted = d.message(); await d.dismiss(); });
    await op.goto(AR_PAGE + "?ostile=1");
    await clickBookmarklet(op);
    await op.waitForTimeout(400);
    const card = await op.evaluate(() => { const h = document.getElementById("ricerca-tkt-ponte"); return h ? h.shadowRoot.textContent : ""; });
    check(!alerted && card.includes("Collega l'Area Riservata"), "nell'Area Riservata aperta da sola il segnalibro spiega come collegarla");
    await op.close();
  }

  // ---- portale: filtri applicati automaticamente, scheda Home aperta (elenco non ancora disegnato)
  await portal(page, "?apply=auto");
  await resetLog(page);
  await clickBookmarklet(page);
  check(await page.locator("#q").isVisible(), "il pannello si apre sopra il portale");
  check(await page.evaluate(() => document.body.inert === true), "il portale sotto il pannello non riceve tastiera e clic");
  check((await txt(page, "#qprev")).includes("tutti i ticket (All tickets)"), "usa l'elenco All tickets anche dalla Home");
  check((await page.locator("#lst").count()) === 0 && (await page.inputValue("#capq")) === "200", "nessuna scelta dell'elenco, massimo ticket nella barra");
  check((await page.inputValue("#st")) === "all", "stato predefinito: tutti");
  await page.click("#adv summary");
  check((await page.locator("#pr-list button").count()) === 5, "priorità lette dal filtro della pagina");
  check((await page.locator("#pf .pr").count()) === 4 && (await page.locator("#pf .chip").count()) === 0, `altri filtri del portale nel pannello, nessuno impostato (${await page.locator("#pf .pr .lb").allInnerTexts()})`);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-01-aperto.png" });

  await search(page, "detassazione");
  let l = await log(page);
  let e = lastList(l);
  check(l.length === 1, `una sola richiesta per ricerca (${l.length})`);
  check(e.params && e.params.limit === "200" && e.token, `richiesta del portale con il token e 200 righe (limit ${e.params && e.params.limit})`);
  check(fval(e, "FullText") === "detassazione", "testo nel campo Search del portale");
  check((fval(e, "TicketStatusID") || []).length === 15, "tutti gli stati (non solo quelli aperti della pagina)");
  check((await txt(page, "#sum")).startsWith("197"), `197 ticket mostrati (${(await txt(page, "#sum")).replace(/\s+/g, " ")})`);
  check((await page.locator("#list .res").count()) === 50, "50 risultati per pagina");
  const first = page.locator("#list .res").first();
  check(/^\d{7,8}Z$/.test(await first.locator(".num").innerText()), "ID del ticket");
  check((await first.locator(".subj mark").count()) > 0, "parole evidenziate nell'oggetto");
  check((await first.locator(".snip").first().innerText()).length > 40, "anteprima della richiesta (dal riepilogo dell'oggetto)");
  check((await first.locator(".badge").first().innerText()).length > 2, "stato del ticket");
  check((await first.locator(".meta").innerText()).includes("Servizio"), "servizio, sede e altri dati");
  // ultime righe: non disegnate dalla griglia (rendering a blocchi), lette dal renderer delle colonne
  await page.locator("#pager button", { hasText: "4" }).click();
  const lastRes = page.locator("#list .res").last();
  check((await lastRes.locator(".badge").count()) >= 2 && (await lastRes.locator(".snip").count()) >= 1, "anche le righe non disegnate dalla griglia hanno stato e anteprima");
  await page.locator("#pager button", { hasText: "1" }).click();
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-02-risultati.png" });

  // faccette, filtro testuale, ordinamento, raggruppamento
  await page.locator("#f-status li button", { hasText: "Closed" }).click();
  check((await txt(page, "#sum")).includes("dopo i filtri"), "faccetta Stato applicata");
  const badges = await page.locator("#list .res .badge:not(.pr)").allInnerTexts();
  check(badges.length > 0 && badges.every((b) => b === "Closed"), "solo ticket Closed");
  await page.click("#active .chip button");
  await page.fill("#refine", "-cedolino");
  await page.waitForTimeout(300);
  const nref = await page.locator("#list .res").count();
  const anyCed = await page.locator("#list .res .subj", { hasText: /cedolino/i }).count();
  check(nref > 0 && anyCed === 0, "filtro nei risultati con esclusione");
  await page.fill("#refine", "");
  await page.selectOption("#sort", "date_asc");
  const ds = (await page.locator("#list .res time").allInnerTexts()).map((d) => d.slice(0, 10).split("/").reverse().join("-"));
  check(ds.join() === [...ds].sort().join(), "ordinamento per data di apertura");
  await page.selectOption("#sort", "rank");
  await page.selectOption("#group", "status");
  check((await page.locator(".gt").count()) >= 2, "raggruppamento per stato");
  await page.selectOption("#group", "none");

  // esportazione
  await page.click("#exp");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expm button[data-x="csv"]')]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  check(csv.startsWith("﻿ID;Data apertura;Ora") && csv.split("\r\n").length === 198, `CSV con 197 righe (${csv.split("\r\n").length - 1})`);
  await page.click("#exp");
  await page.click('#expm button[data-x="codes"]');
  const codes = (await page.evaluate(() => navigator.clipboard.readText())).split("\n");
  check(codes.length === 197 && codes.every((c) => /^\d{7,8}Z$/.test(c)), `copia degli ID (${codes.length}: ${codes.slice(0, 2)})`);

  // preferito con nota
  const favCode = await first.locator(".num").innerText();
  await page.click("#list .res .ib[aria-pressed]");
  await page.click('#list .res .ib[title="Nota ed etichette"]');
  await page.fill("#ntext", "Da rivedere");
  await page.fill("#ntags", "normativa");
  await page.press("#ntags", "Enter");
  check((await txt(page, "#fav-count")) === "1", "preferito salvato");
  check((await page.locator("#f-tag").count()) === 1, "faccetta delle etichette");

  // salva ricerca, cronologia
  await page.click("#qsave");
  await page.fill("#sname", "Detassazione");
  await page.click('#dsave button[value="ok"]');
  await page.click('#nav button[data-tab="saved"]');
  check((await txt(page, "#saved")).includes("Detassazione"), "ricerca salvata");
  await page.click('#nav button[data-tab="history"]');
  check((await page.locator("#hist .li").count()) >= 1, "cronologia aggiornata");
  await page.click('#nav button[data-tab="search"]');

  // filtri avanzati: stati chiusi, priorità, oggetto, periodo
  await resetLog(page);
  await page.selectOption("#st", "closed");
  await page.locator("#pr-list button", { hasText: "P2" }).click();
  await page.fill("#subject", "detassazione");
  await page.selectOption("#preset", "2y");
  await page.waitForTimeout(250);
  check((await txt(page, "#qprev")).includes("stati chiusi e risolti") && (await txt(page, "#qprev")).includes("Priorità: P2"), "anteprima dei filtri inviati");
  await search(page, "");
  e = lastList(await log(page));
  const stc = (fval(e, "TicketStatusID") || []).slice().sort().join(",");
  check(stc === "S4,S5,S6,Z2C", `solo gli stati chiusi e risolti (${stc})`);
  check(JSON.stringify(fval(e, "TicketPriorityID")) === '["P2"]' && fval(e, "Subject") === "detassazione", "priorità e oggetto");
  const dates = (e.filters || []).filter((f) => f.name === "Date").map((f) => f.op).sort().join();
  check(dates === "ge,le", "periodo di apertura dal/al");
  const prios = await page.locator("#list .res .badge.pr").allInnerTexts();
  check(prios.length > 0 && prios.every((p) => p.startsWith("P2")), `risultati coerenti (${prios.length})`);
  await page.click("#qreset");
  check((await page.inputValue("#st")) === "all" && (await page.locator('#pr-list button[aria-pressed="true"]').count()) === 0, "Azzera riporta i valori iniziali");

  // stato scelto a mano
  await page.selectOption("#st", "custom");
  await page.click('[data-sel="st:none"]');
  await page.locator("#st-list button", { hasText: "Reopened" }).click();
  await resetLog(page);
  await search(page, "cedolino");
  e = lastList(await log(page));
  check(JSON.stringify(fval(e, "TicketStatusID")) === '["Z4C"]', "stato scelto a mano");
  await page.selectOption("#st", "all");

  // filtro impostato nella pagina del portale: mantenuto e mostrato
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => document.body.inert === false), "il portale torna utilizzabile dopo la chiusura");
  await page.evaluate(async (P) => {
    // come una scelta fatta nel menu del portale: ramo del servizio aperto, poi il valore
    const f = Ext.getCmp(P + "filter_default_ServiceFilter"), st = f.getStore();
    await new Promise((r) => st.getRootNode().expand(false, r));
    await new Promise((r) => st.getNodeById("F1").expand(false, r));
    f.setValue("SV1");
  }, P0);
  await page.waitForTimeout(1200);
  await clickBookmarklet(page);
  check((await txt(page, '#pf [data-pf="ServiceFilter"]')).includes("Informazione / PAGHE INFINITY"), "filtro Servizio della pagina mostrato nel pannello");
  check((await txt(page, "#qprev")).includes("Service = Informazione / PAGHE INFINITY"), "e indicato tra i filtri inviati");
  await resetLog(page);
  await search(page, "detassazione");
  e = lastList(await log(page));
  check(fval(e, "ServiceID") === "SV1", "filtro della pagina mantenuto nella ricerca");
  const svc = await page.locator("#list .res").allInnerTexts();
  check(svc.length > 0 && svc.every((s) => s.includes("Informazione / PAGHE INFINITY")), "risultati del servizio scelto");
  await page.click('#pf [data-pf="ServiceFilter"] .chip button');
  check(await page.evaluate(() => !Ext.getCmp("id0a9c7e5b3d1f2468_UC_filter_default_ServiceFilter").getValue()), "il filtro della pagina si può togliere dal pannello");

  // più risultati del massimo: avviso e "carica i successivi"
  await resetLog(page);
  await search(page, "cedolino");
  const al = await txt(page, "#alert");
  check(/Il portale ha [\d.]+ ticket/.test(al), `avviso del limite (${al.slice(0, 80)})`);
  const before = (await txt(page, "#sum")).split(" ")[0];
  await page.click("#more");
  await waitDone(page);
  l = await log(page);
  check(l.length === 2 && l[1].params.page === "2" && l[1].params.start === "200", "pagina successiva del portale");
  check((await txt(page, "#sum")).split(" ")[0] !== before, "risultati aggiunti");

  // conteggio per anno: una richiesta per anno, fino a coprire il totale, poi l'elenco torna sulla ricerca
  await page.click("#qreset");
  await resetLog(page);
  await search(page, "cedolino");
  const totalTxt = (await txt(page, "#alert")).match(/ha ([\d.]+) ticket/);
  const total = totalTxt ? +totalTxt[1].replace(/\./g, "") : 0;
  check((await txt(page, "#sum")).includes("i più recenti su"), "riepilogo: i più recenti su tutti");
  await page.click("#yearsbtn");
  await waitDone(page);
  const yrows = await page.locator("#years .yr").count();
  const ysum = await txt(page, "#years");
  l = await log(page);
  const counts = l.filter((x) => x.params && x.params.limit === "1");
  const lastReq = lastList(l);
  check(yrows >= 5 && ysum.includes(`${total.toLocaleString("it-IT")} su ${total.toLocaleString("it-IT")} contati`), `ticket per anno: ${yrows} anni, totale ${total}`);
  check(counts.length === yrows && counts.every((x) => (x.filters || []).filter((f) => f.name === "Date").length === 2), `una richiesta per anno con il periodo dell'anno (${counts.length}: ${counts.map((x) => (x.filters || []).filter((f) => f.name === "Date").map((f) => f.value).join("/") + "=" + x.total).join(" ")})`);
  check(lastReq.params.limit === "200" && !(lastReq.filters || []).some((f) => f.name === "Date"), "poi l'elenco del portale torna sulla ricerca");
  const year2 = await page.locator("#years .yr").nth(2).locator("b").innerText();
  await page.locator("#years .yr").nth(2).locator("button").click();
  await waitDone(page);
  const ydates = await page.locator("#list .res time").allInnerTexts();
  check(ydates.length > 0 && ydates.every((d) => d.slice(6, 10) === year2) && (await page.locator("#years").isVisible()), `ricerca nel ${year2} con un clic, il riepilogo per anno resta`);
  // un altro anno dallo stesso riepilogo: il periodo è quello del nuovo anno (non incrociato con il precedente)
  const year4 = await page.locator("#years .yr").nth(4).locator("b").innerText();
  await resetLog(page);
  await page.locator("#years .yr").nth(4).locator("button").click();
  await waitDone(page);
  const y4dates = await page.locator("#list .res time").allInnerTexts();
  const y4req = (lastList(await log(page)).filters || []).filter((f) => f.name === "Date").map((f) => `${f.op}:${f.value}`).sort().join(" ");
  check(y4dates.length > 0 && y4dates.every((d) => d.slice(6, 10) === year4) && y4req === `ge:${year4}-01-01 le:${year4}-12-31` && (await page.inputValue("#q")) === "cedolino", `secondo anno dallo stesso riepilogo (${year4}: ${y4req})`);
  await page.click("#qreset");

  // gruppi e persone: ricerca del nome nel portale (Modified by) e scelta dal menu del portale (Assigned to)
  await page.evaluate(() => { document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#adv").open = true; });
  check((await page.locator("#ppl .pr").count()) === 4, "quattro filtri di gruppi e persone");
  await page.fill('[data-ppl="ModifiedBy"]', "ro");
  await page.locator("#ppl .sug button").first().waitFor({ timeout: 10000 });
  const who = await page.locator("#ppl .sug button").first().innerText();
  await page.locator("#ppl .sug button").first().click();
  await page.waitForTimeout(200);
  check((await txt(page, "#ppl")).includes(who) && (await txt(page, "#qprev")).includes(`Modificato da = ${who}`), `persona scelta con la ricerca del portale (${who})`);
  // Assegnato a: elenco ad albero dentro il pannello (gruppi, poi le persone del gruppo caricate dal portale)
  await page.click('[data-pftree="AssignedUserOrGroupFilter"]');
  await page.locator('[data-tree="AssignedUserOrGroupFilter"] .nm').first().waitFor({ timeout: 10000 });
  const groupsShown = await page.locator('[data-tree="AssignedUserOrGroupFilter"] .nm').allInnerTexts();
  await page.locator('[data-tree="AssignedUserOrGroupFilter"] li', { hasText: "HR Fiscale" }).locator(".tgl").click();
  await page.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelectorAll('[data-tree="AssignedUserOrGroupFilter"] .nm').length > 5, null, { timeout: 10000 });
  const inGroup = (await page.locator('[data-tree="AssignedUserOrGroupFilter"] .nm').count()) - groupsShown.length;
  await page.locator('[data-tree="AssignedUserOrGroupFilter"] .nm', { hasText: /^HR Fiscale$/ }).click();
  await page.waitForTimeout(300);
  check(groupsShown.length === 5 && inGroup > 0 && (await txt(page, '#ppl [data-pf="AssignedUserOrGroupFilter"]')).includes("HR Fiscale"), `gruppo scelto dall'elenco ad albero nel pannello (${groupsShown.length} gruppi, ${inGroup} persone nel ramo)`);
  // Gruppo proprietario: con il menu del portale (resta come alternativa)
  await page.locator('#ppl [data-pf="OwnerUserGroupID"]').locator("button", { hasText: "Menu del portale" }).click();
  await page.waitForTimeout(500);
  check(!(await isOpen(page)) && (await page.locator("#ricerca-tkt-pill button").isVisible()), "scelta nel portale: il pannello si nasconde e compare il promemoria");
  await page.locator(".fake-tree-picker .x-tree-node-text", { hasText: "HR Fiscale" }).click();
  await page.waitForTimeout(800);
  check(await isOpen(page) && (await txt(page, '#ppl [data-pf="OwnerUserGroupID"]')).includes("HR Fiscale"), "dopo la scelta Ricerca TKT si riapre con il gruppo");
  await resetLog(page);
  await search(page, "");
  e = lastList(await log(page));
  const whoCode = await page.evaluate((n) => (CFG.users.find((u) => u[1] === n) || [])[0], who);
  check(fval(e, "ModifiedBy") === whoCode && fval(e, "AssignedUserOrGroupID") === "G3" && fval(e, "OwnerUserGroupID") === "G3", `filtri di gruppo e persona inviati al portale (${fval(e, "ModifiedBy")}, ${fval(e, "AssignedUserOrGroupID")}, ${fval(e, "OwnerUserGroupID")})`);
  const metas = await page.locator("#list .res .meta").allInnerTexts();
  check(metas.length > 0 && metas.every((x) => x.includes(who) && x.includes("HR Fiscale")), `risultati del gruppo e della persona (${metas.length})`);
  check((await page.locator("#f-modifiers").count()) === 1, "faccetta Modificato da");
  await page.click("#qsave");
  await page.fill("#sname", "Persona e gruppo");
  await page.click('#dsave button[value="ok"]');
  await page.click("#qreset");
  check((await txt(page, "#ppl")).includes("qualsiasi") && await page.evaluate(() => !Ext.getCmp("id0a9c7e5b3d1f2468_UC_filter_default_ModifiedBy").getValue()), "Azzera toglie anche gruppi e persone dalla pagina");
  await page.click('#nav button[data-tab="saved"]');
  await resetLog(page);
  await page.locator("#saved .li", { hasText: "Persona e gruppo" }).locator("button", { hasText: "Esegui" }).click();
  await waitDone(page);
  e = lastList(await log(page));
  check(fval(e, "ModifiedBy") === whoCode && fval(e, "AssignedUserOrGroupID") === "G3", "la ricerca salvata rimette gruppo e persona");
  await page.click("#qreset");

  // apertura del ticket nel portale (pulsante Open della pagina)
  await page.selectOption("#sort", "rank");
  await search(page, "detassazione");
  const code0 = await page.locator("#list .res .num").first().innerText();
  await page.evaluate(() => localStorage.removeItem("rtkt2:touchUrl"));
  await search(page, "detassazione");
  const [tab0] = await Promise.all([ctx.waitForEvent("page"), page.locator("#list .res").first().locator("button", { hasText: "Apri in Touch" }).click()]);
  await tab0.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(400);
  check(/\/HDAPortal\/Ticket\/View\?id=\d+/.test(tab0.url()) && await page.evaluate((c) => window.__opened.includes(c), code0), `ticket ${code0} aperto dal portale in una nuova scheda (${tab0.url().replace(BASE, "")})`);
  await tab0.close();
  check(await isOpen(page), "il pannello resta aperto nella scheda del portale");
  const learned = await page.evaluate(() => JSON.parse(localStorage.getItem("rtkt2:touchUrl") || "null"));
  check(learned && learned.field === "recId" && (await page.locator("#list .res a.btn", { hasText: "Apri in Touch" }).count()) === 50, `indirizzo dei ticket imparato: ogni risultato ha il collegamento diretto (${learned && learned.field})`);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-05-ticket.png" });

  // ticket completo nel pannello: la pagina del ticket letta senza aprire schede
  await resetLog(page);
  let tabs0 = ctx.pages().length;
  await page.locator("#list .res").nth(1).locator("button", { hasText: "Leggi" }).click();
  await page.locator("#rbody .pre").first().waitFor({ timeout: 30000 });
  const rd = { title: await txt(page, "#rtitle"), fields: await page.locator("#rbody .rdf dt").count(), texts: (await page.locator("#rbody .pre").allInnerTexts()).map((x) => x.length), rows: await page.locator("#rbody .rdtab tbody tr").count(), link: await page.locator("#rlink").getAttribute("href") };
  const views = (await log(page)).filter((x) => x.view).length;
  check(rd.fields >= 10 && rd.texts.some((n) => n > 100) && rd.rows >= 2 && /Ticket\/View\?id=/.test(rd.link || "") && ctx.pages().length === tabs0 && views === 1,
    `ticket completo letto nel pannello: campi, testo, messaggi e collegamento (${JSON.stringify(rd)}, ${views} pagina)`);
  await page.click("#rcopy");
  check((await page.evaluate(() => navigator.clipboard.readText())).includes("Issue/Request"), "testo del ticket copiato");
  await page.click("#rclose");

  // preferito non più nell'elenco e indirizzo non ancora noto: Find by ID della pagina, già compilato
  await page.evaluate(() => localStorage.removeItem("rtkt2:touchUrl"));
  await page.keyboard.press("Escape");
  await clickBookmarklet(page);
  check(await isOpen(page), "il segnalibro riapre il pannello");
  check((await page.locator("#list .res").count()) === 50, "risultati conservati alla riapertura");
  await search(page, "conguaglio");
  await page.click('#nav button[data-tab="favorites"]');
  check((await page.locator("#favs .res").count()) === 1 && (await txt(page, "#favs")).includes("Da rivedere"), "preferito con nota");
  await resetLog(page);
  // lettura: Find by ID compilato e confermato, la nuova scheda intercettata e letta nel pannello
  tabs0 = ctx.pages().length;
  await page.locator("#favs .res button", { hasText: "Leggi" }).click();
  await page.locator("#rbody .pre").first().waitFor({ timeout: 30000 }).catch(() => {});
  const finds0 = (await log(page)).filter((x) => x.find).map((x) => x.find);
  check(finds0.includes(favCode) && (await txt(page, "#rbody")).includes(favCode) && ctx.pages().length === tabs0, `preferito letto con Find by ID, senza aprire schede (${finds0})`);
  await page.click("#rclose");
  await page.evaluate(() => localStorage.removeItem("rtkt2:touchUrl"));
  await page.click('#nav button[data-tab="search"]');
  await page.click('#nav button[data-tab="favorites"]');
  await resetLog(page);
  const [tab1] = await Promise.all([ctx.waitForEvent("page"), page.locator("#favs .res button", { hasText: "Apri in Touch" }).click()]);
  await tab1.waitForLoadState("domcontentloaded");
  const finds = (await log(page)).filter((x) => x.find).map((x) => x.find);
  check(finds.includes(favCode) && await page.evaluate((c) => window.__opened.includes(c) && !Ext.Msg.isVisible(), favCode) && tab1.url().includes("/Ticket/View"), `preferito aperto con Find by ID, compilato e confermato (${finds})`);
  await tab1.close();

  // Find by ID con un'altra finestra del portale aperta (Change status...): non scrive e non conferma in quella
  await sh(page, () => {
    window.__opened = []; window.__changed = null;
    Ext.create("Ext.window.Window", { id: "chgwin", title: "Change status", modal: true, width: 420, items: [{ xtype: "textareafield", itemId: "note", fieldLabel: "Note" }],
      buttons: [{ text: "OK", handler: function () { window.__changed = this.up("window").down("#note").getValue(); this.up("window").close(); } }] }).show();
  });
  await page.evaluate(() => localStorage.removeItem("rtkt2:touchUrl"));
  if (!(await isOpen(page))) await clickBookmarklet(page);
  await page.click('#nav button[data-tab="search"]');
  await page.click('#nav button[data-tab="favorites"]');
  const tabsCw = ctx.pages().length;
  await page.locator("#favs .res button", { hasText: "Apri in Touch" }).click();
  await page.waitForTimeout(2000);
  for (const pg of ctx.pages().slice(tabsCw)) await pg.close();
  const cw = await sh(page, (c) => ({ changed: window.__changed, opened: window.__opened.includes(c), open: !!Ext.getCmp("chgwin") && Ext.getCmp("chgwin").isVisible() }), favCode);
  check(cw.changed === null && cw.opened && cw.open, `Find by ID non tocca un'altra finestra aperta (${JSON.stringify(cw)})`);
  await sh(page, () => { Ext.getCmp("chgwin").destroy(); });

  // dati tecnici: struttura dell'elenco, richieste, niente token né dati dei clienti
  if (await isOpen(page)) await page.keyboard.press("Escape");
  await sh(page, () => { Ext.Ajax.request({ url: "/HDAPortal/Account/Save", params: { Note: "ZZ_998877" }, failure() {} }); }); // a pannello chiuso
  await clickBookmarklet(page);
  await sh(page, () => { Ext.Ajax.request({ url: "/HDAPortal/Account/Save", params: { Login: "utente.prova", Phone: "3471234567", VatNumber: "01234567890", Password: "Estate.2025" }, failure() {} }); });
  await page.waitForTimeout(400);
  await page.click('#nav button[data-tab="settings"]');
  const info = await txt(page, "#conninfo");
  check(info.includes("ExtJS 6.2") && info.includes("Subject→subject") && info.includes("avvio automatico"), "stato del collegamento");
  await page.click("#tread");
  check((await txt(page, "#treadout")).includes("righe caricate"), "lettura dell'elenco attuale");
  await page.click("#tcopy");
  const techRaw = await page.evaluate(() => navigator.clipboard.readText());
  const tech = JSON.parse(techRaw);
  check(tech.current && tech.current.store && tech.current.store.proxy.url.includes("/HDAPortal/List/GetData"), "dati tecnici: indirizzo dell'elenco");
  check(tech.current.columns.some((c) => c.header === "Subject" && c.sem === "subject") && tech.current.filters.some((f) => f.suffix === "FullText" && f.controlled), "dati tecnici: colonne e filtri");
  check(tech.requests.length > 0 && JSON.stringify(tech.requests).includes("TicketStatusID"), "dati tecnici: richieste con la struttura dei filtri");
  const sample = await (await page.request.get(BASE + "/__data?limit=3&q=detassazione")).json();
  const leaks = sample.data.flatMap((r) => [r.AccountName, r.ContactName, r.AssignedTo]).filter((x) => techRaw.includes(x));
  check(!techRaw.includes("tok-prova") && !techRaw.includes("SessionId") && leaks.length === 0, `dati tecnici senza token, cookie e nomi ${leaks.length ? JSON.stringify(leaks) : ""}`);
  const secrets = ["ZZ_998877", "utente.prova", "3471234567", "01234567890", "Estate.2025"].filter((x) => techRaw.includes(x));
  check(secrets.length === 0 && techRaw.includes("Account/Save"), `dati tecnici: credenziali e contatti mascherati, niente richieste a pannello chiuso ${secrets.length ? JSON.stringify(secrets) : ""}`);
  const titles = (tech.lists || []).map((x) => x.title).sort().join("|");
  check(titles === "All tickets|My Group Tickets|My tickets|Tickets from my groups" && tech.lists.filter((x) => x.all).length === 1, `elenchi riconosciuti dalle schede (${titles})`);
  check(tech.current.filters.some((f) => f.suffix === "ModifiedBy" && f.people && f.lookup && f.store) && tech.current.filters.some((f) => f.suffix === "AssignedUserOrGroupFilter" && f.people && !f.lookup), "dati tecnici: campi di gruppi e persone");
  check(await page.evaluate(() => window.__activity > 0), "segnala attività al controllo di inattività del portale");

  // ripristino dei filtri che la pagina aveva prima della prima ricerca
  await page.click('#nav button[data-tab="search"]');
  await page.waitForTimeout(200);
  check(await page.locator("#qrestore").isVisible(), "pulsante per ripristinare il portale");
  await resetLog(page);
  await page.click("#qrestore");
  await page.waitForFunction(() => !document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#go").disabled);
  await page.waitForTimeout(300);
  const restored = await page.evaluate(() => {
    const P = "id0a9c7e5b3d1f2468_UC_";
    return { st: Ext.getCmp(P + "filter_default_StatusFilter").getValue(), ft: Ext.getCmp(P + "filter_default_FullText").getValue(), ps: Ext.getCmp(P + "grd").getStore().getPageSize() };
  });
  e = lastList(await log(page));
  check(restored.st.slice().sort().join() === "S1,S10,S2,S8,Z3C,Z4C,Z5C" && restored.ft === "" && restored.ps === 50 && e.params && e.params.limit === "50", `filtri del portale ripristinati (${JSON.stringify(restored)})`);
  check(await page.locator("#qrestore").isHidden(), "dopo il ripristino il pulsante sparisce");

  // massimo di risultati dalle impostazioni
  await page.click('#nav button[data-tab="settings"]');
  await page.selectOption("#s-cap", "50");
  await page.click("#ssave");
  await page.click('#nav button[data-tab="search"]');
  await resetLog(page);
  await search(page, "detassazione");
  e = lastList(await log(page));
  check(e.params.limit === "50" && (await page.locator("#list .res").count()) === 50, `massimo di 50 dalle impostazioni (limit ${e.params.limit}, ${await page.locator("#list .res").count()} risultati)`);

  // con un'altra scheda attiva (My tickets) si cerca comunque in All tickets; massimo dalla barra di ricerca
  await page.keyboard.press("Escape");
  await page.evaluate(() => Ext.getCmp("navbar").setActiveTab("body_MYTKT"));
  await page.waitForTimeout(300);
  await clickBookmarklet(page);
  check((await page.inputValue("#capq")) === "50", "il massimo scelto in Impostazioni compare nella barra");
  await page.selectOption("#capq", "200");
  await resetLog(page);
  await search(page, "cedolino");
  e = lastList(await log(page));
  check(e.list === "INC_ALLGRP_EXTENDED" && e.params.limit === "200", `ricerca su All tickets anche dalla scheda My tickets (${e.list}, ${e.params && e.params.limit})`);

  // importazione di dati personali: niente duplicati, valori strani resi innocui
  await page.click('#nav button[data-tab="settings"]');
  const [pdl] = await Promise.all([page.waitForEvent("download"), page.click("#pexp")]);
  const exported = fs.readFileSync(await pdl.path());
  await page.setInputFiles("#pimp", { name: "dati.json", mimeType: "application/json", buffer: exported });
  await page.waitForTimeout(300);
  await page.setInputFiles("#pimp", { name: "dati.json", mimeType: "application/json", buffer: exported });
  await page.waitForTimeout(300);
  await page.click('#nav button[data-tab="saved"]');
  check((await page.locator("#saved .li").count()) === 2, "importare due volte lo stesso file non duplica le ricerche salvate");
  const evil = { favorites: [{ key: "x", note: "", tags: "non-un-array", ticket: { code: "<img src=x onerror=window.__pwned=1>", subject: "trappola", date: "javascript:1", cols: [{ h: "<b>", v: "<script>window.__pwned=2</script>" }] } }] };
  await page.setInputFiles("#pimp", { name: "evil.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(evil)) });
  await page.waitForTimeout(300);
  await page.click('#nav button[data-tab="favorites"]');
  const trap = page.locator("#favs .res", { hasText: "trappola" });
  check((await trap.count()) === 1, "preferito importato mostrato come testo");
  await trap.locator("summary").click();
  check(await page.evaluate(() => window.__pwned === undefined), "nessun codice eseguito dal preferito importato");
  await page.click('#nav button[data-tab="search"]');

  // Esc chiude; dopo il ricaricamento i dati restano
  await page.keyboard.press("Escape");
  check(!(await isOpen(page)), "Esc chiude il pannello");
  await page.reload();
  await page.waitForFunction(() => window.__ready === true);
  await clickBookmarklet(page);
  check((await txt(page, "#fav-count")) === "2", "preferiti conservati dopo il ricaricamento");

  // ricerca salvata con una persona in una pagina nuova (elenco del campo mai caricato): si vede il nome, non il codice
  await page.click('#nav button[data-tab="saved"]');
  await resetLog(page);
  await page.locator("#saved .li", { hasText: "Persona e gruppo" }).locator("button", { hasText: "Esegui" }).click();
  await waitDone(page);
  e = lastList(await log(page));
  const hist0 = await sh(page, () => JSON.parse(localStorage.getItem("rtkt2:history"))[0]);
  const rawWho = await sh(page, (P) => Ext.getCmp(P + "filter_default_ModifiedBy").getRawValue(), P0);
  check(fval(e, "ModifiedBy") === whoCode && fval(e, "AssignedUserOrGroupID") === "G3" && (await txt(page, "#qprev")).includes(`Modificato da = ${who}`) && hist0.spec.people.ModifiedBy.t === who && rawWho === who,
    `ricerca salvata con persona in una pagina nuova: nome mostrato e conservato (${rawWho}, ${hist0.spec.people.ModifiedBy.t})`);
  await page.click("#qreset");

  // sessione scaduta
  await ctx.clearCookies();
  await search(page, "ferie");
  check((await txt(page, "#alert")).includes("sessione"), "messaggio di sessione scaduta");

  // mobile
  await page.setViewportSize({ width: 390, height: 844 });
  const sw = await page.evaluate(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector(".body").scrollWidth);
  check(sw <= 390, `nessuno scorrimento orizzontale su telefono (${sw})`);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-04-mobile.png" });

  // ---- scheda All tickets mai aperta: il segnalibro la apre e aspetta l'elenco
  {
    const p = await ctx.newPage();
    const perr = [];
    p.on("pageerror", (x) => perr.push(x.message));
    await portal(p, "?lazy=1");
    await p.evaluate(() => localStorage.removeItem("rtkt2:settings"));
    check(await p.evaluate(() => !Ext.getCmp("id0a9c7e5b3d1f2468_UC_ListCt")), "elenco All tickets non ancora creato");
    await resetLog(p);
    await clickBookmarklet(p);
    await p.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#qprev").textContent.includes("All tickets") && !document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#qwarn .note"), null, { timeout: 15000 });
    await search(p, "detassazione");
    const le = lastList(await log(p));
    check(le.list === "INC_ALLGRP_EXTENDED" && fval(le, "FullText") === "detassazione" && (await p.locator("#list .res").count()) === 50, "la scheda All tickets viene aperta dal segnalibro e la ricerca funziona");
    check(perr.length === 0, `nessun errore con la scheda creata dopo ${perr.length ? JSON.stringify(perr) : ""}`);
    await p.close();
  }

  const fresh = async (q, setup) => {
    const p = await ctx.newPage();
    p.__err = [];
    p.on("pageerror", (x) => p.__err.push(x.message));
    if (setup) await setup(p);
    await portal(p, q);
    await p.evaluate(() => { localStorage.removeItem("rtkt2:settings"); localStorage.removeItem("rtkt2:touchUrl"); });
    return p;
  };
  const advOpen = (p) => p.evaluate(() => { document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#adv").open = true; });
  const restoreDone = async (p) => {
    await p.waitForFunction(() => !document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#go").disabled);
    await p.waitForTimeout(400);
  };
  const storeTotal = (p) => p.evaluate((P) => Ext.getCmp(P + "grd").getStore().getTotalCount(), P0);
  const fixReq = (fn) => async (route) => {
    const q = new URLSearchParams(route.request().postData() || "");
    const r = await fn(q, route.request());
    await route.continue(r === false ? undefined : { postData: q.toString() });
  };

  // ---- «Carica i successivi» dopo Ripristina, dopo aver sfogliato l'elenco nel portale e dopo il conteggio per anno
  {
    const p = await fresh("?apply=auto&tab=all");
    await clickBookmarklet(p);
    await search(p, "cedolino");
    await p.click("#qrestore");
    await restoreDone(p);
    await resetLog(p);
    await p.click("#more");
    await waitDone(p);
    let ll = await log(p);
    let le = lastList(ll);
    check(fval(le, "FullText") === "cedolino" && le.params.page === "2" && le.params.start === "200" && (await txt(p, "#sum")).startsWith("400"),
      `dopo Ripristina «Carica i successivi» rimette la ricerca (${ll.map((x) => `${x.params.page}/${x.params.start}/${fval(x, "FullText")}`).join(" ")})`);
    await p.waitForTimeout(300);
    check(await p.locator("#qrestore").isVisible(), "e «Ripristina il portale» torna disponibile");
    await p.keyboard.press("Escape");
    await p.evaluate((P) => { Ext.getCmp(P + "grd").getStore().nextPage(); }, P0); // pagina 3 sfogliata nel portale
    await p.waitForTimeout(1200);
    await clickBookmarklet(p);
    await resetLog(p);
    await p.click("#more");
    await waitDone(p);
    le = lastList(await log(p));
    check(le.params.page === "3" && le.params.start === "400" && (await txt(p, "#sum")).startsWith("600"), `pagina giusta anche dopo aver sfogliato l'elenco nel portale (${le.params.page}/${le.params.start})`);
    await p.click("#yearsbtn");
    await waitDone(p);
    await resetLog(p);
    await p.click("#more");
    await waitDone(p);
    le = lastList(await log(p));
    check(le.params.page === "4" && le.params.start === "600" && fval(le, "FullText") === "cedolino" && (await txt(p, "#sum")).startsWith("800"), `dopo «Quanti per anno?» si continua dalla pagina giusta (${le.params.page}/${le.params.start})`);
    // persona cambiata nel pannello dopo la ricerca: niente pagine di un'altra ricerca
    await advOpen(p);
    await p.fill('[data-ppl="ModifiedBy"]', "ro");
    await p.locator("#ppl .sug button").first().waitFor({ timeout: 10000 });
    await p.locator("#ppl .sug button").first().click();
    await p.waitForTimeout(1500); // il portale (apply=auto) ricarica da solo
    await resetLog(p);
    const n0 = (await txt(p, "#sum")).split(" ")[0];
    await p.click("#more");
    await waitDone(p);
    const nreq = (await log(p)).length;
    check(nreq === 0 && (await txt(p, "#alert")).includes("premi «Cerca»") && (await txt(p, "#sum")).split(" ")[0] === n0, `persona cambiata dopo la ricerca: «Carica i successivi» non aggiunge un'altra ricerca (${nreq} richieste)`);
    await p.click("#yearsbtn");
    await waitDone(p);
    check((await log(p)).length === 0, "e «Quanti per anno?» non conta un'altra ricerca");
    check(p.__err.length === 0, `nessun errore ${p.__err.length ? JSON.stringify(p.__err) : ""}`);
    await p.close();
  }

  // ---- gruppo e persona già impostati nel portale: «Ripristina il portale» li rimette (anche dopo Azzera e un'altra persona)
  {
    const p = await fresh("?apply=auto&tab=all");
    const orig = await p.evaluate(async (P) => {
      Ext.getCmp(P + "filter_default_AssignedUserOrGroupFilter").setValue("G3");
      const f = Ext.getCmp(P + "filter_default_ModifiedBy"), st = f.getStore();
      await new Promise((res) => { st.on("load", res, null, { single: true }); f.doQuery("ro", true, true); });
      f.setValue(st.getAt(0)); f.collapse();
      return { v: f.getValue(), t: f.getRawValue() };
    }, P0);
    await p.waitForTimeout(1200);
    await clickBookmarklet(p);
    await p.click("#qreset"); // toglie gruppo e persona dalla pagina prima della prima ricerca
    await search(p, "cedolino");
    await advOpen(p);
    await p.fill('[data-ppl="ModifiedBy"]', "fontana");
    await p.locator("#ppl .sug button").first().waitFor({ timeout: 10000 });
    await p.locator("#ppl .sug button").first().click();
    await search(p, "cedolino");
    await resetLog(p);
    await p.click("#qrestore");
    await restoreDone(p);
    const now = await p.evaluate((P) => { const f = Ext.getCmp(P + "filter_default_ModifiedBy"); return { v: f.getValue(), t: f.getRawValue(), a: Ext.getCmp(P + "filter_default_AssignedUserOrGroupFilter").getValue() }; }, P0);
    const re = lastList(await log(p));
    check(now.v === orig.v && now.t === orig.t && now.a === "G3" && fval(re, "ModifiedBy") === orig.v && fval(re, "AssignedUserOrGroupID") === "G3",
      `Ripristina rimette gruppo e persona della pagina (${JSON.stringify(orig)} → ${JSON.stringify(now)})`);
    await p.close();
  }

  // ---- «Scegli nel portale» con un'altra scheda attiva: si apre All tickets (elenco annidato come nel portale vero);
  //      scelta lasciata a metà e ritorno dal segnalibro: niente promemoria sopra il pannello, Esc lo chiude davvero
  {
    const p = await fresh("?apply=auto&tab=all");
    await p.evaluate(() => { Ext.getCmp("navbar").setActiveTab("body_MYTKT"); });
    await p.waitForTimeout(300);
    await clickBookmarklet(p);
    await advOpen(p);
    await p.locator('#ppl [data-pf="OwnerUserGroupID"]').locator("button", { hasText: "Menu del portale" }).click();
    await p.waitForTimeout(500);
    const st = await p.evaluate((P) => { const f = Ext.getCmp(P + "filter_default_OwnerUserGroupID"); return { tab: Ext.getCmp("navbar").getActiveTab().id, vis: f.isVisible(true), exp: !!f.isExpanded }; }, P0);
    check(st.tab === "body_INC_ALLGRP_EXTENDED" && st.vis && st.exp, `scelta nel portale da un'altra scheda: si apre All tickets (${JSON.stringify(st)})`);
    await p.evaluate((P) => { Ext.getCmp(P + "filter_default_OwnerUserGroupID").collapse(); }, P0);
    await clickBookmarklet(p); // ritorno dal segnalibro, non dal promemoria
    const pillVis = await p.locator("#ricerca-tkt-pill button").isVisible();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(700);
    const reopened = await isOpen(p);
    check(!pillVis && !reopened, `ritorno dal segnalibro durante una scelta nel portale (promemoria ${pillVis ? "visibile" : "nascosto"}, pannello ${reopened ? "riaperto" : "chiuso"})`);
    await p.close();
  }

  // ---- Open abilitato dal portale poco dopo la selezione (binding) e doppio clic ascoltato dalla view
  {
    const p = await fresh("?apply=auto&tab=all&openbind=1");
    await clickBookmarklet(p);
    await search(p, "detassazione");
    const c0 = await p.locator("#list .res .num").first().innerText();
    const [tb] = await Promise.all([ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null), p.locator("#list .res").first().locator("button", { hasText: "Apri in Touch" }).click()]);
    await p.waitForTimeout(500);
    check(!!tb && await p.evaluate((c) => window.__opened.includes(c), c0), `ticket aperto con Open abilitato in ritardo dal portale (${c0})`);
    if (tb) await tb.close();
    check(p.__err.length === 0, `nessun errore con Open legato alla selezione ${p.__err.length ? JSON.stringify(p.__err) : ""}`);
    await p.close();
  }

  // ---- risposte tardive: caricamento iniziale lento della scheda e ricerca interrotta
  {
    let slowFirst = true;
    const p = await fresh("?apply=auto&lazy=1", (pg) => pg.route("**/HDAPortal/List/GetData**", fixReq(async (q, rq) => {
      const ft = ((JSON.parse(q.get("filters") || "[]").find((f) => f.name === "FullText") || {}).value) || "";
      let delay = 0;
      if (rq.url().includes("INC_ALLGRP_EXTENDED") && slowFirst && !ft) { slowFirst = false; delay = 1800; }
      if (ft === "cedolino") delay = 3000;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return false;
    })));
    await clickBookmarklet(p);
    await search(p, "detassazione"); // subito: la scheda All tickets si sta ancora caricando (lentamente)
    await p.waitForTimeout(2500);
    let tot = await storeTotal(p);
    check((await txt(p, "#sum")).startsWith("197") && tot === 197, `con il caricamento iniziale lento: risultati della ricerca (${(await txt(p, "#sum")).split("·")[0].trim()}, elenco ${tot})`);
    await p.fill("#q", "cedolino");
    await p.click("#go");
    await p.waitForTimeout(1300); // la richiesta (lenta) è partita
    await p.click("#stop");
    await waitDone(p);
    await search(p, "detassazione");
    await p.waitForTimeout(3500);
    tot = await storeTotal(p);
    check((await txt(p, "#sum")).startsWith("197") && tot === 197, `dopo una ricerca interrotta: risultati della nuova (${(await txt(p, "#sum")).split("·")[0].trim()}, elenco ${tot})`);
    check(p.__err.length === 0, `nessun errore con le risposte tardive ${p.__err.length ? JSON.stringify(p.__err) : ""}`);
    await p.close();
  }

  // ---- il portale manda meno righe di quelle chieste: «Carica i successivi» non salta ticket
  {
    const p = await fresh("?apply=auto&tab=all", (pg) => pg.route("**/HDAPortal/List/GetData**", fixReq((q) => { if (+q.get("limit") > 100) q.set("limit", "100"); })));
    await clickBookmarklet(p);
    await search(p, "cedolino");
    await resetLog(p);
    await p.click("#more");
    await waitDone(p);
    const le = lastList(await log(p));
    check((await txt(p, "#sum")).startsWith("200") && le.params.start === "100" && (await txt(p, "#alert")).includes("al massimo 100"), `con al massimo 100 righe per richiesta i successivi partono da 100 (start ${le.params.start})`);
    await p.close();
  }

  // ---- ticket tutti di anni lontani: il conteggio per anno arriva fino a loro
  {
    const p = await fresh("?apply=auto&tab=all", (pg) => pg.route("**/HDAPortal/List/GetData**", fixReq((q) => {
      const f = JSON.parse(q.get("filters") || "[]");
      f.push({ name: "Date", op: "le", value: "2020-12-31" });
      q.set("filters", JSON.stringify(f));
    })));
    await clickBookmarklet(p);
    await search(p, "cedolino");
    await p.click("#yearsbtn");
    await waitDone(p);
    const yt = await txt(p, "#years");
    const ym = yt.match(/([\d.]+) su ([\d.]+) contati/);
    check(!!ym && ym[1] === ym[2] && (await p.locator("#years button", { hasText: "Cerca nel 2020" }).count()) === 1, `conteggio per anno fino agli anni dei ticket (${ym ? ym[0] : yt.slice(0, 60)})`);
    await p.close();
  }

  // ---- scheda All tickets lenta ad aprirsi: doppio invio = una ricerca; ricerca salvata eseguita prima che l'elenco esista
  {
    const p = await fresh("?apply=auto&lazy=2500");
    const h0 = await p.evaluate(() => JSON.parse(localStorage.getItem("rtkt2:history") || "[]").length);
    await clickBookmarklet(p);
    await p.fill("#q", "stampa");
    await p.press("#q", "Enter");
    await p.press("#q", "Enter");
    await waitDone(p);
    await p.waitForTimeout(500);
    const h1 = await p.evaluate(() => JSON.parse(localStorage.getItem("rtkt2:history") || "[]").length);
    check(h1 - h0 === 1, `doppio invio durante l'apertura della scheda: una sola ricerca (${h1 - h0})`);
    await p.close();
  }
  {
    const p = await fresh("?apply=auto&lazy=2500");
    await p.evaluate(() => {
      const all = JSON.parse(localStorage.getItem("rtkt2:saved") || "[]");
      all.push({ name: "Gruppo G3 aperti", spec: { text: "", st: "open", people: { OwnerUserGroupID: { v: "G3", t: "HR Fiscale" } } }, created: "2026-01-01T00:00:00Z" });
      localStorage.setItem("rtkt2:saved", JSON.stringify(all));
    });
    await clickBookmarklet(p);
    await resetLog(p);
    await p.click('#nav button[data-tab="saved"]');
    await p.locator("#saved .li", { hasText: "Gruppo G3 aperti" }).locator("button", { hasText: "Esegui" }).click();
    const note = await txt(p, "#qwarn");
    await p.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#go").disabled, null, { timeout: 10000 }).catch(() => {});
    await waitDone(p);
    check(note.includes("Apro la scheda"), `in attesa della scheda All tickets lo dice (${note})`);
    const le = lastList(await log(p));
    const nst = (fval(le, "TicketStatusID") || []).length;
    check(fval(le, "OwnerUserGroupID") === "G3" && nst === 11, `ricerca salvata eseguita prima che l'elenco esista: gruppo e stati aperti (${fval(le, "OwnerUserGroupID")}, ${nst} stati)`);
    await p.evaluate(() => { const all = JSON.parse(localStorage.getItem("rtkt2:saved") || "[]").filter((x) => x.name !== "Gruppo G3 aperti"); localStorage.setItem("rtkt2:saved", JSON.stringify(all)); });
    await p.close();
  }

  // ---- file importato con ricerche malformate o con codice nel nome di un gruppo (contesto a parte)
  {
    const c2 = await browser.newContext(ctxOpts);
    const p = await c2.newPage();
    const perr = [];
    p.on("pageerror", (x) => perr.push(x.message));
    await portal(p, "?apply=auto&tab=all");
    await clickBookmarklet(p);
    const bad = {
      saved: [{ name: "Malformata", spec: { text: "x", pr: "P2", dfrom: 5, stCodes: "x", st: "custom" } }, { name: "Buona", spec: { text: "ok" } },
        { name: "Trappola", spec: { text: "", people: { AssignedUserOrGroupFilter: { v: "G-X", t: "<img src=x onerror=window.__pwned3=1>" } } } }],
      history: [{ spec: { text: "y", pr: "P1" }, created: "2026-01-01T00:00:00Z" }],
    };
    await p.click('#nav button[data-tab="settings"]');
    await p.setInputFiles("#pimp", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
    await p.waitForTimeout(300);
    await p.click('#nav button[data-tab="saved"]');
    const ns = await p.locator("#saved .li").count();
    await p.click('#nav button[data-tab="history"]');
    const nh = await p.locator("#hist .li").count();
    check(ns === 3 && nh === 1 && perr.length === 0, `ricerche importate malformate: elenchi leggibili (${ns} salvate, ${nh} in cronologia) ${perr.join(" ")}`);
    await p.evaluate((P) => { Ext.getCmp(P + "filter_default_AssignedUserOrGroupFilter").forceSelection = true; }, P0);
    await p.click('#nav button[data-tab="saved"]');
    await p.locator("#saved .li", { hasText: "Trappola" }).locator("button", { hasText: "Apri" }).click();
    await p.waitForTimeout(300);
    await p.evaluate((P) => { Ext.getCmp(P + "filter_default_AssignedUserOrGroupFilter").expand(); }, P0);
    await p.waitForTimeout(300);
    check(await p.evaluate(() => window.__pwned3 === undefined) && perr.length === 0, "nessun codice dal nome di un gruppo importato");
    await c2.close();
  }

  // ---- 3.0: tutti i filtri del portale nel pannello, scelta rapida «Io», ricerca salvata che li rimette
  {
    const p = await fresh("?apply=auto&tab=all");
    await clickBookmarklet(p);
    await advOpen(p);
    await p.click('[data-pftree="ServiceFilter"]');
    await p.locator('[data-tree="ServiceFilter"] input').fill("presenze");
    await p.locator('[data-tree="ServiceFilter"] button.nm', { hasText: "Informazione / PRESENZE WEB" }).waitFor({ timeout: 15000 });
    await p.locator('[data-tree="ServiceFilter"] input').press("Enter");
    await p.waitForTimeout(400);
    check(!(await p.locator("#go").isDisabled()) && await p.locator("#prog").isHidden(), "Invio nella ricerca dell'albero non avvia la ricerca dei ticket");
    const famNotSelectable = await p.locator('[data-tree="ServiceFilter"] span.nm.off').count() >= 0;
    await p.locator('[data-tree="ServiceFilter"] button.nm', { hasText: "Informazione / PRESENZE WEB" }).click();
    await p.fill('[data-pfq="AccountID"]', "tecno");
    await p.locator('[data-pf="AccountID"] .sug button').first().waitFor({ timeout: 10000 });
    const site = await p.locator('[data-pf="AccountID"] .sug button').first().innerText();
    await p.locator('[data-pf="AccountID"] .sug button').first().click();
    await p.locator('[data-pfl="TagFilter"] button', { hasText: "normativa" }).click();
    await p.locator('#ppl [data-pf="ModifiedBy"] button[data-quick="Io"]').click();
    await p.waitForTimeout(300);
    const qp = await txt(p, "#qprev");
    await resetLog(p);
    await search(p, "");
    let le = lastList(await log(p));
    const me = await p.evaluate(() => Portal.Const.TypedLoggedUser);
    check(fval(le, "ServiceID") && fval(le, "AccountID") && JSON.stringify(fval(le, "Relations.ObjectTag.ID")) === '["T1"]' && fval(le, "ModifiedBy") === me.ID && famNotSelectable,
      `filtri scelti nel pannello e inviati al portale (servizio ${fval(le, "ServiceID")}, sede ${site}, etichetta, «Io» = ${fval(le, "ModifiedBy")})`);
    check(qp.includes("Service = Informazione / PRESENZE WEB") && qp.includes(`Site = ${site}`) && qp.includes("Tags = normativa") && qp.includes(`Modificato da = ${me.Name}`), "anteprima con i nomi dei filtri del portale");
    await p.click("#qsave");
    await p.fill("#sname", "Filtri del portale");
    await p.click('#dsave button[value="ok"]');
    await p.click("#qreset");
    check(await p.evaluate((P) => !Ext.getCmp(P + "filter_default_ServiceFilter").getValue() && !Ext.getCmp(P + "filter_default_AccountID").getValue() && !(Ext.getCmp(P + "filter_default_TagFilter").getValue() || []).length, P0), "Azzera toglie anche gli altri filtri del portale");
    await p.reload();
    await p.waitForFunction(() => window.__ready === true);
    await p.waitForTimeout(800);
    await clickBookmarklet(p);
    await p.click('#nav button[data-tab="saved"]');
    await resetLog(p);
    await p.locator("#saved .li", { hasText: "Filtri del portale" }).locator("button", { hasText: "Esegui" }).click();
    await waitDone(p);
    le = lastList(await log(p));
    const qp2 = await txt(p, "#qprev");
    check(fval(le, "ServiceID") && fval(le, "AccountID") && fval(le, "ModifiedBy") === me.ID && qp2.includes("Service = Informazione / PRESENZE WEB"), `la ricerca salvata rimette i filtri del portale in una pagina nuova, con i nomi (${fval(le, "ServiceID")})`);
    await p.evaluate(() => { const all = JSON.parse(localStorage.getItem("rtkt2:saved") || "[]").filter((x) => x.name !== "Filtri del portale"); localStorage.setItem("rtkt2:saved", JSON.stringify(all)); });
    check(p.__err.length === 0, `nessun errore con i filtri nel pannello ${p.__err.length ? JSON.stringify(p.__err) : ""}`);
    await p.close();
  }

  // ---- 3.0: Area Riservata collegata (un altro sito, in un'altra scheda): ricerca su tutte e due le fonti
  {
    const p = await fresh("?apply=auto&tab=all");
    await clickBookmarklet(p);
    await p.click('#nav button[data-tab="settings"]');
    await p.fill("#s-arurl", AR_PAGE);
    await p.click("#ssave");
    await p.click('#nav button[data-tab="search"]');
    check((await txt(p, "#ar-state")) === "non collegata" && await p.locator("#src-ar").isDisabled(), "Area Riservata non collegata all'inizio");
    const [arp] = await Promise.all([ctx.waitForEvent("page"), p.click("#ar-connect")]);
    const arErr = [];
    arp.on("pageerror", (x) => arErr.push(x.message));
    let asked = "", nAsk = 0, accept = false;
    arp.on("dialog", async (d) => { asked = d.message(); nAsk++; if (accept) await d.accept(); else await d.dismiss(); });
    await arp.waitForLoadState("load");
    await arp.waitForTimeout(500);
    check((await txt(p, "#ar-state")).includes("attesa") && (await txt(p, "#ar-help")).includes("premi lì il segnalibro"), "in attesa del segnalibro nella scheda dell'Area Riservata");
    // collegamento rifiutato: la domanda non torna a ogni «hello» del pannello
    await clickBookmarklet(arp);
    await arp.waitForTimeout(3500);
    check(nAsk === 1 && (await txt(p, "#ar-state")).includes("attesa"), `rifiutato il collegamento, la domanda non si ripete (${nAsk} domande in 3,5 s)`);
    await arp.reload();
    await arp.waitForLoadState("load");
    accept = true;
    await clickBookmarklet(arp);
    await p.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#ar-state").textContent === "collegata", null, { timeout: 15000 });
    check(asked.includes(BASE.replace(/\/$/, "")) && await p.locator("#src-ar").isChecked(), `collegamento con la conferma nell'Area Riservata («${asked.slice(0, 60)}…»)`);
    await fetch(BASE_AR + `/__reset?run=${RUN}`, { method: "POST" });
    await search(p, "detassazione");
    const sumAr = await txt(p, "#sum");
    const arLog = (await (await fetch(BASE_AR + `/__log?run=${RUN}`)).json()).filter((x) => x.params);
    const q0 = arLog[0] || { params: {}, order: [] };
    check(/dal portale Touch/.test(sumAr) && /dall'Area Riservata/.test(sumAr) && (await p.locator("#list .res .badge.src").count()) > 0, `risultati di tutte e due le fonti (${sumAr.replace(/\s+/g, " ").slice(0, 120)})`);
    check(arLog.length === 1 && q0.order.join(",") === "pKeyword,pArea,pCore,pLangs,cs_SITE,m_cID" && q0.params.pArea === "TICKOPEXXX" && q0.params.pCore === "" && /^IdCenSer:PAOW +and \( Testi:\("detassazione"\) or Oggetto:\("detassazione"\) \)$/.test(q0.params.pKeyword),
      `richiesta all'Area Riservata nel formato della sua pagina (${q0.params.pKeyword})`);
    check((await p.locator("#f-source li").count()) === 2, "faccetta Fonte (Touch / Area Riservata)");
    await p.locator("#f-source button", { hasText: "Area Riservata" }).click();
    const arCard = p.locator("#list .res", { has: p.locator("a.btn", { hasText: "Area Riservata" }) }).first();
    const arNum = await arCard.locator(".num").innerText();
    await arCard.locator("button", { hasText: "Leggi" }).click();
    await p.locator("#rbody .pre").first().waitFor({ timeout: 30000 });
    const arRead = await txt(p, "#rbody");
    check(arRead.includes(arNum.replace("#", "")) && /Testo/.test(arRead) && (await p.locator("#rlink").getAttribute("href") || "").startsWith(BASE_AR) && (await txt(p, "#rsrc")) === "Area Riservata", `ticket dell'Area Riservata letto nel pannello (${arNum})`);
    await p.click("#rclose");
    await p.click("#active .chip button");
    // periodo: nell'Area Riservata un mese alla volta, con il campo della data di apertura chiesto alla sua pagina
    await fetch(BASE_AR + `/__reset?run=${RUN}`, { method: "POST" });
    await p.selectOption("#preset", "py");
    await search(p, "detassazione");
    const py = new Date().getFullYear() - 1;
    const kwP = ((await (await fetch(BASE_AR + `/__log?run=${RUN}`)).json()).filter((x) => x.params)[0] || { params: {} }).params.pKeyword || "";
    check(kwP.includes(`(IdMeseA:1 and IdAnnoA:${py} )`) && kwP.includes(`(IdMeseA:12 and IdAnnoA:${py} )`), `periodo nell'Area Riservata con la data di apertura (${kwP.slice(0, 90)}…)`);
    await p.selectOption("#preset", "");
    await search(p, "detassazione");
    await p.click("#yearsbtn");
    await waitDone(p);
    const yrs = await txt(p, "#years");
    check(yrs.includes("portale Touch e Area Riservata") && (await p.locator("#years .yr .yn", { hasText: "+" }).count()) > 0, "ticket per anno anche nell'Area Riservata");
    // periodo che non comincia a gennaio: nel conteggio per anno solo i mesi del periodo, mai una richiesta senza periodo
    await p.selectOption("#preset", "2y");
    await search(p, "cedolino");
    await fetch(BASE_AR + `/__reset?run=${RUN}`, { method: "POST" });
    if (await p.locator("#yearsbtn").count()) { await p.click("#yearsbtn"); await waitDone(p); }
    const ykw = (await (await fetch(BASE_AR + `/__log?run=${RUN}`)).json()).filter((x) => x.params).map((x) => x.params.pKeyword || "");
    const d2 = new Date(); d2.setMonth(d2.getMonth() - 24);
    const lo = d2.getFullYear() * 12 + d2.getMonth() + 1;
    const outside = ykw.filter((k) => !/IdAnno\w*:/.test(k) || [...k.matchAll(/IdMese\w*:(\d+) and IdAnno\w*:(\d+)/g)].some(([, mm, yy]) => +yy * 12 + +mm < lo));
    check(ykw.length > 0 && outside.length === 0, `conteggio per anno con «Ultimi 2 anni»: solo i mesi del periodo (${ykw.length} richieste all'Area Riservata, ${outside.length} fuori)`);
    await p.selectOption("#preset", "");
    // filtri che l'Area Riservata non ha: si cerca solo nel portale, e lo si dice
    await advOpen(p);
    await p.locator('#ppl [data-pf="ModifiedBy"] button[data-quick="Io"]').click();
    await p.waitForTimeout(300);
    const note = await txt(p, "#qwarn");
    await fetch(BASE_AR + `/__reset?run=${RUN}`, { method: "POST" });
    await search(p, "detassazione");
    const none = (await (await fetch(BASE_AR + `/__log?run=${RUN}`)).json()).filter((x) => x.params).length;
    check(note.includes("Area Riservata: non usata") && none === 0 && !/dall'Area Riservata/.test(await txt(p, "#sum")), "con gruppi e persone si cerca solo nel portale Touch, e il pannello lo dice");
    await p.click("#qreset");
    await p.click('#nav button[data-tab="settings"]');
    await p.click("#tcopy");
    const tj = JSON.parse(await p.evaluate(() => navigator.clipboard.readText()));
    check(tj.ar && tj.ar.state === "on" && tj.ar.origin === BASE_AR && tj.reader !== undefined, "dati tecnici: stato dell'Area Riservata");
    await p.click('#nav button[data-tab="search"]');
    // la scheda dell'Area Riservata si ricarica (o cambia pagina): il pannello torna in attesa, un clic sul segnalibro la ricollega
    const askBefore = nAsk;
    await arp.reload();
    await arp.waitForLoadState("load");
    await p.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#ar-state").textContent.includes("attesa"), null, { timeout: 8000 }).catch(() => {});
    const stReload = await txt(p, "#ar-state");
    await clickBookmarklet(arp);
    await p.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#ar-state").textContent === "collegata", null, { timeout: 15000 }).catch(() => {});
    const tR = Date.now();
    await search(p, "detassazione");
    const msR = Date.now() - tR;
    check(stReload.includes("attesa") && (await txt(p, "#ar-state")) === "collegata" && nAsk === askBefore && msR < 30000 && /dall'Area Riservata/.test(await txt(p, "#sum")),
      `ricaricata la scheda dell'Area Riservata: in attesa, poi ricollegata senza domande (ricerca in ${(msR / 1000).toFixed(1)} s)`);
    await arp.close();
    await p.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#ar-state").textContent === "non collegata", null, { timeout: 8000 }).catch(() => {});
    check((await txt(p, "#ar-state")) === "non collegata", "chiusa la scheda, l'Area Riservata risulta scollegata");
    check(p.__err.length === 0 && arErr.length === 0, `nessun errore con l'Area Riservata ${JSON.stringify(p.__err.concat(arErr))}`);
    await p.close();
  }

  // ---- altri modi di applicare i filtri: solo con Invio, o mai (il segnalibro ricarica l'elenco)
  for (const [mode, tab, how] of [["enter", "all", "invio dom"], ["enter", "home", "invio evento"], ["none", "all", "loadPage"]]) {
    const p = await ctx.newPage();
    const perr = [];
    p.on("pageerror", (x) => perr.push(x.message));
    await portal(p, `?apply=${mode}&tab=${tab}`);
    await p.evaluate(() => localStorage.removeItem("rtkt2:settings"));
    await resetLog(p);
    await clickBookmarklet(p);
    await search(p, "detassazione");
    const le = lastList(await log(p));
    const tr = await p.evaluate(() => { const r = document.getElementById("ricerca-tkt-host").shadowRoot; return r.querySelector("#sum").innerText; });
    await p.click('#nav button[data-tab="settings"]');
    const inf = await p.locator("#conninfo").innerText();
    check(fval(le, "FullText") === "detassazione" && tr.startsWith("197") && inf.includes(`avvio ${how}`), `filtri applicati con apply=${mode} (scheda ${tab}): ${how} [${fval(le, "FullText")} | ${tr.slice(0, 20)} | ${(inf.match(/avvio [^·]*/) || [""])[0]}]`);
    check(perr.length === 0, `nessun errore con apply=${mode} ${perr.length ? JSON.stringify(perr) : ""}`);
    await p.close();
  }

  // ---- ticket aperto come scheda ExtJS interna a Touch (inpage=1) con PagesTree e Storico conversazioni
  {
    const p = await fresh("?apply=auto&tab=all&inpage=1");
    await clickBookmarklet(p);
    await search(p, "detassazione");
    await p.locator("#list .res").first().locator("button", { hasText: "Leggi" }).click();
    await p.locator("#rbody .tl-item").first().waitFor({ timeout: 30000 });
    const tlCount = await p.locator("#rbody .tl-item").count();
    const reqCount = await p.locator("#rbody .rd-box.req .pre").count();
    check(tlCount >= 2 && reqCount === 1, `scheda interna Touch: Richiesta e Storico conversazioni (${tlCount} messaggi)`);
    await p.click("#rclose");
    check(p.__err.length === 0, `nessun errore con scheda interna Touch ${p.__err.length ? JSON.stringify(p.__err) : ""}`);
    await p.close();
  }

  check(errors.length === 0, `nessun errore JavaScript ${errors.length ? JSON.stringify(errors) : ""}`);
  await browser.close();
  console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli superati");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
