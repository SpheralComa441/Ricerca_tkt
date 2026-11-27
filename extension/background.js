// Service worker dell'estensione Ricerca TKT.
//  - clic sull'icona → apre (o porta in primo piano) l'app in una scheda;
//  - "ponte" verso una scheda Touch aperta quando l'app non riesce a leggere direttamente;
//  - "Apri in Touch": apre il dettaglio del ticket nella scheda Touch, come un clic nel portale;
//  - registra (solo in lettura) i filtri che Touch invia quando li usi nel portale, così l'app
//    impara proprietà, operatori e formato dei valori di ogni filtro senza doverli indovinare.

import { learnFromConditions } from "./lib/filters.js";
import { NATIVE_HOST_NAME, checkRemoteUpdate, downloadRemoteZipBase64 } from "./lib/updater.js";

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

function openDetailInPage(id, entity = "Incident", recordView = "") {
  // eseguita nella pagina di Touch (mondo MAIN): stesso meccanismo dei link "openDetail" del portale
  const P = window.Portal;
  if (!P || !P.Actions || typeof P.Actions.onClick !== "function") return "not-ready";
  const el = document.createElement("div");
  el.setAttribute("data-action", "Portal.PageManager.openDetail");
  el.setAttribute("data-entity", entity || "Incident");
  el.setAttribute("data-id", String(id));
  if (recordView) el.setAttribute("data-record-view", recordView);
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

async function openInTouch(id, entity = "Incident", recordView = "") {
  let tab = await touchTab();
  if (!tab) tab = await chrome.tabs.create({ url: TOUCH_HOME, active: true });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  // aspetta che il portale sia pronto (al massimo ~30 s)
  for (let i = 0; i < 60; i++) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: openDetailInPage, args: [id, entity, recordView] });
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
    openInTouch(msg.id, msg.entity || "Incident", msg.recordView || "").then((r) => sendResponse({ result: r }), (e) => sendResponse({ result: "error: " + (e && e.message) }));
    return true;
  }
  if (msg.type === "touch-tab-status") {
    touchTab().then((t) => sendResponse({ open: !!t }));
    return true;
  }
  if (msg.type === "updater:status") {
    getUpdaterStatus(!!msg.pingHelper).then(sendResponse, (e) => sendResponse({ error: String(e && e.message) }));
    return true;
  }
  if (msg.type === "updater:check") {
    runUpdateCheck({ autoApply: !!msg.autoApply }).then(sendResponse, (e) => sendResponse({ error: String(e && e.message) }));
    return true;
  }
  if (msg.type === "updater:apply") {
    applyRemoteUpdate({ reopenApp: msg.reopenApp !== false }).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }
  if (msg.type === "updater:set-config") {
    saveUpdaterConfig(msg.config || {}).then(sendResponse, (e) => sendResponse({ error: String(e && e.message) }));
    return true;
  }
  if (msg.type === "updater:reload") {
    chrome.storage.local.set({ reopenAppAfterUpdate: true }).finally(() => {
      sendResponse({ ok: true });
      setTimeout(() => chrome.runtime.reload(), 150);
    });
    return true;
  }
  if (msg.type === "updater:consume-just-updated") {
    chrome.storage.local.get("justUpdatedInfo").then((st) => {
      if (st.justUpdatedInfo) chrome.storage.local.remove("justUpdatedInfo");
      sendResponse(st.justUpdatedInfo || null);
    });
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

// ---------------------------------------------------------------- aggiornamenti automatici

const UPDATE_ALARM = "ricerca-tkt-update-check";
const DEFAULT_UPDATER_CFG = { autoCheck: true, autoUpdate: true, githubToken: "" };
let cachedHelper = null;
let updateApplyInFlight = false;

function sendNative(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== "function") {
      return reject(new Error("Native messaging non disponibile in questo browser."));
    }
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message || "Helper locale non configurato"));
        if (!resp) return reject(new Error("Nessuna risposta dall'helper locale"));
        resolve(resp);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function pingNativeHelper(force = false) {
  if (!force && cachedHelper && Date.now() - cachedHelper.at < 60_000) return cachedHelper;
  try {
    const r = await sendNative({ action: "ping" });
    cachedHelper = {
      available: !!(r && r.ok),
      helperVersion: (r && r.helperVersion) || "",
      installDir: (r && r.installDir) || "",
      hasGit: !!(r && r.hasGit),
      error: r && r.ok ? "" : (r && r.error) || "Risposta non valida",
      at: Date.now(),
    };
  } catch (e) {
    cachedHelper = {
      available: false,
      helperVersion: "",
      installDir: "",
      hasGit: false,
      error: (e && e.message) || "Non configurato",
      at: Date.now(),
    };
  }
  return cachedHelper;
}

async function getUpdaterConfig() {
  const st = await chrome.storage.local.get("updaterConfig");
  return { ...DEFAULT_UPDATER_CFG, ...(st.updaterConfig || {}) };
}

async function saveUpdaterConfig(patch) {
  const cur = await getUpdaterConfig();
  const next = {
    autoCheck: patch.autoCheck !== undefined ? !!patch.autoCheck : cur.autoCheck,
    autoUpdate: patch.autoUpdate !== undefined ? !!patch.autoUpdate : cur.autoUpdate,
    githubToken: patch.githubToken !== undefined ? String(patch.githubToken || "").trim() : cur.githubToken,
  };
  await chrome.storage.local.set({ updaterConfig: next });
  await ensureUpdateAlarm(next.autoCheck);
  return getUpdaterStatus(false);
}

function setUpdateBadge(hasUpdate, version) {
  try {
    if (hasUpdate) {
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      chrome.action.setBadgeText({ text: "NEW" });
      chrome.action.setTitle({ title: `Ricerca TKT — Nuova versione disponibile (v${version})` });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Apri Ricerca TKT" });
    }
  } catch {
    /* */
  }
}

async function getScheduledNextCheck(autoCheckEnabled) {
  if (!chrome.alarms) return null;
  try {
    if (!autoCheckEnabled) return null;
    let alarm = await chrome.alarms.get(UPDATE_ALARM);
    if (!alarm) {
      await ensureUpdateAlarm(true);
      alarm = await chrome.alarms.get(UPDATE_ALARM);
    }
    return alarm ? alarm.scheduledTime : null;
  } catch {
    return null;
  }
}

async function getUpdaterStatus(ping = false) {
  const manifest = chrome.runtime.getManifest();
  const [cfg, st, helper] = await Promise.all([
    getUpdaterConfig(),
    chrome.storage.local.get(["updaterLastCheck", "updaterInstalledSha", "updaterLastApplied"]),
    ping ? pingNativeHelper(true) : Promise.resolve(cachedHelper || (await pingNativeHelper(false))),
  ]);
  const nextCheckAt = await getScheduledNextCheck(cfg.autoCheck);
  return {
    currentVersion: manifest.version,
    extensionId: chrome.runtime.id,
    config: {
      autoCheck: cfg.autoCheck,
      autoUpdate: cfg.autoUpdate,
      hasToken: !!cfg.githubToken,
    },
    helper,
    lastCheck: st.updaterLastCheck || null,
    nextCheckAt,
    installedSha: st.updaterInstalledSha || "",
    lastApplied: st.updaterLastApplied || null,
  };
}

let updateCheckInFlight = null;

async function runUpdateCheck({ autoApply = false } = {}) {
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
    const manifest = chrome.runtime.getManifest();
    const [cfg, st] = await Promise.all([
      getUpdaterConfig(),
      chrome.storage.local.get("updaterInstalledSha"),
    ]);
    const res = await checkRemoteUpdate({
      currentVersion: manifest.version,
      installedSha: st.updaterInstalledSha || "",
      token: cfg.githubToken,
    });
    await chrome.storage.local.set({ updaterLastCheck: res });
    setUpdateBadge(res.status === "update_available", res.remoteVersion || "");
    if (cfg.autoCheck) await ensureUpdateAlarm(true, { reset: true });

    if (autoApply && cfg.autoUpdate && res.status === "update_available") {
      const helper = await pingNativeHelper(true);
      if (helper.available) {
        let hasAppOpen = false;
        try {
          const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("app/index.html") + "*" });
          hasAppOpen = tabs.length > 0;
        } catch {
          /* */
        }
        await applyRemoteUpdate({ reopenApp: hasAppOpen, checkResult: res }).catch(() => {});
      }
    }
    return getUpdaterStatus(!cachedHelper || !cachedHelper.available);
  })();
  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = null;
  }
}

async function applyRemoteUpdate({ reopenApp = true, checkResult = null } = {}) {
  if (updateApplyInFlight) return { ok: false, error: "Aggiornamento già in corso…" };
  updateApplyInFlight = true;
  try {
    const helper = await pingNativeHelper(true);
    if (!helper.available) {
      return {
        ok: false,
        needsHelper: true,
        error: "Helper locale non ancora attivato. Esegui una sola volta updater\\attiva_autoaggiornamento.bat nella cartella dell'estensione.",
      };
    }
    const cfg = await getUpdaterConfig();
    const manifest = chrome.runtime.getManifest();
    let remote = checkResult;
    if (!remote) {
      remote = await checkRemoteUpdate({
        currentVersion: manifest.version,
        token: cfg.githubToken,
      });
    }

    let resp;
    try {
      const { zipBase64 } = await downloadRemoteZipBase64({ token: cfg.githubToken });
      resp = await sendNative({
        action: "applyZip",
        zipBase64,
        expectedVersion: (remote && remote.remoteVersion) || "",
      });
    } catch (dlErr) {
      if (helper.hasGit) {
        resp = await sendNative({ action: "gitPull" });
      } else {
        throw dlErr;
      }
    }

    if (!resp || !resp.ok) {
      return { ok: false, error: (resp && resp.error) || "Errore durante l'applicazione dell'aggiornamento." };
    }

    const appliedVersion = resp.version || (remote && remote.remoteVersion) || manifest.version;
    const now = Date.now();
    await chrome.storage.local.set({
      updaterInstalledSha: (remote && remote.remoteSha) || "",
      updaterLastApplied: { version: appliedVersion, at: now, filesUpdated: resp.filesUpdated || 0 },
      updaterLastCheck: {
        status: "up_to_date",
        currentVersion: appliedVersion,
        remoteVersion: appliedVersion,
        remoteSha: (remote && remote.remoteSha) || "",
        remoteShortSha: (remote && remote.remoteShortSha) || "",
        commitMessage: (remote && remote.commitMessage) || "",
        checkedAt: now,
      },
      reopenAppAfterUpdate: !!reopenApp,
      justUpdatedInfo: { from: manifest.version, to: appliedVersion, at: now },
    });
    setUpdateBadge(false);
    setTimeout(() => chrome.runtime.reload(), 300);
    return { ok: true, version: appliedVersion, filesUpdated: resp.filesUpdated || 0, reloading: true };
  } finally {
    updateApplyInFlight = false;
  }
}

async function ensureUpdateAlarm(enabled, { reset = false } = {}) {
  if (!chrome.alarms) return;
  try {
    if (!enabled) {
      await chrome.alarms.clear(UPDATE_ALARM);
      return;
    }
    const existing = await chrome.alarms.get(UPDATE_ALARM);
    if (existing && !reset) return;
    if (reset) await chrome.alarms.clear(UPDATE_ALARM);
    const st = await chrome.storage.local.get("updaterLastCheck");
    const lastAt = (st.updaterLastCheck && st.updaterLastCheck.checkedAt) || 0;
    const elapsedMin = lastAt ? (Date.now() - lastAt) / 60_000 : Infinity;
    const delayInMinutes = reset
      ? 240
      : elapsedMin >= 240
        ? 1
        : Math.max(1, Math.min(240, Math.ceil(240 - elapsedMin)));
    chrome.alarms.create(UPDATE_ALARM, { delayInMinutes, periodInMinutes: 240 });
  } catch {
    /* */
  }
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === UPDATE_ALARM) {
      runUpdateCheck({ autoApply: true }).catch(() => {});
    }
  });
}

async function handlePostReload() {
  try {
    const st = await chrome.storage.local.get("reopenAppAfterUpdate");
    if (st.reopenAppAfterUpdate) {
      await chrome.storage.local.remove("reopenAppAfterUpdate");
      await openApp();
    }
  } catch {
    /* */
  }
}

async function bootstrapUpdater({ runIfOverdue = false } = {}) {
  try {
    const [cfg, st] = await Promise.all([
      getUpdaterConfig(),
      chrome.storage.local.get("updaterLastCheck"),
    ]);
    await ensureUpdateAlarm(cfg.autoCheck);
    if (runIfOverdue && cfg.autoCheck) {
      const lastAt = (st.updaterLastCheck && st.updaterLastCheck.checkedAt) || 0;
      if (!lastAt || Date.now() - lastAt >= 240 * 60_000) {
        runUpdateCheck({ autoApply: true }).catch(() => {});
      }
    }
  } catch {
    /* */
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await bootstrapUpdater({ runIfOverdue: false });
  await handlePostReload();
});

chrome.runtime.onStartup.addListener(async () => {
  await bootstrapUpdater({ runIfOverdue: true });
});

// Assicura alarm attivo, riapertura dell'app dopo chrome.runtime.reload() e recupero controlli scaduti ad ogni risveglio del service worker
handlePostReload();
bootstrapUpdater({ runIfOverdue: true });

