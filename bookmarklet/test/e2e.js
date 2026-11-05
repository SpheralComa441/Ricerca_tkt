// Prova completa del segnalibro sul finto sito (bookmarklet/test/fake_zucchetti.py).
//   BASE=http://127.0.0.1:8770 node bookmarklet/test/e2e.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:8770";
const SHOTS = process.env.SHOTS || "";
const HREF = fs.readFileSync(path.join(__dirname, "..", "dist", "bookmarklet.txt"), "utf8").trim();
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function clickBookmarklet(page) {
  await page.evaluate((href) => {
    const a = document.createElement("a");
    a.id = "__bm";
    a.href = href;
    a.textContent = "bm";
    document.body.appendChild(a);
  }, HREF);
  await page.click("#__bm");
  await page.evaluate(() => document.getElementById("__bm").remove());
}
const log = async (page) => (await (await page.request.get(BASE + "/__log")).json());
const resetLog = (page) => page.request.post(BASE + "/__reset");
async function search(page, text) {
  await page.fill("#q", text);
  await page.click("#go");
  await page.waitForFunction(() => {
    const r = document.getElementById("ricerca-tkt-host").shadowRoot;
    return r.querySelector("#prog").hidden && !r.querySelector("#go").disabled;
  }, null, { timeout: 20000 });
}
const txt = (page, sel) => page.locator(sel).first().innerText();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  // ---- pagina "ostile" come quella reale (Set, Map, Array.from, Intl ridefiniti) -------------
  // Qui non si esegue codice di test nella pagina (le ridefinizioni rompono anche quello):
  // solo clic e localizzatori, che girano in un contesto separato.
  {
    const hp = await ctx.newPage();
    const herr = [];
    hp.on("pageerror", (e) => herr.push(e.message));
    let dialog = "";
    hp.on("dialog", async (d) => { dialog = d.message(); await d.dismiss(); });
    await hp.goto(BASE + "/areariservata/jsp/gspv_psearch.jsp?ostile=1");
    await hp.click("#__bm");
    const opened = await hp.locator("#q").waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    check(opened, `si apre anche se la pagina ridefinisce Set/Map/Array.from/Intl ${dialog ? "(" + dialog.slice(0, 120) + ")" : ""}`);
    if (opened) {
      await hp.fill("#q", "detassazione");
      await hp.click("#go");
      await hp.locator("#prog").waitFor({ state: "hidden", timeout: 20000 });
      check((await hp.locator(".res").count()) === 50, "ricerca e risultati sulla pagina ostile");
      await hp.click("#f-year li:first-child button");
      check((await hp.locator("#sum").innerText()).includes("dopo i filtri"), "faccette sulla pagina ostile");
      await hp.click(".res .ib[aria-pressed]");
      check((await hp.locator("#fav-count").innerText()) === "1", "preferiti sulla pagina ostile");
      await hp.click(".res .ib[aria-pressed]");
    }
    check(herr.length === 0, `nessun errore sulla pagina ostile ${herr.length ? JSON.stringify(herr) : ""}`);
    await hp.close();
  }

  // ---- pagina di ricerca con il portlet -------------------------------------------------
  await page.goto(BASE + "/areariservata/jsp/gspv_psearch.jsp");
  // impostazioni salvate dalla versione 1.0.1 (lingue vuote): devono essere aggiornate a ITA
  await page.evaluate(() => localStorage.setItem("rtkt:settings", JSON.stringify({ core: "TICKET", area: "", langs: "", mapping: {}, cap: 210 })));
  await resetLog(page);
  await clickBookmarklet(page);
  await page.waitForSelector("#ricerca-tkt-host", { state: "attached" });
  check(await page.locator("#q").isVisible(), "il pannello si apre sopra la pagina");
  check(await page.evaluate(() => document.body.inert === true), "la pagina sotto il pannello non riceve tastiera e clic");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-01-aperto.png" });

  await search(page, "detassazione");
  let l = await log(page);
  check(l.length === 1, `una sola richiesta per ricerca (${l.length})`);
  check(l[0] && l[0].params.pKeyword === "detassazione" && l[0].params.pCore === "TICKET", "parametri passati dal portlet della pagina");
  check(l[0] && l[0].params.pLangs === "ITA", `lingua ITA inviata (anche con impostazioni vecchie): "${l[0] && l[0].params.pLangs}"`);
  check((await txt(page, "#sum")).includes("210 ticket trovati"), "210 risultati mostrati");
  check((await txt(page, "#alert")).includes("al massimo 210"), "avviso del limite di Zucchetti");
  check((await page.locator(".res").count()) === 50, "50 risultati per pagina");
  check((await page.locator(".res mark").count()) > 0, "parole evidenziate");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-02-risultati.png" });

  // seconda ricerca: richiesta appresa, asincrona
  await resetLog(page);
  await search(page, "tfr cedolino");
  l = await log(page);
  check(l.length === 1 && l[0].params.pKeyword === "tfr AND cedolino", "seconda ricerca con la richiesta appresa");
  check(l[0] && l[0].params.m_cID && l[0].ctype.includes("x-www-form-urlencoded"), "m_cID e content-type conservati");

  // testo con accenti → passa dal portlet
  await resetLog(page);
  await search(page, "maternità");
  l = await log(page);
  check(l.length === 1 && l[0].params.pKeyword === "maternità", "testo accentato inviato correttamente");

  // periodo + prodotto
  await page.click("#qreset");
  await page.fill("#q", "conguaglio");
  await page.selectOption("#preset", "ytd");
  await page.fill("#pin input", "PAGHEW");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const qp = await txt(page, "#qprev");
  check(/^\(conguaglio\) AND \(PAGHEW\) AND \("01-\d{4}"/.test(qp), `query con prodotto e mesi: ${qp.slice(0, 80)}…`);
  await page.click("#go");
  await page.waitForFunction(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector("#prog").hidden);
  const year = String(new Date().getFullYear());
  const dates = await page.locator(".res time").allInnerTexts();
  check(dates.length > 0 && dates.every((d) => d.endsWith(year)), `tutte le date nell'anno corrente (${dates.length})`);
  const prods = await page.locator(".res .badge").allInnerTexts();
  check(prods.every((p) => p === "PAGHEW"), "solo il prodotto scelto");

  // faccette, filtro, ordinamento
  await page.click("#qreset");
  await search(page, "detassazione");
  await page.click("#f-year li:first-child button");
  const afterYear = await txt(page, "#sum");
  check(afterYear.includes("dopo i filtri"), "faccetta anno applicata");
  await page.fill("#refine", "premio");
  await page.waitForTimeout(300);
  await page.selectOption("#sort", "date_desc");
  const ds = await page.locator(".res time").allInnerTexts();
  const iso = ds.map((d) => d.split("/").reverse().join("-"));
  check(iso.join() === [...iso].sort().reverse().join(), "ordinamento per data");

  // preferito con nota
  await page.click(".res .ib[aria-pressed]");
  await page.click('.res .ib[title="Nota ed etichette"]');
  await page.fill("#ntext", "Da rivedere");
  await page.fill("#ntags", "normativa");
  await page.press("#ntags", "Enter");
  check((await txt(page, "#fav-count")) === "1", "preferito salvato");

  // ricerca senza risultati dopo una al limite: nessun avviso vecchio o fuorviante
  await page.fill("#refine", "");
  await search(page, "parolachenonesiste");
  const al = await page.locator("#alert").isVisible() ? await txt(page, "#alert") : "";
  check(!al.includes("al massimo") && !al.includes("non riesco a leggere"), `nessun avviso vecchio o fuorviante a zero risultati ("${al.slice(0, 60)}")`);
  await search(page, "detassazione");
  await page.selectOption("#sort", "date_desc");

  // apertura ticket: link relativo e "function:"
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => {
    const r = document.getElementById("ricerca-tkt-host").shadowRoot;
    return Array.from(r.querySelectorAll(".res .num")).map((a) => a.textContent);
  });
  const even = rows.findIndex((n) => +n.slice(1) % 2 === 0);
  const odd = rows.findIndex((n) => +n.slice(1) % 2 === 1);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator(".res").nth(even).locator("button", { hasText: "Apri" }).click()]);
  await popup.waitForLoadState();
  check(popup.url().includes("/areariservata/jsp/gspv_fticket.jsp?TKNUMERO="), "apertura con link relativo");
  await popup.close();
  await page.locator(".res").nth(odd).locator("button", { hasText: "Apri" }).click();
  const clicked = await page.evaluate(() => window.__clicked || "");
  check(clicked.startsWith("function:apriTicket("), "apertura tramite il portlet della pagina (function:)");

  // esportazione CSV
  await page.click("#exp");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expm button[data-x="csv"]')]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  check(csv.startsWith("﻿Numero;Data;Prodotto;Oggetto") && csv.split("\r\n").length === 211, "CSV con 210 righe");

  // anno scritto male: errore, nessuna richiesta
  await page.click("#qreset");
  await page.fill("#q", "tfr");
  await page.fill("#dfrom", "0026-01-01");
  await page.waitForTimeout(300);
  check((await txt(page, "#qprev")).includes("Anno non valido"), "anno a 2 cifre segnalato");
  await page.click("#qreset");

  // mappatura di un campo → filtro attivo
  await page.click('#nav button[data-tab="settings"]');
  await page.fill("#s-map", "stato = TKSTATO");
  await page.click("#ssave");
  await page.click('#nav button[data-tab="search"]');
  await page.click("#adv summary");
  check(await page.locator('#rie input[data-f="stato"]').isEnabled(), "campo Stato attivato dalla mappatura");
  await page.fill('#rie input[data-f="stato"]', "Aperto");
  await page.fill("#q", "assunzione");
  await page.waitForTimeout(300);
  check((await txt(page, "#qprev")) === '(assunzione) AND (TKSTATO:"Aperto")', "query con il campo mappato");

  // ricerca fatta dalla pagina con il pannello chiuso: parametri e campi osservati
  await page.keyboard.press("Escape");
  await page.click("#cerca-pagina");
  await clickBookmarklet(page);
  await page.locator("#q").waitFor({ state: "visible", timeout: 5000 });
  await page.click('#nav button[data-tab="settings"]');
  const info = await txt(page, "#conninfo");
  check(info.includes('lingue "ITA,ENG"') && info.includes('area "HR"'), "parametri della ricerca della pagina osservati");
  check(info.includes("TKSTATO"), "campo Solr visto nella ricerca della pagina");
  // lingua sbagliata nelle impostazioni -> Zucchetti dà errore -> seconda richiesta con i parametri della pagina
  await page.fill("#s-langs", "XXX");
  await page.click("#ssave");
  await page.click('#nav button[data-tab="search"]');
  await page.fill('#rie input[data-f="stato"]', "");
  await resetLog(page);
  await search(page, "tfr");
  l = await log(page);
  check(l.length === 2 && l[0].params.pLangs === "XXX" && l[1].params.pLangs === "ITA,ENG", `una sola richiesta in più, con i parametri della pagina (${l.map((x) => x.params.pLangs)})`);
  check((await page.locator(".res").count()) > 0 && (await page.inputValue("#langs")) === "ITA,ENG", "risultati e parametri corretti salvati");
  await page.click('#nav button[data-tab="search"]');

  // salva ricerca e cronologia
  await page.click("#qsave");
  await page.fill("#sname", "Assunzioni aperte");
  await page.click('#dsave button[value="ok"]');
  await page.click('#nav button[data-tab="saved"]');
  check((await txt(page, "#saved")).includes("Assunzioni aperte"), "ricerca salvata");
  await page.click('#nav button[data-tab="history"]');
  check((await page.locator("#hist .li").count()) >= 4, "cronologia aggiornata");

  // dati tecnici
  await page.click('#nav button[data-tab="settings"]');
  await page.click("#tcopy");
  const tech = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  check(tech.template && tech.template.keywordParam === "pKeyword", "dati tecnici: richiesta appresa");
  check((tech.filtersFormHtml || "").includes("w_STATO"), "dati tecnici: modulo Filtri incluso");
  check(!JSON.stringify(tech).includes("JSESSIONID"), "dati tecnici senza cookie");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-03-impostazioni.png" });

  // importazione di dati personali: niente duplicati, preferito "malevolo" reso innocuo
  const [pdl] = await Promise.all([page.waitForEvent("download"), page.click("#pexp")]);
  const exported = fs.readFileSync(await pdl.path());
  await page.setInputFiles("#pimp", { name: "dati.json", mimeType: "application/json", buffer: exported });
  await page.waitForTimeout(300);
  await page.setInputFiles("#pimp", { name: "dati.json", mimeType: "application/json", buffer: exported });
  await page.waitForTimeout(300);
  await page.click('#nav button[data-tab="saved"]');
  check((await page.locator("#saved .li").count()) === 1, "importare due volte lo stesso file non duplica le ricerche salvate");
  const evil = { favorites: [{ key: "nX", note: "", tags: "non-un-array", ticket: { number: 1, subject: "trappola", rawUrl: "function:x||(window.__pwned=1)", url: "javascript:window.__pwned=2", row: { url1: "function:x||(window.__pwned=3)" } } }] };
  await page.setInputFiles("#pimp", { name: "evil.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(evil)) });
  await page.waitForTimeout(300);
  await page.click('#nav button[data-tab="favorites"]');
  const trap = page.locator("#favs .res", { hasText: "trappola" });
  check((await trap.count()) === 1 && (await trap.locator("button", { hasText: "Apri" }).count()) === 0, "preferito importato con link pericoloso: nessun pulsante Apri");
  await trap.locator(".num").click();
  check(await page.evaluate(() => window.__pwned === undefined), "nessun codice eseguito dal preferito importato");
  await page.click('#nav button[data-tab="settings"]');

  // Esc chiude, il segnalibro riapre; dopo il ricaricamento i dati restano
  await page.click('#nav button[data-tab="search"]');
  await page.keyboard.press("Escape");
  check(await page.locator("#ricerca-tkt-host").evaluate((e) => e.style.display === "none"), "Esc chiude il pannello");
  check(await page.evaluate(() => document.body.inert === false), "la pagina torna utilizzabile dopo la chiusura");
  await clickBookmarklet(page);
  const reopened = await page.locator("#q").waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  check(reopened, "il segnalibro riapre il pannello");
  await page.reload();
  await clickBookmarklet(page);
  await page.locator("#q").waitFor({ state: "visible", timeout: 5000 });
  check((await txt(page, "#fav-count")) === "2", "preferiti conservati dopo il ricaricamento");

  // sessione scaduta
  await search(page, "tfr");
  await ctx.clearCookies();
  await search(page, "ferie");
  check((await txt(page, "#alert")).includes("sessione"), "messaggio di sessione scaduta");

  // pagina senza portlet: chiamata diretta con m_cID letto dal portlet .jsp
  await page.goto(BASE + "/areariservata/jsp/home.jsp");
  await resetLog(page);
  await clickBookmarklet(page);
  await search(page, "detassazione");
  l = await log(page);
  check(l.length >= 1 && l[l.length - 1].params.m_cID === "1ef51ea72b7e79d713e5b1b42030dfa2", "chiamata diretta da un'altra pagina dell'area");
  check((await txt(page, "#sum")).includes("210 ticket trovati"), "risultati anche dalla chiamata diretta");

  // mobile
  await page.setViewportSize({ width: 390, height: 844 });
  const sw = await page.evaluate(() => document.getElementById("ricerca-tkt-host").shadowRoot.querySelector(".body").scrollWidth);
  check(sw <= 390, `nessuno scorrimento orizzontale su telefono (${sw})`);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/bm-04-mobile.png" });

  // fuori dall'Area Riservata
  const p2 = await ctx.newPage();
  await p2.goto(BASE + "/altro/pagina.html");
  let alerted = "";
  p2.on("dialog", async (d) => { alerted = d.message(); await d.dismiss(); });
  await clickBookmarklet(p2);
  await p2.waitForTimeout(300);
  check(alerted.includes("Area Riservata"), "avviso se usato fuori dall'Area Riservata");

  check(errors.length === 0, `nessun errore JavaScript ${errors.length ? JSON.stringify(errors) : ""}`);
  await browser.close();
  console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli superati");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
