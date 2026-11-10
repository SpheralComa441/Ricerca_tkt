// Script di contenuto nelle pagine di HDA TOUCH.
// Serve solo come "ponte": esegue dall'interno del portale (stessa origine, stessa sessione)
// le richieste di lettura che l'app dell'estensione non riesce a fare direttamente.

(() => {
  if (window.__rtktBridge) return;
  window.__rtktBridge = true;

  const ALLOWED = /^\/(WSCView\/(ListData|List|GetObjectAndDescription|GetObjectAndDescriptionHierarchy|GetStaticList|ObjectSearch)|WSC\/(Projection|Get|RunAnalysis))\b/;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "hda-fetch") return;
    const req = msg.req || {};
    if (!ALLOWED.test(String(req.path || ""))) {
      sendResponse({ error: "percorso non consentito" });
      return;
    }
    const headers = { "X-Requested-With": "XMLHttpRequest" };
    if (req.body != null) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    // _rtkt=1: così il service worker non scambia queste letture per filtri scelti in Touch
    const path = String(req.path) + (String(req.path).includes("?") ? "&" : "?") + "_rtkt=1";
    fetch(location.origin + "/HDAPortal" + path, { method: req.method || "GET", credentials: "same-origin", cache: "no-store", headers, body: req.body ?? undefined })
      .then(async (r) => sendResponse({ status: r.status, url: r.url, redirected: r.redirected, contentType: r.headers.get("content-type") || "", text: await r.text() }))
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true; // risposta asincrona
  });
})();
