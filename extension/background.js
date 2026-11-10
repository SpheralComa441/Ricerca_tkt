// Service worker dell'estensione Ricerca TKT.
//  - clic sull'icona → apre (o porta in primo piano) l'app in una scheda;
//  - "ponte" verso una scheda Touch aperta quando l'app non riesce a leggere direttamente;
//  - "Apri in Touch": apre il dettaglio del ticket nella scheda Touch, come un clic nel portale;
//  - registra (solo in lettura) i filtri che Touch invia quando li usi nel portale, così l'app
//    impara proprietà, operatori e formato dei valori di ogni filtro senza doverli indovinare.

import { learnFromConditions } from "./lib/filters.js";

const APP_URL = chrome.runtime.getURL("app/index.html");
const TOUCH_MATCH = "https://zucchetti.support/HDAPortal/*";
const TOUCH_HOME = "https://zucchetti.support/HDAPortal/";
const AR_MATCH = "https://*.zucchetti.it/areariservata/*";

async function openApp() {
  const tabs = await chrome.tabs.query({ url: APP_URL + "*" });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
}
chrome.action.onClicked.addListener(openApp);

async function touchTab() {
  const tabs = await chrome.tabs.query({ url: TOUCH_MATCH });
  // preferisce la scheda attiva / usata più di recente
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return tabs[0] || null;
}

async function arTab() {
  const tabs = await chrome.tabs.query({ url: AR_MATCH });
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return tabs[0] || null;
}

async function proxyFetch(req) {
  const tab = await touchTab();
  if (!tab) return { error: "no-tab" };
  const send = () => chrome.tabs.sendMessage(tab.id, { type: "hda-fetch", req });
  try {
    return await send();
  } catch {
    // scheda aperta prima dell'installazione: si inietta il ponte e si riprova
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/bridge.js"] });
    return await send();
  }
}

function readArVarsInMainWorld() {
  let mcid = null;
  let idCenSer = "";
  let pArea = "";
  try {
    if (window.splResults && window.splResults.m_cID) mcid = String(window.splResults.m_cID);
    for (const k of Object.keys(window)) {
      let v;
      try {
        v = window[k];
      } catch {
        continue;
      }
      if (!v || typeof v !== "object") continue;
      if (!mcid && v.splResults && typeof v.splResults.m_cID === "string" && /^[0-9a-fA-F]{16,64}$/.test(v.splResults.m_cID)) {
        mcid = v.splResults.m_cID;
      }
      if (!mcid && v.m_cServlet === "spsl_fquery_mc" && typeof v.m_cID === "string" && /^[0-9a-fA-F]{16,64}$/.test(v.m_cID)) {
        mcid = v.m_cID;
      }
      if (!idCenSer && v.userInput && typeof v.userInput.Value === "function") {
        const uiVal = String(v.userInput.Value() || "");
        const m = /\bIdCenSer:([A-Z0-9_]+)/.exec(uiVal);
        if (m) idCenSer = m[1];
      }
      if (!pArea && v.area && typeof v.area.Value === "function") {
        const aVal = String(v.area.Value() || "").trim();
        if (aVal) pArea = aVal;
      }
    }
    if (typeof window.w_IdCenSer === "string" && window.w_IdCenSer) idCenSer = window.w_IdCenSer;
    if (typeof window.w_pArea === "string" && window.w_pArea) pArea = window.w_pArea;
  } catch {
    /* */
  }
  return { mcid, idCenSer, pArea };
}

// Parametri della Ricerca rapida letti dalla pagina dell'Area Riservata (m_cID, centro di servizio, area),
// tenuti per scheda: la lettura (script in tutti i frame) si fa una volta sola e non a ogni ricerca.
const arHints = new Map(); // tabId → { url, hint }

async function readArHint(tab) {
  const hint = {};
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func: readArVarsInMainWorld,
    });
    for (const f of frames || []) {
      const r = f && f.result;
      if (!r) continue;
      if (r.mcid && !hint.mcid) hint.mcid = r.mcid;
      if (r.idCenSer && !hint.idCenSer) hint.idCenSer = r.idCenSer;
      if (r.pArea && !hint.pArea) hint.pArea = r.pArea;
    }
  } catch {
    /* */
  }
  if (hint.mcid || hint.idCenSer) arHints.set(tab.id, { url: tab.url, hint });
  return hint;
}

chrome.tabs.onRemoved.addListener((tabId) => arHints.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" || info.url) arHints.delete(tabId);
});

async function arProxy(msg) {
  const tab = await arTab();
  if (!tab) return { error: "no-tab" };
  const cached = arHints.get(tab.id);
  const fresh = !cached || cached.url !== tab.url || msg.cmd === "status";
  const hint = fresh ? await readArHint(tab) : cached.hint;
  const send = (h) => chrome.tabs.sendMessage(tab.id, { ...msg, type: "ar-cmd", hint: h });
  let res;
  try {
    res = await send(hint);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/ar_bridge.js"] });
    res = await send(hint);
  }
  // risposta non valida con i parametri in memoria: si rileggono dalla pagina e si riprova una volta
  if (!fresh && (!res || res.error || (msg.cmd === "search" && !res.ok))) {
    arHints.delete(tab.id);
    res = await send(await readArHint(tab));
  }
  return res;
}

function openDetailInPage(id) {
  // eseguita nella pagina di Touch (mondo MAIN): stesso meccanismo dei link "openDetail" del portale
  const P = window.Portal;
  if (!P || !P.Actions || typeof P.Actions.onClick !== "function") return "not-ready";
  const el = document.createElement("div");
  el.setAttribute("data-action", "Portal.PageManager.openDetail");
  el.setAttribute("data-entity", "Incident");
  el.setAttribute("data-id", id);
  el.style.display = "none";
  document.body.appendChild(el);
  try {
    P.Actions.onClick(el);
    return "ok";
  } catch (e) {
    return "error: " + (e && e.message);
  } finally {
    el.remove();
  }
}

async function openInTouch(id) {
  let tab = await touchTab();
  if (!tab) tab = await chrome.tabs.create({ url: TOUCH_HOME, active: true });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  // aspetta che il portale sia pronto (al massimo ~30 s)
  for (let i = 0; i < 60; i++) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: openDetailInPage, args: [id] });
      if (res && res.result && res.result !== "not-ready") return res.result;
    } catch {
      /* pagina in caricamento */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "timeout";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "hda-proxy") {
    proxyFetch(msg.req).then(sendResponse, (e) => sendResponse({ error: String(e && e.message) }));
    return true;
  }
  if (msg.type === "ar-proxy") {
    arProxy(msg).then(sendResponse, (e) => sendResponse({ error: String(e && e.message) }));
    return true;
  }
  if (msg.type === "open-in-touch") {
    openInTouch(msg.id).then((r) => sendResponse({ result: r }), (e) => sendResponse({ result: "error: " + (e && e.message) }));
    return true;
  }
  if (msg.type === "touch-tab-status") {
    touchTab().then((t) => sendResponse({ open: !!t }));
    return true;
  }
});

// ---------------------------------------------------------------- filtri appresi da Touch

function formValue(details, name) {
  const b = details.requestBody;
  if (!b) return null;
  if (b.formData && b.formData[name]) return b.formData[name][0];
  if (b.raw && b.raw[0] && b.raw[0].bytes) {
    try {
      const txt = new TextDecoder().decode(b.raw[0].bytes);
      return new URLSearchParams(txt).get(name);
    } catch {
      return null;
    }
  }
  return null;
}

async function remember(entry, conditions) {
  const st = await chrome.storage.local.get(["captures", "learned"]);
  const captures = [entry, ...(st.captures || [])].slice(0, 40);
  const upd = { captures };
  if (conditions && entry.collection === "Incidents") upd.learned = learnFromConditions(conditions, st.learned || {});
  await chrome.storage.local.set(upd);
}

const TOUCH_ORIGIN = "https://zucchetti.support";
// Solo le richieste fatte dalla pagina di Touch: quelle dell'app (scheda dell'estensione) o del ponte (_rtkt=1)
// non devono diventare "filtri appresi da Touch".
const fromTouchPage = (details) => details.tabId >= 0 && (!details.initiator || details.initiator === TOUCH_ORIGIN) && !/[?&]_rtkt=1/.test(details.url);

// Lingua del portale (_pl) usata da Touch: l'app usa la stessa, come le richieste della pagina.
let lastTouchLang = null;
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!fromTouchPage(details)) return;
    const pl = new URL(details.url).searchParams.get("_pl");
    if (!pl || !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(pl) || pl === lastTouchLang) return;
    lastTouchLang = pl;
    chrome.storage.local.get("touchLang").then((st) => {
      if (st.touchLang !== pl) chrome.storage.local.set({ touchLang: pl });
    });
  },
  { urls: ["https://zucchetti.support/HDAPortal/*"], types: ["xmlhttprequest"] },
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!fromTouchPage(details) || details.method !== "POST") return;
    const u = new URL(details.url);
    const m = /\/HDAPortal\/WSCView\/ListData\/([^/?]+)/.exec(u.pathname);
    if (m) {
      let filter = null;
      try {
        filter = JSON.parse(formValue(details, "filter") || "null");
      } catch {
        /* */
      }
      const conditions = filter && Array.isArray(filter.conditions) ? filter.conditions : null;
      let sort = null;
      try {
        sort = JSON.parse(formValue(details, "sort") || "null");
      } catch {
        /* */
      }
      remember({ at: Date.now(), kind: "data", collection: m[1], viewId: formValue(details, "ViewID"), conditions, sort, subfilters: filter && filter.subfilters }, conditions);
      return;
    }
    if (/\/HDAPortal\/WSCView\/List$/.test(u.pathname) && u.searchParams.get("Entity") === "Incidents") {
      const params = Object.fromEntries([...u.searchParams].filter(([k]) => !/^(_dc|_pl)$/.test(k)));
      chrome.storage.local.set({ touchIncidentsListParams: params });
    }
  },
  { urls: ["https://zucchetti.support/HDAPortal/WSCView/ListData/*", "https://zucchetti.support/HDAPortal/WSCView/List*"] },
  ["requestBody"],
);
