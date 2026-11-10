// Trasporto HTTP verso il portale HDA TOUCH.
//
// Nell'estensione la pagina dell'app chiama direttamente https://zucchetti.support/HDAPortal/...
// con i cookie della sessione già aperta nel browser (permesso host nel manifest).
// Se il browser non manda i cookie (o la sessione risulta scaduta) si passa per una scheda
// Touch aperta: lo script di contenuto fa la stessa richiesta dall'interno del portale.
// Fuori dall'estensione (sviluppo/test con il portale finto) si usa l'origine della pagina.

export const PORTAL_ORIGIN = "https://zucchetti.support";
export const PORTAL_BASE = PORTAL_ORIGIN + "/HDAPortal";

export class AuthError extends Error {
  constructor(msg = "Sessione Touch non attiva: apri HDA TOUCH in una scheda ed esegui l'accesso.") {
    super(msg);
    this.name = "AuthError";
  }
}

export class HdaError extends Error {
  constructor(msg, info = {}) {
    super(msg);
    this.name = "HdaError";
    this.info = info;
  }
}

const inExtension = () => typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);

export function makeTransport(opts = {}) {
  const base = opts.base ?? (inExtension() ? PORTAL_BASE : (globalThis.location ? location.origin + "/HDAPortal" : PORTAL_BASE));
  let mode = opts.mode || "direct"; // "direct" | "proxy"
  const log = opts.log || (() => {});
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));

  function looksLikeLogin(res, text) {
    if (res.status === 401 || res.status === 403) return true;
    if (res.redirected && /login|logon|signin|account\/log/i.test(res.url || "")) return true;
    const ct = res.contentType || "";
    if (/text\/html/i.test(ct) && /<form[^>]+(login|logon)|type=["']?password/i.test(text.slice(0, 20000))) return true;
    return false;
  }

  async function direct(req) {
    const res = await fetchImpl(base + req.path, {
      method: req.method || "GET",
      credentials: "include",
      headers: req.body != null ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" } : { "X-Requested-With": "XMLHttpRequest" },
      body: req.body ?? undefined,
      signal: req.signal,
    });
    const text = await res.text();
    return { status: res.status, url: res.url, redirected: res.redirected, contentType: res.headers.get("content-type") || "", text };
  }

  async function viaProxy(req) {
    if (!inExtension()) throw new AuthError();
    const out = await chrome.runtime.sendMessage({ type: "hda-proxy", req: { path: req.path, method: req.method, body: req.body } });
    if (!out) throw new AuthError("Nessuna scheda HDA TOUCH aperta: aprila, accedi e riprova.");
    if (out.error === "no-tab") throw new AuthError("Nessuna scheda HDA TOUCH aperta: aprila, accedi e riprova.");
    if (out.error) throw new HdaError(out.error);
    return out;
  }

  /**
   * req: { path, method, body (stringa urlencoded), expect: "json"|"text", signal }
   * Ritorna l'oggetto JSON (expect json) o il testo.
   */
  async function request(req) {
    let res;
    const t0 = Date.now();
    if (mode === "direct") {
      try {
        res = await direct(req);
        if (looksLikeLogin(res, res.text) && inExtension()) {
          log("direct: sessione non vista, provo tramite la scheda Touch");
          res = await viaProxy(req);
          mode = "proxy";
        }
      } catch (e) {
        if (e.name === "AbortError" || e instanceof AuthError) throw e;
        if (!inExtension()) throw new HdaError("Portale non raggiungibile: " + e.message);
        log("direct fallita (" + e.message + "), provo tramite la scheda Touch");
        res = await viaProxy(req);
        mode = "proxy";
      }
    } else {
      res = await viaProxy(req);
    }
    log(`${req.method || "GET"} ${req.path.split("?")[0]} → ${res.status} (${Date.now() - t0} ms, ${mode})`);
    if (looksLikeLogin(res, res.text)) throw new AuthError();
    if (res.status >= 400) throw new HdaError(`Il portale ha risposto ${res.status}`, { status: res.status, path: req.path, sample: res.text.slice(0, 300) });
    if (req.expect === "text") return res.text;
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      if (/<html|<!doctype/i.test(res.text.slice(0, 500))) throw new AuthError();
      throw new HdaError("Risposta del portale non in formato JSON", { path: req.path, sample: res.text.slice(0, 300) });
    }
    if (data && data.success === false) {
      const desc = (data.result && (data.result.desc || data.result.code)) || data.message || "errore sconosciuto";
      throw new HdaError("Il portale ha rifiutato la richiesta: " + desc, { path: req.path, result: data.result });
    }
    return data;
  }

  return {
    request,
    get mode() { return mode; },
    set mode(m) { mode = m; },
    base,
  };
}

/** {a:1,b:[..]} → "a=1&b=%5B..%5D" (gli oggetti diventano JSON, come fa ExtJS) */
export function formBody(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const s = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return encodeURIComponent(k) + "=" + encodeURIComponent(s);
    })
    .join("&");
}

export function query(params) {
  const b = formBody(params);
  return b ? "?" + b : "";
}
