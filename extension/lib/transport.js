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

/**
 * Errori del portale che non dipendono dalla richiesta ma da come arriva al portale: la sessione di Touch
 * vive su uno dei server dietro il bilanciatore (cookie BIGipServer…) e il collegamento al servizio dati è
 * legato a quella sessione. Una richiesta che arriva "da fuori" (dall'estensione) può finire senza quel
 * collegamento: il portale non chiede l'accesso ma risponde con questi errori.
 */
const INFRA_ERROR = /underlying connection|webservice|server configuration|configuration parameters/i;
const LOAD_ERROR = /caricamento dei dati|loading (?:the )?data|error occurred while loading/i;

function failureText(res) {
  if (!res || res.status >= 400) return "";
  const t = String(res.text || "").trim();
  if (!t.startsWith("{")) return "";
  try {
    const d = JSON.parse(t);
    if (!d || d.success !== false) return "";
    return String((d.result && (d.result.desc || d.result.code)) || d.message || "");
  } catch {
    return "";
  }
}

export function makeTransport(opts = {}) {
  const base = opts.base ?? (inExtension() ? PORTAL_BASE : (globalThis.location ? location.origin + "/HDAPortal" : PORTAL_BASE));
  let mode = opts.mode || "direct"; // "direct" | "proxy"
  const log = opts.log || (() => {});
  const onModeChange = opts.onModeChange || (() => {});
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const sendMessage = opts.sendMessage || ((m) => chrome.runtime.sendMessage(m));
  const worked = { direct: 0, proxy: 0 }; // risposte buone per ciascuna strada in questa sessione

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
      cache: "no-store", // GetStaticList è memorizzabile 60 s: un errore non deve restare in memoria
      headers: req.body != null ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" } : { "X-Requested-With": "XMLHttpRequest" },
      body: req.body ?? undefined,
      signal: req.signal,
    });
    const text = await res.text();
    return { status: res.status, url: res.url, redirected: res.redirected, contentType: res.headers.get("content-type") || "", text };
  }

  async function viaProxy(req) {
    if (!inExtension() && !opts.sendMessage) throw new AuthError();
    const out = await sendMessage({ type: "hda-proxy", req: { path: req.path, method: req.method, body: req.body } });
    if (!out || out.error === "no-tab") throw new AuthError("Nessuna scheda HDA TOUCH aperta: aprila, accedi e riprova.");
    if (out.error) throw new HdaError(out.error);
    return out;
  }

  /** La risposta va ripetuta dall'altra strada? (sessione non vista o collegamento del portale non disponibile) */
  function needsOtherWay(way, res) {
    if (looksLikeLogin(res, res.text)) return "login";
    const msg = failureText(res);
    if (msg && INFRA_ERROR.test(msg)) return "infra";
    // "errore durante il caricamento dei dati" è anche l'errore di una ricerca troppo pesante: si cambia strada
    // solo finché questa strada non ha ancora mai funzionato
    if (msg && LOAD_ERROR.test(msg) && !worked[way]) return "infra";
    return "";
  }

  /**
   * req: { path, method, body (stringa urlencoded), expect: "json"|"text", signal }
   * Ritorna l'oggetto JSON (expect json) o il testo.
   */
  async function request(req) {
    const t0 = Date.now();
    const canProxy = inExtension() || !!opts.sendMessage;
    const ways = mode === "proxy" ? ["proxy", "direct"] : canProxy ? ["direct", "proxy"] : ["direct"];
    let res = null;
    let used = null;
    let problem = "";
    let proxyError = null;
    for (const way of ways) {
      let r;
      try {
        r = way === "direct" ? await direct(req) : await viaProxy(req);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (way === "proxy") proxyError = e;
        log(`${way === "direct" ? "diretta" : "tramite la scheda Touch"}: ${e.message}`);
        if (way === "direct" && !inExtension() && !opts.sendMessage) throw new HdaError("Portale non raggiungibile: " + e.message);
        continue;
      }
      res = r;
      used = way;
      problem = needsOtherWay(way, r);
      if (!problem) break;
      log(`${way === "direct" ? "diretta" : "tramite la scheda Touch"}: ${problem === "login" ? "sessione non vista" : "errore del collegamento del portale («" + failureText(r).slice(0, 80) + "»)"}, provo l'altra strada`);
    }
    if (!res) {
      if (proxyError instanceof AuthError) throw proxyError;
      throw proxyError || new HdaError("Portale non raggiungibile");
    }
    if (!problem) {
      worked[used] += 1;
      if (used !== mode) {
        log(`da ora le richieste a Touch passano ${used === "proxy" ? "dalla scheda di HDA TOUCH" : "direttamente"}`);
        mode = used;
        onModeChange(mode);
      }
    }
    log(`${req.method || "GET"} ${req.path.split("?")[0]} → ${res.status} (${Date.now() - t0} ms, ${used})`);
    if (looksLikeLogin(res, res.text)) throw new AuthError();
    if (res.status >= 400) throw new HdaError(`Il portale ha risposto ${res.status}`, { status: res.status, path: req.path, sample: res.text.slice(0, 300) });
    if (problem === "infra") {
      const msg = failureText(res);
      // nessuna scheda di Touch da cui ripetere la richiesta: è lì che serve aprirla
      if (proxyError instanceof AuthError) {
        throw new AuthError(`HDA TOUCH ha risposto «${msg}». Apri HDA TOUCH in una scheda (con l'accesso fatto) e premi Riprova: l'estensione passerà da quella scheda.`);
      }
      throw new HdaError(`HDA TOUCH ha risposto «${msg}» anche dalla sua scheda: ricarica la pagina di HDA TOUCH (se serve esci e rientra) e premi Riprova.`, { path: req.path, infra: true });
    }
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
